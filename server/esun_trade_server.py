"""
esun_trade_server.py — E.Sun Securities (玉山證券) Trading Sidecar Service

Provides a local REST & SSE service (default http://127.0.0.1:8090) bridging
the official Python SDK (`esun_trade`) with frontend trading & account interfaces.

Key Protections & Features:
1. Headless Keyring Injection: No interactive prompt (getpass) or native keyring hang.
2. Login Single-Attempt Circuit Breaker: Attempts sdk.login() once. On failure (e.g. AGA0000),
   locks out auto-retries to prevent the 3-strike account lockout.
3. Official Rate Limiters & Sliding Windows:
   - Order mutations: 18 req/sec sliding window (protecting 20 rps AGR0002) & 2,000 req/day (AGR0001).
   - Balance query: mandatory 180s TTL cache (1 call per 180s).
   - Settlements query: 25s TTL cache + 3 req/min limiter (AGR0006).
   - Order query: OrderBookCache (0 calls for refresh=false), 5s min interval + 10 req/min for refresh=true (AGR0005).
   - Positions query: 6s TTL cache + 10 req/min limiter (AGR0003), invalidated on MAT deal.
   - Profit/Loss query: 180-day range clamp + 10s TTL cache + 10 req/min limiter.
   - Trading limits query: 60s TTL cache.
   - Market status query: 300s TTL cache.
   - Reconnect: 60s cooldown on AGR0000, 10 req/min limiter, 300 req/day counter (AGR0004).
4. Reservation Order Guard: Rejects price/quantity modifications on reservation orders (AG0006).
5. Price Modification Guard: Rejects price modifications on non-ROD or non-Limit orders.
6. Singleton WebSocket -> SSE Fan-out: Single WebSocket daemon thread broadcasting ACK/MAT
   events and 25s heartbeats to SSE subscribers.
"""

from __future__ import annotations

import configparser
import datetime
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import logging
import math
import os
import queue
import re
import secrets
import signal
import sys
import threading
import time
import traceback
from urllib.parse import parse_qs, urlparse, urlsplit

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] [esun-sidecar] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("esun_trade_server")

# Try to import esun_trade modules (patched later if available)
try:
    from esun_trade.constant import Action, APCode, BSFlag, PriceFlag, Trade
    from esun_trade.order import OrderObject
    from esun_trade.sdk import SDK
    import esun_trade.util
except ImportError:
    SDK = None  # type: ignore
    OrderObject = None  # type: ignore
    Action = None  # type: ignore
    APCode = None  # type: ignore
    BSFlag = None  # type: ignore
    PriceFlag = None  # type: ignore
    Trade = None  # type: ignore
    logger.warning("esun_trade package not imported at top level; will rely on injected SDK in mock environments.")


# ─────────────────────────────────────────────────────────────────────────────
# 0. Secret Redaction (responses & logs never carry passwords / secrets / IDs)
# ─────────────────────────────────────────────────────────────────────────────

_SECRET_ENV_KEYS = ("ESUN_ACCOUNT_PASSWORD", "ESUN_PASSWORD", "ESUN_CERT_PASSWORD", "ESUN_BRIDGE_TOKEN")
_REDACT_LOCK = threading.Lock()
_REDACTED_VALUES: set[str] = set()
# 台灣身分證／居留證號格式：1 個英文字母 + 9 碼（第 2 碼 1/2/8/9 或 A-D）
_NATIONAL_ID_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z])[1289A-D][0-9]{8}(?![A-Za-z0-9])")


def register_secret(value: any) -> None:
    """Registers a secret value (e.g. [Api] Secret) so redact() masks it everywhere."""
    s = str(value or "").strip()
    if len(s) >= 4:
        with _REDACT_LOCK:
            _REDACTED_VALUES.add(s)


def redact(text: any) -> str:
    """Masks passwords, API secrets, the bridge token and national IDs in free text."""
    s = str(text)
    candidates = {v for v in (os.environ.get(k) for k in _SECRET_ENV_KEYS) if v and len(v) >= 4}
    with _REDACT_LOCK:
        candidates |= _REDACTED_VALUES
    for value in sorted(candidates, key=len, reverse=True):
        if value in s:
            s = s.replace(value, "***")
    return _NATIONAL_ID_RE.sub(lambda m: m.group(1) + "*********", s)


def mask_identifier(value: any) -> str:
    """Masks an identifier for display/logging: A123456789 -> A*******89."""
    s = str(value or "")
    if len(s) <= 4:
        return "*" * len(s)
    return s[:1] + "*" * (len(s) - 3) + s[-2:]


# ─────────────────────────────────────────────────────────────────────────────
# 1. Headless Keyring Injection
# ─────────────────────────────────────────────────────────────────────────────

def apply_headless_keyring_patches() -> None:
    """
    Monkey-patch esun_trade.util.setup_keyring (no-op) and
    esun_trade.util.load_credentials to return passwords from environment variables,
    guaranteeing that SDK(config) and sdk.login() NEVER call getpass() or hang
    in headless environments.
    """
    def _no_op_setup_keyring(user_account: str) -> None:
        pass

    def _headless_load_credentials(user_account: str) -> dict[str, str]:
        account_password = (
            os.environ.get("ESUN_ACCOUNT_PASSWORD")
            or os.environ.get("ESUN_PASSWORD", "")
        )
        cert_password = os.environ.get("ESUN_CERT_PASSWORD", "")
        return {
            "account_password": account_password,
            "cert_password": cert_password,
        }

    try:
        import esun_trade.util
        esun_trade.util.setup_keyring = _no_op_setup_keyring
        esun_trade.util.load_credentials = _headless_load_credentials
    except ImportError:
        pass

    try:
        import esun_trade.sdk
        esun_trade.sdk.setup_keyring = _no_op_setup_keyring
        esun_trade.sdk.load_credentials = _headless_load_credentials
    except ImportError:
        pass


# Apply patches immediately upon module import
apply_headless_keyring_patches()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Config & Account Utilities
# ─────────────────────────────────────────────────────────────────────────────

ESUN_SIMULATION_ENTRY = "https://esuntradingapi-simulation.esunsec.com.tw/api/v1"
ESUN_PRODUCTION_ENTRY = "https://esuntradingapi.esunsec.com.tw/api/v1"

ESUN_SIMULATION_CONFIG_CANDIDATES = (
    "esun-config.simulation.ini",
    "esun-config.sim.ini",
    "esun-config.test.ini",
)
ESUN_PRODUCTION_CONFIG_CANDIDATES = (
    "esun-config.production.ini",
    "esun-config.prod.ini",
)


def _is_placeholder_config(config_path: str) -> bool:
    """
    Returns True if config_path is a generic template file (esun-config.ini or config.ini)
    that contains unconfigured example placeholders (e.g. Key starting with YOUR_ and Account containing 1234567).
    """
    if not config_path or not os.path.isfile(config_path):
        return False
    base_name = os.path.basename(config_path).lower()
    if base_name not in ("esun-config.ini", "config.ini"):
        return False
    try:
        cp = configparser.ConfigParser()
        cp.read(config_path, encoding="utf-8")
        if cp.has_section("Api") and cp.has_section("User"):
            api_key = str(cp["Api"].get("Key", "")).strip()
            account = str(cp["User"].get("Account", "")).strip()
            if api_key.startswith("YOUR_") and ("1234567" in account):
                return True
    except Exception:
        pass
    return False


def discover_esun_config_profiles(
    base_dir: str | None = None,
    default_config_path: str | None = None,
) -> dict[str, any]:
    """
    Scans directory for simulation and production config profiles.
    Supports dual config files (esun-config.simulation.ini + esun-config.production.ini),
    aliases (.sim.ini, .test.ini, .prod.ini), environment variables
    (ESUN_SIMULATION_CONFIG_PATH, ESUN_PRODUCTION_CONFIG_PATH),
    and single esun-config.ini fallback detection.
    """
    if base_dir:
        root_dir = base_dir if os.path.isdir(base_dir) else os.path.dirname(os.path.abspath(base_dir))
    elif os.environ.get("ESUN_CONFIG_DIR"):
        env_dir = os.environ.get("ESUN_CONFIG_DIR")
        root_dir = env_dir if os.path.isdir(env_dir) else os.path.dirname(os.path.abspath(env_dir))
    else:
        root_dir = os.getcwd()
    root_dir = os.path.abspath(root_dir)

    sim_path: str | None = None
    prod_path: str | None = None

    # 1. Check SIMULATION environment variable & candidates
    env_sim = os.environ.get("ESUN_SIMULATION_CONFIG_PATH")
    if env_sim and os.path.isfile(env_sim):
        sim_path = os.path.abspath(env_sim)
    else:
        for candidate in ESUN_SIMULATION_CONFIG_CANDIDATES:
            candidate_path = os.path.join(root_dir, candidate)
            if os.path.isfile(candidate_path):
                sim_path = os.path.abspath(candidate_path)
                break

    # 2. Check PRODUCTION environment variable & candidates
    env_prod = os.environ.get("ESUN_PRODUCTION_CONFIG_PATH")
    if env_prod and os.path.isfile(env_prod):
        prod_path = os.path.abspath(env_prod)
    else:
        for candidate in ESUN_PRODUCTION_CONFIG_CANDIDATES:
            candidate_path = os.path.join(root_dir, candidate)
            if os.path.isfile(candidate_path):
                prod_path = os.path.abspath(candidate_path)
                break

    # 3. Fallback check for single config file (esun-config.ini or explicit default_config_path)
    # CRITICAL: Only fall back to single config file when NEITHER sim_path NOR prod_path was found in Steps 1 & 2!
    if sim_path is None and prod_path is None:
        fallback_candidates: list[str] = []
        if default_config_path:
            p = default_config_path if os.path.isabs(default_config_path) else os.path.join(root_dir, default_config_path)
            fallback_candidates.append(p)
        if os.environ.get("ESUN_CONFIG_PATH"):
            fallback_candidates.append(os.environ.get("ESUN_CONFIG_PATH"))
        fallback_candidates.append(os.path.join(root_dir, "esun-config.ini"))
        fallback_candidates.append(os.path.join(root_dir, "config.ini"))

        found_fallback: str | None = None
        for fc in fallback_candidates:
            if fc and os.path.isfile(fc):
                if _is_placeholder_config(fc):
                    continue
                found_fallback = os.path.abspath(fc)
                break

        if found_fallback:
            try:
                cp = configparser.ConfigParser()
                cp.read(found_fallback, encoding="utf-8")
                detected = detect_esun_environment(cp)
                if detected == "SIMULATION":
                    sim_path = found_fallback
                elif detected == "PRODUCTION":
                    prod_path = found_fallback
            except Exception as e:
                logger.warning(f"Failed to parse fallback config file {found_fallback}: {e}")

    sim_file = os.path.basename(sim_path) if sim_path else None
    prod_file = os.path.basename(prod_path) if prod_path else None

    available_envs: list[str] = []
    if sim_path is not None:
        available_envs.append("SIMULATION")
    if prod_path is not None:
        available_envs.append("PRODUCTION")

    return {
        "availableEnvironments": available_envs,
        "profiles": {
            "SIMULATION": {
                "available": sim_path is not None,
                "fileName": sim_file,
                "filePath": sim_path,
                "expectedFileName": "esun-config.simulation.ini",
                "aliases": list(ESUN_SIMULATION_CONFIG_CANDIDATES),
                "entry": ESUN_SIMULATION_ENTRY,
            },
            "PRODUCTION": {
                "available": prod_path is not None,
                "fileName": prod_file,
                "filePath": prod_path,
                "expectedFileName": "esun-config.production.ini",
                "aliases": list(ESUN_PRODUCTION_CONFIG_CANDIDATES),
                "entry": ESUN_PRODUCTION_ENTRY,
            },
        },
    }


