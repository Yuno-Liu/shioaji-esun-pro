#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Shioaji Pro Web — Docker 一鍵部署管理腳本 (Linux / macOS / Git Bash)
# ─────────────────────────────────────────────────────────────────────────────

set -e

ACTION="${1:-up}"
PORT="${PORT:-8080}"
BRIDGE_PORT="${BRIDGE_PORT:-8090}"

# 切換至專案根目錄
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 顏色設定
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info() { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_docker() {
    info "檢查 Docker 環境..."
    if ! command -v docker &> /dev/null; then
        error "未檢測到 docker 指令。請先安裝 Docker (https://docs.docker.com/get-docker/)。"
        exit 1
    fi
    if ! docker compose version &> /dev/null; then
        error "未檢測到 docker compose 插件。請升級 Docker 或安裝 Docker Compose。"
        exit 1
    fi
}

init_files() {
    info "檢查設定檔與憑證目錄..."
    if [ ! -d "certs" ]; then
        mkdir -p certs
        success "已建立憑證放置目錄: ./certs/ (請將玉山憑證 .p12 放入此目錄)"
    fi

    if [ ! -f "esun-config.ini" ]; then
        if [ -f "esun-config.ini.example" ]; then
            cp esun-config.ini.example esun-config.ini
            success "已從 esun-config.ini.example 自動初始化 esun-config.ini (請編輯填寫您的帳號與 API 金鑰)"
        fi
    fi

    if [ ! -f ".env" ]; then
        if [ -f ".env.docker.example" ]; then
            cp .env.docker.example .env
            success "已從 .env.docker.example 自動初始化 .env (請編輯填寫您的玉山登入密碼與憑證密碼)"
        fi
    fi
}

action_up() {
    check_docker
    init_files

    info "以全容器化模式啟動 Shioaji Pro Web 與 esun-bridge 容器..."
    docker compose up -d --build

    info "等待服務就緒 (3 秒)..."
    sleep 3

    action_status
}

action_down() {
    info "正在停止 Docker 容器..."
    docker compose down
    success "所有容器已停止。"
}

action_status() {
    echo ""
    echo -e "${CYAN}─────────────────────────── [容器運行狀態] ───────────────────────────${NC}"
    docker compose ps

    echo ""
    echo -e "${CYAN}─────────────────────────── [服務連線檢測] ───────────────────────────${NC}"
    WEB_URL="http://localhost:${PORT}"
    HEALTH_URL="http://localhost:${PORT}/esun/health"

    if curl -s -f -m 5 "${WEB_URL}" > /dev/null 2>&1; then
        success "Web 終端 (Nginx): 連線正常 [HTTP 200] -> ${WEB_URL}"
    else
        warn "Web 終端 (Nginx): 無法連線至 ${WEB_URL} 或尚未就緒"
    fi

    if HEALTH_RES=$(curl -s -m 5 "${HEALTH_URL}" 2>/dev/null); then
        success "玉山 Sidecar (/esun/health): 連線正常 [HTTP 200]"
        echo "  - 回應內容: ${HEALTH_RES}"
    else
        warn "玉山 Sidecar (/esun/health): 無法連線至 ${HEALTH_URL}"
    fi

    echo -e "${CYAN}────────────────────────────────────────────────────────────────────────${NC}"
    echo -e "💡 提示："
    echo -e "   - 瀏覽器開啟交易終端: ${GREEN}${WEB_URL}${NC}"
    echo -e "   - 檢視即時容器日誌:   ${CYAN}docker compose logs -f${NC}"
    echo -e "   - 停止所有服務:       ${CYAN}./scripts/deploy-docker.sh down${NC}\n"
}

action_logs() {
    docker compose logs -f
}

case "$ACTION" in
    up)
        action_up
        ;;
    down)
        action_down
        ;;
    restart)
        action_down
        action_up
        ;;
    status)
        action_status
        ;;
    logs)
        action_logs
        ;;
    *)
        echo "使用方式: $0 {up|down|restart|status|logs}"
        exit 1
        ;;
esac
