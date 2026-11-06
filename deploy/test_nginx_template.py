"""deploy/nginx.conf.template 的靜態檢查（fork 專屬）。

以非本機主機名（區網、Tailscale／Caddy 的 HTTPS 名稱）開啟時：
- /api/：nginx 先檢查 Origin 與 Host 相同、Sec-Fetch-Site，通過後轉給永豐 sidecar 時必須改用本機 Host 並移除 Origin，
  否則 sidecar 回 403（"Host is not a loopback address"／"cross-origin request to the local server"）。
- /esun/：玉山 bridge 自己比對 Host 白名單與 Origin，必須保留原始 Host（含 port）與 Origin。
"""

from __future__ import annotations

import os
import re
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(REPO_ROOT, "deploy", "nginx.conf.template")
SECURITY_HEADERS = os.path.join(REPO_ROOT, "deploy", "nginx-security-headers.conf")
PUBLIC_DIR = os.path.join(REPO_ROOT, "public")
SECURITY_INCLUDE = "include /etc/nginx/snippets/security-headers.conf;"


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read().replace("\r\n", "\n")


def _block_body(text: str, body_start: int) -> str:
    """從 `{` 之後取到配對的 `}`（忽略註解中的大括號）。"""
    depth, i = 1, body_start
    while depth:
        ch = text[i]
        if ch == "#":
            i = text.index("\n", i)
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    return text[body_start:i - 1]


def location_block(prefix: str, modifier: str = "^~") -> str:
    """`location <modifier> <prefix> { ... }` 的內容（以大括號配對取出，忽略註解中的大括號）。"""
    text = _read(TEMPLATE)
    m = re.search(r"location " + re.escape(modifier) + " " + re.escape(prefix) + r" \{", text)
    assert m, prefix
    return _block_body(text, m.end())


# location 參數可能是含大括號的帶引號 regex（例如長快取的 {8}），所以引號內整段略過
_LOCATION_RE = re.compile(r'^\s*location\s+((?:"[^"]*"|[^{"\n])+?)\s*\{', re.M)


def all_locations() -> list[tuple[str, str]]:
    """模板內所有 location：(參數, 內容)。"""
    text = _read(TEMPLATE)
    return [(m.group(1), _block_body(text, m.end())) for m in _LOCATION_RE.finditer(text)]


def long_cache_regex() -> re.Pattern[str]:
    """帶雜湊資產長快取的 location regex（`location ~* "..."`，不分大小寫）。"""
    found = [arg for arg, _ in all_locations() if arg.startswith("~* ")]
    assert len(found) == 1, found
    pattern = found[0][len("~* "):].strip()
    assert pattern.startswith('"') and pattern.endswith('"'), pattern
    return re.compile(pattern[1:-1], re.I)


def map_block(source: str, target: str) -> str:
    text = _read(TEMPLATE)
    m = re.search(r"^map " + re.escape(source) + r" " + re.escape(target) + r" \{", text, re.M)
    assert m, target
    return _block_body(text, m.end())


def directives(block: str) -> list[str]:
    """去掉註解與空白後的指令（每行一個，結尾分號保留）。"""
    out = []
    for line in block.split("\n"):
        line = line.split("#", 1)[0].strip()
        if line:
            out.append(re.sub(r"\s+", " ", line))
    return out


def map_value(lines: list[str], value: str) -> str:
    """依 nginx map 規則求值：完全相符優先，其次依序第一個相符的 regex（~ 分大小寫、~* 不分），最後 default。"""
    default, exact, regex_hit = None, None, None
    for line in lines:
        key, val = line.rstrip(";").split(" ", 1)
        key, val = key.strip('"'), val.strip().strip('"')
        if key == "default":
            default = val
        elif key.startswith("~"):
            flags, pattern = (re.I, key[2:]) if key.startswith("~*") else (0, key[1:])
            if regex_hit is None and re.search(pattern, value, flags):
                regex_hit = val
        elif key == value:
            exact = val
    for candidate in (exact, regex_hit, default):
        if candidate is not None:
            return candidate
    raise AssertionError("map 沒有 default")


class ApiLocationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.lines = directives(location_block("/api/"))

    def test_same_origin_checks_run_before_proxying(self) -> None:
        text = "\n".join(self.lines)
        proxy_at = text.index("proxy_pass ")
        self.assertLess(text.index("if ($shioaji_pro_cross_origin) {"), proxy_at)
        self.assertLess(text.index("if ($shioaji_pro_cross_site) {"), proxy_at)
        self.assertEqual(text.count("return 403;"), 2)

    def test_sidecar_gets_loopback_host_and_no_origin(self) -> None:
        self.assertIn("proxy_set_header Host 127.0.0.1;", self.lines)
        self.assertIn('proxy_set_header Origin "";', self.lines)
        self.assertNotIn("proxy_set_header Host $host;", self.lines)
        self.assertNotIn("proxy_set_header Host $http_host;", self.lines)


