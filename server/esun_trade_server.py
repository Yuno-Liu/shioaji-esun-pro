"""
esun_trade_server.py — E.Sun Securities (玉山證券) Trading Sidecar Service

Provides a local REST & SSE service (default http://127.0.0.1:8090) bridging
the official Python SDK (`esun_trade`) with frontend trading & account interfaces.

Key Protections & Features:
1. Headless Keyring Injection: No interactive prompt (getpass) or native keyring hang; the patch
   is verified against the SDK and interactive getpass is hard-disabled.
2. Login Circuit Breaker: startup, reconnect and environment switch share one guard. Credential
   failures (e.g. AGA0000) are persisted in ESUN_STATE_DIR so restarts never auto-retry a wrong
   password; only an explicit reconnect (with changed credentials, or force) lifts the lock.
3. Access Control: Host allowlist, optional ESUN_BRIDGE_TOKEN, CSRF checks (Sec-Fetch-Site /
   Origin vs Host), JSON-only POST bodies <= 64 KiB, allowlisted CORS only, socket timeouts.
4. Immutable session snapshot (generation): /esun/health is read-only, environment switches never
   write the user's ini files, mutations must match expected_environment / expected_account.
5. Official Rate Limiters & Sliding Windows:
   - Order mutations: 18 req/sec sliding window (protecting 20 rps AGR0002) & 2,000 req/day (AGR0001).
   - Balance query: mandatory 180s TTL cache (1 call per 180s).
   - Settlements query: 25s TTL cache + 3 req/min limiter (AGR0006).
   - Order query: OrderBookCache (0 calls for refresh=false), 5s min interval + 10 req/min for refresh=true (AGR0005).
   - Positions query: 6s TTL cache + 10 req/min limiter (AGR0003), invalidated on MAT deal.
   - Profit/Loss query: 180-day range clamp + 10s TTL cache + 10 req/min limiter.
   - Trading limits query: 60s TTL cache.
   - Market status query: 300s TTL cache.
   - Login: 60s cooldown on AGR0000, 10 req/min limiter, 300 req/day counter (AGR0004).
6. Mutation envelope: accepted / not_sent / rejected / unknown; replace-qty is reduce-by
   (cancel_quantity + quantity_unit lot|share).
7. Reservation Order Guard: Rejects price/quantity modifications on reservation orders (AG0006).
8. Price Modification Guard: Rejects price modifications on non-ROD or non-Limit orders.
9. Generation-scoped WebSocket supervisor (backoff reconnect, ping/pong, silence detection) ->
   SSE fan-out with "<boot_id>-<seq>" ids, a 500-event replay ring, resync and session events.
10. Graceful shutdown on SIGTERM / SIGINT; GET /esun/livez for container health checks.
"""

from __future__ import annotations

import collections
import configparser
import dataclasses
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
import random
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
# 1. Headless Keyring Injection & WebSocket Keep-alive Patch
# ─────────────────────────────────────────────────────────────────────────────

HEADLESS_PATCH_STATE: dict[str, any] = {"ok": False, "detail": "尚未套用"}
SUPPORTED_SDK_VERSION_PREFIXES = ("2.2.",)
_INTERACTIVE_CREDENTIAL_NAMES = frozenset({
    "ft_check_password", "ft_get_password", "ft_set_password", "get_password", "getpass",
})


def _detect_sdk_version() -> str | None:
    try:
        from importlib import metadata as importlib_metadata
        return importlib_metadata.version("esun_trade")
    except Exception:
        return None


ESUN_SDK_VERSION = _detect_sdk_version()


def _headless_getpass_guard(prompt: str = "", stream: any = None) -> str:
    raise RuntimeError(
        "esun-bridge 已停用互動式密碼輸入；請以 ESUN_ACCOUNT_PASSWORD / ESUN_CERT_PASSWORD 環境變數提供密碼"
    )


def _code_names(func: any) -> set[str]:
    code = getattr(func, "__code__", None)
    return set(getattr(code, "co_names", ()) or ())


def apply_headless_keyring_patches() -> bool:
    """
    Monkey-patch esun_trade.util.setup_keyring (no-op) and
    esun_trade.util.load_credentials to return passwords from environment variables,
    guaranteeing that SDK(config) and sdk.login() NEVER call getpass() or hang
    in headless environments.

    The patch is verified against the SDK's code objects (SDK.__init__ must call the
    module-level setup_keyring and SDK.login the module-level load_credentials, with no
    interactive keyring/getpass helper); interactive getpass is replaced by a function
    that raises. Returns True only when the headless path is guaranteed.
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
        if hasattr(esun_trade.util, "getpass"):
            esun_trade.util.getpass = _headless_getpass_guard
    except ImportError:
        pass

    ok = False
    detail = "esun_trade 未安裝"
    try:
        import esun_trade.sdk
        esun_trade.sdk.setup_keyring = _no_op_setup_keyring
        esun_trade.sdk.load_credentials = _headless_load_credentials
        if hasattr(esun_trade.sdk, "getpass"):
            esun_trade.sdk.getpass = _headless_getpass_guard
        sdk_cls = getattr(esun_trade.sdk, "SDK", None)
        init_names = _code_names(getattr(sdk_cls, "__init__", None))
        login_names = _code_names(getattr(sdk_cls, "login", None))
        uses_patched_names = "setup_keyring" in init_names and "load_credentials" in login_names
        interactive = sorted(_INTERACTIVE_CREDENTIAL_NAMES & (init_names | login_names))
        ok = (
            uses_patched_names
            and not interactive
            and esun_trade.sdk.load_credentials is _headless_load_credentials
            and esun_trade.sdk.setup_keyring is _no_op_setup_keyring
        )
        if ok:
            detail = "ok"
        elif interactive:
            detail = f"esun_trade SDK 登入流程呼叫互動式函式 {interactive}，headless patch 無法保證不會卡住"
        else:
            detail = "esun_trade SDK 未使用模組層級 setup_keyring/load_credentials，headless patch 未生效"
    except ImportError:
        pass
    HEADLESS_PATCH_STATE["ok"] = ok
    HEADLESS_PATCH_STATE["detail"] = detail
    if not ok and detail != "esun_trade 未安裝":
        logger.error(f"[headless] {detail}（esun_trade {ESUN_SDK_VERSION}）；已停用自動登入")
    return ok


# Apply patches immediately upon module import
apply_headless_keyring_patches()
if ESUN_SDK_VERSION and not ESUN_SDK_VERSION.startswith(SUPPORTED_SDK_VERSION_PREFIXES):
    logger.warning(f"esun_trade {ESUN_SDK_VERSION} 未經驗證（已驗證：{', '.join(SUPPORTED_SDK_VERSION_PREFIXES)}x）")

WS_PING_INTERVAL_SECONDS = 30
WS_PING_TIMEOUT_SECONDS = 10


def apply_websocket_patches() -> bool:
    """
    Replaces esun_trade.websocket.WebsocketHandler.connect_websocket so the bridge can
    (1) keep a handle on the WebSocketApp and close it on session switch, silence or shutdown,
    (2) run websocket-client ping/pong keep-alive (detects half-open TCP connections), and
    (3) observe open / message / ping / pong activity for silence detection.
    Also adds SDK.close_websocket(). Returns True when the patch is active.
    """
    try:
        import esun_trade.websocket as esun_ws
        from websocket import WebSocketApp
    except ImportError:
        return False
    handler_cls = getattr(esun_ws, "WebsocketHandler", None)
    if handler_cls is None:
        return False
    if getattr(handler_cls, "_esun_bridge_patched", False):
        return True

    def _call_hook(handler: any, name: str) -> None:
        hook = getattr(handler, name, None)
        if callable(hook):
            try:
                hook()
            except Exception:
                logger.debug("WebSocket hook %s failed", name, exc_info=True)

    def _bridge_connect_websocket(self: any, url_entry: str) -> None:
        def _on_open(ws: any) -> None:
            _call_hook(self, "bridge_open_hook")

        def _on_message(ws: any, message: any) -> None:
            _call_hook(self, "bridge_activity_hook")
            self.ws_on_message(ws, message)

        def _on_ping(ws: any, data: any) -> None:
            _call_hook(self, "bridge_activity_hook")

        def _on_pong(ws: any, data: any) -> None:
            _call_hook(self, "bridge_activity_hook")

        app = WebSocketApp(
            url_entry,
            on_open=_on_open,
            on_message=_on_message,
            on_error=self.ws_on_error,
            on_close=self.ws_on_close,
            on_ping=_on_ping,
            on_pong=_on_pong,
        )
        self._WebsocketHandler__ws = app
        self.bridge_ws_app = app
        app.run_forever(ping_interval=WS_PING_INTERVAL_SECONDS, ping_timeout=WS_PING_TIMEOUT_SECONDS)

    def _bridge_close_websocket(self: any) -> None:
        app = getattr(self, "bridge_ws_app", None)
        if app is not None:
            app.close()

    handler_cls.connect_websocket = _bridge_connect_websocket
    handler_cls.close_websocket = _bridge_close_websocket
    handler_cls._esun_bridge_patched = True

    try:
        import esun_trade.sdk as esun_sdk
        sdk_cls = getattr(esun_sdk, "SDK", None)
        if sdk_cls is not None and not hasattr(sdk_cls, "close_websocket"):
            def _sdk_close_websocket(self: any) -> None:
                handler = getattr(self, "_SDK__wsHandler", None)
                closer = getattr(handler, "close_websocket", None)
                if callable(closer):
                    closer()

            sdk_cls.close_websocket = _sdk_close_websocket
    except ImportError:
        pass
    return True


WS_PATCH_ACTIVE = apply_websocket_patches()
if ESUN_SDK_VERSION and not WS_PATCH_ACTIVE:
    logger.warning("WebSocket keep-alive patch 未生效：無法主動關閉舊連線，ping/pong 斷線偵測停用（僅剩靜默偵測）")


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

# Config files are user-edited: accept a UTF-8 BOM (e.g. Windows PowerShell 5.1 Set-Content -Encoding UTF8).
CONFIG_ENCODING = "utf-8-sig"


def _describe_config_parse_error(exc: Exception) -> str:
    """Describes a config parsing failure WITHOUT echoing file content (a broken line may hold the API secret)."""
    if isinstance(exc, UnicodeDecodeError):
        return "解析設定檔失敗：檔案編碼錯誤（請以 UTF-8 儲存）"
    lineno = getattr(exc, "lineno", None)
    if lineno:
        return f"解析設定檔失敗：第 {lineno} 行格式錯誤"
    errors = getattr(exc, "errors", None) or []
    line_numbers = [str(item[0]) for item in errors if isinstance(item, tuple) and item]
    if line_numbers:
        return f"解析設定檔失敗：第 {', '.join(line_numbers[:5])} 行格式錯誤"
    return f"解析設定檔失敗：{type(exc).__name__}"


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
        cp.read(config_path, encoding=CONFIG_ENCODING)
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
    Read-only: never modifies any file.
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
                cp.read(found_fallback, encoding=CONFIG_ENCODING)
                detected = detect_esun_environment(cp)
                if detected == "SIMULATION":
                    sim_path = found_fallback
                elif detected == "PRODUCTION":
                    prod_path = found_fallback
            except Exception as e:
                logger.warning(
                    f"Failed to parse fallback config file {os.path.basename(found_fallback)}: "
                    f"{_describe_config_parse_error(e)}"
                )

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


def public_config_profiles(discovery: dict) -> dict:
    """Profile info safe to return to clients (no absolute file paths)."""
    return {
        k: {
            "available": v["available"],
            "fileName": v["fileName"],
            "expectedFileName": v["expectedFileName"],
            "aliases": v["aliases"],
            "entry": v["entry"],
        }
        for k, v in discovery["profiles"].items()
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


def normalize_environment(value: any) -> str | None:
    """Strictly maps a client-supplied environment to SIMULATION / PRODUCTION (None if invalid)."""
    s = str(value or "").strip().upper()
    return s if s in ("SIMULATION", "PRODUCTION") else None


def split_account(aid: str | None) -> dict[str, str]:
    """Split 11-digit or 7-digit account into broker_id and account_id."""
    id_str = str(aid or "").strip()
    if len(id_str) == 11 and id_str.isdigit():
        return {"broker_id": id_str[:4], "account_id": id_str[4:]}
    return {"broker_id": "8840", "account_id": id_str}


def load_config(config_path_override: str | None = None) -> tuple[configparser.ConfigParser | None, list[str], str]:
    """
    Loads config.ini / esun-config.ini or profile-specific config from path or environment.
    Returns (config_parser, problems, environment). Read-only; problem texts never contain
    file content or absolute paths.
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
        return None, [f"找不到玉山設定檔：{os.path.basename(config_path)}"], "UNKNOWN"

    # interpolation=None: a "%" inside an API secret must not raise InterpolationSyntaxError
    # (this parser is handed to SDK(config) as-is).
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(config_path, encoding=CONFIG_ENCODING)
    except Exception as e:
        return None, [_describe_config_parse_error(e)], "UNKNOWN"

    # Validate required sections
    for sec in ("Core", "Cert", "Api", "User"):
        if not parser.has_section(sec):
            problems.append(f"設定檔缺少 [{sec}] 區塊")

    if parser.has_section("Core") and not parser["Core"].get("Entry"):
        problems.append("設定檔缺少 [Core] Entry")
    if parser.has_section("Api"):
        api_key = str(parser["Api"].get("Key") or "").strip()
        api_secret = str(parser["Api"].get("Secret") or "").strip()
        if not api_key:
            problems.append("設定檔缺少 [Api] Key")
        elif api_key.upper().startswith("YOUR_"):
            problems.append("設定檔 [Api] Key 仍為範本預設值，請填入玉山核發的金鑰")
        if not api_secret:
            problems.append("設定檔缺少 [Api] Secret")
        elif api_secret.upper().startswith("YOUR_"):
            problems.append("設定檔 [Api] Secret 仍為範本預設值，請填入玉山核發的密鑰")
        register_secret(api_secret)
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
            problems.append(f"找不到憑證檔案：{os.path.basename(resolved_cert)}")
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


def override_esun_config_environment(config: configparser.ConfigParser, target_env: str) -> tuple[str, str]:
    """
    In-memory only: rewrites [Core] of an already-loaded ConfigParser to match target_env
    ('SIMULATION' or 'PRODUCTION'); the user's ini file on disk is never touched.
    - SIMULATION: Entry = ESUN_SIMULATION_ENTRY, Environment = SIMULATION
    - PRODUCTION: Entry = ESUN_PRODUCTION_ENTRY, no Environment key
    Returns (target_env, target_entry). The parser can be passed straight to SDK(config).
    """
    target_env_normalized = normalize_environment(target_env)
    if target_env_normalized is None:
        raise ValueError(f"不支援的環境設定：{target_env}，僅支援 SIMULATION 或 PRODUCTION")
    target_entry = (
        ESUN_SIMULATION_ENTRY if target_env_normalized == "SIMULATION" else ESUN_PRODUCTION_ENTRY
    )
    if not config.has_section("Core"):
        config.add_section("Core")
    config.set("Core", "Entry", target_entry)
    if target_env_normalized == "SIMULATION":
        config.set("Core", "Environment", "SIMULATION")
    else:
        config.remove_option("Core", "Environment")
    return target_env_normalized, target_entry


# ─────────────────────────────────────────────────────────────────────────────
# 3. Rate Limiters & Caches
# ─────────────────────────────────────────────────────────────────────────────

# Taiwan has no DST: a fixed UTC+8 offset is exact and needs no tzdata in slim images.
TAIPEI_TZ = datetime.timezone(datetime.timedelta(hours=8), "Asia/Taipei")


def taipei_now() -> datetime.datetime:
    """Current time in Asia/Taipei regardless of the container TZ (Docker defaults to UTC)."""
    return datetime.datetime.now(TAIPEI_TZ)


def taipei_today() -> datetime.date:
    return taipei_now().date()


def session_generation_base() -> int:
    """
    Starting point for session generations: the bridge start time in milliseconds, so generations
    keep increasing across restarts. Clients drop state whose generation is lower than one they have
    already seen; counting from 1 on every start would make open pages ignore a restarted bridge.
    """
    return int(time.time() * 1000)


class SlidingWindowRateLimiter:
    """Thread-safe sliding window rate limiter (monotonic clock: immune to wall-clock jumps)."""

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
            now = time.monotonic()
            self._cleanup(now)
            return len(self.timestamps) < self.max_requests

    def acquire(self, timeout: float = 0.0) -> bool:
        deadline = time.monotonic() + timeout
        while True:
            with self.lock:
                now = time.monotonic()
                self._cleanup(now)
                if len(self.timestamps) < self.max_requests:
                    self.timestamps.append(now)
                    return True
                wait_time = self.timestamps[0] + self.window_seconds - now

            if wait_time <= 0:
                continue
            if timeout <= 0 or (time.monotonic() + wait_time) > deadline:
                return False
            time.sleep(min(wait_time, 0.05))

    def time_until_available(self) -> float:
        with self.lock:
            now = time.monotonic()
            self._cleanup(now)
            if len(self.timestamps) < self.max_requests:
                return 0.0
            return max(0.0, self.timestamps[0] + self.window_seconds - now)


class DailyCounter:
    """Thread-safe counter tracking daily requests with automatic Asia/Taipei midnight rollover."""

    def __init__(self, max_daily_requests: int):
        self.max_daily_requests = max_daily_requests
        self.current_day = taipei_today()
        self.count = 0
        self.lock = threading.Lock()

    def _rollover_if_needed(self) -> None:
        today = taipei_today()
        if today != self.current_day:
            self.current_day = today
            self.count = 0

    def can_increment(self) -> bool:
        with self.lock:
            self._rollover_if_needed()
            return self.count < self.max_daily_requests

    def increment(self) -> bool:
        """Atomic try-consume: returns False (and does not count) when the daily cap is reached."""
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

    def restore(self, day: datetime.date, count: int) -> None:
        """Restores a persisted count for `day` (ignored when `day` is not today)."""
        with self.lock:
            self._rollover_if_needed()
            if day == self.current_day:
                self.count = max(self.count, int(count or 0))


