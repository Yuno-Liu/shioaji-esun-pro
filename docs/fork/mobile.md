# 手機版交易網頁：使用與 HTTPS 部署（fork 專屬）

手機入口是 `/mobile.html`（nginx 另提供短網址 `/m`）。完整規格見 [mobile-trading-spec.md](mobile-trading-spec.md)，
本文件只說明**怎麼讓手機用 HTTPS 連進來**，以及部署後的驗收方式。

## 為什麼一定要 HTTPS

手機交易頁只能在 **secure context**（`https://`，或本機 `localhost`／`127.0.0.1`）使用：

- 行情與回報串流依賴 Web Locks（`navigator.locks`）與 `BroadcastChannel` 決定由哪個分頁連線；Web Locks 只在 secure context 提供。
- 少了 Web Locks 時串流會 fail-closed，不建立連線，下單閘門 `assertTradingLive()` 會永遠擋單（規格 [§3.1](mobile-trading-spec.md#31-為什麼必須-https)）。
- 因此以區網 HTTP（例如 `http://192.168.1.20:8080/mobile.html`、`http://trade.lan:8080/mobile.html`）開啟時，頁面只會顯示
  「需要 HTTPS」說明與診斷資訊，**不建立任何連線、不顯示交易畫面**。

> [esun.md 的「區網存取」](esun.md#區網存取)（HTTP＋Basic Auth）只能讓手機開啟頁面，**無法下單**。

支援的瀏覽器：iOS／iPadOS 15.4 以上的 Safari、Android Chrome 最新兩版。

## 部署拓撲

```text
 iPhone Safari／Android Chrome
          │ HTTPS（secure context）
          ▼
 TLS 前端（Tailscale serve／Caddy）── 保留 Host ──┐
                                                  ▼
               nginx（shioaji-pro-web，127.0.0.1:8080）
               ├─ /mobile.html、/m、/index.html、/approval.html、靜態資產
               ├─ /api/  ─► 永豐 sidecar
               └─ /esun/ ─► 玉山 bridge（nginx 注入 X-Esun-Bridge-Token）
```

## 必要條件（三種方案共通）

1. **保留 Host**：TLS 前端轉給 nginx 時必須保留原始 `Host`（例如 `trade.example.ts.net`）。
   - nginx 只接受白名單 Host，其餘直接斷線（444）。
   - `/api/`、`/esun/` 要求 `Origin` 的主機等於 `Host`，否則回 403。
2. **加入白名單**：`.env` 的 `WEB_SERVER_NAMES` 加入手機使用的主機名；compose 會同時帶入玉山 bridge 的
   `ESUN_ALLOWED_HOSTS`，否則 `/esun/` 回 421。
3. **SSE 不可緩衝**：TLS 前端需即時 flush `text/event-stream`，讀取逾時 ≥ 120 秒（心跳 30 秒、看門狗 75 秒）。
4. **不對外開放**：維持 `WEB_BIND=127.0.0.1`，只讓同機的 TLS 前端連 `127.0.0.1:8080`；不得設定路由器轉埠。
5. **存取控制**：方案 A 以 tailnet 存取控制為主；方案 B／C 建議同時啟用 Basic Auth（設定方式見
   [esun.md 的「區網存取」](esun.md#區網存取)）。iOS「加入主畫面」模式下的 Basic Auth 行為尚未驗證（⚠️）。

```dotenv
# .env — 只讓同機的 TLS 前端連到 nginx
WEB_BIND=127.0.0.1
# 手機實際使用的主機名（空白分隔）；同時成為 nginx server_name 與玉山 bridge 的 ESUN_ALLOWED_HOSTS
WEB_SERVER_NAMES=trade.lan
```

修改 `.env` 後重新建立容器：`docker compose up -d`。

## 方案 A（建議）：Tailscale

主機與手機加入同一個 tailnet，使用公開信任的憑證，不開放任何埠，外出時也能使用。

1. 在 Tailscale 管理介面啟用 **MagicDNS** 與 **HTTPS Certificates**。
2. 主機與手機都安裝 Tailscale 並登入同一個 tailnet。
3. `.env` 設定 `WEB_BIND=127.0.0.1`，`WEB_SERVER_NAMES` 加入主機的 ts.net 名稱（例如 `trade.example.ts.net`），然後 `docker compose up -d`。
4. 在主機上把 HTTPS 轉到 nginx：
   ```bash
   tailscale serve --bg http://127.0.0.1:8080
   tailscale serve status   # 確認 https://<機器>.<tailnet>.ts.net 已轉到 127.0.0.1:8080
   ```
5. 手機開啟 `https://<機器>.<tailnet>.ts.net/mobile.html`（或 `/m`）。

> ⚠️ 尚未驗證 `tailscale serve` 轉送時是否保留 ts.net 的 `Host`（規格 §16 Q1）。若 nginx 回 444（連線被關閉）或
> `/api/` 回 403，代表 Host 沒有保留：改用方案 B，或讓 Tailscale 轉到同機的 Caddy、再由 Caddy 轉給 nginx。

撤銷存取：在 tailnet 管理介面移除或停用遺失的手機。

## 方案 B：Caddy（`tls internal`）

同機執行 Caddy，以 Caddy 內建 CA 簽發憑證；Caddy 預設保留 `Host`，SSE 可即時 flush。

1. 複製範例並把主機名改成自己的（需與 `WEB_SERVER_NAMES` 相同，且手機能解析到這台主機）：
   ```bash
   cp deploy/Caddyfile.mobile.example ./Caddyfile
   caddy run --config ./Caddyfile
   ```
   範例內容見 [`deploy/Caddyfile.mobile.example`](../../deploy/Caddyfile.mobile.example)：`tls internal`、
   `reverse_proxy 127.0.0.1:8080` 並設定 `flush_interval -1`。
2. 手機安裝並**完全信任** Caddy 根憑證（Caddy 資料目錄的 `pki/authorities/local/root.crt`）：
   - iOS：安裝描述檔後，到「設定 → 一般 → 關於本機 → 憑證信任設定」開啟完全信任。
   - Android：「設定 → 安全性 → 加密與憑證 → 安裝憑證 → CA 憑證」。
3. 手機開啟 `https://trade.lan/mobile.html`。

## 方案 C：nginx 直接終結 TLS

在 `deploy/nginx.conf.template` 增加 TLS listener（`listen <port> ssl;`、`ssl_certificate`、`ssl_certificate_key`），
並以 `docker-compose.override.yml` 唯讀掛載憑證。少一個元件，但需要修改 fork 的部署檔，憑證信任問題同方案 B。
修改時須保留既有的 Host 白名單、Origin／`Sec-Fetch-Site` 檢查與安全標頭，並以 `nginx -t` 驗證。

## 驗收清單（Phase 0）

- [ ] 手機開啟 `https://<主機名>/mobile.html`，診斷區顯示 `isSecureContext = true`、`navigator.locks` 可用。
- [ ] 10 秒內狀態列顯示「LIVE」。
- [ ] 帶不符的 Origin 呼叫 `/api/v1/info` 回 403；不在白名單的 Host 被拒（444）。
- [ ] 主機以外的區網裝置無法直接連到 `:8080`。
- [ ] 以區網 HTTP 開啟 `/mobile.html` 時只顯示「需要 HTTPS」說明，瀏覽器開發工具看不到任何 `/api/`、`/esun/` 請求。

## 手機版的限制

- 不提供觸價、括號（停損停利）、條件單與背景執行：手機分頁切到背景會被暫停，這些前端引擎不會觸發。
- 每一筆手動委託都經確認面板，且無法關閉；回到前景後會先重新同步（狀態列顯示「同步中」）才允許新單。
- 風控鎖只對這個瀏覽器有效，沒有伺服器端總開關。
- 完整清單見規格 [§12](mobile-trading-spec.md#12--不提供清單)。

## 開發

`pnpm dev` 後開啟 `http://127.0.0.1:5173/mobile.html`（`127.0.0.1` 屬於 secure context）。建置手機入口：

```bash
pnpm exec tsc -b && pnpm exec vite build --config vite.fork.config.ts   # 產出 dist/index.html、approval.html、mobile.html
```
