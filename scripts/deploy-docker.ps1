<#
.SYNOPSIS
    Shioaji Pro Docker 網頁版一鍵部署管理腳本 (PowerShell 7 / Windows PowerShell 5.1)

.DESCRIPTION
    自動檢測並啟動 Shioaji Pro Web 交易終端與玉山證券 Sidecar 服務。
    支援全容器化模式 (預設，推薦) 與 Windows 宿主機原生 Sidecar 模式 (-HostBridge)。
    首次執行會自動在 .env 產生 ESUN_BRIDGE_TOKEN（不會顯示於畫面）。

.PARAMETER Action
    操作動作：up (預設), down, restart, status, logs

.PARAMETER Port
    Web 終端在主機上的埠號。未指定時沿用 .env 的 WEB_PORT（預設 8080）。

.PARAMETER BridgePort
    -HostBridge 模式下宿主機玉山 Sidecar 的埠號 (預設 8090)。

.PARAMETER HostBridge
    若指定，玉山 Sidecar 會在 Windows 宿主機上以原生 Python 執行（預設只綁 127.0.0.1，
    可用環境變數 ESUN_HOST_BRIDGE_BIND 覆寫），Web 終端容器則透過 host.docker.internal 反向代理至主機。

.PARAMETER NoBuild
    若指定，跳過 Docker 映象檔重新建置，直接啟動現有容器。

.EXAMPLE
    .\scripts\deploy-docker.ps1 -Action up
    .\scripts\deploy-docker.ps1 -Action status
    .\scripts\deploy-docker.ps1 -Action down
    .\scripts\deploy-docker.ps1 -Action up -HostBridge
#>

[CmdletBinding()]
param(
    [ValidateSet("up", "down", "restart", "status", "logs")]
    [string]$Action = "up",

    [int]$Port = 8080,

    [int]$BridgePort = 8090,

    [switch]$HostBridge,

    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 測試時可用 DEPLOY_PROJECT_ROOT 指定專案根目錄（與 deploy-docker.sh 相同）
$ProjectRoot = if ($env:DEPLOY_PROJECT_ROOT) { $env:DEPLOY_PROJECT_ROOT } else { Split-Path -Parent $ScriptDir }
Set-Location $ProjectRoot

$PidFile = Join-Path $ProjectRoot ".esun-bridge.pid"
$EnvFile = Join-Path $ProjectRoot ".env"

# 腳本會改動的行程環境變數：先記下原值，結束時（最外層 finally）還原，原本不存在的移除。
# 以 .\scripts\deploy-docker.ps1 執行時 $env: 的修改會留在 PowerShell session，不還原會讓下一次執行
# 沿用殘留的上游與舊密碼（compose 以 shell 環境優先於 .env）。
$ManagedEnvNames = @(
    "ESUN_BRIDGE_UPSTREAM", "WEB_PORT", "ESUN_SERVER_HOST", "ESUN_SERVER_PORT", "ESUN_BRIDGE_TOKEN",
    "ESUN_ACCOUNT_PASSWORD", "ESUN_PASSWORD", "ESUN_CERT_PASSWORD", "ESUN_ALLOWED_HOSTS"
)
$OriginalEnv = @{}
foreach ($name in $ManagedEnvNames) {
    $OriginalEnv[$name] = [Environment]::GetEnvironmentVariable($name)
}

function Write-Info($msg) {
    Write-Host "[INFO] $msg" -ForegroundColor Cyan
}

function Write-Success($msg) {
    Write-Host "[SUCCESS] $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "[WARN] $msg" -ForegroundColor Yellow
}

function Write-Err($msg) {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
}

# 原生指令（docker、python、pip）失敗時 $ErrorActionPreference 不會中止，必須自行檢查結束碼
function Assert-LastExitCode([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        throw "$what 失敗（結束碼 $LASTEXITCODE）"
    }
}

# 與 docker compose 相同：同名鍵重複時以最後一行為準
function Get-DotEnvValue([string]$name) {
    if (-not (Test-Path $EnvFile)) { return $null }
    $pattern = '^\s*' + [regex]::Escape($name) + '\s*=\s*(.*?)\s*$'
    $value = $null
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        $m = [regex]::Match($line, $pattern)
        if ($m.Success) {
            $value = $m.Groups[1].Value.Trim('"', "'")
        }
    }
    return $value
}

