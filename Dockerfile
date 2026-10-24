# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the Vite Single-Page Application (SPA)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# pnpm 主版本與上游 CI（pnpm/action-setup version: 10）一致；釘選確切版本
# 讓映像建置可重現（不在 package.json 加 packageManager，以免與上游 CI 的
# action-setup 版本設定衝突）
ARG PNPM_VERSION=10.34.6
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# Cache dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy application source files
COPY tsconfig*.json vite.config.ts index.html approval.html SHIOAJI_VERSION ./
COPY public ./public
COPY schemas ./schemas
COPY src ./src

# Build production assets into /app/dist
RUN pnpm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: SinoPac Shioaji API server (行情 sidecar)
# 版本唯一來源為 repo 根目錄 SHIOAJI_VERSION（與上游 CI／dev-api.sh 相同），
# 並與 esun-bridge 分開建置：修改玉山橋接不會連帶重建永豐行情容器。
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS shioaji

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY SHIOAJI_VERSION /tmp/SHIOAJI_VERSION
RUN SHIOAJI_CLI_VERSION="$(tr -d 'v[:space:]' < /tmp/SHIOAJI_VERSION)" \
    && test -n "$SHIOAJI_CLI_VERSION" \
    && pip install --no-cache-dir "shioaji-cli==${SHIOAJI_CLI_VERSION}" \
    && shioaji --version

CMD ["shioaji", "server", "start", "--no-open"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: E.Sun Securities Trading Sidecar (Python Bridge)
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS esun-bridge

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 釘選的執行期依賴（版本與既有可運作映像一致）
COPY deploy/requirements-esun-bridge.txt ./deploy/requirements-esun-bridge.txt
RUN pip install --no-cache-dir -r deploy/requirements-esun-bridge.txt

# E.Sun SDK wheels（保留 repo 內既有檔名）＋ SHA256 校驗檔與安裝程式
COPY esun_trade*.whl ./
COPY deploy/install_sdk.py deploy/esun_trade.sha256 ./deploy/

# install_sdk.py：先以 deploy/esun_trade.sha256 驗證 wheel 完整性，再依 wheel
# 內 WHEEL 檔的 Tag 挑選符合目前平台的 wheel、以合法 PEP 427 檔名安裝。
# 任何一步失敗（雜湊不符、無相容 wheel、pip 失敗）都會讓建置失敗；
# 下一行的 import 會載入原生模組 _trade_core，缺少時同樣讓建置失敗。
RUN python deploy/install_sdk.py \
    && python -c "from esun_trade.sdk import SDK; from esun_trade.order import OrderObject; print('E.Sun SDK verified!')" \
    && rm -f esun_trade*.whl

# 整個 server/ 目錄（橋接可能拆成多個模組）與設定檔範本
COPY server ./server
COPY esun-config*.ini.example ./

# 以非 root 使用者執行；/app/state 供具名 volume 掛載（登入熔斷狀態持久化），
# 具名 volume 首次建立時會沿用此目錄的擁有者
RUN groupadd --system --gid 10001 esun \
    && useradd --uid 10001 --gid esun --create-home --home-dir /home/esun esun \
    && mkdir -p /app/state \
    && chown esun:esun /app/state

ENV HOME=/home/esun
ENV ESUN_SERVER_HOST=0.0.0.0
ENV ESUN_SERVER_PORT=8090
ENV ESUN_CONFIG_DIR=/app
ENV ESUN_STATE_DIR=/app/state

USER esun

EXPOSE 8090

# /esun/livez：免驗證、無副作用（不呼叫 SDK、不改狀態）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS -o /dev/null "http://127.0.0.1:${ESUN_SERVER_PORT:-8090}/esun/livez" || exit 1

CMD ["python", "-u", "server/esun_trade_server.py"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Nginx Web Server & Reverse Proxy (Runner)
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.30-alpine AS runner

# Template configuration for environment substitution at container startup
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf

# Built web application artifacts from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Default environment variables（envsubst 只替換「已定義」且名稱符合
# NGINX_ENVSUBST_FILTER 的變數，所以模板用到的每個變數都要有預設值）
ENV PORT=8080
ENV SHIOAJI_API_UPSTREAM=http://host.docker.internal:21322
ENV ESUN_BRIDGE_UPSTREAM=http://esun-bridge:8090
ENV ESUN_BRIDGE_TOKEN=
ENV WEB_SERVER_NAMES=
ENV WEB_BASIC_AUTH=off
# 讓官方 entrypoint 由 /etc/resolv.conf 匯出 NGINX_LOCAL_RESOLVERS，
# /esun/ 以 resolver 在執行期解析上游（橋接未啟動或 IP 改變都不會讓 nginx 起不來）
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
ENV NGINX_ENVSUBST_FILTER="^(PORT|SHIOAJI_API_UPSTREAM|ESUN_BRIDGE_UPSTREAM|ESUN_BRIDGE_TOKEN|WEB_SERVER_NAMES|WEB_BASIC_AUTH|NGINX_LOCAL_RESOLVERS)\$"

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
