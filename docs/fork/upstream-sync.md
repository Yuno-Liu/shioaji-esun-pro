# 同步上游（Sinotrade/shioaji-pro-app）流程與檢查清單

上游更新非常頻繁（例如 `src/App.tsx` 近 90 天 109 個 commit）。fork 維持可合併的關鍵是：
**fork 邏輯放在 fork 擁有的檔案，上游檔案只留 1～5 行的掛鉤**，並且固定節奏小步同步。

## 一次性設定

```bash
git remote add upstream https://github.com/Sinotrade/shioaji-pro-app.git   # 若尚未設定
git config rerere.enabled true      # 記住衝突解法，下次同樣的衝突自動套用
git config rerere.autoupdate true
```

## 固定節奏

- **每週至少一次**（或上游發新版、`SHIOAJI_VERSION` 變更時）同步；間隔越久衝突越大。
- 每次同步都在獨立分支進行，不直接在 `main` 上合併。

```bash
git fetch upstream
git switch main && git pull --ff-only
git switch -c sync/upstream-$(date +%Y%m%d)
git log --oneline main..upstream/main          # 先看這次要進來什麼
git diff --stat main...upstream/main -- src/App.tsx src/lib/shioaji.ts src/lib/stream.ts src/lib/trade.ts   # 熱點檔案（見下表）
git merge upstream/main                         # 不要 rebase：保留可追溯的合併點與 rerere 記錄
```

## 衝突熱點

下表依審查時（2026-10，修正前）的統計：上游近 90／30 天 commit 數與 fork 在該檔的增刪行數。
上游改得越頻繁、fork 改得越多，越容易衝突。合併時優先檢查這些檔案；新的 fork 修改也應避免再擴大這些檔案的差異。

| 檔案 | 上游 90 天 | 上游 30 天 | fork +／− | 處理原則 |
| --- | ---: | ---: | ---: | --- |
| `src/App.tsx` | 109 | 75 | +7／−3 | 只留掛鉤 |
| `src/components/flash-order.tsx` | 86 | 80 | +5／−2 | 只留掛鉤 |
| `src/components/candle-chart.tsx` | 84 | 65 | +3／−1 | 只留掛鉤 |
| `src/lib/shioaji.ts` | 55 | 27 | +126／−9 | 玉山分派移到 `src/lib/esun/**` |
| `src/components/order-ticket.tsx` | 47 | 38 | +15／−71 | 還原上游程式碼＋小條件停用 |
| `src/lib/trading-state.ts` | 39 | 22 | +38／−2 | 移到 fork 模組 |
| `src/lib/trade.ts` | 37 | 27 | +25／−10 | 還原純縮排變動 |
| `src/lib/boot.ts` | 33 | 24 | +5／−0 | 只留掛鉤 |
| `src/lib/stream.ts` | 30 | 19 | +49／−2 | 回報轉換移到 fork 模組 |
| `src/components/settings-dialog.tsx` | 22 | 8 | +19／−17 | 只留掛鉤 |
| `src/components/conditional-form.tsx` | 22 | 22 | +6／−4 | 只留掛鉤 |
| `src/lib/order-confirm.ts` | 21 | 18 | +3／−1 | 只留掛鉤 |
| `src/components/bottom-dock.tsx` | 18 | 5 | +10／−4 | 只留掛鉤 |
| `src/components/bottom-dock-account.tsx` | 14 | 9 | +13／−8 | 只留掛鉤 |
| `src/components/chart-order-popover.tsx` | 14 | 14 | +2／−0 | 只留掛鉤 |
| `src/components/hud-header.tsx` | 13 | 7 | +304／−11 | 頂欄元件移到 `src/components/header-*.tsx` |
| `src/components/hud-header.css.ts` | 11 | 4 | +274／−0 | 樣式移到 fork 新檔 |
| `vite.config.ts` | 9 | 0 | +198／−1 → 只剩 `/esun` proxy | 不再加入 fork 邏輯 |
| `src/lib/account-store.ts` | 8 | 7 | +106／−18 | 只新增、不改簽章 |
| `package.json` | 7 | 3 | +7／−2 | 只動 `scripts` 的 `esun-bridge`／`docker:*`；`name` 已改為 fork 名稱 |
| `README.md` | 7 | 4 | +237／−13 → 只剩開頭 16 行 | fork 內容放 `docs/fork/` |

