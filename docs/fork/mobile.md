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
   - 永豐 sidecar 自己只接受本機 `Host`／`Origin`（否則回 403「Host is not a loopback address」）。
     nginx 完成上述檢查後，轉給 sidecar 時一律改用 `Host: 127.0.0.1` 並移除 `Origin`
     （`deploy/nginx.conf.template`）；玉山 bridge 則保留原始 Host 與 Origin，由它自己比對。
2. **加入白名單**：`.env` 的 `WEB_SERVER_NAMES` 加入手機使用的主機名；compose 會同時帶入玉山 bridge 的
   `ESUN_ALLOWED_HOSTS`，否則 `/esun/` 回 421。
3. **SSE 不可緩衝**：TLS 前端需即時 flush `text/event-stream`，讀取逾時 ≥ 120 秒（心跳 30 秒、看門狗 75 秒）。
4. **不對外開放**：維持 `WEB_BIND=127.0.0.1`，只讓同機的 TLS 前端連 `127.0.0.1:8080`；不得設定路由器轉埠。
5. **存取控制**：方案 A 以 tailnet 存取控制為主；方案 B／C **必須**啟用 Basic Auth。原因：nginx 會替通過
   Host／Origin 檢查的 `/esun/` 請求注入玉山 token，而不帶 `Origin` 的請求（例如 curl）會被放行，區網上任何能連到
   TLS 前端的裝置都能直接送 `/esun/` 請求下單、刪單；Basic Auth 是方案 B／C 唯一的使用者驗證。
   方案 B 在 Caddy 設定 `basic_auth`（見下方範例）；方案 C 用 nginx 的 `WEB_BASIC_AUTH`（設定方式見
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

> ✅ 已實測（Tailscale 1.104，2026-11-05）：`tailscale serve` 轉送時保留 ts.net 的 `Host`（規格 §16 Q1）。
> 部署後可在主機上驗證（只讀取，不會下單）：
>
> ```powershell
> # 預期 200：Origin 與 Host 相同
> curl.exe -s -o NUL -w "%{http_code}`n" -H "Origin: https://<機器>.<tailnet>.ts.net" https://<機器>.<tailnet>.ts.net/api/v1/info
> # 預期 403：Origin 是別的網站
> curl.exe -s -o NUL -w "%{http_code}`n" -H "Origin: https://evil.example" https://<機器>.<tailnet>.ts.net/api/v1/info
> ```
>
> 第一行若是 `000`（nginx 以 444 斷線），代表 `WEB_SERVER_NAMES` 沒有這個主機名或容器尚未重建。

撤銷存取：在 tailnet 管理介面移除或停用遺失的手機。

> ⚠️ **只給自己用**：nginx 會替通過 Host／Origin 檢查的請求代填玉山 token，方案 A 沒有另外的使用者驗證，
> 能連到這台主機 443 的 tailnet 裝置都能下單、刪單（安全稽核 F1，2026-11-06）。
>
> - **不要**執行 `tailscale funnel`：funnel 會把頁面公開到網際網路。
> - 不要把這台主機分享給其他 tailnet 或其他使用者。
> - 在 Tailscale 管理介面的存取控制（ACL／grants）只允許自己的帳號或裝置連到這台主機的 443。

## 方案 B：Caddy（`tls internal`）

同機執行 Caddy，以 Caddy 內建 CA 簽發憑證；Caddy 預設保留 `Host`，SSE 可即時 flush。

1. 複製範例並把主機名改成自己的（需與 `WEB_SERVER_NAMES` 相同，且手機能解析到這台主機）：
   ```bash
   cp deploy/Caddyfile.mobile.example ./Caddyfile
   caddy run --config ./Caddyfile
   ```
   範例內容見 [`deploy/Caddyfile.mobile.example`](../../deploy/Caddyfile.mobile.example)：`tls internal`、
   `basic_auth`、`reverse_proxy 127.0.0.1:8080` 並設定 `flush_interval -1`。
   **必須**把 `basic_auth` 的佔位字串換成 `caddy hash-password` 產生的雜湊；
   Caddy 2.8 以前的指令名稱是 `basicauth`。
2. 手機安裝並**完全信任** Caddy 根憑證（Caddy 資料目錄的 `pki/authorities/local/root.crt`）：
   - iOS：安裝描述檔後，到「設定 → 一般 → 關於本機 → 憑證信任設定」開啟完全信任。
   - Android：「設定 → 安全性 → 加密與憑證 → 安裝憑證 → CA 憑證」。
3. 手機開啟 `https://trade.lan/mobile.html`。

