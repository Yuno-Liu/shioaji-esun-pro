<!-- fork 說明區塊：從檔案開頭到「以下為上游 README 原文」為止。上游原文一個位元組都不改，同步上游時只有這一段可能衝突（docs/fork/upstream-sync.md）。 -->

# Shioaji Esun Pro（fork 說明）

> [!NOTE]
> 本專案是 [Sinotrade/shioaji-pro-app](https://github.com/Sinotrade/shioaji-pro-app)（Shioaji Pro）的 fork：**Shioaji Esun Pro**（[GitHub](https://github.com/Yuno-Liu/shioaji-esun-pro)）。從這裡到「以下為上游 README 原文」是 fork 的完整介紹與部署說明；之後是上游 README 原文，沒有任何修改。

> [!WARNING]
> **不要把 8080／8090 暴露到區網或網際網路。** 預設 web 只綁 `127.0.0.1`，玉山橋接（8090）不發佈到主機。能連到 nginx 的人就能下單。區網存取必須同時設定 `WEB_BIND`、`WEB_SERVER_NAMES` 並啟用 Basic Auth（`WEB_BASIC_AUTH`），見 [docs/fork/esun.md](docs/fork/esun.md#區網存取)；手機請改走 HTTPS（見下方「手機版」），不要開放路由器轉埠。

## 這是什麼

上游 Shioaji Pro 是以永豐 Shioaji HTTP API＋SSE 打造的台股／期權交易終端（React＋Vite）。本 fork 在上游之上加入：

- **玉山證券股票下單與帳務**：以 Python 橋接（`server/esun_trade_server.py`，包裝官方 SDK `esun_trade` 2.2.0）提供 `/esun/*` REST 與委託回報 SSE。玉山只處理**股票**；期貨／選擇權仍走永豐。頂欄可切換玉山或永豐帳號下單。
- **Docker 網頁版**：nginx（前端＋反向代理）＋永豐 sidecar（`shioaji server`）＋玉山橋接，一個指令部署。
- **手機交易網頁**：`/m`（即 `/mobile.html`），經 HTTPS 在手機上看盤與下單。

行情一律來自永豐 Shioaji（玉山只負責股票委託與帳務），所以永豐 API 金鑰是必要的。下方上游 README 提到的桌面 App 安裝檔是**上游**發行的版本，不含本 fork 的玉山整合與手機版；本 fork 以 Docker 網頁版使用。

## 功能總覽

**桌面網頁版**（`http://127.0.0.1:8080/`）

- 上游全部功能：即時行情、K 線、五檔、閃電下單、圖表點價下單、觸價與停損停利、自訂版面等（見下方上游「Features 功能」）。
- 玉山：新單、改價、減量、刪單、庫存、銀行餘額、交割款、已實現損益、委託／成交回報；頂欄「券商／帳號／環境」選單切換帳號、切換玉山測試／正式環境（切正式需確認），登入失效時可重新連線。
- 修正上游的信用交易缺陷（融券買進回補），細節見 [upstream-sync.md](docs/fork/upstream-sync.md)。

**手機版**（`https://<你的主機名>/m`）：底部六個分頁。

| 分頁 | 內容 |
| --- | --- |
| 自選 | 分段［自選｜排行｜持倉］；自選群組、搜尋、迷你走勢、編輯與排序；清單最後固定有「股期近月」「股期遠月」（一般＋小型股票期貨，自動產生、不能編輯）；清單可依股票代號、股價、漲幅%、漲跌排序 |
| 交易 | 走勢／1分／5分／15分／60分／日 圖表、技術指標（主圖最多 4 個、副圖最多 2 個，含當沖／波段／長線範本）、走勢副圖（分時買賣力、大單／小單買賣力）；五檔／明細／公司；買進／賣出 |
| 市場 | ［產業流向｜盤中異動］，只讀、沒有下單入口 |
| 委託 | 未成交／已成交／全部／成交；改價、減量、刪單、勾選批次刪單、全部刪單 |
| 持倉 | 帳戶與市場篩選、排序、詳細｜精簡檢視；平倉、加碼、多選市價出清 |
| 帳戶 | 今日交易額度、帳號切換、資金、交割行事曆、已實現損益（今日／本週／本月／近 30 天／自訂，最長 180 天）、玉山帳務概覽、預收券款／圈存（永豐）、風控、交易成本、連線、伺服器、顯示、本裝置、診斷 |

手機版的交易安全規則：

- 每筆新單、改價、減量、刪單、平倉與批次出清，都要先在面板預覽，再**滑動確認**才送出。
- 「手動下單確認」在手機一律開啟，無法關閉。
- 交易圖表長按選價下單預設關閉（帳戶 › 本裝置開啟）；開啟後也只開下單面板，不會直接送單。
- 從背景回到前景時先重新同步（狀態列顯示「同步中」），完成後才允許新單；結果未知的委託不自動重送。
- 不提供觸價、停損停利、條件單（手機分頁在背景會被暫停）。完整清單見[規格 §12](docs/fork/mobile-trading-spec.md#12--不提供清單)。

## 架構

```text
 桌面瀏覽器 http://127.0.0.1:8080          手機 https://<你的主機名>（經 TLS 前端，見「手機版」）
                 │                                     │
                 ▼                                     ▼
 shioaji-pro-web（nginx；主機 ${WEB_BIND}:${WEB_PORT} → 容器 :8080）
  ├─ /                 桌面網頁版（index.html、approval.html）
  ├─ /m → /mobile.html 手機版
  ├─ /api/*  ─► shioaji-server（永豐 sidecar，127.0.0.1:21322，共用 web 的網路命名空間）─► 永豐
  └─ /esun/* ─► esun-bridge:8090（玉山橋接，只在 compose 內網；nginx 注入 X-Esun-Bridge-Token）─► 玉山
```

| compose 服務 | 容器名稱 | 建置 target | 連接埠 |
| --- | --- | --- | --- |
| `shioaji-pro-web` | `shioaji-pro-web` | `runner`（nginx） | 主機 `WEB_BIND:WEB_PORT`（預設 `127.0.0.1:8080`）→ 容器 `PORT`（8080） |
| `shioaji-server` | `shioaji-pro-sinopac` | `shioaji` | 不發佈；`network_mode: service:shioaji-pro-web`，只綁 `127.0.0.1:21322` |
| `esun-bridge` | `shioaji-pro-esun-bridge` | `esun-bridge` | 不發佈；compose 內網 `expose 8090` |

三個服務都有 healthcheck。永豐 sidecar 沒有金鑰時只待命並回報 unhealthy；玉山橋接停止時 web 照常運作，`/esun/` 回 502。

## 需求

| 項目 | 是否必要 | 說明 |
| --- | --- | --- |
| Docker（含 `docker compose` v2） | 必要 | Docker Desktop（Windows／macOS）或 Linux Docker Engine；前端在映像內建置，主機不需要 Node.js |
| PowerShell 7（`pwsh`）或 bash | 擇一 | `pnpm run docker:*` 會呼叫 `pwsh`；沒有 `pwsh` 時用 `./scripts/deploy-docker.sh`，Windows PowerShell 5.1 可直接執行 `.ps1` |
| 永豐 API Key／Secret Key | 必要 | 行情來源（[申請](https://www.sinotrade.com.tw/newweb/PythonAPIKey/)） |
| 永豐 CA 憑證（`.pfx`） | 選用 | 只有永豐**正式**環境下單才需要 |
| 玉山 API 設定檔、憑證（`.p12`）、登入密碼、憑證密碼 | 選用 | 不用玉山可以跳過：橋接仍會啟動，`/esun/health` 回報待配置項目，永豐行情與交易不受影響 |
| x86_64 主機 | 必要 | repo 只附 Linux x86_64 與 Windows x64 的 `esun_trade` wheel；在 ARM 主機（例如 Apple Silicon）建置 `esun-bridge` 映像會失敗，需自行取得對應 wheel |

## 部署步驟

**1. 取得程式碼**（之後所有 compose 指令都在這個專案根目錄執行）

```bash
git clone https://github.com/Yuno-Liu/shioaji-esun-pro.git
cd shioaji-esun-pro
```

**2. 放憑證到 `certs/`**：玉山憑證 `certs/esun_cert.p12`（使用玉山時）、永豐憑證 `certs/Sinopac.pfx`（只有永豐正式下單時）。目錄不存在時部署腳本會建立。

**3. 玉山設定檔**（不用玉山可略過）。建議同時放測試與正式兩份，頂欄才能切換；只放一份時另一個環境不可選。

```bash
cp esun-config.simulation.ini.example esun-config.simulation.ini   # 測試；別名 .sim.ini、.test.ini
cp esun-config.production.ini.example esun-config.production.ini   # 正式；別名 .prod.ini
```

PowerShell 用 `Copy-Item` 取代 `cp`。編輯 `[Api] Key`／`Secret`、`[User] Account`（`<帳號>`，11 碼或 7 碼）與 `[Cert] Path`（相對路徑以設定檔所在目錄為準，預設 `certs/esun_cert.p12`）。也可以只用單一 `esun-config.ini`（由 `[Core]` 判定環境），見 [esun.md「玉山設定檔」](docs/fork/esun.md#2-玉山設定檔)。

**4. 建立 `.env`**：`cp .env.docker.example .env`（部署腳本在沒有 `.env` 時會自動複製）。注意 Docker 部署用的是 `.env.docker.example`，`.env.example` 是上游開發用的範本。

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `SJ_API_KEY`、`SJ_SEC_KEY` | 空 | 永豐 API 金鑰（必填） |
| `SJ_PRODUCTION` | `false` | `true`＝永豐正式環境（需搭配 `SJ_CA_PATH`、`SJ_CA_PASSWD`） |
| `SJ_CA_PATH`、`SJ_CA_PASSWD` | 空 | 永豐憑證的容器內路徑（例如 `/app/certs/Sinopac.pfx`）與密碼 |
| `ESUN_ACCOUNT_PASSWORD`（或 `ESUN_PASSWORD`） | 空 | 玉山登入密碼；**連續輸錯 3 次會被玉山鎖帳（`AGA0000`）** |
| `ESUN_CERT_PASSWORD` | 空 | 玉山 `.p12` 憑證密碼 |
| `ESUN_BRIDGE_TOKEN` | 空 | nginx 存取橋接的共享 token；部署腳本自動產生（不顯示），瀏覽器不持有 |
| `WEB_BIND`、`WEB_PORT` | `127.0.0.1`、`8080` | web 在主機上綁定的位址與埠號 |
| `WEB_SERVER_NAMES` | 空 | 額外允許的 Host（空白分隔），同時成為 nginx `server_name` 與橋接的 `ESUN_ALLOWED_HOSTS`；手機與區網存取必填 |
| `WEB_BASIC_AUTH` | `off` | nginx Basic Auth 的 realm 名稱；`off` 為停用 |
| `ESUN_CONFIG_HOST_DIR` | `.` | 玉山設定檔所在的主機目錄（唯讀掛載進橋接） |
| `ESUN_BRIDGE_UPSTREAM`、`SHIOAJI_API_UPSTREAM` | `http://esun-bridge:8090`、`http://127.0.0.1:21322` | nginx 的上游位址，一般不需修改 |
| `PORT` | `8080` | nginx 容器內部監聽埠，一般不需修改 |

**5. 部署**（檢查 Docker、補齊 `.env`／設定檔／`certs/`、產生 token、建置並啟動三個服務）

```bash
pnpm run docker:deploy                    # 需要 pwsh；或 .\scripts\deploy-docker.ps1 -Action up（Windows PowerShell 5.1 也可）
./scripts/deploy-docker.sh up             # Linux／macOS／Git Bash
```

也可以 `docker compose up -d --build`，但不會自動產生 `ESUN_BRIDGE_TOKEN`。Windows 進階的宿主機橋接模式（`-HostBridge`）見 [esun.md](docs/fork/esun.md#啟動)。

**6. 驗證**

```bash
pnpm run docker:status                    # 或 ./scripts/deploy-docker.sh status；三個服務都應為 healthy
curl http://127.0.0.1:8080/api/v1/info    # 永豐 sidecar
curl http://127.0.0.1:8080/esun/health    # 玉山登入狀態、環境、待配置項目
```

瀏覽器開啟 <http://127.0.0.1:8080>（Windows 用 `localhost` 會先試 IPv6 而變慢，建議用 `127.0.0.1`）；<http://127.0.0.1:8080/m> 會轉到手機版（本機 `127.0.0.1` 屬於 secure context，可以在電腦上先試用）。

## 手機版

### 手機版部署設定

**為什麼一定要 HTTPS**：手機版的行情與回報串流依賴 Web Locks（`navigator.locks`），只在 secure context（`https://`，或本機 `localhost`／`127.0.0.1`）提供。以區網 HTTP（例如 `http://<區網IP>:8080/m`）開啟時，頁面只顯示「需要 HTTPS」說明，**不建立連線、無法下單**。支援 iOS／iPadOS 15.4 以上的 Safari 與 Android Chrome 最新兩版。

| 方案 | 做法 | 適用 |
| --- | --- | --- |
| **A．Tailscale（建議）** | `tailscale serve` 把 `https://<機器>.<tailnet>.ts.net` 轉到 `127.0.0.1:8080`；公開信任的憑證，不開放任何埠，外出也能用 | 大多數人 |
| B．Caddy | 同機執行 Caddy（`tls internal`），範本 [`deploy/Caddyfile.mobile.example`](deploy/Caddyfile.mobile.example)；手機需安裝並完全信任 Caddy 根憑證 | 只在區網使用 |
| C．nginx 直接終結 TLS | 修改 `deploy/nginx.conf.template` 加 TLS listener，以 `docker-compose.override.yml` 掛載憑證 | 進階；需維護 fork 部署檔 |

三種方案共通的 `.env` 設定：

```dotenv
WEB_BIND=127.0.0.1                     # nginx 仍只讓同機的 TLS 前端連線
WEB_SERVER_NAMES=<你的主機名>           # 手機使用的主機名，例如 <機器>.<tailnet>.ts.net；同時成為 ESUN_ALLOWED_HOSTS
```

改完 `.env` 執行 `docker compose up -d`。TLS 前端必須**保留原始 Host**、SSE 不可緩衝（讀取逾時 ≥ 120 秒）。缺少主機名時 nginx 直接斷線（444），`/esun/` 回 421。

方案 A 步驟（在 Tailscale 管理介面先啟用 MagicDNS 與 HTTPS Certificates，主機與手機登入同一個 tailnet）：

```bash
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status    # 確認 https://<機器>.<tailnet>.ts.net 已轉到 127.0.0.1:8080
```

> [!CAUTION]
> 方案 A 沒有另外的使用者驗證，能連到這台主機 443 的 tailnet 裝置都能下單。**不要**執行 `tailscale funnel`，不要把主機分享給其他人，並在 Tailscale 存取控制（ACL／grants）只允許自己的裝置連到 443。

**在手機上開啟**：`https://<你的主機名>/m`。iPhone 用 Safari「分享 → 加入主畫面」、Android 用 Chrome「加到主畫面」，會以獨立視窗開啟（只有 manifest，沒有 service worker，不做離線快取）。啟用 Basic Auth 時 iOS 主畫面模式能否登入尚未驗證。

**驗收**：帳戶頁「診斷」顯示 `isSecureContext = true` 且 `navigator.locks` 可用、10 秒內狀態列顯示「LIVE」、帶不符的 `Origin` 呼叫 `/api/v1/info` 回 403、主機以外的裝置連不到 `:8080`。完整步驟、curl 驗證與 nginx 安全設定見 [docs/fork/mobile.md](docs/fork/mobile.md)。

### 手機版 App 內設定

設定都在手機上的瀏覽器儲存（localStorage），不經伺服器。下表「與桌面共用」指：在**同一個瀏覽器、同一個網址**開啟桌面網頁版時讀寫同一份設定；手機與電腦是不同的瀏覽器，彼此不同步。「本裝置」表示只有手機版使用。

| 設定 | 位置 | 作用 | 範圍 |
| --- | --- | --- | --- |
| 主題 | 帳戶 › 顯示 | 深色／淺色（桌面設過自訂主題時另有「自訂」） | 與桌面共用（`sj-pro-theme`） |
| 漲跌配色 | 帳戶 › 顯示 | 台灣（紅漲綠跌）／國際（綠漲紅跌） | 與桌面共用（`sj-pro-theme`） |
| 字級 | 帳戶 › 顯示 | 小／標準／大；手機第一次開啟時預設「小」 | 與桌面共用（`sj-pro-theme`） |
| 降低透明度 | 帳戶 › 顯示 | 跟隨系統／開／關；開＝底部列與通知改實心、不模糊。iPhone Safari 不套用系統設定，請在這裡切換；低階 Android 第一次預設開 | 本裝置（`sj-mobile-ui-v1`） |
| 自選迷你走勢 | 帳戶 › 顯示 | 自選列顯示當日走勢；關閉時不讀 K 線 | 本裝置（`sj-mobile-watch-spark`） |
| 遮蔽金額 | 帳戶 › 顯示 | 餘額、損益、交割款以 ••••• 顯示 | 與桌面共用（`sj-pro-privacy-money`） |
| 遮蔽帳號 | 帳戶 › 顯示 | 帳號只露末兩碼 | 與桌面共用（`sj-pro-privacy-mode`） |
| 成交音效 | 帳戶 › 本裝置 | 成交提示音，可試聽；iPhone 需先觸控畫面一次，靜音模式與背景不響 | 與桌面共用（`sj-pro-sound`） |
| 成交震動 | 帳戶 › 本裝置 | 成交時短震；iPhone Safari 不支援 | 本裝置（`sj-mobile-device-v1`） |
| 介面觸覺回饋（Android） | 帳戶 › 本裝置 | 滑動確認到達門檻、長按、數量撞到上下限時輕震；預設開；iPhone 停用 | 本裝置（`sj-mobile-ui-v1`） |
| 螢幕常亮 | 帳戶 › 本裝置 | 前景時螢幕不關閉；需 iOS／iPadOS 16.4 以上 Safari 或 Android Chrome | 本裝置（`sj-mobile-device-v1`） |
| 一鍵鎖單 | 帳戶 › 風控 | 「立即鎖單」擋下所有新單；解除要在面板滑動確認 | 與桌面共用（`sj-pro-risk`）；沒有伺服器端總開關，不會同步到其他裝置 |
| 下單限制 | 帳戶 › 風控 | 單筆上限（張／口）、當日虧損上限（元），0＝不限制 | 與桌面共用（`sj-pro-risk`） |
| 手動下單確認 | 帳戶 › 風控 | 鎖定開啟、無法關閉；新單一律經確認面板，不看這個設定 | 手機啟動時會把 `sj-pro-risk` 的 `confirmManualOrders` 設回開啟，同一瀏覽器的桌面版也會跟著開啟 |
| 交易成本 | 帳戶 › 交易成本 | 手續費折數、融資年利率、借券費率（用於損益估算） | 與桌面共用（`sj-pro-trading-cost-v1`） |
| 帳號切換 | 帳戶 › 帳號，或頂端狀態列 | 選擇證券、期貨帳戶；不可交易（未簽署）的帳戶不可選；下單或確認進行中不能切換 | 與桌面共用（`sj-pro-accounts-selected`） |
| 玉山重新連線 | 帳戶 › 連線 | 登入失效時重新登入（先確認，60 秒冷卻）；玉山環境切換中不能按 | 不儲存 |
| 玉山環境切換 | 帳戶 › 連線 › 交易環境，或狀態列帳戶面板的［玉山模擬／正式切換］ | 模擬／正式（bridge 要有對應設定檔）；切正式要滑動確認，切模擬按確定；bridge 未連線、下單或確認面板開著、多選出清或刪改單進行中時不能切換 | 玉山 bridge（整台主機共用，桌面同步） |
| 自選列右側指標 | 自選 › 表頭切換鍵 | 漲跌幅／總量 | 本裝置（`sj-mobile-watch-metric`） |
| 自選群組順序 | 自選 › 編輯 › 排序群組 | 伺服器的自選清單沒有順序，順序只存在這台裝置 | 本裝置（`sj-mobile-watch-list-order-v1`） |
| 自選清單排序 | 自選 › 表頭排序鍵（含「持倉」分段） | 自訂順序（自己的清單預設；「持倉」分段為持倉順序）／股票代號（股期清單預設）／股價／漲幅%／漲跌，再點一次反向；只改顯示順序，不寫回自選清單、不改持倉 | 本裝置（`sj-mobile-watch-sort-v1`，依清單分別記住；持倉為 `pos:holdings`） |
| 產業流向排序 | 市場 › 產業流向 › 排序段 | 資金流向（預設）／近5分／漲跌幅／成交值，再點一次反向；沒有資料的產業排在最後 | 本裝置（`sj-mobile-sector-sort-v1`） |
| 持倉檢視 | 持倉 › 篩選列 | 詳細｜精簡（預設詳細） | 本裝置（`sj-mobile-positions-view`） |
| 圖表週期 | 交易 › 圖表 | 走勢／1分／5分／15分／60分／日 | 本裝置（`sj-mobile-chart-period`） |
| 技術指標 | 交易 › 圖表工具列「指標」 | 主圖最多 4、副圖最多 2，可調參數、套用範本 | 本裝置（`sj-mobile-indicators-v1`，與桌面指標分開） |
| 走勢副圖 | 指標面板（走勢模式） | 分時買賣力、大單／小單買賣力；大單門檻 100／300／500／1000／2000 萬（預設 500 萬）；開啟才下載當日逐筆，只限股票與 ETF | 本裝置（`sj-mobile-line-indicators-v1`） |
| 漲跌停範圍 | 走勢圖右側價格軸點一下 | Y 軸固定為［跌停, 漲停］，再點回到自動 | 只在本次使用期間，不儲存 |
| 圖表長按選價下單 | 帳戶 › 本裝置 | 開啟後長按交易圖表選價位，放開浮出「以此價買進／賣出」（只開下單面板）；關閉時長按只看價格；預設關 | 本裝置（`sj-mobile-device-v1`） |
| 盤中異動篩選 | 市場 › 盤中異動 | 規則家族（漲跌停、急漲跌、爆量、狀態）與市場（上市、上櫃） | 本裝置（`sj-mobile-signal-filters-v1`） |
| 已實現損益自訂區間 | 帳戶 › 已實現損益 | 起日／迄日，最長 180 天（含起訖日）；含玉山帳戶時每分鐘最多查 4 次 | 只在本次使用期間，不儲存 |

## 日常操作與更新

所有 compose 指令都要在**專案根目錄**（`.env` 所在處）執行。在其他目錄或 git worktree 執行時，compose 會用不同的專案名稱、讀不到 `.env`，產生另一組容器。

| 動作 | pnpm／PowerShell 7 | bash |
| --- | --- | --- |
| 部署／重新建置 | `pnpm run docker:deploy` | `./scripts/deploy-docker.sh up` |
| 狀態與健康檢查 | `pnpm run docker:status` | `./scripts/deploy-docker.sh status` |
| 即時日誌 | `pnpm run docker:logs`（`docker compose logs -f`） | `./scripts/deploy-docker.sh logs` |
| 停止 | `pnpm run docker:down` | `./scripts/deploy-docker.sh down` |
| 重新啟動 | `.\scripts\deploy-docker.ps1 -Action restart` | `./scripts/deploy-docker.sh restart` |

`deploy-docker.ps1` 另有 `-NoBuild`（不重新建置）、`-Port <埠>`、`-HostBridge`。修改 `.env` 後執行 `docker compose up -d` 套用。

**`git pull` 之後更新**：執行 `pnpm run docker:deploy`（或 `./scripts/deploy-docker.sh up`）重新建置並啟動三個服務；指令不指定服務時，compose 會在 web 重建後一併重建永豐 sidecar。只想重建 web（前端、手機版、nginx）時，指令裡 **web 與永豐 sidecar 一定要一起寫**：

```bash
docker compose up -d --build shioaji-pro-web shioaji-server
```

永豐 sidecar 使用 `network_mode: service:shioaji-pro-web`（共用 web 的網路命名空間）。指令只寫 web（例如 `docker compose up -d --build shioaji-pro-web`）時，compose 不會重建 sidecar，它還留在舊 web 的命名空間，nginx 連不到 `127.0.0.1:21322`，`/api/` 回 502。發生時執行 `docker compose up -d --force-recreate shioaji-pro-web shioaji-server` 讓兩者一起重建。

## 模擬與正式環境

> [!WARNING]
> **正式環境的委託是真實下單**，會動用真實資金與庫存。請先在永豐模擬／玉山測試環境完整驗證。桌面頂欄只要任一下單路由是正式就以紅色警示；手機在帳戶頁「伺服器」與狀態列顯示目前環境。

| 券商 | 模擬／測試 | 正式 | 如何切換 |
| --- | --- | --- | --- |
| 永豐 | `SJ_PRODUCTION=false`（預設） | `SJ_PRODUCTION=true`，並設定 `SJ_CA_PATH`、`SJ_CA_PASSWD` | 改 `.env` 後 `docker compose up -d`；UI 只顯示，不能切換 |
| 玉山 | `esun-config.simulation.ini` | `esun-config.production.ini` | 兩份都提供時，在桌面頂欄「券商／帳號／環境」選單或手機「帳戶 › 連線 › 交易環境」切換（切正式需確認） |

兩家的環境彼此獨立。`.env.docker.example` 的預設搭配是永豐模擬（取得即時行情）＋玉山負責股票下單。單一 `esun-config.ini` 由 `[Core] Entry` 判定環境，見 [context-esun.md](docs/fork/context-esun.md)。

## 安全須知

- **預設不對外**：web 只綁 `127.0.0.1`，玉山橋接不發佈到主機；nginx 只接受 `localhost`、`127.0.0.1` 與 `WEB_SERVER_NAMES`，並拒絕跨來源請求。nginx 是信任邊界：它會替通過檢查的請求代填玉山 token。
- **區網存取**：同時設定 `WEB_BIND`、`WEB_SERVER_NAMES`、`WEB_BASIC_AUTH`，並以 `docker-compose.override.yml` 唯讀掛載 htpasswd（[esun.md「區網存取」](docs/fork/esun.md#區網存取)）。Basic Auth 走明文 HTTP，手機在區網 HTTP 下也無法下單。
- **不要提交秘密**：`.env`、`esun-config*.ini`、`certs/`、`*.p12`、`*.pfx` 已列入 `.gitignore` 與 `.dockerignore`。密碼以環境變數傳入容器，有 Docker 權限的本機使用者可用 `docker inspect` 看到，請只在自己的電腦上部署。
- **玉山 API 限制由橋接把關**：登入失敗會熔斷且不自動重試（避免 3 次鎖帳），並限制登入與委託頻率、快取帳務查詢、已實現損益區間鉗位在 180 天內，見 [esun.md「玉山 API 官方限制與橋接防護」](docs/fork/esun.md#玉山-api-官方限制與橋接防護)。

## 排錯

```bash
docker compose ps                                                     # 三個服務的狀態
docker compose logs -f esun-bridge                                    # 或 shioaji-server、shioaji-pro-web
docker compose exec esun-bridge curl -s localhost:8090/esun/livez     # 直接檢查橋接（不經 nginx）
curl -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8080/esun/auth/reconnect   # 修正密碼後解除熔斷並重連
```

| 症狀 | 可能原因 |
| --- | --- |
| `shioaji-server` unhealthy、沒有行情 | `.env` 未填 `SJ_API_KEY`／`SJ_SEC_KEY` |
| 重建後 `/api/` 回 502 | 只重建了 web，見[日常操作與更新](#日常操作與更新) |
| curl 回 `000`、連線被直接關閉 | Host 不在白名單（nginx 444），檢查 `WEB_SERVER_NAMES` 並重建容器 |
| `/esun/` 回 421 | 手機或區網主機名沒有加入 `WEB_SERVER_NAMES` |
| 手機只顯示「需要 HTTPS」 | 用了 HTTP 網址，改用 TLS 前端的 `https://` 網址 |
| 手機顯示「伺服器未連線」 | 若剛改 `SJ_PRODUCTION` 請執行 `docker compose up -d`；否則用 `docker compose ps` 檢查服務與網路 |
| `/esun/health` 顯示 `loginLocked` | 密碼或憑證錯誤造成熔斷；修正後用上面的 reconnect 指令 |

更多指令見 [esun.md「常用管理與排錯指令」](docs/fork/esun.md#常用管理與排錯指令)。

## 開發

```bash
pnpm install
pnpm dev                 # http://127.0.0.1:5173（桌面）、http://127.0.0.1:5173/mobile.html（手機）
pnpm run esun-bridge     # 另開終端啟動玉山橋接（python server/esun_trade_server.py）
pnpm test                # vitest
```

開發伺服器把 `/api` 代理到 `http://127.0.0.1:21322`（可用 `VITE_API_TARGET` 改），`/esun` 代理到 `VITE_ESUN_BRIDGE_TARGET`（預設 `http://127.0.0.1:8090`）。細節見 [esun.md「開發模式」](docs/fork/esun.md#開發模式vite)、[mobile.md「開發」](docs/fork/mobile.md#開發) 與 [docs/DEV.md](docs/DEV.md)。

## 文件索引

| 文件 | 內容 |
| --- | --- |
| [docs/fork/esun.md](docs/fork/esun.md) | 玉山整合與 Docker 部署：架構、設定檔、`.env`、安全模型、區網存取、API 限制、排錯 |
| [docs/fork/context-esun.md](docs/fork/context-esun.md) | 玉山整合詞彙：橋接、環境與設定檔、session、委託、回報串流、帳務 |
| [docs/fork/mobile.md](docs/fork/mobile.md) | 手機版 HTTPS 部署（Tailscale／Caddy／nginx TLS）、nginx 安全設定、驗收清單 |
| [docs/fork/mobile-trading-spec.md](docs/fork/mobile-trading-spec.md) | 手機版交易規格：畫面、下單流程、API 對照、限制、安全模型、路線圖 |
| [docs/fork/mobile-design.md](docs/fork/mobile-design.md) | 手機版介面設計規格：design tokens、元件、各畫面、交易安全不變式 |
| [docs/fork/upstream-sync.md](docs/fork/upstream-sync.md) | 同步上游的流程、衝突熱點與檢查清單 |
| [docs/DEV.md](docs/DEV.md) | 上游的開發規範與流程（分支、PR、commit、品質基線） |

---

以下為上游 README 原文（未修改）。

# Shioaji Pro — 專業交易終端 Trading Terminal

**[官方網站 / Landing Page](https://sinotrade.github.io/shioaji-pro-app/)** ・
**[下載 Download](https://github.com/Sinotrade/shioaji-pro-app/releases/latest)**

A professional, fully-customizable trading terminal for Taiwan markets
(TWSE / TPEX / TAIFEX), built on the [Shioaji](https://sinotrade.github.io/)
HTTP API + SSE streaming. React 19 + TypeScript + Vite, zero backend code —
it talks directly to your local `shioaji server`.

以 Shioaji HTTP API 打造的專業交易終端：即時行情、K 線、五檔、閃電下單、
圖表點價下單、停損停利觸價單、圖表畫圖工具、
可拖拉的自訂版面。

**介面 100% 開源** — UI、行情串流、下單鏈路全部都在這個 repo，
clone 下來就能 build 出完整的 Web 版終端。桌面版外殼（Tauri）、
AI Agent 與策略回測為專屬模組，直接到 Releases 下載安裝檔即可使用。

![Shioaji Pro — futures night session](docs/shot-terminal-dark.png)

## Live Market Intelligence 即時市場情報

Shioaji 1.7.1 的即時計算指數、成分股與產業貢獻，現在整合成可自由配置的
市場脈動面板。自算指數會同時對照官方指數、更新時間差、台指近月與期現差；
成分股貢獻、產業分布和貢獻傳導可單獨或並排顯示。

![市場脈動：成分股貢獻、產業分布與貢獻傳導](docs/images/market-pulse-live.png)

盤中雷達接收上市與上櫃即時訊號，能依訊號自動連動 K 線、五檔和成交明細。
市場與訊號規則皆可細項多選，設定區可隨時收合。

| 盤中雷達 | 訊號與市場篩選 |
|---|---|
| ![盤中雷達連動 K 線、五檔與成交明細](docs/images/intraday-radar-live.png) | ![盤中雷達訊號與市場篩選](docs/images/intraday-radar-filters.png) |

## Features 功能

- **即時行情** — 單一 SSE 連線串流 tick / 五檔，自選清單成交閃動（只在真實成交時閃，試撮不閃）
- **K 線圖** — lightweight-charts，1m/5m/15m/60m/1D，即時 tick 更新當根 K 棒，
  **歷史無限回溯**（往左拖自動載入更舊 K 棒，最多三年）
  - **交易模式 / 畫圖模式**：頂端工具列武裝交易（點價買賣、停損、停利、警示），
    左側工具列負責畫圖與瀏覽，一次只有一種模式生效
  - **點價下單**：點圖表價位直接限價買賣
  - **停損 / 停利**：在圖上掛觸價單（觸價送市價單），虛線顯示、可取消
  - **委託管理**：未成交委託顯示為實線、overlay 有 CANCEL 按鈕、**拖曳委託線即改價**
  - **畫圖工具**：水平線／趨勢線／射線／延伸線／方框，TradingView 式色盤、
    線寬與虛實線、鎖定／隱藏／複製；水平線可輸入精確價位。依商品保存、
    切換週期不跑位（期貨連續月與月份合約預設共用，可關閉）
  - **Hover 同步**：十字線價位即時同步到下單面板
- **閃電下單** — 價格梯點擊即下單（左欄買/右欄賣），含安全開關；
  **⚡全開**：自選前 N 檔自動平鋪多個閃電面板（可選排版）
- **鋪單面板** — 一鍵多檔位掛單：靜態鋪單 ＋ 動態追價模式
- **五檔報價** — 量能條視覺化，點價帶入下單面板
- **成交明細** — 開啟即載入歷史 tick，時間精確到微秒
- **下單面板** — 整股/零股、ROD/IOC/FOK、期貨倉別、沖賣 daytrade_short，
  兩段式確認防誤觸
- **組合單** — 期貨/選擇權組合單（價差、跨式…），T 字報價點擊連動兩腳、
  到價監控自動送單
- **持倉 / 委託 / 帳務** — 即時損益、刪單改量、權益數與保證金、
  資產市值加總＋分布圖、零股混合單位顯示（X張+Y股）
- **排行榜** — 漲幅 / 量 / 額多條件複選 scanner（含放空篩選）、顯示類別、
  點擊即加入追蹤
- **產業全景** — 產業 treemap（面積＝成交值/貢獻可切換、色＝加權漲跌幅）、
  加權/櫃買切換；點產業下鑽主力貢獻或成交值排行＋貢獻磚牆，
  「其他成員」漲跌幅由群組加權反推
- **交易安全** — 風控 Kill Switch（單筆上限/日虧上限/一鍵鎖單）、
  Esc×2 全部刪單、括號單（成交後自動掛 OCO 停損停利）、持倉一鍵平倉/反手、
  委託改量、下單預估成本（手續費/稅/契約值）
- **快捷鍵** — B/S 切換買賣、Esc×2 全刪單、⌘K 商品搜尋跳轉（支援中文股名）
- **技術指標** — 21 種內建（主圖均線/通道/SAR/SuperTrend，副圖 MACD/RSI/KD
  等震盪指標），TradingView 式選擇器與設定視窗（色盤/線型/時框顯示/
  我的預設），副圖獨立窗格、圖上 legend 即時數值
- **自訂指標** — 面板內用 JavaScript + `ta.*` 函式庫寫自己的指標
  （`plot()`/`hline()` 宣告輸出），Web Worker 沙箱驗證（自動擋無窮迴圈）、
  自動偵測輸出線，寫完與內建指標同等待遇（設定/樣式/收藏全套）
- **大盤狀態列** — 加權指數與台指期基差常駐頂部
- **市場脈動** — 自算指數對照官方指數、時間差與期現差，成分股貢獻與
  產業到主要個股的貢獻傳導可自由組合顯示（指數成分即時串流驅動）
- **盤中雷達** — 上市／上櫃即時訊號，規則與市場細項多選，訊號出現時可自動
  連動 K 線、五檔與成交明細
- **到價警示** — 圖上點擊設警示線（只通知不下單），音效＋toast
- **分析面板** — 損益分析（權益曲線/勝率/賺賠比）、分價量表＋內外盤比、
  個股籌碼卡（融資券/借券/處置股）、選擇權 T 字報價（TXO）、
  選擇權損益圖（買方/賣方到期損益）
- **行情回放** — 重播當日歷史 tick 練盤感（1x–100x 變速）
- **委託簿熱圖** — 五檔掛單牆的時間序列視覺化
- **自選清單** — 漲跌幅排序、列備註、迷你走勢圖（可開關）、拖曳排序
- **自訂版面** — react-grid-layout 拖拉移動/縮放，面板可任意新增（多開 K 線圖）、
  每個面板可「連動自選」或「鎖定商品」、可彈出成獨立視窗（多螢幕）、
  版面可命名儲存/載入，內建多組預設版面
- **通知中心 / 診斷面板** — 委託回報時間軸、系統事件、App 版本與連線診斷
- **隱私模式** — 一鍵遮蔽帳號與金額（demo / 截圖 / 直播用）
- **音效回報** — 成交/委託/警示分音色（可關閉）
- **斷線自癒** — SSE 重連後自動重新訂閱所有商品；斷線時自動鎖定下單按鍵
- **主題** — 深色 / 純黑 / 淺色 × 紅漲綠跌(台式) / 綠漲紅跌(美式)，字級可調

| Dark | Light |
|------|-------|
| ![dark](docs/shot-terminal-dark.png) | ![light](docs/shot-terminal-light.png) |

## Desktop App 桌面版（推薦）

到 [Releases](https://github.com/Sinotrade/shioaji-pro-app/releases) 下載對應平台安裝檔
（macOS `.dmg`、Windows `.msi`、Linux `.AppImage`/`.deb`/`.rpm`）。桌面版特色：

系統需求：macOS 13.3+（Apple Silicon / Intel）、Windows 10/11 x64、Linux x86_64。

- **AI Agent** — 多供應商（Claude / Codex）agentic 對話、shioaji 技能市集、
  排程任務、操作觀察學習（桌面版專屬）
- **Codex 訂閱免手動裝 CLI** — 安裝新版 ChatGPT Desktop 並登入 ChatGPT，
  AI Agent 設定頁會偵測 App 內建 Codex runtime、檢查登入與官方 skill；
  也可繼續使用獨立安裝的 Codex CLI（舊版 ChatGPT Classic 不含 Codex）
- **策略回測** — 用 JS 寫進出場策略（與自訂指標同一套 `ta` 函式庫）、
  含手續費/證交稅/期交稅/滑價的回測引擎（訊號收盤成立、次根開盤成交，
  無未來函數）、單商品與自選清單多商品整合績效（合併權益曲線＋可排序
  商品表）、進出場標記直接畫在 K 線上（桌面版專屬）
- **內建 shioaji server**（sidecar）— 不需另外安裝 CLI
- **伺服器管理介面** — header「伺服器」選單：啟動/停止/重啟、健康狀態、
  PID/port、token 效期；API 金鑰在介面填寫（存於本機 App 資料夾）
- **模擬/正式環境切換** — 介面上切換，重啟伺服器生效
- **系統匣（Menu Bar）** — 關閉視窗縮到系統匣常駐；匣選單可叫回視窗、
  開伺服器管理、檢查更新
- **自動更新** — 啟動時靜默檢查，GitHub Releases 簽章驗證後自動更新重啟
- **多視窗 Popout** — 面板 ⧉ 彈出為原生視窗，多螢幕交易
- **單一實例** — 重複開啟自動聚焦既有視窗

> 桌面版外殼（Tauri）、AI Agent 與策略回測為專屬模組，不在本 repo ——
> 本 repo 可 build 出完整的 Web 版終端（CI 持續驗證），桌面版請直接下載安裝檔。

## Getting Started 開始使用（Web 版）

### 1. Prerequisites 前置需求

- 永豐金證券帳戶 + Shioaji API Key/Secret
  （在 [API 管理頁](https://www.sinotrade.com.tw/newweb/PythonAPIKey/) 建立）
- [Node.js](https://nodejs.org/) 20+ 與 [pnpm](https://pnpm.io/)
- Shioaji CLI：

```sh
# 推薦用 uv 安裝
uv tool install shioaji-cli
# 或下載 standalone binary，見 https://sinotrade.github.io/
```

CLI 由獨立的 `shioaji-cli` 套件提供，指令名稱仍是 `shioaji`；Python 3.14t 的
`shioaji` wheel 不含 CLI。桌面版已內建 standalone binary，不需另外安裝。

### 2. Configure credentials 設定金鑰

```sh
cp .env.example .env
# 編輯 .env，填入你的 SJ_API_KEY / SJ_SEC_KEY
```

> `.env` 已被 `.gitignore` 排除，**請勿** commit 你的金鑰。

### 3. Start the Shioaji server 啟動行情/交易伺服器

```sh
shioaji server start          # 預設模擬環境（紙上交易）
shioaji server check          # 確認狀態
```

預設跑在 `http://127.0.0.1:8080`，**simulation 模式**——下單不會動用真錢。
切正式環境：`shioaji server start --production`（需先完成 CA 憑證設定，
請務必先在模擬環境完整測試）。

### 4. Run the app 啟動前端

```sh
pnpm install
pnpm dev
```

開啟 [http://localhost:5173](http://localhost:5173) —— dev server 會把
`/api` 代理到 `localhost:8080`。

## Deploy as a Shioaji custom app 部署為內建 App

Shioaji server 可直接代管前端，build 完上傳即可：

```sh
VITE_BASE=/apps/shioaji-pro-app/ pnpm build
cd dist
ARGS=(); for f in *; do ARGS+=(-F "files=@$f"); done
curl -X POST http://localhost:8080/api/v1/apps/shioaji-pro-app "${ARGS[@]}"
```

然後開啟 `http://localhost:8080/apps/shioaji-pro-app/index.html`。
（注意：上傳的 app 存在 server 記憶體，server 重啟後需重新上傳。）

## Safety notes 安全提醒

- 預設為**模擬環境**；頂部會顯示「模擬環境」徽章，正式環境為紅色「正式環境」
- 閃電下單預設**鎖定**，需手動啟用；圖表點價下單為 one-shot 模式
- 停損/停利為**客戶端觸價單**，只在頁面開啟時監控
- 正式環境的每一筆委託都是真實交易，請自行承擔風險

## Stack

- React 19 + TypeScript + Vite 8
- [vanilla-extract](https://vanilla-extract.style/) — zero-runtime themable CSS
- [lightweight-charts](https://tradingview.github.io/lightweight-charts/) v5
- [react-grid-layout](https://github.com/react-grid-layout/react-grid-layout) v2
- Shioaji HTTP API + Server-Sent Events

## License

[GNU AGPL-3.0](LICENSE) — 介面 100% 開源，但這是強 copyleft 授權：

- **可以**自由使用、修改、學習、fork
- **商用條件**：任何基於本專案的修改或衍生作品（包括架成網路服務提供他人
  使用）都**必須以 AGPL-3.0 完整開源**
- 不願開源的商業使用，請聯繫永豐金證券洽談**商業授權**（dual licensing）

External contributions: by submitting a PR you agree to license your
contribution under AGPL-3.0 and grant the maintainers the right to
include it in dual-licensed distributions.

外部貢獻者的 CI 流程（fork PR 的 desktop CI 需維護者加 `run-desktop-ci`
label 核准）見 [CONTRIBUTING.md](CONTRIBUTING.md#外部-fork-pr-的-ci-流程).
