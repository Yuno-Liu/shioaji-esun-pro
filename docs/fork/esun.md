# 玉山整合與 Docker 部署（fork 專屬）

本文件是 fork（Shioaji Esun Pro）的玉山證券整合與 Docker 網頁版部署說明。上游 README 保持原樣，
fork 專屬內容都放在 `docs/fork/`。詞彙定義見 [context-esun.md](context-esun.md)，同步上游的流程見
[upstream-sync.md](upstream-sync.md)。

## 架構

預設採「永豐取行情 ＋ 玉山負責股票下單與帳務」雙券商並行，也可以在頂欄切換玉山或永豐帳號下單。

```mermaid
flowchart TD
    Client["瀏覽器<br/>http://127.0.0.1:8080"]
    subgraph Docker["Docker Compose"]
        Nginx["shioaji-pro-web（nginx 1.30）<br/>127.0.0.1:8080 → 容器 :8080<br/>SPA ＋ 零緩衝 SSE 反向代理"]
        Sinopac["shioaji-pro-sinopac（shioaji-cli，版本＝SHIOAJI_VERSION）<br/>共用 web 網路命名空間 127.0.0.1:21322"]
        EsunBridge["shioaji-pro-esun-bridge（Python 3.11，uid 10001）<br/>compose 內網 :8090，不發佈到主機"]
    end
    Client -->|"/、/api/*、/esun/*"| Nginx
    Nginx -->|"/api/*"| Sinopac
    Nginx -->|"/esun/*（注入 X-Esun-Bridge-Token）"| EsunBridge
    Sinopac --> SinopacCloud["永豐金證券"]
    EsunBridge -->|"REST ＋ WebSocket"| EsunCloud["玉山證券"]
```

| 服務（容器名稱） | 映像 target | 說明 |
| --- | --- | --- |
| `shioaji-pro-web`（`shioaji-pro-web`） | `runner` | nginx 代管建置後的 SPA（`index.html`、`approval.html`），反向代理 `/api/` 與 `/esun/`。只接受允許的 Host，拒絕跨來源請求，加上防點擊劫持等安全標頭。 |
| `shioaji-server`（`shioaji-pro-sinopac`） | `shioaji` | 永豐 Shioaji API server。版本取自 repo 根目錄 `SHIOAJI_VERSION`（與上游 CI 同一來源）；讀取 `.env` 的 `SJ_API_KEY`／`SJ_SEC_KEY`，未設定時只待命並回報 unhealthy。 |
| `esun-bridge`（`shioaji-pro-esun-bridge`） | `esun-bridge` | 玉山證券橋接（`server/`）：委託、改價、減量、刪單、庫存、餘額、交割款、損益，以及 WebSocket 轉 `/esun/stream/orders` SSE。以非 root（uid 10001）執行，設定檔目錄唯讀掛載，登入熔斷狀態存於具名 volume `esun-state`（`/app/state`）。 |

## 前置準備

### 1. 憑證（`./certs/`）

```text
./certs/esun_cert.p12      # 玉山憑證
./certs/Sinopac.pfx        # （選填）永豐憑證，永豐下單才需要
```

設定檔的 `[Cert] Path = certs/esun_cert.p12` 以「設定檔所在目錄」為基準解析，所以既有的「設定檔在專案根目錄、
憑證在 `certs/`」佈局不需要搬檔。

### 2. 玉山設定檔

雙環境（推薦）：在專案根目錄放測試與正式兩個設定檔，頂欄可以切換；只提供其中一個時，另一個環境會顯示為不可選。

```powershell
# Windows PowerShell
Copy-Item esun-config.simulation.ini.example esun-config.simulation.ini   # 別名：esun-config.sim.ini、esun-config.test.ini
Copy-Item esun-config.production.ini.example esun-config.production.ini   # 別名：esun-config.prod.ini
```

```bash
# Linux / macOS / Git Bash
cp esun-config.simulation.ini.example esun-config.simulation.ini
cp esun-config.production.ini.example esun-config.production.ini
```

單一設定檔（向下相容）：複製 `esun-config.ini.example` 為 `esun-config.ini`，以 `[Core]` 判定環境：

