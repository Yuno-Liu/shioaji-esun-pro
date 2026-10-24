"""部署腳本（scripts/deploy-docker.sh / .ps1）的回歸測試，不會呼叫 docker。

執行：python -m unittest discover -s deploy -p "test_*.py" -v
沒有 bash 或 pwsh 的環境會自動略過對應測試。
"""

from __future__ import annotations

import json
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
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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

    def test_duplicate_token_rewrites_last_line_like_compose(self) -> None:
        # compose 以最後一行為準：最後一行為空時改寫最後一行，不動使用者第一行的值
        _write(self.env, "ESUN_BRIDGE_TOKEN=mytoken\nWEB_PORT=8080\nESUN_BRIDGE_TOKEN=\n")
        output = self.run_ensure(self.dir)
        content = _read(self.env)
        lines = content.splitlines()
        self.assertEqual(lines[0], "ESUN_BRIDGE_TOKEN=mytoken", content)
        self.assertEqual(lines[1], "WEB_PORT=8080", content)
        self.assertRegex(lines[2], r"^ESUN_BRIDGE_TOKEN=[0-9a-f]{64}$")
        self.assertEqual(len(lines), 3, content)
        self.assertIn("重複的 ESUN_BRIDGE_TOKEN", output)
        self.assertNotIn("mytoken", output)
        self.assertNotIn(lines[2].split("=", 1)[1], output)
        # 冪等：再次執行不再改寫
        self.run_ensure(self.dir)
        self.assertEqual(_read(self.env), content)

    def test_duplicate_token_with_value_on_last_line_is_kept(self) -> None:
        _write(self.env, "ESUN_BRIDGE_TOKEN=\nESUN_BRIDGE_TOKEN=mytoken\n")
        output = self.run_ensure(self.dir)
        self.assertEqual(_read(self.env), "ESUN_BRIDGE_TOKEN=\nESUN_BRIDGE_TOKEN=mytoken\n")
        self.assertIn("重複的 ESUN_BRIDGE_TOKEN", output)
        self.assertNotIn("mytoken", output)


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


# 腳本會改動、且必須在結束時還原的行程環境變數
MANAGED_ENV = (
    "ESUN_BRIDGE_UPSTREAM", "WEB_PORT", "ESUN_SERVER_HOST", "ESUN_SERVER_PORT", "ESUN_BRIDGE_TOKEN",
    "ESUN_ACCOUNT_PASSWORD", "ESUN_PASSWORD", "ESUN_CERT_PASSWORD", "ESUN_ALLOWED_HOSTS",
)

# 在同一個 pwsh 行程（等同同一個 PowerShell 視窗）內依序執行整支 deploy-docker.ps1。
# docker、python、Start-Process 等外部動作都以 global 函式替身取代，只記錄當下的環境變數。
PS_FLOW_HARNESS = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$global:ManagedNames = ($env:DEPLOY_MANAGED_ENV -split ',')
function global:Get-MockEnv {
    $o = [ordered]@{}
    foreach ($n in $global:ManagedNames) { $o[$n] = [Environment]::GetEnvironmentVariable($n) }
    return $o
}
$global:Records = New-Object System.Collections.ArrayList
function global:Add-MockRecord([string]$kind, $argList) {
    [void]$global:Records.Add([ordered]@{ kind = $kind; args = (@($argList) -join ' '); env = (Get-MockEnv) })
}
function global:docker { Add-MockRecord 'docker' $args; $global:LASTEXITCODE = 0 }
function global:python {
    Add-MockRecord 'python' $args
    $joined = @($args) -join ' '
    if ($joined -eq '-c import esun_trade' -and $env:MOCK_ESUN_SDK_MISSING) {
        # 模擬 Windows PowerShell 5.1：原生指令被導向的 stderr 會變成 ErrorRecord
        Write-Error 'Traceback (most recent call last): ModuleNotFoundError: esun_trade'
        $global:LASTEXITCODE = 1
        return
    }
    if ($joined -eq '--version') { 'Python 3.11.9' }
    $global:LASTEXITCODE = 0
}
function global:Start-Process { Add-MockRecord 'start-process' $args; return [pscustomobject]@{ Id = 4242 } }
function global:Get-NetTCPConnection { return $null }
function global:Get-CimInstance { return $null }
function global:Start-Sleep { }
function global:Invoke-WebRequest { throw 'mock offline' }
function global:Invoke-RestMethod { throw 'mock offline' }

