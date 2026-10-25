# context-esun.md — 玉山整合詞彙（fork 專屬）

補充上游 [CONTEXT.md](../../CONTEXT.md) 的玉山證券相關詞彙；不修改上游 CONTEXT.md。只放詞彙定義，不放實作細節。
上游詞彙（回報識別、跳號、權威對帳、快取重建、待對帳原因、刪單確認等）在玉山帳號上沿用相同語意。

## 元件與部署

- **玉山橋接 (E.Sun bridge)**: `server/` 的 Python 服務，包裝玉山官方 SDK `esun_trade`，對前端提供 `/esun/*` REST 與 SSE。Docker 中為 `esun-bridge` 服務（容器 `shioaji-pro-esun-bridge`）；舊文件也稱 sidecar。
- **橋接 token (bridge token)**: `ESUN_BRIDGE_TOKEN`，反向代理（nginx 或 Vite dev proxy）存取橋接時注入的 `X-Esun-Bridge-Token`。瀏覽器永遠不持有。
- **允許的 Host (allowed hosts)**: 橋接與 nginx 接受的 Host 名稱；內建 `localhost`、`127.0.0.1`、`::1`、`esun-bridge`、`host.docker.internal`，其他由 `ESUN_ALLOWED_HOSTS`／`WEB_SERVER_NAMES` 擴充。
- **狀態目錄 (state dir)**: `ESUN_STATE_DIR`，橋接持久化登入熔斷狀態的位置；Docker 中為具名 volume `esun-state`（`/app/state`）。
- **存活檢查 (livez)**: `GET /esun/livez`，免驗證、無副作用，只表示橋接程序在回應；不代表已登入或可交易。
- **健康狀態 (health)**: `GET /esun/health`，純讀取的登入／環境／設定問題快照；不呼叫券商網路方法。

## 環境與設定檔

- **玉山環境 (E.Sun environment)**: `SIMULATION`（測試）或 `PRODUCTION`（正式），由設定檔 `[Core] Entry`／`Environment` 判定。與永豐的模擬／正式模式彼此獨立。
- **未知環境 (unknown environment)**: 尚未取得橋接回報時的環境；UI 顯示「未知」，不得預設為模擬。
- **雙設定檔 (dual config)**: 同時提供 `esun-config.simulation.ini`（別名 `.sim.ini`、`.test.ini`）與 `esun-config.production.ini`（別名 `.prod.ini`）；只提供一個時，另一個環境不可選。
- **單一設定檔 (single config)**: 只有 `esun-config.ini`；切換環境時只在記憶體中覆寫 `[Core]`，不改寫使用者的檔案。
- **設定漂移 (config drift)**: 磁碟上偵測到的設定與目前 session 不一致；只提示，不自動切換。

## Session

- **Session 快照 (session snapshot)**: 一次登入成功後的不可變狀態（SDK、環境、設定檔、帳號），以 **session generation** 單調遞增識別；登入或切換成功時整個替換。
- **環境切換 (environment switch)**: 以目標環境重新登入並替換 session；成功時清空所有帳務快取並重建 WebSocket，失敗時保留原 session。受與登入相同的熔斷與限流保護。
- **登入熔斷 (login breaker)**: 憑證類登入失敗（例如密碼錯誤）後鎖定登入（`loginLocked`），不自動重試，跨重啟保留；只有使用者明確觸發的重連能解除，且仍受頻率限制。玉山官方在連續 3 次密碼錯誤後鎖帳（`AGA0000`）。

## 委託

- **預期環境／帳號 (expected environment / account)**: 每個委託 mutation 攜帶的 `expected_environment`（必填）與 `expected_account`；與目前 session 不符時橋接回 409，絕不送出。
- **委託結果 (mutation outcome)**: 橋接回應信封的 `outcome`：
  - `accepted`：已呼叫 SDK 並取得回傳。
  - `not_sent`：確定沒有送到券商（存取控制、驗證、未登入、環境不符、限流）。
  - `rejected`：券商明確拒絕。
  - `unknown`：送單過程中或之後發生例外，無法得知券商是否已收到；沿用上游「結果未知」語意，絕不自動重送。
- **減量 (reduce-by)**: 改量的語意固定為「減少多少」（`cancel_quantity`），不是目標量；與上游 `updateOrderQty`、SDK `cancel_order(cel_qty=…)` 一致。只帶舊的 `quantity` 會被拒絕。
- **數量單位 (quantity unit)**: `lot`（張）或 `share`（股）。整股、盤後定價用張；盤後零股、興櫃、盤中零股用股。
- **市場別 (ap_code)**: 玉山 SDK 的委託市場別：`1` 整股、`2` 盤後定價、`3` 盤後零股、`4` 興櫃、`5` 盤中零股。
- **預約單 (reservation order)**: 盤前預約、尚未進入交易所的委託（`ord_status='1'` 或只有 `pre_ord_no`）；不可改價改量，只能刪單後重下。
- **委託書號 (order_no)**: 玉山委託的識別；預約單在進場前只有預約序號 `pre_ord_no`。

## 回報串流

- **委託回報 (ACK)**: 玉山 WebSocket 的委託狀態事件，SSE 事件類型 `order`。
- **成交回報 (MAT)**: 玉山 WebSocket 的成交事件，SSE 事件類型 `deal`；收到後庫存快取失效。
- **操作類型 (op_type)**: 回報對應的操作（New／Cancel／ModifyPrice／ModifyQty 等）；無法由 SDK 欄位推導時為 `Unknown`，不得一律當成 New。
- **橋接啟動識別 (boot_id)**: 橋接每次啟動產生的隨機字串；SSE 事件 id 為 `<boot_id>-<seq>`。客戶端帶 `Last-Event-ID` 重連時，同一 boot 且仍在緩衝內就補送缺漏，否則送 `resync`。
- **重新同步 (resync)**: 橋接要求客戶端做快取重建的 SSE 事件（例如橋接重啟、緩衝已覆蓋）。
- **Session 事件 (session event)**: 環境切換或登入狀態改變時的 SSE 事件，攜帶 generation、環境、帳號與登入狀態。

## 帳務

- **交割行事曆 T+n (settlement calendar)**: 交割款固定顯示 T+0／T+1／T+2 三格。T+0＝今天起第一個交易日（今天是交易日就是今天，否則是下一個交易日）；交易日以玉山 `market_status`（`GET /esun/market_status`）為準，取不到或過期才退回只跳週末的推算（國定假日無法本地判斷，只影響金額為 0 的格的日期）。玉山 `get_settlements` 的 `c_date` 是交割日、`date` 是成交日、`price` 是淨交割金額（正＝應收、負＝應付）；已交割的列不顯示，超出 T+2 的未交割日期視為格式錯誤。