```ini
[Core]
# 正式：Entry = https://esuntradingapi.esunsec.com.tw/api/v1（不可有 Environment 欄位）
# 測試：Entry = https://esuntradingapi-simulation.esunsec.com.tw/api/v1 且 Environment = SIMULATION
Entry = https://esuntradingapi.esunsec.com.tw/api/v1

[Cert]
Path = certs/esun_cert.p12

[Api]
Key = 您的玉山_API_KEY
Secret = 您的玉山_API_SECRET

[User]
# 11 碼（前 4 碼分公司代碼 + 7 碼帳號）或 7 碼帳號
Account = 8840xxxxxxx
```

橋接的監聽位址與埠號**不從設定檔讀取**，請用環境變數 `ESUN_SERVER_HOST`（預設 `127.0.0.1`）與 `ESUN_SERVER_PORT`（預設 `8090`）。

### 3. `.env`

複製 `.env.docker.example` 為 `.env`（一鍵部署腳本會自動複製），填入：

```dotenv
ESUN_ACCOUNT_PASSWORD=您的玉山證券登入密碼   # 輸錯 3 次會被玉山鎖帳（AGA0000）
ESUN_CERT_PASSWORD=您的玉山憑證密碼
SJ_API_KEY=您的永豐_API_KEY
SJ_SEC_KEY=您的永豐_SECRET_KEY
SJ_PRODUCTION=false                       # 永豐模擬模式即可取得完整即時行情
```

其他常用變數：

| 變數 | 預設 | 用途 |
| --- | --- | --- |
| `WEB_BIND` | `127.0.0.1` | web 在主機上綁定的位址。 |
| `WEB_PORT` | `8080` | web 在主機上的埠號。 |
| `WEB_SERVER_NAMES` | 空 | 額外允許的 Host（空白分隔），同時是 nginx `server_name` 與橋接 `ESUN_ALLOWED_HOSTS`。 |
| `WEB_BASIC_AUTH` | `off` | nginx Basic Auth 的 realm；`off` 表示停用。 |
| `ESUN_BRIDGE_TOKEN` | 空 | nginx 存取橋接的共享 token；部署腳本會自動產生（不顯示）。瀏覽器不持有 token。 |
| `ESUN_CONFIG_HOST_DIR` | `.` | 玉山設定檔所在的主機目錄，唯讀掛載到橋接的 `/app/host-config`。 |
| `ESUN_BRIDGE_UPSTREAM` | `http://esun-bridge:8090` | nginx 的橋接上游（結尾不要加 `/`）。 |
| `SHIOAJI_API_UPSTREAM` | `http://127.0.0.1:21322` | nginx 的永豐上游。 |

> `.env`、設定檔、`certs/`、`*.p12`、`*.pfx` 都列在 `.gitignore` 與 `.dockerignore`，不會被提交或進入建置 context。
> 密碼目前仍以環境變數傳入容器：具有 Docker 權限的本機使用者可以用 `docker inspect` 看到，請只在自己的電腦上執行。

## 啟動

一鍵部署腳本會檢查 Docker、初始化缺少的 `.env`／設定檔／`certs/`、產生 `ESUN_BRIDGE_TOKEN`，並建置與啟動所有容器；
任何 docker 指令失敗都會中止並回報，不會把舊容器的狀態誤報成新版已部署。

```powershell
pnpm run docker:deploy                 # 需要 PowerShell 7（pwsh）
.\scripts\deploy-docker.ps1 -Action up # Windows PowerShell 5.1 也可直接執行
```

```bash
./scripts/deploy-docker.sh up          # Linux / macOS / Git Bash
```

或直接使用 compose（不會自動產生 token；沒有 token 時橋接只在 compose 內網可達）：

```bash
docker compose up -d --build
```

開啟 <http://127.0.0.1:8080>。web 預設只綁 IPv4 的 127.0.0.1；Windows 會先以 IPv6（::1）解析 `localhost`，用 `localhost` 開啟時每條新連線都要等退回 IPv4 才成功（瀏覽器約 0.2–0.3 秒，部分程式約 2 秒），建議改用 127.0.0.1。

`package.json` 的 `docker:deploy`／`docker:down`／`docker:status` 呼叫 `pwsh`；Linux／macOS 請安裝 PowerShell 7，或改用
`./scripts/deploy-docker.sh`。

### Windows 宿主機橋接（`-HostBridge`，進階）

```powershell
.\scripts\deploy-docker.ps1 -Action up -HostBridge
```