def detect_esun_environment(config: configparser.ConfigParser | None) -> str:
    """
    Detects whether an E.Sun configuration is SIMULATION or PRODUCTION based on [Core]:
    - Simulation: Entry == ESUN_SIMULATION_ENTRY and Environment == SIMULATION
    - Production: Entry == ESUN_PRODUCTION_ENTRY and (no Environment key or empty)
    - Fallback: Environment == SIMULATION or "simulation" in Entry URL -> SIMULATION, else PRODUCTION.
    """
    if not config or not config.has_section("Core"):
        return "UNKNOWN"
    entry = config.get("Core", "Entry", fallback="").strip().rstrip("/")
    has_env = config.has_option("Core", "Environment")
    env_val = config.get("Core", "Environment", fallback="").strip().upper() if has_env else ""

    if env_val == "SIMULATION" and entry == ESUN_SIMULATION_ENTRY:
        return "SIMULATION"
    if (not has_env or env_val == "") and entry == ESUN_PRODUCTION_ENTRY:
        return "PRODUCTION"

    if env_val == "SIMULATION" or "simulation" in entry.lower():
        return "SIMULATION"
    return "PRODUCTION"


def split_account(aid: str | None) -> dict[str, str]:
    """Split 11-digit or 7-digit account into broker_id and account_id."""
    id_str = str(aid or "").strip()
    if len(id_str) == 11 and id_str.isdigit():
        return {"broker_id": id_str[:4], "account_id": id_str[4:]}
    return {"broker_id": "8840", "account_id": id_str}


def load_config(config_path_override: str | None = None) -> tuple[configparser.ConfigParser | None, list[str], str]:
    """
    Loads config.ini / esun-config.ini or profile-specific config from path or environment.
    Returns (config_parser, problems, environment).
    """
    if config_path_override:
        config_path = config_path_override
    else:
        base_dir = os.environ.get("ESUN_CONFIG_DIR") or os.getcwd()
        discovery = discover_esun_config_profiles(base_dir)
        if discovery["profiles"]["SIMULATION"]["available"]:
            config_path = discovery["profiles"]["SIMULATION"]["filePath"]
        elif discovery["profiles"]["PRODUCTION"]["available"]:
            config_path = discovery["profiles"]["PRODUCTION"]["filePath"]
        elif os.environ.get("ESUN_CONFIG_PATH"):
            config_path = os.environ.get("ESUN_CONFIG_PATH")
        else:
            esun_ini = os.path.join(base_dir, "esun-config.ini")
            cfg_ini = os.path.join(base_dir, "config.ini")
            if os.path.exists(esun_ini):
                config_path = esun_ini
            elif os.path.exists(cfg_ini):
                config_path = cfg_ini
            else:
                config_path = esun_ini

    problems: list[str] = []

    if not os.path.exists(config_path) or not os.path.isfile(config_path):
        return None, [f"找不到玉山設定檔：{config_path}"], "UNKNOWN"

    parser = configparser.ConfigParser()
    try:
        parser.read(config_path, encoding="utf-8")
    except Exception as e:
        return None, [f"解析設定檔失敗：{e}"], "UNKNOWN"

    # Validate required sections
    for sec in ("Core", "Cert", "Api", "User"):
        if not parser.has_section(sec):
            problems.append(f"設定檔缺少 [{sec}] 區塊")

    if parser.has_section("Core") and not parser["Core"].get("Entry"):
        problems.append("設定檔缺少 [Core] Entry")
    if parser.has_section("Api"):
        if not parser["Api"].get("Key"):
            problems.append("設定檔缺少 [Api] Key")
        if not parser["Api"].get("Secret"):
            problems.append("設定檔缺少 [Api] Secret")
    if parser.has_section("User") and not parser["User"].get("Account"):
        problems.append("設定檔缺少 [User] Account")

    cert_raw = parser["Cert"].get("Path") if parser.has_section("Cert") else None
    if not cert_raw:
        problems.append("設定檔缺少 [Cert] Path")
    else:
        # Resolve cert path relative to config directory if relative
        config_dir = os.path.dirname(os.path.abspath(config_path))
        if os.path.isabs(cert_raw):
            resolved_cert = cert_raw
        else:
            resolved_cert = os.path.abspath(os.path.join(config_dir, cert_raw))
            if not os.path.exists(resolved_cert) and os.path.exists(os.path.abspath(cert_raw)):
                resolved_cert = os.path.abspath(cert_raw)

        if not os.path.exists(resolved_cert):
            problems.append(f"找不到憑證檔案：{resolved_cert}")
        else:
            parser["Cert"]["Path"] = resolved_cert

    # Check password environment variables
    account_pw = os.environ.get("ESUN_ACCOUNT_PASSWORD") or os.environ.get("ESUN_PASSWORD", "")
    cert_pw = os.environ.get("ESUN_CERT_PASSWORD", "")
    if not account_pw:
        problems.append("未設定 ESUN_ACCOUNT_PASSWORD 或 ESUN_PASSWORD（玉山登入密碼）")
    if not cert_pw:
        problems.append("未設定 ESUN_CERT_PASSWORD（憑證密碼）")

    environment = detect_esun_environment(parser)

    return parser, problems, environment


