<#
.SYNOPSIS
    Shioaji Pro Docker 網頁版一鍵部署管理腳本 (Windows PowerShell)

.DESCRIPTION
    自動檢測並啟動 Shioaji Pro Web 交易終端與玉山證券 Sidecar 服務。
    支援全容器化模式 (預設，推薦) 與 Windows 宿主機原生 Sidecar 模式 (-HostBridge)。

.PARAMETER Action
    操作動作：up (預設), down, restart, status, logs

.PARAMETER Port
    Web 終端監聽埠號 (預設 8080)

.PARAMETER BridgePort
    玉山證券 Sidecar 監聽埠號 (預設 8090)

.PARAMETER HostBridge
    若指定，玉山 Sidecar 會在 Windows 宿主機上以原生 Python 執行，
    Web 終端容器則透過 host.docker.internal 反向代理至主機。

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
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

$PidFile = Join-Path $ProjectRoot ".esun-bridge.pid"

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

function Test-DockerPrerequisites {
    Write-Info "檢查 Docker 環境..."
    try {
        $dockerVer = docker --version 2>&1
        Write-Info "Docker: $dockerVer"
    } catch {
        Write-Err "找不到 Docker。請先安裝並啟動 Docker Desktop (https://www.docker.com/products/docker-desktop/)。"
        exit 1
    }

    try {
        $composeVer = docker compose version 2>&1
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

    if (-not (Test-Path "esun-config.ini")) {
        if (Test-Path "esun-config.ini.example") {
            Copy-Item "esun-config.ini.example" "esun-config.ini"
            Write-Success "已從 esun-config.ini.example 自動初始化 esun-config.ini (請編輯填寫您的帳號與 API 金鑰)"
        } else {
            Write-Warn "找不到 esun-config.ini.example，無法初始化 esun-config.ini"
        }
    }

    if (-not (Test-Path ".env")) {
        if (Test-Path ".env.docker.example") {
            Copy-Item ".env.docker.example" ".env"
            Write-Success "已從 .env.docker.example 自動初始化 .env (請編輯填寫您的玉山登入密碼與憑證密碼)"
        }
    }
}

function Stop-HostBridgeProcess {
    if (Test-Path $PidFile) {
        $savedPid = Get-Content $PidFile -ErrorAction SilentlyContinue
        if ($savedPid -and ($savedPid -as [int])) {
            $p = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
            if ($p) {
                Write-Info "正在停止 Windows 宿主機玉山 Sidecar 程序 (PID: $savedPid)..."
                Stop-Process -Id ([int]$savedPid) -Force -ErrorAction SilentlyContinue
                Write-Success "已終止 Sidecar 程序 (PID: $savedPid)"
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
        Write-Info "Python: $pyVer"
    } catch {
        Write-Err "未找到 python 指令。請確認已安裝 Python 3.10+ 並加入 PATH。"
        exit 1
    }

    # 檢查並安裝 esun_trade
    $hasEsun = python -c "import esun_trade" 2>$null
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path "esun_trade-2.2.0.whl") {
            Write-Info "正在安裝本機 Windows Wheel: esun_trade-2.2.0.whl..."
            pip install "websocket-client>=1.5.1,<2" "keyring==23.5.0" "keyrings.cryptfile>=1.3.9,<2" ./esun_trade-2.2.0.whl
        } else {
            Write-Warn "未找到 esun_trade-2.2.0.whl，嘗試直接啟動伺服器..."
        }
    }

    # 檢查是否已在監聽
    $conn = Get-NetTCPConnection -LocalPort $BridgePort -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Warn "連接埠 $BridgePort 已有程序在監聽，跳過啟動 Python 程序。"
        return
    }

    $env:ESUN_SERVER_HOST = "0.0.0.0"
    $env:ESUN_SERVER_PORT = "$BridgePort"
    $logFile = Join-Path $ProjectRoot "esun-bridge.log"

    $p = Start-Process -FilePath "python" `
        -ArgumentList "-u", "server/esun_trade_server.py" `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $logFile `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -Path $PidFile -Value $p.Id
    Write-Success "Windows 宿主機玉山 Sidecar 已在背景啟動 (PID: $($p.Id))，日誌記錄於 $logFile"
    Start-Sleep -Seconds 2
}

function Action-Up {
    Test-DockerPrerequisites
    Initialize-ConfigFiles

    $env:WEB_PORT = "$Port"
    $env:PORT = "$Port"
    $env:BRIDGE_PORT = "$BridgePort"

    $buildFlag = if ($NoBuild) { "" } else { "--build" }

    if ($HostBridge) {
        Start-HostBridgeProcess
        $env:ESUN_BRIDGE_UPSTREAM = "http://host.docker.internal:$BridgePort"
        Write-Info "啟動 Shioaji Pro Web 容器 (指向 Windows 宿主機 Sidecar: $env:ESUN_BRIDGE_UPSTREAM)..."
        if ($buildFlag) {
            docker compose up -d --build shioaji-pro-web
        } else {
            docker compose up -d shioaji-pro-web
        }
    } else {
        # 全容器化模式
        Stop-HostBridgeProcess
        $env:ESUN_BRIDGE_UPSTREAM = "http://esun-bridge:8090"
        Write-Info "以全容器化模式啟動 Shioaji Pro Web 與 esun-bridge 容器..."
        if ($buildFlag) {
            docker compose up -d --build
        } else {
            docker compose up -d
        }
    }

    Write-Info "等待服務就緒..."
    Start-Sleep -Seconds 3

    Action-Status
}

function Action-Down {
    Write-Info "正在停止 Docker 容器與相關服務..."
    docker compose down
    Stop-HostBridgeProcess
    Write-Success "所有服務已停止。"
}

function Action-Status {
    Write-Host "`n─────────────────────────── [容器運行狀態] ───────────────────────────" -ForegroundColor Cyan
    docker compose ps

    Write-Host "`n─────────────────────────── [服務連線檢測] ───────────────────────────" -ForegroundColor Cyan
    $webUrl = "http://localhost:$Port"
    $healthUrl = "http://localhost:$Port/esun/health"

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

    # 檢測玉山健康檢查
    try {
        $healthRes = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5 -ErrorAction Stop
        if ($healthRes.ok) {
            Write-Success "玉山 Sidecar (/esun/health): 連線正常 [HTTP 200]"
            Write-Host "  - 登入狀態: $(if ($healthRes.loggedIn) { '已登入' } else { '未登入' })"
            Write-Host "  - 綁定帳號: $(if ($healthRes.account) { "$($healthRes.account.broker_id)-$($healthRes.account.account_id)" } else { '尚未綁定' })"
            Write-Host "  - 運行環境: $($healthRes.environment)"
            if ($healthRes.problems -and $healthRes.problems.Count -gt 0) {
                Write-Warn "  - 待配置項目: $($healthRes.problems -join '; ')"
            }
        } else {
            Write-Warn "玉山 Sidecar 回傳異常: $healthRes"
        }
    } catch {
        Write-Warn "玉山 Sidecar (/esun/health): 無法連線或尚未就緒 -> $healthUrl"
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

# 執行指定動作
switch ($Action) {
    "up"      { Action-Up }
    "down"    { Action-Down }
    "restart" { Action-Down; Action-Up }
    "status"  { Action-Status }
    "logs"    { Action-Logs }
}
