"""手機首屏 JS 體積預算檢查（fork 專屬；docs/fork/mobile-trading-spec.md §9.4）。

加總建置輸出 mobile.html 引用的 <script src> 與 <link rel="modulepreload"> 的 gzip（level 9）大小，
超過門檻時以非 0 結束。門檻預設 228352 bytes（≤223 KiB，2026-11-11 決議），可用 --limit 覆寫。

用法：
    python scripts/check_mobile_budget.py <dist 目錄> [--limit BYTES]
"""

from __future__ import annotations

import argparse
import gzip
import os
import re
import sys
from html.parser import HTMLParser

DEFAULT_LIMIT = 228352  # 223 KiB


class _EntryRefs(HTMLParser):
    """收集 <script src> 與 <link rel="modulepreload" href>（依出現順序、去重）。"""

    def __init__(self) -> None:
        super().__init__()
        self.refs: list[str] = []

    def _add(self, url: str | None) -> None:
        if url and url not in self.refs:
            self.refs.append(url)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "script":
            self._add(a.get("src"))
        elif tag == "link" and "modulepreload" in (a.get("rel") or "").lower().split():
            self._add(a.get("href"))


def entry_refs(html: str) -> list[str]:
    parser = _EntryRefs()
    parser.feed(html)
    return parser.refs


def resolve(dist: str, url: str) -> str:
    if re.match(r"^[a-z][a-z0-9+.-]*:|^//", url, re.I):
        raise ValueError(f"mobile.html 引用外部資源：{url}")
    path = url.split("?", 1)[0].split("#", 1)[0].lstrip("/")
    return os.path.join(dist, *path.split("/"))


def gzip_size(path: str) -> int:
    with open(path, "rb") as fh:
        return len(gzip.compress(fh.read(), compresslevel=9, mtime=0))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("dist", help="建置輸出目錄（含 mobile.html）")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help=f"門檻 bytes（預設 {DEFAULT_LIMIT}）")
    args = ap.parse_args(argv)

    html_path = os.path.join(args.dist, "mobile.html")
    if not os.path.isfile(html_path):
        print(f"找不到 {html_path}", file=sys.stderr)
        return 2
    with open(html_path, encoding="utf-8") as fh:
        refs = entry_refs(fh.read())
    if not refs:
        print("mobile.html 沒有引用任何 script／modulepreload", file=sys.stderr)
        return 2

    total = 0
    for url in refs:
        path = resolve(args.dist, url)
        if not os.path.isfile(path):
            print(f"mobile.html 引用的檔案不存在：{url}", file=sys.stderr)
            return 2
        size = gzip_size(path)
        total += size
        print(f"{size:>9,}  {url}")

    ok = total <= args.limit
    print(f"{total:>9,}  合計（{len(refs)} 個 JS，gzip -9）；門檻 {args.limit:,}"
          f"（{args.limit / 1024:.1f} KiB），{'剩' if ok else '超出'} {abs(args.limit - total):,} bytes")
    if not ok:
        print("手機首屏 JS 超出預算", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