class EsunLocationTest(unittest.TestCase):
    def test_bridge_keeps_original_host_and_origin(self) -> None:
        lines = directives(location_block("/esun/"))
        self.assertIn("proxy_set_header Host $http_host;", lines)
        self.assertFalse([ln for ln in lines if ln.startswith("proxy_set_header Origin")])


class HostAllowlistTest(unittest.TestCase):
    def test_unknown_hosts_are_dropped_and_origin_must_match_host(self) -> None:
        text = _read(TEMPLATE)
        self.assertRegex(text, r"listen \$\{PORT\} default_server;\s*\n\s*server_name _;\s*\n\s*server_tokens off;\s*\n\s*return 444;")
        self.assertIn("server_name localhost 127.0.0.1 ${WEB_SERVER_NAMES};", text)
        self.assertIn('"~*^https?://([^/|]+)\\|\\1$" 0;', text)


class MobileManifestLocationTest(unittest.TestCase):
    """手機版 PWA manifest：明確的 MIME、不快取，且仍有安全標頭與 Basic Auth。"""

    def setUp(self) -> None:
        self.lines = directives(location_block("/mobile.webmanifest", "="))

    def test_served_as_manifest_json(self) -> None:
        self.assertIn("types { }", self.lines)
        self.assertIn("default_type application/manifest+json;", self.lines)
        self.assertIn("try_files $uri =404;", self.lines)

    def test_keeps_security_headers_and_no_cache(self) -> None:
        # location 內有 add_header 就不繼承 server 層級的安全標頭，必須再 include
        self.assertIn('add_header Cache-Control "no-cache" always;', self.lines)
        self.assertIn("include /etc/nginx/snippets/security-headers.conf;", self.lines)

    def test_does_not_bypass_basic_auth_or_proxy(self) -> None:
        self.assertFalse([ln for ln in self.lines if ln.startswith("auth_basic")])
        self.assertFalse([ln for ln in self.lines if ln.startswith("proxy_pass")])


class ProxyCredentialStrippingTest(unittest.TestCase):
    """稽核 F4：Basic Auth 帳密（Authorization）與 cookie 不轉給永豐 sidecar／玉山 bridge。"""

    def test_api_and_esun_strip_authorization_and_cookie(self) -> None:
        for prefix in ("/api/", "/esun/"):
            with self.subTest(prefix=prefix):
                lines = directives(location_block(prefix))
                self.assertIn('proxy_set_header Authorization "";', lines)
                self.assertIn('proxy_set_header Cookie "";', lines)
                # 只能清空，不可改成轉送任何值
                self.assertEqual(len([ln for ln in lines if ln.startswith("proxy_set_header Authorization")]), 1)
                self.assertEqual(len([ln for ln in lines if ln.startswith("proxy_set_header Cookie")]), 1)


class SecurityHeadersSnippetTest(unittest.TestCase):
    """稽核 F3：共用安全標頭。"""

    def setUp(self) -> None:
        self.lines = directives(_read(SECURITY_HEADERS))

    def test_keeps_existing_headers(self) -> None:
        for line in (
            'add_header X-Frame-Options "DENY" always;',
            "add_header Content-Security-Policy \"frame-ancestors 'none'\" always;",
            'add_header X-Content-Type-Options "nosniff" always;',
            'add_header Referrer-Policy "same-origin" always;',
        ):
            self.assertIn(line, self.lines)

    def test_permissions_policy_without_screen_wake_lock(self) -> None:
        self.assertIn(
            'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;',
            self.lines,
        )
        # 手機版螢幕常亮（wake-lock.ts）要用，不可被停用
        self.assertNotIn("screen-wake-lock", "\n".join(self.lines))

    def test_hsts_comes_from_host_map(self) -> None:
        self.assertIn("add_header Strict-Transport-Security $shioaji_pro_hsts always;", self.lines)


