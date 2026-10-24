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
`docker-compose.yml`、`scripts/deploy-docker.*`、`esun-config*.example`、`.env.docker.example`、`.github/workflows/fork-ci.yml`。

估算某個上游檔案的 fork 差異行數：

```bash
git diff $(git merge-base HEAD upstream/main) -- <檔案> | grep -c '^[+-][^+-]'
```

## 解衝突原則

1. 上游的修改優先完整保留；再把 fork 的掛鉤（呼叫 `src/lib/esun/**` 等 fork 模組）補回去。
2. 不要為了解衝突而重排、重新縮排或改寫上游程式碼。
3. 若 fork 曾刪除上游程式碼，優先「還原上游程式碼＋以小條件停用」。
4. 上游新增的委託／回報語意（CONTEXT.md）要同步檢查玉山路徑是否也要跟上（見 [context-esun.md](context-esun.md)）。

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
- [ ] fork CI（`.github/workflows/fork-ci.yml`）與上游 CI 都通過後，才合併回 `main`。
- [ ] 合併後重新部署：`pnpm run docker:deploy`（或 `./scripts/deploy-docker.sh up`），確認 `docker compose ps` 三個服務都 healthy。