## 方案 C：nginx 直接終結 TLS

在 `deploy/nginx.conf.template` 增加 TLS listener（`listen <port> ssl;`、`ssl_certificate`、`ssl_certificate_key`），
並以 `docker-compose.override.yml` 唯讀掛載憑證。少一個元件，但需要修改 fork 的部署檔，憑證信任問題同方案 B。
**必須**同時以 `WEB_BASIC_AUTH` 與 htpasswd 啟用 Basic Auth（原因同上方必要條件 5）。
修改時須保留既有的 Host 白名單、Origin／`Sec-Fetch-Site` 檢查與安全標頭，並以 `nginx -t` 驗證。

## nginx 安全設定（2026-11-06 安全稽核後補強）

`deploy/nginx.conf.template` 與 `deploy/nginx-security-headers.conf`，靜態檢查在 `deploy/test_nginx_template.py`：

- **安全標頭**：所有回應都有 `X-Frame-Options`、`frame-ancestors 'none'`、`nosniff`、`Referrer-Policy`，另加
  `Permissions-Policy`（停用相機、麥克風、定位、付款、USB；**不**限制螢幕常亮 `screen-wake-lock`）。
  `/mobile.html` 另加 `Cross-Origin-Opener-Policy: same-origin`。有自己 `add_header` 的 location 都重新 include 安全標頭
  （nginx 的 `add_header` 不繼承外層）。
- **HSTS 只送給 `*.ts.net`**（`max-age=31536000`，不含 `includeSubDomains`、`preload`）。
  ⚠️ 瀏覽器收過一次後，一年內都會把 `http://<機器>.<tailnet>.ts.net:8080` 這類網址強制改成 HTTPS，請一律用 `https://` 開啟。
  localhost、區網主機名不送 HSTS。
- **`/api/` 回應一律 `Cache-Control: no-store`**：帳務、持倉 JSON 不留在瀏覽器 HTTP 快取。
- **不把帳密與 cookie 轉給上游**：`/api/`、`/esun/` 轉送前清掉 `Authorization`（Basic Auth 帳密）與 `Cookie`。
  玉山 token 照常由 nginx 注入。
- **方法白名單與大小上限**：
  - `/api/` 只接受 GET、POST、PUT、DELETE，其他方法回 403；body 上限 256 KiB。
  - `/api/` 的 POST、PUT 以及帶 body 的 DELETE 必須是 `application/json`，表單、`text/plain` 都回 415，不轉給 sidecar。
  - `/esun/` 只接受 GET、POST（其他回 403），body 上限 64 KiB（與 bridge 相同），超過回 413。
  - 前端（`src/lib/api.ts`、`src/lib/esun/http-driver.ts`）只用這些方法與 JSON，桌面網頁版與手機版都不受影響。
- **長快取**：帶雜湊的資產（含 rolldown 為避開同名而產生的 9 碼雜湊，例如 `vendor-CjBHE94L2.js`）一年 immutable；
  `public/` 內無雜湊的檔案（`apple-touch-icon.png` 等）每次重新驗證。建置後可用實際輸出檢查：
  `SHIOAJI_WEB_DIST=<dist 目錄> python -I -m unittest discover -s deploy -p test_nginx_template.py`。

部署後在主機上驗證（只讀取，不會下單）：

```powershell
# 預期有 Cross-Origin-Opener-Policy、Permissions-Policy；ts.net 主機另有 Strict-Transport-Security
curl.exe -sI https://<機器>.<tailnet>.ts.net/mobile.html
# 預期 200 且有 Cache-Control: no-store（以 GET 讀取標頭，不下載內容）
curl.exe -s -D - -o NUL -H "Origin: https://<機器>.<tailnet>.ts.net" https://<機器>.<tailnet>.ts.net/api/v1/info
```

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