class HstsMapTest(unittest.TestCase):
    """HSTS 只給 *.ts.net；其他主機為空字串（nginx 不送出空值的 add_header）。"""

    def setUp(self) -> None:
        self.lines = directives(map_block("$host", "$shioaji_pro_hsts"))

    def _value_for(self, host: str) -> str:
        """依 nginx map 規則求值：完全相符優先，其次依序第一個相符的 regex，最後 default。"""
        default, exact, regex_hit = None, None, None
        for line in self.lines:
            key, val = line.rstrip(";").split(" ", 1)
            key, val = key.strip('"'), val.strip().strip('"')
            if key == "default":
                default = val
            elif key.startswith("~"):
                flags, pattern = (re.I, key[2:]) if key.startswith("~*") else (0, key[1:])
                if regex_hit is None and re.search(pattern, host, flags):
                    regex_hit = val
            elif key == host:
                exact = val
        for candidate in (exact, regex_hit, default):
            if candidate is not None:
                return candidate
        raise AssertionError("map 沒有 default")

    def test_only_ts_net_hosts_get_hsts_without_subdomains_or_preload(self) -> None:
        self.assertIn('default "";', self.lines)
        for host in ("phone.tail1234.ts.net", "PHONE.TAIL1234.TS.NET"):
            self.assertEqual(self._value_for(host), "max-age=31536000", host)
        for host in ("localhost", "127.0.0.1", "trade.lan", "192.168.1.20", "ts.net.evil.example", "evilts.net", "ts.net"):
            self.assertEqual(self._value_for(host), "", host)
        text = "\n".join(self.lines)
        self.assertNotIn("includeSubDomains", text)
        self.assertNotIn("preload", text)


class MobileHtmlLocationTest(unittest.TestCase):
    """手機交易頁：no-cache、COOP same-origin，且保留安全標頭與 Basic Auth。"""

    def setUp(self) -> None:
        self.lines = directives(location_block("/mobile.html", "="))

    def test_headers(self) -> None:
        self.assertIn('add_header Cache-Control "no-cache" always;', self.lines)
        self.assertIn('add_header Cross-Origin-Opener-Policy "same-origin" always;', self.lines)
        self.assertIn(SECURITY_INCLUDE, self.lines)
        self.assertIn("try_files /mobile.html =404;", self.lines)

    def test_does_not_bypass_basic_auth_or_proxy(self) -> None:
        self.assertFalse([ln for ln in self.lines if ln.startswith("auth_basic")])
        self.assertFalse([ln for ln in self.lines if ln.startswith("proxy_pass")])


class ApiNoStoreTest(unittest.TestCase):
    def test_api_responses_are_no_store_and_keep_security_headers(self) -> None:
        lines = directives(location_block("/api/"))
        self.assertIn('add_header Cache-Control "no-store" always;', lines)
        self.assertIn(SECURITY_INCLUDE, lines)


class MethodAndBodyLimitsTest(unittest.TestCase):
    """稽核 F8：方法白名單與 body 上限；/api/ 的寫入請求只接受 JSON（sidecar 自己的跨來源檢查因 Host 改寫失效）。"""

    def test_api_allows_only_frontend_methods_and_json_writes(self) -> None:
        lines = directives(location_block("/api/"))
        text = "\n".join(lines)
        self.assertIn("limit_except GET POST PUT DELETE {", lines)
        self.assertIn("deny all;", lines)
        self.assertIn("client_max_body_size 256k;", lines)
        self.assertIn("return 415;", lines)
        self.assertLess(text.index("if ($shioaji_pro_api_bad_type) {"), text.index("proxy_pass "))

    def test_esun_allows_only_get_post_with_bridge_body_limit(self) -> None:
        lines = directives(location_block("/esun/"))
        self.assertIn("limit_except GET POST {", lines)
        self.assertIn("deny all;", lines)
        # 與 bridge 自己的 64 KiB 上限相同
        self.assertIn("client_max_body_size 64k;", lines)

    def test_api_content_type_map(self) -> None:
        lines = directives(map_block('"$request_method:$content_type"', "$shioaji_pro_api_bad_type"))
        self.assertIn("default 1;", lines)
        allowed = (
            "GET:", "HEAD:", "GET:text/plain",
            "POST:application/json", "POST:application/json; charset=utf-8", "POST:Application/JSON",
            "PUT:application/json", "DELETE:", "DELETE:application/json",
        )
        rejected = (
            "POST:", "PUT:", "POST:text/plain", "POST:text/plain;charset=UTF-8",
            "POST:application/x-www-form-urlencoded", "POST:multipart/form-data; boundary=x",
            "POST:application/jsonp", "POST:application/json-patch+json", "PUT:text/plain", "DELETE:text/plain",
            "PATCH:application/json", "OPTIONS:", "TRACE:",
        )
        for value in allowed:
            self.assertEqual(map_value(lines, value), "0", value)
        for value in rejected:
            self.assertEqual(map_value(lines, value), "1", value)