def update_esun_config_environment(config_path: str, target_env: str) -> tuple[str, str]:
    """
    Updates the [Core] section of config_path to match target_env ('SIMULATION' or 'PRODUCTION').
    - When 'SIMULATION':
      Entry = https://esuntradingapi-simulation.esunsec.com.tw/api/v1
      Environment = SIMULATION
    - When 'PRODUCTION':
      Entry = https://esuntradingapi.esunsec.com.tw/api/v1
      Removes Environment key from [Core].
    Preserves other sections and existing comments.
    Returns (target_env, target_entry).
    """
    target_env_normalized = str(target_env or "").strip().upper()
    if target_env_normalized not in ("SIMULATION", "PRODUCTION"):
        raise ValueError(f"不支援的環境設定：{target_env}，僅支援 SIMULATION 或 PRODUCTION")

    target_entry = (
        ESUN_SIMULATION_ENTRY if target_env_normalized == "SIMULATION" else ESUN_PRODUCTION_ENTRY
    )

    if not os.path.exists(config_path):
        dirname = os.path.dirname(os.path.abspath(config_path))
        if dirname:
            os.makedirs(dirname, exist_ok=True)
        lines = ["[Core]\n", f"Entry = {target_entry}\n"]
        if target_env_normalized == "SIMULATION":
            lines.append("Environment = SIMULATION\n")
        with open(config_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
        return target_env_normalized, target_entry

    with open(config_path, "r", encoding="utf-8") as f:
        existing_lines = f.readlines()

    new_lines: list[str] = []
    in_core = False
    core_seen = False
    entry_updated = False
    env_updated = False

    for line in existing_lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            sec_name = stripped[1:-1].strip()
            if in_core:
                if not entry_updated:
                    new_lines.append(f"Entry = {target_entry}\n")
                    entry_updated = True
                if target_env_normalized == "SIMULATION" and not env_updated:
                    new_lines.append("Environment = SIMULATION\n")
                    env_updated = True
                in_core = False
            if sec_name.lower() == "core":
                in_core = True
                core_seen = True
            new_lines.append(line)
            continue

        if in_core:
            # Check if line sets Entry
            if stripped.lower().startswith("entry") and ("=" in stripped or ":" in stripped):
                sep = "=" if "=" in line else ":"
                prefix = line.split(sep, 1)[0]
                new_lines.append(f"{prefix}= {target_entry}\n")
                entry_updated = True
                continue

            # Check if line sets Environment
            if stripped.lower().startswith("environment") and ("=" in stripped or ":" in stripped):
                if target_env_normalized == "SIMULATION":
                    sep = "=" if "=" in line else ":"
                    prefix = line.split(sep, 1)[0]
                    new_lines.append(f"{prefix}= SIMULATION\n")
                    env_updated = True
                else:
                    # PRODUCTION: Remove Environment key completely
                    env_updated = True
                continue

        new_lines.append(line)

    if in_core:
        if not entry_updated:
            new_lines.append(f"Entry = {target_entry}\n")
            entry_updated = True
        if target_env_normalized == "SIMULATION" and not env_updated:
            new_lines.append("Environment = SIMULATION\n")
            env_updated = True

    if not core_seen:
        core_block = ["[Core]\n", f"Entry = {target_entry}\n"]
        if target_env_normalized == "SIMULATION":
            core_block.append("Environment = SIMULATION\n")
        core_block.append("\n")
        new_lines = core_block + new_lines

    with open(config_path, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    return target_env_normalized, target_entry


# ─────────────────────────────────────────────────────────────────────────────
# 3. Rate Limiters & Caches
# ─────────────────────────────────────────────────────────────────────────────

class SlidingWindowRateLimiter:
    """Thread-safe sliding window rate limiter."""

    def __init__(self, max_requests: int, window_seconds: float):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.timestamps: list[float] = []
        self.lock = threading.Lock()

    def _cleanup(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self.timestamps and self.timestamps[0] <= cutoff:
            self.timestamps.pop(0)

    def can_acquire(self) -> bool:
        with self.lock:
            now = time.time()
            self._cleanup(now)
            return len(self.timestamps) < self.max_requests

    def acquire(self, timeout: float = 0.0) -> bool:
        deadline = time.time() + timeout
        while True:
            with self.lock:
                now = time.time()
                self._cleanup(now)
                if len(self.timestamps) < self.max_requests:
                    self.timestamps.append(now)
                    return True
                wait_time = self.timestamps[0] + self.window_seconds - now

            if wait_time <= 0:
                continue
            if timeout <= 0 or (time.time() + wait_time) > deadline:
                return False
            time.sleep(min(wait_time, 0.05))

    def time_until_available(self) -> float:
        with self.lock:
            now = time.time()
            self._cleanup(now)
            if len(self.timestamps) < self.max_requests:
                return 0.0
            return max(0.0, self.timestamps[0] + self.window_seconds - now)


class DailyCounter:
    """Thread-safe counter tracking daily requests with automatic midnight rollover."""

    def __init__(self, max_daily_requests: int):
        self.max_daily_requests = max_daily_requests
        self.current_day = datetime.date.today()
        self.count = 0
        self.lock = threading.Lock()

    def _rollover_if_needed(self) -> None:
        today = datetime.date.today()
        if today != self.current_day:
            self.current_day = today
            self.count = 0

    def can_increment(self) -> bool:
        with self.lock:
            self._rollover_if_needed()
            return self.count < self.max_daily_requests

    def increment(self) -> bool:
        with self.lock:
            self._rollover_if_needed()
            if self.count >= self.max_daily_requests:
                return False
            self.count += 1
            return True

    def get_count(self) -> int:
        with self.lock:
            self._rollover_if_needed()
            return self.count


class TTLCache:
    """Thread-safe TTL cache with support for dirty marking."""

    def __init__(self, ttl_seconds: float):
        self.ttl_seconds = ttl_seconds
        self._cache: dict[str, tuple[any, float]] = {}
        self._dirty = False
        self.lock = threading.Lock()

    def get(self, key: str = "default") -> tuple[any, float] | None:
        """Returns (data, cache_age_sec) if fresh and not dirty, else None."""
        with self.lock:
            if self._dirty:
                return None
            entry = self._cache.get(key)
            if not entry:
                return None
            data, timestamp = entry
            age = time.time() - timestamp
            if age <= self.ttl_seconds:
                return data, age
            return None

    def get_stale(self, key: str = "default") -> tuple[any, float] | None:
        """Returns (data, cache_age_sec) even if expired, for rate limit fallback."""
        with self.lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            data, timestamp = entry
            return data, time.time() - timestamp

    def set(self, key: str = "default", data: any = None) -> None:
        with self.lock:
            self._cache[key] = (data, time.time())
            self._dirty = False

    def mark_dirty(self) -> None:
        with self.lock:
            self._dirty = True

    def invalidate(self, key: str | None = None) -> None:
        with self.lock:
            if key is None:
                self._cache.clear()
            else:
                self._cache.pop(key, None)

    def clear(self) -> None:
        with self.lock:
            self._cache.clear()
            self._dirty = True


# ─────────────────────────────────────────────────────────────────────────────
# 4. Order Validation & Helper Rules
# ─────────────────────────────────────────────────────────────────────────────

def validate_order_quantity(ap_code_val: str, quantity: int) -> tuple[bool, str]:
    """
    Validates single order quantity limit:
    - Common ("1") / AfterMarket ("2"): 1 <= qty <= 499 sheets
    - Odd ("3") / IntradayOdd ("5"): 1 <= qty <= 999 shares
    - Emg ("4"): 1 <= qty <= 499,000 shares (>1000 must be multiple of 1000)
    """
    try:
        qty = int(quantity)
    except (ValueError, TypeError):
        return False, "委託數量必須為正整數"

    code = str(ap_code_val).strip()
    if code in ("1", "2"):  # Common (整股) or AfterMarket (盤後定價)
        if qty < 1 or qty > 499:
            return False, f"整股/盤後定價單筆委託數量必須在 1 至 499 張之間 (目前為 {qty})"
    elif code in ("3", "5"):  # Odd (盤後零股) or IntradayOdd (盤中零股)
        if qty < 1 or qty > 999:
            return False, f"零股單筆委託數量必須在 1 至 999 股之間 (目前為 {qty})"
    elif code == "4":  # Emg (興櫃)
        if qty < 1 or qty > 499000:
            return False, f"興櫃委託數量必須在 1 至 499,000 股之間 (目前為 {qty})"
        if qty > 1000 and (qty % 1000 != 0):
            return False, f"興櫃超過 1,000 股部分必須為 1,000 的整數倍 (目前為 {qty})"
    return True, ""


def check_and_clamp_date_range(start_str: str, end_str: str) -> tuple[str, str, str | None]:
    """
    Validates date range and clamps start_date to end_date - 180 days if > 180 days (AW00002 / AW00003).
    Returns (clamped_start_str, end_str, error_message).
    """
    def _parse(s: str) -> datetime.date | None:
        s = s.strip()
        for fmt in ("%Y-%m-%d", "%Y%m%d"):
            try:
                return datetime.datetime.strptime(s, fmt).date()
            except ValueError:
                pass
        return None

    s_date = _parse(start_str)
    e_date = _parse(end_str)
    if not s_date or not e_date:
        return "", "", "日期格式錯誤，請使用 YYYY-MM-DD 或 YYYYMMDD"

    if s_date > e_date:
        return "", "", "起始日期不得大於結束日期"

    delta_days = (e_date - s_date).days
    if delta_days > 180:
        s_date = e_date - datetime.timedelta(days=180)

    return s_date.strftime("%Y-%m-%d"), e_date.strftime("%Y-%m-%d"), None


# Enum mapping helpers
def to_action(val: any) -> any:
    if Action and isinstance(val, Action):
        return val
    s = str(val or "B").strip().upper()
    if Action:
        return Action.Buy if s in ("B", "BUY", "ACTION.BUY") else Action.Sell
    return s


def to_ap_code(val: any) -> any:
    if APCode and isinstance(val, APCode):
        return val
    s = str(val or "1").strip().upper()
    mapping = {
        "1": "1", "COMMON": "1",
        "2": "2", "AFTERMARKET": "2",
        "3": "3", "ODD": "3",
        "4": "4", "EMG": "4",
        "5": "5", "INTRADAYODD": "5",
    }
    raw = mapping.get(s, "1")
    return APCode(raw) if APCode else raw


def to_bs_flag(val: any) -> any:
    if BSFlag and isinstance(val, BSFlag):
        return val
    s = str(val or "R").strip().upper()
    mapping = {
        "R": "R", "ROD": "R",
        "I": "I", "IOC": "I",
        "F": "F", "FOK": "F",
    }
    raw = mapping.get(s, "R")
    return BSFlag(raw) if BSFlag else raw


def to_price_flag(val: any) -> any:
    if PriceFlag and isinstance(val, PriceFlag):
        return val
    s = str(val or "0").strip().upper()
    mapping = {
        "0": "0", "LIMIT": "0", "LMT": "0",
        "1": "1", "FLAT": "1",
        "2": "2", "LIMITDOWN": "2",
        "3": "3", "LIMITUP": "3",
        "4": "4", "MARKET": "4", "MKT": "4",
    }
    raw = mapping.get(s, "0")
    return PriceFlag(raw) if PriceFlag else raw


def to_trade(val: any) -> any:
    if Trade and isinstance(val, Trade):
        return val
    s = str(val or "0").strip().upper()
    mapping = {
        "0": "0", "CASH": "0",
        "3": "3", "MARGIN": "3",
        "4": "4", "SHORT": "4",
        "A": "A", "DAYTRADINGSELL": "A",
    }
    raw = mapping.get(s, "0")
    return Trade(raw) if Trade else raw


# ─────────────────────────────────────────────────────────────────────────────
# 5. Thread-safe OrderBookCache
# ─────────────────────────────────────────────────────────────────────────────

class OrderBookCache:
    """
    Thread-safe in-memory cache of day orders dual-indexed by ord_no and pre_ord_no.
    Updated from get_order_results(), WebSocket ACK events, and MAT deal events.
    """

    def __init__(self):
        self._orders: dict[str, dict] = {}
        self._ord_no_map: dict[str, str] = {}
        self._pre_ord_no_map: dict[str, str] = {}
        self.lock = threading.RLock()

    def update_from_order_results(self, orders: list) -> None:
        with self.lock:
            for o in orders:
                if isinstance(o, dict):
                    self._upsert(o)

    def update_from_ack(self, ack_data: dict) -> None:
        with self.lock:
            self._upsert(ack_data)

    def update_from_mat(self, mat_data: dict) -> None:
        with self.lock:
            ord_no = mat_data.get("ord_no") or mat_data.get("ordNo")
            target = None
            if ord_no and ord_no in self._ord_no_map:
                target = self._orders[self._ord_no_map[ord_no]]
            if target is not None:
                mat_qty = mat_data.get("deal_qty") or mat_data.get("mat_qty") or mat_data.get("qty") or 0
                try:
                    target["deal_qty"] = int(target.get("deal_qty", 0)) + int(mat_qty)
                except (ValueError, TypeError):
                    pass
                if "mat_time" in mat_data:
                    target["mat_time"] = mat_data["mat_time"]
                try:
                    org_qty = int(target.get("org_qty") or target.get("quantity") or 0)
                    if int(target.get("deal_qty", 0)) >= org_qty:
                        target["status"] = "Filled"
                    else:
                        target["status"] = "PartFilled"
                except (ValueError, TypeError):
                    pass

    def _upsert(self, data: dict) -> str:
        ord_no = str(data.get("ord_no") or data.get("ordNo") or "").strip()
        pre_ord_no = str(data.get("pre_ord_no") or data.get("preOrdNo") or "").strip()

        internal_id = None
        if ord_no and ord_no in self._ord_no_map:
            internal_id = self._ord_no_map[ord_no]
        elif pre_ord_no and pre_ord_no in self._pre_ord_no_map:
            internal_id = self._pre_ord_no_map[pre_ord_no]

        if not internal_id:
            internal_id = ord_no or pre_ord_no or f"order_{len(self._orders) + 1}"

        existing = self._orders.get(internal_id, {})
        merged = {**existing, **data}
        self._orders[internal_id] = merged

        if ord_no:
            self._ord_no_map[ord_no] = internal_id
        if pre_ord_no:
            self._pre_ord_no_map[pre_ord_no] = internal_id

        return internal_id

    def get(self, order_id: str) -> dict | None:
        with self.lock:
            if not order_id:
                return None
            key = str(order_id).strip()
            if key in self._ord_no_map:
                return self._orders.get(self._ord_no_map[key])
            if key in self._pre_ord_no_map:
                return self._orders.get(self._pre_ord_no_map[key])
            if key in self._orders:
                return self._orders.get(key)
            return None

    def get_all(self) -> list[dict]:
        with self.lock:
            return list(self._orders.values())

    def clear(self) -> None:
        with self.lock:
            self._orders.clear()
            self._ord_no_map.clear()
            self._pre_ord_no_map.clear()

    @staticmethod
    def is_reservation(order: dict | None) -> bool:
        """
        Reservation Order Guard (AG0006):
        An order is a reservation order if ord_status == '1', or has pre_ord_no without ord_no,
        or status is 'PreSubmitted'.
        """
        if not order:
            return False
        ord_status = str(order.get("ord_status", "")).strip()
        if ord_status == "1":
            return True
        pre_ord_no = order.get("pre_ord_no") or order.get("preOrdNo")
        ord_no = order.get("ord_no") or order.get("ordNo")
        if pre_ord_no and not ord_no:
            return True
        status = str(order.get("status", "")).strip()
        if status == "PreSubmitted":
            return True
        return False

    @staticmethod
    def can_modify_price(order: dict | None) -> bool:
        """
        Price Modification Guard:
        Only ROD ('R') and Limit ('0') orders may modify price.
        """
        if not order:
            return False
        bs_flag = str(order.get("bs_flag") or order.get("bsFlag") or "").strip().upper()
        order_type = str(order.get("order_type") or "").strip().upper()
        price_flag = str(order.get("price_flag") or order.get("priceFlag") or "").strip().upper()

        is_rod = (bs_flag in ("R", "ROD") or order_type == "ROD")
        is_limit = (price_flag in ("0", "LIMIT", "LMT"))
        return is_rod and is_limit


# ─────────────────────────────────────────────────────────────────────────────
# 6. SSE Fan-out Manager
# ─────────────────────────────────────────────────────────────────────────────

class SSEFanoutManager:
    """Manages active Server-Sent Events subscribers and broadcasts order events and heartbeats."""

    def __init__(self):
        self.subscribers: set[queue.Queue] = set()
        self.lock = threading.Lock()

    def register(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=200)
        with self.lock:
            self.subscribers.add(q)
        return q

    def unregister(self, q: queue.Queue) -> None:
        with self.lock:
            self.subscribers.discard(q)

    def broadcast(self, event_type: str, data: dict, event_id: str | None = None) -> None:
        payload_str = json.dumps(data, ensure_ascii=False)
        parts = []
        if event_id:
            parts.append(f"id: {event_id}\n")
        parts.append(f"event: {event_type}\n")
        parts.append(f"data: {payload_str}\n\n")
        raw_msg = "".join(parts).encode("utf-8")

        with self.lock:
            active_subs = list(self.subscribers)

        for q in active_subs:
            try:
                q.put_nowait(raw_msg)
            except queue.Full:
                pass

    def client_count(self) -> int:
        with self.lock:
            return len(self.subscribers)

    def close_all(self) -> None:
        """Wakes every SSE handler with a None sentinel so connections end on shutdown."""
        with self.lock:
            active_subs = list(self.subscribers)
        for q in active_subs:
            try:
                q.put_nowait(None)
            except queue.Full:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# 7. Bridge Core Engine
# ─────────────────────────────────────────────────────────────────────────────

class EsunTradeBridge:
    """
    Coordinates E.Sun Trading SDK lifecycle, official rate limiters,
    caches, OrderBookCache, and WebSocket fan-out.
    """

    def __init__(
        self,
        config_path: str | None = None,
        sdk_factory: any = None,
        auto_login: bool = True,
    ):
        self.base_dir = (
            os.environ.get("ESUN_CONFIG_DIR")
            or (os.path.dirname(os.path.abspath(config_path)) if config_path else os.getcwd())
        )
        if config_path is not None:
            self.config_path = config_path
        else:
            discovery = discover_esun_config_profiles(self.base_dir)
            if discovery["profiles"]["SIMULATION"]["available"]:
                self.config_path = discovery["profiles"]["SIMULATION"]["filePath"]
            elif discovery["profiles"]["PRODUCTION"]["available"]:
                self.config_path = discovery["profiles"]["PRODUCTION"]["filePath"]
            elif os.environ.get("ESUN_CONFIG_PATH"):
                self.config_path = os.environ.get("ESUN_CONFIG_PATH")
            else:
                default_ini = os.path.join(self.base_dir, "esun-config.ini")
                config_ini = os.path.join(self.base_dir, "config.ini")
                if os.path.exists(default_ini):
                    self.config_path = default_ini
                elif os.path.exists(config_ini):
                    self.config_path = config_ini
                else:
                    self.config_path = default_ini
        self.sdk_factory = sdk_factory or (lambda cfg: SDK(cfg))
        self.sdk: any = None

        cfg, _, env = load_config(self.config_path)
        self.environment = env
        self.entry = cfg.get("Core", "Entry", fallback="").strip() if cfg and cfg.has_section("Core") else ""

        # Lockout & connection states
        self.logged_in = False
        self.login_locked = False
        self.login_error: str | None = None
        self.last_agr0000_time: float = 0.0
        self.hit_agr0004 = False
        self.last_reconnect_time: float = 0.0
        self.last_orders_refresh_time: float = 0.0

        # Rate Limiters
        self.order_mutation_limiter = SlidingWindowRateLimiter(max_requests=18, window_seconds=1.0)
        self.order_mutation_daily = DailyCounter(max_daily_requests=2000)
        self.reconnect_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)
        self.reconnect_daily = DailyCounter(max_daily_requests=300)
        self.settlements_limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=60.0)
        self.orders_refresh_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)
        self.positions_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)
        self.profit_loss_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)

        # Tiered TTL Caches
        self.balance_cache = TTLCache(ttl_seconds=180.0)
        self.settlements_cache = TTLCache(ttl_seconds=25.0)
        self.positions_cache = TTLCache(ttl_seconds=6.0)
        self.profit_loss_cache = TTLCache(ttl_seconds=10.0)
        self.trade_status_cache = TTLCache(ttl_seconds=60.0)
        self.market_status_cache = TTLCache(ttl_seconds=300.0)

        # Order & Stream managers
        self.order_book_cache = OrderBookCache()
        self.sse_fanout = SSEFanoutManager()
        self.ws_thread: threading.Thread | None = None
        self._shutdown_event = threading.Event()

        # Startup login attempt (at most once)
        if auto_login:
            self._attempt_initial_login()

    def attempt_initial_login(self) -> None:
        """Public entry point used by main() after the HTTP port is bound."""
        self._attempt_initial_login()

    def is_shutting_down(self) -> bool:
        return self._shutdown_event.is_set()

    def shutdown(self) -> None:
        """Graceful shutdown: stop accepting SSE work and release subscribers."""
        if self._shutdown_event.is_set():
            return
        self._shutdown_event.set()
        self.sse_fanout.close_all()

    def get_config_profiles(self) -> dict:
        discovery = discover_esun_config_profiles(self.base_dir, self.config_path)
        return {
            "ok": True,
            "availableEnvironments": discovery["availableEnvironments"],
            "configProfiles": {
                k: {
                    "available": v["available"],
                    "fileName": v["fileName"],
                    "expectedFileName": v["expectedFileName"],
                    "aliases": v["aliases"],
                    "entry": v["entry"],
                }
                for k, v in discovery["profiles"].items()
            },
            "activeConfigFile": os.path.basename(self.config_path) if self.config_path and os.path.exists(self.config_path) else None,
            "activeEnvironment": self.environment,
        }

    def _attempt_initial_login(self) -> None:
        """Attempt login at most once at startup; never retry automatically on failure."""
        cfg, problems, env = load_config(self.config_path)
        self.environment = env
        if cfg and cfg.has_section("Core"):
            self.entry = cfg.get("Core", "Entry", fallback="").strip()
        if problems or not cfg:
            self.login_locked = True
            self.login_error = "；".join(problems)
            logger.warning(f"Initial setup incomplete: {self.login_error}")
            return

        try:
            apply_headless_keyring_patches()
            client = self.sdk_factory(cfg)
            client.login()
            self.sdk = client
            self.logged_in = True
            self.login_locked = False
            self.login_error = None
            logger.info("玉山證券登入成功")
            self._start_websocket_thread()
            # Bootstrap OrderBookCache in background thread
            threading.Thread(target=self._bootstrap_orders, daemon=True, name="EsunOrdersBootstrap").start()
        except Exception as e:
            err_msg = str(e)
            self.logged_in = False
            self.login_locked = True
            self.login_error = err_msg
            if "AGR0000" in err_msg:
                self.last_agr0000_time = time.time()
            if "AGR0004" in err_msg:
                self.hit_agr0004 = True
            logger.error(f"玉山證券初始登入失敗 (防鎖帳已啟動，禁止自動重試)：{err_msg}")

    def reconnect(self) -> tuple[bool, dict, int]:
        """
        Manual reconnect with 60s cooldown on AGR0000, 10 req/min sliding window,
        and 300 req/day counter (AGR0004).
        """
        now = time.time()

        # Cooldown guard on AGR0000
        if now - self.last_agr0000_time < 60.0:
            remaining = int(60.0 - (now - self.last_agr0000_time))
            return False, {
                "error": f"登入頻率超限冷卻中 (AGR0000)，請於 {remaining} 秒後再試",
                "code": "AGR0000",
                "cooldown_remaining_sec": remaining,
            }, 429

        # AGR0004 Daily limit
        if self.hit_agr0004 or not self.reconnect_daily.can_increment():
            return False, {
                "error": "已達每日登入上限 300 次 (AGR0004)",
                "code": "AGR0004",
            }, 429

        # 6s Minimum interval
        if now - self.last_reconnect_time < 6.0:
            return False, {
                "error": "重連操作過於頻繁，請於 6 秒後重試",
                "code": "TOO_FREQUENT",
            }, 429

        # 10 req/min sliding window
        if not self.reconnect_limiter.acquire():
            return False, {
                "error": "登入頻率過高 (限 10 次/分，AGR0000)",
                "code": "AGR0000",
            }, 429

        self.last_reconnect_time = now
        self.reconnect_daily.increment()

        # Reload config and try login
        cfg, problems, env = load_config(self.config_path)
        self.environment = env
        if cfg and cfg.has_section("Core"):
            self.entry = cfg.get("Core", "Entry", fallback="").strip()
        if problems or not cfg:
            self.login_locked = True
            self.login_error = "；".join(problems)
            return False, {"error": f"玉山設定不完整：{self.login_error}", "code": "CONFIG_ERROR"}, 503

        try:
            apply_headless_keyring_patches()
            client = self.sdk_factory(cfg)
            client.login()
            self.sdk = client
            self.logged_in = True
            self.login_locked = False
            self.login_error = None
            self._start_websocket_thread()
            aid = cfg["User"]["Account"]
            return True, {
                "ok": True,
                "message": "玉山證券登入成功",
                "account": split_account(aid),
            }, 200
        except Exception as e:
            err_msg = str(e)
            self.logged_in = False
            self.login_locked = True
            self.login_error = err_msg
            if "AGR0000" in err_msg:
                self.last_agr0000_time = time.time()
            if "AGR0004" in err_msg:
                self.hit_agr0004 = True
            return False, {
                "error": f"玉山登入失敗：{err_msg}",
                "code": "LOGIN_FAILED",
                "login_locked": True,
            }, 502

    def _start_websocket_thread(self) -> None:
        """Register singleton WebSocket callbacks and launch connection thread."""
        if not self.sdk or not hasattr(self.sdk, "on"):
            return

        @self.sdk.on("order")
        def _on_order(data: dict):
            self._handle_ack(data)

        @self.sdk.on("dealt")
        def _on_dealt(data: dict):
            self._handle_mat(data)

        @self.sdk.on("error")
        def _on_error(err: any):
            logger.error(f"[WebSocket] Error: {err}")

        @self.sdk.on("close")
        def _on_close(ws: any, code: any, msg: any):
            logger.info(f"[WebSocket] Closed: code={code} msg={msg}")

        def _ws_worker():
            try:
                self.sdk.connect_websocket()
            except Exception as e:
                logger.error(f"[WebSocket] Worker terminated: {e}")

        if self.ws_thread is None or not self.ws_thread.is_alive():
            self.ws_thread = threading.Thread(target=_ws_worker, daemon=True, name="EsunWSWorker")
            self.ws_thread.start()

    def _bootstrap_orders(self) -> None:
        """Bootstrap OrderBookCache with initial get_order_results() call."""
        if not self.sdk or not self.logged_in:
            return
        try:
            orders = self.sdk.get_order_results()
            if isinstance(orders, list):
                self.order_book_cache.update_from_order_results(orders)
        except Exception as e:
            logger.warning(f"Bootstrap orders query failed: {e}")

    def _generate_event_id(self, prefix: str, data: dict) -> str:
        ord_no = data.get("ord_no") or data.get("ordNo") or data.get("pre_ord_no") or data.get("preOrdNo") or ""
        serialized = json.dumps(data, sort_keys=True, ensure_ascii=False)
        digest = hashlib.md5(serialized.encode("utf-8")).hexdigest()[:8]
        return f"esun-{prefix}-{ord_no}-{digest}"

    def _handle_ack(self, data: dict) -> None:
        self.order_book_cache.update_from_ack(data)
        event_id = self._generate_event_id("ack", data)
        stock_order = {
            **data,
            "event_id": event_id,
            "operation": {
                "op_type": "New",
                "op_code": str(data.get("err_code") or data.get("errCode") or "00"),
                "op_msg": str(data.get("err_msg") or data.get("errMsg") or ""),
            },
            "order": {
                "id": str(data.get("ord_no") or data.get("ordNo") or data.get("pre_ord_no") or data.get("preOrdNo") or ""),
                "seqno": str(data.get("ord_no") or data.get("ordNo") or ""),
                "ordno": str(data.get("ord_no") or data.get("ordNo") or ""),
                "action": "Buy" if str(data.get("buy_sell") or data.get("buySell") or "").upper().startswith("B") else "Sell",
                "price": float(data.get("od_price") or data.get("odPrice") or data.get("price") or 0.0),
                "quantity": int(data.get("org_qty") or data.get("orgQty") or data.get("quantity") or 0),
            },
            "status": {
                "id": str(data.get("ord_no") or data.get("ordNo") or ""),
                "order_quantity": int(data.get("org_qty") or data.get("orgQty") or data.get("quantity") or 0),
                "deal_quantity": int(data.get("deal_qty") or data.get("mat_qty") or data.get("matQty") or 0),
                "cancel_quantity": int(data.get("cel_qty") or data.get("celQty") or 0),
            },
            "contract": {
                "code": str(data.get("stock_no") or data.get("stockNo") or ""),
            },
        }
        payload = {
            "state": "StockOrder",
            "data": {
                "StockOrder": stock_order
            },
            "event_id": event_id,
        }
        self.sse_fanout.broadcast("order_event", payload, event_id=event_id)

    def _handle_mat(self, data: dict) -> None:
        self.order_book_cache.update_from_mat(data)
        self.positions_cache.mark_dirty()
        event_id = self._generate_event_id("mat", data)
        stock_deal = {
            **data,
            "event_id": event_id,
            "code": str(data.get("stock_no") or data.get("stockNo") or ""),
            "action": "Buy" if str(data.get("buy_sell") or data.get("buySell") or "").upper().startswith("B") else "Sell",
            "price": float(data.get("deal_price") or data.get("dealPrice") or data.get("price") or 0.0),
            "quantity": int(data.get("deal_qty") or data.get("dealQty") or data.get("mat_qty") or data.get("matQty") or data.get("qty") or 0),
            "ordno": str(data.get("ord_no") or data.get("ordNo") or ""),
            "seqno": str(data.get("ord_no") or data.get("ordNo") or ""),
        }
        payload = {
            "state": "StockDeal",
            "data": {
                "StockDeal": stock_deal
            },
            "event_id": event_id,
        }
        self.sse_fanout.broadcast("order_event", payload, event_id=event_id)

    # ─────────────────────────────────────────────────────────────────────────
    # Status & Accounts
    # ─────────────────────────────────────────────────────────────────────────

    def get_health(self) -> dict:
        discovery = discover_esun_config_profiles(self.base_dir, self.config_path)

        # Re-sync active config_path if files changed or environment became available
        sim_profile = discovery["profiles"].get("SIMULATION", {})
        prod_profile = discovery["profiles"].get("PRODUCTION", {})

        current_env = self.environment
        if current_env in discovery["profiles"] and discovery["profiles"][current_env]["available"]:
            matching_path = discovery["profiles"][current_env]["filePath"]
            if matching_path and matching_path != self.config_path and os.path.exists(matching_path):
                self.config_path = matching_path
        elif current_env == "SIMULATION" and not sim_profile.get("available") and prod_profile.get("available"):
            if prod_profile.get("filePath") and os.path.exists(prod_profile["filePath"]):
                self.config_path = prod_profile["filePath"]
        elif current_env == "PRODUCTION" and not prod_profile.get("available") and sim_profile.get("available"):
            if sim_profile.get("filePath") and os.path.exists(sim_profile["filePath"]):
                self.config_path = sim_profile["filePath"]

        cfg, problems, env = load_config(self.config_path)
        self.environment = env
        if cfg and cfg.has_section("Core"):
            self.entry = cfg.get("Core", "Entry", fallback="").strip()
        account = split_account(cfg["User"].get("Account")) if (cfg and cfg.has_section("User")) else None

        cert_info = None
        machine_time = None
        market_status = None

        if self.logged_in and self.sdk:
            try:
                cert_info = self.sdk.certinfo() if hasattr(self.sdk, "certinfo") else None
            except Exception:
                pass
            try:
                machine_time = self.sdk.get_machine_time() if hasattr(self.sdk, "get_machine_time") else None
            except Exception:
                pass
            try:
                market_status = self.get_market_status()
            except Exception:
                pass

        discovery = discover_esun_config_profiles(self.base_dir, self.config_path)

        return {
            "ok": True,
            "configured": len(problems) == 0,
            "problems": problems,
            "environment": self.environment,
            "simulation": self.environment == "SIMULATION",
            "entry": self.entry,
            "account": account,
            "loggedIn": self.logged_in,
            "loginLocked": self.login_locked,
            "loginError": self.login_error,
            "certInfo": cert_info,
            "machineTime": machine_time,
            "marketStatus": market_status,
            "availableEnvironments": discovery["availableEnvironments"],
            "configProfiles": {
                k: {
                    "available": v["available"],
                    "fileName": v["fileName"],
                    "expectedFileName": v["expectedFileName"],
                    "aliases": v["aliases"],
                    "entry": v["entry"],
                }
                for k, v in discovery["profiles"].items()
            },
            "activeConfigFile": os.path.basename(self.config_path) if self.config_path and os.path.exists(self.config_path) else None,
            "rateLimits": {
                "ordersToday": self.order_mutation_daily.get_count(),
                "ordersDailyMax": 2000,
                "reconnectToday": self.reconnect_daily.get_count(),
                "reconnectDailyMax": 300,
            },
        }

    def switch_environment(self, target_env: str) -> dict[str, any]:
        """
        Switches between SIMULATION and PRODUCTION.
        Validates target environment profile availability.
        Switches activeConfigFile to corresponding profile file if available.
        """
        target_env_normalized = str(target_env or "").strip().upper()
        if target_env_normalized not in ("SIMULATION", "PRODUCTION"):
            raise ValueError(f"不支援的環境設定：{target_env}，僅支援 SIMULATION 或 PRODUCTION")

        discovery = discover_esun_config_profiles(self.base_dir, self.config_path)
        profile_info = discovery["profiles"].get(target_env_normalized, {})

        if not profile_info.get("available", False):
            expected = profile_info.get("expectedFileName", f"esun-config.{target_env_normalized.lower()}.ini")
            cfg, current_problems, _ = load_config(self.config_path)
            return {
                "ok": False,
                "error": f"未提供 {expected} 設定檔，無法切換至 {target_env_normalized}",
                "environment": self.environment,
                "simulation": self.environment == "SIMULATION",
                "entry": self.entry,
                "activeConfigFile": os.path.basename(self.config_path) if self.config_path and os.path.exists(self.config_path) else None,
                "availableEnvironments": discovery["availableEnvironments"],
                "configProfiles": {
                    k: {
                        "available": v["available"],
                        "fileName": v["fileName"],
                        "expectedFileName": v["expectedFileName"],
                        "aliases": v["aliases"],
                        "entry": v["entry"],
                    }
                    for k, v in discovery["profiles"].items()
                },
                "loggedIn": self.logged_in,
                "problems": current_problems,
            }

        self.order_book_cache.clear()
        self.positions_cache.clear()
        self.balance_cache.clear()
        self.settlements_cache.clear()
        self.profit_loss_cache.clear()
        self.trade_status_cache.clear()
        self.market_status_cache.clear()

        target_path = profile_info.get("filePath")
        if target_path and os.path.exists(target_path):
            self.config_path = target_path
            if not os.environ.get("ESUN_CONFIG_DIR"):
                self.base_dir = os.path.dirname(os.path.abspath(self.config_path))

        target_entry = (
            ESUN_SIMULATION_ENTRY if target_env_normalized == "SIMULATION" else ESUN_PRODUCTION_ENTRY
        )

        needs_update = True
        try:
            cfg_check = configparser.ConfigParser()
            cfg_check.read(self.config_path, encoding="utf-8")
            if (
                detect_esun_environment(cfg_check) == target_env_normalized
                and cfg_check.get("Core", "Entry", fallback="").strip().rstrip("/") == target_entry.rstrip("/")
            ):
                needs_update = False
        except Exception:
            needs_update = True

        if needs_update:
            try:
                update_esun_config_environment(self.config_path, target_env_normalized)
            except OSError as e:
                logger.warning(f"Could not update config file {self.config_path}: {e}")

        cfg, problems, loaded_env = load_config(self.config_path)
        self.environment = loaded_env
        self.entry = target_entry
        self.logged_in = False
        self.login_locked = False
        self.login_error = None
        self.sdk = None

        if not problems and cfg:
            try:
                apply_headless_keyring_patches()
                client = self.sdk_factory(cfg)
                client.login()
                self.sdk = client
                self.logged_in = True
                self.login_locked = False
                self.login_error = None
                self._start_websocket_thread()
                threading.Thread(target=self._bootstrap_orders, daemon=True, name="EsunOrdersBootstrap").start()
            except Exception as e:
                err_msg = str(e)
                self.logged_in = False
                self.login_locked = True
                self.login_error = err_msg
                logger.warning(f"環境切換至 {self.environment} 後登入失敗 (非阻斷性)：{err_msg}")
        else:
            self.login_locked = True
            self.login_error = "；".join(problems)

        new_discovery = discover_esun_config_profiles(self.base_dir, self.config_path)
        account = split_account(cfg["User"].get("Account")) if (cfg and cfg.has_section("User")) else None

        return {
            "ok": True,
            "environment": self.environment,
            "simulation": self.environment == "SIMULATION",
            "entry": self.entry,
            "account": account,
            "activeConfigFile": os.path.basename(self.config_path) if self.config_path and os.path.exists(self.config_path) else None,
            "availableEnvironments": new_discovery["availableEnvironments"],
            "configProfiles": {
                k: {
                    "available": v["available"],
                    "fileName": v["fileName"],
                    "expectedFileName": v["expectedFileName"],
                    "aliases": v["aliases"],
                    "entry": v["entry"],
                }
                for k, v in new_discovery["profiles"].items()
            },
            "loggedIn": self.logged_in,
            "problems": problems,
        }

    @staticmethod
    def _extract_cert_meta(cert_info: any) -> tuple[str, str]:
        if not isinstance(cert_info, dict):
            return "", ""
        expire = str(cert_info.get("ca_expiretime") or "")
        if not expire and cert_info.get("not_after"):
            try:
                ts = int(cert_info["not_after"])
                expire = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError, OSError):
                expire = str(cert_info["not_after"])
        person_id = str(cert_info.get("person_id") or "")
        if not person_id and cert_info.get("cn"):
            person_id = str(cert_info["cn"]).split("-")[0].strip()
        return expire, person_id

    def get_ca_expiretime(self) -> dict:
        health = self.get_health()
        expire, _ = self._extract_cert_meta(health.get("certInfo"))
        return {"ca_expiretime": expire}

    def get_accounts(self) -> list[dict]:
        health = self.get_health()
        acc = health.get("account")
        if not acc:
            return []
        expire, person_id = self._extract_cert_meta(health.get("certInfo"))

        return [{
            "account_type": "S",
            "broker_id": acc["broker_id"],
            "account_id": acc["account_id"],
            "signed": True,
            "username": "玉山證券",
            "person_id": person_id,
            "ca_expiretime": expire,
        }]

    # ─────────────────────────────────────────────────────────────────────────
    # Order Mutations (place, replace-price, replace-qty, cancel)
    # ─────────────────────────────────────────────────────────────────────────

    def _ensure_active_login(self) -> None:
        if not self.logged_in or not self.sdk:
            if self.login_locked:
                raise PermissionError(f"玉山尚未登入或已鎖定 (請呼叫 /esun/auth/reconnect 重連)：{self.login_error}")
            raise PermissionError("玉山證券尚未登入")

    def _build_synthetic_order_result(self, order_no: str, payload: dict) -> dict:
        return {
            "ord_no": order_no,
            "pre_ord_no": payload.get("preOrdNo") or payload.get("pre_ord_no") or "",
            "stock_no": payload.get("stockNo") or payload.get("stock_no") or "",
            "buy_sell": str(payload.get("buySell") or payload.get("buy_sell") or "B"),
            "ap_code": str(payload.get("apCode") or payload.get("ap_code") or "1"),
            "price_flag": str(payload.get("priceFlag") or payload.get("price_flag") or "0"),
            "bs_flag": str(payload.get("bsFlag") or payload.get("bs_flag") or "R"),
            "trade": str(payload.get("trade") or "0"),
            "od_price": str(payload.get("price") or "0"),
            "org_qty": int(payload.get("quantity") or 1),
        }

    def place_order(self, payload: dict) -> tuple[any, int]:
        self._ensure_active_login()

        # Rate limits
        if not self.order_mutation_daily.can_increment():
            return {"error": "已達每日委託上限 2,000 次 (AGR0001)", "code": "AGR0001"}, 429
        if not self.order_mutation_limiter.acquire(timeout=0.5):
            return {"error": "委託下單頻率過高，超過每秒 18 次限制 (AGR0002)", "code": "AGR0002"}, 429
        self.order_mutation_daily.increment()

        stock_no = payload.get("stockNo") or payload.get("stock_no")
        buy_sell = payload.get("buySell") or payload.get("buy_sell")
        quantity = payload.get("quantity")
        price = payload.get("price")
        ap_code = payload.get("apCode") or payload.get("ap_code") or "1"
        price_flag = payload.get("priceFlag") or payload.get("price_flag") or "0"
        bs_flag = payload.get("bsFlag") or payload.get("bs_flag") or "R"
        trade = payload.get("trade") or "0"
        user_def = payload.get("userDef") or payload.get("user_def") or ""

        if not stock_no or not buy_sell or quantity is None:
            return {"error": "委託內容不完整（stockNo, buySell, quantity 為必填）", "code": "INVALID_PARAMS"}, 400

        # Validate quantity against official limits
        valid_qty, qty_err = validate_order_quantity(str(ap_code), quantity)
        if not valid_qty:
            return {"error": qty_err, "code": "AG_INVALID_QUANTITY"}, 400

        # Build OrderObject
        try:
            action_enum = to_action(buy_sell)
            ap_code_enum = to_ap_code(ap_code)
            bs_flag_enum = to_bs_flag(bs_flag)
            price_flag_enum = to_price_flag(price_flag)
            trade_enum = to_trade(trade)

            order_obj = OrderObject(
                buy_sell=action_enum,
                price=float(price or 0.0),
                stock_no=str(stock_no),
                quantity=int(quantity),
                ap_code=ap_code_enum,
                bs_flag=bs_flag_enum,
                price_flag=price_flag_enum,
                trade=trade_enum,
                user_def=str(user_def)[:50],
            )
        except Exception as e:
            return {"error": f"委託參數格式錯誤：{e}", "code": "INVALID_ORDER_PARAMS"}, 400

        try:
            res = self.sdk.place_order(order_obj)
            if isinstance(res, dict):
                self.order_book_cache._upsert(res)
            return res, 200
        except Exception as e:
            return {"error": f"玉山下單失敗：{e}", "code": "PLACE_ORDER_ERROR"}, 502

    def replace_price(self, body: dict) -> tuple[any, int]:
        self._ensure_active_login()
        order_no = body.get("orderNo") or body.get("order_no")
        price = body.get("price")
        if not order_no or price is None:
            return {"error": "缺少委託書號 (orderNo) 或價格 (price)", "code": "INVALID_PARAMS"}, 400

        # Rate limits
        if not self.order_mutation_daily.can_increment():
            return {"error": "已達每日委託上限 2,000 次 (AGR0001)", "code": "AGR0001"}, 429
        if not self.order_mutation_limiter.acquire(timeout=0.5):
            return {"error": "委託改價頻率過高 (AGR0002)", "code": "AGR0002"}, 429
        self.order_mutation_daily.increment()

        order = self.order_book_cache.get(order_no)
        payload = body.get("payload") or {}

        # Reservation Guard (AG0006)
        if OrderBookCache.is_reservation(order) or OrderBookCache.is_reservation(payload):
            return {"error": "預約單不可改單 (AG0006)，請先刪單後重新下單", "code": "AG0006"}, 400

        # Price Modify Guard (ROD Limit only)
        target = order or payload
        if target and not OrderBookCache.can_modify_price(target):
            return {"error": "玉山證券僅支援 ROD 限價單改價，市價單或 IOC/FOK 請先刪單再重新下單", "code": "AG_INVALID_PRICE_MODIFY"}, 400

        in_order_result = order or self._build_synthetic_order_result(order_no, payload)
        price_flag_val = body.get("priceFlag") or body.get("price_flag") or "0"
        price_flag_enum = to_price_flag(price_flag_val)

        try:
            res = self.sdk.modify_price(in_order_result, target_price=float(price), price_flag=price_flag_enum)
            if isinstance(res, dict):
                self.order_book_cache._upsert(res)
            return res, 200
        except Exception as e:
            return {"error": f"玉山改價失敗：{e}", "code": "REPLACE_PRICE_ERROR"}, 502

    def replace_qty(self, body: dict) -> tuple[any, int]:
        self._ensure_active_login()
        order_no = body.get("orderNo") or body.get("order_no")
        if not order_no:
            return {"error": "缺少委託書號 (orderNo)", "code": "INVALID_PARAMS"}, 400

        # Rate limits
        if not self.order_mutation_daily.can_increment():
            return {"error": "已達每日委託上限 2,000 次 (AGR0001)", "code": "AGR0001"}, 429
        if not self.order_mutation_limiter.acquire(timeout=0.5):
            return {"error": "委託改量頻率過高 (AGR0002)", "code": "AGR0002"}, 429
        self.order_mutation_daily.increment()

        order = self.order_book_cache.get(order_no)
        payload = body.get("payload") or {}

        # Reservation Guard (AG0006)
        if OrderBookCache.is_reservation(order) or OrderBookCache.is_reservation(payload):
            return {"error": "預約單不可改單 (AG0006)，請先刪單後重新下單", "code": "AG0006"}, 400

        in_order_result = order or self._build_synthetic_order_result(order_no, payload)

        cancel_kwargs = {}
        if "cel_qty" in body:
            cancel_kwargs["cel_qty"] = int(body["cel_qty"])
        elif "cel_qty_share" in body:
            cancel_kwargs["cel_qty_share"] = int(body["cel_qty_share"])
        elif "quantity" in body:
            target_qty = int(body["quantity"])
            current_qty = int(in_order_result.get("org_qty") or in_order_result.get("quantity") or 0)
            cel = current_qty - target_qty
            if cel <= 0:
                return {"error": f"改量目標數量 ({target_qty}) 必須小於原委託數量 ({current_qty})", "code": "INVALID_QTY"}, 400
            ap_code = str(in_order_result.get("ap_code") or in_order_result.get("apCode") or "1")
            if ap_code in ("3", "4", "5"):
                cancel_kwargs["cel_qty_share"] = cel
            else:
                cancel_kwargs["cel_qty"] = cel
        else:
            return {"error": "缺少改量參數 (quantity, cel_qty, 或 cel_qty_share)", "code": "INVALID_PARAMS"}, 400

        try:
            res = self.sdk.cancel_order(in_order_result, **cancel_kwargs)
            if isinstance(res, dict):
                self.order_book_cache._upsert(res)
            return res, 200
        except Exception as e:
            return {"error": f"玉山改量失敗：{e}", "code": "REPLACE_QTY_ERROR"}, 502

    def cancel_order(self, body: dict) -> tuple[any, int]:
        self._ensure_active_login()
        order_no = body.get("orderNo") or body.get("order_no")
        if not order_no:
            return {"error": "缺少委託書號 (orderNo)", "code": "INVALID_PARAMS"}, 400

        # Rate limits
        if not self.order_mutation_daily.can_increment():
            return {"error": "已達每日委託上限 2,000 次 (AGR0001)", "code": "AGR0001"}, 429
        if not self.order_mutation_limiter.acquire(timeout=0.5):
            return {"error": "刪單頻率過高 (AGR0002)", "code": "AGR0002"}, 429
        self.order_mutation_daily.increment()

        order = self.order_book_cache.get(order_no)
        payload = body.get("payload") or {}
        in_order_result = order or self._build_synthetic_order_result(order_no, payload)

        try:
            # sdk.cancel_order without cel_qty cancels all
            res = self.sdk.cancel_order(in_order_result)
            if isinstance(res, dict):
                self.order_book_cache._upsert(res)
            return res, 200
        except Exception as e:
            return {"error": f"玉山刪單失敗：{e}", "code": "CANCEL_ORDER_ERROR"}, 502

    # ─────────────────────────────────────────────────────────────────────────
    # Portfolio Queries with Tiered Caching & Rate Limiting
    # ─────────────────────────────────────────────────────────────────────────

    def get_orders(self, refresh: bool = False) -> list[dict]:
        """
        If refresh is False, returns local OrderBookCache (0 API calls).
        If refresh is True, enforces 5s min interval + 10 rpm limiter (AGR0005).
        """
        now = time.time()
        if not refresh:
            return self.order_book_cache.get_all()

        # Enforce 5s min interval & 10 req/min
        if (now - self.last_orders_refresh_time < 5.0) or not self.orders_refresh_limiter.acquire():
            logger.info("Order results refresh rate limited; serving cached OrderBookCache")
            return self.order_book_cache.get_all()

        self.last_orders_refresh_time = now
        try:
            self._ensure_active_login()
            orders = self.sdk.get_order_results()
            if isinstance(orders, list):
                self.order_book_cache.update_from_order_results(orders)
            return self.order_book_cache.get_all()
        except Exception as e:
            logger.warning(f"get_order_results failed: {e}; serving cached orders")
            return self.order_book_cache.get_all()

    def get_balance(self) -> tuple[dict, int]:
        """Mandatory 180-second TTL cache for get_balance()."""
        cached = self.balance_cache.get("balance")
        if cached is not None:
            data, age = cached
            if isinstance(data, dict):
                return {**data, "cached": True, "cache_age_sec": round(age, 1)}, 200
            return data, 200

        try:
            self._ensure_active_login()
            data = self.sdk.get_balance()
            self.balance_cache.set("balance", data)
            if isinstance(data, dict):
                return {**data, "cached": False, "cache_age_sec": 0.0}, 200
            return data, 200
        except Exception as e:
            # Try serving stale cache if available
            stale = self.balance_cache.get_stale("balance")
            if stale is not None:
                data, age = stale
                if isinstance(data, dict):
                    return {**data, "cached": True, "cache_age_sec": round(age, 1), "stale": True}, 200
            return {"error": f"玉山查詢餘額失敗：{e}", "code": "BALANCE_QUERY_ERROR"}, 502

    def get_settlements(self) -> tuple[any, int]:
        """25-second TTL cache + 3 req/min limiter (AGR0006)."""
        cached = self.settlements_cache.get("settlements")
        if cached is not None:
            data, _ = cached
            return data, 200

        if not self.settlements_limiter.acquire():
            stale = self.settlements_cache.get_stale("settlements")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": "交割款查詢頻率過高 (限 3 次/分，AGR0006)", "code": "AGR0006"}, 429

        try:
            self._ensure_active_login()
            data = self.sdk.get_settlements()
            self.settlements_cache.set("settlements", data)
            return data, 200
        except Exception as e:
            stale = self.settlements_cache.get_stale("settlements")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": f"玉山查詢交割款失敗：{e}", "code": "SETTLEMENTS_QUERY_ERROR"}, 502

    def get_inventories(self) -> tuple[any, int]:
        """6-second TTL cache + 10 req/min limiter (AGR0003), invalidated on MAT deals."""
        cached = self.positions_cache.get("positions")
        if cached is not None:
            data, _ = cached
            return data, 200

        if not self.positions_limiter.acquire():
            stale = self.positions_cache.get_stale("positions")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": "庫存查詢頻率過高 (限 10 次/分，AGR0003)", "code": "AGR0003"}, 429

        try:
            self._ensure_active_login()
            data = self.sdk.get_inventories()
            self.positions_cache.set("positions", data)
            return data, 200
        except Exception as e:
            stale = self.positions_cache.get_stale("positions")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": f"玉山查詢持股庫存失敗：{e}", "code": "INVENTORIES_QUERY_ERROR"}, 502

    def get_profit_loss(self, start_date: str | None, end_date: str | None) -> tuple[any, int]:
        """
        180-day range check/clamping (AW00002/AW00003) + 10s TTL cache + 10 req/min limiter.
        """
        today_str = datetime.date.today().strftime("%Y-%m-%d")
        s_raw = start_date or today_str
        e_raw = end_date or today_str

        clamped_start, clamped_end, err = check_and_clamp_date_range(s_raw, e_raw)
        if err:
            return {"error": err, "code": "INVALID_DATE_RANGE"}, 400

        cache_key = f"{clamped_start}_{clamped_end}"
        cached = self.profit_loss_cache.get(cache_key)
        if cached is not None:
            data, _ = cached
            return data, 200

        if not self.profit_loss_limiter.acquire():
            stale = self.profit_loss_cache.get_stale(cache_key)
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": "損益查詢頻率過高 (限 10 次/分，AGR0003)", "code": "AGR0003"}, 429

        try:
            self._ensure_active_login()
            data = self.sdk.get_transactions_by_date(clamped_start, clamped_end)
            self.profit_loss_cache.set(cache_key, data)
            return data, 200
        except Exception as e:
            stale = self.profit_loss_cache.get_stale(cache_key)
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": f"玉山查詢損益失敗：{e}", "code": "PROFIT_LOSS_ERROR"}, 502

    def get_trade_status(self) -> tuple[any, int]:
        """60-second TTL cache for get_trade_status()."""
        cached = self.trade_status_cache.get("trade_status")
        if cached is not None:
            data, _ = cached
            return data, 200

        try:
            self._ensure_active_login()
            data = self.sdk.get_trade_status()
            self.trade_status_cache.set("trade_status", data)
            return data, 200
        except Exception as e:
            stale = self.trade_status_cache.get_stale("trade_status")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": f"玉山查詢交易額度失敗：{e}", "code": "TRADE_STATUS_ERROR"}, 502

    def get_market_status(self) -> tuple[any, int]:
        """300-second TTL cache for get_market_status()."""
        cached = self.market_status_cache.get("market_status")
        if cached is not None:
            data, _ = cached
            return data, 200

        try:
            self._ensure_active_login()
            data = self.sdk.get_market_status()
            self.market_status_cache.set("market_status", data)
            return data, 200
        except Exception as e:
            stale = self.market_status_cache.get_stale("market_status")
            if stale is not None:
                data, _ = stale
                return data, 200
            return {"error": f"玉山查詢市場狀態失敗：{e}", "code": "MARKET_STATUS_ERROR"}, 502


