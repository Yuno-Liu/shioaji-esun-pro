#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Shioaji Pro Web — Docker 一鍵部署管理腳本 (Linux / macOS / Git Bash)
# 首次執行會自動在 .env 產生 ESUN_BRIDGE_TOKEN（不會顯示於畫面）。
# ─────────────────────────────────────────────────────────────────────────────

set -eu

# 切換至專案根目錄（測試時可用 DEPLOY_PROJECT_ROOT 指定）
PROJECT_ROOT="${DEPLOY_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
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
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# 讀取 .env 中的值（去掉前後空白與引號）；不存在時輸出空字串
dotenv_value() {
    [ -f .env ] || return 0
    sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)$/\1/p" .env \
        | tail -n 1 | tr -d '\r' | sed -E "s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"
}

# compose 的變數優先序：shell 環境變數 > .env > 預設值
effective_setting() {
    local name="$1" default="$2" value
    value="$(printenv "$name" 2>/dev/null || true)"
    [ -n "$value" ] || value="$(dotenv_value "$name")"
    [ -n "$value" ] || value="$default"
    printf '%s' "$value"
}

generate_token() {
    if command -v openssl > /dev/null 2>&1; then
        openssl rand -hex 32
    else
        od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    fi
}

# 若 .env 沒有（或為空的）ESUN_BRIDGE_TOKEN，產生 32 bytes 隨機 token 寫入；不輸出 token 內容
ensure_bridge_token() {
    if [ ! -f .env ]; then
        warn "找不到 .env，略過 ESUN_BRIDGE_TOKEN 產生"
        return 0
    fi
    # 與 docker compose 相同：同名鍵重複時最後一行生效（dotenv_value 讀最後一行，這裡也改寫最後一行）
    local token_re='^[[:space:]]*ESUN_BRIDGE_TOKEN[[:space:]]*=' count last
    count="$(grep -Ec "$token_re" .env || true)"
    if [ "$count" -gt 1 ]; then
        warn "偵測到 .env 有重複的 ESUN_BRIDGE_TOKEN（${count} 行），以最後一行為準（與 docker compose 相同），請刪除多餘的行"
    fi
    if [ -n "$(dotenv_value ESUN_BRIDGE_TOKEN)" ]; then
        return 0
    fi

    local token tmp
    token="$(generate_token)"
    if [ "${#token}" -ne 64 ]; then
        error "無法產生 ESUN_BRIDGE_TOKEN"
        return 1
    fi
    tmp="$(mktemp "${TMPDIR:-/tmp}/shioaji-env.XXXXXX")"
    if [ "$count" -gt 0 ]; then
        last="$(grep -En "$token_re" .env | tail -n 1 | cut -d: -f1)"
        TOKEN="$token" awk -v BINMODE=3 -v last="$last" '
            FNR == last {
                cr = ($0 ~ /\r$/) ? "\r" : ""
                print "ESUN_BRIDGE_TOKEN=" ENVIRON["TOKEN"] cr
                next
            }
            { print }
        ' .env > "$tmp"
    else
        cat .env > "$tmp"
        if [ -s "$tmp" ] && [ "$(tail -c 1 "$tmp" | od -An -c | tr -d ' ')" != '\n' ]; then
            printf '\n' >> "$tmp"
        fi
        printf '# 由 deploy-docker 自動產生：nginx 以此 token 存取玉山橋接（瀏覽器不持有）\n' >> "$tmp"
        printf 'ESUN_BRIDGE_TOKEN=%s\n' "$token" >> "$tmp"
    fi
    # 以 cat 覆寫，保留 .env 原本的權限與擁有者
    cat "$tmp" > .env
    rm -f "$tmp"
    token=""
    success "已在 .env 產生 ESUN_BRIDGE_TOKEN（內容不顯示）"
}

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

    # Check for dedicated config files
    has_dedicated=0
    for cand in esun-config.simulation.ini esun-config.sim.ini esun-config.test.ini esun-config.production.ini esun-config.prod.ini; do
        if [ -f "$cand" ]; then
            has_dedicated=1
            break
        fi
    done

    # If dedicated config exists and esun-config.ini is identical to esun-config.ini.example, remove placeholder
    if [ "$has_dedicated" -eq 1 ] && [ -f "esun-config.ini" ] && [ -f "esun-config.ini.example" ]; then
        if cmp -s esun-config.ini esun-config.ini.example; then
            rm -f esun-config.ini
            info "已偵測到專用環境設定檔，自動移除未編輯的預設範本 esun-config.ini"
        fi
    fi

    has_any=0
    for cand in esun-config.simulation.ini esun-config.sim.ini esun-config.test.ini esun-config.production.ini esun-config.prod.ini esun-config.ini; do
        if [ -f "$cand" ]; then
            has_any=1
            break
        fi
    done

    if [ "$has_any" -eq 0 ]; then
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

    ensure_bridge_token
}

action_up() {
    check_docker
    init_files

    info "以全容器化模式啟動 Shioaji Pro Web 與 esun-bridge 容器..."
    if ! docker compose up -d --build; then
        error "docker compose up 失敗，請檢查上方建置訊息（舊容器狀態不代表新版已部署）。"
        exit 1
    fi

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
    WEB_PORT_EFFECTIVE="$(effective_setting WEB_PORT 8080)"
    WEB_URL="http://localhost:${WEB_PORT_EFFECTIVE}"
    HEALTH_URL="http://localhost:${WEB_PORT_EFFECTIVE}/esun/health"

    if curl -s -f -m 5 "${WEB_URL}" > /dev/null 2>&1; then
        success "Web 終端 (Nginx): 連線正常 [HTTP 200] -> ${WEB_URL}"
    else
        warn "Web 終端 (Nginx): 無法連線至 ${WEB_URL} 或尚未就緒"
    fi

    # 只顯示登入狀態與環境，不輸出帳號或憑證資訊
    if HEALTH_RES="$(curl -s -f -m 5 "${HEALTH_URL}" 2>/dev/null)"; then
        LOGGED_IN="$(printf '%s' "$HEALTH_RES" | sed -n -E 's/.*"loggedIn"[[:space:]]*:[[:space:]]*(true|false).*/\1/p')"
        ENVIRONMENT="$(printf '%s' "$HEALTH_RES" | sed -n -E 's/.*"environment"[[:space:]]*:[[:space:]]*"([A-Z_]*)".*/\1/p')"
        success "玉山 Sidecar (/esun/health): 連線正常"
        echo "  - 登入狀態: ${LOGGED_IN:-未知}"
        echo "  - 運行環境: ${ENVIRONMENT:-未知}"
    else
        warn "玉山 Sidecar (/esun/health): 無法連線或尚未就緒 -> ${HEALTH_URL}"
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

main() {
    local action="${1:-up}"
    case "$action" in
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
}

# 被 source（例如測試）時不執行動作
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