fork 自有、不會與上游衝突的檔案：`server/**`、`src/lib/esun/**`、`deploy/**`、`docs/fork/**`、`Dockerfile`、
`docker-compose.yml`、`scripts/deploy-docker.*`、`esun-config*.example`、`.env.docker.example`、`.github/workflows/fork-ci.yml`，
以及手機版（[mobile.md](mobile.md)）的 `mobile.html`、`vite.fork.config.ts`、`src/mobile/**`、`deploy/Caddyfile.mobile.example`。
手機入口由 `vite.fork.config.ts` 合併上游 `vite.config.ts` 加入，不在上游設定檔加 fork 邏輯；`src/mobile/**` 只呼叫 `src/lib` 既有函式。

估算某個上游檔案的 fork 差異行數：

```bash
git diff $(git merge-base HEAD upstream/main) -- <檔案> | grep -c '^[+-][^+-]'
```

## 解衝突原則

1. 上游的修改優先完整保留；再把 fork 的掛鉤（呼叫 `src/lib/esun/**` 等 fork 模組）補回去。
2. 不要為了解衝突而重排、重新縮排或改寫上游程式碼。
3. 若 fork 曾刪除上游程式碼，優先「還原上游程式碼＋以小條件停用」。
4. 上游新增的委託／回報語意（CONTEXT.md）要同步檢查玉山路徑是否也要跟上（見 [context-esun.md](context-esun.md)）。

## fork 修正的上游信用交易缺陷（合併時要保留）

2026-10 玉山正式帳號實測發現，上游把「融券買進（回補）」當成禁止組合，而且有幾處會把融券空單與現股混在一起。
台股的融券回補就是「買進＋融券」（Shioaji 為 `Buy`＋`ShortSelling`，玉山為 `B`＋trade `4`），只有借券、借券豁免限賣出。
這些缺陷在上游共用程式碼裡，永豐也會受影響。本 fork 以最小差異修正下列上游檔案。合併上游時，**不要讓上游版本蓋掉這些修正**：

| 檔案 | 修正 | 原因 |
| --- | --- | --- |
| `src/lib/odd-lot.ts` | `SELL_ONLY_CONDS` 只保留 `SBLShort`、`SBLShortPriceExempt`；`CREDIT_TEXT.shortBuy` 改為說明借券限賣、融券回補請用「融券」買進 | `creditProblem` 會擋下 `Buy`＋`ShortSelling`，而 `placeStockOrder`、`placeQuickOrder` 都經過這個閘門，所以 App 沒有任何路徑能送出融券回補 |
| `src/lib/credit-eligibility.ts` | 同步 `SELL_ONLY_CONDS`；可否融券為 0 時只擋融券賣出，回補照常 | 閃電與 K 線的買邊被停用。信用了結不受暫停限制 |
| `src/lib/chart-order-settings.ts` | 同步 `SELL_ONLY`；摘要與提示寫明「融券買進（回補）」 | K 線點價買被停用 |
| `src/components/order-ticket.tsx` | 移除「切回買進時把融券改成現股」的 effect；買進提供「融券（回補）」；借券類買進保留選取並明確擋下說明；確認視窗帶 `credit`，動作名稱為「融券買進」 | 原本會靜默把融券改成現股，送出的是現股買進而不是回補 |
| `src/components/flash-order.tsx`、`src/lib/flash-trigger.ts` | 股票的持有量只算與面板信用條件相同 cond 的列（`sameCondRows`）；持倉依 cond 分開顯示（`stockPositionGroups`）；現股面板遇到融券空單時顯示「現股買進不會回補融券」；融券面板的買邊為「融券買（回補）」 | 原本融券空單與現股合併成一個淨額：有空單時，現股買進會被判成「減倉」而不附保護；淨額為 0 時，持倉列整個消失 |