class EveryLocationKeepsSecurityHeadersTest(unittest.TestCase):
    """nginx 的 add_header 不繼承外層：凡有 add_header 的 location 都必須再 include 安全標頭。"""

    def test_server_level_include(self) -> None:
        text = _read(TEMPLATE)
        server = text[text.index("server_name localhost 127.0.0.1"):]
        first_location = server.index("location ")
        self.assertIn(SECURITY_INCLUDE, directives(server[:first_location]))

    def test_locations_with_add_header_reinclude_snippet(self) -> None:
        locations = all_locations()
        self.assertGreaterEqual(len(locations), 10)
        for arg, body in locations:
            lines = directives(body)
            if any(ln.startswith("add_header ") for ln in lines):
                with self.subTest(location=arg):
                    self.assertIn(SECURITY_INCLUDE, lines)


# 帶雜湊的建置檔名（rolldown：名稱-8 碼雜湊；同名同雜湊時第 9 碼補數字）與 public/ 無雜湊檔
HASHED_NAMES = (
    "main-D_2YXx_3.js", "mobile-Bz0ku85Z.js", "vendor-DjDK5o4-.js", "vendor-CjBHE94L2.js",
    "vendor-CJsXggX52.js", "index-AbCdEf_-.css", "font-Ab12Cd34.woff2",
)
UNHASHED_NAMES = (
    "apple-touch-icon.png", "shioaji-mark-small.svg", "favicon.svg", "favicon.ico",
    "index.html", "mobile.html", "approval.html", "mobile.webmanifest",
)


class LongCacheRegexTest(unittest.TestCase):
    """稽核 P9：長快取 regex 要涵蓋 9 碼雜湊檔，但不可誤判無雜湊檔。"""

    def setUp(self) -> None:
        self.regex = long_cache_regex()

    def test_hashed_names_match(self) -> None:
        for name in HASHED_NAMES:
            self.assertRegex("/" + name, self.regex, name)

    def test_unhashed_names_do_not_match(self) -> None:
        for name in UNHASHED_NAMES:
            self.assertNotRegex("/" + name, self.regex, name)

    def test_public_files_do_not_match(self) -> None:
        if not os.path.isdir(PUBLIC_DIR):
            self.skipTest("沒有 public/")
        for name in os.listdir(PUBLIC_DIR):
            self.assertNotRegex("/" + name, self.regex, name)


def _dist_dir() -> str:
    return os.environ.get("SHIOAJI_WEB_DIST") or os.path.join(REPO_ROOT, "dist")


_ASSET_REF_RE = re.compile(r'(?:src|href)="/?([^"?#:]+\.(?:js|mjs|css))"')


class BuildOutputLongCacheTest(unittest.TestCase):
    """以實際建置輸出驗證長快取 regex（vite.fork.config.ts：mobile、index、approval）。

    先建置，再以 SHIOAJI_WEB_DIST 指定輸出目錄（預設 <repo>/dist）；沒有建置輸出時略過。
    """

    def setUp(self) -> None:
        self.dist = _dist_dir()
        pages = [os.path.join(self.dist, p) for p in ("index.html", "mobile.html", "approval.html")]
        missing = [p for p in pages if not os.path.isfile(p)]
        if missing:
            self.skipTest(f"沒有完整建置輸出：{missing}")
        self.pages = pages
        self.regex = long_cache_regex()

    def _files(self) -> list[str]:
        out = []
        for root, _, names in os.walk(self.dist):
            for name in names:
                out.append(os.path.relpath(os.path.join(root, name), self.dist).replace(os.sep, "/"))
        return out

    def test_every_js_and_css_is_long_cached(self) -> None:
        assets = [f for f in self._files() if f.endswith((".js", ".mjs", ".css"))]
        self.assertTrue(assets)
        for rel in assets:
            self.assertRegex("/" + rel, self.regex, rel)

    def test_html_entry_assets_exist_and_are_long_cached(self) -> None:
        for page in self.pages:
            refs = _ASSET_REF_RE.findall(_read(page))
            with self.subTest(page=os.path.basename(page)):
                self.assertTrue(refs)
                for rel in refs:
                    self.assertTrue(os.path.isfile(os.path.join(self.dist, rel)), rel)
                    self.assertRegex("/" + rel, self.regex, rel)

    def test_unhashed_outputs_are_not_long_cached(self) -> None:
        public = set(os.listdir(PUBLIC_DIR)) if os.path.isdir(PUBLIC_DIR) else set()
        for rel in self._files():
            name = os.path.basename(rel)
            if name in public or name.endswith((".html", ".webmanifest")):
                self.assertNotRegex("/" + rel, self.regex, rel)


if __name__ == "__main__":
    unittest.main()
