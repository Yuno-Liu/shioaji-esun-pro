#!/usr/bin/env python3
"""
install_sdk.py — 安裝 repo 內附的玉山證券 SDK（esun_trade）wheel

流程（任何一步失敗都以非零結束碼退出，讓 Docker 建置／CI 直接失敗）：
1. 以 deploy/esun_trade.sha256 驗證 wheel 的 SHA256（未列在校驗檔中的 wheel 一律不用）。
2. 讀取 wheel 內 *.dist-info/WHEEL 的 Tag，挑出與目前 Python／平台相容的 wheel
   （Linux x86_64 → manylinux wheel；Windows x64 → win_amd64 wheel）。
3. 以 dist-info 的名稱、版本與 Tag 組出合法的 PEP 427 檔名，複製到暫存目錄後
   交給 pip 安裝（repo 內的檔名保持不變）。

不再「解壓純 Python 模組」當退路：缺少原生模組 _trade_core 時橋接無法運作，
必須讓建置失敗而不是默默啟動一個壞掉的服務。

用法：
    python deploy/install_sdk.py [--wheel-dir DIR] [--checksums FILE] [--dry-run]
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

try:
    from packaging.tags import parse_tag, sys_tags
except ImportError:  # pip 內建一份 packaging
    from pip._vendor.packaging.tags import parse_tag, sys_tags  # type: ignore

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CHECKSUMS = os.path.join(SCRIPT_DIR, "esun_trade.sha256")


class InstallError(Exception):
    pass


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_checksums(path: str) -> dict[str, str]:
    """讀取 sha256sum 格式（`<hex>  <檔名>`）的校驗檔。"""
    if not os.path.isfile(path):
        raise InstallError(f"找不到校驗檔 {path}")
    sums: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) != 2 or len(parts[0]) != 64:
                raise InstallError(f"校驗檔格式錯誤：{raw!r}")
            sums[os.path.basename(parts[1].lstrip("*"))] = parts[0].lower()
    return sums


def read_wheel_info(path: str) -> tuple[str, str, str]:
    """回傳 (distribution, version, 壓縮後的 tag 字串)。"""
    with zipfile.ZipFile(path) as z:
        wheel_files = [n for n in z.namelist() if n.endswith(".dist-info/WHEEL")]
        if len(wheel_files) != 1:
            raise InstallError(f"{os.path.basename(path)} 不是有效的 wheel（找不到唯一的 WHEEL 檔）")
        dist_info = wheel_files[0].split("/")[0][: -len(".dist-info")]
        name, sep, version = dist_info.rpartition("-")
        if not sep or not name or not version:
            raise InstallError(f"{os.path.basename(path)} 的 dist-info 名稱無法解析：{dist_info}")
        tags = [
            line.split(":", 1)[1].strip()
            for line in z.read(wheel_files[0]).decode("utf-8").splitlines()
            if line.lower().startswith("tag:")
        ]
    if not tags:
        raise InstallError(f"{os.path.basename(path)} 的 WHEEL 檔沒有 Tag")
    # 多個 Tag 行時依 PEP 425 壓縮成 py-abi-plat 形式
    pythons, abis, plats = (sorted({t.split("-")[i] for t in tags}) for i in range(3))
    tag = "-".join(".".join(group) for group in (pythons, abis, plats))
    return name, version, tag


def select_wheel(wheel_dir: str, checksums: dict[str, str]) -> tuple[str, str]:
    """回傳 (wheel 路徑, 合法 PEP 427 檔名)。"""
    candidates = sorted(glob.glob(os.path.join(wheel_dir, "esun_trade*.whl")))
    if not candidates:
        raise InstallError(f"{wheel_dir} 中找不到 esun_trade*.whl")

    supported = set(sys_tags())
    rejected: list[str] = []
    for path in candidates:
        base = os.path.basename(path)
        expected = checksums.get(base)
        if expected is None:
            rejected.append(f"{base}: 未列在校驗檔中")
            continue
        actual = sha256_of(path)
        if actual != expected:
            raise InstallError(f"{base} 的 SHA256 不符（預期 {expected}，實際 {actual}）— wheel 可能遭替換或損毀")
        name, version, tag = read_wheel_info(path)
        if supported.isdisjoint(parse_tag(tag)):
            rejected.append(f"{base}: Tag {tag} 與目前平台不相容")
            continue
        return path, f"{name}-{version}-{tag}.whl"

    platform_hint = next(iter(sys_tags()))
    raise InstallError(
        "沒有與目前平台相容的玉山 SDK wheel（目前平台例如 "
        f"{platform_hint}）。repo 只附 Linux x86_64 與 Windows x64 版本；"
        "ARM 主機（例如 Apple Silicon）需向玉山取得對應 wheel 或改用 x86_64 平台建置。\n  - "
        + "\n  - ".join(rejected)
    )


def install(wheel_dir: str, checksums_path: str, dry_run: bool = False) -> str:
    checksums = load_checksums(checksums_path)
    path, pep427_name = select_wheel(wheel_dir, checksums)
    print(f"已驗證 {os.path.basename(path)}（SHA256 相符），以 {pep427_name} 安裝")
    if dry_run:
        return pep427_name
    with tempfile.TemporaryDirectory() as tmp:
        target = os.path.join(tmp, pep427_name)
        shutil.copyfile(path, target)
        res = subprocess.run([sys.executable, "-m", "pip", "install", "--no-cache-dir", target])
    if res.returncode != 0:
        raise InstallError(f"pip 安裝 {pep427_name} 失敗（結束碼 {res.returncode}）")
    return pep427_name


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="安裝 repo 內附的玉山證券 SDK wheel")
    parser.add_argument("--wheel-dir", default=os.getcwd(), help="wheel 所在目錄（預設為目前目錄）")
    parser.add_argument("--checksums", default=DEFAULT_CHECKSUMS, help="sha256sum 格式的校驗檔")
    parser.add_argument("--dry-run", action="store_true", help="只驗證與挑選 wheel，不安裝")
    args = parser.parse_args(argv)
    try:
        install(args.wheel_dir, args.checksums, args.dry_run)
    except InstallError as exc:
        print(f"[install_sdk] 錯誤：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
