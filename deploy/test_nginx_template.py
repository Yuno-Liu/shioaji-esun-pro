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


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read().replace("\r\n", "\n")


def location_block(prefix: str, modifier: str = "^~") -> str:
    """`location <modifier> <prefix> { ... }` 的內容（以大括號配對取出，忽略註解中的大括號）。"""
    text = _read(TEMPLATE)
    m = re.search(r"location " + re.escape(modifier) + " " + re.escape(prefix) + r" \{", text)
    assert m, prefix
    depth, i = 1, m.end()
    body_start = i
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


def directives(block: str) -> list[str]:
    """去掉註解與空白後的指令（每行一個，結尾分號保留）。"""
    out = []
    for line in block.split("\n"):
        line = line.split("#", 1)[0].strip()
        if line:
            out.append(re.sub(r"\s+", " ", line))
    return out


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


if __name__ == "__main__":
    unittest.main()
