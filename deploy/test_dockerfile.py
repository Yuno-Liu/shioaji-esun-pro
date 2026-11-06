"""Dockerfile 建置階段的輸入檢查（fork 專屬）。

web 映像在 builder 階段執行 `pnpm exec tsc -b && pnpm exec vite build --config vite.fork.config.ts`，
但只複製列舉的檔案與目錄。上游在 tsconfig 或 vite.config.ts 新增建置期依賴（例如 2026-11 的
scripts/dev-etf-proxy.ts）時，若 Dockerfile 沒跟上，映像會在 tsc 階段失敗，而本機與上游 CI 都看不出來。
"""

from __future__ import annotations

import json
import os
import re
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(name: str) -> str:
    with open(os.path.join(REPO_ROOT, name), encoding="utf-8") as fh:
        return fh.read().replace("\r\n", "\n")


def builder_copy_sources() -> list[str]:
    """builder 階段（第一個 FROM 到下一個 FROM 之間）COPY 的來源路徑（不含 --from 的跨階段複製）。"""
    text = _read("Dockerfile")
    stages = re.split(r"^FROM\s", text, flags=re.M)
    builder = stages[1]
    sources: list[str] = []
    for line in builder.split("\n"):
        line = line.split("#", 1)[0].strip()
        if not line.startswith("COPY ") or "--from=" in line:
            continue
        parts = [p for p in line[len("COPY "):].split() if not p.startswith("--")]
        sources.extend(p.rstrip("/") for p in parts[:-1])
    return sources


def covered(path: str, sources: list[str]) -> bool:
    path = path.rstrip("/")
    return any(path == src or path.startswith(src + "/") for src in sources)


def tsconfig_includes(name: str) -> list[str]:
    raw = _read(name)
    # tsconfig 允許註解；本專案的 tsconfig 只有整行 // 註解
    raw = "\n".join(line for line in raw.split("\n") if not line.strip().startswith("//"))
    return list(json.loads(raw).get("include", []))


class BuilderCopiesBuildInputsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sources = builder_copy_sources()

    def test_tsconfig_includes_are_copied(self) -> None:
        for name in ("tsconfig.node.json", "tsconfig.app.json"):
            for include in tsconfig_includes(name):
                # modules 是桌面閉源層的掛載點（tsconfig.app.json），web 映像以 stub 建置，不在 repo 內
                if include == "modules":
                    continue
                with self.subTest(tsconfig=name, include=include):
                    self.assertTrue(covered(include, self.sources), f"{include} 不在 Dockerfile builder 階段的 COPY 內")

    def test_vite_config_local_imports_are_copied(self) -> None:
        for config in ("vite.config.ts", "vite.fork.config.ts"):
            for spec in re.findall(r"""from\s+['"](\./[^'"]+)['"]""", _read(config)):
                path = os.path.normpath(spec).replace("\\", "/")
                # './vite.config' 沒有副檔名（.config 不是副檔名）：只有已知的程式副檔名才視為帶副檔名
                exts = (".ts", ".mts", ".tsx", ".js", ".mjs")
                candidates = [path] if path.endswith(exts) else [path + ext for ext in exts]
                existing = [c for c in candidates if os.path.exists(os.path.join(REPO_ROOT, c))]
                with self.subTest(config=config, spec=spec):
                    self.assertTrue(existing, f"{spec} 在 repo 內找不到")
                    self.assertTrue(covered(existing[0], self.sources), f"{existing[0]} 不在 Dockerfile builder 階段的 COPY 內")


if __name__ == "__main__":
    unittest.main()