class TTLCache:
    """
    Thread-safe TTL cache with dirty marking, session scoping and a single-flight fill lock.
    - reset(generation) clears the cache for a new login session; writes tagged with an
      older generation (a query that started before an environment switch) are dropped.
    - A fill token from begin_fill() taken before the SDK call keeps the cache dirty when a
      MAT deal marked it dirty while that call was in flight (pre-deal data is never "fresh").
    - fill_lock lets concurrent misses share one upstream call (official per-endpoint limits).
    """

    def __init__(self, ttl_seconds: float):
        self.ttl_seconds = ttl_seconds
        self._cache: dict[str, tuple[any, float]] = {}
        self._dirty = False
        self._dirty_version = 0
        self._generation = 0
        self.lock = threading.Lock()
        self.fill_lock = threading.Lock()

    def get(self, key: str = "default") -> tuple[any, float] | None:
        """Returns (data, cache_age_sec) if fresh and not dirty, else None."""
        with self.lock:
            if self._dirty:
                return None
            entry = self._cache.get(key)
            if not entry:
                return None
            data, timestamp = entry
            age = time.monotonic() - timestamp
            if age <= self.ttl_seconds:
                return data, age
            return None

    def get_stale(self, key: str = "default") -> tuple[any, float] | None:
        """Returns (data, cache_age_sec) even if expired."""
        with self.lock:
            entry = self._cache.get(key)
            if not entry:
                return None
            data, timestamp = entry
            return data, time.monotonic() - timestamp

    def begin_fill(self) -> tuple[int, int]:
        """Token to pass to set() for data fetched after this call."""
        with self.lock:
            return self._generation, self._dirty_version

    def set(
        self,
        key: str = "default",
        data: any = None,
        generation: int | None = None,
        fill_token: tuple[int, int] | None = None,
    ) -> bool:
        with self.lock:
            if generation is not None and generation != self._generation:
                return False
            if fill_token is not None:
                token_generation, token_version = fill_token
                if token_generation != self._generation:
                    return False
                if token_version != self._dirty_version:
                    # Fetched before the latest dirty mark: keep it, but stay dirty so the next read refetches.
                    self._cache[key] = (data, time.monotonic())
                    return False
            self._cache[key] = (data, time.monotonic())
            self._dirty = False
            return True

    def mark_dirty(self) -> None:
        with self.lock:
            self._dirty = True
            self._dirty_version += 1

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
            self._dirty_version += 1

    def reset(self, generation: int) -> None:
        """Drops everything and scopes the cache to a new login session."""
        with self.lock:
            self._cache.clear()
            self._dirty = False
            self._dirty_version += 1
            self._generation = int(generation)


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


# Strict request parsing: unknown values are rejected (400) instead of silently mapping to a
# default (e.g. an unknown apCode used to become "Common" and turn 100 shares into 100 lots).