# ─────────────────────────────────────────────────────────────────────────────
# 8. Access Control (Host allowlist -> token -> CSRF) & HTTP / SSE Handler
# ─────────────────────────────────────────────────────────────────────────────

BRIDGE_TOKEN_HEADER = "X-Esun-Bridge-Token"
BUILTIN_ALLOWED_HOSTS = ("localhost", "127.0.0.1", "::1", "esun-bridge", "host.docker.internal")
MAX_REQUEST_BODY_BYTES = 64 * 1024
REQUEST_SOCKET_TIMEOUT_SECONDS = 30.0
MAX_CONCURRENT_CONNECTIONS = 96
MUTATION_PATHS = frozenset({
    "/esun/orders/place",
    "/esun/orders/replace-price",
    "/esun/orders/replace-qty",
    "/esun/orders/cancel",
})

_PORT_RE = re.compile(r"[0-9]{1,5}")
_CONTENT_LENGTH_RE = re.compile(r"[0-9]+")


def _split_host_port(value: str | None) -> tuple[str, int | None] | None:
    """Parses a Host header value: "host", "host:port", "[::1]", "[::1]:port" or a bare IPv6 literal."""
    v = str(value or "").strip()
    if not v:
        return None
    port: int | None = None
    if v.startswith("["):
        end = v.find("]")
        if end == -1:
            return None
        host = v[1:end]
        rest = v[end + 1:]
        if rest:
            if not rest.startswith(":") or not _PORT_RE.fullmatch(rest[1:]):
                return None
            port = int(rest[1:])
    elif v.count(":") == 1:
        host, _, raw_port = v.partition(":")
        if not _PORT_RE.fullmatch(raw_port):
            return None
        port = int(raw_port)
    else:
        host = v  # plain hostname or a bare IPv6 literal
    host = host.strip().lower().rstrip(".")
    if not host or any(c in host for c in "/@ \t\\"):
        return None
    if port is not None and not (0 < port < 65536):
        return None
    return host, port


