"""
test_esun_trade_server.py — Comprehensive Unit Tests for E.Sun Trade Sidecar

Covers:
1. Headless Keyring Injection (no-op setup_keyring, load_credentials from env).
2. Config loading, environment detection, and account parsing.
3. Login lockout guard (AGA0000 single-attempt breaker) & Reconnect rules (AGR0000 / AGR0004).
4. Order quantity validation (Common 1-499, Odd 1-999, Emg 1-499000).
5. Rate limiters: 18 rps sliding window & 2000 daily order limits.
6. Reservation order guard (AG0006) on replace-price and replace-qty.
7. Price modification guard (ROD Limit only).
8. Order quantity reduction calculation (replace-qty).
9. Tiered TTL caches:
   - Balance 180s mandatory TTL cache.
   - Settlements 25s TTL cache + 3 req/min limiter (AGR0006).
   - Order results 0 API calls when refresh=false, 5s interval + 10 req/min when refresh=true.
   - Inventories 6s TTL cache, marked dirty on MAT deals.
   - Profit/Loss 180-day clamping (AW00002/AW00003) + 10s TTL cache.
   - Trade status 60s TTL cache.
10. Singleton WebSocket ACK/MAT event translation and SSE fan-out with heartbeats.
11. End-to-end HTTP integration tests via ThreadingHTTPServer.
"""

from __future__ import annotations

import configparser
import contextlib
import datetime
import http.client
import io
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.request
import urllib.error

import esun_trade.sdk
import esun_trade.util
from server.esun_trade_server import (
    AccessPolicy,
    DailyCounter,
    EsunHTTPRequestHandler,
    EsunQueryError,
    EsunTradeBridge,
    HEADLESS_PATCH_STATE,
    MAX_REQUEST_BODY_BYTES,
    SSECapacityError,
    SSEFanoutManager,
    derive_ack_op_type,
    make_shutdown_handler,
    normalize_report_status,
    redact,
    register_secret,
    OrderBookCache,
    SlidingWindowRateLimiter,
    TTLCache,
    apply_headless_keyring_patches,
    check_and_clamp_date_range,
    create_server,
    detect_esun_environment,
    load_config,
    override_esun_config_environment,
    split_account,
    validate_order_quantity,
    discover_esun_config_profiles,
    ESUN_PRODUCTION_ENTRY,
    ESUN_SIMULATION_ENTRY,
    ESUN_SIMULATION_CONFIG_CANDIDATES,
    ESUN_PRODUCTION_CONFIG_CANDIDATES,
)
from esun_trade.constant import Action, APCode, BSFlag, PriceFlag, Trade


# The persistent login circuit breaker writes to ESUN_STATE_DIR: keep tests away from server/.state.
_MODULE_STATE_DIR: tempfile.TemporaryDirectory | None = None


def setUpModule():
    global _MODULE_STATE_DIR
    _MODULE_STATE_DIR = tempfile.TemporaryDirectory()
    os.environ["ESUN_STATE_DIR"] = _MODULE_STATE_DIR.name


def tearDownModule():
    os.environ.pop("ESUN_STATE_DIR", None)
    if _MODULE_STATE_DIR is not None:
        _MODULE_STATE_DIR.cleanup()


# ─────────────────────────────────────────────────────────────────────────────
# Mock SDK for deterministic testing
# ─────────────────────────────────────────────────────────────────────────────

class MockSDK:
    def __init__(self, config=None, login_fail_msg: str | None = None):
        self.config = config
        self.login_fail_msg = login_fail_msg
        self.callbacks: dict[str, any] = {}
        self.login_calls = 0
        self.placed_orders: list[dict] = []
        self.balance_calls = 0
        self.settlements_calls = 0
        self.inventories_calls = 0
        self.orders_calls = 0
        self.profit_loss_calls = 0
        self.trade_status_calls = 0
        self.market_status_calls = 0
        self.certinfo_calls = 0
        self.machine_time_calls = 0
        self.ws_connected = False
        self.ws_connect_calls = 0
        self.ws_close_calls = 0
        self._ws_lock = threading.Lock()
        self._ws_events: list[threading.Event] = []

    def login(self) -> None:
        self.login_calls += 1
        if self.login_fail_msg:
            raise Exception(self.login_fail_msg)

    def on(self, event_name: str):
        def decorator(func):
            self.callbacks[event_name] = func
            return func
        return decorator

    def connect_websocket(self) -> None:
        # Like the real SDK (WebSocketApp.run_forever) this blocks until the connection closes.
        ev = threading.Event()
        with self._ws_lock:
            self.ws_connect_calls += 1
            self._ws_events.append(ev)
            self.ws_connected = True
        ev.wait()
        with self._ws_lock:
            if ev in self._ws_events:
                self._ws_events.remove(ev)
            self.ws_connected = bool(self._ws_events)

    def close_websocket(self) -> None:
        with self._ws_lock:
            self.ws_close_calls += 1
            for ev in self._ws_events:
                ev.set()

    def certinfo(self) -> dict:
        self.certinfo_calls += 1
        return {"ca_expiretime": "2027/12/31", "subject": "CN=ESUN_TEST"}

    def get_machine_time(self) -> dict:
        self.machine_time_calls += 1
        return {"time": "2026-10-23 08:30:00", "diff": 0.05}

    def place_order(self, order_obj: any) -> dict:
        res = {
            "ord_no": f"O{len(self.placed_orders) + 1:04d}",
            "pre_ord_no": "",
            "stock_no": order_obj.stock_no,
            "buy_sell": str(order_obj.buy_sell.value if hasattr(order_obj.buy_sell, "value") else order_obj.buy_sell),
            "price": order_obj.price,
            "od_price": str(order_obj.price),
            "org_qty": order_obj.quantity,
            "quantity": order_obj.quantity,
            "ap_code": str(order_obj.ap_code.value if hasattr(order_obj.ap_code, "value") else order_obj.ap_code),
            "bs_flag": str(order_obj.bs_flag.value if hasattr(order_obj.bs_flag, "value") else order_obj.bs_flag),
            "price_flag": str(order_obj.price_flag.value if hasattr(order_obj.price_flag, "value") else order_obj.price_flag),
            "trade": str(order_obj.trade.value if hasattr(order_obj.trade, "value") else order_obj.trade),
            "ord_status": "2",
            "status": "Submitted",
        }
        self.placed_orders.append(res)
        return res

    def modify_price(self, in_order_result: dict, target_price: float = None, price_flag: any = None) -> dict:
        return {
            "ord_no": in_order_result.get("ord_no"),
            "od_price": str(target_price),
            "price_flag": str(price_flag.value if hasattr(price_flag, "value") else price_flag),
            "status": "PriceModified",
        }

    def cancel_order(self, in_order_result: dict, **kwargs) -> dict:
        return {
            "ord_no": in_order_result.get("ord_no"),
            "cel_qty": kwargs.get("cel_qty", 0),
            "cel_qty_share": kwargs.get("cel_qty_share", 0),
            "status": "Cancelled" if not kwargs else "VolumeModified",
        }

    def get_order_results(self) -> list[dict]:
        self.orders_calls += 1
        return list(self.placed_orders)

    def get_balance(self) -> dict:
        self.balance_calls += 1
        return {
            "bank_account": "88401234567",
            "available_balance": 500000,
            "currency": "TWD",
        }

    def get_settlements(self) -> list[dict]:
        self.settlements_calls += 1
        return [
            {"date": "2026-10-24", "amount": 10500, "status": "Pending"},
        ]

    def get_inventories(self) -> list[dict]:
        self.inventories_calls += 1
        return [
            {"stock_no": "2330", "qty": 1000, "cost_price": 950.0},
        ]

    def get_transactions_by_date(self, start: str, end: str) -> list[dict]:
        self.profit_loss_calls += 1
        return [
            {"stock_no": "2330", "trade_date": start, "pnl": 5000},
        ]

    def get_trade_status(self) -> dict:
        self.trade_status_calls += 1
        return {
            "trading_limit": 5000000,
            "margin_limit": 1000000,
        }

    def get_market_status(self) -> dict:
        self.market_status_calls += 1
        return {"status": "OPEN", "market": "TSE"}


# ─────────────────────────────────────────────────────────────────────────────
# Test Classes
# ─────────────────────────────────────────────────────────────────────────────

class TestKeyringAndConfig(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_file = os.path.join(self.temp_dir.name, "test_config.ini")
        self.cert_file = os.path.join(self.temp_dir.name, "test.p12")
        with open(self.cert_file, "w") as f:
            f.write("mock cert")

        ini_content = f"""[Core]
Entry = https://tradeapi-simulation.esunsec.com.tw
Environment = Simulation

[Cert]
Path = test.p12

[Api]
Key = test_key
Secret = test_secret

[User]
Account = 88401234567
"""
        with open(self.config_file, "w", encoding="utf-8") as f:
            f.write(ini_content)

        os.environ["ESUN_ACCOUNT_PASSWORD"] = "test_pw"
        os.environ["ESUN_CERT_PASSWORD"] = "test_cert_pw"

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)
        os.environ.pop("ESUN_PASSWORD", None)

    def test_headless_keyring_patches(self):
        apply_headless_keyring_patches()
        # Verify setup_keyring does not throw or prompt
        esun_trade.util.setup_keyring("88401234567")

        creds = esun_trade.util.load_credentials("88401234567")
        self.assertEqual(creds["account_password"], "test_pw")
        self.assertEqual(creds["cert_password"], "test_cert_pw")

    def test_split_account(self):
        self.assertEqual(split_account("88401234567"), {"broker_id": "8840", "account_id": "1234567"})
        self.assertEqual(split_account("96007654321"), {"broker_id": "9600", "account_id": "7654321"})
        self.assertEqual(split_account("1234567"), {"broker_id": "8840", "account_id": "1234567"})
        self.assertEqual(split_account(None), {"broker_id": "8840", "account_id": ""})

    def test_load_config_success(self):
        cfg, problems, env = load_config(self.config_file)
        self.assertEqual(problems, [])
        self.assertEqual(env, "SIMULATION")
        self.assertEqual(cfg["User"]["Account"], "88401234567")
        self.assertTrue(os.path.isabs(cfg["Cert"]["Path"]))

    def test_load_config_missing_file(self):
        cfg, problems, env = load_config("non_existent_file.ini")
        self.assertIsNone(cfg)
        self.assertTrue(any("找不到玉山設定檔" in p for p in problems))

    def test_detect_esun_environment(self):
        cp_sim = configparser.ConfigParser()
        cp_sim.read_string(f"[Core]\nEntry = {ESUN_SIMULATION_ENTRY}\nEnvironment = SIMULATION\n")
        self.assertEqual(detect_esun_environment(cp_sim), "SIMULATION")

        cp_prod = configparser.ConfigParser()
        cp_prod.read_string(f"[Core]\nEntry = {ESUN_PRODUCTION_ENTRY}\n")
        self.assertEqual(detect_esun_environment(cp_prod), "PRODUCTION")

        cp_legacy_sim = configparser.ConfigParser()
        cp_legacy_sim.read_string("[Core]\nEntry = https://custom-simulation.api.com\n")
        self.assertEqual(detect_esun_environment(cp_legacy_sim), "SIMULATION")

        cp_legacy_prod = configparser.ConfigParser()
        cp_legacy_prod.read_string("[Core]\nEntry = https://custom.api.com\n")
        self.assertEqual(detect_esun_environment(cp_legacy_prod), "PRODUCTION")

    def test_override_esun_config_environment_roundtrip_in_memory(self):
        # Contract change (§3): switching environments never rewrites the user's ini file;
        # the [Core] section is overridden on the in-memory ConfigParser handed to SDK(config).
        with open(self.config_file, "rb") as f:
            original_bytes = f.read()
        cp, _, _ = load_config(self.config_file)

        # 1. Switch to PRODUCTION
        env, entry = override_esun_config_environment(cp, "PRODUCTION")
        self.assertEqual(env, "PRODUCTION")
        self.assertEqual(entry, ESUN_PRODUCTION_ENTRY)
        self.assertFalse(cp.has_option("Core", "Environment"))
        self.assertEqual(cp.get("Core", "Entry"), ESUN_PRODUCTION_ENTRY)
        self.assertEqual(detect_esun_environment(cp), "PRODUCTION")
        # Ensure User and Api sections remain intact
        self.assertEqual(cp.get("User", "Account"), "88401234567")
        self.assertEqual(cp.get("Api", "Key"), "test_key")

        # 2. Switch to SIMULATION
        env2, entry2 = override_esun_config_environment(cp, "SIMULATION")
        self.assertEqual(env2, "SIMULATION")
        self.assertEqual(entry2, ESUN_SIMULATION_ENTRY)
        self.assertTrue(cp.has_option("Core", "Environment"))
        self.assertEqual(cp.get("Core", "Environment"), "SIMULATION")
        self.assertEqual(cp.get("Core", "Entry"), ESUN_SIMULATION_ENTRY)
        self.assertEqual(detect_esun_environment(cp), "SIMULATION")

        with self.assertRaises(ValueError):
            override_esun_config_environment(cp, "STAGING")
        # The file on disk is byte-for-byte unchanged.
        with open(self.config_file, "rb") as f:
            self.assertEqual(f.read(), original_bytes)