class EsunValidationError(ValueError):
    """A request refused locally before any SDK call (envelope outcome: not_sent)."""

    def __init__(self, message: str, code: str = "ESUN_INVALID_PARAMS", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


_ACTION_ALIASES = {"B": "B", "BUY": "B", "ACTION.BUY": "B", "S": "S", "SELL": "S", "ACTION.SELL": "S"}
_AP_CODE_ALIASES = {
    "1": "1", "COMMON": "1", "APCODE.COMMON": "1",
    "2": "2", "AFTERMARKET": "2", "APCODE.AFTERMARKET": "2",
    "3": "3", "ODD": "3", "APCODE.ODD": "3",
    "4": "4", "EMG": "4", "APCODE.EMG": "4",
    "5": "5", "INTRADAYODD": "5", "APCODE.INTRADAYODD": "5",
}
_BS_FLAG_ALIASES = {
    "R": "R", "ROD": "R", "BSFLAG.ROD": "R",
    "I": "I", "IOC": "I", "BSFLAG.IOC": "I",
    "F": "F", "FOK": "F", "BSFLAG.FOK": "F",
}
_PRICE_FLAG_ALIASES = {
    "0": "0", "LIMIT": "0", "LMT": "0", "PRICEFLAG.LIMIT": "0",
    "1": "1", "FLAT": "1", "PRICEFLAG.FLAT": "1",
    "2": "2", "LIMITDOWN": "2", "PRICEFLAG.LIMITDOWN": "2",
    "3": "3", "LIMITUP": "3", "PRICEFLAG.LIMITUP": "3",
    "4": "4", "MARKET": "4", "MKT": "4", "PRICEFLAG.MARKET": "4",
}
_TRADE_ALIASES = {
    "0": "0", "CASH": "0", "TRADE.CASH": "0",
    "3": "3", "MARGIN": "3", "TRADE.MARGIN": "3",
    "4": "4", "SHORT": "4", "TRADE.SHORT": "4",
    "A": "A", "DAYTRADINGSELL": "A", "TRADE.DAYTRADINGSELL": "A",
}


def _parse_enum(val: any, aliases: dict[str, str], enum_cls: any, field: str, default: str | None) -> any:
    if enum_cls is not None and isinstance(val, enum_cls):
        return val
    if val is None or (isinstance(val, str) and not val.strip()):
        if default is None:
            raise EsunValidationError(f"缺少必要欄位 {field}")
        val = default
    if isinstance(val, bool) or not isinstance(val, (str, int)):
        raise EsunValidationError(f"{field} 格式錯誤：{val!r}")
    raw = aliases.get(str(val).strip().upper())
    if raw is None:
        raise EsunValidationError(f"不支援的 {field}：{val}")
    return enum_cls(raw) if enum_cls is not None else raw


def enum_value(val: any) -> str:
    """'1' for APCode.Common, '1' for '1'."""
    return str(getattr(val, "value", val))


def to_action(val: any, default: str | None = None) -> any:
    return _parse_enum(val, _ACTION_ALIASES, Action, "buySell", default)


def to_ap_code(val: any, default: str | None = None) -> any:
    return _parse_enum(val, _AP_CODE_ALIASES, APCode, "apCode", default)


def to_bs_flag(val: any, default: str | None = "R") -> any:
    return _parse_enum(val, _BS_FLAG_ALIASES, BSFlag, "bsFlag", default)


def to_price_flag(val: any, default: str | None = "0") -> any:
    return _parse_enum(val, _PRICE_FLAG_ALIASES, PriceFlag, "priceFlag", default)


def to_trade(val: any, default: str | None = "0") -> any:
    return _parse_enum(val, _TRADE_ALIASES, Trade, "trade", default)


_STOCK_NO_RE = re.compile(r"[0-9A-Za-z]{1,12}")
_ORDER_NO_RE = re.compile(r"[0-9A-Za-z_:\-]{1,32}")


def parse_positive_int(value: any, field: str) -> int:
    """JSON integer (or integral float / digit string) > 0; anything else is a 400."""
    if value is None or isinstance(value, bool):
        raise EsunValidationError(f"{field} 必須為正整數")
    if isinstance(value, int):
        number = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        number = int(value)
    elif isinstance(value, str) and re.fullmatch(r"\s*[0-9]+\s*", value):
        number = int(value)
    else:
        raise EsunValidationError(f"{field} 必須為正整數（目前為 {value!r}）")
    if number <= 0:
        raise EsunValidationError(f"{field} 必須大於 0（目前為 {number}）")
    return number


def parse_price(value: any, field: str = "price") -> float:
    """JSON number, finite and > 0. Strings are refused so a price flag can never be read as a price."""
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EsunValidationError(f"{field} 必須為大於 0 的數值")
    price = float(value)
    if not math.isfinite(price) or price <= 0:
        raise EsunValidationError(f"{field} 必須為大於 0 的有限數值（目前為 {value!r}）")
    return price


def parse_order_no(body: dict) -> str:
    value = body.get("order_no", body.get("orderNo"))
    if not isinstance(value, str) or not _ORDER_NO_RE.fullmatch(value.strip()):
        raise EsunValidationError("缺少或無效的委託書號 (order_no)")
    return value.strip()


def is_success_ret_code(code: any) -> bool:
    """Success = empty or all zeros ('0', '00', '000000', '00000000'), per the existing client convention."""
    text = str(code).strip()
    return text == "" or set(text) <= {"0"}


# ─────────────────────────────────────────────────────────────────────────────
# 5. Thread-safe OrderBookCache
# ─────────────────────────────────────────────────────────────────────────────

ORDER_SNAPSHOT_KEEP_RECENT_SECONDS = 15.0
_ORPHAN_MAT_MEMORY = 2000


def _to_number(value: any) -> float | None:
    """Parses SDK numeric fields (int / float / numeric string); None when absent or invalid."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip().replace(",", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    return number if math.isfinite(number) else None


def _num_out(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def _order_keys(data: dict) -> tuple[str, str]:
    ord_no = str(data.get("ord_no") or data.get("ordNo") or "").strip()
    pre_ord_no = str(data.get("pre_ord_no") or data.get("preOrdNo") or "").strip()
    return ord_no, pre_ord_no


SHARES_PER_LOT = 1000
_SHARE_UNIT_AP_CODES = ("3", "4", "5")  # odd lot, emerging, intraday odd lot


def _first_present(raw: dict, *keys: str) -> any:
    """JavaScript `a ?? b`: the first value that is not None (missing keys count as None)."""
    for key in keys:
        value = raw.get(key)
        if value is not None:
            return value
    return None


def _js_finite_number(value: any) -> float | None:
    """finiteNumber() of src/lib/esun/order-mapping.ts (Number(String(v).trim()), finite only)."""
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if "_" in text:
            return None
        try:
            number = float(text) if text else 0.0
        except ValueError:
            return None
    return number if math.isfinite(number) else None


def _js_round(value: float) -> int:
    return int(math.floor(value + 0.5))  # Math.round


def _row_ap_code(*rows: dict | None) -> str:
    for row in rows:
        if row:
            text = str(_first_present(row, "ap_code", "apCode") or "").strip()
            if text:
                return text
    return "1"


def esun_quantity_from_fields(raw: dict, base: str, ap_code: str) -> int | None:
    """
    Port of esunQuantityFromFields() in src/lib/esun/order-mapping.ts (keep them identical):
    ap_code 1/2 read *_qty (lots); 3/4/5 read *_qty_share (shares) first, otherwise *_qty, where a
    value >= 1 is already shares (except emerging, ap_code 4) and a smaller one is lots x 1000.
    Returns the App unit: lots for ap_code 1/2, shares for 3/4/5.
    """
    camel = {"org": "orgQty", "mat": "matQty", "cel": "celQty"}[base]
    lots = _js_finite_number(_first_present(raw, f"{base}_qty", camel))
    if ap_code not in _SHARE_UNIT_AP_CODES:
        return None if lots is None else _js_round(lots)
    shares = _js_finite_number(_first_present(raw, f"{base}_qty_share", f"{camel}Share"))
    if shares is not None:
        return _js_round(shares)
    if lots is None:
        return None
    if ap_code != "4" and lots >= 1:
        return _js_round(lots)
    return _js_round(lots * SHARES_PER_LOT)


def esun_quantity_shares(raw: dict, base: str, ap_code: str) -> int | None:
    """esun_quantity_from_fields() expressed in shares (lots x 1000 for ap_code 1/2)."""
    qty = esun_quantity_from_fields(raw, base, ap_code)
    if qty is None:
        return None
    return qty if ap_code in _SHARE_UNIT_AP_CODES else qty * SHARES_PER_LOT


def mat_report_shares(mat: dict, ap_code: str) -> int | None:
    """Deal quantity of one MAT in shares, read like src/lib/esun/report-adapter.ts reads deals."""
    fields = {
        "mat_qty": _first_present(mat, "mat_qty", "deal_qty", "qty"),
        "mat_qty_share": _first_present(mat, "mat_qty_share", "deal_qty_share"),
    }
    return esun_quantity_shares(fields, "mat", ap_code)


class OrderBookCache:
    """
    Thread-safe in-memory cache of day orders dual-indexed by ord_no and pre_ord_no.
    - get_order_results() snapshots are authoritative and REPLACE the cache (orders seen in
      the last few seconds but not yet in the snapshot are kept).
    - WebSocket ACK/MAT events and accepted mutations update existing rows.
    - Scoped to one login session: writes tagged with another generation are dropped.
    - Scoped to one Asia/Taipei trading day: rows whose work_date is before today are evicted.
    - Only dicts carrying ord_no or pre_ord_no become rows (modify/cancel responses never do).
    - Per-row metadata records whether quantities come from an untouched snapshot
      ("snapshot") or were touched by events/mutations since ("event"/"local").
    - Per-row metadata also keeps event_mat_shares (deduplicated MAT total) and event_cel_shares
      (largest cumulative ACK cancel) across snapshots; every read reports
      max(snapshot, event) for the filled / cancelled quantities, so a snapshot that started
      before a report never rolls the row back.
    - Only successful ACKs (op_code '' / all zeros) change a row; a MAT counts only with a
      mkt_seq_num. Every read lists the applied MATs as `esun_fills` (receive order).
    - Mutations hand the SDK the raw row (snapshot / successful ACK values), never the read view.
    """

    # ACK fields that describe the report itself rather than the order state.
    REPORT_ONLY_KEYS = frozenset({"kind", "ret_date", "ret_time", "action", "before_qty", "after_qty", "cel_type"})

    def __init__(self):
        self._orders: dict[str, dict] = {}
        self._ord_no_map: dict[str, str] = {}
        self._pre_ord_no_map: dict[str, str] = {}
        self._meta: dict[str, dict] = {}
        self._orphan_mats: collections.OrderedDict = collections.OrderedDict()
        self._generation = 0
        self._day = taipei_today()
        self.lock = threading.RLock()

    @property
    def generation(self) -> int:
        with self.lock:
            return self._generation

    # ── internal helpers (lock held) ──────────────────────────────────────────

    def _accepts(self, generation: int | None) -> bool:
        return generation is None or generation == self._generation

    def _clear_locked(self) -> None:
        self._orders.clear()
        self._ord_no_map.clear()
        self._pre_ord_no_map.clear()
        self._meta.clear()
        self._orphan_mats.clear()

    def _roll_day_locked(self) -> None:
        today = taipei_today()
        if today == self._day:
            return
        self._day = today
        today_key = today.strftime("%Y%m%d")
        for internal_id in list(self._orders):
            order = self._orders[internal_id]
            work_date = re.sub(r"[^0-9]", "", str(order.get("work_date") or order.get("workDate") or ""))
            if not work_date or work_date < today_key:
                self._remove_locked(internal_id)
        self._orphan_mats.clear()

    def _remove_locked(self, internal_id: str) -> None:
        self._orders.pop(internal_id, None)
        self._meta.pop(internal_id, None)
        for mapping in (self._ord_no_map, self._pre_ord_no_map):
            for key in [k for k, v in mapping.items() if v == internal_id]:
                del mapping[key]

    def _find_locked(self, ord_no: str, pre_ord_no: str) -> str | None:
        if ord_no and ord_no in self._ord_no_map:
            return self._ord_no_map[ord_no]
        if pre_ord_no and pre_ord_no in self._pre_ord_no_map:
            return self._pre_ord_no_map[pre_ord_no]
        return None

    def _lookup_locked(self, order_id: any) -> str | None:
        key = str(order_id or "").strip()
        if not key:
            return None
        if key in self._ord_no_map:
            return self._ord_no_map[key]
        if key in self._pre_ord_no_map:
            return self._pre_ord_no_map[key]
        if key in self._orders:
            return key
        return None

    def _upsert_locked(self, data: dict, source: str) -> str | None:
        ord_no, pre_ord_no = _order_keys(data)
        if not ord_no and not pre_ord_no:
            return None
        internal_id = self._find_locked(ord_no, pre_ord_no) or (ord_no or f"pre:{pre_ord_no}")
        existing = self._orders.get(internal_id, {})
        self._orders[internal_id] = {**existing, **data}
        if ord_no:
            self._ord_no_map[ord_no] = internal_id
        if pre_ord_no:
            self._pre_ord_no_map[pre_ord_no] = internal_id
        now = time.monotonic()
        meta = self._meta.get(internal_id)
        if meta is None:
            meta = self._new_meta(now)
            self._meta[internal_id] = meta
        meta["source"] = source
        meta["updated"] = now
        return internal_id

    @staticmethod
    def _new_meta(now: float) -> dict:
        return {"created": now, "seen_mat": set(), "fills": [], "event_mat_shares": 0, "event_cel_shares": 0}

    @staticmethod
    def _carry_event_meta(target: dict, old: dict) -> None:
        """Report-derived state outlives snapshots (same lifetime as seen_mat)."""
        target["seen_mat"] |= set(old.get("seen_mat") or ())
        old_fills = list(old.get("fills") or ())
        old_seqs = {fill["mkt_seq_num"] for fill in old_fills}
        target["fills"] = old_fills + [f for f in target.get("fills") or () if f["mkt_seq_num"] not in old_seqs]
        for key in ("event_mat_shares", "event_cel_shares"):
            target[key] = max(target.get(key) or 0, old.get(key) or 0)

    def _effective_row_locked(self, internal_id: str) -> dict:
        """
        Copy of a row whose filled / cancelled quantities are max(row, reports received): written
        back as mat_qty / cel_qty (lots; fractional lots for odd-lot classes) and *_qty_share
        (shares). Lot rows get their bridge-only status re-derived from the effective quantities.
        `esun_fills` lists the MATs applied in this cache generation (receive order).
        """
        row = dict(self._orders[internal_id])
        meta = self._meta.get(internal_id) or {}
        row["esun_fills"] = [dict(fill) for fill in meta.get("fills") or ()]
        ap_code = _row_ap_code(row)
        changed = False
        for base in ("mat", "cel"):
            event_shares = meta.get(f"event_{base}_shares") or 0
            current = esun_quantity_shares(row, base, ap_code) or 0
            if event_shares > current:
                row[f"{base}_qty"] = _num_out(event_shares / SHARES_PER_LOT)
                row[f"{base}_qty_share"] = _num_out(event_shares)
                changed = True
        if (changed or "status" in row) and ap_code not in _SHARE_UNIT_AP_CODES:
            org = esun_quantity_from_fields(row, "org", ap_code)
            mat = esun_quantity_from_fields(row, "mat", ap_code) or 0
            cel = esun_quantity_from_fields(row, "cel", ap_code) or 0
            if org and mat + cel >= org:
                row["status"] = "Cancelled" if cel > 0 else "Filled"
            elif mat > 0:
                row["status"] = "PartFilled"
        return row

    # ── public API ────────────────────────────────────────────────────────────

    def reset(self, generation: int) -> None:
        """Drops every row and scopes the cache to a new login session."""
        with self.lock:
            self._clear_locked()
            self._generation = int(generation)
            self._day = taipei_today()

    def clear(self) -> None:
        with self.lock:
            self._clear_locked()

    def upsert(self, data: dict, generation: int | None = None, source: str = "event") -> str | None:
        if not isinstance(data, dict):
            return None
        with self.lock:
            if not self._accepts(generation):
                return None
            self._roll_day_locked()
            return self._upsert_locked(dict(data), source)

    def update_from_order_results(self, orders: list, generation: int | None = None) -> bool:
        """Replaces the cache with an authoritative get_order_results() snapshot."""
        with self.lock:
            if not self._accepts(generation):
                return False
            self._day = taipei_today()
            now = time.monotonic()
            old_orders, old_meta = self._orders, self._meta
            self._orders, self._meta = {}, {}
            self._ord_no_map, self._pre_ord_no_map = {}, {}
            for order in orders or []:
                if isinstance(order, dict):
                    self._upsert_locked(dict(order), "snapshot")
            for old_id, old_order in old_orders.items():
                meta = old_meta.get(old_id) or {}
                ord_no, pre_ord_no = _order_keys(old_order)
                new_id = self._find_locked(ord_no, pre_ord_no)
                if new_id is not None:
                    self._carry_event_meta(self._meta[new_id], meta)
                    continue
                if now - float(meta.get("created") or 0.0) <= ORDER_SNAPSHOT_KEEP_RECENT_SECONDS:
                    # Placed/reported moments ago and not yet visible in the broker snapshot.
                    kept_id = self._upsert_locked(dict(old_order), str(meta.get("source") or "event"))
                    if kept_id is not None:
                        self._meta[kept_id]["created"] = float(meta.get("created") or now)
                        self._carry_event_meta(self._meta[kept_id], meta)
            return True

    def update_from_ack(self, ack_data: dict, generation: int | None = None) -> tuple[bool, dict | None]:
        """Merges an ACK into its row. Returns (accepted, previous_row_copy)."""
        if not isinstance(ack_data, dict):
            return False, None
        with self.lock:
            if not self._accepts(generation):
                return False, None
            self._roll_day_locked()
            ord_no, pre_ord_no = _order_keys(ack_data)
            internal_id = self._find_locked(ord_no, pre_ord_no)
            previous = dict(self._orders[internal_id]) if internal_id else None
            if normalize_report_status(ack_data)[0] not in ("", "00"):
                # A failed ACK (e.g. a rejected cancel still carrying the requested cel_qty) reports
                # the request, not the order: published as is, but the row and its counts stay.
                return True, previous
            state = {k: v for k, v in ack_data.items() if k not in self.REPORT_ONLY_KEYS}
            new_id = self._upsert_locked(state, "event")
            if new_id is not None:
                # ACK cel_qty is the cumulative cancelled quantity of the order.
                cel_shares = esun_quantity_shares(ack_data, "cel", _row_ap_code(ack_data, previous))
                meta = self._meta[new_id]
                meta["event_cel_shares"] = max(meta.get("event_cel_shares") or 0, cel_shares or 0)
            return True, previous

    def update_from_mat(self, mat_data: dict, generation: int | None = None) -> bool:
        """
        Applies a MAT deal. Returns False when dropped (other session, or a duplicate of an
        already-applied mkt_seq_num). Quantity fields of the row are never overwritten here; the
        deal is added to event_mat_shares (in shares, see esun_quantity_from_fields) and to the
        row's fills, applied on read. Bridge-only deal_qty/status are kept. A MAT without
        mkt_seq_num cannot be deduplicated: it is published (True) but never counted.
        """
        if not isinstance(mat_data, dict):
            return False
        with self.lock:
            if not self._accepts(generation):
                return False
            self._roll_day_locked()
            ord_no = str(mat_data.get("ord_no") or mat_data.get("ordNo") or "").strip()
            seq = str(mat_data.get("mkt_seq_num") or mat_data.get("mktSeqNum") or "").strip()
            internal_id = self._ord_no_map.get(ord_no) if ord_no else None
            if internal_id is None:
                if seq:
                    key = (ord_no, seq)
                    if key in self._orphan_mats:
                        return False
                    self._orphan_mats[key] = True
                    while len(self._orphan_mats) > _ORPHAN_MAT_MEMORY:
                        self._orphan_mats.popitem(last=False)
                return True
            meta = self._meta[internal_id]
            if seq and seq in meta["seen_mat"]:
                return False
            meta["source"] = "event"
            meta["updated"] = time.monotonic()
            if not seq:
                logger.warning(f"[WebSocket] 成交回報缺少 mkt_seq_num，無法去重，不計入快取成交量（ord_no={ord_no}）")
                return True
            meta["seen_mat"].add(seq)
            target = self._orders[internal_id]
            mat_shares = mat_report_shares(mat_data, _row_ap_code(mat_data, target))
            if mat_shares:
                meta["event_mat_shares"] = (meta.get("event_mat_shares") or 0) + mat_shares
                price = _js_finite_number(_first_present(mat_data, "mat_price", "matPrice"))
                meta["fills"].append({
                    "mkt_seq_num": seq,
                    "mat_qty_share": mat_shares,
                    "mat_price": _num_out(price) if price is not None and price > 0 else None,
                })
            qty = _to_number(
                mat_data.get("mat_qty") or mat_data.get("matQty") or mat_data.get("deal_qty")
                or mat_data.get("dealQty") or mat_data.get("qty")
            )
            if qty is not None:
                deal = _to_number(target.get("deal_qty")) or 0.0
                target["deal_qty"] = _num_out(deal + qty)
            if "mat_time" in mat_data:
                target["mat_time"] = mat_data["mat_time"]
            ap_code = str(target.get("ap_code") or target.get("apCode") or "").strip()
            if ap_code in ("", "1", "2"):  # lot-denominated rows only (odd-lot qty units differ)
                org_qty = _to_number(target.get("org_qty") or target.get("quantity"))
                deal_qty = _to_number(target.get("deal_qty"))
                if org_qty and deal_qty is not None:
                    target["status"] = "Filled" if deal_qty >= org_qty else "PartFilled"
            return True

    def mark_event(self, order_id: any, generation: int | None = None, updates: dict | None = None) -> None:
        """Marks a row as touched by an accepted mutation (its snapshot quantities are no longer known)."""
        with self.lock:
            if not self._accepts(generation):
                return
            internal_id = self._lookup_locked(order_id)
            if internal_id is None:
                return
            if updates:
                self._orders[internal_id].update(updates)
            meta = self._meta.setdefault(internal_id, self._new_meta(time.monotonic()))
            meta["source"] = "event"
            meta["updated"] = time.monotonic()

    def get(self, order_id: str) -> dict | None:
        with self.lock:
            self._roll_day_locked()
            internal_id = self._lookup_locked(order_id)
            return self._effective_row_locked(internal_id) if internal_id else None

    def get_with_meta(self, order_id: str) -> tuple[dict | None, dict | None]:
        with self.lock:
            self._roll_day_locked()
            internal_id = self._lookup_locked(order_id)
            if internal_id is None:
                return None, None
            meta = self._meta.get(internal_id) or {}
            return self._effective_row_locked(internal_id), {"source": meta.get("source"), "created": meta.get("created")}

    def get_for_mutation(self, order_id: str) -> tuple[dict | None, dict | None, dict | None]:
        """(raw row, read view, meta) under one lock: the SDK gets the raw row, checks use the view."""
        with self.lock:
            self._roll_day_locked()
            internal_id = self._lookup_locked(order_id)
            if internal_id is None:
                return None, None, None
            meta = self._meta.get(internal_id) or {}
            return (
                dict(self._orders[internal_id]),
                self._effective_row_locked(internal_id),
                {"source": meta.get("source"), "created": meta.get("created")},
            )

    def pre_ord_no_of(self, ord_no: str) -> str:
        """pre_ord_no of the row indexed by this ord_no (never falls back to the pre_ord_no index)."""
        with self.lock:
            internal_id = self._ord_no_map.get(str(ord_no or "").strip())
            return _order_keys(self._orders[internal_id])[1] if internal_id else ""

    def get_all(self) -> list[dict]:
        with self.lock:
            self._roll_day_locked()
            return [self._effective_row_locked(internal_id) for internal_id in self._orders]

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
# 6. SSE Fan-out Manager (event ids, replay ring, resync)
# ─────────────────────────────────────────────────────────────────────────────

SSE_RING_SIZE = 500
SSE_SUBSCRIBER_QUEUE_SIZE = 256
MAX_SSE_SUBSCRIBERS = 32
SSE_HEARTBEAT_SECONDS = 25.0


class SSECapacityError(Exception):
    """Too many concurrent SSE subscribers."""


class SSESubscriber:
    """One SSE connection: a bounded queue plus a flag set when it fell behind or must close."""

    def __init__(self, maxsize: int):
        self.queue: queue.Queue = queue.Queue(maxsize=maxsize)
        self.closed = threading.Event()


class SSEFanoutManager:
    """
    Publishes events to SSE subscribers with ids "<boot_id>-<seq>" (boot_id random per bridge
    process, seq strictly increasing) and keeps the last SSE_RING_SIZE events, so a client that
    reconnects with Last-Event-ID replays exactly what it missed. When the id cannot be served
    (other boot, evicted from the ring, malformed) the client gets a `resync` event instead.
    A subscriber whose queue overflows is closed (it reconnects and replays) rather than
    silently losing events. Heartbeats carry no id, so they never move a client's Last-Event-ID.
    """

    def __init__(
        self,
        ring_size: int = SSE_RING_SIZE,
        max_subscribers: int = MAX_SSE_SUBSCRIBERS,
        queue_size: int = SSE_SUBSCRIBER_QUEUE_SIZE,
    ):
        self.boot_id = secrets.token_hex(6)
        self._seq = 0
        # report_seq counters per (report scope = session generation, report stream)
        self._report_seqs: collections.OrderedDict = collections.OrderedDict()
        self._ring: collections.deque = collections.deque(maxlen=ring_size)
        self.subscribers: set[SSESubscriber] = set()
        self.max_subscribers = max_subscribers
        self.queue_size = queue_size
        self.lock = threading.Lock()

    @property
    def last_event_id(self) -> str:
        with self.lock:
            return f"{self.boot_id}-{self._seq}"

    @staticmethod
    def format_event(event_type: str, data: dict, event_id: str | None = None) -> bytes:
        payload_str = json.dumps(data, ensure_ascii=False, default=_json_default)
        parts = []
        if event_id:
            parts.append(f"id: {event_id}\n")
        parts.append(f"event: {event_type}\n")
        parts.append(f"data: {payload_str}\n\n")
        return "".join(parts).encode("utf-8")

    def publish(
        self,
        event_type: str,
        data: dict,
        include_ids: bool = False,
        report_stream: str | None = None,
        report_scope: any = None,
    ) -> str:
        """
        Assigns the next id, stores the event in the replay ring and fans it out (in seq order).
        With report_stream, the payload also gets report_stream + report_seq: 1, 2, ... per
        (report_scope, report_stream), counting only the reports actually published.
        """
        with self.lock:
            self._seq += 1
            seq = self._seq
            event_id = f"{self.boot_id}-{seq}"
            payload = {**data, "event_id": event_id, "seq": seq} if include_ids else data
            if report_stream is not None:
                key = (report_scope, report_stream)
                report_seq = self._report_seqs.pop(key, 0) + 1
                self._report_seqs[key] = report_seq
                while len(self._report_seqs) > 8:  # a few recent sessions x {order, deal}
                    self._report_seqs.popitem(last=False)
                payload = {**payload, "report_stream": report_stream, "report_seq": report_seq}
            raw = self.format_event(event_type, payload, event_id)
            self._ring.append((seq, raw))
            for sub in list(self.subscribers):
                try:
                    sub.queue.put_nowait(raw)
                except queue.Full:
                    sub.closed.set()
                    self.subscribers.discard(sub)
                    logger.warning("SSE 訂閱者處理過慢（佇列已滿）：中斷連線，客戶端可帶 Last-Event-ID 重連重播")
        return event_id

    def broadcast(self, event_type: str, data: dict, event_id: str | None = None) -> str:
        """Backward-compatible alias of publish() (ids are always assigned by the manager)."""
        return self.publish(event_type, data)

    @staticmethod
    def _parse_event_id(value: any) -> tuple[str, int] | None:
        boot, sep, seq = str(value or "").strip().rpartition("-")
        if not sep or not boot or not seq.isdigit():
            return None
        return boot, int(seq)

    def _resync_locked(self, reason: str) -> bytes:
        data = {
            "reason": reason,
            "bootId": self.boot_id,
            "ts": taipei_now().isoformat(timespec="milliseconds"),
        }
        return self.format_event("resync", data, f"{self.boot_id}-{self._seq}")

    def subscribe(self, last_event_id: str | None = None) -> tuple[SSESubscriber, list[bytes], str | None]:
        """
        Registers a subscriber atomically with the backlog it must receive first:
        replayed events after last_event_id, or a single `resync` event when that id cannot be
        served. Returns (subscriber, backlog, resync_reason).
        """
        with self.lock:
            if len(self.subscribers) >= self.max_subscribers:
                raise SSECapacityError()
            sub = SSESubscriber(self.queue_size)
            backlog: list[bytes] = []
            reason = None
            if last_event_id:
                parsed = self._parse_event_id(last_event_id)
                if parsed is None:
                    reason = "invalid_last_event_id"
                elif parsed[0] != self.boot_id:
                    reason = "bridge_restarted"
                else:
                    last_seq = parsed[1]
                    oldest = self._ring[0][0] if self._ring else self._seq + 1
                    if last_seq > self._seq:
                        reason = "unknown_last_event_id"
                    elif last_seq < self._seq and last_seq + 1 < oldest:
                        reason = "events_evicted"
                    else:
                        backlog = [raw for seq, raw in self._ring if seq > last_seq]
                if reason:
                    backlog = [self._resync_locked(reason)]
            self.subscribers.add(sub)
            return sub, backlog, reason

    def unsubscribe(self, sub: SSESubscriber) -> None:
        with self.lock:
            self.subscribers.discard(sub)

    def register(self) -> queue.Queue:
        """Live-only subscription (no replay); returns the subscriber's queue."""
        sub, _, _ = self.subscribe(None)
        return sub.queue

    def unregister(self, q: queue.Queue) -> None:
        with self.lock:
            for sub in [s for s in self.subscribers if s.queue is q]:
                self.subscribers.discard(sub)

    def client_count(self) -> int:
        with self.lock:
            return len(self.subscribers)

    def close_all(self) -> None:
        """Ends every SSE stream (shutdown): sets the closed flag and wakes the handler."""
        with self.lock:
            active_subs = list(self.subscribers)
            self.subscribers.clear()
        for sub in active_subs:
            sub.closed.set()
            try:
                sub.queue.put_nowait(None)
            except queue.Full:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# 7. Session Snapshot, Login Guard & Persistent Circuit Breaker
# ─────────────────────────────────────────────────────────────────────────────

LOGIN_AGR0000_COOLDOWN_SECONDS = 60.0
RECONNECT_MIN_INTERVAL_SECONDS = 6.0
LOGIN_DAILY_MAX = 300
ORDERS_DAILY_MAX = 2000
ORDERS_REFRESH_MIN_INTERVAL_SECONDS = 5.0
ORDERS_REFRESH_MAX_WAIT_SECONDS = 12.0  # refresh=true waits at most this long before its query starts
SHUTDOWN_MUTATION_GRACE_SECONDS = 8.0  # SIGTERM: in-flight order mutations may finish (< compose grace)
CACHE_FILL_WAIT_SECONDS = 20.0
WS_SILENCE_SECONDS = 90.0
WS_WATCHDOG_INTERVAL_SECONDS = 5.0
WS_BACKOFF_INITIAL_SECONDS = 1.0
WS_BACKOFF_MAX_SECONDS = 60.0
WS_STABLE_SECONDS = 60.0
WS_RESYNC_OPEN_WAIT_SECONDS = 5.0


@dataclasses.dataclass(frozen=True)
class EsunSession:
    """
    Immutable login-session snapshot. Replaced as a whole (generation + 1) only after a
    successful login or environment switch; every request reads exactly one snapshot.
    The offline snapshot (selected, not yet logged-in config) carries the process start base
    (session_generation_base()); each successful login takes the next number.
    """

    generation: int
    sdk: any
    environment: str
    config_path: str | None
    config_file_name: str | None
    entry: str
    account: dict | None
    source_environment: str = "UNKNOWN"  # environment written in the config file at login time
    config_overridden: bool = False  # [Core] rewritten in memory to match the requested environment
    cert_info: dict | None = None
    logged_in_at: str | None = None

    @property
    def logged_in(self) -> bool:
        return self.sdk is not None


@dataclasses.dataclass
class _PreparedLogin:
    config: configparser.ConfigParser
    config_path: str
    environment: str
    source_environment: str
    overridden: bool
    entry: str
    account: dict | None
    material: bytes


def resolve_state_dir(explicit: str | None = None) -> str:
    """ESUN_STATE_DIR, else <server dir>/.state (Docker sets ESUN_STATE_DIR=/app/state)."""
    if explicit:
        return os.path.abspath(explicit)
    env_dir = (os.environ.get("ESUN_STATE_DIR") or "").strip()
    if env_dir:
        return os.path.abspath(env_dir)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), ".state")


