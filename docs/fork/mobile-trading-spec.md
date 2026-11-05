# 📱 手機版交易網頁規格（玉山／永豐）

> - **文件狀態**：規格草案 v1（2026-11-05），供 AI 代理實作與人工審查使用。
> - **適用基準**：`main` @ `4f31b8a`（內建 Shioaji 1.7.10、玉山 `esun_trade` 2.2.0）。
> - **判定圖例**：✅ 已對照 repo 程式碼證實可行 ｜ ⚠️ 程式碼可行，但需實機或部署環境驗證 ｜ ❌ 不可行或刻意不做。
> - **引用方式**：`檔案:行號` 皆以上述基準 commit 為準；實作前若行號漂移，以函式名稱搜尋。

## 目錄

0. [給實作代理的硬性規則](#0--給實作代理的硬性規則)
1. [背景、目標與範圍](#1--背景目標與範圍)
2. [可行性總表](#2--可行性總表)
3. [Phase 0：HTTPS 存取層（硬性前置）](#3--phase-0https-存取層硬性前置)
4. [前端架構](#4--前端架構)
5. [資訊架構與共用元件](#5--資訊架構與共用元件)
6. [畫面規格](#6--畫面規格)
7. [下單、改單、刪單流程](#7--下單改單刪單流程)
8. [API 對照與資料流](#8--api-對照與資料流)
9. [限制、配額與效能預算](#9--限制配額與效能預算)
10. [安全模型](#10--安全模型)
11. [非功能需求（行動裝置）](#11--非功能需求行動裝置)
12. [不提供清單](#12--不提供清單)
13. [分期路線圖](#13--分期路線圖)
14. [測試計畫與驗收標準](#14--測試計畫與驗收標準)
15. [給 AI 代理的工作分解](#15--給-ai-代理的工作分解)
16. [待驗證事項與風險](#16--待驗證事項與風險)
17. [v1 實作備註（與本文的差異）](#17--v1-實作備註與本文的差異)

---

## 0. 🧭 給實作代理的硬性規則

| # | 規則 | 依據 |
|---|---|---|
| R1 | 手機只能經 **HTTPS（secure context）** 使用。非 secure context 時只顯示「需要 HTTPS」說明頁，不建立任何連線、不顯示交易畫面。 | 沒有 Web Locks 時串流會 fail-closed，`assertTradingLive()` 永遠擋單（§3.1 實測） |
| R2 | **上游檔案零修改，既有檔案只改白名單**。<br>• 可新增：`mobile.html`、`vite.fork.config.ts`、`src/mobile/**`，以及 `deploy/**`、`docs/fork/**` 下的部署範例與文件。<br>• 可修改的既有檔案只限 §4.3 表列的 fork 擁有檔案：`Dockerfile`、`deploy/nginx.conf.template`、`.github/workflows/fork-ci.yml`、`docs/fork/**`。<br>• 其餘一律不改：上游檔案（`vite.config.ts`、`index.html`、`src/App.tsx`、`src/main.tsx`…）與整個 `src/lib/**`（含 fork 擁有的 `src/lib/esun/**`，見 R3、R10）。 | `docs/fork/upstream-sync.md:52`（`vite.config.ts` 標記「不再加入 fork 邏輯」）、`:57-58`（fork 自有檔案清單） |
| R3 | **不重寫交易邏輯**。新單、改價、減量、刪單、全部刪單、平倉一律呼叫 §7、§8 列出的 `src/lib` 既有函式。 | 這些函式內含帳戶、伺服器模式、券商路由、零股與信用規則等多層閘門 |
| R4 | **每一筆手動委託都必須經過確認面板**（`requestOrderConfirm()`），手機版不允許關閉。 | 行動裝置誤觸率高；確認面板開啟時會重新讀 `/info` 確認模擬／正式（`src/lib/order-confirm.ts:181-230`） |
| R5 | 新單、改價、減量受三道閘門控制：`useTradingLive()`、**ResumeGate**（§7.4）、風控 `checkOrderAllowed()`。 | 手機切到背景後串流可能已斷，但看門狗的恢復寬限期內狀態仍是 `live`（`src/lib/stream.ts:612-634`） |
| R6 | 錯誤一律分兩類呈現：**確定未成立**（`mutationNotStarted`）與**結果未知**（其餘，含 `mutationOutcomeUnknown`）。結果未知**禁止自動重送**，也不提供「再送一次」按鈕。 | `src/lib/api.ts:180-295`、`src/lib/esun/http-driver.ts:230-265`、`src/components/esun-order-meta.tsx:91-97` |
| R7 | 不提供：一鍵（閃電）下單、圖上拖曳改價、觸價／括號／條件單、背景執行、期權組合單、玉山環境切換、強制重新登入。 | §12 |
| R8 | 玉山帳戶只能下**台股現貨**；期貨、選擇權只走永豐帳戶。 | `src/lib/shioaji.ts:878`、`src/lib/esun/order-mapping.ts:163-241` |
| R9 | 實機驗證**只在模擬環境**進行。PR 必須通過 `pnpm build`、`pnpm test`、fork-ci。 | — |
| R10 | 不新增後端端點，不修改 `server/esun_trade_server.py` 與永豐 sidecar 協定。實作中若發現必須修改 `src/lib/**` 或上游檔案，**停止並回報**（§15.3）。 | 範圍控制 |

---

## 1. 🎯 背景、目標與範圍

### 1.1 現況

- Web 版（Docker：nginx ＋ 永豐 sidecar ＋ 玉山 bridge）只有桌面工作區（react-grid-layout 多面板），沒有手機版面，手機上無法實際操作下單。
- 後端能力已足夠：
  - **永豐 sidecar**（shioaji-cli 1.7.10）：行情、合約、委託、帳務 REST，以及單一彙總 SSE `/api/v1/stream/data`。
  - **玉山 bridge**（`server/esun_trade_server.py`）：台股委託、帳務 REST，以及委託回報 SSE `/esun/stream/orders`。玉山**沒有行情**，玉山帳戶看到的報價全部來自永豐。
- 前端 `src/lib` 已實作完整的下單安全閘門（串流 LIVE、帳戶可交易、伺服器模式代次、顯示路由一致、風控、零股與信用規則、刪單回讀確認、對帳原因）。

### 1.2 目標

1. 新增手機入口 `/mobile.html`，在 iPhone Safari 與 Android Chrome 上完成：**看盤 → 下單 → 追蹤委託 → 改價／減量／刪單 → 查持倉與平倉 → 查帳務**。
2. 同時支援永豐（股票、期貨、選擇權）與玉山（台股現貨）帳戶，畫面隨時標示「**送往哪家券商、哪個環境**」。
3. 重新設計以下單為中心的圖表：圖上顯示自己的委託、持倉成本、漲跌停，長按價位帶入下單面板。

### 1.3 非目標

- 原生 App、推播通知、鎖屏或背景時持續交易。
- 對公開網際網路開放（只支援私有網路或 VPN 內使用）。
- 修改後端或新增後端端點。
- 完整移植桌面功能（見 §12）。

---

## 2. ✅ 可行性總表

### 2.1 連線與平台

| 項目 | 判定 | 依據 | 說明 |
|---|---|---|---|
| 手機以區網 HTTP（`http://192.168.x.x:8080`、`http://trade.lan:8080`）下單 | ❌ | `src/lib/shared-stream.ts:64-66`；§3.1 實測 | 非 secure context 沒有 `navigator.locks` → 串流不連線 → 永遠無法下單 |
| 以 HTTPS 開啟 | ✅ Chromium 實測 ／ ⚠️ 部署環境需實測 | §3.1 | `https://` 為 secure context，Web Locks 可用 |
| iOS 最低版本 | ⚠️ iOS／iPadOS 15.4+ | Safari 15.4 起才有 Web Locks、BroadcastChannel | 建置 target `['es2020','safari13']`（`vite.config.ts:58`）只保證語法，不保證 API |
| 背景（切換 App、鎖屏）持續收回報 | ❌ | 行動瀏覽器會暫停背景分頁 | 回前景後以 ResumeGate 重新同步（§7.4） |
| 推播通知 | ❌ | 無推播伺服器；iOS 還需安裝成主畫面 App | — |
| 加入主畫面（PWA） | ⚠️ P2 | 需 HTTPS；iOS standalone 模式與 Basic Auth 的相容性未驗證 | MVP 以瀏覽器分頁使用 |
| 震動回饋 | ⚠️ | Android Chrome 有 `navigator.vibrate`；iOS Safari 不支援 | 只作加分項，不可作為唯一回饋 |
| 成交音效 | ⚠️ | 行動瀏覽器需使用者手勢後才能播放音訊 | 首次點擊後解鎖 |
| 螢幕常亮（Wake Lock） | ⚠️ P2 | 需實測各版本行為 | 選配 |

### 2.2 行情與圖表

| 項目 | 判定 | 依據 | 說明 |
|---|---|---|---|
| 即時成交、五檔（股票、期貨、選擇權） | ✅ | SSE `tick_*`／`bidask_*`；`useQuote()`（`src/hooks/use-stream.ts:40`） | 玉山帳戶的報價也走永豐 |
| 指數報價 | ✅ | SSE `quote_idx`（`src/lib/stream.ts:281` 正規化） | |
| 快照（開高低收、漲跌、量） | ✅ | `POST /api/v1/data/snapshots`（`src/lib/shioaji.ts:387`） | |
| 盤中零股行情 | ✅ | `useQuote(code, { oddLot: true })` | 量以股計 |
| 分 K（1／5／15／60 分） | ✅ | `POST /api/v1/data/kbars` **只回 1 分 K**，前端聚合（`src/lib/utils/kbars.ts:40`） | 手機縮短查詢區間（§9.3） |
| 日 K | ⚠️ 由 1 分 K 聚合 | 與桌面相同（`src/components/candle-chart.tsx:172-178`） | 官方日線管線（`docs/design/daily-kbar-data-plan.md`）尚未實作；不含除權息調整，畫面須標註 |
| 當日走勢 | ✅ | `fetchChartHistory()`（`src/lib/chart-history.ts:14`）＋即時 tick；盤別視窗 `sessionWindowFor()`（`src/lib/intraday-session.ts:21`） | |
| 逐筆明細 | ✅ | `fetchLastTicks()`（`src/lib/shioaji.ts:429`）＋ `onAnyTick()` | |
| 商品資訊（漲跌停、參考價、可否當沖、資券餘額） | ✅ | `useContract(code)`（`src/lib/contracts-cache.ts:121`）／`fetchContractInfo()` | |
| 升降單位 | ✅ | `tickSizeFor`／`roundToTick`／`stepPrice`（`src/lib/utils/ticksize.ts:31-70`） | 期權以 server tick bands 為準 |
| 商品搜尋 | ✅ | `searchProducts()`（`src/lib/product-search.ts:170`） | |
| 自選清單（與桌面共用） | ✅ ／ ⚠️ | `/api/v1/watchlist` CRUD；`useWatchlist()`（`src/hooks/use-watchlist.ts:91`） | ⚠️ 永豐 sidecar 容器只掛載 `./certs`（`docker-compose.yml:60-61`），容器重建後清單是否保留未驗證 |
| 漲跌幅排行 | ✅ P2 | `POST /api/v1/data/scanner`（`src/lib/shioaji.ts:442`） | |

### 2.3 交易（委託）

| 項目 | 永豐 | 玉山 | 依據 | 說明 |
|---|---|---|---|---|
| 股票整股 限價 ROD／IOC／FOK | ✅ | ✅ | `placeStockOrder()`（`src/lib/shioaji.ts:850-866`）→ 玉山帳戶自動轉 `placeEsunStockOrder()` | 玉山 1–499 張（`order-mapping.ts:193-199`） |
| 股票整股 市價 | ✅ | ✅ | `toEsunOrderPayload()`（`order-mapping.ts:386-431`） | 市價送 `price: 0`；預設效期 IOC（`defaultOrderTypeFor()`） |
| 盤中零股（1–999 股、限價 ROD、現股） | ✅ | ✅ | `stockOrderProblem()`（`src/lib/odd-lot.ts:110-117`）、`validateEsunStockOrder()`（`order-mapping.ts:201-219`） | |
| 盤後零股（13:40–14:30 收單） | ✅ P1 | ✅ P1 | 桌面下單面板提供（`src/components/order-ticket.tsx:1058-1063`） | |
| 盤後定價（Fixing） | ⚠️ | ⚠️ | 桌面下單面板未提供；玉山 ap_code 2 已有對應（`order-mapping.ts:376`） | 本期不做 |
| 融資、融券、現股當沖先賣 | ✅ P1 | ✅ P1 | `creditLabel()`、`stockOrderProblem()`、`validateEsunStockOrder()` | 只限整股 |
| 借券賣出 | ⚠️ | ❌ | `order-mapping.ts:179-184` | 手機不提供 |
| 鉅額 | ⚠️ 桌面未提供 | ❌ | `order-mapping.ts:175-177` | 手機不提供 |
| 興櫃 | ⚠️ 未驗證 | ❌ | `order-mapping.ts:188-190` | 手機不提供 |
| 期貨／選擇權 單式 | ✅ | ❌ | `placeFuturesOrder()`（`src/lib/shioaji.ts:868-883`） | 價別 LMT／MKT／MKP；效期 ROD／IOC／FOK；倉別 自動／新倉／平倉／當沖（`src/lib/order-conditions.ts`） |
| 期權組合單 | ✅ API 存在 | ❌ | `placeComboOrder()`（`src/lib/shioaji.ts:1550`） | 手機不提供 |
| 改價 | ✅（零股不可） | ✅（ROD 限價、非預約、非零股） | `updateOrderPrice()`（`src/lib/shioaji.ts:1112-1125`）、`validateEsunOrderPriceMutation()`（`order-mapping.ts:244`） | |
| 減量 | ✅ | ✅（預約單不可） | `updateOrderQty(tradeId, 減少量)`（`src/lib/shioaji.ts:1127-1138`） | 參數是**減少量**，不是新數量 |
| 刪單（含回讀確認） | ✅ | ✅ | `cancelOrder()`（`src/lib/shioaji.ts:982-1000`）、`cancelEsunOrder()`（`src/lib/esun/dispatch.ts:162`） | 回讀未確認時丟出 `CANCEL_UNCONFIRMED`，不可重送 |
| 全部刪單 | ✅ | ✅ | `cancelAllOrders()`（`src/lib/trade.ts:475`） | |
| 委託／成交即時回報 | ✅ | ✅ | SSE `order_event`；`/esun/stream/orders`（`src/lib/esun/stream.ts:235`） | |
| 持倉平倉（帶入全部數量） | ✅ | ✅（股票） | `placeStockExitByShares()`（`src/lib/trade.ts:379-472`）；期貨 `placeQuickOrder(…, { ocType: 'Cover' })` | 股票不提供反手 |
| 一鍵閃電下單、圖上拖曳改價 | ❌ 刻意不做 | | | 誤觸風險 |
| 觸價、括號（停損停利）、條件單、背景執行 | ❌ | | `src/main.tsx:21-29` 的前端引擎 | 手機分頁被暫停時引擎不會執行，會讓使用者誤以為有保護 |

### 2.4 帳務

| 項目 | 永豐 | 玉山 | 依據 |
|---|---|---|---|
| 持倉 | ✅ | ✅ | `/api/v1/portfolio/position_unit`；`/esun/portfolio/positions`（bridge 6 秒快取） |
| 股票交割帳戶餘額 | ✅ | ✅ | `account_balance`；`/esun/portfolio/balance`（bridge 180 秒快取） |
| 交割款 | ✅ | ✅ | `settlements`；`/esun/portfolio/settlements`（25 秒快取、3 次／分） |
| 買賣額度 | ✅ P1 | ✅ P1 | `trading_limits`；`/esun/portfolio/trading-limits` |
| 期貨保證金 | ✅ | — | `margin` |
| 已實現損益 | ✅ P1 | ✅ P1（最長 180 天） | `profit_loss`；`clampEsunDateRange180Days()` |
| 憑證到期 | ✅ | ✅ | `/api/v1/health` 的 `ca_expires_in_days`；`/esun/ca_expiretime` |
| 永豐每日流量 | ✅ | — | `/api/v1/auth/usage`（`parseUsage()`、`quotaState()`：`src/lib/server-monitor.ts:37-42`） |

### 2.5 環境與帳號管理

| 項目 | 判定 | 依據 | 說明 |
|---|---|---|---|
| 永豐模擬／正式切換 | ❌ | 由部署的 `SJ_PRODUCTION` 決定（`docker-compose.yml:55`） | 手機只顯示目前環境 |
| 玉山模擬／正式切換 | ❌ 手機不提供 | API 存在（`POST /esun/auth/environment`） | 只讀徽章；切換請用桌面 |
| 玉山重新連線（非強制） | ⚠️ P1 | `POST /esun/auth/reconnect`；登入 10 次／分、300 次／日、密碼錯 3 次鎖帳（`server/esun_trade_server.py:11-26`） | 60 秒冷卻 |
| 伺服器端風控總開關 | ❌ 不存在 | 風控只存在各瀏覽器 localStorage（`src/lib/risk.ts:20`） | 手機風控設定與桌面不同步，需明示 |

---

## 3. 🔒 Phase 0：HTTPS 存取層（硬性前置）

### 3.1 為什麼必須 HTTPS

程式路徑：

1. `src/lib/shared-stream.ts:19-20` 讀取 `BroadcastChannel` 與 `navigator.locks`。
2. `src/lib/shared-stream.ts:64-66`：任一缺少就呼叫 `onMissing()`，**不建立 EventSource**（fail-closed，避免每個分頁各開一條串流）。
3. `src/lib/stream.ts` 的 `onMissing` 只會把狀態設為 `down`。
4. `useTradingLive()`（`src/hooks/use-stream.ts:24-28`）恆為 `false` → 下單鍵停用；`assertTradingLive()`（`src/lib/trade.ts:107-113`）丟出「行情非 LIVE…已暫停下單」。

Web Locks API 只在 secure context 提供。實測（Playwright Chromium，以 `route.fulfill` 模擬各來源，2026-11-05）：

| 來源 | `isSecureContext` | `navigator.locks` | `crypto.randomUUID` | 結論 |
|---|---|---|---|---|
| `http://192.168.1.20:8080/` | false | 無 | 無 | ❌ 永遠無法下單 |
| `http://trade.lan:8080/` | false | 無 | 無 | ❌ 永遠無法下單 |
| `https://trade.example.ts.net/` | true | 有 | 有 | ✅ |
| `http://127.0.0.1:8080/`、`http://localhost:8080/` | true | 有 | 有 | ✅（只限本機，手機用不到） |

> 結論：`docs/fork/esun.md`「區網存取」（HTTP ＋ Basic Auth）可以讓手機打開頁面，但**永遠無法下單**。手機使用必須在 nginx 前面加 TLS。

### 3.2 方案

| 方案 | 做法 | 優點 | 注意 |
|---|---|---|---|
| **A（建議）Tailscale** | 主機與手機加入同一 tailnet，啟用 MagicDNS 與 HTTPS 憑證，用 `tailscale serve` 把 `https://<機器>.<tailnet>.ts.net` 轉到 `http://127.0.0.1:8080` | 公開信任的憑證、不開放任何埠、外出也能用、網路層驗證 | ⚠️ 必須實測轉送時 `Host` 是否保留為 ts.net 主機名；不保留時改用方案 B，或讓 Tailscale 轉到同機的 Caddy |
| **B Caddy** | 同機執行 Caddy，`reverse_proxy 127.0.0.1:8080`，`tls internal` | `Host` 預設保留；SSE 可即時 flush | 手機要安裝並完全信任 Caddy 根憑證（iOS：設定 → 一般 → 關於本機 → 憑證信任設定） |
| C nginx 直接終結 TLS | 修改 `deploy/nginx.conf.template` 增加 TLS listener 並掛載憑證 | 少一個元件 | 修改 fork 部署檔；憑證信任問題同 B |

### 3.3 部署必要條件（三種方案共通）

1. **保留 Host**：TLS 前端轉給 nginx 時必須保留原始 `Host`（例如 `trade.example.ts.net`）。
   - nginx 只接受白名單 Host，其餘回 444（`deploy/nginx.conf.template:21-27`）。
   - `/api/`、`/esun/` 要求 `Origin` 的主機等於 `Host`（`deploy/nginx.conf.template:7-11`），否則 403。
2. **加入白名單**：`.env` 的 `WEB_SERVER_NAMES` 加入該主機名；compose 會同時帶入玉山 bridge 的 `ESUN_ALLOWED_HOSTS`（`docker-compose.yml:95`），否則 `/esun/` 回 421。
3. **SSE 不可緩衝**：前端代理需即時 flush `text/event-stream`，讀取逾時 ≥ 120 秒（心跳 30 秒、看門狗 75 秒：`src/lib/stream.ts:511-513`）。
4. **不對外開放**：維持 `WEB_BIND=127.0.0.1`，只讓同機 TLS 前端連 `127.0.0.1:8080`；不得設定路由器轉埠。
5. **存取控制**：方案 A 以 tailnet 存取控制為主；若同時啟用 `WEB_BASIC_AUTH`，需實測 iOS「加入主畫面」模式的 Basic Auth 行為（⚠️）。

```caddyfile
# Caddyfile（方案 B）— 只在私有網路使用的 TLS 前端；主機名請換成自己的
trade.lan {
    # 使用 Caddy 內建 CA 簽發憑證；手機需安裝並信任 Caddy 根憑證
    tls internal

    reverse_proxy 127.0.0.1:8080 {
        # SSE（/api/v1/stream/data、/esun/stream/orders）每個事件立即送出，不緩衝
        flush_interval -1
        # Caddy 預設保留原始 Host：nginx 的 Host 白名單與 Origin 檢查依賴這一點
    }
}
```

```dotenv
# .env — 只讓同機的 TLS 前端連到 nginx
WEB_BIND=127.0.0.1
# 手機實際使用的主機名（空白分隔）；同時成為 nginx server_name 與玉山 bridge 的 ESUN_ALLOWED_HOSTS
WEB_SERVER_NAMES=trade.lan
```

### 3.4 Phase 0 驗收

- [ ] 手機開啟 `https://<主機名>/mobile.html`，診斷區顯示 `isSecureContext = true`、`navigator.locks` 可用。
- [ ] 10 秒內狀態列顯示「LIVE」。
- [ ] 帶不符的 Origin 呼叫 `/api/v1/info` 回 403；不在白名單的 Host 被拒（444）。
- [ ] 主機以外的區網裝置無法直接連到 `:8080`。

---

## 4. 🧱 前端架構

### 4.1 部署拓撲

```text
 iPhone Safari／Android Chrome
          │ HTTPS（secure context）
          ▼
 TLS 前端（Tailscale serve／Caddy）── 保留 Host ──┐
                                                  ▼
               nginx（shioaji-pro-web，127.0.0.1:8080）
               ├─ /mobile.html、/index.html、/approval.html、靜態資產
               ├─ /api/  ─► 永豐 sidecar 127.0.0.1:21322
               │            行情／合約／委託／帳務 REST、SSE /api/v1/stream/data
               └─ /esun/ ─► 玉山 bridge esun-bridge:8090（nginx 注入 X-Esun-Bridge-Token）
                            委託／帳務 REST、SSE /esun/stream/orders
```

### 4.2 入口與目錄（全部為 fork 擁有的新檔案）

```text
mobile.html                        # 第三個 HTML 入口（與 index.html、approval.html 並列）
vite.fork.config.ts                # 以 mergeConfig 擴充上游設定，加入 mobile 入口
src/mobile/
  main.tsx                         # 入口：polyfills → theme → 強制確認 → bootstrap → render
  app.tsx                          # SecureContextGate ＋ 路由 ＋ 全域 sheet／toast host
  gate/secure-context-gate.tsx     # 非 secure context 的說明頁與診斷
  routes/
    watchlist-page.tsx             # 自選
    trade-page.tsx                 # 交易（圖表／五檔／明細＋下單）
    orders-page.tsx                # 委託
    positions-page.tsx             # 持倉
    account-page.tsx               # 帳戶（資金、損益、帳號、連線、風控、設定）
  components/
    status-bar.tsx                 # 連線／券商／環境／帳戶／風控鎖
    route-badge.tsx                # 「送往 玉山 模擬」徽章
    order-ticket-sheet.tsx         # 下單底部面板
    order-confirm-sheet.tsx        # requestOrderConfirm 的手機確認面板
    order-action-sheet.tsx         # 改價／減量／刪單
    trade-chart.tsx                # 交易圖表（lightweight-charts v5）
    depth-ladder.tsx               # 五檔價格梯
    tick-list.tsx                  # 逐筆明細
    slide-to-confirm.tsx           # 滑動確認
    toast-host.tsx                 # onNotice／onOrderEvent 通知
  hooks/
    use-resume-gate.ts             # ResumeGate 的 React 綁定
    use-risk-pnl-feed.ts           # 風控當日損益餵送（與 src/App.tsx:1045-1053 同公式）
    use-mobile-ticket.ts           # 下單面板狀態與即時驗證
  lib/
    resume-gate.ts                 # ResumeGate 狀態機（純邏輯，可單元測試）
    mobile-order.ts                # 下單流程編排（只呼叫 src/lib 既有函式）
    chart-model.ts                 # 委託線／成本線／漲跌停線的純函式
    chart-ranges.ts                # 手機圖表週期與查詢區間
    hash-router.ts                 # 極簡 hash 路由
    mobile-store.ts                # 目前商品、分頁等 UI 狀態
  styles/*.css.ts                  # vanilla-extract，沿用 src/theme.css.ts 的 vars
```

> 使用 **hash 路由**（`#/trade/2330`）：nginx 的 SPA fallback 會把未知路徑導向桌面 `index.html`（`deploy/nginx.conf.template:144-147`），hash 路由可避免深層連結落到桌面版。

### 4.3 對既有檔案的異動（只動 fork 擁有的檔案）

| 檔案 | 異動 |
|---|---|
| `vite.fork.config.ts`（新） | 以 `mergeConfig` 合併上游 `vite.config.ts`，加入 `mobile` 入口 |
| `Dockerfile` | builder 的 `COPY`（`Dockerfile:21`）加入 `vite.fork.config.ts mobile.html`；`RUN pnpm run build`（`Dockerfile:27`）改為 `RUN pnpm exec tsc -b && pnpm exec vite build --config vite.fork.config.ts` |
| `deploy/nginx.conf.template` | 選配：`location = /m { return 302 /mobile.html; }`（`/mobile.html` 已由 `location /` 以 no-cache 提供，不加也可用） |
| `.github/workflows/fork-ci.yml` | 「Build web (nginx) image」之後新增一步：`docker run --rm --entrypoint test shioaji-pro-web:ci -f /usr/share/nginx/html/mobile.html`（確認映像內有手機入口） |
| `docs/fork/upstream-sync.md` | fork 自有檔案清單加入 `mobile.html`、`vite.fork.config.ts`、`src/mobile/**` |
| `docs/fork/esun.md` | 已完成（與本文件一起提交）：「區網存取」加註手機下單需 HTTPS，並連到本文件 §3。實作時不需再改 |

```ts
// vite.fork.config.ts — fork 擁有：不修改上游 vite.config.ts，加入手機入口
import path from 'node:path';
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import upstream from './vite.config';

export default defineConfig(async (env: ConfigEnv) => {
    // 上游設定是函式型（依 mode／command 產生），用同一組 env 取得實際設定
    const base = (typeof upstream === 'function' ? await upstream(env) : upstream) as UserConfig;
    // mergeConfig 會深層合併：rolldownOptions.input 保留 main、approval，再加上 mobile
    return mergeConfig(base, {
        build: {
            rolldownOptions: {
                input: { mobile: path.resolve(__dirname, 'mobile.html') },
            },
        },
    });
});
```

- **已以原型驗證（2026-11-05）**：以上述 `vite.fork.config.ts`＋最小 `mobile.html`＋引用 MVP 所需 `src/lib` 模組的探針入口執行 `pnpm exec vite build --config vite.fork.config.ts`，同時產出 `index.html`、`approval.html`、`mobile.html`，`vite.config.ts` 完全未修改。原型檔案未提交。
- **開發模式**：`pnpm dev` 不需任何設定即可開啟 `http://127.0.0.1:5173/mobile.html`（Vite dev server 會直接提供根目錄的 HTML）。
- **型別檢查**：`src/mobile/**` 由 `tsconfig.app.json` 的 `include: ["src", …]` 涵蓋，`tsc -b` 會檢查。`vite.fork.config.ts` 不在 `tsconfig.node.json` 內，以 fork-ci 的實際建置驗證。

### 4.4 `mobile.html` 要點

- `<html lang="zh-Hant">`；`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`（安全區）。
- 複製 `index.html` 的 ES5 白畫面防護腳本（舊 WebView 解析失敗時顯示錯誤，而非空白頁）。
- **不載入 Google Fonts**，使用系統字型（減少外部請求）。
- `<meta name="theme-color">` 依深淺主題設定；P2 再加 `manifest`。

### 4.5 啟動順序

```tsx
// src/mobile/main.tsx — 手機入口；polyfills 必須是第一個 import（同 src/main.tsx 的規則）
import '../lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { bootstrap } from '../lib/boot';
import { getRiskSettings, setRiskSettings } from '../lib/risk';
import { initTheme } from '../lib/theme-store';
import { MobileApp } from './app';

// 1) 主題（深淺色、紅漲綠跌）沿用桌面設定
initTheme();

// 2) 手機一律開啟「手動下單確認」：placeQuickOrder／placeStockExitByShares 內部依此設定決定是否跳確認
//    （src/lib/trade.ts:144）；新單由 mobile-order.ts 直接呼叫 requestOrderConfirm，不受此設定影響
if (!getRiskSettings().confirmManualOrders) setRiskSettings({ confirmManualOrders: true });

// 3) 只有 secure context 才啟動連線；否則由 SecureContextGate 顯示 HTTPS 說明（不建立任何連線）
const secure = window.isSecureContext && typeof navigator.locks?.request === 'function';
if (secure) {
    // web 模式：檢查 /api/v1/health → 啟動交易狀態 → 訂閱委託回報（含玉山回報串流）
    bootstrap();
}

// 刻意不呼叫：startTriggerEngine、startBracketRuntime、startOddSpreadService、
// startBackgroundExecution、startConditionalRuntime、startAnalytics（見 §12）

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <MobileApp secure={secure} />
    </StrictMode>,
);
```

`bootstrap()`（`src/lib/boot.ts:169`）在 web 模式會：讀 `/api/v1/health` → `startTradingState` → `subscribeTradeReports()`（`src/lib/boot.ts:577`，對每個可交易帳戶訂閱回報；玉山帳戶會啟動 `/esun/stream/orders`）。帳戶清單由 `fetchAccountsWithEsun()` 合併：永豐在前、玉山在後；**永豐失敗或回空清單時不合併玉山**（`src/lib/esun/dispatch.ts:50-62`），所以玉山也依賴永豐 sidecar 正常。

> 注意：手機頁**不得**帶 `?popout=` 參數。帶了會被視為鏡像視窗（`src/lib/trading-mirror-lease.ts:3-4`），交易狀態不會自行讀取。

---

## 5. 🧩 資訊架構與共用元件

### 5.1 導覽

底部分頁（5 個）：

| 分頁 | 路由 | 內容 |
|---|---|---|
| 自選 | `#/watchlist` | 自選清單、搜尋 |
| 交易 | `#/trade/:code` | 目前商品的圖表／五檔／明細，買進／賣出 |
| 委託 | `#/orders` | 未成交／已成交／全部，改價、減量、刪單（徽章顯示未成交筆數） |
| 持倉 | `#/positions` | 各帳戶持倉、未實現損益、平倉 |
| 帳戶 | `#/account` | 資金、損益、帳號切換、連線、風控、設定 |

### 5.2 全域狀態列（每頁頂端，sticky）

```text
┌──────────────────────────────────────────────┐
│ ● LIVE │ 永豐 正式 · 證 ****4567 ▾  │ 🔓 風控 │
└──────────────────────────────────────────────┘
```

| 區塊 | 資料來源 | 規則 |
|---|---|---|
| 連線燈號 | `useStreamStatus()`、ResumeGate | 綠「LIVE」／黃「連線中」／紅「中斷」／藍「同步中」（ResumeGate 非 ready）；點擊展開連線詳情 |
| 券商＋環境＋帳戶 | `useAccounts()`、`orderRouteOf()`（`src/lib/order-route.ts:56-68`）、`useEsunEnvironment()` | 依目前商品顯示對應市場槽位（股票 `selectedStock`／期貨 `selectedFutures`）；「正式」用醒目的 `danger` 色框，「模擬」用 `accent` 色；環境未知顯示「環境未確認」 |
| 風控鎖 | `useRiskSettings()` | 鎖定時顯示紅色「🔒 已鎖單」；點擊可立即鎖定（解鎖需確認） |

### 5.3 RouteBadge（送單路由徽章）

- 文字固定格式：「送往 {玉山｜永豐} {模擬｜正式｜環境未確認}」，與 `routeConfirmNote()`（`src/lib/order-route.ts:75-79`）一致。
- 出現位置：下單面板頂端、確認面板、委託列。
- 環境未確認時，下單面板的「預覽」按鈕停用。

### 5.4 帳戶切換面板

- 依市場分組：「證券」（永豐、玉山）、「期貨／選擇權」（永豐）。
- 每列顯示：券商、帳號（遮蔽模式下用 `privacyAccountLabel()`）、環境徽章、`canTrade()`（`src/lib/account-tradable.ts:6`）為 false 時標示「不可交易（未簽署）」。
- 選取呼叫 `selectAccount(account)`（`src/lib/account-store.ts:250`）。下單面板開啟或確認進行中時不允許切換（避免路由變更；即使切換，`captureDisplayedRoute()` 也會擋下）。

### 5.5 通知（Toast）

- 訂閱 `onNotice()`（`src/lib/trade.ts:44`）顯示 lib 發出的通知。
- 訂閱 `onOrderEvent()`，以 `describeOrderReport()`（`src/lib/order-report.ts:261`）產生成交／委託回報文字。
- 成交通知可附音效（P1，需手勢解鎖）與 Android 震動（10 ms）。
- 遮蔽金額模式（`usePrivacyMoney()`，`src/lib/privacy.ts:80`）下不顯示金額。

---

## 6. 📲 畫面規格

### 6.1 自選（`#/watchlist`）

```text
┌ 自選 ────────────────────────── [🔍] [✎] ┐
│ [我的自選 ▾]                              │
├──────────────────────────────────────────┤
│ 2330 台積電        1,085.0   ▲15.0 +1.40% │
│ 2317 鴻海            212.5   ▼1.5  −0.70% │
│ TXFL6 台指期近     22,950    ▲80   +0.35% │
│ …                                        │
└──────────────────────────────────────────┘
```

- 資料：`useWatchlist()`（伺服器端清單，與桌面共用）；即時價 `useQuote(code, { narrow: true })`。
- **只有可見列訂閱行情**（虛擬清單＋IntersectionObserver），離開畫面由 `RELEASE_GRACE_MS`（1.5 秒，`src/lib/quote-ownership.ts`）後釋放，控制訂閱數與流量。
- 點一列 → `#/trade/:code`；長按 → 刪除／移動。
- 搜尋：`searchProducts(query, 10)`，結果可「加入自選」或直接開啟交易頁。
- 顏色：漲 `vars.color.up`、跌 `vars.color.down`（隨使用者的台灣／國際配色設定）。

### 6.2 交易（`#/trade/:code`）— 以下單為中心的重新設計

```text
┌ 狀態列 ──────────────────────────────────────┐
├──────────────────────────────────────────────┤
│ 2330 台積電 · 上市                    ☆  ⋯  │
│ 1,085.0  ▲15.0 (+1.40%)   量 23,456 張       │
│ 漲停 1,175 · 跌停 963 · 參考 1,070 · 可當沖  │
├─[走勢][1分][5分][15分][60分][日]─────────────┤
│                                    ┌────────┐│
│      交易圖表（約 42% 高度）       │1,175 漲停││
│  ─ ─ ─ 買 2 @1,080（我的委託）─ ─ │1,085 ◀ ││
│  ······ 成本 1,052.5 ··········· │ 963 跌停││
│                                    └────────┘│
├─[五檔][明細]─────────────────────────────────┤
│ 買一 1,084 × 120      賣一 1,085 × 88        │
│ 持倉：現股 3 張 · 均價 1,052.5 · +97,500     │
│ 未成交：2 筆 ›                               │
├──────────────────────────────────────────────┤
│ [      買 進      ]   [      賣 出      ]     │ ← sticky，位於安全區上方
├──────────────────────────────────────────────┤
│  自選    交易    委託    持倉    帳戶         │
└──────────────────────────────────────────────┘
```

**標頭**：`useContract(code)` 取得名稱、漲跌停、參考價、`day_trade`；即時價格 `useQuote(code)`。股票顯示漲跌停與「可當沖／不可當沖」；期貨顯示到期月份與交易時段（`sessionWindowFor()`）。

**交易圖表（`trade-chart.tsx`，lightweight-charts v5）**

| 圖層 | 資料 | 樣式 |
|---|---|---|
| K 線／走勢線＋成交量 | `fetchChartHistory()` → `kbarsToCandles()` → `aggregate()`；最後一根由即時 tick 更新 | 走勢模式畫參考價基準線 |
| 漲停／跌停線（僅股票） | `ContractInfo.limit_up`／`limit_down` | 細虛線，價格軸標籤「漲停」「跌停」 |
| 參考價（平盤） | `ContractInfo.reference` | 灰色細線 |
| **我的未成交委託** | `useTradingState().trades` 中目前商品、狀態屬 `ACTIVE_ORDER_STATUSES`（`src/lib/types/order.ts:125-130`）且 `remainingWorkingOrderQuantity() > 0` 者 | 每筆一條水平線：買用 `up` 色、賣用 `down` 色；標籤「買 2 @1,080」；市價單不畫 |
| **持倉成本線** | `useTradingState().positions` 中目前商品的均價 | 點狀線，標籤「成本 1,052.5」 |
| 最新價 | 即時 tick | 價格軸高亮 |

互動：

- 單指拖曳平移、雙指縮放（`handleScroll`、`handleScale`）。
- **長按**進入追蹤模式（lightweight-charts 的 `trackingMode`，觸控長按啟用），十字線價格以 `roundToTick(contract, price)` 取整；放開後浮出「以 1,080 買進／賣出」→ 開啟下單面板並**帶入價格**，**不會直接送單**。
- 點委託線標籤 → 開啟該筆的委託操作面板（改價／減量／刪單）。
- **不支援拖曳委託線改價**。
- 橫向旋轉（P1）：圖表全螢幕＋週期列，底部保留買進／賣出按鈕。
- 指標：MVP 只有成交量與 MA(5／20)；其他指標 P2。
- 日 K 圖說：「日 K 由 1 分 K 聚合，未含除權息調整」。

線條模型抽成純函式，方便測試：

```ts
// src/mobile/lib/chart-model.ts — 由交易狀態產生圖上的水平線（純函式，不碰圖表 API）
import { ACTIVE_ORDER_STATUSES, type AccountedTrade } from '../../lib/types/order';
import { remainingWorkingOrderQuantity } from '../../lib/working-order-quantity';

export interface PriceLineSpec {
    key: string;                 // 穩定 key：同一筆委託更新時重用同一條線
    price: number;
    kind: 'order-buy' | 'order-sell' | 'cost' | 'limit-up' | 'limit-down' | 'reference';
    label: string;               // 價格軸上的標籤文字
    tradeId?: string;            // 委託線才有：點擊時開啟委託操作面板
}

/**
 * 目前商品的未成交限價委託 → 委託線（市價、已無剩餘量者不畫）
 * orderableCode：目前商品實際下單的合約代碼。連續月別名（如 TXFR1）下單時會換成實際月份
 * （src/lib/shioaji.ts 的 orderableKey），所以呼叫端傳入 contract.target_code || contract.code。
 */
export function workingOrderLines(orderableCode: string, trades: readonly AccountedTrade[]): PriceLineSpec[] {
    return trades
        .filter(t => (t.contract.target_code || t.contract.code) === orderableCode)
        .filter(t => ACTIVE_ORDER_STATUSES.has(t.status.status) && remainingWorkingOrderQuantity(t) > 0)
        .filter(t => t.order.price_type === 'LMT')
        .map(t => {
            // 改價後以 modified_price 為準（與桌面 OrderEditor 相同）
            const price = t.status.modified_price || t.order.price;
            const side = t.order.action === 'Buy' ? '買' : '賣';
            return {
                key: `order:${t.order.id}`,
                price,
                kind: t.order.action === 'Buy' ? 'order-buy' : 'order-sell',
                label: `${side} ${remainingWorkingOrderQuantity(t)} @${price}`,
                tradeId: t.order.id,
            };
        });
}
```

> 連續月別名（`TXFR1`／`TXFR2`）只用於行情；委託一律以實際月份合約送出（`src/lib/shioaji.ts:821-830` 的 `orderableKey()`）。圖上委託線比對時用 `contract.target_code || contract.code`，並為「別名頁面也畫得出實際月份委託」寫測試。

**五檔價格梯（`depth-ladder.tsx`）**

```text
 委買量    價格     委賣量
           1,089      45
           1,087      30
           1,085      88   ← 賣一
  120     1,084            ← 買一
   76     1,083
          …（共買賣各五檔）
```

- 資料：`useQuote(code)` 的 BidAsk。
- 點任一價位 → 開啟下單面板並帶入該價（**只帶價，不決定買賣**）。
- 自己的未成交委託在對應價位標示「我 買2」。
- 盤中零股商品切換「零股」時改用 `useQuote(code, { oddLot: true })`。

**逐筆明細（`tick-list.tsx`）**：先以 `fetchLastTicks(contract, 50)` 取得最近 50 筆，再接 `onAnyTick()`；最多保留 200 筆；內外盤以 `tick_type`（1 外盤、2 內盤）著色。

### 6.3 下單面板（`order-ticket-sheet.tsx`，底部面板）

股票版：

```text
┌────────────────────────────────────────────┐
│ ▔▔▔                                        │
│ 2330 台積電             送往 玉山 模擬 ●    │ ← RouteBadge（必顯示）
│ 帳戶  玉山 ****3456（證券）         [切換]  │
│ [  買進  ][  賣出  ]                        │
│ 單位  [整股][盤中零股][盤後零股 P1]          │
│ 條件  [現股][融資 P1][融券 P1] □當沖先賣 P1 │
│ 價別  [限價][市價]    效期 [ROD][IOC][FOK]  │
│ 價格  [－]  1,085.0  [＋]                   │
│       [買一][賣一][成交][漲停][跌停][平盤]   │
│ 數量  [－]    2 張    [＋]   [1][2][5][10]   │
│ ──────────────────────────────────────────│
│ 預估金額 2,170,000（不含手續費、稅）         │
│ ⚠ 單筆上限 5 張（風控）                     │
│ [            預覽並確認委託            ]     │
└────────────────────────────────────────────┘
```

期貨／選擇權版差異：

- 沒有「單位」「條件」列。
- 價別 `[限價][市價][範圍市價]`；倉別 `[自動][新倉][平倉][當沖]`（`FUTURES_OCTYPES`）。
- 數量單位「口」；金額列改為「名目價值 = 價格 × 契約乘數 × 口數」（`ContractInfo.multiplier`），**不估保證金**（無可靠來源）。

欄位規則：

| 欄位 | 規則 | 依據 |
|---|---|---|
| 帳戶 | 開啟時以 `captureSelectedAccount(market)` 固定；顯示並帶入 `captureDisplayedRoute()` | `src/lib/order-account.ts:13-17`、`src/lib/order-route.ts:95-105` |
| 單位 | 切換時數量歸 1；零股強制 限價＋ROD＋現股＋不當沖 | 同桌面 `order-ticket.tsx:1078-1096` |
| 價別／效期 | 預設 `defaultOrderTypeFor()`（限價→ROD、市價→IOC）；零股停用原因 `orderTypeDisabledReason()`／`priceTypeDisabledReason()` | `src/lib/order-conditions.ts:33-45` |
| 價格 | 開啟時帶入一次（來源：長按／五檔價位，否則最新成交價），**之後不自動跟價**；旁邊顯示即時成交價；步進用 `stepPrice()`；輸入失焦以 `roundToTick()` 檢查，不符顯示「價格不符合升降單位」 | `src/lib/utils/ticksize.ts` |
| 快捷價 | 買一／賣一／成交來自 `useQuote`；漲停／跌停／平盤來自 `ContractInfo`。一律送**限價**（玉山的平盤／漲停／跌停 price flag 不使用，`toEsunOrderPayload()` 只映射限價與市價） | `order-mapping.ts:392-396` |
| 股票價格範圍 | 限價必須介於跌停與漲停之間，否則停用預覽 | `ContractInfo.limit_up`／`limit_down` |
| 數量 | 正整數；整股 1–499 張（玉山）、零股 1–999 股 | `order-mapping.ts:193-219`、`ODD_LOT_MAX_SHARES` |
| 市價 | 送 `price: 0`（同桌面 `order-ticket.tsx:307`） | |
| 提示 | 信用相關提示用 `manualStockCreditHint()`、`cashOrderCreditWarning()`（P1） | `src/lib/stock-exit-cond.ts:45-90` |

即時驗證（任一不通過就顯示第一個原因並停用「預覽」）：

1. 帳戶存在、`canTrade()`、市場相符（股票帳戶 `S`、期貨帳戶 `F`），且玉山帳戶不可用於期權。
2. `checkOrderAllowed(qty, orderLot)`（風控鎖、單筆上限、當日虧損上限）。
3. 期權：`futuresOrderProblem({ price_type, order_type, octype })`。
4. 股票：`esunStockLegProblem(account, contract, order) ?? stockOrderProblem(order)`。
5. 價格：限價 > 0、符合升降單位、在漲跌停內（股票）。
6. 連線：`useTradingLive()` 為 true 且 ResumeGate 為 `ready`；ResumeGate 為 `stale-data` 時需勾選「我了解委託／持倉資料可能過期」。
7. 環境：RouteBadge 不是「環境未確認」。

### 6.4 確認面板（`order-confirm-sheet.tsx`）

- 綁定既有確認佇列：`subscribeOrderConfirm()`、`getPendingOrderConfirm()`、`resolveOrderConfirm()`（`src/lib/order-confirm.ts:76-90`）。**必須掛在 App 根層**，否則 `requestOrderConfirm()` 的 promise 永遠不會結束。
- 內容：動作（含信用名稱，如「融券賣出」）、商品、價格（市價顯示「市價」）、數量＋單位、條件說明（`note`）、帳戶（`accountLabel`）、**環境大字**（模擬／正式）。
- 送出手勢：**滑動確認**（slide-to-confirm，需滑過 80% 寬度）。取消：點背景、下滑或「取消」。
- 滑動元件停用條件與桌面相同（`src/components/order-confirm-dialog.tsx:113`）：`awaitingMode`、`simulation === null`、`serverChanged`、有 `livePriceCode` 但尚無即時價。
- `serverChanged` 時顯示「伺服器或模式已變更，這筆不會送出，請取消後重新下單」。
- ResumeGate 離開 `ready`（例如確認中切到背景）時，自動 `resolveOrderConfirm(false)`。

### 6.5 委託（`#/orders`）

```text
┌ 委託 ────────────────────────── [⟳ 更新] ┐
│ [未成交 3] [已成交] [全部]     帳戶：全部 ▾│
│ ⚠ 串流中斷：重新連線後請手動對帳  [對帳]   │ ← 對帳原因 banner
├──────────────────────────────────────────┤
│ 2330 台積電  買 · 整股 · 限價 ROD          │
│ 1,080 × 2 張   成交 0 · 剩餘 2             │
│ 送往 永豐 正式 · 09:12:03 · 書號 A1234    │
│                   [改價] [減量] [刪單]     │
├──────────────────────────────────────────┤
│ 2317 鴻海  賣 · 盤中零股 · 限價 ROD        │
│ 212.5 × 300 股   成交 0 · 剩餘 300         │
│ 送往 玉山 模擬 · 預約 11/06                │
│                           [減量] [刪單]   │
├──────────────────────────────────────────┤
│           [ 全部刪單（3 筆） ]             │
└──────────────────────────────────────────┘
```

- 資料：`useTradingState().trades`（`AccountedTrade`，每列帶帳戶）；「未成交」= `ACTIVE_ORDER_STATUSES` 且剩餘量 > 0。
- 對帳：`queries.orders.needsReconcile`／`reasons` 以 `RECONCILE_REASON_LABELS`（`src/lib/trading-state.ts:70-84`）顯示；「更新」呼叫 `refreshTradingState('orders')`（`src/lib/trading-state.ts:362`），按下後 6 秒冷卻（玉山 refresh 有 5 秒間隔、10 次／分限制）。
- 玉山列：以 `useEsunOrderMeta()`（`src/lib/esun/account-details.ts:863`）顯示預約日；預約單以 `isEsunReservationTrade()`（`src/components/esun-order-meta.tsx`）判斷。
- 按鈕顯示規則：

| 動作 | 顯示條件 | 呼叫 |
|---|---|---|
| 改價 | 限價、非零股（`isOddLot()`）、非玉山預約單；玉山再以 `validateEsunOrderPriceMutation()` 檢查 | `updateOrderPrice(tradeId, newPrice)` |
| 減量 | 剩餘量 ≥ 2、非玉山預約單 | `updateOrderQty(tradeId, remaining - newRemaining)`（輸入「新的剩餘數量」，同 `src/components/bottom-dock-orders.tsx:157-175`） |
| 刪單 | 一律顯示（刪單是降低風險的動作，**不因玉山 `celable` 提示而隱藏**） | `cancelOrder(tradeId)` |
| 全部刪單 | 有未成交委託 | `cancelAllOrders()` |

- 每個動作都先開確認面板（`order-action-sheet.tsx`，滑動確認）；全部刪單需列出筆數與涉及帳戶。
- 結果訊息一律用 `mutationErrorNotice(err, verb)`（`src/components/esun-order-meta.tsx:91-97`），確保「未送出」與「失敗或結果未知、勿自動重送」用語與桌面一致。

### 6.6 持倉（`#/positions`）

```text
┌ 持倉 ──────────────── 帳戶：全部 ▾ [⟳] ┐
│ 未實現損益合計 +127,500（估）           │
├────────────────────────────────────────┤
│ 2330 台積電  現股 多 3 張 · 永豐 正式    │
│ 均價 1,052.5 · 現價 1,085 · +97,500      │
│                    [平倉] [加碼] [看圖]  │
├────────────────────────────────────────┤
│ TXFL6 台指期  多 1 口 · 永豐 正式        │
│ 均價 22,800 · 現價 22,950 · +30,000      │
│                         [平倉] [看圖]    │
└────────────────────────────────────────┘
```

- 資料：`useTradingState().positions`（現價會被即時 tick 更新）；`queries.positions` 的對帳原因同委託頁。
- **平倉**：
  - 股票：`stockExitFor(direction, cond, shares)`（`src/lib/stock-exit-cond.ts:22`）回傳字串時顯示原因、不送出；否則 `placeStockExitByShares(contract, exit, shares, account, { orderCond })`。行為：**整張以市價（IOC）、零股以漲跌停價的盤中零股限價**送出，確認只出現一次（`src/lib/trade.ts:403-418`）。平倉前的說明面板需寫明這一點。
  - 期貨：`placeQuickOrder(contract, 反向, null, 口數, { account, ocType: 'Cover' })`（市價 IOC；確認由 `confirmManualOrders` 觸發，手機已強制開啟）。
  - 股票不提供反手；信用部位非整張時依 `stockExitFor()` 拒絕。
- **加碼**：開啟下單面板並帶入同方向、同帳戶。
- 未實現損益標示「（估）」：來源是券商持倉＋即時價推估。

### 6.7 帳戶（`#/account`）

| 區塊 | 內容 | 資料 |
|---|---|---|
| 帳號 | 證券／期貨槽位切換（§5.4） | `useAccounts()` |
| 資金 | 股票：交割帳戶餘額、交割款（T+1／T+2）；期貨：權益數、可用保證金、維持率 | `useTradingState().balance`／`margin`；玉山另以 `esunTradeService.fetchAccountBalance()`、`fetchSettlements()` |
| 額度（P1） | 買賣額度、資券額度 | `fetchTradingLimits()` |
| 損益（P1） | 已實現損益（日期區間；玉山上限 180 天） | `fetchProfitLoss()`、`fetchProfitLossSummary()` |
| 連線 | 永豐串流狀態、最後心跳時間（`getLastHeartbeat()`）、連線世代；玉山 bridge：登入、環境、`sessionExpired`、`wsConnected`、回報串流狀態（`getEsunStreamStatus()`） | `src/lib/stream.ts:157,909`、`EsunBridgeHealth`（`src/lib/esun/adapter.ts:29-55`） |
| 伺服器 | 版本（`/api/v1/info`）、模擬／正式、憑證剩餘天數、每日流量 | `fetchInfo()`、`fetchHealth()`、`/api/v1/auth/usage` |
| 玉山重新連線（P1） | 只提供一般重新連線（不提供 force），60 秒冷卻，按下前提醒「密碼錯誤 3 次會鎖帳」 | `esunTradeService.reconnect()` |
| 風控 | 一鍵鎖單、單筆上限、當日虧損上限；「手動下單確認」顯示為**鎖定開啟** | `useRiskSettings()`、`setRiskSettings()` |
| 顯示 | 深／淺色、台灣（紅漲綠跌）／國際配色、字級、遮蔽金額 | `useThemeSettings()`、`usePrivacyMoney()` |
| 診斷 | secure context、Web Locks、BroadcastChannel、User Agent、建置版本 `__SHIOAJI_BUILD_VERSION__` | — |

---

## 7. 🧾 下單、改單、刪單流程

### 7.1 新單流程（`src/mobile/lib/mobile-order.ts`）

順序比照桌面 `src/components/order-ticket.tsx:286-445`，另加手機閘門。

```ts
// src/mobile/lib/mobile-order.ts — 手機新單流程：只編排 src/lib 既有函式，不自行組 HTTP 請求
import { ORDER_CONTEXT_CHANGED_MESSAGE } from '../../hooks/use-order-context';
import { captureDisplayedRoute, esunStockLegProblem, routeConfirmNote } from '../../lib/order-route';
import { accountConfirmLabel, requestOrderConfirm } from '../../lib/order-confirm';
import { ACCOUNT_CHANGED_MESSAGE, captureSelectedAccount, isSelectedAccountUnchanged } from '../../lib/order-account';
import { checkOrderAllowed } from '../../lib/risk';
import { creditLabel, lotLabel, orderQtyUnit, stockOrderProblem } from '../../lib/odd-lot';
import { futuresOrderProblem } from '../../lib/order-conditions';
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE } from '../../lib/server-info-store';
import { placeFuturesOrder, placeStockOrder } from '../../lib/shioaji';
import { assertTradingLive, OrderConfirmCancelled } from '../../lib/trade';
import type { MobileOrderInput } from './mobile-order-types';

/** 確定沒有送出的錯誤（UI 依此顯示「未送出」） */
function notStarted(message: string): Error & { mutationNotStarted: true } {
    return Object.assign(new Error(message), { mutationNotStarted: true as const });
}

export interface MobileOrderGuards {
    /** ResumeGate 必須是 ready（或 stale-data 且使用者已勾選了解）；否則丟出 notStarted */
    assertResumeReady(): void;
    /** 商品／單位／條件沒有變（useOrderContext 的擷取結果） */
    isContextCurrent(): boolean;
}

export async function submitMobileOrder(input: MobileOrderInput, guards: MobileOrderGuards) {
    const market = input.isFutures ? 'F' : 'S';
    // 1) 手機閘門＋串流 LIVE（按鈕已停用，這裡是硬性備援）
    guards.assertResumeReady();
    assertTradingLive();
    // 2) 記下伺服器模式代次：確認期間模擬 sidecar 重啟成正式（同位址）也不送
    const sameServerMode = captureServerMode();
    // 3) 風控：鎖單、單筆上限、當日虧損上限
    const blocked = checkOrderAllowed(input.quantity, input.isFutures ? undefined : input.orderLot);
    if (blocked) throw notStarted(blocked);
    // 4) 商品與券商規則：期權規則；股票先玉山規則再上游規則
    const problem = input.isFutures
        ? futuresOrderProblem({ price_type: input.priceType, order_type: input.orderType, octype: input.octype })
        : esunStockLegProblem(input.displayedAccount, input.contract, input.stockOrder)
            ?? stockOrderProblem({ ...input.stockOrder, day_trade: input.contract.day_trade });
    if (problem) throw notStarted(problem);
    // 5) 固定送單帳戶：必須等於面板上顯示的帳戶
    const orderAccount = captureSelectedAccount(market);
    if (!orderAccount) throw notStarted('缺少有效的下單帳戶，請重新選擇帳戶');
    const sameRoute = captureDisplayedRoute(input.displayedAccount, market);
    sameRoute(); // 顯示的帳戶或環境已變就丟出 ROUTE_CHANGED_MESSAGE
    // 6) 強制確認（不看 confirmManualOrders）；備註最後一定附上實際路由
    const credit = input.isFutures ? undefined : creditLabel(input.action, input.stockOrder.order_cond, input.stockOrder.daytrade_short);
    const approved = await requestOrderConfirm({
        code: input.contract.code,
        name: input.contract.name,
        action: input.action,
        credit,
        price: input.priceType === 'LMT' ? input.price : null,
        quantity: input.quantity,
        unit: orderQtyUnit(input.isFutures, input.orderLot),
        note: [input.orderType, input.isFutures ? undefined : lotLabel(input.orderLot), routeConfirmNote(orderAccount)]
            .filter(Boolean).join('・'),
        accountLabel: accountConfirmLabel(orderAccount),
    }, { serverMode: sameServerMode });
    if (!approved) throw new OrderConfirmCancelled('已取消下單');
    // 7) 確認後重驗（確認可能停留很久）
    if (!sameServerMode()) throw notStarted(SERVER_MODE_CHANGED_MESSAGE);
    if (!isSelectedAccountUnchanged(orderAccount)) throw notStarted(ACCOUNT_CHANGED_MESSAGE);
    // 8) beforeDispatch：HTTP 送出前最後一刻同步重驗，丟出就不送
    const dispatch = {
        beforeDispatch: () => {
            guards.assertResumeReady();
            assertTradingLive();
            if (!guards.isContextCurrent()) throw notStarted(ORDER_CONTEXT_CHANGED_MESSAGE);
            if (!sameServerMode()) throw notStarted(SERVER_MODE_CHANGED_MESSAGE);
            if (!isSelectedAccountUnchanged(orderAccount)) throw notStarted(ACCOUNT_CHANGED_MESSAGE);
            sameRoute();
        },
    };
    dispatch.beforeDispatch();
    // 9) 送出：玉山帳戶由 placeStockOrder 內部轉往 bridge；期權拒絕玉山帳戶
    return input.isFutures
        ? placeFuturesOrder(input.contract, input.futuresOrder, orderAccount, dispatch)
        : placeStockOrder(input.contract, input.stockOrder, orderAccount, dispatch);
}
```

輸入型別以 `isFutures` 區分，TypeScript 才能在各分支取用正確欄位：

```ts
// src/mobile/lib/mobile-order-types.ts — 股票與期權兩種輸入（discriminated union）
import type { Account } from '../../lib/types/portfolio';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action, FuturesOCType, FuturesOrderReq, FuturesPriceType, OrderType, StockOrderLot, StockOrderReq } from '../../lib/types/order';

interface Common {
    contract: ContractInfo;      // useContract() 取得（含漲跌停、day_trade、multiplier）
    displayedAccount: Account;   // 下單面板上顯示的帳戶（必須等於目前市場槽位）
    action: Action;
    quantity: number;            // 整股為張、零股為股、期權為口
    price: number;               // 市價送 0
    orderType: OrderType;
}
export type MobileOrderInput =
    | (Common & { isFutures: false; priceType: 'LMT' | 'MKT'; orderLot: StockOrderLot; stockOrder: StockOrderReq })
    | (Common & { isFutures: true; priceType: FuturesPriceType; octype: FuturesOCType; futuresOrder: FuturesOrderReq; orderLot?: undefined });
```

> `stockOrder.order_cond` 為現股時不送（`undefined`），`daytrade_short` 只在「賣出＋現股」時送 `true`（同 `src/components/order-ticket.tsx:424-438`）。上列型別皆已確認存在於 `src/lib/types/order.ts`、`portfolio.ts`、`contract.ts`。

### 7.2 結果處理

| 結果 | 判斷 | 顯示 | 後續 |
|---|---|---|---|
| 已受理 | promise resolve（`Trade`） | 「委託已送出」＋狀態與書號（`orderStatusWithNumber()`，`src/lib/order-status-label.ts:32`） | 關閉面板；等待回報 |
| 使用者取消 | `OrderConfirmCancelled` | 「已取消」（不視為錯誤） | 面板保留 |
| 確定未成立 | `err.mutationNotStarted === true`（含券商立即回 Failed、玉山 `not_sent`／`rejected`） | 「未送出：{原因}」 | 面板保留，可修改後重試 |
| 結果未知 | 其他所有錯誤（含 `mutationOutcomeUnknown`；逾時：永豐下單與刪單 3 秒、玉山 15 秒，見 §9.2） | 琥珀色「結果未知：請到委託頁按『更新』核對，**勿重送**」 | 關閉面板；委託頁顯示對帳 banner；**不提供重送按鈕** |

### 7.3 改價、減量、刪單、全部刪單

| 動作 | 前置 | 呼叫 | 結果說明 |
|---|---|---|---|
| 改價 | 確認面板（新價格、步進） | `updateOrderPrice(tradeId, price)` | 內部 `prepareOrderMutation()` 驗證委託唯一、帳戶可交易、市場相符；零股直接拒絕 |
| 減量 | 輸入新的剩餘數量 n（1 ≤ n < 剩餘） | `updateOrderQty(tradeId, remaining - n)` | 玉山以 `quantity_unit` 換算張／股 |
| 刪單 | 確認面板 | `cancelOrder(tradeId)` | 只有回讀確認已取消才 resolve；否則 `CANCEL_UNCONFIRMED`（結果未知，勿重送） |
| 全部刪單 | 確認面板（筆數、帳戶） | `cancelAllOrders()` → 回傳筆數 | 先以 `refresh: true` 取得權威委託再逐筆刪 |

- 改價、減量受 ResumeGate 與 `useTradingLive()` 控制；**刪單與全部刪單在 `resyncing` 時仍允許**（降低風險的動作）。若委託其實已成交，刪單不會成立，結果依 lib 的回讀判定顯示（「未送出」或「結果未知」），照 §7.2 處理。
- 風控鎖不擋刪單（`checkOrderAllowed()` 只用於新單）。

### 7.4 ResumeGate（手機特有：回前景重新同步）

**問題**：看門狗在偵測到頁面曾被暫停時，會給一個心跳週期（30 秒）的寬限才判定 STALE（`src/lib/stream.ts:612-634`）。手機切到背景後 EventSource 可能早已中斷，但回前景後最長約 30 秒內狀態仍顯示 `live`，此時畫面上的報價、委託、持倉都可能是舊的，下單面板帶入的價格也可能是幾分鐘前的價格。

**狀態機**（`src/mobile/lib/resume-gate.ts`，純邏輯，可注入時鐘與事件來源測試）：

```text
            hidden ≥ 5 秒後回到 visible／pageshow(persisted)
  ready ───────────────────────────────────────────────► resyncing
    ▲                                                        │
    │  全部條件成立：                                          │ 45 秒內未達成
    │  ① getStreamStatus() === 'live'                        ▼
    │  ② 回前景後觀察到串流活動（tick／bidask／heartbeat）      failed（顯示「連線未恢復」
    │     或 streamConnectionEpoch() 與隱藏前不同（重新連上）         ＋［重新整理頁面］）
    │  ③ refreshTradingState('orders')、('positions') 已結束
    │  ④ 目前商品的快照已重新取得（fetchSnapshots）
    │                                                        │
    └──────────── ③ 或 ④ 失敗 ─────────► stale-data（banner＋［重試］；
                                          新單需勾選「我了解資料可能過期」）
```

規則：

- 隱藏時間 < 5 秒（例如快速切換 App）不進入 `resyncing`。
- 進入 `resyncing` 時：停用新單／改價／減量；關閉進行中的確認面板（`resolveOrderConfirm(false)`）；下單面板的價格標記為「價格可能過期」，需重新點選快捷價或手動確認後才能預覽。
- 觀察活動使用既有匯出：`onAnyTick()`、`onAnyBidAsk()`、`onStreamEvent('heartbeat', …)`、`streamConnectionEpoch()`、`getLastHeartbeat()`（`src/lib/stream.ts:157,489,909,924,932`）。盤中通常 1 秒內就有 tick；非交易時段最長等一次心跳（≤ 30 秒）。
- ③④ 在 ①② 成立後才發出（先確認串流活著再讀快照，符合既有「先訂閱再快照」原則）。
- `refreshTradingState()` 有自己的節流（被節流時立即 resolve），不會因頻繁切換造成查詢風暴。
- 只用 `visibilitychange`、`pagehide`、`pageshow`（iOS 與 Android 皆支援）；不依賴僅 Chromium 才有的 `freeze`／`resume` 事件。

```ts
// src/mobile/lib/resume-gate.ts（節錄）— 只描述判斷，事件來源與時鐘由外部注入，方便單元測試
export type ResumeGateState = 'ready' | 'resyncing' | 'stale-data' | 'failed';

export const HIDDEN_THRESHOLD_MS = 5_000;   // 隱藏少於 5 秒不重新同步
export const RESYNC_TIMEOUT_MS = 45_000;    // 超過仍未恢復 → failed

export interface ResumeChecks {
    streamLive: boolean;            // getStreamStatus() === 'live'
    activitySinceResume: boolean;   // 回前景後收到 tick／bidask／heartbeat，或連線世代改變
    tradingReadSettled: 'pending' | 'ok' | 'failed';  // orders＋positions 重新讀取
    snapshotSettled: 'pending' | 'ok' | 'failed';     // 目前商品快照
}

/** 依目前檢查結果與經過時間決定下一個狀態（純函式） */
export function nextResumeState(checks: ResumeChecks, elapsedMs: number): ResumeGateState {
    const reads = [checks.tradingReadSettled, checks.snapshotSettled];
    if (checks.streamLive && checks.activitySinceResume && !reads.includes('pending')) {
        // 連線已恢復：讀取都成功才算 ready，否則提示資料可能過期
        return reads.includes('failed') ? 'stale-data' : 'ready';
    }
    return elapsedMs >= RESYNC_TIMEOUT_MS ? 'failed' : 'resyncing';
}
```

### 7.5 風控當日損益餵送

桌面由 `src/App.tsx:1045-1053` 呼叫 `reportDailyPnl()`；手機沒有掛載 `App.tsx`，**必須自行餵送**，否則「當日虧損上限」在手機上不會生效。

```ts
// src/mobile/hooks/use-risk-pnl-feed.ts — 與 src/App.tsx:1045-1053 同公式：持倉未實現損益＋期貨結算損益
import { useEffect } from 'react';
import { reportDailyPnl } from '../../lib/risk';
import { useTradingState } from '../../lib/trading-state';

export function useRiskPnlFeed(): void {
    const trading = useTradingState();
    useEffect(() => {
        const unrealized = trading.positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
        const settle = trading.margin?.future_settle_profitloss ?? 0;
        // known：持倉與保證金都已實際讀到才算數（讀到之前的 0 不是損益）
        reportDailyPnl(unrealized + settle, trading.queries.positions.updatedAt !== null && trading.margin !== undefined);
    }, [trading.positions, trading.margin, trading.queries.positions.updatedAt]);
}
```

> 此 hook 掛在 `MobileApp` 根層。若上游日後把公式抽成共用函式，改為呼叫共用函式。

---

## 8. 🔌 API 對照與資料流

### 8.1 永豐 sidecar（經 nginx `/api/`）

| 用途 | 方法與路徑 | `src/lib` 函式 | 手機使用處 |
|---|---|---|---|
| 健康／憑證 | `GET /api/v1/health` | `fetchHealth()`（`shioaji.ts:107`） | 狀態、帳戶頁 |
| 伺服器資訊（模擬／正式） | `GET /api/v1/info` | `fetchInfo()`（`shioaji.ts:111`） | 狀態列、確認面板 |
| 帳戶清單 | `GET /api/v1/auth/accounts`（＋玉山合併） | `fetchAccounts()`（`shioaji.ts:124`）→ `ensureAccounts()` | 全域 |
| 憑證到期 | `GET /api/v1/auth/ca_expiretime` | `fetchCaExpire()`（`shioaji.ts:130`） | 帳戶頁 |
| 每日流量 | `GET /api/v1/auth/usage` | （`server-monitor` 的 `parseUsage()`） | 帳戶頁 |
| 訂閱委託回報 | `POST /api/v1/auth/subscribe_trade` | `subscribeTradeReports()`（`boot.ts:577`） | 啟動時自動 |
| 合約資訊 | `GET /api/v1/data/contracts/{code}/info` | `fetchContractInfo()`（`shioaji.ts:235`）／`useContract()` | 交易頁 |
| 快照 | `POST /api/v1/data/snapshots` | `fetchSnapshots()`（`shioaji.ts:387`） | 交易頁、ResumeGate |
| K 線（1 分） | `POST /api/v1/data/kbars` | `fetchChartHistory()`（`chart-history.ts:14`） | 圖表 |
| 逐筆 | `POST /api/v1/data/ticks` | `fetchLastTicks()`（`shioaji.ts:429`） | 明細 |
| 排行（P2） | `POST /api/v1/data/scanner` | `fetchScanner()`（`shioaji.ts:442`） | — |
| 訂閱／退訂行情 | `POST /api/v1/stream/subscribe`／`unsubscribe` | `useQuote()` → `retainContractQuotes()` | 各頁 |
| 串流 | `GET /api/v1/stream/data?region=TW`（SSE） | `ensureStream()` | 全域 |
| 下單 | `POST /api/v1/order/place_order` | `placeStockOrder()`／`placeFuturesOrder()` | 下單面板 |
| 改價／改量 | `POST /api/v1/order/update_price`／`update_qty` | `updateOrderPrice()`／`updateOrderQty()` | 委託頁 |
| 刪單 | `POST /api/v1/order/cancel_order` | `cancelOrder()`／`cancelAllOrders()` | 委託頁 |
| 委託查詢 | `POST /api/v1/order/trades` | `useTradingState()`／`refreshTradingState('orders')` | 委託頁 |
| 持倉 | `POST /api/v1/portfolio/position_unit` | `useTradingState()` | 持倉頁 |
| 餘額／交割／保證金 | `POST /api/v1/portfolio/account_balance`／`settlements`／`margin` | `useTradingState()`、`fetchSettlements()` | 帳戶頁 |
| 額度（P1） | `POST /api/v1/portfolio/trading_limits` | `fetchTradingLimits()`（`shioaji.ts:1336`） | 帳戶頁 |
| 損益（P1） | `POST /api/v1/portfolio/profit_loss`／`profitloss_sum` | `fetchProfitLoss()`／`fetchProfitLossSummary()` | 帳戶頁 |
| 自選 | `GET／POST／PUT /api/v1/watchlist…` | `useWatchlist()` | 自選頁 |

SSE 事件：`tick_stk`、`tick_fop`、`bidask_stk`、`bidask_fop`、`quote_idx`、`order_event`、`contract_event`（含 `MAINTENANCE`／`RECONNECT`，觸發重新訂閱）、`heartbeat`（30 秒）。

### 8.2 玉山 bridge（經 nginx `/esun/`，手機不直接呼叫）

手機**一律透過 `src/lib` 間接使用**玉山（帳戶的 `broker_id` 為玉山時，`placeStockOrder()`、`cancelOrder()`、`updateOrderPrice()`、`updateOrderQty()`、帳務查詢會自動轉往 bridge：`src/lib/shioaji.ts:861,1019,1069,1116,1131,1149-1157`）。

| 用途 | 方法與路徑 | 備註 |
|---|---|---|
| 健康 | `GET /esun/health` | 登入、環境、`sessionExpired`、`loginLocked`（`server/esun_trade_server.py:5678`） |
| 帳戶 | `GET /esun/accounts` | 合併進帳戶清單 |
| 委託 | `GET /esun/orders?refresh=` | refresh 有 5 秒最小間隔、10 次／分（AGR0005） |
| 持倉／餘額／交割／損益／額度 | `GET /esun/portfolio/*` | 快取與限流見 §9.1 |
| 市場狀態 | `GET /esun/market_status` | 300 秒快取（P2 可用於盤別顯示） |
| 回報串流 | `GET /esun/stream/orders`（SSE，支援 Last-Event-ID） | 事件 `order`、`deal`、`session`、`resync`、`heartbeat`（25 秒）；前端 80 秒視為 stale（`src/lib/esun/stream.ts:40`） |
| 下單／改價／減量／刪單 | `POST /esun/orders/place`、`/replace-price`、`/replace-qty`、`/cancel` | 回應信封 `outcome`：`accepted`／`not_sent`／`rejected`／`unknown`；缺 `expected_environment` 回 409 `ESUN_ENV_MISMATCH`（`server/esun_trade_server.py:4445-4461`） |
| 重新連線（P1） | `POST /esun/auth/reconnect` | 手機只用非強制 |
| 環境切換 | `POST /esun/auth/environment` | **手機不使用** |

### 8.3 主要資料流

**啟動**

```text
mobile.html → main.tsx
  ├─ 非 secure context → SecureContextGate（結束，不連線）
  └─ bootstrap()
       ├─ GET /api/v1/health（失敗則等待並在恢復後重新整理）
       ├─ startTradingState → GET accounts（永豐＋玉山）→ 讀持倉／委託／帳務
       ├─ subscribeTradeReports → subscribe_trade（永豐）／啟動 /esun/stream/orders（玉山）
       └─ ensureStream → SSE /api/v1/stream/data → heartbeat → LIVE
```

**新單**

```text
點「買進」→ 下單面板（即時驗證）→「預覽」
  → submitMobileOrder：ResumeGate＋LIVE → 風控 → 券商規則 → 固定帳戶與路由
  → requestOrderConfirm（重新讀 /info，顯示模擬／正式）→ 滑動確認
  → 重驗（模式、帳戶、路由、ResumeGate、LIVE）→ beforeDispatch
  → place_order（永豐）或 /esun/orders/place（玉山）
  → 結果分類（§7.2）→ 回報經 SSE 更新委託頁與圖上委託線
```

**回前景**

```text
visibilitychange(visible) 且隱藏 ≥ 5 秒 → ResumeGate = resyncing（停用新單）
  → 等串流 LIVE＋回前景後的活動 → refreshTradingState(orders/positions)＋快照
  → ready（或 stale-data／failed）
```

---

## 9. 📏 限制、配額與效能預算

### 9.1 券商與 bridge 限制

| 項目 | 限制 | 來源 | 手機對策 |
|---|---|---|---|
| 永豐 帳務查詢 | 25 次／5 秒 | `src/lib/trading-state.ts:314-316`（`ACCOUNT_READ_CONCURRENCY = 2`） | 只透過 `useTradingState()`，不自行輪詢 |
| 永豐 行情訂閱 | 50 次／5 秒（重連重播每 5 秒 40 筆） | `src/lib/stream.ts:391-396` | 自選只訂閱可見列 |
| 永豐 每日流量 | 依帳戶等級 | `/api/v1/auth/usage` | 帳戶頁顯示；K 線區間縮短（§9.3） |
| 永豐 委託頻率 | repo 未記載 | — | ⚠️ 以永豐官方文件為準；手機沒有批次下單 |
| 玉山 委託 | 18 次／秒（官方 20）、2,000 次／日 | `server/esun_trade_server.py:18`、`:1988` | 手動操作不會觸及 |
| 玉山 登入 | 10 次／分、300 次／日、密碼錯 3 次鎖帳 | `server/esun_trade_server.py:26`、`:2356` | 重新連線 60 秒冷卻並提醒 |
| 玉山 委託查詢 refresh | 5 秒最小間隔、10 次／分 | `server/esun_trade_server.py:21` | 「更新」6 秒冷卻 |
| 玉山 持倉 | 6 秒快取、10 次／分 | `:22` | — |
| 玉山 交割 | 25 秒快取、3 次／分 | `:20` | 顯示資料時間 |
| 玉山 餘額 | 180 秒快取 | `server/esun_trade_server.py:2859`；`docs/fork/esun.md:213` | 顯示資料時間 |
| 玉山 損益 | 最長 180 天 | `clampEsunDateRange180Days()` | 日期選擇上限 180 天 |
| bridge 請求 | body ≤ 64 KiB、同時連線 ≤ 96 | `server/esun_trade_server.py:5291-5293` | 不影響手機 |

### 9.2 逾時

| 類型 | 逾時 | 來源 |
|---|---|---|
| 永豐 下單、刪單 | 3 秒（逾時＝結果未知，訊息「請求可能已送達…勿直接重送」） | `src/lib/api.ts:186-196,411,428` |
| 永豐 改價、改量 | 無預設逾時 | `src/lib/api.ts:428` |
| 永豐 K 線 | 10 秒（4xx 不重試） | `src/lib/shioaji.ts:398-420` |
| 玉山 委託類 | 15 秒（逾時＝結果未知） | `src/lib/esun/http-driver.ts:51` |
| 玉山 委託查詢 | 30 秒 | `src/lib/esun/http-driver.ts:54` |
| 玉山 重新連線 | 30 秒 | `src/lib/esun/http-driver.ts:56` |

### 9.3 手機圖表區間（`src/mobile/lib/chart-ranges.ts`）

K 線端點只回 1 分 K，資料量與天數成正比（股票每日約 270 根；期貨日盤＋夜盤約 1,140 根）。手機預設縮短區間：

| 週期 | 桌面（`candle-chart.tsx:172-178`） | 手機 股票 | 手機 期貨／選擇權 |
|---|---|---|---|
| 走勢 | — | 當日 | 當日（日盤／夜盤依 `sessionWindowFor()`） |
| 1 分 | 3 天 | 1 天 | 1 天 |
| 5 分 | 10 天 | 5 天 | 3 天 |
| 15 分 | 20 天 | 10 天 | 5 天 |
| 60 分 | 60 天 | 20 天 | 10 天 |
| 日 | 240 天 | 120 天 | 20 天 |

- 圖上最多保留 5,000 根已聚合 K 棒。
- 使用 `fetchChartHistory()` 的快取；切換週期先用快取顯示再背景更新。

### 9.4 效能預算

| 指標 | 目標 | 量測方式 |
|---|---|---|
| 首次載入 JS（gzip） | ≤ 400 KB | 加總 `dist/mobile.html` 引用的 script／modulepreload 的 gzip 大小；超過時於 PR 說明原因。**基準**：原型探針入口（已引用 MVP 會用到的 `src/lib` 模組、React、lightweight-charts，尚無畫面元件）為 17 個 JS、約 285 KiB gzip（868 KiB 未壓縮）；桌面 `index.html` 為 26 個 JS、約 763 KiB gzip |
| 首屏可互動（4G、中階手機） | ≤ 3 秒 | 實機量測 |
| 行情更新重繪 | 行情 store 已以 `QUOTE_FLUSH_MS`（50 ms，`src/lib/stream.ts:118`）合併通知；自選列表再以 100 ms 節流重繪（≤ 10 fps） | DevTools Performance |
| 記憶體 | 圖表 ≤ 5,000 根；明細 ≤ 200 筆 | 實機 30 分鐘不持續成長 |

---

## 10. 🔐 安全模型

1. **信任邊界不變**：能連到 nginx 的人就能操作交易端點（`docs/fork/esun.md:162`）。手機存取讓這個邊界延伸到手機，因此：
   - 只在私有網路或 tailnet 使用；不轉埠、不公開。
   - 方案 A 以 tailnet 裝置管理作為「遺失手機時撤銷存取」的手段；方案 B／C 建議同時啟用 Basic Auth。
2. **瀏覽器不持有密鑰**：玉山 token 由 nginx 注入（`deploy/nginx.conf.template:104-107`）；永豐金鑰只在 sidecar 環境變數。手機 localStorage 只有風控、主題、帳戶選擇等非機密設定。
3. **跨來源防護沿用**：Origin 必須等於 Host、`Sec-Fetch-Site` 只接受同源或 none（`deploy/nginx.conf.template:7-19`）；bridge 另有 Host 白名單與 token 檢查（`server/esun_trade_server.py:5389`）。
4. **防點擊劫持**：`X-Frame-Options: DENY`、`frame-ancestors 'none'`（`deploy/nginx-security-headers.conf`）。
5. **無第三方腳本**：手機頁不載入 GA、不載入 Google Fonts。
6. **風控只在本機**：手機的鎖單只影響手機這個瀏覽器；**沒有伺服器端總開關**（❌）。帳戶頁需明示「此鎖定只對本裝置有效」。伺服器端 kill switch 列入後續提案（需修改 bridge／nginx，不在本期）。
7. **不記錄敏感資料**：正式建置不得 `console.log` 委託內容或帳號。
8. **遮蔽金額**：支援 `usePrivacyMoney()`，公共場所使用時遮蔽金額與帳號。

---

## 11. 📐 非功能需求（行動裝置）

| 類別 | 需求 |
|---|---|
| 版面 | 以 390×844（iPhone 14／15）設計，支援 360–430 寬；高度用 `100dvh`，不用 `100vh` |
| 安全區 | `viewport-fit=cover`；底部分頁與買賣按鈕加 `env(safe-area-inset-bottom)` |
| 觸控目標 | ≥ 44×44 pt；買進／賣出按鈕高度 ≥ 56 px，兩鍵間距 ≥ 12 px |
| 輸入 | 價格 `inputmode="decimal"`、數量 `inputmode="numeric"`；字級 ≥ 16 px（避免 iOS 自動放大） |
| 顏色 | 漲跌與買賣用 `vars.color.up`／`down`（依使用者配色）；狀態（成功、錯誤、正式環境）用 `success`／`danger`（`src/theme.css.ts:95-122`）；**買賣一律有文字**，不只靠顏色 |
| 主題 | 沿用 `initTheme()`：深／淺色、台灣／國際配色、字級 |
| 方向 | 直向為主；橫向時交易頁圖表全螢幕（P1） |
| 語系 | 正體中文 |
| 動態 | 遵守 `prefers-reduced-motion` |
| 瀏覽器 | iOS／iPadOS 15.4+ Safari、Android Chrome 最新兩版 |

---

## 12. 🚫 不提供清單

| 功能 | 原因 |
|---|---|
| 區網 HTTP 使用 | 無 Web Locks，下單閘門永遠鎖住（§3.1） |
| 一鍵閃電下單 | 誤觸風險；所有新單需面板＋確認 |
| 圖上拖曳改價 | 誤觸風險；改價走確認面板 |
| 觸價單、括號單（停損停利）、條件單、收盤前平倉、背景執行、整零價差 | 都是前端常駐引擎（`src/main.tsx:21-29`）；手機分頁會被暫停，保護不會觸發，會造成錯誤的安全感 |
| 期權組合單 | 介面複雜度高，非本期 |
| 盤後定價、借券賣出、鉅額、興櫃 | 桌面未提供或券商規則不支援（§2.3） |
| 玉山環境切換、強制重新登入 | 會影響整台主機的玉山 session，且有鎖帳風險；請用桌面 |
| 永豐模擬／正式切換 | 由部署設定決定 |
| AI Agent | 私有模組；Docker 建置使用空的 modules stub（`vite.config.ts:12-18`） |
| 推播、背景收回報 | 平台限制（§2.1） |

---

## 13. 🚀 分期路線圖

| 階段 | 內容 | 出口條件 |
|---|---|---|
| **Phase 0** 存取層 | TLS 前端（§3）、`mobile.html` 最小殼（SecureContextGate＋連線診斷）、`vite.fork.config.ts`、Dockerfile、fork-ci | §3.4 全部通過 |
| **Phase 1** MVP | 狀態列、帳戶切換、自選（含搜尋）、交易頁（走勢／分 K／日 K、委託線、成本線、漲跌停線、五檔、明細）、下單面板（股票整股＋盤中零股、期權單式；永豐＋玉山）、確認面板、委託頁（改價／減量／刪單／全部刪單／對帳）、持倉（平倉）、帳戶（資金、連線、風控、主題）、ResumeGate、風控損益餵送 | §14 的 MVP 驗收全部通過 |
| **Phase 2**（P1） | 信用交易（融資／融券／現股當沖先賣）、盤後零股、已實現損益、買賣額度、橫向全螢幕圖表、成交音效、玉山一般重新連線 | 對應驗收通過 |
| **Phase 3**（P2） | PWA（manifest、圖示；**不快取 API**）、漲跌幅排行、Wake Lock、更多指標 | 對應驗收通過 |

---

## 14. 🧪 測試計畫與驗收標準

### 14.1 自動化測試（Vitest＋`react-test-renderer`，比照現有元件測試寫法）

以 `vi.mock()` 隔離 `src/lib/shioaji`、`src/lib/trade`、`src/lib/order-confirm` 等模組，**不打任何真實 API**。

| 測試檔 | 必測情境 |
|---|---|
| `resume-gate.test.ts` | 隱藏 < 5 秒不觸發；≥ 5 秒進入 `resyncing`；四個條件全成立才 `ready`；讀取失敗 → `stale-data`；45 秒逾時 → `failed`；`pageshow(persisted)` 視同回前景 |
| `mobile-order.test.ts` | 風控擋下時**不呼叫** `requestOrderConfirm`；玉山規則錯誤（例如零股 1,000 股）不送出；期權＋玉山帳戶在確認前拒絕；確認取消不送出；確認期間帳戶改變、伺服器模式改變、路由改變皆不送出；`beforeDispatch` 在 ResumeGate 非 ready 時丟出；成功路徑以正確參數呼叫 `placeStockOrder`（永豐、玉山帳戶各一）與 `placeFuturesOrder` |
| `order-ticket-sheet.test.tsx` | 零股強制限價＋ROD＋現股；單位切換數量歸 1；價格不符升降單位時停用預覽；超出漲跌停停用預覽；環境未確認停用預覽；開啟後不自動跟價 |
| `order-confirm-sheet.test.tsx` | `awaitingMode`、`simulation === null`、`serverChanged` 時滑動確認停用；顯示環境與路由；ResumeGate 離開 ready 時自動取消 |
| `orders-page.test.tsx` | 減量把「新的剩餘數量」換成減少量；零股與玉山預約單不顯示改價；刪單結果未確認顯示「勿自動重送」；全部刪單需確認；更新鍵冷卻 |
| `positions-page.test.tsx` | 股票平倉呼叫 `placeStockExitByShares`；`stockExitFor` 回傳原因時不送出；期貨平倉 `ocType: 'Cover'`、價格 `null` |
| `chart-model.test.ts` | 只畫目前商品、有剩餘量的限價委託；`modified_price` 優先；近月別名對應；成本線；漲跌停只對股票 |
| `use-risk-pnl-feed.test.tsx` | 與 `App.tsx` 相同公式；未讀到持倉／保證金時 `known = false` |
| `secure-context-gate.test.tsx` | 非 secure context 顯示說明且不呼叫 `bootstrap()` |

### 14.2 建置與 CI

- [ ] `pnpm build`、`pnpm test` 通過（上游 CI）。
- [ ] `pnpm exec vite build --config vite.fork.config.ts` 產生 `dist/mobile.html`；fork-ci 的 web 映像內存在 `/usr/share/nginx/html/mobile.html`。
- [ ] Docker 映像建置成功、`nginx -t` 通過（fork-ci 既有步驟）。
- [ ] 效能預算（§9.4）量測結果寫在 PR 說明。

### 14.3 實機驗收（只在模擬環境）

裝置：iPhone（iOS 17 或 18，Safari）、Android（Chrome 最新版）。

| # | 情境 | 期望 |
|---|---|---|
| A1 | 以區網 HTTP 開啟 | 顯示「需要 HTTPS」說明，無任何 API 請求 |
| A2 | 以 HTTPS 開啟 | 10 秒內 LIVE；狀態列顯示正確券商與環境 |
| B1 | 永豐股票整股限價買 1 張 → 改價 → 減量（若為多張）→ 刪單 | 每步都有確認；委託頁與圖上委託線同步；刪單回讀確認 |
| B2 | 玉山股票整股限價買 1 張 → 刪單 | RouteBadge 顯示「送往 玉山 模擬」；刪單回讀確認 |
| B3 | 玉山盤中零股 10 股 | 只能限價 ROD；改價按鈕不出現 |
| B4 | 永豐期貨 1 口限價 → 刪單；持倉平倉 | 倉別、口數正確；平倉以市價 IOC |
| B5 | 期貨商品選擇玉山帳戶 | 下單面板停用並說明「玉山證券不支援期貨交易」 |
| C1 | 下單面板開啟中切到背景 2 分鐘再回來 | 狀態「同步中」、按鈕停用、價格標示可能過期；恢復後才可預覽 |
| C2 | 確認面板開啟中切到背景 | 回來時確認已取消，沒有送出 |
| C3 | 關閉 Wi‑Fi 改用行動網路 | 串流重連；ResumeGate 正常結束 |
| D1 | 開啟風控鎖 | 所有新單停用；刪單仍可用 |
| D2 | 單筆上限 1 張，下 2 張 | 未送出並顯示原因 |
| E1 | 深／淺色、國際配色、遮蔽金額 | 顏色與遮蔽正確，買賣仍有文字 |
| E2 | iPhone：逐一開啟底部面板，包括平倉說明（永豐、玉山）、全部刪單、批次刪單、下單、確認、指標、帳號切換；再看全螢幕圖表（按鈕進入與橫向自動進入）與長按選價列 | 面板的按鈕與滑塊完整可見、可點，不被分頁列、交易鍵列或通知擋住。舊版曾因 main 的疊層脈絡發生「平倉說明」按鈕被分頁列蓋住，見 mobile-design.md §6.6 |

---

## 15. 🤖 給 AI 代理的工作分解

### 15.1 任務清單

| 任務 | 產出 | 驗收 | 建議代理（依 `CLAUDE.md`） |
|---|---|---|---|
| T0 | Phase 0 部署文件與 `vite.fork.config.ts`、`mobile.html`、Dockerfile、fork-ci | §3.4、§14.2 | code-worker |
| T1 | 殼層：`main.tsx`、`app.tsx`、SecureContextGate、hash 路由、底部分頁、狀態列 | `secure-context-gate.test.tsx` | code-worker |
| T2 | `resume-gate.ts`＋`use-resume-gate.ts` | `resume-gate.test.ts` | deep-reviewer（涉及交易正確性） |
| T3 | `mobile-order.ts`＋確認面板 | `mobile-order.test.ts`、`order-confirm-sheet.test.tsx` | deep-reviewer |
| T4 | 下單面板 | `order-ticket-sheet.test.tsx` | code-worker |
| T5 | 交易頁：圖表、`chart-model.ts`、五檔、明細 | `chart-model.test.ts` | code-worker |
| T6 | 委託頁與操作面板 | `orders-page.test.tsx` | code-worker |
| T7 | 持倉頁（平倉）＋`use-risk-pnl-feed.ts` | `positions-page.test.tsx`、`use-risk-pnl-feed.test.tsx` | code-worker |
| T8 | 自選＋搜尋、帳戶頁 | 手動驗收 | code-worker |
| T9 | 文件更新：`upstream-sync.md` 的 fork 自有檔案清單（`esun.md` 已完成，只需查核連結） | 審查 | fast-reader 查核連結 |
| T10 | 整合審查：閘門順序、錯誤分類、無上游檔案修改 | `git diff --stat` 只含 R2 允許的檔案 | deep-reviewer |

依賴：T0 → T1 → (T2, T4, T5, T8 可平行) → T3（需 T2） → T6、T7 → T10。

### 15.2 每個任務的輸入原則

- 只提供該任務需要的檔案與本文件對應章節，不提供整個 repo。
- 任務完成需回報：變更檔案清單、測試結果摘要、未驗證的假設。

### 15.3 停止並回報（升級條件）

- 需要修改 R2 白名單以外的既有檔案（例如 `src/lib/**`、`src/App.tsx`、`vite.config.ts` 或任何上游檔案）。
- 同一測試連續兩次修正仍失敗。
- 發現本文件與程式碼行為不一致（例如函式簽章不同）。
- 任何可能讓委託在未確認、非 LIVE、帳戶不符時送出的路徑。

---

## 16. ❓ 待驗證事項與風險

| # | 項目 | 影響 | 驗證方式 |
|---|---|---|---|
| Q1 | `tailscale serve` 轉送時是否保留 `Host` | 不保留則 nginx 444／403 | ✅ 已實測（Tailscale 1.104，2026-11-05）：會保留。同時發現永豐 sidecar 只接受本機 Host／Origin，已由 nginx 處理（見 §17） |
| Q2 | iOS「加入主畫面」模式與 Basic Auth | 可能無法登入 | 實機測試（P2 才需要） |
| Q3 | 永豐 sidecar 自選清單在容器重建後是否保留 | 清單遺失 | `docker compose up -d --force-recreate` 前後比對；必要時另提 compose volume 變更 |
| Q4 | 永豐委託頻率上限 | repo 未記載 | 查永豐官方文件並補入 §9.1 |
| Q5 | iOS bfcache 還原時 EventSource 的行為 | ResumeGate 是否足以涵蓋 | 實機 C1–C3 |
| Q6 | 共用 `vendor` chunk 讓手機下載到桌面套件 | 首次載入變大 | 原型探針約 285 KiB gzip，低於 400 KB 預算；加入畫面元件後再量測（§9.4），超標時在 PR 說明 |
| Q7 | 日 K 由 1 分 K 聚合的正確性（交易日歸屬、除權息） | 圖表誤差 | 已在畫面標註；正式日線依 `docs/design/daily-kbar-data-plan.md` 另案 |
| Q8 | 手機與桌面同時操作同一帳戶 | 兩邊對帳時間差 | 兩邊都以回報＋手動對帳為準；不需額外機制 |
| Q9 | 永豐下單／刪單 3 秒逾時在行動網路（或 Tailscale 中繼）下較易觸發 | 「結果未知」變多，需手動對帳 | 實機量測下單往返時間；若常觸發，另案評估調整逾時（需修改 `src/lib/api.ts`，超出本期） |

---

## 17. 📝 v1 實作備註（與本文的差異）

MVP（Phase 0＋Phase 1）實作時發現的規格範例錯誤，以及經獨立審查後刻意比本文更嚴格的地方。以程式碼為準。

| 項目 | 本文寫法 | 實作 | 理由 |
|---|---|---|---|
| §7.1 取消確認 | `new OrderConfirmCancelled('已取消下單')` | `new OrderConfirmCancelled()` | 建構子不接受參數；它自帶 `mutationNotStarted`，UI 先以 `instanceof` 判斷「已取消」 |
| §7.1 credit／note | 範例把當沖先賣併入 credit | 比照桌面 `order-ticket.tsx`：`daytrade_short` 不進 credit，note 加「現股當沖」 | 與桌面確認內容一致 |
| §6.6 股票平倉 | `placeStockExitByShares(contract, exit, …)` | 第 2 個參數是 `exit.exit`（Action），信用條件放在 `opts.orderCond` | 實際簽章 `src/lib/trade.ts:379` |
| §6.4 即時價 | 比照桌面 `usePendingPrices()` | 手機不載入 `trigger-engine`；請求帶 `livePriceCode` 時一律顯示「行情中斷」並停用 | 載入即啟動觸價執行器，違反 R7；只有觸價單會帶 `livePriceCode`，fail-closed |
| §7.4 ② 串流活動 | 回前景後有活動，或連線世代與**隱藏前**不同 | 只算**回前景之後**的重連，或回前景後至少 1 秒才收到的 tick／bidask／heartbeat | 回前景時派送的排隊事件、隱藏期間的舊重連都不能證明串流此刻仍活著；休市時下一次心跳（30 秒）仍在 45 秒逾時內 |
| §7.4 ③ 重新讀取 | `refreshTradingState('orders'／'positions')` | 委託用 `reconcileOrdersOnce()`；兩者讀完都以 `queries[scope].updatedAt` 確認晚於本週期開始，否則冷卻後重讀一次（每週期每範圍最多 2 次），仍不符合 → `stale-data` | `refreshTradingState` 可能回傳其他範圍進行中的讀取，或在冷卻內直接 resolve |
| §7.4 bfcache | `pageshow(persisted)` 視同回前景 | 先進入 `resyncing` 擋下送單，再重新載入頁面 | `src/lib/quote-ownership.ts` 在 `pagehide` 永久拆除訂閱狀態，還原後報價可能凍結（Q5，仍待實機確認） |
| §7.4 stale-data | 新單勾選「我了解」後可送 | 新單、改價、減量、平倉都要勾選；持倉頁、平倉面板與狀態列也提供勾選與重試；回前景前帶入的價格須重新確認 | 降低以過期資料操作的風險；刪單與全部刪單不受限制 |
| §6.2／§6.3 價格來源 | 標頭與下單面板以 `tick.close` 為最新價 | 排除試撮（`simtrade`）tick 並標示「試撮」；沒有真實成交時用市場快照，連快照都沒有才用參考價並標示「參考價」；百分比一律由 `price_chg` 與參考價計算 | 盤前試撮揭示價不是成交價；串流 `pct_chg` 的單位因商品而異 |
| §9.4 效能 | ≤ 400 KB | 首次載入 19 個 JS、347.1 KiB gzip（桌面 `index.html` 27 個、764.0 KiB） | 量測方式同 §9.4 |
| §3.3 nginx 轉送永豐 | `/api/` 保留原始 `Host` | nginx 完成 Host 白名單、Origin＝Host、Sec-Fetch-Site 檢查後，轉給 sidecar 一律用 `Host: 127.0.0.1` 並移除 `Origin` | Shioaji sidecar 1.7.10 只接受本機 Host／Origin（否則 403），且沒有放寬的設定；玉山 `/esun/` 不變 |