同一批修正也改了持倉面板平倉、全平、`placeStockExitByShares` 與成交投影（`src/components/bottom-dock-positions.tsx`、`src/lib/conditional/flatten.ts`、`src/lib/trade.ts`、`src/lib/portfolio-projection.ts`），讓信用部位能用正確的條件平倉並套用成交。合併時同樣要保留。
相關測試：`src/lib/odd-lot.test.ts`、`src/lib/trade-credit.test.ts`、`src/lib/credit-eligibility.test.ts`、`src/lib/chart-order-settings.test.ts`、`src/lib/flash-trigger.test.ts`、`src/components/order-ticket-credit.test.tsx`、`src/components/flash-order-credit.test.tsx`、`src/components/flash-order-short-cover.test.tsx`、`src/components/flash-order-cost.test.tsx`。上游若改寫這些規則，這些測試應該會失敗；不要直接改回上游的預期。

## 同步紀錄

### 2026-11-06（上游 65 個提交，Shioaji 1.7.10 → 1.7.11）

11 個衝突檔，解法已由 rerere 記錄；細節見合併提交 568df3af 的訊息。

- **交易**：
  - `src/lib/trade.ts`：fork 的信用了結檢查與上游的「權證沒有零股」並存。
  - `bottom-dock-positions.tsx`：沿用 fork 的 `refused()`（確定未送出、不對帳），市場判斷改用上游的 `contractMarket()`，權證歸股票。
  - `flash-order.tsx`：採上游 #376 的「平倉鈕常駐」版面，數量與可否平倉仍看 fork 的 `exitNet`。買賣鈕提示遇到信用部位時，優先顯示 fork 的警告。
- **搜尋**：上游重寫了搜尋。
  - `product-search.ts`、`command-palette.tsx`、`App.tsx` 改採上游版本。
  - `stock-index.ts` 的 `searchStocks` 以上游排序為主。fork 的模糊比對（去除前導 0 的代碼、代碼片段、多關鍵字、名稱子序列）只在上游比不到時補上，排在上游命中之後。「50 → 0050」這類去零後完全相符的代碼視同代碼相符。
  - 頂欄與手機快速切換的模糊搜尋因此保留，「台電」「元大50」仍找得到。
  - 「小台」這類期貨根簡稱的比對隨上游改寫移除，請用「台指」或 `MXF`。桌面頂欄的範例文字已改用「台指」。
  - 審查修正：真正的代碼完全相符永遠排在去零相符之前（`6208` 日揚在 `006208` 富邦台50 之前，去零相符為 rank 0.5）。
  - 上游每次搜尋讀股票目錄有 1.2 秒期限。手機搜尋面板與交易頁快速切換開啟時，先以不帶 signal 的 `loadStockCatalog()` 預熱，比照頂欄 focus 時的做法。
  - 商品目錄或名稱目錄改版時，上游會讓進行中的查詢失敗並要求重查。手機 hook 與頂欄改為版本一變就自動重查；頂欄搜尋失敗時提示「按 Enter 重試」，不再顯示「找不到」。
  - 手機版搜尋已在 QA mock 上端對端實測：自選搜尋面板與交易頁快速切換都正常。
- **上游新的建置與執行期依賴**：
  - `vite.config.ts` 匯入 `scripts/dev-etf-proxy.ts`，web 映像的 builder 階段原本沒有複製，`tsc -b` 失敗。已補上，並新增 `deploy/test_dockerfile.py`，檢查 tsconfig 與 vite 設定用到的檔案都有被複製。
  - 上游新增同源路徑 `/metadata/etf/*`、`/metadata/equity/*`，用來向證交所、櫃買中心取得官方名稱；開發時由上面的代理提供。nginx 部署沒有代理這些路徑，請求會落到 `location /` 拿到 `index.html`，執行期解析失敗後，名稱退回券商的權證標的名稱，和同步前相同。
  - 要讓網頁版也拿到官方名稱，需要在 nginx 加固定路徑的對外代理。這是新的對外連線，目前未做。
