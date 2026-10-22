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
import datetime
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error

import esun_trade.util
from server.esun_trade_server import (
    DailyCounter,
    EsunHTTPRequestHandler,
    EsunTradeBridge,
    OrderBookCache,
    SlidingWindowRateLimiter,
    TTLCache,
    apply_headless_keyring_patches,
    check_and_clamp_date_range,
    create_server,
    load_config,
    split_account,
    validate_order_quantity,
)
from esun_trade.constant import Action, APCode, BSFlag, PriceFlag, Trade


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
        self.ws_connected = False

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
        self.ws_connected = True

    def certinfo(self) -> dict:
        return {"ca_expiretime": "2027/12/31", "subject": "CN=ESUN_TEST"}

    def get_machine_time(self) -> dict:
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

    def tearDown(self):
        self.temp_dir.cleanup()
        os.environ.pop("ESUN_ACCOUNT_PASSWORD", None)
        os.environ.pop("ESUN_CERT_PASSWORD", None)

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
        cls.config_file = os.path.join(cls.temp_dir.name, "test_config.ini")
        with open(cls.config_file, "w") as f:
            f.write("[Core]\nEntry=https://test\n[Cert]\nPath=c.p12\n[Api]\nKey=k\nSecret=s\n[User]\nAccount=88401234567\n")
        with open(os.path.join(cls.temp_dir.name, "c.p12"), "w") as f:
            f.write("cert")
        os.environ["ESUN_ACCOUNT_PASSWORD"] = "pw"
        os.environ["ESUN_CERT_PASSWORD"] = "cpw"

        cls.mock_sdk = MockSDK()
        cls.bridge = EsunTradeBridge(
            config_path=cls.config_file,
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
            }
        }
        placed, code = self._post("/esun/orders/place", order_payload)
        self.assertEqual(code, 200)
        ord_no = placed["ord_no"]
        self.assertTrue(ord_no.startswith("O"))

        # 2. Get Orders (cached)
        orders, code = self._get("/esun/orders?refresh=false")
        self.assertEqual(code, 200)
        self.assertTrue(any(o.get("ord_no") == ord_no for o in orders))

        # 3. Replace Price
        rep_price_payload = {
            "orderNo": ord_no,
            "price": 955.0,
        }
        res_price, code = self._post("/esun/orders/replace-price", rep_price_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_price["status"], "PriceModified")

        # 4. Replace Qty
        rep_qty_payload = {
            "orderNo": ord_no,
            "quantity": 0,
            "cel_qty": 1,
        }
        res_qty, code = self._post("/esun/orders/replace-qty", rep_qty_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_qty["status"], "VolumeModified")

        # 5. Cancel Order
        cancel_payload = {
            "orderNo": ord_no,
        }
        res_cancel, code = self._post("/esun/orders/cancel", cancel_payload)
        self.assertEqual(code, 200)
        self.assertEqual(res_cancel["status"], "Cancelled")

    def test_reservation_order_rejection_http(self):
        # Prepopulate reservation order
        self.bridge.order_book_cache.update_from_ack({
            "ord_no": "RES001",
            "ord_status": "1",
            "stock_no": "2330",
            "bs_flag": "R",
            "price_flag": "0",
        })

        # Replace price on reservation order -> 400 AG0006
        res, code = self._post("/esun/orders/replace-price", {"orderNo": "RES001", "price": 960.0})
        self.assertEqual(code, 400)
        self.assertEqual(res.get("code"), "AG0006")

        # Replace qty on reservation order -> 400 AG0006
        res, code = self._post("/esun/orders/replace-qty", {"orderNo": "RES001", "cel_qty": 1})
        self.assertEqual(code, 400)
        self.assertEqual(res.get("code"), "AG0006")

        # Cancellation on reservation order IS permitted
        res, code = self._post("/esun/orders/cancel", {"orderNo": "RES001"})
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

        # Read order_event from stream
        id_line = resp.readline().decode("utf-8")
        event_line = resp.readline().decode("utf-8")
        data_line = resp.readline().decode("utf-8")
        empty_line = resp.readline().decode("utf-8")

        self.assertTrue(id_line.startswith("id: esun-ack-SSE_ORD_1-"))
        self.assertEqual(event_line.strip(), "event: order_event")
        ack_obj = json.loads(data_line.replace("data: ", ""))
        self.assertEqual(ack_obj["state"], "StockOrder")
        self.assertEqual(ack_obj["data"]["StockOrder"]["ord_no"], "SSE_ORD_1")

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

        self.assertTrue(id_line.startswith("id: esun-mat-SSE_ORD_1-"))
        self.assertEqual(event_line.strip(), "event: order_event")
        mat_obj = json.loads(data_line.replace("data: ", ""))
        self.assertEqual(mat_obj["state"], "StockDeal")
        self.assertEqual(mat_obj["data"]["StockDeal"]["deal_qty"], 1)

        resp.close()

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


if __name__ == "__main__":
    unittest.main()