# 設定行程環境變數；值為空時移除
function Set-ProcessEnv([System.Collections.IDictionary]$values) {
    foreach ($name in @($values.Keys)) {
        if ($values[$name]) {
            [Environment]::SetEnvironmentVariable($name, [string]$values[$name])
        } else {
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }
    }
}

# 把指定的變數還原成腳本啟動時的值（$OriginalEnv）；原本不存在的移除
function Restore-ProcessEnv([string[]]$names) {
    $saved = [ordered]@{}
    foreach ($name in $names) { $saved[$name] = $script:OriginalEnv[$name] }
    Set-ProcessEnv $saved
}

# compose 的變數優先序：shell 環境變數 > .env > 預設值
function Get-EffectiveSetting([string]$name, [string]$default) {
    $fromShell = [Environment]::GetEnvironmentVariable($name)
    if ($fromShell) { return $fromShell }
    $fromFile = Get-DotEnvValue $name
    if ($fromFile) { return $fromFile }
    return $default
}

function New-BridgeToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

# 若 .env 沒有（或為空的）ESUN_BRIDGE_TOKEN，產生 32 bytes 隨機 token 寫入；不輸出 token 內容
function Initialize-BridgeToken {
    if (-not (Test-Path $EnvFile)) {
        Write-Warn "找不到 .env，略過 ESUN_BRIDGE_TOKEN 產生"
        return
    }
    $content = [System.IO.File]::ReadAllText($EnvFile)
    $linePattern = '(?m)^[ \t]*ESUN_BRIDGE_TOKEN[ \t]*=.*?(?=\r?$)'
    $tokenLines = [regex]::Matches($content, $linePattern)
    if ($tokenLines.Count -gt 1) {
        Write-Warn "偵測到 .env 有重複的 ESUN_BRIDGE_TOKEN（$($tokenLines.Count) 行），以最後一行為準（與 docker compose 相同），請刪除多餘的行"
    }
    if (Get-DotEnvValue "ESUN_BRIDGE_TOKEN") {
        return
    }

    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $token = New-BridgeToken
    if ($tokenLines.Count -gt 0) {
        # 改寫 compose 實際生效的最後一行
        $last = $tokenLines[$tokenLines.Count - 1]
        $content = $content.Substring(0, $last.Index) + "ESUN_BRIDGE_TOKEN=$token" + $content.Substring($last.Index + $last.Length)
    } else {
        if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
            $content += $newline
        }
        $content += "# 由 deploy-docker 自動產生：nginx 以此 token 存取玉山橋接（瀏覽器不持有）$newline"
        $content += "ESUN_BRIDGE_TOKEN=$token$newline"
    }
    [System.IO.File]::WriteAllText($EnvFile, $content, (New-Object System.Text.UTF8Encoding($false)))
    $token = $null
    Write-Success "已在 .env 產生 ESUN_BRIDGE_TOKEN（內容不顯示）"
}

function Test-DockerPrerequisites {
    Write-Info "檢查 Docker 環境..."
    try {
        $dockerVer = docker --version 2>&1
        Assert-LastExitCode "docker --version"
        Write-Info "Docker: $dockerVer"
    } catch {
        Write-Err "找不到 Docker。請先安裝並啟動 Docker Desktop (https://www.docker.com/products/docker-desktop/)。"
        exit 1
    }

    try {
        $composeVer = docker compose version 2>&1
        Assert-LastExitCode "docker compose version"
        Write-Info "Docker Compose: $composeVer"
    } catch {
        Write-Err "找不到 Docker Compose。請確認 Docker Desktop 已正確安裝 Compose 插件。"
        exit 1
    }
}

