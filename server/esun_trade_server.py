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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import queue
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

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

def split_account(aid: str | None) -> dict[str, str]:
    """Split 11-digit or 7-digit account into broker_id and account_id."""
    id_str = str(aid or "").strip()
    if len(id_str) == 11 and id_str.isdigit():
        return {"broker_id": id_str[:4], "account_id": id_str[4:]}
    return {"broker_id": "8840", "account_id": id_str}


def load_config(config_path_override: str | None = None) -> tuple[configparser.ConfigParser | None, list[str], str]:
    """
    Loads config.ini / esun-config.ini from path or environment.
    Returns (config_parser, problems, environment).
    """
    config_path = (
        config_path_override
        or os.environ.get("ESUN_CONFIG_PATH")
        or "esun-config.ini"
    )
    problems: list[str] = []

    # If default file not found, try fallback config.ini
    if not os.path.exists(config_path) and config_path == "esun-config.ini" and os.path.exists("config.ini"):
        config_path = "config.ini"

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
        resolved_cert = os.path.abspath(os.path.join(config_dir, cert_raw)) if not os.path.isabs(cert_raw) else cert_raw
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

    entry = parser["Core"].get("Entry", "") if parser.has_section("Core") else ""
    environment = "SIMULATION" if "simulation" in entry.lower() else "PRODUCTION"

    return parser, problems, environment


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
        self.config_path = config_path or os.environ.get("ESUN_CONFIG_PATH", "esun-config.ini")
        self.sdk_factory = sdk_factory or (lambda cfg: SDK(cfg))
        self.sdk: any = None

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

        # Startup login attempt (at most once)
        if auto_login:
            self._attempt_initial_login()

    def _attempt_initial_login(self) -> None:
        """Attempt login at most once at startup; never retry automatically on failure."""
        cfg, problems, _ = load_config(self.config_path)
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
        cfg, problems, _ = load_config(self.config_path)
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
        cfg, problems, env = load_config(self.config_path)
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

        return {
            "ok": True,
            "configured": len(problems) == 0,
            "problems": problems,
            "environment": env,
            "account": account,
            "loggedIn": self.logged_in,
            "loginLocked": self.login_locked,
            "loginError": self.login_error,
            "certInfo": cert_info,
            "machineTime": machine_time,
            "marketStatus": market_status,
            "rateLimits": {
                "ordersToday": self.order_mutation_daily.get_count(),
                "ordersDailyMax": 2000,
                "reconnectToday": self.reconnect_daily.get_count(),
                "reconnectDailyMax": 300,
            },
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
# 8. HTTP & SSE Request Handler
# ─────────────────────────────────────────────────────────────────────────────

class EsunHTTPRequestHandler(BaseHTTPRequestHandler):
    """Handles /esun/* REST and SSE requests with ThreadingHTTPServer."""

    bridge: EsunTradeBridge

    def _send_json(self, status_code: int, data: any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

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
            self._send_json(code, data)
        elif path == "/esun/portfolio/balance":
            data, code = self.bridge.get_balance()
            self._send_json(code, data)
        elif path == "/esun/portfolio/settlements":
            data, code = self.bridge.get_settlements()
            self._send_json(code, data)
        elif path == "/esun/portfolio/profit-loss":
            start = qs.get("begin_date", [None])[0] or qs.get("start", [None])[0] or qs.get("start_date", [None])[0]
            end = qs.get("end_date", [None])[0] or qs.get("end", [None])[0]
            data, code = self.bridge.get_profit_loss(start, end)
            self._send_json(code, data)
        elif path == "/esun/portfolio/trading-limits":
            data, code = self.bridge.get_trade_status()
            self._send_json(code, data)
        elif path == "/esun/market_status":
            data, code = self.bridge.get_market_status()
            self._send_json(code, data)
        elif path == "/esun/stream/orders":
            self._handle_sse()
        else:
            self._send_json(404, {"error": f"未知的端點 GET {path}"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            self._send_json(400, {"error": "JSON 格式錯誤"})
            return

        try:
            if path == "/esun/auth/reconnect":
                _, res, code = self.bridge.reconnect()
                self._send_json(code, res)
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
                self._send_json(404, {"error": f"未知的端點 POST {path}"})
        except PermissionError as pe:
            self._send_json(503, {"error": str(pe), "code": "NOT_LOGGED_IN"})
        except Exception as e:
            self._send_json(500, {"error": f"伺服器錯誤：{e}"})

    def _handle_sse(self) -> None:
        """Handles /esun/stream/orders SSE connections with fan-out and 25s heartbeats."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = self.bridge.sse_fanout.register()
        try:
            # Send initial connected heartbeat
            initial_hb = f"event: heartbeat\ndata: {json.dumps({'time': datetime.datetime.now().isoformat(), 'connected': True})}\n\n"
            self.wfile.write(initial_hb.encode("utf-8"))
            self.wfile.flush()

            while True:
                try:
                    # Wait for next event or 25-second heartbeat
                    msg = q.get(timeout=25.0)
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
# 9. Server Factory & Main Entry Point
# ─────────────────────────────────────────────────────────────────────────────

def create_server(
    host: str = "127.0.0.1",
    port: int = 8090,
    bridge: EsunTradeBridge | None = None,
) -> ThreadingHTTPServer:
    """Creates a ThreadingHTTPServer instance bound to the provided or default EsunTradeBridge."""
    if bridge is None:
        bridge = EsunTradeBridge()

    class BoundHandler(EsunHTTPRequestHandler):
        pass

    BoundHandler.bridge = bridge
    server = ThreadingHTTPServer((host, port), BoundHandler)
    return server


if __name__ == "__main__":
    host = os.environ.get("ESUN_SERVER_HOST") or os.environ.get("ESUN_BRIDGE_HOST") or "127.0.0.1"
    port = int(os.environ.get("ESUN_SERVER_PORT") or os.environ.get("ESUN_BRIDGE_PORT") or 8090)

    bridge = EsunTradeBridge()
    server = create_server(host=host, port=port, bridge=bridge)
    logger.info(f"玉山證券交易 Sidecar 啟動中：http://{host}:{port}")

    status = bridge.get_health()
    if status["account"]:
        logger.info(f"綁定帳號：{status['account']['broker_id']}-{status['account']['account_id']} 環境：{status['environment']}")
    if status["problems"]:
        for p in status["problems"]:
            logger.warning(f"設定問題：{p}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("伺服器已正常停止")
        server.server_close()