def _parse_origin(origin: str | None) -> tuple[str, str, int] | None:
    """Parses an Origin header into (scheme, host, port) with the scheme's default port filled in."""
    v = str(origin or "").strip()
    if not v or v.lower() == "null":
        return None
    try:
        parts = urlsplit(v)
        port = parts.port
    except ValueError:
        return None
    scheme = (parts.scheme or "").lower()
    if scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80
    return scheme, parts.hostname.lower().rstrip("."), port


def _normalize_origin(origin: str | None) -> str | None:
    parsed = _parse_origin(origin)
    if not parsed:
        return None
    scheme, host, port = parsed
    host_fmt = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    return f"{scheme}://{host_fmt}" if port == default_port else f"{scheme}://{host_fmt}:{port}"


def _origin_matches_host(origin: str | None, host_header: str | None) -> bool:
    """Same-origin check: Origin host:port must equal the request Host header (default ports filled in)."""
    parsed_origin = _parse_origin(origin)
    parsed_host = _split_host_port(host_header)
    if not parsed_origin or not parsed_host:
        return False
    scheme, origin_host, origin_port = parsed_origin
    host, host_port = parsed_host
    if host_port is None:
        host_port = 443 if scheme == "https" else 80
    return origin_host == host and origin_port == host_port


def _is_loopback_bind(host: str | None) -> bool:
    h = str(host or "").strip().lower().strip("[]")
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