function Initialize-ConfigFiles {
    Write-Info "檢查設定檔與憑證目錄..."

    if (-not (Test-Path "certs")) {
        New-Item -ItemType Directory -Path "certs" -Force | Out-Null
        Write-Success "已建立憑證放置目錄: ./certs/ (請將玉山憑證 .p12 放入此目錄)"
    }

    $dedicatedCandidates = @(
        "esun-config.simulation.ini",
        "esun-config.sim.ini",
        "esun-config.test.ini",
        "esun-config.production.ini",
        "esun-config.prod.ini"
    )
    $hasDedicatedConfig = $false
    foreach ($cand in $dedicatedCandidates) {
        if (Test-Path $cand) {
            $hasDedicatedConfig = $true
            break
        }
    }

    # If dedicated config exists, check if esun-config.ini is an unedited copy of esun-config.ini.example
    if ($hasDedicatedConfig -and (Test-Path "esun-config.ini") -and (Test-Path "esun-config.ini.example")) {
        try {
            $hashExample = (Get-FileHash "esun-config.ini.example" -Algorithm SHA256).Hash
            $hashCurrent = (Get-FileHash "esun-config.ini" -Algorithm SHA256).Hash
            if ($hashExample -eq $hashCurrent) {
                Remove-Item "esun-config.ini" -Force -ErrorAction SilentlyContinue
                Write-Info "已偵測到專用環境設定檔，自動移除未編輯的預設範本 esun-config.ini"
            }
        } catch {
            # ignore hash check error
        }
    }

    $allEsunConfigs = @(
        "esun-config.simulation.ini",
        "esun-config.sim.ini",
        "esun-config.test.ini",
        "esun-config.production.ini",
        "esun-config.prod.ini",
        "esun-config.ini"
    )
    $hasAnyConfig = $false
    foreach ($cand in $allEsunConfigs) {
        if (Test-Path $cand) {
            $hasAnyConfig = $true
            break
        }
    }

    if (-not $hasAnyConfig) {
        if (Test-Path "esun-config.ini.example") {
            Copy-Item "esun-config.ini.example" "esun-config.ini"
            Write-Success "已從 esun-config.ini.example 自動初始化 esun-config.ini (請編輯填寫您的帳號與 API 金鑰)"
        } else {
            Write-Warn "找不到 esun-config.ini.example，無法初始化 esun-config.ini"
        }
    }

    if (-not (Test-Path $EnvFile)) {
        if (Test-Path ".env.docker.example") {
            Copy-Item ".env.docker.example" $EnvFile
            Write-Success "已從 .env.docker.example 自動初始化 .env (請編輯填寫您的玉山登入密碼與憑證密碼)"
        }
    }

    Initialize-BridgeToken
}