def _pbkdf2_hex(material: bytes, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", material, salt, 120_000).hex()


class LoginStateStore:
    """
    Persists the login circuit breaker (credential failures such as AGA0000 or certificate
    password errors) and the daily login-attempt count as JSON in ESUN_STATE_DIR, so a restart
    or redeploy never retries a known-bad password. No secret is stored: only a salted PBKDF2
    fingerprint of the credentials used by the failed attempt.
    """

    FILE_NAME = "esun-login-state.json"
    VERSION = 1

    def __init__(self, state_dir: str):
        self.state_dir = state_dir
        self.path = os.path.join(state_dir, self.FILE_NAME)
        self.lock = threading.Lock()
        self.persist_ok = True
        self._state = self._load()

    @classmethod
    def _default_state(cls) -> dict:
        return {
            "version": cls.VERSION,
            "credentialLocked": False,
            "lockCode": None,
            "lockReason": None,
            "lockedAt": None,
            "fingerprint": None,
            "loginAttempts": {"day": None, "count": 0},
        }

    def _unreadable_state(self, reason: str) -> dict:
        logger.warning(f"登入狀態檔無法讀取（{reason}）；為避免以錯誤密碼重複登入，已停用自動登入")
        state = self._default_state()
        state.update(
            credentialLocked=True,
            lockCode="STATE_UNREADABLE",
            lockReason="登入狀態檔無法讀取，請確認設定後手動重新連線",
            lockedAt=taipei_now().isoformat(timespec="seconds"),
        )
        return state

    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return self._default_state()
        except (OSError, ValueError) as e:
            return self._unreadable_state(type(e).__name__)
        if not isinstance(data, dict):
            return self._unreadable_state("format")
        state = self._default_state()
        state["credentialLocked"] = bool(data.get("credentialLocked"))
        for key in ("lockCode", "lockReason", "lockedAt"):
            value = data.get(key)
            state[key] = str(value) if value is not None else None
        fingerprint = data.get("fingerprint")
        if isinstance(fingerprint, dict) and isinstance(fingerprint.get("salt"), str) and isinstance(fingerprint.get("hash"), str):
            state["fingerprint"] = {"salt": fingerprint["salt"], "hash": fingerprint["hash"]}
        attempts = data.get("loginAttempts")
        if isinstance(attempts, dict):
            try:
                state["loginAttempts"] = {
                    "day": str(attempts.get("day") or "") or None,
                    "count": max(0, int(attempts.get("count") or 0)),
                }
            except (TypeError, ValueError):
                pass
        return state

    def _save_locked(self) -> bool:
        tmp = f"{self.path}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._state, fh, ensure_ascii=False, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.path)
            self.persist_ok = True
            return True
        except OSError as e:
            self.persist_ok = False
            logger.warning(f"無法寫入登入狀態檔 {self.path}（{type(e).__name__}）；熔斷狀態僅保存在記憶體中")
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return False

    @property
    def credential_locked(self) -> bool:
        with self.lock:
            return bool(self._state["credentialLocked"])

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "locked": bool(self._state["credentialLocked"]),
                "code": self._state.get("lockCode"),
                "reason": self._state.get("lockReason"),
                "lockedAt": self._state.get("lockedAt"),
                "persisted": self.persist_ok,
            }

    def fingerprint_matches(self, material: bytes | None) -> bool:
        with self.lock:
            fingerprint = self._state.get("fingerprint")
        if not fingerprint or material is None:
            return False
        try:
            salt = bytes.fromhex(fingerprint["salt"])
        except (ValueError, KeyError):
            return False
        return hmac.compare_digest(_pbkdf2_hex(material, salt), str(fingerprint.get("hash") or ""))

    def record_credential_failure(self, code: str, reason: str, material: bytes | None) -> None:
        fingerprint = None
        if material is not None:
            salt = secrets.token_bytes(16)
            fingerprint = {"salt": salt.hex(), "hash": _pbkdf2_hex(material, salt)}
        with self.lock:
            self._state.update(
                credentialLocked=True,
                lockCode=code,
                lockReason=str(reason or "")[:300],
                lockedAt=taipei_now().isoformat(timespec="seconds"),
                fingerprint=fingerprint,
            )
            self._save_locked()

    def clear_credential_lock(self) -> None:
        with self.lock:
            if not self._state.get("credentialLocked") and not self._state.get("fingerprint"):
                return
            self._state.update(credentialLocked=False, lockCode=None, lockReason=None, lockedAt=None, fingerprint=None)
            self._save_locked()

    def login_attempts_for(self, day: datetime.date) -> int:
        with self.lock:
            attempts = self._state.get("loginAttempts") or {}
            if attempts.get("day") == day.isoformat():
                return int(attempts.get("count") or 0)
            return 0

    def record_login_attempts(self, day: datetime.date, count: int) -> None:
        with self.lock:
            self._state["loginAttempts"] = {"day": day.isoformat(), "count": int(count)}
            self._save_locked()


_LOGIN_CREDENTIAL_PATTERNS = (
    "aga0000", "passworderror", "password", "密碼", "a00003",
    "certnotfound", "certopenerror", "certexpirederror", "certpermission", "certkeyerror",
    "certerror", "keyloaderror", "憑證",
)
_LOGIN_NETWORK_PATTERNS = (
    "error sending request", "timed out", "timeout", "connection", "connect", "dns", "network",
    "unreachable", "broken pipe", "temporarily unavailable", "reqwest", "eof", "502", "503", "504",
)


def classify_login_error(message: str) -> str:
    """
    Returns 'daily_limit' | 'rate_limited' | 'network' | 'credential'.
    Anything that is not clearly a rate limit or a network problem counts as a credential
    failure: E.SUN locks the account after 3 wrong passwords (AGA0000), so fail safe.
    """
    low = str(message or "").lower()
    if "agr0004" in low:
        return "daily_limit"
    if re.search(r"agr000[0-9]", low):
        return "rate_limited"
    if any(p in low for p in _LOGIN_CREDENTIAL_PATTERNS):
        return "credential"
    if any(p in low for p in _LOGIN_NETWORK_PATTERNS):
        return "network"
    return "credential"


def _extract_error_code(message: str, default: str = "LOGIN_FAILED") -> str:
    match = re.search(r"\b([A-Z]{1,4}[0-9]{4,6})\b", str(message or ""))
    return match.group(1) if match else default


def _credential_material(cfg: configparser.ConfigParser) -> bytes:
    """Bytes identifying the credentials of a login attempt (only ever stored as a salted PBKDF2 hash)."""
    def _get(section: str, key: str) -> str:
        return str(cfg[section].get(key, "")) if cfg.has_section(section) else ""

    cert_path = _get("Cert", "Path")
    try:
        st = os.stat(cert_path)
        cert_sig = f"{st.st_size}:{st.st_mtime_ns}"
    except OSError:
        cert_sig = "missing"
    account_pw = os.environ.get("ESUN_ACCOUNT_PASSWORD") or os.environ.get("ESUN_PASSWORD", "")
    cert_pw = os.environ.get("ESUN_CERT_PASSWORD", "")
    parts = [_get("User", "Account"), _get("Api", "Key"), cert_path, cert_sig, account_pw, cert_pw]
    return "\x1f".join(parts).encode("utf-8")


class EsunQueryError(Exception):
    """A query that must surface as an HTTP error instead of stale or empty data."""

    def __init__(self, status: int, code: str, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after

    def to_body(self) -> dict:
        body: dict[str, any] = {"ok": False, "code": self.code, "error": str(self)}
        if self.retry_after:
            body["retry_after"] = int(math.ceil(self.retry_after))
        return body


def not_sent(status: int, code: str, error: str, **extra: any) -> tuple[dict, int]:
    """Mutation envelope for requests that were definitely NOT sent to the broker."""
    body: dict[str, any] = {"ok": False, "outcome": "not_sent", "code": code, "error": error}
    body.update(extra)
    return body, status


def account_matches(expected: any, account: dict | None) -> bool:
    """expected_account: 7-digit account (no branch code) or the full 11-digit broker+account."""
    if not account:
        return False
    text = re.sub(r"[\s-]", "", str(expected))
    account_id = str(account.get("account_id") or "")
    broker_id = str(account.get("broker_id") or "")
    if len(text) == 11 and text.isdigit():
        return text == broker_id + account_id
    return bool(text) and text == account_id


def remaining_quantity(order: dict, unit: str) -> float | None:
    """
    org - mat - cel in the request's unit: lots use *_qty (ap_code 1/2); shares use *_qty_share
    (the SDK's *_qty of odd-lot / emerging orders are fractional lots). None when unknown.
    """
    keys = ("org_qty", "mat_qty", "cel_qty") if unit == "lot" else ("org_qty_share", "mat_qty_share", "cel_qty_share")
    org = _to_number(order.get(keys[0]))
    if org is None:
        return None
    mat = _to_number(order.get(keys[1])) or 0.0
    cel = _to_number(order.get(keys[2])) or 0.0
    return max(org - mat - cel, 0.0)


# esun_trade core input checks (O00001-O00021) are raised before any request is sent.
_SDK_LOCAL_VALIDATION_RE = re.compile(r"\bO000(0[1-9]|1[0-9]|2[01])\b")


def derive_ack_op_type(ack: dict, previous: dict | None) -> str:
    """
    Operation of an ACK from the SDK's before_qty / after_qty (and the price vs the cached order):
    New (0 -> n), Cancel (n -> 0), ModifyQty (n -> m < n), ModifyPrice (same quantity, price or
    price flag changed). "Unknown" whenever the fields do not determine it - never default to New.
    """
    before = _to_number(ack.get("before_qty", ack.get("beforeQty")))
    after = _to_number(ack.get("after_qty", ack.get("afterQty")))
    if before is None or after is None:
        return "Unknown"
    if before == 0 and after > 0:
        return "New"
    if before > 0 and after == 0:
        return "Cancel"
    if 0 < after < before:
        return "ModifyQty"
    if before == after and before > 0 and previous:
        prev_price, new_price = _to_number(previous.get("od_price")), _to_number(ack.get("od_price"))
        prev_flag = str(previous.get("price_flag") or "").strip()
        new_flag = str(ack.get("price_flag") or "").strip()
        price_changed = prev_price is not None and new_price is not None and abs(prev_price - new_price) > 1e-9
        if price_changed or (prev_flag and new_flag and prev_flag != new_flag):
            return "ModifyPrice"
    return "Unknown"


def normalize_report_status(data: dict) -> tuple[str, str]:
    """(op_code, op_msg): '00' when err_code is empty / all zeros, the raw code otherwise, '' when absent."""
    raw = data.get("err_code", data.get("errCode"))
    message = str(data.get("err_msg") or data.get("errMsg") or "")
    if raw is None:
        return "", message
    return ("00" if is_success_ret_code(raw) else str(raw).strip()), message


def _report_datetime(date_raw: any, time_raw: any) -> datetime.datetime:
    now = taipei_now()
    t_digits = re.sub(r"[^0-9]", "", str(time_raw or ""))
    d_digits = re.sub(r"[^0-9]", "", str(date_raw or ""))
    if len(t_digits) >= 14 and t_digits[:2] in ("19", "20"):
        d_digits, t_digits = t_digits[:8], t_digits[8:]
    if len(t_digits) < 6:
        return now
    try:
        frac = t_digits[6:12]
        clock = datetime.time(
            int(t_digits[0:2]), int(t_digits[2:4]), int(t_digits[4:6]), int(frac.ljust(6, "0")) if frac else 0
        )
        day = now.date()
        if len(d_digits) == 8:
            day = datetime.date(int(d_digits[:4]), int(d_digits[4:6]), int(d_digits[6:8]))
        return datetime.datetime.combine(day, clock, tzinfo=TAIPEI_TZ)
    except ValueError:
        return now


def report_timestamp(data: dict) -> str:
    """ISO8601 (+08:00) report time from ret_date/ret_time (ACK) or mat_time (MAT); receive time otherwise."""
    date_raw = data.get("ret_date") or data.get("retDate") or data.get("work_date") or data.get("workDate")
    time_raw = data.get("ret_time") or data.get("retTime") or data.get("mat_time") or data.get("matTime")
    return _report_datetime(date_raw, time_raw).isoformat(timespec="milliseconds")


@dataclasses.dataclass
class _OrdersRefreshFlight:
    """One refresh=true get_order_results() call, shared by the requests that arrived before it started."""

    started: float
    generation: int
    ticket: int  # ordering under the lock (monotonic() can tick coarser than a fast query)
    done: bool = False
    error: EsunQueryError | None = None


class _WsRuntime:
    """Mutable WebSocket state of one session generation."""

    def __init__(self, generation: int):
        self.generation = generation
        self.stop_event = threading.Event()
        self.opened_event = threading.Event()
        self.lock = threading.Lock()
        self.connected = False
        self.last_activity = time.monotonic()
        self.last_message_at: str | None = None
        self.reconnects = 0
        self.connect_attempts = 0
        self.thread: threading.Thread | None = None
        self.watchdog: threading.Thread | None = None

    def touch(self) -> None:
        with self.lock:
            self.last_activity = time.monotonic()

    def note_message(self) -> None:
        with self.lock:
            self.last_activity = time.monotonic()
            self.last_message_at = taipei_now().isoformat(timespec="seconds")
            self.connected = True

    def note_open(self) -> None:
        with self.lock:
            self.connected = True
            self.last_activity = time.monotonic()
        self.opened_event.set()

    def note_connecting(self) -> None:
        with self.lock:
            self.connected = True  # optimistic until connect_websocket() returns
            self.last_activity = time.monotonic()
            self.connect_attempts += 1
        self.opened_event.clear()

    def note_closed(self) -> None:
        with self.lock:
            self.connected = False
        self.opened_event.clear()

    def silence(self) -> tuple[bool, float]:
        with self.lock:
            return self.connected, time.monotonic() - self.last_activity

    def is_connected(self) -> bool:
        with self.lock:
            return self.connected and not self.stop_event.is_set()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "connected": self.connected and not self.stop_event.is_set(),
                "lastMessageAt": self.last_message_at,
                "reconnects": self.reconnects,
                "generation": self.generation,
            }


# ─────────────────────────────────────────────────────────────────────────────
# 7b. Bridge Core Engine
# ─────────────────────────────────────────────────────────────────────────────

