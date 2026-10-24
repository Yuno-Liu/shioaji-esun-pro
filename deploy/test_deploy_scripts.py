"""部署腳本（scripts/deploy-docker.sh / .ps1）的回歸測試，不會呼叫 docker。

執行：python -m unittest discover -s deploy -p "test_*.py" -v
沒有 bash 或 pwsh 的環境會自動略過對應測試。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SH_SCRIPT = os.path.join(REPO_ROOT, "scripts", "deploy-docker.sh")
PS_SCRIPT = os.path.join(REPO_ROOT, "scripts", "deploy-docker.ps1")
TOKEN_RE = re.compile(r"^ESUN_BRIDGE_TOKEN=([0-9a-f]{64})\r?$", re.M)

def _find_bash() -> str | None:
    if os.name != "nt":
        return shutil.which("bash")
    # Windows：用 Git Bash，避開 System32 的 WSL bash（不會繼承環境變數與 Windows 路徑）
    git_bash = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Git", "bin", "bash.exe")
    return git_bash if os.path.isfile(git_bash) else None


BASH = _find_bash()
PWSH = shutil.which("pwsh")

PS_HARNESS = r"""
$ErrorActionPreference = 'Stop'
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DEPLOY_PS_SCRIPT, [ref]$null, [ref]$errs)
if ($errs.Count -gt 0) { throw "parse errors: $($errs -join '; ')" }
$funcs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($f in $funcs) { . ([scriptblock]::Create($f.Extent.Text)) }
$EnvFile = $env:DEPLOY_ENV_FILE
Initialize-BridgeToken
"""


def _read(path: str) -> str:
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def _write(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)


class _TokenCases:
    """bash 與 PowerShell 版本共用的 token 產生案例。"""

    def run_ensure(self, project_dir: str) -> str:  # pragma: no cover - 由子類別實作
        raise NotImplementedError

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.env = os.path.join(self.dir, ".env")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_fills_empty_token_without_printing_it(self) -> None:
        _write(self.env, "WEB_PORT=8080\nESUN_BRIDGE_TOKEN=\nSJ_API_KEY=abc\n")
        output = self.run_ensure(self.dir)
        content = _read(self.env)
        tokens = TOKEN_RE.findall(content)
        self.assertEqual(len(tokens), 1, content)
        self.assertNotIn(tokens[0], output)
        self.assertIn("WEB_PORT=8080\n", content)
        self.assertIn("SJ_API_KEY=abc\n", content)
        self.assertEqual(content.count("ESUN_BRIDGE_TOKEN="), 1)

    def test_appends_token_when_missing_and_is_idempotent(self) -> None:
        _write(self.env, "WEB_PORT=8080")
        self.run_ensure(self.dir)
        first = _read(self.env)
        self.assertTrue(first.startswith("WEB_PORT=8080\n"), first)
        self.assertEqual(len(TOKEN_RE.findall(first)), 1, first)
        self.run_ensure(self.dir)
        self.assertEqual(_read(self.env), first)

    def test_keeps_existing_token(self) -> None:
        _write(self.env, "ESUN_BRIDGE_TOKEN=keep-me\n")
        self.run_ensure(self.dir)
        self.assertEqual(_read(self.env), "ESUN_BRIDGE_TOKEN=keep-me\n")

    def test_preserves_crlf_line_endings(self) -> None:
        _write(self.env, "WEB_PORT=8080\r\nESUN_BRIDGE_TOKEN=\r\nPORT=8080\r\n")
        self.run_ensure(self.dir)
        content = _read(self.env)
        self.assertEqual(len(TOKEN_RE.findall(content)), 1, content)
        self.assertNotIn("\n", content.replace("\r\n", ""))
        self.assertTrue(content.endswith("PORT=8080\r\n"))


@unittest.skipUnless(BASH, "需要 bash")
class BashDeployScriptTest(_TokenCases, unittest.TestCase):
    def run_ensure(self, project_dir: str) -> str:
        env = dict(os.environ, DEPLOY_PROJECT_ROOT=project_dir, DEPLOY_SH=SH_SCRIPT.replace("\\", "/"))
        res = subprocess.run(
            [BASH, "-c", 'source "$DEPLOY_SH" && ensure_bridge_token'],
            env=env, capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return res.stdout + res.stderr

    def test_syntax(self) -> None:
        res = subprocess.run([BASH, "-n", SH_SCRIPT.replace("\\", "/")], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_dotenv_value_strips_quotes_and_cr(self) -> None:
        _write(self.env, "WEB_PORT = \"9000\"\r\n")
        env = dict(os.environ, DEPLOY_PROJECT_ROOT=self.dir, DEPLOY_SH=SH_SCRIPT.replace("\\", "/"))
        res = subprocess.run(
            [BASH, "-c", 'source "$DEPLOY_SH" && effective_setting WEB_PORT 8080'],
            env={k: v for k, v in env.items() if k != "WEB_PORT"}, capture_output=True, text=True,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout, "9000")


@unittest.skipUnless(PWSH, "需要 pwsh")
class PowerShellDeployScriptTest(_TokenCases, unittest.TestCase):
    def run_ensure(self, project_dir: str) -> str:
        env = dict(os.environ, DEPLOY_PS_SCRIPT=PS_SCRIPT, DEPLOY_ENV_FILE=os.path.join(project_dir, ".env"))
        res = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command", PS_HARNESS],
            env=env, capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        return res.stdout + res.stderr


if __name__ == "__main__":
    unittest.main()