class AccessPolicy:
    """
    Request access control (checked in order): Host allowlist -> shared token -> CSRF.
    - ESUN_BRIDGE_TOKEN: when set, every request except GET /esun/livez must carry X-Esun-Bridge-Token.
    - ESUN_ALLOWED_HOSTS: extra Host names (comma/whitespace separated; "*.lan" / ".lan" suffix forms).
    - ESUN_ALLOWED_ORIGINS: CORS allowlist of full origins; empty means no CORS headers at all.
    """

    def __init__(
        self,
        token: str | None = None,
        allowed_hosts: any = (),
        allowed_origins: any = (),
    ):
        self.token = str(token or "").strip()
        self.exact_hosts: set[str] = set(BUILTIN_ALLOWED_HOSTS)
        self.suffix_hosts: list[str] = []
        for raw in allowed_hosts or ():
            self._add_host(raw)
        self.allowed_origins: set[str] = set()
        for raw in allowed_origins or ():
            normalized = _normalize_origin(raw)
            if normalized:
                self.allowed_origins.add(normalized)
            elif str(raw or "").strip():
                logger.warning("忽略無效的 ESUN_ALLOWED_ORIGINS 項目：%s", raw)

    @classmethod
    def from_env(cls, environ: dict | None = None) -> "AccessPolicy":
        env = os.environ if environ is None else environ
        hosts = [h for h in re.split(r"[\s,]+", env.get("ESUN_ALLOWED_HOSTS", "") or "") if h]
        origins = [o for o in re.split(r"[\s,]+", env.get("ESUN_ALLOWED_ORIGINS", "") or "") if o]
        return cls(token=env.get("ESUN_BRIDGE_TOKEN", ""), allowed_hosts=hosts, allowed_origins=origins)

    def _add_host(self, raw: any) -> None:
        v = str(raw or "").strip().lower()
        if not v or v == "_" or v.startswith("~"):
            return  # nginx catch-all / regex server_name entries are not host names
        if v.startswith("*."):
            self.suffix_hosts.append(v[1:])
            return
        if v.startswith("."):
            self.suffix_hosts.append(v)
            self.exact_hosts.add(v[1:])
            return
        parsed = _split_host_port(v)
        if parsed:
            self.exact_hosts.add(parsed[0])
        else:
            logger.warning("忽略無效的 ESUN_ALLOWED_HOSTS 項目：%s", raw)

    def host_allowed(self, host_header: str | None) -> bool:
        parsed = _split_host_port(host_header)
        if not parsed:
            return False
        host = parsed[0]
        if host in self.exact_hosts:
            return True
        return any(host.endswith(sfx) and len(host) > len(sfx) for sfx in self.suffix_hosts)

    def origin_allowed(self, origin: str | None) -> bool:
        normalized = _normalize_origin(origin) if origin else None
        return bool(normalized) and normalized in self.allowed_origins

    def token_valid(self, provided: str | None) -> bool:
        if not self.token:
            return True
        return hmac.compare_digest(str(provided or "").encode("utf-8"), self.token.encode("utf-8"))

    def check(
        self,
        method: str,
        host: str | None,
        origin: str | None,
        sec_fetch_site: str | None,
        token: str | None,
    ) -> tuple[int, str, str] | None:
        """Returns (status, code, message) when the request must be refused, else None."""
        if not self.host_allowed(host):
            return 421, "ESUN_HOST_NOT_ALLOWED", "Host 不在允許清單內（請設定 ESUN_ALLOWED_HOSTS）"
        if method == "OPTIONS":
            # Preflights never carry custom headers (the token), so only the CORS allowlist applies.
            if origin is not None and self.origin_allowed(origin):
                return None
            return 403, "ESUN_CROSS_SITE", "不允許的跨來源預檢請求"
        if not self.token_valid(token):
            return 401, "ESUN_UNAUTHORIZED", f"缺少或錯誤的 {BRIDGE_TOKEN_HEADER}"
        origin_ok = origin is not None and self.origin_allowed(origin)
        if sec_fetch_site is not None:
            site = sec_fetch_site.strip().lower()
            if site not in ("same-origin", "none") and not origin_ok:
                return 403, "ESUN_CROSS_SITE", "拒絕跨站請求（Sec-Fetch-Site）"
        if origin is not None and not origin_ok and not _origin_matches_host(origin, host):
            return 403, "ESUN_CROSS_SITE", "拒絕跨來源請求（Origin 與 Host 不符）"
        return None


