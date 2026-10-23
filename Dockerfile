# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the Vite Single-Page Application (SPA)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable pnpm via Corepack
RUN corepack enable && corepack prepare pnpm@latest --activate

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
# Stage 2: E.Sun Securities Trading Sidecar (Python Bridge)
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS esun-bridge

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
        "shioaji-cli==1.7.9" \
        "websocket-client>=1.5.1,<2" \
        "keyring==23.5.0" \
        "keyrings.cryptfile>=1.3.9,<2"

# Copy wheel packages, bridge server, config template, and install helper
COPY esun_trade*.whl ./
COPY server/esun_trade_server.py ./server/esun_trade_server.py
COPY esun-config*.ini.example ./
COPY deploy/install_sdk.py ./deploy/install_sdk.py

# Install E.Sun Python SDK:
# 1. Locate Linux wheel (esun_trade-2.2.0-linux.whl) and rename to valid PEP 427 format
#    (cp37-abi3-manylinux_2_17_x86_64.whl) so pip can install the native Rust C-extension.
# 2. If wheel is incompatible or only Windows wheel is present, extract python modules
#    into site-packages so esun_trade_server.py boots and serves /esun/health gracefully.
RUN python deploy/install_sdk.py \
    && python -c "from esun_trade.sdk import SDK; from esun_trade.order import OrderObject; print('E.Sun SDK verified!')"

ENV ESUN_SERVER_HOST=0.0.0.0
ENV ESUN_SERVER_PORT=8090
ENV ESUN_CONFIG_DIR=/app

EXPOSE 8090

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8090/esun/health || exit 1

CMD ["python", "-u", "server/esun_trade_server.py"]

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Nginx Web Server & Reverse Proxy (Runner)
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Template configuration for environment substitution at container startup
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

# Built web application artifacts from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Default environment variables
ENV PORT=8080
ENV SHIOAJI_API_UPSTREAM=http://host.docker.internal:21322
ENV ESUN_BRIDGE_UPSTREAM=http://esun-bridge:8090
ENV NGINX_ENVSUBST_FILTER="PORT|SHIOAJI_API_UPSTREAM|ESUN_BRIDGE_UPSTREAM"

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/ > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