class EsunTradeBridge:
    """
    Coordinates E.Sun Trading SDK lifecycle, official rate limiters,
    caches, OrderBookCache, and WebSocket fan-out.
    All session-bound state (sdk, environment, config, account) lives in one immutable
    EsunSession snapshot that is swapped atomically after a successful login/switch.
    """

    def __init__(
        self,
        config_path: str | None = None,
        sdk_factory: any = None,
        auto_login: bool = True,
        state_dir: str | None = None,
        websocket_enabled: bool = True,
    ):
        self.base_dir = (
            os.environ.get("ESUN_CONFIG_DIR")
            or (os.path.dirname(os.path.abspath(config_path)) if config_path else os.getcwd())
        )
        if config_path is not None:
            selected_path = config_path
        else:
            discovery = discover_esun_config_profiles(self.base_dir)
            if discovery["profiles"]["SIMULATION"]["available"]:
                selected_path = discovery["profiles"]["SIMULATION"]["filePath"]
            elif discovery["profiles"]["PRODUCTION"]["available"]:
                selected_path = discovery["profiles"]["PRODUCTION"]["filePath"]
            elif os.environ.get("ESUN_CONFIG_PATH"):
                selected_path = os.environ.get("ESUN_CONFIG_PATH")
            else:
                default_ini = os.path.join(self.base_dir, "esun-config.ini")
                config_ini = os.path.join(self.base_dir, "config.ini")
                if os.path.exists(default_ini):
                    selected_path = default_ini
                elif os.path.exists(config_ini):
                    selected_path = config_ini
                else:
                    selected_path = default_ini
        self._uses_real_sdk = sdk_factory is None
        self.sdk_factory = sdk_factory or (lambda cfg: SDK(cfg))
        self.websocket_enabled = websocket_enabled
        self.ws_backoff_initial = WS_BACKOFF_INITIAL_SECONDS
        self.ws_backoff_max = WS_BACKOFF_MAX_SECONDS
        self.ws_silence_seconds = WS_SILENCE_SECONDS
        self.ws_watchdog_interval = WS_WATCHDOG_INTERVAL_SECONDS
        self.ws_resync_open_wait = WS_RESYNC_OPEN_WAIT_SECONDS

        self._state_lock = threading.RLock()  # guards the session pointer + cache resets
        self._session_change_lock = threading.Lock()  # serializes logins / switches
        self._login_guard_lock = threading.Lock()  # atomic check-and-record of login limits
        self._orders_refresh_lock = threading.Lock()
        self._orders_refresh_cond = threading.Condition(self._orders_refresh_lock)
        self._orders_refresh_flight: _OrdersRefreshFlight | None = None  # latest refresh=true query
        self._orders_refresh_tickets = 0  # request arrivals and query starts, in lock order
        self._shutdown_event = threading.Event()
        self._shutdown_lock = threading.Lock()  # first shutdown() caller does the work, others wait
        self._shutdown_complete = False
        self._drain_lock = threading.Lock()  # first drain_mutations() caller waits, others share its result
        self._drained: bool | None = None
        self._mutations_cond = threading.Condition()  # guards _mutations_in_flight + the shutdown flag
        self._mutations_in_flight = 0
        self._generation_seq = session_generation_base()

        cfg, _, env = load_config(selected_path)
        # Offline (not logged in / failed / locked) reports the start base: newer than any previous
        # process, older than this process's first login (base + 1).
        self._session = self._offline_session(selected_path, cfg, env, self._generation_seq)
        self.login_error: str | None = None

        # Login guard state (wall-clock timestamps; elapsed < 0 after a clock jump restarts the window)
        self.last_agr0000_time: float = 0.0
        self.hit_agr0004 = False
        self._agr0004_day: datetime.date | None = None
        self.last_reconnect_time: float = 0.0
        self.last_orders_refresh_time: float = 0.0

        # Rate Limiters
        self.order_mutation_limiter = SlidingWindowRateLimiter(max_requests=18, window_seconds=1.0)
        self.order_mutation_daily = DailyCounter(max_daily_requests=ORDERS_DAILY_MAX)
        self.reconnect_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)
        self.reconnect_daily = DailyCounter(max_daily_requests=LOGIN_DAILY_MAX)
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
        self._ws_runtime: _WsRuntime | None = None

        # Persistent login circuit breaker
        self.state_dir = resolve_state_dir(state_dir)
        self.login_state = LoginStateStore(self.state_dir)
        today = taipei_today()
        self.reconnect_daily.restore(today, self.login_state.login_attempts_for(today))

        # Startup login attempt (at most once)
        if auto_login:
            self.attempt_initial_login()

    # ─────────────────────────────────────────────────────────────────────────
    # Session snapshot accessors (read-only views kept for compatibility)
    # ─────────────────────────────────────────────────────────────────────────

    @property
    def session(self) -> EsunSession:
        return self._session

    @property
    def sdk(self) -> any:
        return self._session.sdk

    @property
    def environment(self) -> str:
        return self._session.environment

    @property
    def config_path(self) -> str | None:
        return self._session.config_path

    @property
    def entry(self) -> str:
        return self._session.entry

    @property
    def logged_in(self) -> bool:
        return self._session.logged_in

    @property
    def login_locked(self) -> bool:
        """True while the persistent credential circuit breaker blocks automatic logins."""
        return self.login_state.credential_locked

    @staticmethod
    def _offline_session(
        config_path: str | None, cfg: configparser.ConfigParser | None, env: str, generation: int
    ) -> EsunSession:
        account = split_account(cfg["User"].get("Account")) if (cfg and cfg.has_section("User")) else None
        entry = cfg.get("Core", "Entry", fallback="").strip() if (cfg and cfg.has_section("Core")) else ""
        return EsunSession(
            generation=generation,
            sdk=None,
            environment=env,
            config_path=config_path,
            config_file_name=os.path.basename(config_path) if config_path else None,
            entry=entry,
            account=account,
            source_environment=env,
        )

    def _ttl_caches(self) -> tuple[TTLCache, ...]:
        return (
            self.balance_cache,
            self.settlements_cache,
            self.positions_cache,
            self.profit_loss_cache,
            self.trade_status_cache,
            self.market_status_cache,
        )

    def _is_current(self, generation: int) -> bool:
        return self._session.generation == generation

    def is_shutting_down(self) -> bool:
        return self._shutdown_event.is_set()

    def begin_shutdown(self) -> None:
        """Refuses every order mutation from now on (503 ESUN_SHUTTING_DOWN, not_sent)."""
        with self._mutations_cond:
            self._shutdown_event.set()
            self._mutations_cond.notify_all()

    def try_begin_mutation(self) -> bool:
        """Registers an in-flight order mutation; False once shutdown has started."""
        with self._mutations_cond:
            if self._shutdown_event.is_set():
                return False
            self._mutations_in_flight += 1
            return True

    def end_mutation(self) -> None:
        with self._mutations_cond:
            self._mutations_in_flight -= 1
            self._mutations_cond.notify_all()

    def _wait_for_mutations(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with self._mutations_cond:
            while self._mutations_in_flight > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._mutations_cond.wait(remaining)
            return True

    def drain_mutations(self) -> bool:
        """
        begin_shutdown(), then gives in-flight mutations up to SHUTDOWN_MUTATION_GRACE_SECONDS to
        finish and answer (once: later callers wait for and share the first result). The HTTP
        server keeps accepting meanwhile, so new requests get 503 ESUN_SHUTTING_DOWN (not_sent).
        """
        with self._drain_lock:
            if self._drained is None:
                self.begin_shutdown()
                self._drained = self._wait_for_mutations(SHUTDOWN_MUTATION_GRACE_SECONDS)
                if not self._drained:
                    logger.warning("關閉時仍有委託請求未完成（已等待 %.0f 秒），其結果需以委託查詢確認", SHUTDOWN_MUTATION_GRACE_SECONDS)
            return self._drained

    def shutdown(self) -> None:
        """
        Graceful shutdown: drain_mutations() (refuse new mutations, in-flight ones finish and
        answer, max SHUTDOWN_MUTATION_GRACE_SECONDS), then close the WebSocket and SSE.
        Concurrent callers block until the first one has finished.
        """
        with self._shutdown_lock:
            if self._shutdown_complete:
                return
            self.drain_mutations()
            with self._state_lock:
                runtime = self._ws_runtime
                session = self._session
                self._ws_runtime = None
            self._stop_websocket(runtime, session)
            self.sse_fanout.close_all()
            self._shutdown_complete = True

    # ─────────────────────────────────────────────────────────────────────────
    # Login guard (shared by startup, reconnect and environment switch)
    # ─────────────────────────────────────────────────────────────────────────

    def _prepare_login_config(self, config_path: str | None, target_env: str | None) -> tuple[_PreparedLogin | None, str | None]:
        """Loads a config read-only; when target_env differs, rewrites [Core] in memory (never on disk)."""
        if self._uses_real_sdk and not HEADLESS_PATCH_STATE.get("ok"):
            return None, f"已停用登入：{HEADLESS_PATCH_STATE.get('detail')}"
        if not config_path:
            return None, "找不到玉山設定檔"
        cfg, problems, env = load_config(config_path)
        if problems or cfg is None:
            return None, "；".join(problems) or "無法讀取玉山設定檔"
        source_env = env
        overridden = False
        if target_env and target_env != env:
            env, _ = override_esun_config_environment(cfg, target_env)
            overridden = True
        entry = cfg.get("Core", "Entry", fallback="").strip()
        account = split_account(cfg["User"].get("Account")) if cfg.has_section("User") else None
        return _PreparedLogin(
            config=cfg,
            config_path=config_path,
            environment=env,
            source_environment=source_env,
            overridden=overridden,
            entry=entry,
            account=account,
            material=_credential_material(cfg),
        ), None

    def _acquire_login_permit(self, *, explicit: bool, force: bool, material: bytes | None) -> tuple[int, dict] | None:
        """
        Atomically checks and records one login attempt. Returns (status, error_body) when refused.
        explicit=True only for a user-triggered /esun/auth/reconnect: the only path that may
        lift the credential circuit breaker (and only if credentials changed, or force=True).
        """
        with self._login_guard_lock:
            now = time.time()
            today = taipei_today()
            if self._agr0004_day is not None and self._agr0004_day != today:
                self.hit_agr0004 = False
                self._agr0004_day = None

            lock = self.login_state.snapshot()
            if lock["locked"]:
                if not explicit:
                    return 423, {
                        "ok": False,
                        "error": (
                            f"登入熔斷鎖定中（{lock['code'] or 'LOGIN_FAILED'}）：已停用自動登入與環境切換登入；"
                            "請修正密碼或憑證後以「重新連線」解除"
                        ),
                        "code": "ESUN_LOGIN_LOCKED",
                        "login_locked": True,
                    }
                if not force and self.login_state.fingerprint_matches(material):
                    return 423, {
                        "ok": False,
                        "error": (
                            "帳號、密碼與憑證與上次失敗時相同，重試可能觸發玉山「密碼錯誤 3 次鎖帳」(AGA0000)；"
                            "請更新 .env 後重啟服務，或確認無誤後以 force=true 強制重試"
                        ),
                        "code": "ESUN_CREDENTIALS_UNCHANGED",
                        "login_locked": True,
                    }

            elapsed = now - self.last_agr0000_time
            if elapsed < 0:
                self.last_agr0000_time = now
                elapsed = 0.0
            if self.last_agr0000_time and elapsed < LOGIN_AGR0000_COOLDOWN_SECONDS:
                remaining = int(math.ceil(LOGIN_AGR0000_COOLDOWN_SECONDS - elapsed))
                return 429, {
                    "ok": False,
                    "error": f"登入頻率超限冷卻中 (AGR0000)，請於 {remaining} 秒後再試",
                    "code": "AGR0000",
                    "cooldown_remaining_sec": remaining,
                }

            if self.hit_agr0004 or not self.reconnect_daily.can_increment():
                return 429, {"ok": False, "error": "已達每日登入上限 300 次 (AGR0004)", "code": "AGR0004"}

            if explicit:
                since = now - self.last_reconnect_time
                if since < 0:
                    self.last_reconnect_time = now
                    since = 0.0
                if since < RECONNECT_MIN_INTERVAL_SECONDS:
                    return 429, {
                        "ok": False,
                        "error": "重連操作過於頻繁，請於 6 秒後重試",
                        "code": "TOO_FREQUENT",
                        "retry_after": int(math.ceil(RECONNECT_MIN_INTERVAL_SECONDS - since)),
                    }

            if not self.reconnect_limiter.acquire():
                return 429, {
                    "ok": False,
                    "error": "登入頻率過高 (限 10 次/分，AGR0000)",
                    "code": "AGR0000",
                    "retry_after": int(math.ceil(self.reconnect_limiter.time_until_available())) or 1,
                }

            self.last_reconnect_time = now
            self.reconnect_daily.increment()
            self.login_state.record_login_attempts(today, self.reconnect_daily.get_count())
            return None

    def _record_login_failure(self, message: str, material: bytes | None) -> str:
        self.login_error = message
        kind = classify_login_error(message)
        if "AGR0000" in message.upper():
            self.last_agr0000_time = time.time()
        if kind == "daily_limit":
            self.hit_agr0004 = True
            self._agr0004_day = taipei_today()
        if kind == "credential":
            self.login_state.record_credential_failure(_extract_error_code(message), message, material)
            logger.error(f"玉山證券登入失敗（憑證類，已啟動持久化熔斷鎖，禁止自動重試）：{message}")
        else:
            logger.error(f"玉山證券登入失敗（{kind}）：{message}")
        return kind

    def _perform_login(self, prepared: _PreparedLogin, reason: str) -> tuple[bool, str | None]:
        """Network login with a fresh SDK client; on success installs a new session snapshot."""
        try:
            apply_headless_keyring_patches()
            client = self.sdk_factory(prepared.config)
        except Exception as e:
            # SDK(config) validation happens locally, before any login request.
            self.login_error = f"SDK 初始化失敗：{redact(e)}"
            logger.error(self.login_error)
            return False, self.login_error
        try:
            client.login()
        except Exception as e:
            message = redact(e)
            self._record_login_failure(message, prepared.material)
            return False, message

        cert_info = None
        try:
            info = client.certinfo() if hasattr(client, "certinfo") else None
            cert_info = info if isinstance(info, dict) else None
        except Exception:
            cert_info = None

        with self._state_lock:
            self._generation_seq += 1
            generation = self._generation_seq
        session = EsunSession(
            generation=generation,
            sdk=client,
            environment=prepared.environment,
            config_path=prepared.config_path,
            config_file_name=os.path.basename(prepared.config_path),
            entry=prepared.entry,
            account=prepared.account,
            source_environment=prepared.source_environment,
            config_overridden=prepared.overridden,
            cert_info=cert_info,
            logged_in_at=taipei_now().isoformat(timespec="seconds"),
        )
        self.login_error = None
        self.login_state.clear_credential_lock()
        self._install_session(session, reason)
        logger.info(f"玉山證券登入成功（{session.environment}，{reason}，generation {generation}）")
        return True, None

    def _install_session(self, session: EsunSession, reason: str) -> None:
        """Atomically publishes a new session: caches are reset, the old WebSocket is stopped."""
        with self._state_lock:
            old_session = self._session
            old_runtime = self._ws_runtime
            self._session = session
            self._ws_runtime = None
            for cache in self._ttl_caches():
                cache.reset(session.generation)
            self.order_book_cache.reset(session.generation)
            self.last_orders_refresh_time = 0.0
        self._stop_websocket(old_runtime, old_session)
        self._start_websocket(session)
        threading.Thread(
            target=self._bootstrap_orders,
            args=(session,),
            daemon=True,
            name=f"EsunOrdersBootstrap-g{session.generation}",
        ).start()
        self._publish_session_event(reason)

    def _publish_session_event(self, reason: str, ok: bool = True, error: str | None = None) -> None:
        session = self._session
        lock = self.login_state.snapshot()
        payload = {
            "generation": session.generation,
            "environment": session.environment,
            "account": dict(session.account) if session.account else None,
            "loggedIn": session.logged_in,
            "reason": reason,
            "ok": ok,
            "error": error,
            "loginLocked": lock["locked"],
            "ts": taipei_now().isoformat(timespec="milliseconds"),
        }
        self.sse_fanout.publish("session", payload)

    def attempt_initial_login(self) -> bool:
        """Attempt login at most once at startup; never retry automatically on failure."""
        with self._session_change_lock:
            session = self._session
            if session.logged_in or self._shutdown_event.is_set():
                return session.logged_in
            lock = self.login_state.snapshot()
            if lock["locked"]:
                self.login_error = (
                    f"登入熔斷鎖定中（{lock['code'] or 'LOGIN_FAILED'}）：啟動時不自動登入；"
                    "請修正密碼或憑證後以「重新連線」解除"
                )
                logger.warning(self.login_error)
                return False
            target = session.environment if session.environment in ("SIMULATION", "PRODUCTION") else None
            prepared, err = self._prepare_login_config(session.config_path, target)
            if err:
                self.login_error = err
                logger.warning(f"Initial setup incomplete: {err}")
                return False
            refusal = self._acquire_login_permit(explicit=False, force=False, material=prepared.material)
            if refusal:
                self.login_error = refusal[1]["error"]
                logger.warning(self.login_error)
                return False
            ok, _ = self._perform_login(prepared, reason="startup")
            if not ok:
                self._publish_session_event("startup_failed", ok=False, error=self.login_error)
            return ok

    def _attempt_initial_login(self) -> None:
        self.attempt_initial_login()

    def reconnect(self, force: bool = False) -> tuple[bool, dict, int]:
        """
        Manual (explicit) reconnect: same guard as every login path plus the 6s minimum interval.
        The only way to lift the persistent credential lock (credentials must have changed, or force).
        A failed reconnect keeps the current session untouched.
        """
        if not self._session_change_lock.acquire(blocking=False):
            return False, {"ok": False, "error": "另一個登入或環境切換作業進行中", "code": "ESUN_SESSION_BUSY"}, 409
        try:
            session = self._session
            target = session.environment if session.environment in ("SIMULATION", "PRODUCTION") else None
            path = session.config_path
            if (not path or not os.path.isfile(path)) and target:
                profile = discover_esun_config_profiles(self.base_dir, path)["profiles"].get(target) or {}
                path = profile.get("filePath") or path
            prepared, err = self._prepare_login_config(path, target)
            if err:
                self.login_error = err
                return False, {"ok": False, "error": f"玉山設定不完整：{err}", "code": "CONFIG_ERROR"}, 503
            refusal = self._acquire_login_permit(explicit=True, force=bool(force), material=prepared.material)
            if refusal:
                status, body = refusal
                return False, body, status
            ok, message = self._perform_login(prepared, reason="reconnect")
            if not ok:
                self._publish_session_event("reconnect_failed", ok=False, error=message)
                return False, {
                    "ok": False,
                    "error": f"玉山登入失敗：{message}",
                    "code": "LOGIN_FAILED",
                    "login_locked": self.login_locked,
                }, 502
            session = self._session
            return True, {
                "ok": True,
                "message": "玉山證券登入成功",
                "account": dict(session.account) if session.account else None,
                "environment": session.environment,
                "sessionGeneration": session.generation,
            }, 200
        finally:
            self._session_change_lock.release()

    # ─────────────────────────────────────────────────────────────────────────
    # WebSocket supervisor (generation scoped)
    # ─────────────────────────────────────────────────────────────────────────

    def _ws_should_run(self, session: EsunSession, runtime: _WsRuntime) -> bool:
        return (
            not runtime.stop_event.is_set()
            and not self._shutdown_event.is_set()
            and self._is_current(session.generation)
        )

    @staticmethod
    def _close_sdk_websocket(sdk: any) -> None:
        closer = getattr(sdk, "close_websocket", None)
        if callable(closer):
            try:
                closer()
            except Exception as e:
                logger.debug(f"[WebSocket] close failed: {redact(e)}")

    def _stop_websocket(self, runtime: _WsRuntime | None, session: EsunSession | None) -> None:
        if runtime is None:
            return
        runtime.stop_event.set()
        runtime.note_closed()
        if session is not None and session.sdk is not None:
            self._close_sdk_websocket(session.sdk)

    def _register_ws_callbacks(self, session: EsunSession, runtime: _WsRuntime) -> None:
        sdk = session.sdk
        if not hasattr(sdk, "on"):
            return
        generation = session.generation

        def _on_order(data: dict) -> None:
            runtime.note_message()
            try:
                self._handle_ack(data, generation=generation)
            except Exception:
                logger.error(f"[WebSocket] ACK handling failed:\n{redact(traceback.format_exc())}")

        def _on_dealt(data: dict) -> None:
            runtime.note_message()
            try:
                self._handle_mat(data, generation=generation)
            except Exception:
                logger.error(f"[WebSocket] MAT handling failed:\n{redact(traceback.format_exc())}")

        def _on_error(err: any) -> None:
            logger.error(f"[WebSocket] Error (g{generation}): {redact(err)}")

        def _on_close(*args: any) -> None:
            runtime.note_closed()
            logger.info(f"[WebSocket] Closed (g{generation})")

        sdk.on("order")(_on_order)
        sdk.on("dealt")(_on_dealt)
        sdk.on("error")(_on_error)
        sdk.on("close")(_on_close)

        handler = getattr(sdk, "_SDK__wsHandler", None)
        if handler is not None:
            def _open_hook() -> None:
                if runtime.stop_event.is_set():
                    self._close_sdk_websocket(sdk)
                    return
                runtime.note_open()

            try:
                handler.bridge_open_hook = _open_hook
                handler.bridge_activity_hook = runtime.touch
            except Exception:
                pass

    def _start_websocket(self, session: EsunSession) -> None:
        if (
            not self.websocket_enabled
            or session.sdk is None
            or not hasattr(session.sdk, "connect_websocket")
            or self._shutdown_event.is_set()
        ):
            return
        runtime = _WsRuntime(session.generation)
        self._register_ws_callbacks(session, runtime)
        with self._state_lock:
            if not self._is_current(session.generation):
                return
            self._ws_runtime = runtime
        runtime.thread = threading.Thread(
            target=self._ws_supervisor, args=(session, runtime), daemon=True, name=f"EsunWS-g{session.generation}"
        )
        runtime.watchdog = threading.Thread(
            target=self._ws_watchdog, args=(session, runtime), daemon=True, name=f"EsunWSWatchdog-g{session.generation}"
        )
        runtime.thread.start()
        runtime.watchdog.start()

    def _ws_supervisor(self, session: EsunSession, runtime: _WsRuntime) -> None:
        """Keeps the session's WebSocket connected: exponential backoff (capped) with jitter."""
        backoff = self.ws_backoff_initial
        first = True
        while self._ws_should_run(session, runtime):
            # Clears the previous connection's opened flag BEFORE the resync thread waits on it,
            # so the resync snapshot is taken after this new connection opens.
            runtime.note_connecting()
            if not first:
                threading.Thread(
                    target=self._ws_resync_after_reconnect,
                    args=(session, runtime),
                    daemon=True,
                    name=f"EsunWSResync-g{session.generation}",
                ).start()
            started = time.monotonic()
            try:
                session.sdk.connect_websocket()
            except Exception as e:
                logger.warning(f"[WebSocket] 連線失敗或中斷（g{session.generation}）：{redact(e)}")
            runtime.note_closed()
            first = False
            if not self._ws_should_run(session, runtime):
                break
            if time.monotonic() - started >= WS_STABLE_SECONDS:
                backoff = self.ws_backoff_initial
            delay = min(backoff, self.ws_backoff_max)
            delay += delay * 0.2 * random.random()
            with runtime.lock:
                runtime.reconnects += 1
                attempt = runtime.reconnects
            logger.warning(f"[WebSocket] 已斷線，{delay:.1f} 秒後重連（g{session.generation}，第 {attempt} 次）")
            if runtime.stop_event.wait(delay):
                break
            backoff = min(backoff * 2, self.ws_backoff_max)

    def _ws_watchdog(self, session: EsunSession, runtime: _WsRuntime) -> None:
        """Silence detection: no message/ping/pong for ws_silence_seconds counts as a dead connection."""
        while not runtime.stop_event.wait(self.ws_watchdog_interval):
            if not self._ws_should_run(session, runtime):
                break
            connected, silent_for = runtime.silence()
            if connected and silent_for > self.ws_silence_seconds:
                logger.warning(f"[WebSocket] 已 {silent_for:.0f} 秒無任何訊息，視為斷線並重連（g{session.generation}）")
                runtime.touch()
                runtime.note_closed()
                self._close_sdk_websocket(session.sdk)

    def _ws_resync_after_reconnect(self, session: EsunSession, runtime: _WsRuntime) -> None:
        """After a reconnect, re-read orders (events may have been missed) and ask clients to resync."""
        runtime.opened_event.wait(timeout=self.ws_resync_open_wait)
        if not self._ws_should_run(session, runtime):
            return
        refreshed = self._bootstrap_orders(session)
        if self._is_current(session.generation):
            self.sse_fanout.publish("resync", {
                "reason": "ws_reconnected",
                "generation": session.generation,
                "cacheRefreshed": refreshed,
                "ts": taipei_now().isoformat(timespec="milliseconds"),
            })

    def _bootstrap_orders(self, session: EsunSession | None = None) -> bool:
        """Re-reads the day's orders into OrderBookCache (counts against the order-query limiter)."""
        session = session or self._session
        if session.sdk is None or not self._is_current(session.generation):
            return False
        if not self.orders_refresh_limiter.acquire():
            logger.warning("Bootstrap orders query skipped: order query rate limit reached")
            return False
        try:
            orders = session.sdk.get_order_results()
        except Exception as e:
            logger.warning(f"Bootstrap orders query failed: {redact(e)}")
            return False
        if isinstance(orders, list):
            return self.order_book_cache.update_from_order_results(orders, generation=session.generation)
        return False

    @staticmethod
    def _report_payload(session: EsunSession, data: dict, op_type: str, status: tuple[str, str] | None = None) -> dict:
        """§5 report event: the SDK's raw fields plus normalized identity / context fields."""
        payload = dict(data)
        order_no = str(data.get("ord_no") or data.get("ordNo") or data.get("pre_ord_no") or data.get("preOrdNo") or "")
        stock_no = data.get("stock_no") or data.get("stockNo") or data.get("stk_no") or data.get("stkNo")
        if stock_no:
            payload["stock_no"] = str(stock_no)
        payload.update({
            "ts": report_timestamp(data),
            "environment": session.environment,
            "account": dict(session.account) if session.account else None,
            "order_no": order_no,
            "op_type": op_type,
            "session_generation": session.generation,
        })
        if status is not None:
            payload["op_code"], payload["op_msg"] = status
        return payload

    def _handle_ack(self, data: dict, generation: int | None = None) -> str | None:
        """WebSocket ACK -> OrderBookCache + SSE `order` event. Events of an old session are dropped."""
        session = self._session
        if generation is not None and generation != session.generation:
            logger.info(f"[WebSocket] 丟棄舊 session（g{generation}）的委託回報")
            return None
        if not isinstance(data, dict):
            return None
        accepted, previous = self.order_book_cache.update_from_ack(data, generation=session.generation)
        if not accepted:
            return None
        payload = self._report_payload(session, data, derive_ack_op_type(data, previous), normalize_report_status(data))
        return self.sse_fanout.publish(
            "order", payload, include_ids=True, report_stream="order", report_scope=session.generation
        )

    def _handle_mat(self, data: dict, generation: int | None = None) -> str | None:
        """WebSocket MAT -> OrderBookCache (deduplicated by mkt_seq_num) + SSE `deal` event."""
        session = self._session
        if generation is not None and generation != session.generation:
            logger.info(f"[WebSocket] 丟棄舊 session（g{generation}）的成交回報")
            return None
        if not isinstance(data, dict):
            return None
        if not self.order_book_cache.update_from_mat(data, generation=session.generation):
            logger.info(
                f"[WebSocket] 略過重複的成交回報（ord_no={data.get('ord_no')}, mkt_seq_num={data.get('mkt_seq_num')}）"
            )
            return None
        self.positions_cache.mark_dirty()
        payload = self._report_payload(session, data, "Deal")
        ord_no, pre_ord_no = _order_keys(data)
        if ord_no and not pre_ord_no:
            # A converted reservation keeps pre_ord_no as its client id; MAT only carries ord_no.
            cached_pre = self.order_book_cache.pre_ord_no_of(ord_no)
            if cached_pre:
                payload["pre_ord_no"] = cached_pre
        return self.sse_fanout.publish(
            "deal", payload, include_ids=True, report_stream="deal", report_scope=session.generation
        )

    def sse_heartbeat_bytes(self, initial: bool = False) -> bytes:
        """Per-connection heartbeat (no SSE id, so it never moves the client's Last-Event-ID)."""
        session = self._session
        runtime = self._ws_runtime
        data = {
            "time": taipei_now().isoformat(timespec="seconds"),
            "generation": session.generation,
            "environment": session.environment,
            "loggedIn": session.logged_in,
            "wsConnected": bool(runtime is not None and runtime.is_connected()),
        }
        if initial:
            data["connected"] = True
            data["bootId"] = self.sse_fanout.boot_id
            data["lastEventId"] = self.sse_fanout.last_event_id
        return SSEFanoutManager.format_event("heartbeat", data)

    # ─────────────────────────────────────────────────────────────────────────
    # Status & Accounts (pure reads: no SDK network call, no state change)
    # ─────────────────────────────────────────────────────────────────────────

    def _inspect_disk_state(self, session: EsunSession) -> dict:
        """Read-only comparison of the config files on disk with the session snapshot."""
        discovery = discover_esun_config_profiles(self.base_dir, session.config_path)
        path = session.config_path
        exists = bool(path) and os.path.isfile(path)
        if exists:
            cfg, problems, disk_env = load_config(path)
        else:
            cfg, disk_env = None, "UNKNOWN"
            problems = [f"找不到玉山設定檔：{os.path.basename(path) if path else 'esun-config.ini'}"]
        disk_environment = disk_env if (exists and disk_env in ("SIMULATION", "PRODUCTION")) else None
        drift = False
        if session.logged_in:
            if not exists or disk_env != session.source_environment:
                drift = True
            else:
                disk_account = split_account(cfg["User"].get("Account")) if (cfg and cfg.has_section("User")) else None
                if disk_account != session.account:
                    drift = True
            profile = discovery["profiles"].get(session.environment) or {}
            profile_path = profile.get("filePath")
            if not profile.get("available") or not profile_path or os.path.abspath(profile_path) != os.path.abspath(path or ""):
                drift = True
        return {
            "discovery": discovery,
            "exists": exists,
            "problems": problems,
            "disk_environment": disk_environment,
            "drift": drift,
        }

    def get_health(self) -> dict:
        """Read-only status: never calls an SDK network method and never mutates bridge state."""
        session = self._session
        disk = self._inspect_disk_state(session)
        discovery = disk["discovery"]
        runtime = self._ws_runtime
        ws = runtime.snapshot() if runtime is not None else {"connected": False, "lastMessageAt": None, "reconnects": 0}
        lock = self.login_state.snapshot()
        expire, _ = self._extract_cert_meta(session.cert_info)
        cached_market = self.market_status_cache.get("market_status")
        lock_reason = None
        if lock["locked"]:
            lock_reason = f"{lock['code'] or 'LOGIN_FAILED'}：{lock['reason'] or ''}".rstrip("：")

        return {
            "ok": True,
            "configured": session.logged_in or len(disk["problems"]) == 0,
            "problems": disk["problems"],
            "environment": session.environment,
            "simulation": session.environment == "SIMULATION",
            "entry": session.entry,
            "account": dict(session.account) if session.account else None,
            "loggedIn": session.logged_in,
            "loginLocked": lock["locked"],
            "loginLockReason": lock_reason,
            "loginError": self.login_error,
            "certInfo": {"ca_expiretime": expire} if expire else None,
            "machineTime": None,
            "marketStatus": cached_market[0] if cached_market else None,
            "availableEnvironments": discovery["availableEnvironments"],
            "configProfiles": public_config_profiles(discovery),
            "activeConfigFile": session.config_file_name if disk["exists"] else None,
            "sessionGeneration": session.generation,
            "configDrift": disk["drift"],
            "diskEnvironment": disk["disk_environment"],
            "configOverridden": session.config_overridden,
            "wsConnected": bool(ws["connected"]),
            "wsLastMessageAt": ws["lastMessageAt"],
            "wsReconnects": ws["reconnects"],
            "wsKeepalive": WS_PATCH_ACTIVE,
            "sseBootId": self.sse_fanout.boot_id,
            "sdkVersion": ESUN_SDK_VERSION,
            "rateLimits": {
                "ordersToday": self.order_mutation_daily.get_count(),
                "ordersDailyMax": ORDERS_DAILY_MAX,
                "reconnectToday": self.reconnect_daily.get_count(),
                "reconnectDailyMax": LOGIN_DAILY_MAX,
            },
        }

    def get_config_profiles(self) -> dict:
        session = self._session
        discovery = discover_esun_config_profiles(self.base_dir, session.config_path)
        return {
            "ok": True,
            "availableEnvironments": discovery["availableEnvironments"],
            "configProfiles": public_config_profiles(discovery),
            "activeConfigFile": session.config_file_name if session.config_path and os.path.isfile(session.config_path) else None,
            "activeEnvironment": session.environment,
            "sessionGeneration": session.generation,
        }

    def _switch_response(
        self,
        ok: bool,
        discovery: dict | None = None,
        *,
        error: str | None = None,
        code: str | None = None,
        problems: list[str] | None = None,
        extra: dict | None = None,
    ) -> dict:
        session = self._session
        discovery = discovery or discover_esun_config_profiles(self.base_dir, session.config_path)
        res: dict[str, any] = {
            "ok": ok,
            "environment": session.environment,
            "simulation": session.environment == "SIMULATION",
            "entry": session.entry,
            "account": dict(session.account) if session.account else None,
            "activeConfigFile": session.config_file_name if session.config_path and os.path.isfile(session.config_path) else None,
            "availableEnvironments": discovery["availableEnvironments"],
            "configProfiles": public_config_profiles(discovery),
            "loggedIn": session.logged_in,
            "loginLocked": self.login_locked,
            "sessionGeneration": session.generation,
            "configOverridden": session.config_overridden,
            "problems": problems or [],
        }
        if error is not None:
            res["error"] = error
            res["code"] = code or "ESUN_SWITCH_FAILED"
        if extra:
            res.update(extra)
        return res

    def switch_environment(self, target_env: str) -> dict[str, any]:
        """Dict-only wrapper (see switch_environment_with_status)."""
        res, _ = self.switch_environment_with_status(target_env)
        return res

    def switch_environment_with_status(self, target_env: str) -> tuple[dict[str, any], int]:
        """
        Switches between SIMULATION and PRODUCTION without ever writing the user's ini files:
        dual-file mode loads the target profile file; a profile file whose [Core] does not
        match the target is overridden in memory and the ConfigParser goes to SDK(config).
        Goes through the same login guard as startup (circuit breaker, rate limit, daily cap).
        Success swaps the session (caches cleared, new WebSocket); failure keeps the current
        session. Either way a `session` SSE event is broadcast.
        """
        target = normalize_environment(target_env)
        if target is None:
            raise ValueError(f"不支援的環境設定：{target_env}，僅支援 SIMULATION 或 PRODUCTION")

        if not self._session_change_lock.acquire(blocking=False):
            return self._switch_response(False, error="另一個登入或環境切換作業進行中", code="ESUN_SESSION_BUSY"), 409
        try:
            session = self._session
            discovery = discover_esun_config_profiles(self.base_dir, session.config_path)
            if session.logged_in and session.environment == target:
                self._publish_session_event("switch_unchanged")
                return self._switch_response(True, discovery, extra={"message": f"已在 {target} 環境，未重新登入"}), 200

            profile_info = discovery["profiles"].get(target, {})
            if not profile_info.get("available", False):
                expected = profile_info.get("expectedFileName", f"esun-config.{target.lower()}.ini")
                error = f"未提供 {expected} 設定檔，無法切換至 {target}"
                self._publish_session_event("switch_failed", ok=False, error=error)
                return self._switch_response(False, discovery, error=error, code="ESUN_PROFILE_UNAVAILABLE"), 400

            prepared, err = self._prepare_login_config(profile_info.get("filePath"), target)
            if err:
                self._publish_session_event("switch_failed", ok=False, error=err)
                return self._switch_response(
                    False, discovery, error=f"玉山設定不完整：{err}", code="ESUN_CONFIG_INCOMPLETE", problems=err.split("；")
                ), 503
            refusal = self._acquire_login_permit(explicit=False, force=False, material=prepared.material)
            if refusal:
                status, body = refusal
                self._publish_session_event("switch_failed", ok=False, error=body["error"])
                extra = {k: v for k, v in body.items() if k not in ("ok", "error", "code")}
                return self._switch_response(False, discovery, error=body["error"], code=body["code"], extra=extra), status
            ok, message = self._perform_login(prepared, reason="switch")
            if not ok:
                self._publish_session_event("switch_failed", ok=False, error=message)
                return self._switch_response(
                    False,
                    discovery,
                    error=f"切換至 {target} 失敗（登入未成功，維持原環境）：{message}",
                    code="ESUN_LOGIN_FAILED",
                ), 502
            return self._switch_response(True), 200
        finally:
            self._session_change_lock.release()

    @staticmethod
    def _extract_cert_meta(cert_info: any) -> tuple[str, str]:
        if not isinstance(cert_info, dict):
            return "", ""
        expire = str(cert_info.get("ca_expiretime") or "")
        if not expire and cert_info.get("not_after"):
            try:
                ts = int(cert_info["not_after"])
                expire = datetime.datetime.fromtimestamp(ts, TAIPEI_TZ).strftime("%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError, OSError, OverflowError):
                expire = str(cert_info["not_after"])
        person_id = str(cert_info.get("person_id") or "")
        if not person_id and cert_info.get("cn"):
            person_id = str(cert_info["cn"]).split("-")[0].strip()
        return expire, person_id

    def get_ca_expiretime(self) -> dict:
        expire, _ = self._extract_cert_meta(self._session.cert_info)
        return {"ca_expiretime": expire}

    def get_accounts(self) -> list[dict]:
        session = self._session
        acc = session.account
        if not acc:
            return []
        expire, person_id = self._extract_cert_meta(session.cert_info)

        return [{
            "account_type": "S",
            "broker_id": acc["broker_id"],
            "account_id": acc["account_id"],
            "signed": True,
            "username": "玉山證券",
            "person_id": mask_identifier(person_id) if person_id else "",
            "ca_expiretime": expire,
        }]

    # ─────────────────────────────────────────────────────────────────────────
    # Order Mutations (place, replace-price, replace-qty, cancel)
    # ─────────────────────────────────────────────────────────────────────────

    def _not_logged_in_message(self) -> str:
        lock = self.login_state.snapshot()
        if lock["locked"]:
            return f"玉山尚未登入（登入熔斷鎖定中：{lock['code'] or 'LOGIN_FAILED'}），請修正後呼叫 /esun/auth/reconnect"
        if self.login_error:
            return f"玉山尚未登入：{self.login_error}"
        return "玉山證券尚未登入"

    # Contract (§4): access control -> JSON -> logged-in session (503) -> expected_environment (409)
    # -> expected_account (409) -> rate limits (429) -> local validation (400/409) -> quota consumed
    # -> SDK call. Envelope: accepted 200 / not_sent 4xx,503 / rejected 422 / unknown 502,504.

    _PAYLOAD_ORDER_FIELDS = (
        ("stock_no", ("stockNo", "stock_no")),
        ("buy_sell", ("buySell", "buy_sell")),
        ("ap_code", ("apCode", "ap_code")),
        ("price_flag", ("priceFlag", "price_flag")),
        ("bs_flag", ("bsFlag", "bs_flag")),
        ("trade", ("trade",)),
        ("ord_no", ("ordNo", "ord_no")),  # must equal order_no (validated in _resolve_order)
        ("pre_ord_no", ("preOrdNo", "pre_ord_no")),
        ("od_price", ("price", "od_price", "odPrice")),
        ("work_date", ("workDate", "work_date")),
    )
    # Bridge-side bookkeeping fields that are not part of the SDK's order result.
    _BRIDGE_ONLY_ORDER_KEYS = frozenset({"deal_qty", "status", "mat_time", "esun_fills"})

    def _mutation_prelude(self, body: any) -> tuple[EsunSession | None, tuple[dict, int] | None]:
        if not isinstance(body, dict):
            return None, not_sent(400, "ESUN_INVALID_JSON", "請求本文必須為 JSON 物件")
        if self.is_shutting_down():
            return None, self._shutting_down_refusal()
        session = self._session
        if not session.logged_in:
            return None, not_sent(503, "ESUN_NOT_LOGGED_IN", self._not_logged_in_message())
        context = {"environment": session.environment, "sessionGeneration": session.generation}
        raw_env = body.get("expected_environment", body.get("expectedEnvironment"))
        if raw_env is None or not str(raw_env).strip():
            return None, not_sent(409, "ESUN_ENV_MISMATCH", "缺少 expected_environment：請重新取得玉山環境後再送出（委託未送出）", **context)
        if normalize_environment(raw_env) != session.environment:
            return None, not_sent(
                409, "ESUN_ENV_MISMATCH",
                f"環境不符：畫面為 {raw_env}，玉山 bridge 目前為 {session.environment}（委託未送出）", **context,
            )
        raw_account = body.get("expected_account", body.get("expectedAccount"))
        if raw_account not in (None, "") and not account_matches(raw_account, session.account):
            return None, not_sent(
                409, "ESUN_ACCOUNT_MISMATCH", "帳號不符：玉山 bridge 目前登入的帳號與畫面不同（委託未送出）",
                account=dict(session.account) if session.account else None, **context,
            )
        if not self.order_mutation_daily.can_increment():
            return None, not_sent(429, "AGR0001", "已達每日委託上限 2,000 次 (AGR0001)")
        if self.order_mutation_limiter.time_until_available() > 0.5:
            return None, not_sent(429, "AGR0002", "委託頻率過高，超過每秒 18 次限制 (AGR0002)", retry_after=1)
        return session, None

    def _consume_mutation_quota(self) -> tuple[dict, int] | None:
        """Consumes the per-second slot and the daily count right before the SDK call."""
        if not self.order_mutation_limiter.acquire(timeout=0.5):
            return not_sent(429, "AGR0002", "委託頻率過高，超過每秒 18 次限制 (AGR0002)", retry_after=1)
        if not self.order_mutation_daily.increment():
            return not_sent(429, "AGR0001", "已達每日委託上限 2,000 次 (AGR0001)")
        return None

    @staticmethod
    def _shutting_down_refusal() -> tuple[dict, int]:
        return not_sent(503, "ESUN_SHUTTING_DOWN", "玉山 bridge 關閉中，委託未送出")

    def _call_sdk_mutation(self, session: EsunSession, label: str, call: any) -> tuple[dict, int]:
        if not self.try_begin_mutation():  # atomic with begin_shutdown(): nothing reaches the SDK after it
            return self._shutting_down_refusal()
        try:
            return self._call_sdk_mutation_now(session, label, call)
        finally:
            self.end_mutation()

    def _call_sdk_mutation_now(self, session: EsunSession, label: str, call: any) -> tuple[dict, int]:
        try:
            result = call()
        except Exception as e:
            message = redact(e)
            if _SDK_LOCAL_VALIDATION_RE.search(message):
                # O000xx are the SDK core's own input checks, raised before any request is built.
                logger.warning(f"{label}未送出（SDK 本地驗證）：{message}")
                return not_sent(400, "ESUN_SDK_VALIDATION", f"{label}未送出：{message}")
            low = message.lower()
            timed_out = isinstance(e, TimeoutError) or "timed out" in low or "timeout" in low
            logger.error(f"{label}結果未知（SDK 呼叫期間或之後拋出例外）：{message}")
            return {
                "ok": False,
                "outcome": "unknown",
                "code": "ESUN_OUTCOME_UNKNOWN",
                "error": f"{label}結果未知，無法確認玉山是否已收到：{message}（請以委託查詢確認，切勿直接重送）",
                "environment": session.environment,
                "sessionGeneration": session.generation,
            }, (504 if timed_out else 502)
        return self._classify_mutation_result(session, label, result)

    @staticmethod
    def _classify_mutation_result(session: EsunSession, label: str, result: any) -> tuple[dict, int]:
        ret_code = None
        if isinstance(result, dict):
            for key in ("ret_code", "retCode"):
                if result.get(key) is not None:
                    ret_code = str(result[key]).strip()
                    break
        if ret_code is not None and not is_success_ret_code(ret_code):
            ret_msg = str(result.get("ret_msg") or result.get("retMsg") or "").strip()
            return {
                "ok": False,
                "outcome": "rejected",
                "code": ret_code,
                "error": f"玉山證券拒絕{label} [{ret_code}]" + (f"：{ret_msg}" if ret_msg else ""),
                "result": result,
                "environment": session.environment,
                "sessionGeneration": session.generation,
            }, 422
        return {
            "ok": True,
            "outcome": "accepted",
            "result": result,
            "environment": session.environment,
            "sessionGeneration": session.generation,
        }, 200

    def _resolve_order(self, order_no: str, body: dict) -> tuple[dict, dict | None, dict, bool, dict]:
        """
        Cached order merged with payload hints. The payload only fills fields the cache lacks and
        never supplies quantities (their units differ between lots and odd-lot shares).
        Returns (order, cache_meta, payload, known_in_cache, sdk_order): `order` is the read view
        (effective quantities) for the checks; `sdk_order` is the raw cached row plus the same
        hints, the only form handed to the SDK.
        """
        payload = body.get("payload") if isinstance(body.get("payload"), dict) else {}
        raw, cached, meta = self.order_book_cache.get_for_mutation(order_no)
        order = dict(cached) if cached else {}
        sdk_order = self._sdk_order_dict(raw or {})
        normalizers = {
            "buy_sell": to_action,
            "ap_code": to_ap_code,
            "price_flag": lambda v: to_price_flag(v, default=None),
            "bs_flag": lambda v: to_bs_flag(v, default=None),
            "trade": lambda v: to_trade(v, default=None),
        }
        for field, aliases in self._PAYLOAD_ORDER_FIELDS:
            if order.get(field) not in (None, ""):
                continue
            value = next((payload[a] for a in aliases if payload.get(a) not in (None, "")), None)
            if value is None:
                continue
            if field in normalizers:
                value = enum_value(normalizers[field](value))
            elif field == "stock_no":
                if not isinstance(value, str) or not _STOCK_NO_RE.fullmatch(value.strip()):
                    raise EsunValidationError("payload.stockNo 格式錯誤")
                value = value.strip()
            elif field == "od_price":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    continue
            elif field == "ord_no":
                # A reservation that became a regular order has both numbers; keeping ord_no on a
                # cache miss stops it from being mistaken for a reservation (pre_ord_no only).
                value = value.strip() if isinstance(value, str) else ""
                if not _ORDER_NO_RE.fullmatch(value) or value != order_no:
                    raise EsunValidationError("payload.ordNo 格式錯誤或與 order_no 不一致")
            else:
                value = str(value).strip()
            order[field] = value
            sdk_order[field] = value
        if not order.get("ord_no") and not order.get("pre_ord_no"):
            order["ord_no"] = order_no
            sdk_order["ord_no"] = order_no
        return order, meta, payload, cached is not None, sdk_order

    @staticmethod
    def _require_order_details(order: dict) -> None:
        """recover_order_result() needs ap_code and stock_no: refuse instead of guessing defaults."""
        if not str(order.get("ap_code") or "").strip() or not str(order.get("stock_no") or "").strip():
            raise EsunValidationError(
                "委託資料不完整（缺 ap_code 或 stock_no）：請先更新委託（refresh=true）或於 payload 提供 apCode/stockNo",
                "ESUN_ORDER_DETAILS_MISSING",
                409,
            )

    def _sdk_order_dict(self, order: dict) -> dict:
        return {k: v for k, v in order.items() if k not in self._BRIDGE_ONLY_ORDER_KEYS}

    def _safe_mark_event(self, session: EsunSession, order_no: str, updates: dict | None = None) -> None:
        try:
            self.order_book_cache.mark_event(order_no, generation=session.generation, updates=updates)
        except Exception:
            logger.error(f"更新委託快取失敗（委託已送出）：\n{redact(traceback.format_exc())}")

    def _build_order_object(self, payload: dict) -> tuple[any, dict]:
        """Strictly validates a place-order payload and builds the SDK OrderObject (no SDK call)."""
        stock_no = payload.get("stockNo", payload.get("stock_no"))
        if not isinstance(stock_no, str) or not _STOCK_NO_RE.fullmatch(stock_no.strip()):
            raise EsunValidationError("委託內容不完整或格式錯誤（stockNo）")
        stock_no = stock_no.strip()
        action = to_action(payload.get("buySell", payload.get("buy_sell")))
        ap_code = to_ap_code(payload.get("apCode", payload.get("ap_code")))
        bs_flag = to_bs_flag(payload.get("bsFlag", payload.get("bs_flag")))
        price_flag = to_price_flag(payload.get("priceFlag", payload.get("price_flag")))
        trade = to_trade(payload.get("trade"))
        quantity = parse_positive_int(payload.get("quantity"), "quantity")

        ap, flag, trade_code, side = enum_value(ap_code), enum_value(price_flag), enum_value(trade), enum_value(action)
        valid_qty, qty_err = validate_order_quantity(ap, quantity)
        if not valid_qty:
            raise EsunValidationError(qty_err, "AG_INVALID_QUANTITY")
        # SDK core rule O00014: price must be None unless the price flag is Limit.
        price = parse_price(payload.get("price")) if flag == "0" else None
        if ap == "2" and flag != "0":
            raise EsunValidationError("盤後定價交易僅支援限價 (O00012)")
        if ap == "4" and flag != "0":
            raise EsunValidationError("興櫃僅支援限價 (O00015)")
        if ap == "4" and trade_code != "0":
            raise EsunValidationError("興櫃僅支援現股 (O00016)")
        if trade_code == "A" and side != "S":
            raise EsunValidationError("現股當沖賣 (trade=A) 只能搭配賣出")

        user_def = payload.get("userDef", payload.get("user_def"))
        user_def = "" if user_def is None else str(user_def)[:50]
        if OrderObject is None:
            raise EsunValidationError("esun_trade SDK 未安裝，無法建立委託", "ESUN_SDK_UNAVAILABLE", 503)
        try:
            order_obj = OrderObject(
                buy_sell=action,
                price=price,
                stock_no=stock_no,
                quantity=quantity,
                ap_code=ap_code,
                bs_flag=bs_flag,
                price_flag=price_flag,
                trade=trade,
                user_def=user_def,
            )
        except Exception as e:
            raise EsunValidationError(f"委託參數格式錯誤：{redact(e)}", "INVALID_ORDER_PARAMS")
        normalized = {
            "stock_no": stock_no,
            "buy_sell": side,
            "ap_code": ap,
            "price_flag": flag,
            "bs_flag": enum_value(bs_flag),
            "trade": trade_code,
            "od_price": price,
            "quantity": quantity,
        }
        return order_obj, normalized

    def _remember_placed_order(self, session: EsunSession, normalized: dict, result: any) -> None:
        """Caches an accepted order as request fields + response (the response alone lacks stock/ap_code)."""
        if not isinstance(result, dict) or not (result.get("ord_no") or result.get("pre_ord_no")):
            return
        entry = {k: normalized[k] for k in ("stock_no", "buy_sell", "ap_code", "price_flag", "bs_flag", "trade", "od_price")}
        if normalized["ap_code"] in ("1", "2"):
            entry["org_qty"] = normalized["quantity"]  # lots, same unit as order results
        else:
            entry["org_qty_share"] = normalized["quantity"]  # shares (order results use fractional lots in *_qty)
        entry.update(result)
        try:
            self.order_book_cache.upsert(entry, generation=session.generation, source="local")
        except Exception:
            logger.error(f"寫入委託快取失敗（委託已送出）：\n{redact(traceback.format_exc())}")

    def place_order(self, body: dict) -> tuple[dict, int]:
        """POST /esun/orders/place: {payload, expected_environment, expected_account}."""
        if not isinstance(body, dict):
            return not_sent(400, "ESUN_INVALID_JSON", "請求本文必須為 JSON 物件")
        if "payload" in body:
            payload = body.get("payload")
            if not isinstance(payload, dict):
                return not_sent(400, "ESUN_INVALID_PARAMS", "payload 必須為物件")
        else:
            payload = body  # legacy: order fields at the top level
        session, refusal = self._mutation_prelude(body)
        if refusal:
            return refusal
        try:
            order_obj, normalized = self._build_order_object(payload)
        except EsunValidationError as e:
            return not_sent(e.status, e.code, str(e))
        refusal = self._consume_mutation_quota()
        if refusal:
            return refusal
        envelope, status = self._call_sdk_mutation(session, "下單", lambda: session.sdk.place_order(order_obj))
        if envelope.get("outcome") == "accepted":
            self._remember_placed_order(session, normalized, envelope.get("result"))
        return envelope, status

    def replace_price(self, body: dict) -> tuple[dict, int]:
        """POST /esun/orders/replace-price: {order_no, price, price_flag?, payload?, expected_*}."""
        session, refusal = self._mutation_prelude(body)
        if refusal:
            return refusal
        try:
            order_no = parse_order_no(body)
            price_flag = to_price_flag(body.get("price_flag", body.get("priceFlag")))
            flag = enum_value(price_flag)
            if flag == "4":
                raise EsunValidationError("不可將委託改為市價 (O00019)，請刪單後重新下單", "AG_INVALID_PRICE_MODIFY")
            price = parse_price(body.get("price")) if flag == "0" else None
            order, _meta, payload, _known, sdk_order = self._resolve_order(order_no, body)
            # Reservation Guard (AG0006)
            if OrderBookCache.is_reservation(order) or OrderBookCache.is_reservation(payload):
                raise EsunValidationError("預約單不可改單 (AG0006)，請先刪單後重新下單", "AG0006")
            # Price Modify Guard (ROD Limit only), applied whenever the order type is known
            bs = str(order.get("bs_flag") or order.get("bsFlag") or "").strip().upper()
            current_flag = str(order.get("price_flag") or order.get("priceFlag") or "").strip().upper()
            if (bs and bs not in ("R", "ROD")) or (current_flag and current_flag not in ("0", "LIMIT", "LMT")):
                raise EsunValidationError(
                    "玉山證券僅支援 ROD 限價單改價，市價單或 IOC/FOK 請先刪單再重新下單", "AG_INVALID_PRICE_MODIFY"
                )
            if str(order.get("ap_code") or "").strip() in ("3", "5"):
                raise EsunValidationError("零股委託不支援改價，請刪單後重新下單", "AG_INVALID_PRICE_MODIFY")
            current_price = _to_number(order.get("od_price"))
            if price is not None and current_price is not None and abs(current_price - price) < 1e-9:
                raise EsunValidationError("新價格與原委託價格相同 (O00021)", "AG_INVALID_PRICE_MODIFY")
            self._require_order_details(order)
        except EsunValidationError as e:
            return not_sent(e.status, e.code, str(e))
        refusal = self._consume_mutation_quota()
        if refusal:
            return refusal
        envelope, status = self._call_sdk_mutation(
            session, "改價", lambda: session.sdk.modify_price(sdk_order, target_price=price, price_flag=price_flag)
        )
        if envelope.get("outcome") == "accepted":
            updates = {"price_flag": flag}
            if price is not None:
                updates["od_price"] = price
            self._safe_mark_event(session, order_no, updates)
        return envelope, status

    @staticmethod
    def _parse_cancel_quantity(body: dict) -> tuple[int, str]:
        """reduce-by semantics: cancel_quantity + quantity_unit ('lot' | 'share'); legacy cel_qty / cel_qty_share."""
        has_cancel = any(body.get(k) is not None for k in ("cancel_quantity", "cancelQuantity"))
        legacy = [k for k in ("cel_qty", "cel_qty_share") if body.get(k) is not None]
        if not has_cancel and not legacy:
            if body.get("quantity") is not None:
                raise EsunValidationError(
                    "quantity（目標量語意）已停用：請改送 cancel_quantity（要減少的數量）與 quantity_unit",
                    "ESUN_QTY_SEMANTICS",
                )
            raise EsunValidationError("缺少 cancel_quantity（要減少的數量）")
        if has_cancel and legacy or len(legacy) > 1:
            raise EsunValidationError("cancel_quantity、cel_qty、cel_qty_share 只能擇一提供")
        if has_cancel:
            value = body.get("cancel_quantity", body.get("cancelQuantity"))
            unit = str(body.get("quantity_unit", body.get("quantityUnit")) or "").strip().lower()
            if unit not in ("lot", "share"):
                raise EsunValidationError("quantity_unit 必須為 lot（整股／盤後，張）或 share（零股／興櫃，股）")
        else:
            value = body[legacy[0]]
            unit = "lot" if legacy[0] == "cel_qty" else "share"
        return parse_positive_int(value, "cancel_quantity"), unit

    def replace_qty(self, body: dict) -> tuple[dict, int]:
        """
        POST /esun/orders/replace-qty: reduce an order BY cancel_quantity (same semantics as
        upstream updateOrderQty and SDK cancel_order(cel_qty=...)).
        lot -> cel_qty for ap_code 1/2; share -> cel_qty_share for ap_code 3/4/5.
        """
        session, refusal = self._mutation_prelude(body)
        if refusal:
            return refusal
        try:
            order_no = parse_order_no(body)
            cancel_quantity, unit = self._parse_cancel_quantity(body)
            order, meta, payload, known, sdk_order = self._resolve_order(order_no, body)
            # Reservation Guard (AG0006)
            if OrderBookCache.is_reservation(order) or OrderBookCache.is_reservation(payload):
                raise EsunValidationError("預約單不可改單 (AG0006)，請先刪單後重新下單", "AG0006")
            self._require_order_details(order)
            ap = str(order.get("ap_code")).strip()
            expected_unit = "lot" if ap in ("1", "2") else ("share" if ap in ("3", "4", "5") else None)
            if expected_unit is None:
                raise EsunValidationError(f"未知的委託類別 ap_code={ap}")
            if unit != expected_unit:
                raise EsunValidationError(
                    f"quantity_unit={unit} 與委託類別不符（ap_code {ap} 應使用 {expected_unit}）", "ESUN_QTY_UNIT_MISMATCH"
                )
            # Remaining quantity is only "known" from an untouched broker snapshot.
            remaining = remaining_quantity(order, unit) if (known and meta and meta.get("source") == "snapshot") else None
            if remaining is not None:
                if remaining <= 0:
                    raise EsunValidationError("此委託已無剩餘量可減少（已全部成交或取消）", "ESUN_QTY_EXCEEDS_REMAINING")
                if cancel_quantity > remaining + 1e-9:
                    raise EsunValidationError(
                        f"減少量 {cancel_quantity} 超過剩餘量 {_num_out(remaining)}（{unit}）", "ESUN_QTY_EXCEEDS_REMAINING"
                    )
        except EsunValidationError as e:
            return not_sent(e.status, e.code, str(e))
        refusal = self._consume_mutation_quota()
        if refusal:
            return refusal
        kwargs = {"cel_qty": cancel_quantity} if unit == "lot" else {"cel_qty_share": cancel_quantity}
        envelope, status = self._call_sdk_mutation(session, "改量", lambda: session.sdk.cancel_order(sdk_order, **kwargs))
        if envelope.get("outcome") == "accepted":
            self._safe_mark_event(session, order_no)
        return envelope, status

    def cancel_order(self, body: dict) -> tuple[dict, int]:
        """POST /esun/orders/cancel: cancels the whole remaining quantity."""
        session, refusal = self._mutation_prelude(body)
        if refusal:
            return refusal
        try:
            order_no = parse_order_no(body)
            order, _meta, _payload, _known, sdk_order = self._resolve_order(order_no, body)
            self._require_order_details(order)
        except EsunValidationError as e:
            return not_sent(e.status, e.code, str(e))
        refusal = self._consume_mutation_quota()
        if refusal:
            return refusal
        # sdk.cancel_order without cel_qty cancels all
        envelope, status = self._call_sdk_mutation(session, "刪單", lambda: session.sdk.cancel_order(sdk_order))
        if envelope.get("outcome") == "accepted":
            self._safe_mark_event(session, order_no)
        return envelope, status

    # ─────────────────────────────────────────────────────────────────────────
    # Portfolio Queries with Tiered Caching & Rate Limiting
    # (errors are explicit: 503 not logged in, 429 rate limited, 502 SDK failure;
    #  stale data is never served as if it were fresh)
    # ─────────────────────────────────────────────────────────────────────────

    def get_orders(self, refresh: bool = False) -> list[dict]:
        """
        If refresh is False, returns local OrderBookCache (0 API calls).
        If refresh is True, returns the cache right after a get_order_results() snapshot that
        STARTED after this request arrived: a query already started after the arrival is shared
        (result or error); an older in-flight one is waited out, then the next query starts at
        max(arrival, last start + 5 s) within the 10 rpm limiter (AGR0005). Waiting happens
        outside the lock; if the query cannot start within ORDERS_REFRESH_MAX_WAIT_SECONDS the
        request fails with 429 AGR0005 + retry_after. Raises EsunQueryError on failure.
        """
        session = self._session
        if not session.logged_in:
            raise EsunQueryError(503, "ESUN_NOT_LOGGED_IN", self._not_logged_in_message())
        if not refresh:
            return self.order_book_cache.get_all()

        arrival = time.monotonic()
        deadline = arrival + ORDERS_REFRESH_MAX_WAIT_SECONDS
        cond = self._orders_refresh_cond
        with cond:
            self._orders_refresh_tickets += 1
            arrival_ticket = self._orders_refresh_tickets
            while True:
                if not self._is_current(session.generation):
                    raise EsunQueryError(503, "ESUN_SESSION_CHANGED", "等待期間玉山 session 已切換，請重新查詢")
                flight = self._orders_refresh_flight
                now = time.monotonic()
                if flight is not None and flight.generation == session.generation:
                    if flight.ticket > arrival_ticket:  # began after this request arrived: share it
                        while not flight.done:
                            cond.wait()
                        if flight.error is not None:
                            e = flight.error
                            raise EsunQueryError(e.status, e.code, str(e), retry_after=e.retry_after)
                        return self.order_book_cache.get_all()
                    if not flight.done:  # older snapshot still running: wait for it to end
                        if now >= deadline:
                            raise EsunQueryError(
                                429, "AGR0005", "委託查詢等待逾時（前一次查詢仍在進行）",
                                retry_after=ORDERS_REFRESH_MIN_INTERVAL_SECONDS,
                            )
                        cond.wait(deadline - now)
                        continue
                start_at = max(
                    arrival,
                    self.last_orders_refresh_time + ORDERS_REFRESH_MIN_INTERVAL_SECONDS,
                    now + self.orders_refresh_limiter.time_until_available(),
                )
                if start_at > deadline:
                    raise EsunQueryError(
                        429, "AGR0005",
                        "委託查詢頻率過高（refresh 最短間隔 5 秒、限 10 次/分，AGR0005）",
                        retry_after=max(1.0, start_at - now),
                    )
                if start_at > now:
                    cond.wait(start_at - now)
                    continue
                if not self.orders_refresh_limiter.acquire():
                    continue  # another caller took the slot in between: recompute
                self._orders_refresh_tickets += 1
                flight = _OrdersRefreshFlight(started=now, generation=session.generation,
                                              ticket=self._orders_refresh_tickets)
                self._orders_refresh_flight = flight
                self.last_orders_refresh_time = now
                break

        error: EsunQueryError | None = None
        try:  # SDK call outside the lock
            orders = session.sdk.get_order_results()
            if not isinstance(orders, list):
                error = EsunQueryError(502, "ORDERS_QUERY_ERROR", "玉山委託查詢回應格式錯誤")
            elif not self.order_book_cache.update_from_order_results(orders, generation=session.generation):
                error = EsunQueryError(503, "ESUN_SESSION_CHANGED", "查詢期間玉山 session 已切換，請重新查詢")
        except Exception as e:
            logger.warning(f"get_order_results failed: {redact(e)}")
            error = EsunQueryError(502, "ORDERS_QUERY_ERROR", f"玉山查詢委託失敗：{redact(e)}")
        finally:
            with cond:
                flight.error = error  # handed to the requests sharing this query only, never cached
                flight.done = True
                cond.notify_all()
        if error is not None:
            raise error
        return self.order_book_cache.get_all()

    def _cached_query(
        self,
        cache: TTLCache,
        key: str,
        fetch: any,
        label: str,
        error_code: str,
        limiter: SlidingWindowRateLimiter | None = None,
        limit_code: str | None = None,
        limit_message: str | None = None,
        decorate: any = None,
    ) -> tuple[any, int]:
        session = self._session
        if not session.logged_in:
            return {"ok": False, "error": self._not_logged_in_message(), "code": "ESUN_NOT_LOGGED_IN"}, 503
        hit = cache.get(key)
        if hit is not None:
            return (decorate(hit[0], hit[1], True) if decorate else hit[0]), 200
        if not cache.fill_lock.acquire(timeout=CACHE_FILL_WAIT_SECONDS):
            return {"ok": False, "error": f"{label}查詢忙碌中，請稍後再試", "code": "ESUN_BUSY", "retry_after": 2}, 503
        try:
            hit = cache.get(key)  # filled by the request we waited for (single-flight)
            if hit is not None:
                return (decorate(hit[0], hit[1], True) if decorate else hit[0]), 200
            with self._state_lock:
                session = self._session
                token = cache.begin_fill()
            if not session.logged_in or token[0] != session.generation:
                return {"ok": False, "error": self._not_logged_in_message(), "code": "ESUN_NOT_LOGGED_IN"}, 503
            if limiter is not None and not limiter.acquire():
                return {
                    "ok": False,
                    "error": limit_message,
                    "code": limit_code,
                    "retry_after": int(math.ceil(max(1.0, limiter.time_until_available()))),
                }, 429
            try:
                data = fetch(session.sdk)
            except Exception as e:
                return {"ok": False, "error": f"玉山查詢{label}失敗：{redact(e)}", "code": error_code}, 502
            cache.set(key, data, fill_token=token)
            return (decorate(data, 0.0, False) if decorate else data), 200
        finally:
            cache.fill_lock.release()

    def get_balance(self) -> tuple[dict, int]:
        """Mandatory 180-second TTL cache for get_balance()."""
        def _decorate(data: any, age: float, cached: bool) -> any:
            if isinstance(data, dict):
                return {**data, "cached": cached, "cache_age_sec": round(age, 1)}
            return data

        return self._cached_query(
            self.balance_cache, "balance", lambda sdk: sdk.get_balance(), "餘額", "BALANCE_QUERY_ERROR",
            decorate=_decorate,
        )

    def get_settlements(self) -> tuple[any, int]:
        """25-second TTL cache + 3 req/min limiter (AGR0006)."""
        return self._cached_query(
            self.settlements_cache, "settlements", lambda sdk: sdk.get_settlements(), "交割款", "SETTLEMENTS_QUERY_ERROR",
            limiter=self.settlements_limiter, limit_code="AGR0006", limit_message="交割款查詢頻率過高 (限 3 次/分，AGR0006)",
        )

    def get_inventories(self) -> tuple[any, int]:
        """6-second TTL cache + 10 req/min limiter (AGR0003), invalidated on MAT deals."""
        return self._cached_query(
            self.positions_cache, "positions", lambda sdk: sdk.get_inventories(), "持股庫存", "INVENTORIES_QUERY_ERROR",
            limiter=self.positions_limiter, limit_code="AGR0003", limit_message="庫存查詢頻率過高 (限 10 次/分，AGR0003)",
        )

    def get_profit_loss_with_meta(self, start_date: str | None, end_date: str | None) -> tuple[any, int, dict[str, str]]:
        """
        180-day range check/clamping (AW00002/AW00003) + 10s TTL cache + 10 req/min limiter.
        Default dates use the Asia/Taipei calendar. Returns response headers describing a clamp.
        """
        today_str = taipei_today().strftime("%Y-%m-%d")
        s_raw = start_date or today_str
        e_raw = end_date or today_str

        clamped_start, clamped_end, err = check_and_clamp_date_range(s_raw, e_raw)
        if err:
            return {"ok": False, "error": err, "code": "INVALID_DATE_RANGE"}, 400, {}

        headers: dict[str, str] = {"X-Esun-Range-Start": clamped_start, "X-Esun-Range-End": clamped_end}
        parsed_start = None
        for fmt in ("%Y-%m-%d", "%Y%m%d"):
            try:
                parsed_start = datetime.datetime.strptime(s_raw.strip(), fmt).date()
                break
            except ValueError:
                pass
        if parsed_start is not None and parsed_start.strftime("%Y-%m-%d") != clamped_start:
            headers["X-Esun-Range-Clamped"] = "1"

        cache_key = f"{clamped_start}_{clamped_end}"
        data, status = self._cached_query(
            self.profit_loss_cache, cache_key,
            lambda sdk: sdk.get_transactions_by_date(clamped_start, clamped_end), "損益", "PROFIT_LOSS_ERROR",
            limiter=self.profit_loss_limiter, limit_code="AGR0003", limit_message="損益查詢頻率過高 (限 10 次/分，AGR0003)",
        )
        return data, status, headers

    def get_profit_loss(self, start_date: str | None, end_date: str | None) -> tuple[any, int]:
        data, status, _ = self.get_profit_loss_with_meta(start_date, end_date)
        return data, status

    def get_trade_status(self) -> tuple[any, int]:
        """60-second TTL cache for get_trade_status()."""
        return self._cached_query(
            self.trade_status_cache, "trade_status", lambda sdk: sdk.get_trade_status(), "交易額度", "TRADE_STATUS_ERROR",
        )

    def get_market_status(self) -> tuple[any, int]:
        """300-second TTL cache for get_market_status()."""
        return self._cached_query(
            self.market_status_cache, "market_status", lambda sdk: sdk.get_market_status(), "市場狀態", "MARKET_STATUS_ERROR",
        )


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
                data, code, range_headers = self.bridge.get_profit_loss_with_meta(start, end)
                headers = dict(range_headers)
                headers.update(self._retry_headers(data) or {})
                self._send_json(code, data, headers)
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
        except EsunQueryError as qe:
            body = qe.to_body()
            self._send_json(qe.status, body, self._retry_headers(body))
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
        if self._is_mutation_path():
            # Tracked until the response is written, so a graceful shutdown waits for the answer.
            if not self.bridge.try_begin_mutation():
                self._send_error_json(503, "ESUN_SHUTTING_DOWN", "玉山 bridge 關閉中，委託未送出")
                return
            try:
                self._dispatch_post(path, body)
            finally:
                self.bridge.end_mutation()
            return
        self._dispatch_post(path, body)

    def _dispatch_post(self, path: str, body: dict) -> None:
        try:
            if path == "/esun/auth/reconnect":
                _, res, code = self.bridge.reconnect(force=body.get("force") is True)
                self._send_json(code, res, self._retry_headers(res))
            elif path in ("/esun/auth/environment", "/esun/environment"):
                target = body.get("environment")
                if target is None and "simulation" in body:
                    target = "SIMULATION" if body["simulation"] else "PRODUCTION"
                if not target:
                    self._send_error_json(400, "ESUN_INVALID_PARAMS", "缺少 environment 參數 (SIMULATION 或 PRODUCTION)")
                    return
                try:
                    res, status_code = self.bridge.switch_environment_with_status(str(target))
                    self._send_json(status_code, res, self._retry_headers(res))
                except ValueError as ve:
                    self._send_error_json(400, "ESUN_INVALID_PARAMS", str(ve))
            elif path == "/esun/orders/place":
                res, code = self.bridge.place_order(body)
                self._send_json(code, res, self._retry_headers(res))
            elif path == "/esun/orders/replace-price":
                res, code = self.bridge.replace_price(body)
                self._send_json(code, res, self._retry_headers(res))
            elif path == "/esun/orders/replace-qty":
                res, code = self.bridge.replace_qty(body)
                self._send_json(code, res, self._retry_headers(res))
            elif path == "/esun/orders/cancel":
                res, code = self.bridge.cancel_order(body)
                self._send_json(code, res, self._retry_headers(res))
            else:
                self._send_error_json(404, "ESUN_NOT_FOUND", f"未知的端點 POST {path}")
        except Exception:
            self._send_internal_error()

    def _handle_sse(self, qs: dict) -> None:
        """
        /esun/stream/orders: replays the events after Last-Event-ID (header, or ?last_event_id= for
        clients that recreate their EventSource), sends `resync` when that id cannot be served, then
        streams live events with 25s heartbeats. A subscriber that falls behind is disconnected.
        """
        bridge = self.bridge
        if bridge.is_shutting_down():
            self._send_error_json(503, "ESUN_SHUTTING_DOWN", "服務關閉中")
            return
        last_event_id = self.headers.get("Last-Event-ID")
        if not last_event_id:
            for key in ("last_event_id", "lastEventId"):
                values = qs.get(key)
                if values and values[0]:
                    last_event_id = values[0]
                    break
        try:
            sub, backlog, _reason = bridge.sse_fanout.subscribe(last_event_id)
        except SSECapacityError:
            self._send_error_json(503, "ESUN_SSE_CAPACITY", "SSE 連線數已達上限", retry_after=5)
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self._send_cors_headers()
            self.end_headers()

            self.wfile.write(bridge.sse_heartbeat_bytes(initial=True))
            for raw in backlog:
                self.wfile.write(raw)
            self.wfile.flush()

            while not sub.closed.is_set() and not bridge.is_shutting_down():
                try:
                    msg = sub.queue.get(timeout=SSE_HEARTBEAT_SECONDS)
                except queue.Empty:
                    self.wfile.write(bridge.sse_heartbeat_bytes())
                    self.wfile.flush()
                    continue
                if msg is None:
                    break
                self.wfile.write(msg)
                self.wfile.flush()
        except (ConnectionError, TimeoutError, OSError):
            pass
        except Exception:
            # Headers are already sent: end the stream (the client reconnects with Last-Event-ID).
            logger.error(f"SSE 串流錯誤：\n{redact(traceback.format_exc())}")
        finally:
            bridge.sse_fanout.unsubscribe(sub)


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
                # Consume the pending request first: closing a socket with unread data sends an
                # RST that can reach the client before the 503 does.
                request.settimeout(0.5)
                request.recv(65536)
            except OSError:
                pass
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

    def handle_error(self, request: any, client_address: any) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return  # client went away or timed out: not an error worth a traceback
        logger.error(f"處理請求時發生未預期錯誤：\n{redact(traceback.format_exc())}")


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
    Builds the SIGTERM/SIGINT handler. From a helper thread (calling server.shutdown() on the
    serve_forever thread deadlocks): refuse new mutations / SSE (503, still accepting and answering)
    -> in-flight mutations finish and answer (max SHUTDOWN_MUTATION_GRACE_SECONDS) -> stop
    accepting -> close the listening socket at once (late connections fail fast instead of
    hanging in the backlog) -> WebSocket / SSE close. main() calls bridge.shutdown() too, which
    waits for this one.
    """
    started = threading.Event()

    def _handler(signum: any = None, frame: any = None) -> None:
        if started.is_set():
            return
        started.set()
        logger.info("收到停止訊號（%s），開始優雅關閉…", signum)

        def _stop() -> None:
            bridge.begin_shutdown()
            try:
                bridge.drain_mutations()
                server.shutdown()
                server.server_close()
            finally:
                bridge.shutdown()

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
        server.server_close()  # idempotent; closes the listening socket before WebSocket / SSE
        bridge.shutdown()
        logger.info("伺服器已正常停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