$results = New-Object System.Collections.ArrayList
foreach ($step in (Get-Content -Raw -Encoding utf8 $env:DEPLOY_STEPS | ConvertFrom-Json)) {
    if ($null -ne $step.envFile) {
        [System.IO.File]::WriteAllText($env:DEPLOY_ENV_FILE, $step.envFile, (New-Object System.Text.UTF8Encoding($false)))
    }
    $params = @{}
    foreach ($p in $step.params.psobject.Properties) { $params[$p.Name] = $p.Value }
    $global:Records.Clear()
    $global:LASTEXITCODE = 0
    & $env:DEPLOY_PS_SCRIPT @params
    [void]$results.Add([ordered]@{ exit = $LASTEXITCODE; records = @($global:Records.ToArray()); envAfter = (Get-MockEnv) })
}
[System.IO.File]::WriteAllText($env:DEPLOY_RESULT, (ConvertTo-Json -InputObject @($results.ToArray()) -Depth 8))
"""


@unittest.skipUnless(PWSH, "需要 pwsh")
class PowerShellDeployFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.env_file = os.path.join(self.dir, ".env")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_steps(self, steps: list[dict], shell_env: dict[str, str] | None = None) -> list[dict]:
        steps_file = os.path.join(self.dir, "steps.json")
        result_file = os.path.join(self.dir, "result.json")
        with open(steps_file, "w", encoding="utf-8") as f:
            json.dump(steps, f, ensure_ascii=False)
        cleared = set(MANAGED_ENV) | {"WEB_SERVER_NAMES", "ESUN_HOST_BRIDGE_BIND", "MOCK_ESUN_SDK_MISSING"}
        env = {k: v for k, v in os.environ.items() if k.upper() not in cleared}
        env.update(
            DEPLOY_PROJECT_ROOT=self.dir, DEPLOY_PS_SCRIPT=PS_SCRIPT, DEPLOY_ENV_FILE=self.env_file,
            DEPLOY_STEPS=steps_file, DEPLOY_RESULT=result_file, DEPLOY_MANAGED_ENV=",".join(MANAGED_ENV),
        )
        env.update(shell_env or {})
        res = subprocess.run(
            [PWSH, "-NoProfile", "-NonInteractive", "-Command", PS_FLOW_HARNESS],
            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        with open(result_file, encoding="utf-8-sig") as f:
            results = json.load(f)
        self.output = res.stdout + res.stderr
        return results

    @staticmethod
    def records(result: dict, kind: str) -> list[dict]:
        return [r for r in result["records"] if r["kind"] == kind]

    def compose_up(self, result: dict) -> dict:
        ups = [r for r in self.records(result, "docker") if r["args"].startswith("compose up")]
        assert len(ups) == 1, result
        return ups[0]

    def start_process(self, result: dict) -> dict:
        starts = self.records(result, "start-process")
        assert len(starts) == 1, result
        return starts[0]

    def assert_env_restored(self, result: dict, expected: dict[str, str] | None = None) -> None:
        expected = expected or {}
        for name in MANAGED_ENV:
            self.assertEqual(result["envAfter"][name], expected.get(name), name)

    def test_env_restored_and_reread_between_runs_in_same_session(self) -> None:
        base = (
            "WEB_PORT=8080\nESUN_BRIDGE_TOKEN=tok-a\nESUN_BRIDGE_UPSTREAM=http://esun-bridge:8090\n"
            "ESUN_CERT_PASSWORD=cert-pass\n"
        )
        first, second, third = self.run_steps([
            {"params": {"Action": "up", "HostBridge": True, "Port": 9000},
             "envFile": base + "ESUN_ACCOUNT_PASSWORD=old-pass\n"},
            # 同一個 session 修正 .env 的密碼後重跑：宿主機 bridge 必須拿到新密碼
            {"params": {"Action": "up", "HostBridge": True}, "envFile": base + "ESUN_ACCOUNT_PASSWORD=new-pass\n"},
            # 再改跑全容器模式：上游不得沿用 host.docker.internal，秘密也不留在 shell 環境
            {"params": {"Action": "up"}, "envFile": None},
        ])
        for result in (first, second, third):
            self.assertEqual(result["exit"], 0, self.output)
            self.assert_env_restored(result)

        bridge_env = self.start_process(first)["env"]
        self.assertEqual(bridge_env["ESUN_ACCOUNT_PASSWORD"], "old-pass")
        self.assertEqual(bridge_env["ESUN_CERT_PASSWORD"], "cert-pass")
        self.assertEqual(bridge_env["ESUN_BRIDGE_TOKEN"], "tok-a")
        self.assertEqual(bridge_env["ESUN_SERVER_HOST"], "127.0.0.1")
        self.assertEqual(bridge_env["ESUN_SERVER_PORT"], "8090")
        compose_env = self.compose_up(first)["env"]
        self.assertEqual(compose_env["ESUN_BRIDGE_UPSTREAM"], "http://host.docker.internal:8090")
        self.assertEqual(compose_env["WEB_PORT"], "9000")
        # 秘密只在 Start-Process 前後存在，compose 由 .env 自行讀取
        for name in ("ESUN_ACCOUNT_PASSWORD", "ESUN_CERT_PASSWORD", "ESUN_BRIDGE_TOKEN", "ESUN_SERVER_HOST"):
            self.assertIsNone(compose_env[name], name)

        self.assertEqual(self.start_process(second)["env"]["ESUN_ACCOUNT_PASSWORD"], "new-pass")
        self.assertIsNone(self.compose_up(second)["env"]["WEB_PORT"])

        self.assertEqual(self.records(third, "start-process"), [])
        compose_env = self.compose_up(third)["env"]
        self.assertEqual(compose_env["ESUN_BRIDGE_UPSTREAM"], "http://esun-bridge:8090")
        self.assertIsNone(compose_env["ESUN_ACCOUNT_PASSWORD"])

    def test_full_container_mode_uses_default_upstream_without_env_entry(self) -> None:
        first, second = self.run_steps([
            {"params": {"Action": "up", "HostBridge": True}, "envFile": "ESUN_BRIDGE_TOKEN=tok\n"},
            {"params": {"Action": "up"}, "envFile": None},
        ])
        self.assertEqual(self.compose_up(second)["env"]["ESUN_BRIDGE_UPSTREAM"], "http://esun-bridge:8090")
        self.assert_env_restored(first)
        self.assert_env_restored(second)

    def test_user_preset_env_is_kept_and_restored(self) -> None:
        shell = {"ESUN_ACCOUNT_PASSWORD": "shell-pass", "ESUN_BRIDGE_UPSTREAM": "http://custom:1", "WEB_PORT": "7000"}
        (result,) = self.run_steps(
            [{"params": {"Action": "up", "HostBridge": True, "Port": 9000},
              "envFile": "ESUN_BRIDGE_TOKEN=tok\nESUN_ACCOUNT_PASSWORD=file-pass\n"}],
            shell_env=shell,
        )
        self.assertEqual(result["exit"], 0, self.output)
        self.assertEqual(self.start_process(result)["env"]["ESUN_ACCOUNT_PASSWORD"], "shell-pass")
        self.assert_env_restored(result, shell)

    def test_host_bridge_allowed_hosts_defaults_to_web_server_names(self) -> None:
        env_file = "ESUN_BRIDGE_TOKEN=tok\nWEB_SERVER_NAMES=192.168.1.20 trade.lan\n"
        (from_file,) = self.run_steps([{"params": {"Action": "up", "HostBridge": True}, "envFile": env_file}])
        self.assertEqual(self.start_process(from_file)["env"]["ESUN_ALLOWED_HOSTS"], "192.168.1.20 trade.lan")
        self.assert_env_restored(from_file)
        # 與 compose 相同：shell 的 WEB_SERVER_NAMES 優先於 .env
        (from_shell,) = self.run_steps(
            [{"params": {"Action": "up", "HostBridge": True}, "envFile": env_file}],
            shell_env={"WEB_SERVER_NAMES": "shell.lan"},
        )
        self.assertEqual(self.start_process(from_shell)["env"]["ESUN_ALLOWED_HOSTS"], "shell.lan")

    def test_host_bridge_explicit_allowed_hosts_wins(self) -> None:
        env_file = "ESUN_BRIDGE_TOKEN=tok\nWEB_SERVER_NAMES=192.168.1.20\nESUN_ALLOWED_HOSTS=explicit.lan\n"
        (result,) = self.run_steps([{"params": {"Action": "up", "HostBridge": True}, "envFile": env_file}])
        self.assertEqual(self.start_process(result)["env"]["ESUN_ALLOWED_HOSTS"], "explicit.lan")

    def test_host_bridge_uses_last_duplicate_token_like_compose(self) -> None:
        env_file = "ESUN_BRIDGE_TOKEN=\nWEB_PORT=8080\nESUN_BRIDGE_TOKEN=mytoken\n"
        (result,) = self.run_steps([{"params": {"Action": "up", "HostBridge": True}, "envFile": env_file}])
        self.assertEqual(result["exit"], 0, self.output)
        # nginx 經 compose 取最後一行；宿主機 bridge 必須拿到同一個 token，.env 也不得被改寫
        self.assertEqual(self.start_process(result)["env"]["ESUN_BRIDGE_TOKEN"], "mytoken")
        self.assertEqual(_read(self.env_file), env_file)
        self.assertIn("重複的 ESUN_BRIDGE_TOKEN", self.output)
        self.assertNotIn("mytoken", self.output)

    def test_missing_sdk_check_does_not_abort_under_stop(self) -> None:
        (result,) = self.run_steps(
            [{"params": {"Action": "up", "HostBridge": True}, "envFile": "ESUN_BRIDGE_TOKEN=tok\n"}],
            shell_env={"MOCK_ESUN_SDK_MISSING": "1"},
        )
        self.assertEqual(result["exit"], 0, self.output)
        python_calls = [r["args"] for r in self.records(result, "python")]
        self.assertIn("-m pip install -r deploy/requirements-esun-bridge.txt", python_calls)
        self.assertIn("deploy/install_sdk.py", python_calls)
        self.start_process(result)


class ComposeAndDocsTest(unittest.TestCase):
    @staticmethod
    def service_block(name: str) -> str:
        compose = _read(os.path.join(REPO_ROOT, "docker-compose.yml")).replace("\r\n", "\n")
        m = re.search(r"^  " + re.escape(name) + r":\n((?:(?:    .*)?\n)*)", compose, re.M)
        assert m, name
        return m.group(1)

    def test_esun_bridge_stop_grace_period_covers_mutation_drain(self) -> None:
        # bridge 收到 SIGTERM 後最多等 8 秒讓進行中的委託回應；Docker 預設 10 秒不夠關閉 WS/SSE
        m = re.search(r"^    stop_grace_period:\s*(\d+)s\s*$", self.service_block("esun-bridge"), re.M)
        self.assertIsNotNone(m)
        self.assertGreaterEqual(int(m.group(1)), 15)

    def test_linux_host_bridge_gateway_ip_note(self) -> None:
        # nginx 的 resolver 不讀 /etc/hosts：Linux Docker Engine 的模式 B 要改用 gateway IP
        for rel in (".env.docker.example", os.path.join("docs", "fork", "esun.md")):
            text = _read(os.path.join(REPO_ROOT, rel))
            self.assertIn("http://172.17.0.1:8090", text, rel)
            self.assertIn("/etc/hosts", text, rel)


if __name__ == "__main__":
    unittest.main()