- **手機版跟上的調整**：
  - 權證持倉可以平倉（`closePlanFor` 改用 `contractMarket()`；權證有零股時先說明原因）。
    lib 的 `resolveContract` 對權證不給漲跌停價（0），所以只有零股腳才要求漲跌停價；整張是市價 IOC，和 lib 相同。
    玉山帳戶在說明面板就以 `esunStockLegProblem` 逐腳檢查。
  - 交易頁持倉摘要、統計格與量單位把權證當股票整股（張）。
  - 逐筆明細與下單面板的權證單位改為「張」。
  - 產業頁測試補上 `GroupFlow.volumeRatio`。
- **玉山**：`validateEsunStockOrder` 只接受 STK，玉山帳戶的權證委託仍在送出前拒絕（確定未送出），訊息改為明說「尚未支援權證委託」。
  玉山 API 是否支援權證，需要在模擬環境實測後再決定。
  桌面持倉面板平倉玉山的權證時，仍是確認之後才被 lib 擋下（也是確定未送出）。若要提前擋，需在上游熱點檔 `trade.ts` 加掛鉤，目前不加。
- **搜尋的延遲載入體積**：上游搜尋本體含 390 筆 ETF 目錄，成為獨立的 `product-search` chunk，約 18.7 KiB gzip。
  閒置預載或第一次開啟搜尋時才下載，手機首屏不受影響。
- **熱點更新**：搜尋相關的 `product-search.ts`、`command-palette.tsx` 與上游已無差異；fork 差異集中在 `stock-index.ts` 的 `searchStocks`（模糊比對後補）。

## 同步後必跑

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b
pnpm exec vitest run
python -m unittest server.test_esun_trade_server -v
python -m unittest discover -s deploy -p 'test_*.py' -v
docker compose config -q
docker build --target esun-bridge -t shioaji-pro-esun-bridge:sync .
docker build --target shioaji     -t shioaji-pro-sinopac:sync .
docker build --target runner      -t shioaji-pro-web:sync .
```

另外檢查：

- [ ] `SHIOAJI_VERSION` 有變更時，`shioaji` 映像會自動改裝對應的 `shioaji-cli`；確認 PyPI 上有該版本，並在 UI 確認 `/api/v1/info` 的版本。
- [ ] 上游 CI 的 pnpm 主版本（`pnpm/action-setup` 的 `version`）若改變，同步更新 `Dockerfile` 的 `PNPM_VERSION`。
- [ ] `vite.config.ts` 與 `README.md` 仍只有最小的 fork 差異（見上表）。
- [ ] 上游若新增 `/api` 路徑、SSE 或 `index.html` 之外的 HTML 入口，確認 `deploy/nginx.conf.template` 的代理與快取規則仍適用。
  其他同源路徑（例如 2026-11 的 `/metadata/*`）在 nginx 會落到 `location /`、回 `index.html`，要確認執行期有後備。
- [ ] 上游若在 `vite.config.ts` 或 tsconfig 加入新的建置期檔案（例如 `scripts/*.ts`），`Dockerfile` 的 builder 階段要一併 COPY。
  `deploy/test_dockerfile.py` 會檢查；web 映像一定要實際建置一次。
- [ ] 手機版（`src/mobile/**`）只呼叫 `src/lib` 既有函式；上游改了 lib 的型別或語意時，手機版的型別檢查、測試與 QA 都要重跑，
  並量測手機首屏（設計規格 §13 的目標）。
- [ ] fork CI（`.github/workflows/fork-ci.yml`）與上游 CI 都通過後，才合併回 `main`。
- [ ] 合併後重新部署：`pnpm run docker:deploy`（或 `./scripts/deploy-docker.sh up`），確認 `docker compose ps` 三個服務都 healthy。