腳本會以 `deploy/install_sdk.py` 安裝並驗證 Windows wheel，在宿主機背景啟動 `server/esun_trade_server.py`
（預設只綁 `127.0.0.1:8090`，日誌在 `esun-bridge.log`／`esun-bridge.err.log`），再以 `--no-deps` 啟動 web 與永豐容器，
nginx 透過 `host.docker.internal` 代理到宿主機。若容器連不到宿主機的 127.0.0.1，可設定 `ESUN_HOST_BRIDGE_BIND=0.0.0.0`
（橋接仍要求 `ESUN_BRIDGE_TOKEN`）。

- 宿主機橋接的 `ESUN_BRIDGE_TOKEN`、密碼與 `ESUN_ALLOWED_HOSTS` 每次都從 `.env` 重新讀取（同名鍵重複時與 compose 相同，
  以最後一行為準），只在啟動子程序的當下帶入；腳本結束時會把它改動過的 PowerShell 環境變數還原，同一個視窗重跑或改用
  全容器模式不會沿用殘留值。執行腳本前自行在 shell 設定的變數優先且會保留。
- `ESUN_ALLOWED_HOSTS` 未設定時，以 `WEB_SERVER_NAMES`（shell > `.env` > 空）帶入，與容器模式的 compose 對應一致；
  依[區網存取](#區網存取)設定 `WEB_SERVER_NAMES` 後，宿主機橋接也會接受這些 Host（否則 `/esun/` 會回 421）。
- **Linux Docker Engine**（非 Docker Desktop）自行在宿主機執行橋接時（模式 B；`-HostBridge` 只支援 Windows）：nginx 以 resolver 在執行期解析
  `ESUN_BRIDGE_UPSTREAM`，不讀 `/etc/hosts`，compose `extra_hosts` 寫入的 `host.docker.internal` 會解析失敗（`/esun/` 回 502）。
  請把 `.env` 的 `ESUN_BRIDGE_UPSTREAM` 設為 gateway IP，例如 `http://172.17.0.1:8090`。Docker Desktop（Windows／macOS）不受影響。

## 安全模型

- **只綁本機**：web 預設發佈到 `127.0.0.1`；`esun-bridge` 只 `expose` 在 compose 內網，不發佈到主機。
- **Host 允許清單**：nginx 只服務 `localhost`、`127.0.0.1` 與 `WEB_SERVER_NAMES`，其他 Host（例如 DNS rebinding、以區網 IP 直連）
  由預設 server 直接斷線（444）。橋接另有自己的 Host 白名單（`ESUN_ALLOWED_HOSTS`）。
- **跨來源防護**：`/api/` 與 `/esun/` 拒絕 Origin 與 Host 不符、`Origin: null`、`Sec-Fetch-Site: cross-site/same-site` 的請求（403）。
- **橋接 token**：nginx 在 `/esun/` 注入 `X-Esun-Bridge-Token` 並覆寫客戶端自帶的同名標頭；橋接以常數時間比對。
  也就是說，nginx 本身就是信任邊界——能連到 nginx 的人就能操作交易端點。
- **安全標頭**：`X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、
  `Referrer-Policy: same-origin`；`index.html`／`approval.html` 不快取，只有帶雜湊的資產長期快取。
- **最小權限**：橋接以 uid 10001 執行、`cap_drop: ALL`、`no-new-privileges`，設定檔目錄唯讀掛載。
- **SDK 完整性**：`deploy/install_sdk.py` 以 `deploy/esun_trade.sha256` 驗證 wheel，雜湊不符或沒有相容平台的 wheel 時建置失敗。
  repo 只附 Linux x86_64 與 Windows x64 wheel；ARM 主機（例如 Apple Silicon）需要另外取得對應 wheel。

## 區網存取

**不要把 8080／8090 直接暴露到區網。** 真的需要讓其他裝置連線時：

1. 產生 htpasswd（任一方式）：
   ```bash
   docker run --rm httpd:2.4-alpine htpasswd -nbB trader '強密碼' > ./secrets/htpasswd
   ```
2. 在 `.env` 設定：
   ```dotenv
   WEB_BIND=0.0.0.0              # 或指定網卡 IP
   WEB_SERVER_NAMES=192.168.1.20 trade.lan
   WEB_BASIC_AUTH=ShioajiPro
   ```
3. 以 `docker-compose.override.yml` 唯讀掛載 htpasswd：
   ```yaml
   services:
     shioaji-pro-web:
       volumes:
         - ./secrets/htpasswd:/etc/nginx/auth/htpasswd:ro
   ```
4. `docker compose up -d`。Basic Auth 走明文 HTTP，跨出可信任網段時請在前面加 TLS 反向代理。

> **手機下單必須經 HTTPS（secure context）。** 區網 HTTP 只能開啟頁面、**無法下單**：非 secure context 沒有 Web Locks，
> 行情與回報串流不會連線，下單閘門會一直擋單。手機請依 [mobile.md](mobile.md) 在 nginx 前面加 TLS 前端
> （Tailscale 或 Caddy），原因與實測見 [手機版規格 §3](mobile-trading-spec.md#3--phase-0https-存取層硬性前置)。

容器 healthcheck 使用免驗證的 `/healthz`，啟用 Basic Auth 不影響健康狀態。

## 非 root 與檔案權限

橋接以 uid 10001 執行。Docker Desktop（Windows／macOS）的綁定掛載對容器內所有使用者可讀，不需調整；
Linux 主機請確認設定檔與 `certs/esun_cert.p12` 對其他使用者可讀（例如 `chmod o+r`），或在 override 檔中以 `user:` 指定
與檔案擁有者相同的 uid（此時 `esun-state` volume 的擁有者也要一致）。永豐 sidecar（上游 CLI）目前仍以 root 執行。

## 玉山 API 官方限制與橋接防護

| 項目／代碼 | 官方限制 | 橋接防護 |
| --- | --- | --- |
| 登入鎖帳（`AGA0000`） | 連續密碼錯誤 3 次鎖帳 | 單次熔斷：登入失敗後鎖定（`loginLocked`），不自動重試；熔斷狀態寫入 `ESUN_STATE_DIR`（Docker 為具名 volume），容器重啟後不會再自動登入，須修正後手動重連 |
| 登入頻率（`AGR0000`） | 每分鐘 10 次 | 滑動視窗限流；觸發後冷卻 60 秒 |
| 每日登入（`AGR0004`） | 每日 300 次 | 每日累計計數 |
| 登入 token 換日失效 | 台北換日後舊登入失效（WebSocket 1011 `Token Validation Error`、SDK `A0000x: response parse Error`） | 判定依「登入開始時間」（`client.login()` 前記錄）：早於「今日 00:00 ＋ `ESUN_AUTO_RELOGIN_NOT_BEFORE`（預設 00:05）」的 session 視為換日前 session（含 23:59:59 開始、午夜後才完成，以及 00:00–00:05 間完成的登入）。換日前 session 收到 WebSocket token 錯誤或 SDK 回應解析失敗時判定失效；之後才登入的 session 收到 token 錯誤屬「日間失效」（可能在其他地方重新登入），**不自動重新登入**，health 要求手動重連，以免踢掉其他工具的登入。失效後 health 改回 `loggedIn: false`、`sessionExpired: true`；委託在呼叫 SDK 前即以 503 `ESUN_SESSION_EXPIRED`（`not_sent`）拒絕，查詢回 503；舊 WebSocket 停止重連；已在 SDK 呼叫中的委託維持 `accepted`／`unknown`。換日型失效自動重新登入（`ESUN_AUTO_RELOGIN=0` 可停用）：第一次在 max(偵測＋2 秒, 今日 00:05) ＋ 0–60 秒隨機延遲（`ESUN_AUTO_RELOGIN_JITTER_SECONDS`）；只有明確未送出的網路失敗（DNS、connection refused、unreachable）與 AGR0000（至少等完冷卻）依 2／5／10 分鐘重試（`ESUN_AUTO_RELOGIN_RETRY_MINUTES`）；可能已送達伺服器的失敗（timeout、EOF、502／503／504）同一次失效最多 2 次嘗試。只有明確的憑證錯誤（AGA0000、密碼、憑證）才啟動持久熔斷；無法辨識的回應（含 `A0000x: response parse Error`、SDK 核心 panic）改為 `autoRelogin.state: paused`，不寫熔斷與指紋，按「重新連線」即可手動登入。手動登入路徑的分類維持 fail-safe（無法辨識一律視為憑證錯誤）。每次嘗試記錄時間與結果 |
| WebSocket 保活與重連 | SDK 原生不送 ping。實測玉山會回應 ping，另外每條連線約每 120 秒多送一個 pong | 每 30 秒送一次 ping，但不使用 websocket-client 的 `ping_timeout`：它把「距上次 ping 超過逾時才到的 pong」當成逾時，玉山多送的那個 pong 會讓健康的連線被切斷（2026-11-13 正式環境 55 分鐘誤斷 21 次，全部落在連線後 120 秒的整數倍）。半開連線改由靜默看門狗偵測：90 秒沒有任何訊息、ping 或 pong 就關線重連（`WS_SILENCE_SECONDS`，依賴玉山回應每 30 秒的 ping，不可拿掉或拉長 ping 間隔）。握手（TCP＋TLS＋HTTP upgrade）逾時 20 秒；連線建立後的讀取逾時 75 秒，只限制「讀到一半就停住」的 frame，安靜的連線不受影響。重新連上後查一次委託並發 `resync`（`ws_reconnected`），發布前把庫存快取標成需重讀；連不上的嘗試每 60 秒最多補查一次（斷線後第一次失敗立即補查）。 |
| 委託頻率（`AGR0002`） | 每秒 20 筆 | 限制 18 筆／秒 |
| 每日委託（`AGR0001`） | 每日 2,000 筆 | 新單、改價、改量、刪單合計計數 |
| 委託數量 | 整股 499 張／零股 999 股 | 前端與橋接都先檢查 |
| 預約單（`AG0006`） | 預約單不可改價改量 | 直接拒絕，只允許刪單後重下 |
| 改價條件 | 僅限價 ROD 可改價 | 市價、IOC、FOK 禁止改價 |
| 銀行餘額 | 避免高頻查詢 | 180 秒快取 |
| 交割款（`AGR0006`） | 每分鐘 3 次 | 25 秒快取 ＋ 3 次／分限流 |
| 庫存（`AGR0003`） | 每分鐘 10 次 | 6 秒快取，收到成交（MAT）即失效 |
| 已實現損益（`AW00002`／`AW00003`） | 區間不超過 180 天 | 自動鉗位在 180 天內 |

改量的語意固定為「**減少量**」（與上游 `updateOrderQty` 及 SDK `cancel_order(cel_qty=…)` 一致），委託 mutation 的請求／回應
信封與結果未知的處理方式見 [context-esun.md](context-esun.md)。

SDK 例外一律視為結果未知，只有「整段訊息為 `代碼: 內容`、內容不含逾時／連線／重試等字、且代碼在該操作的允許清單內」才回
422 `rejected`（`code` 為子碼）：下單只認 `000013` 且「後台錯誤」後接 `ODR0239`（警示股預收），之後一定在背景跑一次
權威委託查詢（與失敗 ACK 共用排程；即使本行程還沒收過失敗 ACK，或已有查詢在途，也會再跑一次在拒絕之後才開始的查詢），
完成後發 `resync`（`failed_ack_refreshed`、`cacheRefreshed: true`）；刪單、改價、改量只認 `AG00005`、`AG00004`。清單外的代碼
維持 502／504 `unknown` 並記 log。

成交回報（SSE `deal`）另帶 `esun_covered_by_snapshot`（這筆成交已含在列上的快照成交量內）與 `esun_order_mat_qty_share`
（套用後的委託累計成交股數，不超過委託量）；列上 `esun_fills` 的同一筆也帶 `esun_covered_by_snapshot: true`。橋接列的成交、
取消量為 max(快照／ACK, 回報累計)，快照較小時不會往下修（玉山 REST 可能落後 WebSocket）；回報累計超過委託量時以委託量為上限，
並在列上加 `esun_quantity_conflict`（`reason: exceeds_order`、`report_shares`、`org_shares`、`raw_shares` 為列本身的快照／ACK
股數）並記 warning，直到列本身的數量達到委託量才清除。成功的 ACK 不會讓 `org_qty`
變小（減量以 `cel_qty` 表示，差異記 warning）。每筆 ACK、MAT 以 INFO 記錄去識別化的原始欄位（委託書號只留末 2 碼，不記帳號、
身分證），用來確認 `mat_qty` 是單筆或累計，以及 ACK `org_qty` 的語意。

## 常用管理與排錯指令

```bash
pnpm run docker:status                    # 或 docker compose ps
curl http://127.0.0.1:8080/esun/health    # 玉山登入狀態、環境、待配置項目
curl http://127.0.0.1:8080/api/v1/info    # 永豐 sidecar 狀態
docker compose exec esun-bridge curl -s localhost:8090/esun/livez   # 直接檢查橋接存活（不經 nginx）
docker compose up -d                      # 修改 .env 後重新載入
docker compose logs -f esun-bridge        # 或 shioaji-server、shioaji-pro-web
pnpm run docker:down                      # 或 docker compose down
```

### 玉山 WebSocket 斷線排查

`docker compose logs esun-bridge` 裡與回報連線有關的訊息：

- `ping/pong timed out`：2026-11-13 之後不應再出現（原因見上表「WebSocket 保活與重連」）。
- `已 N 秒無任何訊息，視為斷線並重連`：靜默看門狗判定半開連線。偶爾出現是正常的網路中斷；
  如果在安靜但正常的連線上大約每 90 秒出現一次，代表玉山不再回應 ping，要把 `WS_SILENCE_SECONDS` 提高到涵蓋它自己的
  120 秒 pong（例如 150）。
- `已重新連上，查詢補齊委託`：每次重新連上各一次。`尚未重新連上，改以查詢補齊委託`：連不上期間每分鐘最多一次。
- `Connection timed out`：握手 20 秒內沒完成，或連線建立後某個 frame 讀到一半停了 75 秒；之後會依退避重連。
- `用戶端已中斷連線，回應未送達`：瀏覽器在收到回應前就關閉連線（逾時、切到別的 App、關頁面），不是 bridge 的錯誤。
- `/esun/livez` 成功的存取記錄不再寫入日誌（容器健康檢查每 15 秒一次）；失敗仍會記錄。

### 永豐 sidecar 卡在舊的網路命名空間

`shioaji-server` 以 `network_mode: service:shioaji-pro-web` 共用 web 的網路命名空間。web 單獨重啟（`docker restart`、
當掉後依 restart 政策自動重啟）或單獨重建時，sidecar 仍留在舊的命名空間，nginx 連不到 `127.0.0.1:21322`，`/api/` 回 502。
sidecar 的 healthcheck 同時檢查自己的 `/api/v1/info` 與 web 的 `/healthz`（免 Basic Auth），這時會顯示 unhealthy。恢復：

```bash
docker compose up -d --no-deps --force-recreate shioaji-server
```

只重建 sidecar，不碰 web 與玉山 bridge。`--force-recreate` 不可省：web 是「重啟」（容器 ID 不變）時，compose 認為 sidecar
設定沒變、狀態為 Running，不加這個參數會什麼都不做（2026-11-13 以一次性 compose 專案實測；web 是「重建」時，不加也會重建）。

### 日誌輪替

`shioaji-pro-web` 與 `shioaji-server` 使用 json-file 日誌輪替（每檔 10 MB、保留 3 檔，`docker-compose.yml` 的
`x-logging`），重建容器後生效。`esun-bridge` 目前沒有：修改它的 compose 設定會讓下一次 `docker compose up` 重建連著玉山
正式環境的 bridge，所以要等下次收盤後重建 bridge 時，再一起在 `esun-bridge` 加上 `logging: *default-logging`。

### web 不依賴 esun-bridge

`shioaji-pro-web` 沒有 `depends_on: esun-bridge`：nginx 以 resolver 在執行期解析 bridge，bridge 停止時 web 照常運作，
`/esun/` 回 502。因此 `docker compose up -d shioaji-pro-web shioaji-server` 不會把刻意停掉的 bridge 啟動起來；
要啟動 bridge 時請明確寫出 `esun-bridge`，或不指定服務。

### 建置版本

`scripts/deploy-docker.*` 在建置前設定 `GIT_REVISION`（`git rev-parse --short HEAD`），web 映像據此顯示
「dev · <commit>」（手機「帳戶 › 診斷」、未加密連線說明頁與桌面伺服器面板的建置版本），並寫入映像標籤 `org.opencontainers.image.revision`。
直接用 compose 建置時請自行帶入，否則顯示 `dev · unknown`：

```bash
GIT_REVISION=$(git rev-parse --short HEAD) docker compose build shioaji-pro-web
docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' shioaji-pro-web
```

修正玉山密碼或設定檔後，手動解除熔斷並重新登入：

```bash
curl -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8080/esun/auth/reconnect
```

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' http://127.0.0.1:8080/esun/auth/reconnect
```

## 開發模式（Vite）

`pnpm dev` 會把 `/esun` 代理到 `VITE_ESUN_BRIDGE_TARGET`（預設 `http://127.0.0.1:8090`）；`.env` 或環境變數有
`ESUN_BRIDGE_TOKEN` 時由 dev proxy 注入標頭。橋接需另外以 `pnpm run esun-bridge`（或 `python server/esun_trade_server.py`）啟動；
橋接離線時 `/esun` 請求會直接失敗，由前端顯示離線狀態。