def _json_default(obj: any) -> any:
    """JSON fallback for SDK enums, sets and datetimes inside SDK results."""
    value = getattr(obj, "value", None)
    if value is not None and not callable(value):
        return value
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return obj.decode("utf-8", "replace")
    return str(obj)


class EsunHTTPRequestHandler(BaseHTTPRequestHandler):
    """Handles /esun/* REST and SSE requests with ThreadingHTTPServer."""

    bridge: EsunTradeBridge
    access_policy: AccessPolicy | None = None
    # StreamRequestHandler.setup() applies this to the client socket: slow-loris reads and
    # writes stalled for 30 seconds (including SSE) drop the connection.
    timeout = REQUEST_SOCKET_TIMEOUT_SECONDS
    server_version = "EsunBridge"
    sys_version = ""

    _cors_origin: str | None = None
    _route_path: str = ""

    def log_request(self, code: any = "-", size: any = "-") -> None:
        """Logs method and path only: query strings may carry identifiers (e.g. person_id)."""
        code_val = getattr(code, "value", code)
        path = urlsplit(self.path or "").path or "-"
        self.log_message('"%s %s" %s %s', self.command, path, str(code_val), str(size))

    def _policy(self) -> AccessPolicy:
        policy = self.access_policy
        if policy is None:
            policy = AccessPolicy.from_env()
            type(self).access_policy = policy
        return policy

    def _is_mutation_path(self) -> bool:
        return self._route_path in MUTATION_PATHS

    def _send_cors_headers(self) -> None:
        if self._cors_origin:
            self.send_header("Access-Control-Allow-Origin", self._cors_origin)
            self.send_header("Vary", "Origin")

    def _send_json(self, status_code: int, data: any, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(data, ensure_ascii=False, default=_json_default).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_cors_headers()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _retry_headers(data: any) -> dict[str, str] | None:
        if isinstance(data, dict):
            retry_after = data.get("retry_after") or data.get("cooldown_remaining_sec")
            if isinstance(retry_after, (int, float)) and retry_after > 0:
                return {"Retry-After": str(max(1, int(math.ceil(retry_after))))}
        return None

    def _send_error_json(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retry_after: float | None = None,
        extra: dict | None = None,
    ) -> None:
        body: dict[str, any] = {"ok": False, "code": code, "error": message}
        if self._is_mutation_path():
            body["outcome"] = "not_sent"
        if extra:
            body.update(extra)
        headers = {"Retry-After": str(max(1, int(math.ceil(retry_after))))} if retry_after else None
        self._send_json(status_code, body, headers)

    def _send_internal_error(self) -> None:
        request_id = secrets.token_hex(4)
        logger.error(
            "內部錯誤 request_id=%s %s %s\n%s",
            request_id,
            self.command,
            self._route_path,
            redact(traceback.format_exc()),
        )
        body: dict[str, any] = {
            "ok": False,
            "code": "ESUN_INTERNAL_ERROR",
            "error": f"伺服器內部錯誤（request id：{request_id}）",
            "requestId": request_id,
        }
        if self._is_mutation_path():
            # The failure may have happened after the SDK call: never claim "not sent".
            body["outcome"] = "unknown"
        try:
            self._send_json(500, body)
        except OSError:
            pass

    def _guard(self, method: str) -> bool:
        """Applies Host allowlist -> token -> CSRF checks; sends the refusal and returns False on failure."""
        policy = self._policy()
        origin = self.headers.get("Origin")
        self._cors_origin = origin.strip() if (origin is not None and policy.origin_allowed(origin)) else None
        failure = policy.check(
            method,
            self.headers.get("Host"),
            origin,
            self.headers.get("Sec-Fetch-Site"),
            self.headers.get(BRIDGE_TOKEN_HEADER),
        )
        if failure:
            status, code, message = failure
            self.close_connection = True
            self._send_error_json(status, code, message)
            return False
        return True

    def _read_json_body(self) -> dict | None:
        """Reads a bounded application/json object body; sends the error and returns None on failure."""
        content_type = self.headers.get("Content-Type", "") or ""
        mime = content_type.split(";", 1)[0].strip().lower()
        if mime != "application/json":
            self.close_connection = True
            self._send_error_json(415, "ESUN_UNSUPPORTED_MEDIA_TYPE", "POST 必須使用 Content-Type: application/json")
            return None
        raw_length = (self.headers.get("Content-Length") or "").strip()
        if not _CONTENT_LENGTH_RE.fullmatch(raw_length):
            self.close_connection = True
            self._send_error_json(411, "ESUN_LENGTH_REQUIRED", "缺少或無效的 Content-Length")
            return None
        length = int(raw_length)
        if length > MAX_REQUEST_BODY_BYTES:
            self.close_connection = True
            self._send_error_json(413, "ESUN_PAYLOAD_TOO_LARGE", "請求本文超過 64 KiB 上限")
            return None
        raw = self.rfile.read(length) if length else b""
        if len(raw) != length:
            self.close_connection = True
            self._send_error_json(400, "ESUN_INVALID_JSON", "請求本文不完整")
            return None
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self._send_error_json(400, "ESUN_INVALID_JSON", "JSON 格式錯誤")
            return None
        if not isinstance(body, dict):
            self._send_error_json(400, "ESUN_INVALID_JSON", "請求本文必須為 JSON 物件")
            return None
        return body

    def do_OPTIONS(self) -> None:
        self._cors_origin = None
        self._route_path = urlsplit(self.path or "").path.rstrip("/")
        if not self._guard("OPTIONS"):
            return
        self.send_response(204)
        self._send_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {BRIDGE_TOKEN_HEADER}")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        self._cors_origin = None
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        self._route_path = path

        if path == "/esun/livez":
            # Liveness only: no authentication, no SDK, no disk access, no state.
            self._send_json(200, {"ok": True})
            return
        if not self._guard("GET"):
            return
        qs = parse_qs(parsed.query)

        try:
            if path == "/esun/health":
                self._send_json(200, self.bridge.get_health())
            elif path == "/esun/accounts":
                self._send_json(200, self.bridge.get_accounts())
            elif path in ("/esun/ca_expiretime", "/esun/ca_expire"):
                self._send_json(200, self.bridge.get_ca_expiretime())
            elif path == "/esun/orders":
                refresh = qs.get("refresh", ["false"])[0].lower() == "true"
                self._send_json(200, self.bridge.get_orders(refresh=refresh))
            elif path == "/esun/portfolio/positions":
                data, code = self.bridge.get_inventories()
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/portfolio/balance":
                data, code = self.bridge.get_balance()
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/portfolio/settlements":
                data, code = self.bridge.get_settlements()
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/portfolio/profit-loss":
                start = qs.get("begin_date", [None])[0] or qs.get("start", [None])[0] or qs.get("start_date", [None])[0]
                end = qs.get("end_date", [None])[0] or qs.get("end", [None])[0]
                data, code = self.bridge.get_profit_loss(start, end)
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/portfolio/trading-limits":
                data, code = self.bridge.get_trade_status()
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/market_status":
                data, code = self.bridge.get_market_status()
                self._send_json(code, data, self._retry_headers(data))
            elif path == "/esun/config-profiles":
                self._send_json(200, self.bridge.get_config_profiles())
            elif path == "/esun/stream/orders":
                self._handle_sse(qs)
            else:
                self._send_error_json(404, "ESUN_NOT_FOUND", f"未知的端點 GET {path}")
        except Exception:
            self._send_internal_error()

    def do_POST(self) -> None:
        self._cors_origin = None
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        self._route_path = path

        if not self._guard("POST"):
            return
        body = self._read_json_body()
        if body is None:
            return

        try:
            if path == "/esun/auth/reconnect":
                _, res, code = self.bridge.reconnect()
                self._send_json(code, res, self._retry_headers(res))
            elif path in ("/esun/auth/environment", "/esun/environment"):
                target = body.get("environment")
                if target is None and "simulation" in body:
                    target = "SIMULATION" if body["simulation"] else "PRODUCTION"
                if not target:
                    self._send_error_json(400, "ESUN_INVALID_PARAMS", "缺少 environment 參數 (SIMULATION 或 PRODUCTION)")
                    return
                try:
                    res = self.bridge.switch_environment(str(target))
                    status_code = 200 if res.get("ok") else 400
                    self._send_json(status_code, res)
                except ValueError as ve:
                    self._send_error_json(400, "ESUN_INVALID_PARAMS", str(ve))
            elif path == "/esun/orders/place":
                payload = body.get("payload") if "payload" in body else body
                res, code = self.bridge.place_order(payload)
                self._send_json(code, res)
            elif path == "/esun/orders/replace-price":
                res, code = self.bridge.replace_price(body)
                self._send_json(code, res)
            elif path == "/esun/orders/replace-qty":
                res, code = self.bridge.replace_qty(body)
                self._send_json(code, res)
            elif path == "/esun/orders/cancel":
                res, code = self.bridge.cancel_order(body)
                self._send_json(code, res)
            else:
                self._send_error_json(404, "ESUN_NOT_FOUND", f"未知的端點 POST {path}")
        except PermissionError as pe:
            self._send_error_json(503, "NOT_LOGGED_IN", redact(pe))
        except Exception:
            self._send_internal_error()

    def _handle_sse(self, qs: dict) -> None:
        """Handles /esun/stream/orders SSE connections with fan-out and 25s heartbeats."""
        if self.bridge.is_shutting_down():
            self._send_error_json(503, "ESUN_SHUTTING_DOWN", "服務關閉中")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_cors_headers()
        self.end_headers()

        q = self.bridge.sse_fanout.register()
        try:
            # Send initial connected heartbeat
            initial_hb = f"event: heartbeat\ndata: {json.dumps({'time': datetime.datetime.now().isoformat(), 'connected': True})}\n\n"
            self.wfile.write(initial_hb.encode("utf-8"))
            self.wfile.flush()

            while not self.bridge.is_shutting_down():
                try:
                    # Wait for next event or 25-second heartbeat
                    msg = q.get(timeout=25.0)
                    if msg is None:
                        break
                    self.wfile.write(msg)
                    self.wfile.flush()
                except queue.Empty:
                    # Send periodic 25s heartbeat
                    hb = f"event: heartbeat\ndata: {json.dumps({'time': datetime.datetime.now().isoformat()})}\n\n"
                    self.wfile.write(hb.encode("utf-8"))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.bridge.sse_fanout.unregister(q)


# ─────────────────────────────────────────────────────────────────────────────
# 9. Server Factory, Graceful Shutdown & Main Entry Point
# ─────────────────────────────────────────────────────────────────────────────

class EsunThreadingHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer with a bounded number of concurrent connections (SSE included)."""

    daemon_threads = True
    request_queue_size = 64

    def __init__(self, server_address: any, handler_class: any, max_connections: int = MAX_CONCURRENT_CONNECTIONS):
        self._connection_slots = threading.BoundedSemaphore(max_connections)
        super().__init__(server_address, handler_class)

    def process_request(self, request: any, client_address: any) -> None:
        if not self._connection_slots.acquire(blocking=False):
            try:
                request.sendall(
                    b"HTTP/1.0 503 Service Unavailable\r\nContent-Type: application/json\r\n"
                    b"Content-Length: 2\r\nConnection: close\r\n\r\n{}"
                )
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connection_slots.release()
            raise

    def process_request_thread(self, request: any, client_address: any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connection_slots.release()


def create_server(
    host: str = "127.0.0.1",
    port: int = 8090,
    bridge: EsunTradeBridge | None = None,
    access_policy: AccessPolicy | None = None,
    max_connections: int = MAX_CONCURRENT_CONNECTIONS,
) -> ThreadingHTTPServer:
    """Creates a bounded ThreadingHTTPServer bound to the provided or default EsunTradeBridge."""
    if bridge is None:
        bridge = EsunTradeBridge()
    policy = access_policy if access_policy is not None else AccessPolicy.from_env()

    class BoundHandler(EsunHTTPRequestHandler):
        pass

    BoundHandler.bridge = bridge
    BoundHandler.access_policy = policy
    server = EsunThreadingHTTPServer((host, port), BoundHandler, max_connections=max_connections)
    server.bridge = bridge
    server.access_policy = policy
    return server


def make_shutdown_handler(server: ThreadingHTTPServer, bridge: EsunTradeBridge) -> any:
    """
    Builds the SIGTERM/SIGINT handler: stops the bridge (WebSocket, SSE) and calls
    server.shutdown() from a helper thread (calling it on the serve_forever thread deadlocks).
    """
    started = threading.Event()

    def _handler(signum: any = None, frame: any = None) -> None:
        if started.is_set():
            return
        started.set()
        logger.info("收到停止訊號（%s），開始優雅關閉…", signum)

        def _stop() -> None:
            try:
                bridge.shutdown()
            finally:
                server.shutdown()

        threading.Thread(target=_stop, daemon=True, name="EsunShutdown").start()

    return _handler


def install_signal_handlers(server: ThreadingHTTPServer, bridge: EsunTradeBridge) -> any:
    handler = make_shutdown_handler(server, bridge)
    for name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass  # not on the main thread or unsupported on this platform
    return handler


def main() -> int:
    host = os.environ.get("ESUN_SERVER_HOST") or os.environ.get("ESUN_BRIDGE_HOST") or "127.0.0.1"
    port = int(os.environ.get("ESUN_SERVER_PORT") or os.environ.get("ESUN_BRIDGE_PORT") or 8090)

    policy = AccessPolicy.from_env()
    if not policy.token and not _is_loopback_bind(host):
        logger.warning("=" * 78)
        logger.warning(
            "WARNING: esun-bridge 綁定在非 loopback 位址 %s 但未設定 ESUN_BRIDGE_TOKEN；"
            "任何能連到此埠的主機都能下單、刪單與切換環境。請設定 ESUN_BRIDGE_TOKEN 並僅經由反向代理存取。",
            host,
        )
        logger.warning("=" * 78)

    bridge = EsunTradeBridge(auto_login=False)
    server = create_server(host=host, port=port, bridge=bridge, access_policy=policy)
    logger.info(f"玉山證券交易 Sidecar 啟動中：http://{host}:{port}")

    status = bridge.get_health()
    if status["account"]:
        account = status["account"]
        logger.info(
            "綁定帳號：%s-%s 環境：%s",
            account.get("broker_id"),
            mask_identifier(account.get("account_id")),
            status["environment"],
        )
    if status["problems"]:
        for p in status["problems"]:
            logger.warning(f"設定問題：{p}")

    install_signal_handlers(server, bridge)
    # Bind first, then log in (in the background) so /esun/livez answers immediately.
    threading.Thread(target=bridge.attempt_initial_login, daemon=True, name="EsunInitialLogin").start()

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        bridge.shutdown()
        server.server_close()
        logger.info("伺服器已正常停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