class TestLoginCircuitBreaker(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_file = os.path.join(self.temp_dir.name, "test_config.ini")
        with open(self.config_file, "w") as f:
            f.write("[Core]\nEntry=https://test\n[Cert]\nPath=c.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")
        with open(os.path.join(self.temp_dir.name, "c.p12"), "w") as f:
            f.write("cert")
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"
        # Each test gets its own persistent-state directory (the breaker survives restarts).
        self._prev_state_dir = os.environ.get("ESUN_STATE_DIR")
        os.environ["ESUN_STATE_DIR"] = os.path.join(self.temp_dir.name, "state")

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)
        if self._prev_state_dir is None:
            os.environ.pop("ESUN_STATE_DIR", None)
        else:
            os.environ["ESUN_STATE_DIR"] = self._prev_state_dir

    def test_single_attempt_lockout_on_failure(self):
        mock_sdk = MockSDK(login_fail_msg="AGA0000 密碼錯誤")
        bridge = EsunTradeBridge(
            config_path=self.config_file,
            sdk_factory=lambda cfg: mock_sdk,
            auto_login=True,
        )
        # Should attempt login exactly once
        self.assertEqual(mock_sdk.login_calls, 1)
        self.assertFalse(bridge.logged_in)
        self.assertTrue(bridge.login_locked)
        self.assertIn("AGA0000", bridge.login_error)

    def test_reconnect_cooldown_and_limits(self):
        mock_sdk = MockSDK(login_fail_msg="AGR0000 登入頻率超限")
        bridge = EsunTradeBridge(
            config_path=self.config_file,
            sdk_factory=lambda cfg: mock_sdk,
            auto_login=True,
        )

        # 1. Immediate reconnect should be blocked by 60s AGR0000 cooldown
        success, res, status = bridge.reconnect()
        self.assertFalse(success)
        self.assertEqual(status, 429)
        self.assertEqual(res["code"], "AGR0000")

        # Simulate 61 seconds passing
        bridge.last_agr0000_time = time.time() - 65.0
        bridge.last_reconnect_time = time.time() - 10.0

        # 2. Daily limit (300 requests)
        bridge.reconnect_daily.count = 300
        success, res, status = bridge.reconnect()
        self.assertFalse(success)
        self.assertEqual(status, 429)
        self.assertEqual(res["code"], "AGR0004")

        # 3. Successful reconnect resets lock
        bridge.reconnect_daily.count = 0
        mock_sdk.login_fail_msg = None  # Now success
        success, res, status = bridge.reconnect()
        self.assertTrue(success)
        self.assertEqual(status, 200)
        self.assertTrue(bridge.logged_in)
        self.assertFalse(bridge.login_locked)
        self.assertIsNone(bridge.login_error)


class TestOrderRulesAndGuards(unittest.TestCase):
    def test_quantity_validation(self):
        # Common / AfterMarket: 1 - 499 sheets
        self.assertFalse(validate_order_quantity("1", 0)[0])
        self.assertTrue(validate_order_quantity("1", 1)[0])
        self.assertTrue(validate_order_quantity("1", 499)[0])
        self.assertFalse(validate_order_quantity("1", 500)[0])
        self.assertTrue(validate_order_quantity("2", 10)[0])

        # Odd / IntradayOdd: 1 - 999 shares
        self.assertFalse(validate_order_quantity("3", 0)[0])
        self.assertTrue(validate_order_quantity("3", 1)[0])
        self.assertTrue(validate_order_quantity("5", 999)[0])
        self.assertFalse(validate_order_quantity("5", 1000)[0])

        # Emg: 1 - 499000 shares (>1000 must be multiple of 1000)
        self.assertTrue(validate_order_quantity("4", 500)[0])
        self.assertTrue(validate_order_quantity("4", 1000)[0])
        self.assertFalse(validate_order_quantity("4", 1500)[0])
        self.assertTrue(validate_order_quantity("4", 2000)[0])
        self.assertTrue(validate_order_quantity("4", 499000)[0])
        self.assertFalse(validate_order_quantity("4", 500000)[0])

    def test_reservation_order_guard_ag0006(self):
        res_order_1 = {"ord_no": "O001", "ord_status": "1", "stock_no": "2330", "ap_code": "1"}
        res_order_2 = {"ord_no": "", "pre_ord_no": "P001", "stock_no": "2330", "ap_code": "1"}
        res_order_3 = {"ord_no": "O002", "status": "PreSubmitted", "stock_no": "2330", "ap_code": "1"}
        normal_order = {"ord_no": "O003", "ord_status": "2", "stock_no": "2330", "ap_code": "1"}

        self.assertTrue(OrderBookCache.is_reservation(res_order_1))
        self.assertTrue(OrderBookCache.is_reservation(res_order_2))
        self.assertTrue(OrderBookCache.is_reservation(res_order_3))
        self.assertFalse(OrderBookCache.is_reservation(normal_order))

    def test_price_modify_guard(self):
        rod_limit = {"bs_flag": "R", "price_flag": "0"}
        ioc_limit = {"bs_flag": "I", "price_flag": "0"}
        fok_limit = {"bs_flag": "F", "price_flag": "0"}
        rod_market = {"bs_flag": "R", "price_flag": "4"}

        self.assertTrue(OrderBookCache.can_modify_price(rod_limit))
        self.assertFalse(OrderBookCache.can_modify_price(ioc_limit))
        self.assertFalse(OrderBookCache.can_modify_price(fok_limit))
        self.assertFalse(OrderBookCache.can_modify_price(rod_market))

    def test_date_range_check_and_clamping(self):
        # Within 180 days -> unchanged
        s, e, err = check_and_clamp_date_range("2026-05-01", "2026-08-01")
        self.assertIsNone(err)
        self.assertEqual(s, "2026-05-01")
        self.assertEqual(e, "2026-08-01")

        # Exceeds 180 days -> clamped
        s, e, err = check_and_clamp_date_range("2025-01-01", "2026-01-01")
        self.assertIsNone(err)
        self.assertEqual(e, "2026-01-01")
        e_date = datetime.date(2026, 1, 1)
        expected_s = (e_date - datetime.timedelta(days=180)).strftime("%Y-%m-%d")
        self.assertEqual(s, expected_s)

        # Invalid format -> error
        _, _, err = check_and_clamp_date_range("invalid", "2026-01-01")
        self.assertIsNotNone(err)

        # Start > End -> error
        _, _, err = check_and_clamp_date_range("2026-10-01", "2026-01-01")
        self.assertIsNotNone(err)


class TestOrderBookCacheAndSSE(unittest.TestCase):
    def test_dual_indexing_and_event_handling(self):
        cache = OrderBookCache()
        # Insert initial order via ACK
        ack_data = {
            "ord_no": "O001",
            "pre_ord_no": "P001",
            "stock_no": "2330",
            "quantity": 2,
            "org_qty": 2,
            "deal_qty": 0,
            "ord_status": "2",
        }
        cache.update_from_ack(ack_data)

        # Both lookups should find the same order
        self.assertIsNotNone(cache.get("O001"))
        self.assertIsNotNone(cache.get("P001"))
        self.assertEqual(cache.get("O001")["stock_no"], "2330")

        # Update via MAT (deal 1 sheet)
        mat_data = {
            "ord_no": "O001",
            "deal_qty": 1,
            "deal_price": 950.0,
            "mat_time": "09:05:00",
        }
        cache.update_from_mat(mat_data)
        updated = cache.get("O001")
        self.assertEqual(updated["deal_qty"], 1)
        self.assertEqual(updated["status"], "PartFilled")

        # Update via second MAT (deal another 1 sheet)
        cache.update_from_mat(mat_data)
        updated2 = cache.get("O001")
        self.assertEqual(updated2["deal_qty"], 2)
        self.assertEqual(updated2["status"], "Filled")


class TestTieredCachesAndRateLimiters(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_file = os.path.join(self.temp_dir.name, "test_config.ini")
        with open(self.config_file, "w") as f:
            f.write("[Core]\nEntry=https://test\n[Cert]\nPath=c.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")
        with open(os.path.join(self.temp_dir.name, "c.p12"), "w") as f:
            f.write("cert")
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"

        self.mock_sdk = MockSDK()
        self.bridge = EsunTradeBridge(
            config_path=self.config_file,
            sdk_factory=lambda cfg: self.mock_sdk,
            auto_login=True,
        )

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)

    def test_balance_180s_mandatory_cache(self):
        # 1st call: calls SDK
        res1, code1 = self.bridge.get_balance()
        self.assertEqual(code1, 200)
        self.assertEqual(self.mock_sdk.balance_calls, 1)
        self.assertFalse(res1.get("cached", False))

        # 2nd call: returns cached, 0 SDK calls
        res2, code2 = self.bridge.get_balance()
        self.assertEqual(code2, 200)
        self.assertEqual(self.mock_sdk.balance_calls, 1)
        self.assertTrue(res2.get("cached", True))
        self.assertIn("cache_age_sec", res2)

    def test_orders_read_write_separation(self):
        # Wait a moment for background bootstrap thread to settle if any
        time.sleep(0.05)
        initial_calls = self.mock_sdk.orders_calls

        # Prepopulate OrderBookCache
        self.bridge.order_book_cache.update_from_ack({"ord_no": "O100", "stock_no": "2330"})

        # refresh=False: 0 new SDK calls
        orders = self.bridge.get_orders(refresh=False)
        self.assertTrue(len(orders) >= 1)
        self.assertEqual(self.mock_sdk.orders_calls, initial_calls)

        # refresh=True: calls SDK (reset last refresh time to bypass 5s min interval)
        self.bridge.last_orders_refresh_time = 0.0
        orders2 = self.bridge.get_orders(refresh=True)
        self.assertEqual(self.mock_sdk.orders_calls, initial_calls + 1)

    def test_inventories_cache_invalidated_by_mat(self):
        # 1st call: calls SDK
        self.bridge.get_inventories()
        self.assertEqual(self.mock_sdk.inventories_calls, 1)

        # 2nd call: served from cache
        self.bridge.get_inventories()
        self.assertEqual(self.mock_sdk.inventories_calls, 1)

        # Simulate MAT deal
        self.bridge._handle_mat({"ord_no": "O001", "deal_qty": 1})

        # 3rd call: dirty cache invalidates, calls SDK again
        self.bridge.get_inventories()
        self.assertEqual(self.mock_sdk.inventories_calls, 2)


class TestFullHttpIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        with open(os.path.join(cls.temp_dir.name, "c.p12"), "w") as f:
            f.write("cert")

        # Create both simulation and production files in the directory
        cls.sim_config_file = os.path.join(cls.temp_dir.name, "esun-config.simulation.ini")
        with open(cls.sim_config_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=c.p12\n[Api]\nKey=sim_k\nSecret=sim_s\n[User]\nAccount=88401234567\n")

        cls.prod_config_file = os.path.join(cls.temp_dir.name, "esun-config.production.ini")
        with open(cls.prod_config_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n[Cert]\nPath=c.p12\n[Api]\nKey=prod_k\nSecret=prod_s\n[User]\nAccount=88401234567\n")

        cls.config_file = cls.sim_config_file
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"

        cls.mock_sdk = MockSDK()
        cls.bridge = EsunTradeBridge(
            config_path=cls.sim_config_file,
            sdk_factory=lambda cfg: cls.mock_sdk,
            auto_login=True,
        )

        # Start ThreadingHTTPServer on an ephemeral port (0)
        cls.server = create_server(host="127.0.0.1", port=0, bridge=cls.bridge)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)

    def _get(self, path: str):
        req = urllib.request.Request(f"{self.base_url}{path}")
        with urllib.request.urlopen(req) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data), resp.status

    def _post(self, path: str, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data), resp.status
        except urllib.error.HTTPError as err:
            data = err.read().decode("utf-8")
            return json.loads(data), err.code

    def test_health_and_accounts(self):
        health, status = self._get("/esun/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])
        self.assertTrue(health["loggedIn"])

        accounts, status = self._get("/esun/accounts")
        self.assertEqual(status, 200)
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["broker_id"], "8840")
        self.assertEqual(accounts[0]["account_id"], "1234567")

        ca_expire, status = self._get("/esun/ca_expiretime")
        self.assertEqual(status, 200)
        self.assertEqual(ca_expire["ca_expiretime"], "2027/12/31")

    def test_order_lifecycle_http(self):
        # Contract change (§4): every mutation carries expected_environment (+ optional
        # expected_account) and answers with an outcome envelope; replace-qty is reduce-by.
        env = {"expected_environment": "SIMULATION", "expected_account": "1234567"}
        # 1. Place Order
        order_payload = {
            "payload": {
                "stockNo": "2330",
                "buySell": "B",
                "quantity": 1,
                "price": 950.0,
                "apCode": "1",
                "priceFlag": "0",
                "bsFlag": "R",
            },
            **env,
        }
        placed, code = self._post("/esun/orders/place", order_payload)
        self.assertEqual(code, 200)
        self.assertTrue(placed["ok"])
        self.assertEqual(placed["outcome"], "accepted")
        self.assertEqual(placed["environment"], "SIMULATION")
        ord_no = placed["result"]["ord_no"]
        self.assertTrue(ord_no.startswith("O"))

        # 2. Get Orders (cached)
        orders, code = self._get("/esun/orders?refresh=false")
        self.assertEqual(code, 200)
        self.assertTrue(any(o.get("ord_no") == ord_no for o in orders))

        # 3. Replace Price
        rep_price_payload = {
            "order_no": ord_no,
            "price": 955.0,
            **env,
        }
        res_price, code = self._post("/esun/orders/replace-price", rep_price_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_price["outcome"], "accepted")
        self.assertEqual(res_price["result"]["status"], "PriceModified")

        # 4. Replace Qty: reduce BY one lot
        rep_qty_payload = {
            "order_no": ord_no,
            "cancel_quantity": 1,
            "quantity_unit": "lot",
            **env,
        }
        res_qty, code = self._post("/esun/orders/replace-qty", rep_qty_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_qty["result"]["status"], "VolumeModified")
        self.assertEqual(res_qty["result"]["cel_qty"], 1)

        # 5. Cancel Order
        cancel_payload = {
            "order_no": ord_no,
            **env,
        }
        res_cancel, code = self._post("/esun/orders/cancel", cancel_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_cancel["result"]["status"], "Cancelled")

        # Wrong environment is refused before anything else (not sent).
        res, code = self._post("/esun/orders/cancel", {"order_no": ord_no, "expected_environment": "PRODUCTION"})
        self.assertEqual(code, 409)
        self.assertEqual(res["code"], "ESUN_ENV_MISMATCH")
        self.assertEqual(res["outcome"], "not_sent")
        self.assertEqual(res["environment"], "SIMULATION")

    def test_reservation_order_rejection_http(self):
        # Prepopulate reservation order
        self.bridge.order_book_cache.update_from_ack({
            "ord_no": "RES001",
            "ord_status": "1",
            "stock_no": "2330",
            "ap_code": "1",
            "bs_flag": "R",
            "price_flag": "0",
        })
        env = {"expected_environment": "SIMULATION"}

        # Replace price on reservation order -> 400 AG0006
        res, code = self._post("/esun/orders/replace-price", {"order_no": "RES001", "price": 960.0, **env})
        self.assertEqual(code, 400)
        self.assertEqual(res.get("code"), "AG0006")
        self.assertEqual(res.get("outcome"), "not_sent")

        # Replace qty on reservation order -> 400 AG0006
        res, code = self._post("/esun/orders/replace-qty", {"order_no": "RES001", "cel_qty": 1, **env})
        self.assertEqual(code, 400)
        self.assertEqual(res.get("code"), "AG0006")

        # Cancellation on reservation order IS permitted
        res, code = self._post("/esun/orders/cancel", {"order_no": "RES001", **env})
        self.assertEqual(code, 200)

    def test_portfolio_endpoints_http(self):
        # Balance
        bal, code = self._get("/esun/portfolio/balance")
        self.assertEqual(code, 200)
        self.assertEqual(bal["available_balance"], 500000)

        # Positions
        pos, code = self._get("/esun/portfolio/positions")
        self.assertEqual(code, 200)
        self.assertIsInstance(pos, list)

        # Settlements
        settle, code = self._get("/esun/portfolio/settlements")
        self.assertEqual(code, 200)
        self.assertIsInstance(settle, list)

        # Profit & Loss
        pnl, code = self._get("/esun/portfolio/profit-loss?begin_date=2026-05-01&end_date=2026-06-01")
        self.assertEqual(code, 200)
        self.assertIsInstance(pnl, list)

        # Trading Limits
        limits, code = self._get("/esun/portfolio/trading-limits")
        self.assertEqual(code, 200)
        self.assertIn("trading_limit", limits)

        # Market Status
        mkt, code = self._get("/esun/market_status")
        self.assertEqual(code, 200)
        self.assertEqual(mkt["status"], "OPEN")


    def test_sse_stream_fanout_http(self):
        # Connect to /esun/stream/orders and read first event (initial heartbeat)
        req = urllib.request.Request(f"{self.base_url}/esun/stream/orders")
        resp = urllib.request.urlopen(req)

        # Read initial heartbeat
        line1 = resp.readline().decode("utf-8")
        line2 = resp.readline().decode("utf-8")
        line3 = resp.readline().decode("utf-8")

        self.assertIn("event: heartbeat", line1)
        self.assertIn("connected", line2)

        # Simulate ACK broadcast
        self.bridge._handle_ack({
            "ord_no": "SSE_ORD_1",
            "stock_no": "2330",
            "buy_sell": "B",
            "quantity": 1,
        })

        # Contract change (§5): `order` / `deal` events, ids "<boot_id>-<seq>", flat payload.
        id_line = resp.readline().decode("utf-8")
        event_line = resp.readline().decode("utf-8")
        data_line = resp.readline().decode("utf-8")
        empty_line = resp.readline().decode("utf-8")

        boot_id = self.bridge.sse_fanout.boot_id
        self.assertTrue(id_line.startswith(f"id: {boot_id}-"))
        self.assertEqual(event_line.strip(), "event: order")
        ack_obj = json.loads(data_line[len("data: "):])
        self.assertEqual(ack_obj["ord_no"], "SSE_ORD_1")  # raw SDK fields are preserved
        self.assertEqual(ack_obj["order_no"], "SSE_ORD_1")
        self.assertEqual(ack_obj["event_id"], id_line[len("id: "):].strip())
        self.assertIsInstance(ack_obj["seq"], int)
        self.assertEqual(ack_obj["environment"], "SIMULATION")
        self.assertEqual(ack_obj["account"], {"broker_id": "8840", "account_id": "1234567"})
        self.assertTrue(ack_obj["ts"].endswith("+08:00"))
        self.assertEqual(ack_obj["op_type"], "Unknown")  # no before/after quantity: never guessed as New

        # Simulate MAT broadcast
        self.bridge._handle_mat({
            "ord_no": "SSE_ORD_1",
            "deal_qty": 1,
            "deal_price": 950.0,
        })

        id_line = resp.readline().decode("utf-8")
        event_line = resp.readline().decode("utf-8")
        data_line = resp.readline().decode("utf-8")
        empty_line = resp.readline().decode("utf-8")

        self.assertEqual(id_line.strip(), f"id: {boot_id}-{ack_obj['seq'] + 1}")
        self.assertEqual(event_line.strip(), "event: deal")
        mat_obj = json.loads(data_line[len("data: "):])
        self.assertEqual(mat_obj["deal_qty"], 1)
        self.assertEqual(mat_obj["op_type"], "Deal")
        self.assertEqual(mat_obj["seq"], ack_obj["seq"] + 1)

        resp.close()

    def test_switch_environment_http(self):
        # 1. Verify GET /esun/config-profiles returns both profiles
        profiles_data, status = self._get("/esun/config-profiles")
        self.assertEqual(status, 200)
        self.assertTrue(profiles_data.get("ok"))
        self.assertEqual(profiles_data.get("availableEnvironments"), ["SIMULATION", "PRODUCTION"])
        self.assertTrue(profiles_data["configProfiles"]["SIMULATION"]["available"])
        self.assertTrue(profiles_data["configProfiles"]["PRODUCTION"]["available"])

        # 2. Switch to PRODUCTION via POST /esun/auth/environment
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/esun/auth/environment",
            data=json.dumps({"environment": "PRODUCTION"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("ok"))
            self.assertEqual(data.get("environment"), "PRODUCTION")
            self.assertFalse(data.get("simulation"))
            self.assertEqual(data.get("entry"), ESUN_PRODUCTION_ENTRY)
            self.assertEqual(data.get("activeConfigFile"), "esun-config.production.ini")

        # Health should reflect PRODUCTION and activeConfigFile
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/esun/health") as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data.get("environment"), "PRODUCTION")
            self.assertFalse(data.get("simulation"))
            self.assertEqual(data.get("entry"), ESUN_PRODUCTION_ENTRY)
            self.assertEqual(data.get("activeConfigFile"), "esun-config.production.ini")
            self.assertEqual(data.get("availableEnvironments"), ["SIMULATION", "PRODUCTION"])

        # 3. Switch back to SIMULATION via POST /esun/environment
        req2 = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/esun/environment",
            data=json.dumps({"simulation": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req2) as resp:
            self.assertEqual(resp.status, 200)
            data2 = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data2.get("ok"))
            self.assertEqual(data2.get("environment"), "SIMULATION")
            self.assertTrue(data2.get("simulation"))
            self.assertEqual(data2.get("entry"), ESUN_SIMULATION_ENTRY)
            self.assertEqual(data2.get("activeConfigFile"), "esun-config.simulation.ini")

    def test_order_rate_limiter_burst_and_daily(self):
        # Test 18 req/sec sliding window limiter
        limiter = SlidingWindowRateLimiter(max_requests=18, window_seconds=1.0)
        for _ in range(18):
            self.assertTrue(limiter.acquire(timeout=0.0))
        # 19th request should fail
        self.assertFalse(limiter.acquire(timeout=0.0))

        # Test 2000 req/day daily counter
        counter = DailyCounter(max_daily_requests=2000)
        counter.count = 2000
        self.assertFalse(counter.can_increment())
        self.assertFalse(counter.increment())

    def test_settlements_rate_limiter_agr0006(self):
        # Invalidate settlements cache
        self.bridge.settlements_cache.invalidate()
        # Exhaust 3 req/min limiter
        self.bridge.settlements_limiter.timestamps = [time.time(), time.time(), time.time()]
        # Call should return 429 with AGR0006 when no cache is available
        res, code = self.bridge.get_settlements()
        self.assertEqual(code, 429)
        self.assertEqual(res.get("code"), "AGR0006")



class TestConfigProfilesDiscovery(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        with open(os.path.join(self.temp_dir.name, "cert.p12"), "w") as f:
            f.write("cert")
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)
        os.environ.pop("ESUN_SIMULATION_CONFIG_PATH", None)
        os.environ.pop("ESUN_PRODUCTION_CONFIG_PATH", None)

    def test_discover_dual_profiles(self):
        sim_file = os.path.join(self.temp_dir.name, "esun-config.simulation.ini")
        prod_file = os.path.join(self.temp_dir.name, "esun-config.production.ini")
        with open(sim_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n")
        with open(prod_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n")

        discovery = discover_esun_config_profiles(base_dir=self.temp_dir.name)
        self.assertEqual(discovery["availableEnvironments"], ["SIMULATION", "PRODUCTION"])
        self.assertTrue(discovery["profiles"]["SIMULATION"]["available"])
        self.assertEqual(discovery["profiles"]["SIMULATION"]["fileName"], "esun-config.simulation.ini")
        self.assertTrue(discovery["profiles"]["PRODUCTION"]["available"])
        self.assertEqual(discovery["profiles"]["PRODUCTION"]["fileName"], "esun-config.production.ini")

    def test_discover_aliases(self):
        sim_alias = os.path.join(self.temp_dir.name, "esun-config.sim.ini")
        prod_alias = os.path.join(self.temp_dir.name, "esun-config.prod.ini")
        with open(sim_alias, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n")
        with open(prod_alias, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n")

        discovery = discover_esun_config_profiles(base_dir=self.temp_dir.name)
        self.assertEqual(discovery["availableEnvironments"], ["SIMULATION", "PRODUCTION"])
        self.assertEqual(discovery["profiles"]["SIMULATION"]["fileName"], "esun-config.sim.ini")
        self.assertEqual(discovery["profiles"]["PRODUCTION"]["fileName"], "esun-config.prod.ini")

    def test_single_sim_profile_refuses_production_switch(self):
        sim_file = os.path.join(self.temp_dir.name, "esun-config.simulation.ini")
        with open(sim_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=cert.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")

        mock_sdk = MockSDK()
        bridge = EsunTradeBridge(config_path=sim_file, sdk_factory=lambda cfg: mock_sdk, auto_login=True)
        health = bridge.get_health()
        self.assertEqual(health["availableEnvironments"], ["SIMULATION"])
        self.assertTrue(health["configProfiles"]["SIMULATION"]["available"])
        self.assertFalse(health["configProfiles"]["PRODUCTION"]["available"])

        # Attempt to switch to unavailable PRODUCTION
        res = bridge.switch_environment("PRODUCTION")
        self.assertFalse(res["ok"])
        self.assertIn("未提供 esun-config.production.ini 設定檔", res["error"])
        # Environment should remain unchanged
        self.assertEqual(bridge.environment, "SIMULATION")
        self.assertEqual(res["environment"], "SIMULATION")

    def test_single_fallback_esun_config_detection(self):
        # Single esun-config.ini with PRODUCTION settings
        single_file = os.path.join(self.temp_dir.name, "esun-config.ini")
        with open(single_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n[Cert]\nPath=cert.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")

        discovery = discover_esun_config_profiles(base_dir=self.temp_dir.name)
        self.assertEqual(discovery["availableEnvironments"], ["PRODUCTION"])
        self.assertFalse(discovery["profiles"]["SIMULATION"]["available"])
        self.assertTrue(discovery["profiles"]["PRODUCTION"]["available"])
        self.assertEqual(discovery["profiles"]["PRODUCTION"]["fileName"], "esun-config.ini")

    def test_discover_dual_profiles_with_placeholder_present(self):
        # Create simulation and production files, plus an unconfigured placeholder esun-config.ini
        sim_file = os.path.join(self.temp_dir.name, "esun-config.simulation.ini")
        prod_file = os.path.join(self.temp_dir.name, "esun-config.production.ini")
        placeholder = os.path.join(self.temp_dir.name, "esun-config.ini")

        with open(sim_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=cert.p12\n[Api]\nKey=sim_key\nSecret=sim_sec\n[User]\nAccount=88401111111\n")
        with open(prod_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n[Cert]\nPath=cert.p12\n[Api]\nKey=prod_key\nSecret=prod_sec\n[User]\nAccount=88402222222\n")
        with open(placeholder, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=certs/cert.p12\n[Api]\nKey=YOUR_API_KEY_HERE\nSecret=YOUR_API_SECRET_HERE\n[User]\nAccount=88401234567\n")

        os.environ["ESUN_CONFIG_DIR"] = self.temp_dir.name
        try:
            discovery = discover_esun_config_profiles()
            self.assertEqual(discovery["availableEnvironments"], ["SIMULATION", "PRODUCTION"])
            self.assertEqual(discovery["profiles"]["SIMULATION"]["fileName"], "esun-config.simulation.ini")
            self.assertEqual(discovery["profiles"]["PRODUCTION"]["fileName"], "esun-config.production.ini")

            mock_sdk = MockSDK()
            bridge = EsunTradeBridge(config_path=None, sdk_factory=lambda cfg: mock_sdk, auto_login=True)
            self.assertEqual(bridge.config_path, sim_file)
            self.assertEqual(bridge.environment, "SIMULATION")

            health = bridge.get_health()
            self.assertEqual(health["activeConfigFile"], "esun-config.simulation.ini")
            self.assertEqual(health["account"]["account_id"], "1111111")
            self.assertEqual(health["availableEnvironments"], ["SIMULATION", "PRODUCTION"])

            # Populate caches in SIMULATION
            bridge.order_book_cache.update_from_ack({"ord_no": "O_SIM", "stock_no": "2330"})
            bridge.positions_cache.set("positions", [{"stock_no": "2330", "qty": 1000}])
            bridge.balance_cache.set("balance", {"acc_balance": 500000})

            # Switch to PRODUCTION and verify account updates
            switch_res = bridge.switch_environment("PRODUCTION")
            self.assertIsNone(bridge.order_book_cache.get("O_SIM"))
            self.assertEqual(bridge.order_book_cache.get_all(), [])
            self.assertIsNone(bridge.positions_cache.get("positions"))
            self.assertIsNone(bridge.balance_cache.get("balance"))
            self.assertTrue(switch_res["ok"])
            self.assertEqual(switch_res["environment"], "PRODUCTION")
            self.assertEqual(switch_res["activeConfigFile"], "esun-config.production.ini")
            self.assertIsNotNone(switch_res["account"])
            self.assertEqual(switch_res["account"]["account_id"], "2222222")
        finally:
            os.environ.pop("ESUN_CONFIG_DIR", None)

    def test_single_sim_profile_with_leftover_ini_not_polluted(self):
        # Only simulation file provided, but directory has leftover esun-config.ini
        sim_file = os.path.join(self.temp_dir.name, "esun-config.simulation.ini")
        leftover = os.path.join(self.temp_dir.name, "esun-config.ini")

        with open(sim_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=cert.p12\n[Api]\nKey=sim_key\nSecret=sim_sec\n[User]\nAccount=88401111111\n")
        with open(leftover, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n[Cert]\nPath=cert.p12\n[Api]\nKey=prod_key\nSecret=prod_sec\n[User]\nAccount=88409999999\n")

        discovery = discover_esun_config_profiles(base_dir=self.temp_dir.name)
        # PRODUCTION must be unavailable because user explicitly provided dedicated simulation config
        self.assertEqual(discovery["availableEnvironments"], ["SIMULATION"])
        self.assertTrue(discovery["profiles"]["SIMULATION"]["available"])
        self.assertFalse(discovery["profiles"]["PRODUCTION"]["available"])

    def test_esun_config_dir_support(self):
        sim_file = os.path.join(self.temp_dir.name, "esun-config.simulation.ini")
        with open(sim_file, "w") as f:
            f.write(f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n[Cert]\nPath=cert.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")

        os.environ["ESUN_CONFIG_DIR"] = self.temp_dir.name
        try:
            discovery = discover_esun_config_profiles()
            self.assertEqual(discovery["availableEnvironments"], ["SIMULATION"])
            self.assertEqual(discovery["profiles"]["SIMULATION"]["filePath"], sim_file)

            mock_sdk = MockSDK()
            bridge = EsunTradeBridge(config_path=None, sdk_factory=lambda cfg: mock_sdk, auto_login=True)
            self.assertEqual(bridge.base_dir, self.temp_dir.name)
            self.assertEqual(bridge.config_path, sim_file)
        finally:
            os.environ.pop("ESUN_CONFIG_DIR", None)


# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers for the review-fix regression tests
# ─────────────────────────────────────────────────────────────────────────────

def _write_profile(directory: str, file_name: str, environment: str, account: str = "88401234567",
                   key: str | None = None, secret: str | None = None) -> str:
    """Writes a profile ini (and its c.p12) into directory; returns the absolute path."""
    cert = os.path.join(directory, "c.p12")
    if not os.path.exists(cert):
        with open(cert, "w") as f:
            f.write("cert")
    if environment == "SIMULATION":
        core = f"[Core]\nEntry={ESUN_SIMULATION_ENTRY}\nEnvironment=SIMULATION\n"
    else:
        core = f"[Core]\nEntry={ESUN_PRODUCTION_ENTRY}\n"
    key = key or f"{environment.lower()}_key"
    secret = secret or f"{environment.lower()}_secret_value"
    path = os.path.join(directory, file_name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{core}[Cert]\nPath=c.p12\n[Api]\nKey={key}\nSecret={secret}\n[User]\nAccount={account}\n")
    return os.path.abspath(path)


def _raw_request(port: int, method: str, path: str, headers: dict | None = None,
                 body: bytes | None = None, send_length: bool = True):
    """Sends a request with full header control (Host included); returns (status, headers, json-or-bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        hdrs = dict(headers or {})
        hdrs.setdefault("Host", f"127.0.0.1:{port}")
        for k, v in hdrs.items():
            if v is not None:
                conn.putheader(k, v)
        if body is not None and send_length:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body if (body is not None and send_length) else None)
        resp = conn.getresponse()
        raw = resp.read()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            data = raw
        return resp.status, resp_headers, data
    finally:
        conn.close()


def _serve(server):
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    return thread


class TestAccessControlHttp(unittest.TestCase):
    """§2 access control: Host allowlist -> token -> CSRF, bounded JSON bodies, CORS allowlist only."""

    TOKEN = "unit-test-bridge-token-0123456789"
    ALLOWED_ORIGIN = "http://localhost:5173"

    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.sim_file = _write_profile(cls.temp_dir.name, "esun-config.simulation.ini", "SIMULATION")
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"
        cls.mock_sdk = MockSDK()
        cls.bridge = EsunTradeBridge(config_path=cls.sim_file, sdk_factory=lambda cfg: cls.mock_sdk, auto_login=True)
        cls.open_server = create_server(
            host="127.0.0.1", port=0, bridge=cls.bridge,
            access_policy=AccessPolicy(allowed_hosts=["trader.lan", "*.corp.example"], allowed_origins=[cls.ALLOWED_ORIGIN]),
        )
        cls.token_server = create_server(host="127.0.0.1", port=0, bridge=cls.bridge, access_policy=AccessPolicy(token=cls.TOKEN))
        cls.open_port = cls.open_server.server_address[1]
        cls.token_port = cls.token_server.server_address[1]
        _serve(cls.open_server)
        _serve(cls.token_server)

    @classmethod
    def tearDownClass(cls):
        for server in (cls.open_server, cls.token_server):
            server.shutdown()
            server.server_close()
        cls.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)

    def _get(self, path, headers=None, port=None):
        return _raw_request(port or self.open_port, "GET", path, headers=headers)

    def _post(self, path, body=b"{}", headers=None, port=None, send_length=True):
        hdrs = {"Content-Type": "application/json"}
        hdrs.update(headers or {})
        return _raw_request(port or self.open_port, "POST", path, headers=hdrs, body=body, send_length=send_length)

    def test_livez_is_unauthenticated_and_side_effect_free(self):
        status, _, data = self._get("/esun/livez", headers={"Host": "evil.example"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})
        status, _, data = self._get("/esun/livez", port=self.token_port)
        self.assertEqual(status, 200)
        self.assertEqual(data, {"ok": True})

    def test_host_allowlist(self):
        for host in ("evil.example", "evil.example:8090", "127.0.0.1.evil.example", "localhost.evil:80"):
            status, _, data = self._get("/esun/health", headers={"Host": host})
            self.assertEqual(status, 421, host)
            self.assertEqual(data["code"], "ESUN_HOST_NOT_ALLOWED")
        for host in ("localhost:8090", "LOCALHOST", "[::1]:8090", "esun-bridge:8090", "host.docker.internal",
                     "trader.lan:8080", "desk.corp.example"):
            status, _, _ = self._get("/esun/health", headers={"Host": host})
            self.assertEqual(status, 200, host)
        # A missing Host header is refused as well (DNS-rebinding protection needs it).
        conn = http.client.HTTPConnection("127.0.0.1", self.open_port, timeout=10)
        try:
            conn.putrequest("GET", "/esun/health", skip_host=True, skip_accept_encoding=True)
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 421)
        finally:
            conn.close()

    def test_sec_fetch_site_blocks_cross_site(self):
        for site in ("cross-site", "same-site"):
            status, _, data = self._get("/esun/health", headers={"Sec-Fetch-Site": site})
            self.assertEqual(status, 403, site)
            self.assertEqual(data["code"], "ESUN_CROSS_SITE")
        for site in ("same-origin", "none"):
            status, _, _ = self._get("/esun/health", headers={"Sec-Fetch-Site": site})
            self.assertEqual(status, 200, site)
        # An allowlisted origin may call cross-site (dev server on another port).
        status, headers, _ = self._get("/esun/health", headers={"Sec-Fetch-Site": "same-site", "Origin": self.ALLOWED_ORIGIN})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("access-control-allow-origin"), self.ALLOWED_ORIGIN)

    def test_origin_must_match_host_when_not_allowlisted(self):
        port = self.open_port
        status, _, data = self._post("/esun/__probe", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(data["code"], "ESUN_CROSS_SITE")
        status, _, _ = self._post("/esun/__probe", headers={"Origin": "null"})
        self.assertEqual(status, 403)
        status, _, _ = self._post("/esun/__probe", headers={"Origin": f"http://localhost:{port + 1}", "Host": f"localhost:{port}"})
        self.assertEqual(status, 403)
        # Same origin (port included, default port filled in) passes the guard and reaches routing (404).
        status, _, data = self._post("/esun/__probe", headers={"Origin": f"http://127.0.0.1:{port}"})
        self.assertEqual(status, 404)
        status, _, _ = self._post("/esun/__probe", headers={"Origin": "http://localhost", "Host": "localhost"})
        self.assertEqual(status, 404)
        status, _, _ = self._post("/esun/__probe", headers={"Origin": "http://localhost:80", "Host": "localhost"})
        self.assertEqual(status, 404)

    def test_cors_headers_only_for_allowlisted_origins_never_wildcard(self):
        status, headers, _ = self._get("/esun/health", headers={"Origin": self.ALLOWED_ORIGIN})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("access-control-allow-origin"), self.ALLOWED_ORIGIN)
        self.assertEqual(headers.get("vary"), "Origin")
        status, headers, _ = self._get("/esun/health", headers={"Origin": f"http://127.0.0.1:{self.open_port}"})
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)
        status, headers, _ = self._get("/esun/health")
        self.assertNotIn("access-control-allow-origin", headers)
        self.assertNotIn("access-control-allow-methods", headers)

    def test_options_preflight(self):
        status, headers, _ = _raw_request(self.open_port, "OPTIONS", "/esun/orders/place", headers={
            "Origin": self.ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-esun-bridge-token",
        })
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("access-control-allow-origin"), self.ALLOWED_ORIGIN)
        self.assertEqual(headers.get("vary"), "Origin")
        self.assertEqual(headers.get("access-control-allow-methods"), "GET, POST")
        self.assertEqual(headers.get("access-control-allow-headers"), "Content-Type, X-Esun-Bridge-Token")
        status, headers, _ = _raw_request(self.open_port, "OPTIONS", "/esun/orders/place", headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)
        status, _, _ = _raw_request(self.open_port, "OPTIONS", "/esun/orders/place")
        self.assertEqual(status, 403)

    def test_post_requires_bounded_json_object(self):
        status, _, data = self._post("/esun/__probe", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        self.assertEqual(data["code"], "ESUN_UNSUPPORTED_MEDIA_TYPE")
        status, _, _ = self._post("/esun/__probe", headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 415)
        status, _, _ = self._post("/esun/__probe", headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(status, 404)
        status, _, data = self._post("/esun/__probe", body=None)
        self.assertEqual(status, 411)
        self.assertEqual(data["code"], "ESUN_LENGTH_REQUIRED")
        status, _, _ = self._post("/esun/__probe", body=None, headers={"Content-Length": "abc"})
        self.assertEqual(status, 411)
        status, _, _ = self._post("/esun/__probe", body=None, headers={"Content-Length": "-5"})
        self.assertEqual(status, 411)
        # Oversized body: declared length alone triggers 413 (the body is never read).
        status, _, data = self._post("/esun/__probe", body=None, headers={"Content-Length": str(MAX_REQUEST_BODY_BYTES + 1)})
        self.assertEqual(status, 413)
        self.assertEqual(data["code"], "ESUN_PAYLOAD_TOO_LARGE")
        status, _, data = self._post("/esun/__probe", body=b"{not json")
        self.assertEqual(status, 400)
        self.assertEqual(data["code"], "ESUN_INVALID_JSON")
        status, _, data = self._post("/esun/__probe", body=b"[1, 2]")
        self.assertEqual(status, 400)
        self.assertEqual(data["code"], "ESUN_INVALID_JSON")

    def test_mutation_path_refusals_are_not_sent_envelopes(self):
        status, _, data = self._post("/esun/orders/place", headers={"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        self.assertFalse(data["ok"])
        self.assertEqual(data["outcome"], "not_sent")
        status, _, data = self._post("/esun/orders/cancel", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        self.assertEqual(data["outcome"], "not_sent")

    def test_token_required_when_configured(self):
        status, _, data = self._get("/esun/health", port=self.token_port)
        self.assertEqual(status, 401)
        self.assertEqual(data["code"], "ESUN_UNAUTHORIZED")
        status, _, _ = self._get("/esun/health", port=self.token_port, headers={"X-Esun-Bridge-Token": "wrong"})
        self.assertEqual(status, 401)
        status, _, data = self._get("/esun/health", port=self.token_port, headers={"X-Esun-Bridge-Token": self.TOKEN})
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        # Host is checked before the token.
        status, _, data = self._get("/esun/health", port=self.token_port, headers={"Host": "evil.example"})
        self.assertEqual(status, 421)
        # SSE is protected as well.
        status, _, _ = self._get("/esun/stream/orders", port=self.token_port)
        self.assertEqual(status, 401)

    def test_internal_error_does_not_leak_exception_text(self):
        with mock.patch.object(self.bridge, "get_health", side_effect=RuntimeError("super-secret-detail")):
            with contextlib.redirect_stderr(io.StringIO()):
                status, _, data = self._get("/esun/health")
        self.assertEqual(status, 500)
        self.assertEqual(data["code"], "ESUN_INTERNAL_ERROR")
        self.assertNotIn("super-secret-detail", json.dumps(data, ensure_ascii=False))
        self.assertTrue(data.get("requestId"))

    def test_request_log_omits_query_string(self):
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            status, _, _ = self._get("/esun/ca_expiretime?person_id=A123456789")
        self.assertEqual(status, 200)
        log = buf.getvalue()
        self.assertIn("/esun/ca_expiretime", log)
        self.assertNotIn("A123456789", log)
        self.assertNotIn("person_id", log)

    def test_access_policy_from_env_parsing(self):
        policy = AccessPolicy.from_env({
            "ESUN_ALLOWED_HOSTS": "a.lan, *.corp  .home 192.168.1.10:8080 _ ~^regex$",
            "ESUN_ALLOWED_ORIGINS": "http://localhost:5173,https://x.example:443, not-an-origin",
            "ESUN_BRIDGE_TOKEN": "  tok  ",
        })
        self.assertEqual(policy.token, "tok")
        for host in ("a.lan", "A.LAN:1", "x.corp", "home", "pc.home", "192.168.1.10", "localhost"):
            self.assertTrue(policy.host_allowed(host), host)
        for host in ("corp", "b.lan", "evil", "", None):
            self.assertFalse(policy.host_allowed(host), host)
        self.assertTrue(policy.origin_allowed("http://localhost:5173"))
        self.assertTrue(policy.origin_allowed("https://x.example"))
        self.assertFalse(policy.origin_allowed("http://localhost:5174"))
        self.assertFalse(policy.origin_allowed("null"))

    def test_connection_cap_rejects_excess_connections(self):
        server = create_server(host="127.0.0.1", port=0, bridge=self.bridge, access_policy=AccessPolicy(), max_connections=1)
        port = server.server_address[1]
        _serve(server)
        sse = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            sse.request("GET", "/esun/stream/orders", headers={"Host": f"127.0.0.1:{port}"})
            sse_resp = sse.getresponse()
            self.assertEqual(sse_resp.status, 200)
            sse_resp.readline()  # first heartbeat line: the slot is now held by the SSE stream
            status, _, _ = _raw_request(port, "GET", "/esun/livez")
            self.assertEqual(status, 503)
        finally:
            sse.close()
            server.shutdown()
            server.server_close()

    def test_redact_masks_secrets_and_national_ids(self):
        register_secret("MySecretApiValue")
        with mock.patch.dict(os.environ, {"ESUN_ACCOUNT_PASSWORD": "Passw0rd!x"}):
            text = redact("login failed pw=Passw0rd!x secret=MySecretApiValue id=A123456789 acct=88401234567")
        self.assertNotIn("Passw0rd!x", text)
        self.assertNotIn("MySecretApiValue", text)
        self.assertNotIn("A123456789", text)
        self.assertIn("88401234567", text)


class RecordingFactory:
    """sdk_factory that creates a fresh MockSDK per login (like the real SDK) and keeps them."""

    def __init__(self, login_fail_msg: str | None = None, mock_cls: type | None = None):
        self.instances: list[MockSDK] = []
        self.login_fail_msg = login_fail_msg
        self.mock_cls = mock_cls or MockSDK

    def __call__(self, cfg):
        sdk = self.mock_cls(cfg, login_fail_msg=self.login_fail_msg)
        self.instances.append(sdk)
        return sdk

    @property
    def login_calls(self) -> int:
        return sum(s.login_calls for s in self.instances)


def _parse_sse(raw: bytes) -> dict:
    fields: dict[str, str] = {}
    for line in raw.decode("utf-8").splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return {"id": fields.get("id"), "event": fields.get("event"), "data": json.loads(fields["data"]) if "data" in fields else None}


def _drain(q, timeout: float = 0.0) -> list[dict]:
    events = []
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        try:
            raw = q.get(timeout=remaining) if remaining > 0 else q.get_nowait()
        except Exception:
            return events
        if raw is None:
            return events
        events.append(_parse_sse(raw))


def _wait_until(predicate, timeout: float = 3.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class _BridgeCase(unittest.TestCase):
    """Per-test temp config dir + persistent state dir + passwords."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.dir = self.temp_dir.name
        self.state_dir = os.path.join(self.dir, "state")
        self._env = mock.patch.dict(os.environ, {
            "ESUN_ACCOUNT_PASSWORD": "pw-correct-horse",
            "ESUN_CERT_PASSWORD": "cert-pw-battery",
        })
        self._env.start()
        for key in ("ESUN_CONFIG_DIR", "ESUN_SIMULATION_CONFIG_PATH", "ESUN_PRODUCTION_CONFIG_PATH", "ESUN_CONFIG_PATH"):
            os.environ.pop(key, None)
        self.bridges: list[EsunTradeBridge] = []

    def tearDown(self):
        for bridge in self.bridges:
            bridge.shutdown()
        self._env.stop()
        self.temp_dir.cleanup()

    def make_bridge(self, config_path, factory=None, auto_login=True, **kwargs) -> EsunTradeBridge:
        kwargs.setdefault("state_dir", self.state_dir)
        bridge = EsunTradeBridge(config_path=config_path, sdk_factory=factory or RecordingFactory(), auto_login=auto_login, **kwargs)
        self.bridges.append(bridge)
        return bridge

    @staticmethod
    def file_fingerprint(path):
        with open(path, "rb") as f:
            data = f.read()
        return data, os.stat(path).st_mtime_ns


class TestSessionHealthAndSwitch(_BridgeCase):
    def test_health_is_read_only_and_reports_drift(self):
        prod = _write_profile(self.dir, "esun-config.ini", "PRODUCTION", account="88405555555")
        factory = RecordingFactory()
        bridge = self.make_bridge(prod, factory)
        sdk = factory.instances[0]
        before = bridge.get_health()
        self.assertTrue(before["loggedIn"])
        self.assertEqual(before["environment"], "PRODUCTION")
        self.assertEqual(before["sessionGeneration"], 1)
        self.assertFalse(before["configDrift"])
        self.assertEqual(before["diskEnvironment"], "PRODUCTION")
        self.assertFalse(before["loginLocked"])
        self.assertIn("wsLastMessageAt", before)
        self.assertEqual(before["certInfo"], {"ca_expiretime": "2027/12/31"})  # sanitized: no subject/cn
        calls_before = (sdk.certinfo_calls, sdk.machine_time_calls, sdk.market_status_calls)

        # Adding a simulation profile while logged into PRODUCTION used to flip health to SIMULATION.
        _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", account="88401234567")
        for _ in range(3):
            health = bridge.get_health()
        self.assertEqual(health["environment"], "PRODUCTION")
        self.assertFalse(health["simulation"])
        self.assertEqual(health["account"], {"broker_id": "8840", "account_id": "5555555"})
        self.assertTrue(health["configDrift"])
        self.assertEqual(health["sessionGeneration"], 1)
        self.assertEqual(bridge.config_path, prod)
        self.assertEqual(bridge.environment, "PRODUCTION")
        # Health never calls SDK network methods.
        self.assertEqual((sdk.certinfo_calls, sdk.machine_time_calls, sdk.market_status_calls), calls_before)

        # Editing the active file's environment is reported, not adopted.
        os.remove(os.path.join(self.dir, "esun-config.simulation.ini"))
        _write_profile(self.dir, "esun-config.ini", "SIMULATION", account="88405555555")
        health = bridge.get_health()
        self.assertEqual(health["environment"], "PRODUCTION")
        self.assertEqual(health["diskEnvironment"], "SIMULATION")
        self.assertTrue(health["configDrift"])

    def test_switch_never_writes_ini_and_resets_session_state(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", account="88401111111")
        prod = _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION", account="88402222222")
        sim_before, prod_before = self.file_fingerprint(sim), self.file_fingerprint(prod)
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        events = bridge.sse_fanout.register()
        old_sdk = factory.instances[0]
        self.assertTrue(_wait_until(lambda: old_sdk.ws_connect_calls == 1))

        bridge.order_book_cache.update_from_ack({"ord_no": "O_SIM", "stock_no": "2330", "work_date": taipei_today_str()})
        for cache, key in ((bridge.balance_cache, "balance"), (bridge.positions_cache, "positions"),
                           (bridge.settlements_cache, "settlements"), (bridge.trade_status_cache, "trade_status"),
                           (bridge.profit_loss_cache, "x_y"), (bridge.market_status_cache, "market_status")):
            cache.set(key, {"stale": True})

        res, status = bridge.switch_environment_with_status("PRODUCTION")
        self.assertEqual(status, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(res["environment"], "PRODUCTION")
        self.assertEqual(res["account"]["account_id"], "2222222")
        self.assertEqual(res["sessionGeneration"], 2)
        # ini files untouched (byte content and mtime)
        self.assertEqual(self.file_fingerprint(sim), sim_before)
        self.assertEqual(self.file_fingerprint(prod), prod_before)
        # every cache was cleared
        self.assertEqual(bridge.order_book_cache.get_all(), [])
        for cache, key in ((bridge.balance_cache, "balance"), (bridge.positions_cache, "positions"),
                           (bridge.settlements_cache, "settlements"), (bridge.trade_status_cache, "trade_status"),
                           (bridge.profit_loss_cache, "x_y"), (bridge.market_status_cache, "market_status")):
            self.assertIsNone(cache.get(key))
        # the old WebSocket was closed and a new one started for the new SDK client
        new_sdk = factory.instances[1]
        self.assertGreaterEqual(old_sdk.ws_close_calls, 1)
        self.assertTrue(_wait_until(lambda: new_sdk.ws_connect_calls == 1))
        # a session event was broadcast
        session_events = [e for e in _drain(events, timeout=0.5) if e["event"] == "session"]
        self.assertTrue(session_events)
        self.assertEqual(session_events[-1]["data"]["environment"], "PRODUCTION")
        self.assertEqual(session_events[-1]["data"]["generation"], 2)
        self.assertTrue(session_events[-1]["data"]["loggedIn"])
        self.assertEqual(session_events[-1]["data"]["reason"], "switch")

    def test_switch_to_current_environment_is_a_noop(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        res, status = bridge.switch_environment_with_status("SIMULATION")
        self.assertEqual(status, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(factory.login_calls, 1)
        self.assertEqual(bridge.session.generation, 1)

    def test_switch_failure_keeps_original_session(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        original = bridge.session
        bridge.balance_cache.set("balance", {"acc_balance": 1})
        events = bridge.sse_fanout.register()
        factory.login_fail_msg = "error sending request: connection reset"
        res, status = bridge.switch_environment_with_status("PRODUCTION")
        self.assertEqual(status, 502)
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "ESUN_LOGIN_FAILED")
        self.assertEqual(res["environment"], "SIMULATION")
        self.assertIs(bridge.session, original)
        self.assertTrue(bridge.logged_in)
        self.assertIsNotNone(bridge.balance_cache.get("balance"))
        failed = [e for e in _drain(events, timeout=0.3) if e["event"] == "session"]
        self.assertEqual(failed[-1]["data"]["reason"], "switch_failed")
        self.assertFalse(failed[-1]["data"]["ok"])
        self.assertEqual(failed[-1]["data"]["environment"], "SIMULATION")
        # network errors do not trip the credential circuit breaker
        self.assertFalse(bridge.login_locked)

    def test_mismatched_profile_file_is_overridden_in_memory_only(self):
        # A simulation-named profile whose [Core] says PRODUCTION: old code rewrote the file.
        mislabeled = _write_profile(self.dir, "esun-config.simulation.ini", "PRODUCTION")
        prod = _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        before = self.file_fingerprint(mislabeled)
        factory = RecordingFactory()
        bridge = self.make_bridge(prod, factory)
        res, status = bridge.switch_environment_with_status("SIMULATION")
        self.assertEqual(status, 200)
        self.assertEqual(res["environment"], "SIMULATION")
        self.assertTrue(res["configOverridden"])
        self.assertEqual(bridge.entry, ESUN_SIMULATION_ENTRY)
        cfg_given_to_sdk = factory.instances[-1].config
        self.assertEqual(cfg_given_to_sdk.get("Core", "Entry"), ESUN_SIMULATION_ENTRY)
        self.assertEqual(cfg_given_to_sdk.get("Core", "Environment"), "SIMULATION")
        self.assertEqual(self.file_fingerprint(mislabeled), before)
        health = bridge.get_health()
        self.assertEqual(health["environment"], "SIMULATION")
        self.assertFalse(health["configDrift"])  # intentional override is not drift

    def test_switch_obeys_login_guard(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        bridge.reconnect_limiter.timestamps = [time.monotonic()] * 10
        res, status = bridge.switch_environment_with_status("PRODUCTION")
        self.assertEqual(status, 429)
        self.assertEqual(res["code"], "AGR0000")
        self.assertEqual(bridge.environment, "SIMULATION")
        self.assertEqual(factory.login_calls, 1)
        bridge.reconnect_limiter.timestamps = []
        bridge.reconnect_daily.count = 300
        res, status = bridge.switch_environment_with_status("PRODUCTION")
        self.assertEqual((status, res["code"]), (429, "AGR0004"))
        self.assertEqual(factory.login_calls, 1)

    def test_concurrent_switch_is_rejected_while_busy(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        release = threading.Event()

        class SlowLoginSDK(MockSDK):
            def login(self):
                super().login()
                if self.config.get("Core", "Entry") == ESUN_PRODUCTION_ENTRY:
                    release.wait(5)

        factory = RecordingFactory(mock_cls=SlowLoginSDK)
        bridge = self.make_bridge(sim, factory)
        results = []
        worker = threading.Thread(target=lambda: results.append(bridge.switch_environment_with_status("PRODUCTION")))
        worker.start()
        self.assertTrue(_wait_until(lambda: factory.login_calls == 2))
        res, status = bridge.switch_environment_with_status("SIMULATION")
        self.assertEqual((status, res["code"]), (409, "ESUN_SESSION_BUSY"))
        ok, body, code = bridge.reconnect()
        self.assertEqual((ok, code, body["code"]), (False, 409, "ESUN_SESSION_BUSY"))
        release.set()
        worker.join(5)
        self.assertEqual(results[0][1], 200)
        self.assertEqual(bridge.environment, "PRODUCTION")

    def test_accounts_mask_person_id_and_come_from_session(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", account="88407654321")

        class CnSDK(MockSDK):
            def certinfo(self):
                return {"cn": "A123456789-00-00", "not_after": 1893456000, "serial": "01"}

        bridge = self.make_bridge(sim, RecordingFactory(mock_cls=CnSDK))
        accounts = bridge.get_accounts()
        self.assertEqual(accounts[0]["account_id"], "7654321")
        self.assertEqual(accounts[0]["person_id"], "A*******89")
        self.assertTrue(accounts[0]["ca_expiretime"].startswith("2030-01-01"))
        self.assertNotIn("A123456789", json.dumps(bridge.get_health(), ensure_ascii=False))


def taipei_today_str() -> str:
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y%m%d")


class TestPersistentCircuitBreaker(_BridgeCase):
    def _state_file(self):
        return os.path.join(self.state_dir, "esun-login-state.json")

    def test_credential_failure_is_persisted_and_blocks_auto_login_after_restart(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        first = self.make_bridge(sim, RecordingFactory(login_fail_msg="AGA0000 密碼錯誤"))
        self.assertTrue(first.login_locked)
        with open(self._state_file(), encoding="utf-8") as f:
            raw = f.read()
        state = json.loads(raw)
        self.assertTrue(state["credentialLocked"])
        self.assertEqual(state["lockCode"], "AGA0000")
        self.assertNotIn("pw-correct-horse", raw)  # no secret stored, only a salted fingerprint
        self.assertNotIn("cert-pw-battery", raw)
        self.assertEqual(state["loginAttempts"]["count"], 1)

        # "Restart": a new process with the same state dir must not auto-login.
        factory = RecordingFactory()
        second = self.make_bridge(sim, factory)
        self.assertEqual(factory.login_calls, 0)
        self.assertFalse(second.logged_in)
        health = second.get_health()
        self.assertTrue(health["loginLocked"])
        self.assertIn("AGA0000", health["loginLockReason"])
        # The daily login count survives the restart too.
        self.assertEqual(second.reconnect_daily.get_count(), 1)

        # Environment switch is blocked by the breaker like auto-login.
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        res, status = second.switch_environment_with_status("PRODUCTION")
        self.assertEqual((status, res["code"]), (423, "ESUN_LOGIN_LOCKED"))

        # Explicit reconnect with unchanged credentials is refused (would be strike #2) ...
        ok, body, code = second.reconnect()
        self.assertEqual((ok, code, body["code"]), (False, 423, "ESUN_CREDENTIALS_UNCHANGED"))
        self.assertEqual(factory.login_calls, 0)
        # ... unless forced, which logs in and clears the persisted lock.
        ok, body, code = second.reconnect(force=True)
        self.assertEqual((ok, code), (True, 200))
        self.assertFalse(second.login_locked)
        with open(self._state_file(), encoding="utf-8") as f:
            self.assertFalse(json.load(f)["credentialLocked"])

    def test_changed_password_allows_explicit_reconnect(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        self.make_bridge(sim, RecordingFactory(login_fail_msg="AGA0000 密碼錯誤"))
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        self.assertEqual(factory.login_calls, 0)
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw-fixed-now"
        ok, _, code = bridge.reconnect()
        self.assertEqual((ok, code), (True, 200))
        self.assertEqual(factory.login_calls, 1)
        self.assertFalse(bridge.login_locked)

    def test_rate_limit_and_network_errors_do_not_lock(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        for message in ("AGR0000 登入頻率超限", "error sending request for url: operation timed out"):
            bridge = self.make_bridge(sim, RecordingFactory(login_fail_msg=message))
            self.assertFalse(bridge.login_locked, message)
            self.assertFalse(bridge.get_health()["loginLocked"])

    def test_unreadable_state_file_fails_safe(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        os.makedirs(self.state_dir, exist_ok=True)
        with open(self._state_file(), "w", encoding="utf-8") as f:
            f.write("{corrupt")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        self.assertEqual(factory.login_calls, 0)
        self.assertTrue(bridge.login_locked)
        ok, _, code = bridge.reconnect()  # no stored fingerprint: explicit reconnect is allowed
        self.assertEqual((ok, code), (True, 200))


class TestWebSocketSupervisor(_BridgeCase):
    def test_old_generation_events_are_dropped_after_switch(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        _write_profile(self.dir, "esun-config.production.ini", "PRODUCTION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        old_sdk = factory.instances[0]
        old_on_order, old_on_dealt = old_sdk.callbacks["order"], old_sdk.callbacks["dealt"]
        bridge.switch_environment_with_status("PRODUCTION")
        new_sdk = factory.instances[1]
        events = bridge.sse_fanout.register()

        old_on_order({"kind": "ACK", "ord_no": "S0001", "stock_no": "2330", "work_date": taipei_today_str()})
        old_on_dealt({"kind": "MAT", "ord_no": "S0001", "mat_qty": 1, "mkt_seq_num": "1"})
        self.assertEqual(_drain(events, timeout=0.2), [])
        self.assertIsNone(bridge.order_book_cache.get("S0001"))
        self.assertIsNone(bridge.positions_cache.get_stale("positions"))

        new_sdk.callbacks["order"]({"kind": "ACK", "ord_no": "P0001", "stock_no": "2330", "work_date": taipei_today_str()})
        received = _drain(events, timeout=0.5)
        self.assertEqual(len(received), 1)
        self.assertIsNotNone(bridge.order_book_cache.get("P0001"))

    def test_disconnect_triggers_backoff_reconnect_and_resync(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory, auto_login=False)
        bridge.ws_backoff_initial = 0.05
        bridge.ws_resync_open_wait = 0.1
        bridge.attempt_initial_login()
        sdk = factory.instances[0]
        events = bridge.sse_fanout.register()
        self.assertTrue(_wait_until(lambda: sdk.ws_connect_calls == 1))
        orders_calls = sdk.orders_calls
        sdk.close_websocket()  # network drop: run_forever returns
        self.assertTrue(_wait_until(lambda: sdk.ws_connect_calls == 2, timeout=3))
        self.assertTrue(_wait_until(lambda: sdk.orders_calls > orders_calls, timeout=8))
        resync = [e for e in _drain(events, timeout=1.0) if e["event"] == "resync"]
        self.assertTrue(resync)
        self.assertEqual(resync[0]["data"]["reason"], "ws_reconnected")
        self.assertGreaterEqual(bridge.get_health()["wsReconnects"], 1)

    def test_silence_detection_forces_reconnect(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory, auto_login=False)
        bridge.ws_backoff_initial = 0.05
        bridge.ws_silence_seconds = 0.2
        bridge.ws_watchdog_interval = 0.05
        bridge.attempt_initial_login()
        sdk = factory.instances[0]
        self.assertTrue(_wait_until(lambda: sdk.ws_connect_calls >= 2, timeout=5))
        self.assertGreaterEqual(sdk.ws_close_calls, 1)

    def test_shutdown_closes_websocket(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        sdk = factory.instances[0]
        self.assertTrue(_wait_until(lambda: sdk.ws_connect_calls == 1))
        bridge.shutdown()
        self.assertGreaterEqual(sdk.ws_close_calls, 1)
        self.assertTrue(_wait_until(lambda: not sdk.ws_connected))
        time.sleep(0.2)
        self.assertEqual(sdk.ws_connect_calls, 1)  # no reconnect after shutdown


class TestQuerySemanticsAndCaches(_BridgeCase):
    def test_not_logged_in_queries_return_503_instead_of_empty_data(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        bridge = self.make_bridge(sim, RecordingFactory(login_fail_msg="error sending request"))
        with self.assertRaises(EsunQueryError) as ctx:
            bridge.get_orders(refresh=False)
        self.assertEqual(ctx.exception.status, 503)
        for fn in (bridge.get_balance, bridge.get_inventories, bridge.get_settlements, bridge.get_trade_status):
            data, status = fn()
            self.assertEqual(status, 503, fn.__name__)
            self.assertEqual(data["code"], "ESUN_NOT_LOGGED_IN")

    def test_refresh_throttle_and_sdk_failure_are_errors(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        factory = RecordingFactory()
        bridge = self.make_bridge(sim, factory)
        bridge.last_orders_refresh_time = 0.0
        bridge.get_orders(refresh=True)
        with self.assertRaises(EsunQueryError) as ctx:
            bridge.get_orders(refresh=True)  # within 5 s
        self.assertEqual((ctx.exception.status, ctx.exception.code), (429, "AGR0005"))
        self.assertGreater(ctx.exception.retry_after, 0)

        sdk = factory.instances[0]
        sdk.get_order_results = mock.Mock(side_effect=RuntimeError("upstream exploded"))
        bridge.last_orders_refresh_time = 0.0
        with self.assertRaises(EsunQueryError) as ctx:
            bridge.get_orders(refresh=True)
        self.assertEqual(ctx.exception.status, 502)

        # SDK failure with an expired cache must not be served as fresh data.
        bridge.balance_cache.set("balance", {"acc_balance": 1})
        bridge.balance_cache.invalidate()
        sdk.get_balance = mock.Mock(side_effect=RuntimeError("down"))
        data, status = bridge.get_balance()
        self.assertEqual(status, 502)
        self.assertEqual(data["code"], "BALANCE_QUERY_ERROR")

    def test_dirty_positions_are_not_served_when_rate_limited(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")
        bridge = self.make_bridge(sim, RecordingFactory())
        data, status = bridge.get_inventories()
        self.assertEqual(status, 200)
        bridge._handle_mat({"ord_no": "X1", "mat_qty": 1})  # deal arrives: cache dirty
        bridge.positions_limiter.timestamps = [time.monotonic()] * 10
        data, status = bridge.get_inventories()
        self.assertEqual(status, 429)
        self.assertEqual(data["code"], "AGR0003")

    def test_balance_single_flight(self):
        sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION")

        class SlowBalanceSDK(MockSDK):
            def get_balance(self):
                time.sleep(0.2)
                return super().get_balance()

        factory = RecordingFactory(mock_cls=SlowBalanceSDK)
        bridge = self.make_bridge(sim, factory)
        results = []
        threads = [threading.Thread(target=lambda: results.append(bridge.get_balance())) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(factory.instances[0].balance_calls, 1)
        self.assertTrue(all(status == 200 for _, status in results))

    def test_ttl_cache_rejects_stale_generation_and_keeps_dirty(self):
        cache = TTLCache(ttl_seconds=60)
        cache.reset(1)
        token = cache.begin_fill()
        cache.reset(2)  # environment switched while the query was in flight
        self.assertFalse(cache.set("k", "old-session-data", fill_token=token))
        self.assertIsNone(cache.get("k"))
        token = cache.begin_fill()
        cache.mark_dirty()  # MAT arrived while the query was in flight
        cache.set("k", "pre-deal", fill_token=token)
        self.assertIsNone(cache.get("k"))
        cache.set("k", "fresh", fill_token=cache.begin_fill())
        self.assertEqual(cache.get("k")[0], "fresh")

    def test_daily_counter_rolls_over_on_taipei_midnight(self):
        counter = DailyCounter(max_daily_requests=2)
        with mock.patch("server.esun_trade_server.taipei_today", return_value=datetime.date(2026, 10, 24)):
            counter.current_day = datetime.date(2026, 10, 24)
            self.assertTrue(counter.increment())
            self.assertTrue(counter.increment())
            self.assertFalse(counter.increment())  # atomic try-consume
            self.assertEqual(counter.get_count(), 2)
        with mock.patch("server.esun_trade_server.taipei_today", return_value=datetime.date(2026, 10, 25)):
            self.assertTrue(counter.can_increment())
            self.assertEqual(counter.get_count(), 0)

    def test_order_book_cache_snapshot_replaces_and_scopes_generation(self):
        cache = OrderBookCache()
        cache.reset(3)
        today = taipei_today_str()
        cache.update_from_order_results([{"ord_no": "A1", "work_date": today, "org_qty": 2}], generation=3)
        self.assertFalse(cache.update_from_order_results([{"ord_no": "OLD"}], generation=2))
        self.assertIsNone(cache.upsert({"ord_date": "x", "ret_code": "000000"}, generation=3))  # no phantom rows
        cache.update_from_order_results([{"ord_no": "A2", "work_date": today}], generation=3)
        # A1 was created moments ago, so it is kept until the broker snapshot shows it; force it old:
        with cache.lock:
            for meta in cache._meta.values():
                meta["created"] -= 3600
        cache.update_from_order_results([{"ord_no": "A2", "work_date": today}], generation=3)
        self.assertEqual([o["ord_no"] for o in cache.get_all()], ["A2"])

    def test_order_book_cache_evicts_previous_trading_day(self):
        cache = OrderBookCache()
        with mock.patch("server.esun_trade_server.taipei_today", return_value=datetime.date(2026, 10, 23)):
            cache.reset(1)
            cache.update_from_ack({"ord_no": "B0001", "work_date": "20261023"}, generation=1)
            cache.update_from_ack({"ord_no": "R0001", "work_date": "20261024"}, generation=1)  # reservation for tomorrow
        with mock.patch("server.esun_trade_server.taipei_today", return_value=datetime.date(2026, 10, 24)):
            self.assertIsNone(cache.get("B0001"))
            self.assertIsNotNone(cache.get("R0001"))


class TestConfigHardening(_BridgeCase):
    def test_bom_and_sanitized_problems(self):
        path = _write_profile(self.dir, "esun-config.ini", "SIMULATION")
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        with open(path, "w", encoding="utf-8-sig") as f:  # PowerShell 5.1 style BOM
            f.write(content)
        cfg, problems, env = load_config(path)
        self.assertEqual(problems, [])
        self.assertEqual(env, "SIMULATION")

        broken = os.path.join(self.dir, "broken.ini")
        with open(broken, "w", encoding="utf-8") as f:
            f.write("[Core]\nEntry=x\n[Api]\nKey=k\nSecret=s3cr3t-line-1\n  ZZZ-SECRET-CONTINUATION-WITHOUT-EQUALS\n=orphan\n")
        cfg, problems, env = load_config(broken)
        joined = " ".join(problems)
        self.assertIsNone(cfg)
        self.assertIn("行格式錯誤", joined)
        self.assertNotIn("orphan", joined)
        self.assertNotIn("SECRET", joined)

        cfg, problems, _ = load_config(os.path.join(self.dir, "missing", "esun-config.ini"))
        self.assertEqual(problems, ["找不到玉山設定檔：esun-config.ini"])

    def test_placeholder_credentials_block_login(self):
        path = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", key="YOUR_SIMULATION_API_KEY_HERE")
        factory = RecordingFactory()
        bridge = self.make_bridge(path, factory)
        self.assertEqual(factory.login_calls, 0)
        self.assertIn("範本預設值", bridge.login_error)
        self.assertFalse(bridge.login_locked)

    def test_headless_patch_is_verified(self):
        self.assertTrue(apply_headless_keyring_patches())
        self.assertTrue(HEADLESS_PATCH_STATE["ok"])
        with self.assertRaises(RuntimeError):
            esun_trade.util.getpass("Enter esun account password:")


class FakeCore:
    """
    Stand-in for esun_trade._trade_core.CoreSDK (the Rust core). Returns JSON shaped like the
    core's structs (Payload501: 7 fields, PayloadModify: 4 fields, no ord_no) so the REAL
    esun_trade.sdk.SDK code (recover_order_result, cancel_order unit conversion, type checks) runs.
    """

    instances: list["FakeCore"] = []

    def __init__(self, entry, account, cert_path, cert_password, api_key, api_secret):
        self.entry = entry
        self.account = account
        self.calls: list[tuple] = []
        self.order_results: list[dict] = []
        self.order_response: any = None
        self.modify_response: any = None
        FakeCore.instances.append(self)

    @staticmethod
    def _wrap(data):
        if isinstance(data, BaseException):
            raise data
        return json.dumps({"data": data})

    def login(self, account, password):
        self.calls.append(("login", account))

    def get_volume_per_unit(self, stock_no):
        return 1000

    def get_certinfo(self):
        return json.dumps({"serial": "01", "is_valid": True, "not_after": 1893456000, "cn": "A123456789-00"})

    def get_ws_url(self):
        raise RuntimeError("websocket disabled in unit tests")

    def order(self, order_object, user_def):
        fields = ("buy_sell", "price", "stock_no", "quantity", "ap_code", "bs_flag", "price_flag", "trade", "user_def")
        self.calls.append(("order", {k: getattr(order_object, k) for k in fields}))
        default = {"ord_date": "20261024", "ord_time": "093001123", "ord_type": "2", "ord_no": "A0001",
                   "ret_code": "000000", "ret_msg": "", "work_date": "20261024"}
        return self._wrap(self.order_response if self.order_response is not None else default)

    def _modify_default(self):
        return {"ord_date": "20261024", "ord_time": "093501000", "ret_code": "000000", "ret_msg": ""}

    def modify_volume(self, order_result, cel_qty):
        self.calls.append(("modify_volume", dict(order_result), cel_qty))
        return self._wrap(self.modify_response if self.modify_response is not None else self._modify_default())

    def modify_price(self, order_result, new_price, new_price_flag):
        self.calls.append(("modify_price", dict(order_result), new_price, new_price_flag))
        return self._wrap(self.modify_response if self.modify_response is not None else self._modify_default())

    def get_order_results(self):
        return json.dumps({"data": {"order_results": list(self.order_results)}})


class TestMutationContractWithRealSdk(_BridgeCase):
    """§4 mutation contract driven through the real esun_trade.sdk.SDK (fake core)."""

    def setUp(self):
        super().setUp()
        FakeCore.instances = []
        self._core_patch = mock.patch("esun_trade.sdk.CoreSDK", FakeCore)
        self._core_patch.start()
        self.sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", account="88401234567")
        self.bridge = self.make_bridge(self.sim, factory=lambda cfg: esun_trade.sdk.SDK(cfg), websocket_enabled=False)
        self.assertTrue(self.bridge.logged_in)
        self.core = FakeCore.instances[-1]
        self.env = {"expected_environment": "SIMULATION", "expected_account": "1234567"}
        # let the login bootstrap (empty snapshot) settle before tests install their own snapshot
        _wait_until(lambda: self.bridge.orders_refresh_limiter.timestamps != [], timeout=1)
        time.sleep(0.05)

    def tearDown(self):
        self._core_patch.stop()
        super().tearDown()

    def _snapshot(self, *orders):
        self.core.order_results = [dict(o) for o in orders]
        self.bridge.last_orders_refresh_time = 0.0
        return self.bridge.get_orders(refresh=True)

    def _place(self, **overrides):
        payload = {"stockNo": "2330", "buySell": "B", "quantity": 1, "price": 950.0, "apCode": "1",
                   "priceFlag": "0", "bsFlag": "R", "trade": "0"}
        payload.update(overrides)
        return self.bridge.place_order({"payload": payload, **self.env})

    def _core_calls(self, name):
        return [c for c in self.core.calls if c[0] == name]

    def _lot_order(self, **overrides):
        order = {"ord_no": "A0101", "stock_no": "2330", "ap_code": "1", "buy_sell": "B", "bs_flag": "R",
                 "price_flag": "0", "trade": "0", "od_price": 950.0, "org_qty": 5, "mat_qty": 2, "cel_qty": 0,
                 "work_date": taipei_today_str(), "ord_status": "2"}
        order.update(overrides)
        return order

    def test_place_accepted_envelope_and_cache_entry(self):
        res, status = self._place()
        self.assertEqual(status, 200)
        self.assertEqual((res["ok"], res["outcome"]), (True, "accepted"))
        self.assertEqual(res["environment"], "SIMULATION")
        self.assertEqual(res["sessionGeneration"], self.bridge.session.generation)
        self.assertEqual(res["result"]["ord_no"], "A0001")
        sent = self._core_calls("order")[-1][1]
        self.assertEqual((sent["stock_no"], sent["quantity"], sent["price"]), ("2330", 1, 950.0))
        cached = self.bridge.order_book_cache.get("A0001")
        # Payload501 lacks stock/ap_code: the cache entry combines request fields and the response.
        self.assertEqual((cached["stock_no"], cached["ap_code"], cached["org_qty"]), ("2330", "1", 1))
        self.assertEqual(self.bridge.order_mutation_daily.get_count(), 1)

    def test_market_order_sends_price_none(self):
        res, status = self._place(priceFlag="4", price=0)
        self.assertEqual(status, 200, res)
        self.assertIsNone(self._core_calls("order")[-1][1]["price"])  # SDK core rule O00014

    def test_broker_rejection_is_422_rejected(self):
        self.core.order_response = {"ord_date": "", "ord_time": "", "ord_type": "2", "ord_no": "",
                                    "ret_code": "AG0099", "ret_msg": "餘額不足", "work_date": "20261024"}
        res, status = self._place()
        self.assertEqual(status, 422)
        self.assertEqual((res["ok"], res["outcome"], res["code"]), (False, "rejected", "AG0099"))
        self.assertIn("餘額不足", res["error"])
        self.assertEqual(res["result"]["ret_code"], "AG0099")
        self.assertEqual(self.bridge.order_book_cache.get_all(), [])

    def test_exception_during_sdk_call_is_unknown_outcome(self):
        self.core.order_response = RuntimeError("A00004: response error")
        res, status = self._place()
        self.assertEqual(status, 502)
        self.assertEqual((res["ok"], res["outcome"], res["code"]), (False, "unknown", "ESUN_OUTCOME_UNKNOWN"))
        self.core.order_response = TimeoutError("operation timed out")
        res, status = self._place()
        self.assertEqual((status, res["outcome"]), (504, "unknown"))
        self.assertEqual(self.bridge.order_mutation_daily.get_count(), 2)  # both reached the SDK

    def test_sdk_core_local_validation_error_is_not_sent(self):
        self.core.order_response = RuntimeError("SDKError { code: \"O00008\", message: \"quantity must <= 499\" }")
        res, status = self._place()
        self.assertEqual((status, res["outcome"], res["code"]), (400, "not_sent", "ESUN_SDK_VALIDATION"))

    def test_invalid_parameters_are_not_sent_and_not_counted(self):
        cases = [
            dict(apCode="intraday_odd"), dict(apCode=None), dict(buySell="long"), dict(trade="MarginTrading"),
            dict(quantity=0), dict(quantity="1e3"), dict(quantity=True), dict(quantity=500),
            dict(price=0), dict(price="955"), dict(price=float("nan")),
            dict(apCode="2", priceFlag="4"), dict(apCode="4", trade="3", quantity=1000),
            dict(trade="A", buySell="B"), dict(stockNo=""), dict(stockNo="23 30"), dict(bsFlag="GTC"),
        ]
        for overrides in cases:
            res, status = self._place(**overrides)
            self.assertEqual(status, 400, overrides)
            self.assertEqual(res["outcome"], "not_sent", overrides)
        self.assertEqual(self._core_calls("order"), [])
        self.assertEqual(self.bridge.order_mutation_daily.get_count(), 0)

    def test_environment_and_account_checks(self):
        res, status = self.bridge.place_order({"payload": {"stockNo": "2330"}, "expected_environment": "PRODUCTION"})
        self.assertEqual((status, res["code"], res["outcome"]), (409, "ESUN_ENV_MISMATCH", "not_sent"))
        self.assertEqual(res["environment"], "SIMULATION")
        res, status = self.bridge.place_order({"payload": {"stockNo": "2330"}})
        self.assertEqual((status, res["code"]), (409, "ESUN_ENV_MISMATCH"))
        res, status = self.bridge.replace_qty({"order_no": "X", "cancel_quantity": 1, "quantity_unit": "lot",
                                               "expected_environment": "SIMULATION", "expected_account": "7654321"})
        self.assertEqual((status, res["code"]), (409, "ESUN_ACCOUNT_MISMATCH"))
        res, status = self.bridge.cancel_order({"order_no": "X", "expected_environment": "SIMULATION",
                                                "expected_account": "96001234567"})
        self.assertEqual((status, res["code"]), (409, "ESUN_ACCOUNT_MISMATCH"))
        self.assertEqual(self.core.calls[1:], [])  # only the login call
        # Accepted forms: lower-case environment, 11-digit account with the right branch.
        res, status = self.bridge.place_order({
            "payload": {"stockNo": "2330", "buySell": "S", "quantity": 1, "price": 951.0, "apCode": "1"},
            "expectedEnvironment": "simulation", "expectedAccount": "88401234567",
        })
        self.assertEqual(status, 200, res)

    def test_not_logged_in_is_503_not_sent(self):
        bridge = self.make_bridge(self.sim, RecordingFactory(login_fail_msg="error sending request"))
        res, status = bridge.place_order({"payload": {}, **self.env})
        self.assertEqual((status, res["code"], res["outcome"]), (503, "ESUN_NOT_LOGGED_IN", "not_sent"))

    def test_replace_qty_lot_reduce_by_and_remaining_validation(self):
        self._snapshot(self._lot_order())  # remaining = 5 - 2 - 0 = 3 lots
        body = {"order_no": "A0101", "cancel_quantity": 4, "quantity_unit": "lot", **self.env}
        res, status = self.bridge.replace_qty(body)
        self.assertEqual((status, res["code"]), (400, "ESUN_QTY_EXCEEDS_REMAINING"))
        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 1, "quantity_unit": "share"})
        self.assertEqual((status, res["code"]), (400, "ESUN_QTY_UNIT_MISMATCH"))
        res, status = self.bridge.replace_qty({"order_no": "A0101", "quantity": 2, **self.env})
        self.assertEqual((status, res["code"]), (400, "ESUN_QTY_SEMANTICS"))
        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 0})
        self.assertEqual(status, 400)
        self.assertEqual(self._core_calls("modify_volume"), [])

        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 3})
        self.assertEqual((status, res["outcome"]), (200, "accepted"))
        _, order_result, executed = self._core_calls("modify_volume")[-1]
        self.assertEqual(executed, 3)  # SDK cel_qty for a lot order == lots to cancel
        self.assertEqual(order_result["org_qty"], 5)
        self.assertNotIn("ord_no", res["result"])  # PayloadModify has no ord_no ...
        self.assertEqual(len(self.bridge.order_book_cache.get_all()), 1)  # ... and creates no phantom row

        # Once the order was touched, remaining is unknown until the next snapshot: the broker decides.
        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 10})
        self.assertEqual(status, 200)
        self.assertEqual(self._core_calls("modify_volume")[-1][2], 10)

    def test_replace_qty_odd_lot_uses_shares(self):
        odd = self._lot_order(ord_no="B0201", ap_code="5", org_qty=0.05, mat_qty=0.01, cel_qty=0.0,
                              org_qty_share=50, mat_qty_share=10, cel_qty_share=0)
        self._snapshot(odd)  # remaining = 50 - 10 - 0 = 40 shares
        body = {"order_no": "B0201", "cancel_quantity": 41, "quantity_unit": "share", **self.env}
        res, status = self.bridge.replace_qty(body)
        self.assertEqual((status, res["code"]), (400, "ESUN_QTY_EXCEEDS_REMAINING"))
        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 1, "quantity_unit": "lot"})
        self.assertEqual((status, res["code"]), (400, "ESUN_QTY_UNIT_MISMATCH"))
        res, status = self.bridge.replace_qty({**body, "cancel_quantity": 40})
        self.assertEqual(status, 200, res)
        _, order_result, executed = self._core_calls("modify_volume")[-1]
        self.assertEqual(executed, 40)  # cel_qty_share for odd lots == shares
        # recover_order_result turned the fractional lots back into shares for the core
        self.assertEqual((order_result["org_qty"], order_result["mat_qty"]), (50, 10))

    def test_cancel_requires_order_details_then_cancels_all(self):
        body = {"order_no": "C0301", "payload": {"stockNo": "2330"}, **self.env}
        res, status = self.bridge.cancel_order(body)
        self.assertEqual((status, res["code"], res["outcome"]), (409, "ESUN_ORDER_DETAILS_MISSING", "not_sent"))
        res, status = self.bridge.cancel_order({**body, "payload": {"stockNo": "2330", "apCode": "bogus"}})
        self.assertEqual(status, 400)
        self.assertEqual(self._core_calls("modify_volume"), [])
        res, status = self.bridge.cancel_order({**body, "payload": {"stockNo": "2330", "apCode": "1", "buySell": "S"}})
        self.assertEqual(status, 200, res)
        _, order_result, executed = self._core_calls("modify_volume")[-1]
        self.assertEqual(executed, 0)  # modify_volume(order, 0) == cancel all
        self.assertEqual((order_result["ord_no"], order_result["ap_code"], order_result["buy_sell"]), ("C0301", "1", "S"))
        self.assertNotIn("org_qty", order_result)  # payload never supplies quantities

    def test_rejected_cancel_is_422(self):
        self._snapshot(self._lot_order())
        self.core.modify_response = {"ord_date": "", "ord_time": "", "ret_code": "AG0011", "ret_msg": "委託已全部成交"}
        res, status = self.bridge.cancel_order({"order_no": "A0101", **self.env})
        self.assertEqual((status, res["outcome"], res["code"]), (422, "rejected", "AG0011"))

    def test_replace_price_guards(self):
        self._snapshot(self._lot_order(ord_no="D0401"))
        body = {"order_no": "D0401", "price": 955.0, **self.env}
        for bad in ({"price": "955"}, {"price": -1}, {"price_flag": "4"}, {"price": 950.0}):
            res, status = self.bridge.replace_price({**body, **bad})
            self.assertEqual(status, 400, bad)
            self.assertEqual(res["outcome"], "not_sent")
        res, status = self.bridge.replace_price(body)
        self.assertEqual(status, 200, res)
        _, order_result, new_price, new_flag = self._core_calls("modify_price")[-1]
        self.assertEqual((new_price, new_flag, order_result["ord_no"]), (955.0, "0", "D0401"))
        self.assertEqual(self.bridge.order_book_cache.get("D0401")["od_price"], 955.0)
        # limit-up flag: price is not sent
        res, status = self.bridge.replace_price({"order_no": "D0401", "price_flag": "3", **self.env})
        self.assertEqual(status, 200, res)
        self.assertIsNone(self._core_calls("modify_price")[-1][2])

        self._snapshot(self._lot_order(ord_no="E1", bs_flag="I"), self._lot_order(ord_no="E2", ap_code="5"),
                       self._lot_order(ord_no="E3", ord_status="1"))
        for ord_no, code in (("E1", "AG_INVALID_PRICE_MODIFY"), ("E2", "AG_INVALID_PRICE_MODIFY"), ("E3", "AG0006")):
            res, status = self.bridge.replace_price({**body, "order_no": ord_no})
            self.assertEqual((status, res["code"]), (400, code), ord_no)


class TestSseEventLog(unittest.TestCase):
    """§5: <boot_id>-<seq> ids, 500-event replay ring, Last-Event-ID replay, resync, overflow."""

    def test_ids_are_monotonic_and_carry_boot_id(self):
        fanout = SSEFanoutManager()
        ids = [fanout.publish("order", {"n": i}, include_ids=True) for i in range(3)]
        self.assertEqual(ids, [f"{fanout.boot_id}-{i}" for i in (1, 2, 3)])
        self.assertEqual(fanout.last_event_id, f"{fanout.boot_id}-3")
        self.assertNotEqual(SSEFanoutManager().boot_id, fanout.boot_id)

    def test_replay_after_last_event_id(self):
        fanout = SSEFanoutManager()
        first = fanout.publish("order", {"n": 1}, include_ids=True)
        fanout.publish("deal", {"n": 2}, include_ids=True)
        fanout.publish("session", {"n": 3})
        sub, backlog, reason = fanout.subscribe(first)
        self.assertIsNone(reason)
        events = [_parse_sse(raw) for raw in backlog]
        self.assertEqual([e["event"] for e in events], ["deal", "session"])
        self.assertEqual(events[0]["data"]["seq"], 2)
        self.assertEqual(events[0]["id"], f"{fanout.boot_id}-2")
        # the latest id replays nothing
        _, backlog, reason = fanout.subscribe(fanout.last_event_id)
        self.assertEqual((backlog, reason), ([], None))
        # live events after subscription go to the queue, in order
        fanout.publish("order", {"n": 4}, include_ids=True)
        self.assertEqual(_parse_sse(sub.queue.get_nowait())["data"]["seq"], 4)

    def test_resync_when_id_cannot_be_served(self):
        fanout = SSEFanoutManager(ring_size=3)
        for i in range(5):
            fanout.publish("order", {"n": i}, include_ids=True)  # ring keeps seq 3..5
        cases = {
            "other-boot-3": "bridge_restarted",
            f"{fanout.boot_id}-1": "events_evicted",
            f"{fanout.boot_id}-99": "unknown_last_event_id",
            "garbage": "invalid_last_event_id",
        }
        for last_id, expected in cases.items():
            _, backlog, reason = fanout.subscribe(last_id)
            self.assertEqual(reason, expected, last_id)
            self.assertEqual(len(backlog), 1)
            event = _parse_sse(backlog[0])
            self.assertEqual(event["event"], "resync")
            self.assertEqual(event["data"]["reason"], expected)
            self.assertEqual(event["id"], f"{fanout.boot_id}-5")  # position marker: replay from here next time
        _, backlog, reason = fanout.subscribe(f"{fanout.boot_id}-2")  # oldest kept is 3: no gap
        self.assertIsNone(reason)
        self.assertEqual([_parse_sse(r)["data"]["seq"] for r in backlog], [3, 4, 5])

    def test_overflowing_subscriber_is_closed_not_silently_skipped(self):
        fanout = SSEFanoutManager(queue_size=2)
        sub, _, _ = fanout.subscribe(None)
        for i in range(3):
            fanout.publish("order", {"n": i}, include_ids=True)
        self.assertTrue(sub.closed.is_set())
        self.assertEqual(fanout.client_count(), 0)
        # the dropped event is still in the ring for the reconnect
        last_delivered = _parse_sse(sub.queue.queue[-1])["id"]
        _, backlog, reason = fanout.subscribe(last_delivered)
        self.assertIsNone(reason)
        self.assertEqual([_parse_sse(r)["data"]["n"] for r in backlog], [2])

    def test_subscriber_capacity(self):
        fanout = SSEFanoutManager(max_subscribers=1)
        fanout.subscribe(None)
        with self.assertRaises(SSECapacityError):
            fanout.subscribe(None)


class TestReportEvents(_BridgeCase):
    def setUp(self):
        super().setUp()
        self.sim = _write_profile(self.dir, "esun-config.simulation.ini", "SIMULATION", account="88401234567")
        self.bridge = self.make_bridge(self.sim, RecordingFactory())
        self.events = self.bridge.sse_fanout.register()

    def test_op_type_derivation_and_status_normalization(self):
        self.assertEqual(derive_ack_op_type({"before_qty": 0, "after_qty": 2}, None), "New")
        self.assertEqual(derive_ack_op_type({"before_qty": 2, "after_qty": 0}, None), "Cancel")
        self.assertEqual(derive_ack_op_type({"before_qty": 5, "after_qty": 3}, None), "ModifyQty")
        self.assertEqual(derive_ack_op_type({"before_qty": 3, "after_qty": 3, "od_price": 101.0}, {"od_price": 100.0}), "ModifyPrice")
        self.assertEqual(derive_ack_op_type({"before_qty": 3, "after_qty": 3, "od_price": 100.0}, {"od_price": 100.0}), "Unknown")
        self.assertEqual(derive_ack_op_type({"before_qty": 3, "after_qty": 3}, None), "Unknown")
        self.assertEqual(derive_ack_op_type({"org_qty": 3}, None), "Unknown")
        self.assertEqual(normalize_report_status({"err_code": "00000000"}), ("00", ""))
        self.assertEqual(normalize_report_status({"err_code": ""}), ("00", ""))
        self.assertEqual(normalize_report_status({"err_code": "E0123", "err_msg": "價格超過漲跌幅"}), ("E0123", "價格超過漲跌幅"))
        self.assertEqual(normalize_report_status({}), ("", ""))

    def test_ack_event_payload_uses_report_time_and_derived_op(self):
        today = taipei_today_str()
        self.bridge.order_book_cache.update_from_order_results(
            [{"ord_no": "A0001", "stock_no": "2884", "ap_code": "1", "od_price": 26.0, "org_qty": 1, "work_date": today}],
            generation=self.bridge.session.generation,
        )
        self.bridge._handle_ack({
            "kind": "ACK", "work_date": today, "ret_date": "20261024", "ret_time": "103010810", "ord_type": "2",
            "ord_no": "A0001", "pre_ord_no": "", "stock_no": "2884", "buy_sell": "B", "ap_code": "1", "price_flag": "0",
            "trade": "0", "od_price": 26.5, "org_qty": 1, "cel_qty": 0, "cel_type": "1", "err_code": "00000000",
            "err_msg": "", "action": "3", "before_qty": 1, "after_qty": 1, "bs_flag": "R",
        })
        event = _drain(self.events, timeout=0.5)[-1]
        self.assertEqual(event["event"], "order")
        data = event["data"]
        self.assertEqual(data["ts"], "2026-10-24T10:30:10.810+08:00")
        self.assertEqual(data["op_type"], "ModifyPrice")
        self.assertEqual((data["op_code"], data["op_msg"]), ("00", ""))
        self.assertEqual(data["order_no"], "A0001")
        self.assertEqual(data["account"], {"broker_id": "8840", "account_id": "1234567"})
        self.assertEqual(data["environment"], "SIMULATION")
        self.assertEqual(data["action"], "3")  # raw field kept for the client
        self.assertEqual(self.bridge.order_book_cache.get("A0001")["od_price"], 26.5)
        self.assertNotIn("before_qty", self.bridge.order_book_cache.get("A0001"))  # report-only field

    def test_mat_events_are_deduplicated_by_mkt_seq_num(self):
        mat = {"kind": "MAT", "ord_no": "A0002", "stock_no": "2884", "ap_code": "1", "buy_sell": "B",
               "trade": "0", "mat_time": "103512345", "mat_price": 26.0, "mat_qty": 1, "pay_price": 26026.0,
               "mkt_seq_num": "000123"}
        self.bridge.order_book_cache.update_from_ack({"ord_no": "A0002", "stock_no": "2884", "ap_code": "1", "org_qty": 2})
        first = self.bridge._handle_mat(dict(mat))
        second = self.bridge._handle_mat(dict(mat))
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        deals = [e for e in _drain(self.events, timeout=0.5) if e["event"] == "deal"]
        self.assertEqual(len(deals), 1)
        self.assertEqual(deals[0]["data"]["op_type"], "Deal")
        self.assertEqual(deals[0]["data"]["mat_price"], 26.0)
        self.assertTrue(deals[0]["data"]["ts"].endswith("10:35:12.345+08:00"))
        self.assertEqual(self.bridge.order_book_cache.get("A0002")["deal_qty"], 1)

    def test_last_event_id_replay_over_http(self):
        server = create_server(host="127.0.0.1", port=0, bridge=self.bridge, access_policy=AccessPolicy())
        port = server.server_address[1]
        _serve(server)
        try:
            missed_first = self.bridge._handle_ack({"ord_no": "R1", "stock_no": "2330", "ap_code": "1"})
            self.bridge._handle_ack({"ord_no": "R2", "stock_no": "2330", "ap_code": "1"})

            def read_events(headers, path="/esun/stream/orders", count=1):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                try:
                    conn.request("GET", path, headers={"Host": f"127.0.0.1:{port}", **headers})
                    resp = conn.getresponse()
                    self.assertEqual(resp.status, 200)
                    events, block = [], b""
                    while len(events) < count + 1:  # +1: the initial heartbeat
                        line = resp.readline()
                        block += line
                        if line in (b"\n", b"\r\n"):
                            events.append(_parse_sse(block))
                            block = b""
                    return events
                finally:
                    conn.close()

            events = read_events({"Last-Event-ID": missed_first})
            self.assertEqual(events[0]["event"], "heartbeat")
            self.assertEqual(events[1]["data"]["order_no"], "R2")
            events = read_events({}, path=f"/esun/stream/orders?last_event_id={missed_first}")
            self.assertEqual(events[1]["data"]["order_no"], "R2")
            events = read_events({"Last-Event-ID": "previous-boot-41"})
            self.assertEqual(events[1]["event"], "resync")
            self.assertEqual(events[1]["data"]["reason"], "bridge_restarted")
        finally:
            server.shutdown()
            server.server_close()


class TestGracefulShutdown(unittest.TestCase):
    def test_shutdown_handler_stops_serve_forever_and_bridge(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = _write_profile(tmp, "esun-config.simulation.ini", "SIMULATION")
            with mock.patch.dict(os.environ, {"ESUN_ACCOUNT_PASSWORD": "pw", "ESUN_CERT_PASSWORD": "cpw"}):
                bridge = EsunTradeBridge(config_path=sim, sdk_factory=lambda cfg: MockSDK(cfg), auto_login=True)
            server = create_server(host="127.0.0.1", port=0, bridge=bridge, access_policy=AccessPolicy())
            thread = _serve(server)
            handler = make_shutdown_handler(server, bridge)
            handler(15, None)
            handler(15, None)  # idempotent
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive(), "serve_forever must return after SIGTERM")
            self.assertTrue(bridge.is_shutting_down())
            server.server_close()


if __name__ == "__main__":
    unittest.main()