# 只終止確實是 esun_trade_server.py 的程序（PID 可能已被系統重複使用）
function Stop-HostBridgeProcess {
    if (Test-Path $PidFile) {
        $savedPid = Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($savedPid -and ($savedPid -as [int])) {
            $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$savedPid)" -ErrorAction SilentlyContinue
            if ($procInfo -and $procInfo.CommandLine -and $procInfo.CommandLine -like "*esun_trade_server.py*") {
                Write-Info "正在停止 Windows 宿主機玉山 Sidecar 程序 (PID: $savedPid)..."
                Stop-Process -Id ([int]$savedPid) -Force -ErrorAction SilentlyContinue
                Write-Success "已終止 Sidecar 程序 (PID: $savedPid)"
            } elseif ($procInfo) {
                Write-Warn "PID $savedPid 已不是玉山 Sidecar（可能已被其他程序重用），不終止它"
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Start-HostBridgeProcess {
    Write-Info "正在啟動 Windows 宿主機原生玉山 Sidecar..."

    # 檢查 Python
    try {
        $pyVer = python --version 2>&1
        Assert-LastExitCode "python --version"
        Write-Info "Python: $pyVer"
    } catch {
        Write-Err "未找到 python 指令。請確認已安裝 Python 3.10+ 並加入 PATH。"
        exit 1
    }

    # 檢查並安裝 esun_trade（install_sdk.py 會驗證 SHA256 並挑選 Windows wheel）。
    # Windows PowerShell 5.1 會把被導向的原生 stderr 包成 ErrorRecord，在 Stop 下直接中止，
    # 因此檢查期間暫時改為 Continue，只看結束碼
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        python -c "import esun_trade" 2>$null
        $sdkMissing = ($LASTEXITCODE -ne 0)
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($sdkMissing) {
        Write-Info "正在安裝玉山 SDK 與相依套件..."
        python -m pip install -r deploy/requirements-esun-bridge.txt
        Assert-LastExitCode "安裝 deploy/requirements-esun-bridge.txt"
        python deploy/install_sdk.py
        Assert-LastExitCode "安裝玉山 SDK (deploy/install_sdk.py)"
    }

    # 檢查是否已在監聽
    $conn = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Warn "連接埠 $BridgePort 已有程序在監聽，跳過啟動 Python 程序。"
        return
    }

    # 子程序沿用目前環境：腳本啟動前使用者自行設定的值優先，否則每次從 .env 重新讀取最新值
    $bridgeEnv = [ordered]@{}
    foreach ($name in @("ESUN_BRIDGE_TOKEN", "ESUN_ACCOUNT_PASSWORD", "ESUN_PASSWORD", "ESUN_CERT_PASSWORD", "ESUN_ALLOWED_HOSTS")) {
        $value = $script:OriginalEnv[$name]
        if (-not $value) { $value = Get-DotEnvValue $name }
        $bridgeEnv[$name] = $value
    }
    # 與 compose 的 ESUN_ALLOWED_HOSTS=${WEB_SERVER_NAMES} 一致（shell > .env > 空）
    if (-not $bridgeEnv["ESUN_ALLOWED_HOSTS"]) {
        $bridgeEnv["ESUN_ALLOWED_HOSTS"] = Get-EffectiveSetting "WEB_SERVER_NAMES" ""
    }
    $bindHost = Get-EffectiveSetting "ESUN_HOST_BRIDGE_BIND" "127.0.0.1"
    $bridgeEnv["ESUN_SERVER_HOST"] = $bindHost
    $bridgeEnv["ESUN_SERVER_PORT"] = "$BridgePort"
    $logFile = Join-Path $ProjectRoot "esun-bridge.log"
    $errLogFile = Join-Path $ProjectRoot "esun-bridge.err.log"

    # 秘密只在 Start-Process 前設定，子程序啟動後立即還原，不留在 PowerShell session
    try {
        Set-ProcessEnv $bridgeEnv
        $p = Start-Process -FilePath "python" `
            -ArgumentList "-u", "server/esun_trade_server.py" `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError $errLogFile `
            -WindowStyle Hidden `
            -PassThru
    } finally {
        Restore-ProcessEnv @($bridgeEnv.Keys)
    }

    Set-Content -Path $PidFile -Value $p.Id
    Write-Success "Windows 宿主機玉山 Sidecar 已在背景啟動 (PID: $($p.Id), 綁定 ${bindHost}:$BridgePort)，日誌記錄於 $logFile / $errLogFile"
    Start-Sleep -Seconds 2
}

function Action-Up {
    Test-DockerPrerequisites
    Initialize-ConfigFiles

    # 只有明確指定參數時才覆寫，否則交由 compose 讀取 .env（shell 環境變數優先於 .env）
    if ($script:PortBound) {
        $env:WEB_PORT = "$Port"
    }

    $composeArgs = @("compose", "up", "-d")
    if (-not $NoBuild) { $composeArgs += "--build" }

    if ($HostBridge) {
        Start-HostBridgeProcess
        $env:ESUN_BRIDGE_UPSTREAM = "http://host.docker.internal:$BridgePort"
        Write-Info "啟動 Shioaji Pro Web 容器 (指向 Windows 宿主機 Sidecar: $env:ESUN_BRIDGE_UPSTREAM)..."
        # --no-deps：不連帶啟動 esun-bridge 容器
        docker @composeArgs --no-deps shioaji-pro-web shioaji-server
        Assert-LastExitCode "docker compose up (HostBridge)"
    } else {
        # 全容器化模式
        Stop-HostBridgeProcess
        # 明確決定上游（.env 值或預設），不沿用 session 殘留的 host.docker.internal
        $upstream = Get-DotEnvValue "ESUN_BRIDGE_UPSTREAM"
        $env:ESUN_BRIDGE_UPSTREAM = if ($upstream) { $upstream } else { "http://esun-bridge:8090" }
        Write-Info "以全容器化模式啟動 Shioaji Pro Web 與 esun-bridge 容器..."
        docker @composeArgs
        Assert-LastExitCode "docker compose up"
    }

    Write-Info "等待服務就緒..."
    Start-Sleep -Seconds 3

    Action-Status
}

function Action-Down {
    Write-Info "正在停止 Docker 容器與相關服務..."
    docker compose down
    Assert-LastExitCode "docker compose down"
    Stop-HostBridgeProcess
    Write-Success "所有服務已停止。"
}

function Action-Status {
    Write-Host "`n─────────────────────────── [容器運行狀態] ───────────────────────────" -ForegroundColor Cyan
    docker compose ps
    Assert-LastExitCode "docker compose ps"

    Write-Host "`n─────────────────────────── [服務連線檢測] ───────────────────────────" -ForegroundColor Cyan
    $webPort = if ($script:PortBound) { "$Port" } else { Get-EffectiveSetting "WEB_PORT" "8080" }
    $webUrl = "http://localhost:$webPort"
    $healthUrl = "http://localhost:$webPort/esun/health"

    # 檢測 Web 終端
    try {
        $webRes = Invoke-WebRequest -Uri $webUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        if ($webRes.StatusCode -eq 200) {
            Write-Success "Web 終端 (Nginx): 連線正常 [HTTP 200] -> $webUrl"
        } else {
            Write-Warn "Web 終端 (Nginx): 回應狀態碼 $($webRes.StatusCode) -> $webUrl"
        }
    } catch {
        Write-Err "Web 終端 (Nginx): 無法連線至 $webUrl ($($_.Exception.Message))"
    }

    # 檢測玉山健康檢查（只顯示登入狀態與環境，不輸出帳號或憑證資訊）
    try {
        $healthRes = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5 -ErrorAction Stop
        if ($healthRes.ok) {
            Write-Success "玉山 Sidecar (/esun/health): 連線正常 [HTTP 200]"
            Write-Host "  - 登入狀態: $(if ($healthRes.loggedIn) { '已登入' } else { '未登入' })"
            Write-Host "  - 運行環境: $($healthRes.environment)"
            if ($healthRes.loginLocked) {
                Write-Warn "  - 登入已鎖定（熔斷），請確認密碼後手動重連"
            }
            if ($healthRes.problems -and $healthRes.problems.Count -gt 0) {
                Write-Warn "  - 待配置項目: $($healthRes.problems -join '; ')"
            }
        } else {
            Write-Warn "玉山 Sidecar 回傳異常（ok=false）"
        }
    } catch {
        Write-Warn "玉山 Sidecar (/esun/health): 無法連線或尚未就緒 -> $healthUrl ($($_.Exception.Message))"
        if ($HostBridge) {
            Write-Warn "  若容器無法連到宿主機 127.0.0.1，可設定環境變數 ESUN_HOST_BRIDGE_BIND=0.0.0.0 後重試（橋接仍要求 ESUN_BRIDGE_TOKEN）"
        }
    }

    Write-Host "────────────────────────────────────────────────────────────────────────" -ForegroundColor Cyan
    Write-Host "💡 提示：" -ForegroundColor White
    Write-Host "   - 瀏覽器開啟交易終端: $webUrl" -ForegroundColor Green
    Write-Host "   - 檢視即時容器日誌:   pnpm docker:logs  或  docker compose logs -f" -ForegroundColor Gray
    Write-Host "   - 停止所有服務:       pnpm docker:down  或  .\scripts\deploy-docker.ps1 -Action down`n" -ForegroundColor Gray
}

function Action-Logs {
    docker compose logs -f
}

$script:PortBound = $PSBoundParameters.ContainsKey("Port")

# 執行指定動作
try {
    switch ($Action) {
        "up"      { Action-Up }
        "down"    { Action-Down }
        "restart" { Action-Down; Action-Up }
        "status"  { Action-Status }
        "logs"    { Action-Logs }
    }
} catch {
    Write-Err $_.Exception.Message
    exit 1
} finally {
    Restore-ProcessEnv $ManagedEnvNames
}
