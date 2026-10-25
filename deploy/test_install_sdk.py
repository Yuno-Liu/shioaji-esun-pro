"""deploy/install_sdk.py 的單元測試（不需要真的安裝 SDK）。

執行：python -m unittest discover -s deploy -p "test_*.py" -v
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import install_sdk  # noqa: E402


def _current_tag() -> str:
    tag = next(iter(install_sdk.sys_tags()))
    return f"{tag.interpreter}-{tag.abi}-{tag.platform}"


def _make_wheel(path: str, tag: str, dist_info: str = "esun_trade-2.2.0") -> str:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"{dist_info}.dist-info/WHEEL", f"Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: {tag}\n")
        z.writestr("esun_trade/__init__.py", "")
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class InstallSdkTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.checksums = os.path.join(self.dir, "sums.sha256")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_sums(self, entries: dict[str, str]) -> None:
        with open(self.checksums, "w", encoding="utf-8") as f:
            for name, digest in entries.items():
                f.write(f"{digest}  {name}\n")

    def test_selects_compatible_wheel_and_builds_pep427_name(self) -> None:
        good = _make_wheel(os.path.join(self.dir, "esun_trade-2.2.0-linux.whl"), _current_tag())
        other = _make_wheel(os.path.join(self.dir, "esun_trade-2.2.0.whl"), "cp37-abi3-fakeplatform_x")
        self._write_sums({"esun_trade-2.2.0-linux.whl": good, "esun_trade-2.2.0.whl": other})

        name = install_sdk.install(self.dir, self.checksums, dry_run=True)

        self.assertEqual(name, f"esun_trade-2.2.0-{_current_tag()}.whl")
        # repo 內原檔名不得被改名
        self.assertTrue(os.path.exists(os.path.join(self.dir, "esun_trade-2.2.0-linux.whl")))

    def test_checksum_mismatch_fails(self) -> None:
        _make_wheel(os.path.join(self.dir, "esun_trade-2.2.0-linux.whl"), _current_tag())
        self._write_sums({"esun_trade-2.2.0-linux.whl": "0" * 64})
        with self.assertRaisesRegex(install_sdk.InstallError, "SHA256 不符"):
            install_sdk.install(self.dir, self.checksums, dry_run=True)

    def test_unlisted_wheel_is_not_used(self) -> None:
        _make_wheel(os.path.join(self.dir, "esun_trade-9.9.9.whl"), _current_tag())
        self._write_sums({})
        with self.assertRaisesRegex(install_sdk.InstallError, "未列在校驗檔中"):
            install_sdk.install(self.dir, self.checksums, dry_run=True)

    def test_incompatible_platform_fails_with_clear_message(self) -> None:
        digest = _make_wheel(os.path.join(self.dir, "esun_trade-2.2.0.whl"), "cp37-abi3-fakeplatform_x")
        self._write_sums({"esun_trade-2.2.0.whl": digest})
        with self.assertRaisesRegex(install_sdk.InstallError, "不相容"):
            install_sdk.install(self.dir, self.checksums, dry_run=True)

    def test_main_returns_nonzero_without_wheels(self) -> None:
        self._write_sums({})
        self.assertEqual(install_sdk.main(["--wheel-dir", self.dir, "--checksums", self.checksums, "--dry-run"]), 1)

    def test_repo_checksum_file_matches_committed_wheels(self) -> None:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        sums = install_sdk.load_checksums(install_sdk.DEFAULT_CHECKSUMS)
        for name, digest in sums.items():
            path = os.path.join(repo_root, name)
            if os.path.exists(path):
                self.assertEqual(install_sdk.sha256_of(path), digest, name)


if __name__ == "__main__":
    unittest.main()
