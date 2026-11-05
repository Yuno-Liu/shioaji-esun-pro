# Shioaji Pro 手機交易網頁：介面現代化最終設計規格（整合版 v1）

- 存放位置：`docs/fork/mobile-design.md`
- 適用範圍：`src/mobile/**`、`docs/fork/**`
- 不可修改：`src/theme.css.ts`、`src/lib/**`、`src/components/**`、`mobile.html`（只能讀取與重用）
- 基準：2026-11-06 工作樹。本文行號已重新定位；施工前仍須以 Grep 再確認（工作樹持續變動）。
- 使用者需求：「介面 UIUX 及操作我希望可以設計更現代化」；既有決定：下單面板依買賣整面著色、五檔買賣同列、字級預設小、紅綠大按鈕、禁止頁面手勢縮放與選取文字（圖表可雙指縮放）。

---

## 0. 決策摘要

### 0.1 骨架與移植來源

| 來源 | 採用內容 |
|---|---|
| P1 iOS 原生流暢感（骨架，22.6 分） | 解析解彈簧＋共用 rAF；1:1 拖曳、速度承接、投射、橡皮筋；Sheet v2（退場凍結、堆疊後退、焦點陷阱、頂端留出狀態列）；SlideToConfirm v2（只看放手位置、armDelay）；材質配方與後備；`createVar`＋`themeClasses` 深淺映射；安全不變式；漲跌小字只放中性島 |
| P2 專業看盤密度（21.8 分） | 不透明狀態列＋非 LIVE 整條淡染；實心填色疊黑（本版改為依字級兩級，§4.8）；價量一律系統字 tabular、禁用 800；快捷價 6 欄雙行、數量 4 欄；內嵌五檔補內外盤比；量條／比例條 `scaleX`；跳價閃爍覆蓋層＋350ms 節流；退場 testId `${testId}-closing`；面板 portal 到殼層外再設 inert；iOS `:active` 需 touchstart 監聽；平倉中性鍵；限價偏離提醒；「1 張＝1,000 股」 |
| P3 現代金融極簡（19.5 分） | 方向鍵兩顆 ≥56px、間距 12px（§11）；正式環境狀態列底緣 2px danger；確認類滑塊 settled／300ms 進場保護與完整中止條件；按 CTA 前先 blur；持續狀態就地呈現、事件才用通知；選價列與全螢幕買賣鍵升到 56px；gesture-guard 只在 WebKit 掛 touchmove（實機驗證後）；先給使用者看下單面板原型 |

### 0.2 明確排除（評審要求避免）

1. 以遲滯「預備狀態」決定送出（P3：≥0.80 進、<0.77 出、預備中放手即送）；任何讓速度、投射或遲滯參與送出判定的寫法；手指按住時把手吸附到終點；首次使用自動推動送出把手（P2）。
2. 下單買賣改成 48px 或兩段相鄰無間距的分段控制（P1/P2，違反 `docs/fork/mobile-trading-spec.md:1062`）。
3. 移除 `src/mobile/styles/layout.css.ts:52-60` 的全域減少動態保底規則（P3）。
4. 通知維持在狀態列下方疊在內容上（P2/P3）；通知長時間蓋住狀態列鎖單鈕（P1）；「結果未知」被後到的通知壓在後面，或不自動消失卻停在遮擋內容的位置。
5. 承載連線、環境、鎖單的狀態列做成半透明（P1/P3）。
6. 自選列預設逐列 `fetchKbars` 迷你走勢（P2，`src/components/sparkline.tsx:8-47`，抵觸規格 §9.1／§9.3）；在共用 `main` 上 `scroll-snap`；交易頁標頭左右滑切換商品。
7. 面板投射係數 0.998（P3）；面板拖曳接手時不排除 `[role=slider]`、輸入元件。
8. 把 SlideToConfirm 指標處理改成只綁 ref 的原生監聽（`slide-to-confirm.test.tsx:22-29` 直接呼叫 `props.onPointerDown/Move/Up`）。
9. 確認面板仍 `if (!current) return null`（`order-confirm-sheet.tsx:148`）卻期待退場動畫；移除 approve／cancel 的 entry id 檢查（同檔 154-173）；讓已核准面板等 lib 處理完才離開（`src/lib/order-confirm.ts:85-97` resolve 時立即清空 pending）。
10. 退場凍結期間仍以 `mounted.current` 決定回饋寫入（`use-mobile-ticket.ts:674-678`）。
11. 字重 800；主價 2.25rem；每頁 28px 大標題（與「字級預設小、高密度」衝突）。
12. 帳戶頁改「列表＋第二層面板」並改變刷新時機（P3）；委託操作面板改分段（P2）。
13. 讓 `main` 或其祖先產生 transform／filter／backdrop-filter／will-change／contain:paint（會破壞 `chart.css.ts:22-38` 的 fixed 全螢幕圖表與面板定位），或建立疊層脈絡、設定 `-webkit-overflow-scrolling`（iOS 會把 main 內 fixed 子孫壓在底部 chrome 之下，見 §6.6）；在圖表 canvas 上方、或捲動容器內的 sticky 列用 backdrop-filter；同畫面超過 3 個模糊層；動畫 blur 半徑、height、box-shadow、background。
14. 引用 `vars.color.wickUp／wickDown`（`theme.css.ts:113-114` 用 color-mix，iOS 15.4 整條宣告無效）；使用 theme 的 `flash-up／flash-down` 關鍵影格（`theme.css.ts:154-162` 動畫 background）。
15. 未經使用者看樣張就改動已確認的設計：整面雙層方向著色、紅綠方向大鍵的大小與形式。

### 0.3 本版相對 P1 的刪減（依 CLAUDE.md 最小可驗證原則）

不做：長按 ContextMenu（含列預覽放大）、每頁大標題收合、FLIP 版面動畫、面板內容區「捲到頂再下拉」接手、交易頁 ☆／⋯ 選單、列水平滑動、下拉更新。全部列入第二輪候選（§17），本輪以既有操作面板與明確按鈕完成相同功能。

---

## 1. 硬性限制（摘要）

- 安全：所有新單、改價、減量、刪單、全部刪單、批次刪單、平倉、解除鎖單都必須經滑動確認；不新增一鍵下單、圖上拖曳改價、價格拖曳調整、觸價／括號／條件單、批次市價平倉、背景執行（規格 §0 R4–R7、§12）；買賣一律有文字；漲跌與買賣顏色只用 `vars.color.up／down`。
- 相容：iOS／iPadOS 15.4+ Safari、Android Chrome 最新兩版。禁用 `color-mix()`、`:has()`、CSS `linear()`、容器查詢；`@layer` 可用但不依賴。半透明一律「透明元素＋`::before` 底色以 opacity 疊」。
- 效能：首次載入 JS（gzip）預算 400 KB，現況約 208 KiB；本案首屏增量 ≤10 KiB；不引入 framer-motion／motion（`package.json` 內的 motion 13.4.6 只供桌面，手機不得 import）；只動畫 transform／opacity。
- 無障礙：觸控目標 ≥44px（隨字級放大）、輸入字級 ≥16px、rem 隨字級、減少動態、降低透明度、提高對比、深淺色與兩種配色。

---

## 2. 現況問題（證據已複核）

| # | 等級 | 問題 | 證據 | 處理 |
|---|---|---|---|---|
| 1 | 高・已確認 | 通知固定在狀態列下方 52px 疊在內容上，z=300 高於面板；錯誤與結果未知最長 9 秒；面板最高可到距頂 24px，通知也會壓到面板頂部 | `styles/toast.css.ts:8-18`、`styles/metrics.ts:20-25`、`components/toast-host.tsx:28`、`styles/sheet.css.ts:27`；截圖 m-watchlist、m-orders、m-positions、m-account、p-trade 的頁首都被「等待 shioaji server…」蓋住 | §6.4 雙錨點通知；§6.1 所有面板頂端留出狀態列 |
| 2 | 中・已確認 | 通知外層是 `<button>` 卻設 `role=alert/status`，覆寫按鈕語意 | `components/toast-host.tsx:74-80` | §6.4 |
| 3 | 高・已確認 | 下單面板預覽鍵不在第一屏；重複資訊佔約 300px | t-ticket-buy.png；`order-ticket-sheet.tsx:385-393`（CTA 在快捷價、數量、資訊之後）；標題 `:80` 與 `ticket/ticket-quote-row.tsx:34` 重複商品名；方向大字 `:155-157`＋方向鍵 `:158-177`；帳戶說明常駐 `:192` | §7.4 固定 footer＋瘦身 |
| 4 | 中・已確認 | 快捷價 `repeat(auto-fill, minmax(3.75rem,1fr))` 在 390 寬折成 5＋1 | `styles/order-ticket.css.ts:328-332`；截圖「平盤」單獨一列 | §6.10 |
| 5 | 高・已確認 | 面板：關閉直接卸載無退場、每次 move 都 setState、放開瞬間歸位且只看 80px、焦點只在開啟時移入、進場 200ms 關鍵影格不可中斷 | `components/bottom-sheet.tsx:41-48、52、65-70、71-78`；`styles/sheet.css.ts:39` | §6.1 |
| 6 | 中・已確認 | 滑塊以 left／width 動畫且逐 move setState；越過門檻無回饋 | `slide-to-confirm.tsx:97-101、143-166`；`controls.css.ts:116` | §6.3 |
| 7 | 中・已確認 | 其他 width／left 轉場 | `trade.css.ts:411`、`orders.css.ts:371`、`account.css.ts:189`（Switch left）、`account.css.ts:399` | §6.12、§7.8 |
| 8 | 高・已確認（實算） | 深色主題實心填色白字對比不足：綠 #16b389 2.68、accent #3d8bff 3.31、紅 #f23645 3.90；分頁徽章 11px 白字在紅底 3.90 | `theme.css.ts:46、49、52`；`controls.css.ts:22-47`；`order-ticket.css.ts:64-69、444-448`；`trade.css.ts:231-264`（選價列）；`chart.css.ts:193-219`（全螢幕買賣）；`layout.css.ts:115-129` | §4.8 ink 兩級 |
| 9 | 中・已確認（實算） | 方向著色面板（兩層 13%）上：紅字 3.94、mutedForeground 4.24（淺色 3.97） | `sheet.css.ts:50-60`；`order-ticket.css.ts` 的 livePrice、muted、fieldLabel、ladderWrap | §4.8 規則 6–8 |
| 10 | 中・已確認（實算） | 淺色主題漲跌色字直接放在 #eef0f3：紅 4.45、綠 3.80；淺色綠對白也只有 4.34（theme 層級，本案不可改） | `theme.css.ts:61、73、76` | §4.8 規則 9；theme 另案 |
| 11 | 低・已確認 | 六種分段樣式 | `watchlist.css.ts:277-304`、`orders.css.ts:56-67`、`positions.css.ts:288-315`、`order-ticket.css.ts:150-178`、`account.css.ts:195-218`、`trade.css.ts:130-153` | §6.7 |
| 12 | 中・已確認 | 停用原因只寫在 title（觸控看不到） | `ticket/ticket-conditions.tsx:89、116、137`；`order-ticket-sheet.tsx:228` | §6.7 |
| 13 | 低・已確認 | 價量用 `vars.font.mono`（手機未載 JetBrains Mono，Android 無 ui-monospace，p-trade.png 出現斜線零）；800 字重 6 處；圖表字型 | `trade.css.ts:50、62、125、340、351、376、377、393、481`；`chart.css.ts` 4 處；`order-confirm.css.ts:21、37、48、63`；`order-ticket.css.ts:32、56、435`；`trade-chart.tsx:258` | §4.7 |
| 14 | 低・已確認 | emoji 與字元圖示 | `status-bar.tsx:178-180`（鎖頭 emoji）、`bottom-sheet.tsx:117-119`（✕） | §6.5、§6.10 |
| 15 | 低・已確認 | 內嵌五檔不顯示內外盤比 | `depth-ladder.tsx:139` | §7.3 |
| 16 | 中・已確認 | 選價列與全螢幕買賣鍵只有 44px | `trade.css.ts:231-264`、`chart.css.ts:193-219` | §7.3 |
| 17 | 待驗證 | 單一 main 捲動容器、`src/mobile` 內無 scrollTop 處理，切頁殘留上一頁位置 | `app.tsx:175-186` | §6.6 捲動記憶 |
| 18 | 待驗證（重要） | VoiceOver 對自訂 `role=slider` 的上下滑是否送出方向鍵、雙擊能否確認 | `slide-to-confirm.tsx:154-173` | §6.3 AT 關卡 |
| 19 | 待驗證 | gesture-guard 在 document 掛非被動 touchmove（capture），Android 捲動可能等主執行緒；Android 已遵守 `user-scalable=no`（`mobile.html:28-31`） | `lib/gesture-guard.ts:22、61` | §15 B4 |
| 20 | 待驗證 | shot-insecure.png 右側裁切，可能只是 1x 非行動截圖 | `gate.css.ts` | §7.8 |

---

## 3. 設計原則（最終）

1. **安全優先於流暢**：動態只讓狀態更清楚，不縮短、不繞過確認。新增的入口（長按操作面板的「買進…／賣出…」、列上「改價／減量／刪單」鍵、五檔點價、圖表選價）只會「開啟」下單面板或委託操作面板。送出只有 SlideToConfirm 一條路，判定只看放手時手指的實際位置 ≥ 80%。
2. **按下即回饋、1:1、可中斷、承接速度**：按下同一幀出現按壓狀態；拖曳保留抓取偏移 1:1 跟手；放手以手指速度作彈簧初速；動畫中可再抓住，新動畫一律從畫面上目前的值出發。
3. **空間一致**：面板從下進、往下出；確認面板疊上時下單面板後退（縮 6%、變暗），取消後沿原路回來；通知從錨點邊緣進出。
4. **材質表達層級，但安全資訊永遠不透明**：只有「分頁列＋交易鍵列」這一片底部 chrome 與通知使用半透明；狀態列、所有面板、資料區不透明。材質不疊材質。
5. **高密度、靠層級不靠框線**：保留台新式密度（精簡報價、統計格、五檔同列、額度與價金、內外盤比），以字重、字級、等寬數字、對齊、底色深淺分組；常用路徑（方向→價格→數量→預覽）一屏完成，主要按鈕永遠看得到。
6. **顏色只承載意義且對比可證**：up／down 只表示漲跌、買賣、多空、損益正負，並附文字、▲▼ 或正負號；success／danger／amber 表示狀態且不隨配色翻轉；accent 只用於互動、選取與焦點。所有用色組合都附實算對比（§4.8）。
7. **一種控制一種外觀**：全站只有一種 Segmented、一種 Chip、一種 Sheet、一種通知。
8. **持續狀態就地呈現、事件才用通知**：連線、同步、資料過期、待對帳、價格過期放在狀態列、分頁徽章或相關操作旁；通知只報告事件（成交、委託結果、lib 通知）。
9. **尊重使用者設定**：rem 隨字級（小 1／標準 1.15／大 1.3）；減少動態改交叉淡化；降低透明度有 App 內開關（iOS Safari 沒有對應媒體查詢）；提高對比改實心加框。
10. **相容與預算先於特效**：每個效果都有 iOS 15.4 寫法與後備；首屏 JS 增量 ≤10 KiB。

---

## 4. Design tokens

### 4.1 檔案

| 檔案 | 內容 |
|---|---|
| `src/mobile/styles/tokens.ts`（新，純常數） | SPACE、SIZE、RADIUS、ELEVATION、Z、SPRING、GESTURE、DUR、EASE |
| `src/mobile/styles/metrics.ts`（改） | 改為轉出 tokens，保留原匯出名：`TOUCH_MIN`（改為 `'max(44px, 2.75rem)'`）、`TRADE_BUTTON_MIN_HEIGHT`（維持 `'56px'`，滑塊幾何依賴）、`TRADE_BUTTON_GAP`（`'12px'`）、`INPUT_FONT_SIZE`、`SAFE_*`、`Z`（擴充鍵，原鍵值不變）、`REDUCED_MOTION` |
| `src/mobile/styles/theme-vars.css.ts`（新） | `createVar` 宣告的手機語意變數與深淺映射（§4.2） |
| `src/mobile/styles/material.css.ts`（新） | bar、thick 兩級材質與後備（§4.6） |
| `src/mobile/styles/typography.css.ts`（新） | 字級樣式與 num 數字樣式（§4.7） |
| `src/mobile/styles/primitives.css.ts`（新） | pressable、pressableRow、srOnly、hairline、focusRing、fill（含 ink）、island（§6.14） |

### 4.2 主題映射變數

寫法（只讀取 `themeClasses`，不修改 theme）：

```ts
// styles/theme-vars.css.ts
export const sj = {
  contentBg: createVar(), groupedBg: createVar(), islandBg: createVar(), elevatedBg: createVar(),
  segTrack: createVar(), segThumb: createVar(), inkStrong: createVar(), inkLarge: createVar(),
  scrim: createVar(), scrimStack: createVar(), barAlpha: createVar(), thickAlpha: createVar(),
  edgeLight: createVar(),
};
const dark = { [sj.contentBg]: vars.color.background, /* …下表… */ };
const light = { /* …下表… */ };
globalStyle(':root', { vars: dark });   // 尚未套主題 class 時的預設
globalStyle(`html.${themeClasses['dark-tw']}, html.${themeClasses['dark-intl']}`, { vars: dark });
globalStyle(`html.${themeClasses['light-tw']}, html.${themeClasses['light-intl']}`, { vars: light });
```

主題 class 掛在 `<html>`，自訂配色以 base class（dark／light）加 inline 覆寫 `vars.color.*`（`src/lib/theme-store.ts:87-108`），因此映射自動跟隨自訂配色。

| 變數 | 用途 | 深色 | 淺色 |
|---|---|---|---|
| `contentBg` | 清單型頁面表面（自選、交易、委託） | `vars.color.background` | `vars.color.panel` |
| `groupedBg` | GroupedSection 卡片 | `vars.color.muted` | `vars.color.panel` |
| `islandBg` | 面板內中性島（報價、資訊、五檔、輸入框、未選方向鍵、滑塊軌道） | `vars.color.inset` | `vars.color.panel` |
| `elevatedBg` | 晶片、步進鍵 | `vars.color.panelRaised` | `vars.color.panel` |
| `segTrack` | 分段軌道 | `vars.color.muted` | `vars.color.muted` |
| `segThumb` | 分段選中拇指 | `vars.color.borderBright` | `vars.color.panel` |
| `inkStrong` | 實心填色疊黑（小字） | `0.28` | `0.08` |
| `inkLarge` | 實心填色疊黑（≥1.1875rem 粗體或純圖示） | `0.12` | `0` |
| `scrim` | 第一層暗化幕 alpha | `0.56` | `0.36` |
| `scrimStack` | 疊在另一面板上的暗化幕 alpha | `0.24` | `0.24` |
| `barAlpha` | bar 材質底色不透明度 | `0.72` | `0.80` |
| `thickAlpha` | thick 材質底色不透明度 | `0.86` | `0.90` |
| `edgeLight` | 面板與按鍵上緣受光線 | `rgba(255,255,255,0.08)` | `transparent` |

頁面底色：清單型頁面 `contentBg`；分組型頁面（持倉、帳戶）用 `vars.color.background` 加 `groupedBg` 卡片。

### 4.3 間距與尺寸（4pt 格線，rem 隨字級）

- SPACE：`s1 .25rem`、`s1_5 .375rem`、`s2 .5rem`、`s3 .75rem`、`s4 1rem`、`s5 1.25rem`、`s6 1.5rem`、`s8 2rem`。
- 版面：頁面左右邊距 s4 ＋ `env(safe-area-inset-left/right)`；區塊間 s6；表單欄位間 s3（下單面板 body 區塊間 12px）；列內距上下 .6875rem、左右 s4；晶片間 s1_5。
- SIZE：
  - `TOUCH_MIN = max(44px, 2.75rem)`（字級大時同步放大）。
  - `CONTROL_COMPACT = 2.25rem`（外觀 36px；點擊區以 `::before { inset: -4px 0 }` 擴到 TOUCH_MIN，相鄰元素須留 ≥8px 垂直間距）。
  - `CONTROL_REGULAR = TOUCH_MIN`。
  - `CONTROL_LARGE = max(56px, 3.5rem)`（方向鍵、交易鍵列、CTA、選價列、全螢幕買賣鍵）。
  - 滑塊軌道固定 `56px`、把手 48px、內距 3px（`SLIDE_HANDLE_SPAN_PX = 54` 不變）。
  - `TRADE_BUTTON_GAP = 12px`（px，不隨字級）。
  - 狀態列 `STRIP_H = TOUCH_MIN`；分頁列 `TABBAR_H = 49px`；交易精簡標頭 `COMPACT_BAR_H = 40px`；交易鍵列 = 56 ＋ 上下 8 = 72px。
- 殼層 CSS 自訂屬性（設在 `.shell`）：
  - `--sj-strip-h: calc(max(44px, 2.75rem) + env(safe-area-inset-top, 0px))`
  - `--sj-tabbar-h: calc(49px + env(safe-area-inset-bottom, 0px))`
  - `--sj-accessory-h: 0px`（由 ResizeObserver 寫入底部配件槽實際高度）
  - `--sj-sheet-top: calc(var(--sj-strip-h) + 8px)`
  - `--sj-kb: 0px`（鍵盤高度，寫在面板 backdrop，見 §6.1）

### 4.4 圓角（px，不隨字級；同心規則：內層＝外層－內距）

`xs 4`（小徽章）、`sm 6`（漲跌膠囊、方向小膠囊）、`md 8`（輸入框、步進鍵、晶片、中性島）、`lg 12`（GroupedSection、方向鍵、CTA、交易鍵）、`xl 16`（面板上緣、通知卡）、`pill 999`（狀態列膠囊、路由徽章、滑塊軌道與把手、精簡通知）。分段軌道 9px、內距 2px → 拇指 7px。

### 4.5 陰影、髮絲線、暗化幕、Z

- `e1`（拇指、步進鍵、晶片）：`0 1px 2px rgba(0,0,0,.20), 0 0 0 .5px rgba(0,0,0,.10)`，深色再加 `inset 0 .5px 0 ${sj.edgeLight}`。
- `e2`（通知、選價列）：`0 6px 20px rgba(0,0,0,.28)`。
- `e3`（面板）：`0 -8px 30px rgba(0,0,0,.40), inset 0 .5px 0 ${sj.edgeLight}`。
- 不對 box-shadow 做動畫。
- 髮絲線：`0.5px solid vars.color.border`；`@media (-webkit-max-device-pixel-ratio: 1.5), (max-resolution: 1.5dppx)` 改 1px；`prefers-contrast: more` 改 `1px vars.color.borderBright`。
- 暗化幕：`rgba(0,0,0, var(sj.scrim))`；疊在另一面板之上時 `rgba(0,0,0, var(sj.scrimStack))`（下層面板因此再暗一階）。
- Z：`bars 10 < compactBar 11 < accessory 12 < fullscreenChart 50 < sheet 100（堆疊每層 +10）< confirm 200 < toast 300`。

### 4.6 材質（theme 色為不透明 hex；不用 color-mix）

配方（vanilla-extract 需同時寫 `WebkitBackdropFilter` 與 `backdropFilter`）：

```ts
export const bar = style({
  position: 'relative', isolation: 'isolate', background: 'transparent',
  WebkitBackdropFilter: 'blur(20px) saturate(180%)', backdropFilter: 'blur(20px) saturate(180%)',
  selectors: {
    '&::before': { content: '""', position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none',
                   background: vars.color.panel, opacity: sj.barAlpha },
    '[data-sheet-open="true"] &': { WebkitBackdropFilter: 'none', backdropFilter: 'none' },
    '[data-sheet-open="true"] &::before': { opacity: 1 },
    'html[data-sj-transparency="reduced"] &': { WebkitBackdropFilter: 'none', backdropFilter: 'none' },
    'html[data-sj-transparency="reduced"] &::before': { opacity: 1 },
  },
  '@supports': { 'not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))':
                 { selectors: { '&::before': { opacity: 1 } } } },
  '@media': {
    '(prefers-reduced-transparency: reduce)': { selectors: {
      'html:not([data-sj-transparency="full"]) &': { WebkitBackdropFilter: 'none', backdropFilter: 'none' },
      'html:not([data-sj-transparency="full"]) &::before': { opacity: 1 } } },
    '(prefers-contrast: more)': { WebkitBackdropFilter: 'none', backdropFilter: 'none',
      boxShadow: `inset 0 1px 0 ${vars.color.borderBright}`, selectors: { '&::before': { opacity: 1 } } },
  },
});
```

| 等級 | 用途 | 模糊 | 底色／不透明度 |
|---|---|---|---|
| `bar` | 底部 chrome（交易鍵列＋分頁列共用一片） | `blur(20px) saturate(180%)` | `vars.color.panel`／`sj.barAlpha` |
| `thick` | 通知 | `blur(30px) saturate(180%)` | `vars.color.panelRaised`／`sj.thickAlpha` |

規則：
- 狀態列、交易精簡標頭、選價列、全螢幕圖表上下列、所有面板：**不透明**（`vars.color.panel`）。
- 同畫面最多 3 個模糊層（實際最多：底部 chrome 1 ＋ 通知 1）。
- 任何面板開啟（殼層 `data-sheet-open="true"`）時底部 chrome 改實心、停用模糊。
- 不動畫 blur 半徑；清單列不用 backdrop-filter。
- 材質上的文字一律 `vars.color.foreground`，字重比一般情況加一級；不放 mutedForeground 小字。
- 低階 Android 首次啟動預設「降低透明度」（§5.3）。

### 4.7 字級與數字（rem；root 16px＝字級「小」）

字族沿用 `layout.css.ts:24` 的 body：`system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif`。數字一律同字族加 `font-variant-numeric: tabular-nums lining-nums` 與 `font-feature-settings: "tnum" 1, "lnum" 1`；手機不再以 `vars.font.mono` 顯示價量，mono 只留給書號、完整帳號與診斷值。字重只用 400／500／600／700，**禁用 800**（PingFang TC 最重 600、Noto CJK 有 700／900，800 兩平台粗細不一）。

| Token | 字級 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| `pageTitle` | 1.25rem | 700 | 1.25 | 0 | 頁首標題（h1 文字不變） |
| `sheetTitle` | 1.0625rem | 700 | 1.3 | 0 | 面板標題 |
| `headline` | .9375rem | 600 | 1.3 | 0 | 列主文字、代碼、名稱 |
| `body` | .9375rem | 400 | 1.5 | 0 | 說明段落 |
| `callout` | .875rem | 500 | 1.35 | 0 | 分段、晶片、按鈕 |
| `subhead` | .8125rem | 400 | 1.4 | .01em | 列第二行 |
| `footnote` | .75rem | 400 | 1.35 | .01em | 欄位標籤、註腳 |
| `caption` | .6875rem | 600 | 1.25 | .02em | 徽章、分頁標籤（最小字級） |
| `actionLabel` | 1.1875rem | 700 | 1.25 | .02em | 方向鍵、交易鍵、CTA、選價列 |
| `confirmAction` | 1.75rem | 700 | 1.2 | .02em | 確認面板動作字 |
| `envBanner` | 1.25rem | 700 | 1.3 | .08em | 確認面板環境橫幅 |
| `numHero` | 1.75rem | 700 | 1.1 | -.02em | 交易頁主價、持倉損益合計 |
| `numLg` | 1.25rem | 700 | 1.2 | -.01em | 價格與數量輸入（≥16px） |
| `numMd` | .9375rem | 600 | 1.2 | 0 | 列價格、五檔價 |
| `numSm` | .8125rem | 500 | 1.2 | 0 | 量、統計格、成本 |

- 中文不加負字距；負字距只套在 num 樣式。
- 輸入欄位維持 `INPUT_FONT_SIZE = max(16px, 1rem)`，含疊在按鈕上的透明 select。
- 字級「大」（`html[data-sj-font-scale="1.3"]`）：統計格 2 欄、快捷價 3×2、五檔表頭改縮寫（不用容器查詢）。
- `trade-chart.tsx:258` 圖表字型改為同一系統字族字串（只改字型選項，不動圖表邏輯）。

### 4.8 色彩規則與對比實算

WCAG 相對亮度實算（以 sRGB 疊色、與瀏覽器合成一致）：

| 組合 | 深色 | 淺色 |
|---|---|---|
| 白字／紅實心（無疊） | 3.90 | 5.08 |
| 白字／紅＋inkStrong | 6.69（28%） | 5.81（8%） |
| 白字／紅＋inkLarge | 4.87（12%） | 5.08（0%） |
| 白字／綠實心（無疊） | 2.68 | 4.34 |
| 白字／綠＋inkStrong | 4.85 | 4.99 |
| 白字／綠＋inkLarge | 3.41（大字門檻 3:1 通過） | 4.34（大字通過） |
| 白字／accent（無疊） | 3.31 | 4.90 |
| 白字／accent＋inkStrong | 5.80 | 5.61 |
| 白字／accent＋inkLarge | 4.17 | 4.90 |
| 黑字／amber 實心 | 9.54 | 6.11 |
| 紅字／雙層買進著色面板 | 3.94 | 3.74 |
| 綠字／雙層賣出著色面板 | 5.04 | 3.39 |
| 紅字／雙層賣出著色面板 | 3.46 | 3.97 |
| mutedForeground／雙層著色 | 4.24 | 3.97 |
| mutedForeground／單層著色 | 4.90 | 4.60 |
| foreground／雙層著色 | 11.05 | 11.46 |
| 紅字／islandBg | 5.23 | 5.08 |
| 綠字／islandBg | 7.61 | 4.34（theme 層級問題） |
| mutedForeground／islandBg | 5.64 | 5.38 |
| 紅字／background | 5.39 | 4.45 |
| 綠字／background | 7.84 | 3.80 |
| 分段 accent 環／軌道 | 5.37 | 4.14 |

規則：
1. **漲跌**：文字用 up／down／flat，並附 ▲▼ 與正負號；跳價閃爍只用 upFlash／downFlash 覆蓋層的 opacity。
2. **買賣**：方向鍵選中段、CTA、交易鍵列、選價列與全螢幕買賣鍵用實心 up／down；文字永遠是完整動作（買進、賣出、預覽融資買進委託…）。
3. **實心填色疊黑**：`background-color: <up|down|accent|danger>; background-image: linear-gradient(rgba(0,0,0,var(sj.inkX)), rgba(0,0,0,var(sj.inkX)))`。≥1.1875rem 粗體或純圖示（方向鍵、交易鍵、CTA、選價列、全螢幕買賣、滑塊把手、環境橫幅）用 `inkLarge`；其餘小字（漲跌膠囊、方向小膠囊、鎖單膠囊、環境小膠囊、分頁徽章、委託狀態實心標籤）用 `inkStrong`。
4. **amber**：小字警示一律 foreground 文字，amber 只用於圖示、3px 左側條與框線（淺色 amber 對白只有 3.44）；「環境未確認」小膠囊為 amber 實心＋黑字。
5. **選取**：分段選中用 `segThumb`＋e1＋1px accent 環（深色主題拇指與軌道亮度差僅約 1.37，必須靠 accent 環達 ≥3:1）；選中文字 foreground 600、未選 mutedForeground 500。accent 另用於連結、焦點環、開關開啟、分頁 active。
6. **著色面板上直接承載的文字只用 foreground**（標籤以字級與字重分層），不用 mutedForeground、不用漲跌色小字、不用 amber 小字。
7. 含漲跌色小字或 mutedForeground 的區塊（精簡報價、資訊雙欄、內嵌五檔、確認明細）放在 `islandBg` 中性島內。
8. 著色面板上的 ▲▼ 可用漲跌色（圖形門檻 3:1），旁邊數字用 foreground。
9. 淺色主題：含漲跌色文字的清單、五檔、統計放在 `contentBg`（白），不直接放 #eef0f3。淺色綠對白 4.34 屬 theme 層級問題，本案不可改；記錄為已知問題，建議主代理另案評估把淺色綠調到約 #088262（約 4.8:1）並同時考量桌面。
10. 狀態色固定：success（LIVE、全部成交）、amber（連線中、資料過期、結果未知、待對帳）、danger（中斷、錯誤、正式環境、已鎖單、刪單）、accent（同步中、模擬環境）。不隨台灣／國際配色翻轉。
11. 暗化幕只用黑色 rgba；白字只用 `#ffffff`；不自訂任何漲跌 hex。

### 4.9 動態 token

彈簧（Apple 以阻尼比 ζ 與反應時間 response 描述；m=1、ω0=2π/response、k=ω0²、c=2ζω0）：

| 名稱 | ζ | response | k | c | 用途 |
|---|---|---|---|---|---|
| `default` | 1.00 | .35s | 322.3 | 35.90 | 一般狀態、未達門檻滑塊回彈 |
| `snappy` | 1.00 | .22s | 815.7 | 57.12 | 選價列升起、小元件 |
| `sheet` | 1.00 | .32s | 385.5 | 39.27 | 面板程式觸發的開關、堆疊後退 |
| `sheetFling` | .82 | .30s | 438.6 | 34.35 | 只在放手 \|v\| ≥500px/s 後（Apple sheet 參考值 ζ.8／.3s） |
| `toast` | .90 | .38s | 273.4 | 29.76 | 通知進出 |
| `bump` | .55 | .25s | 631.7 | 27.65 | 步進撞界限、不可關閉面板輕彈 |

手勢常數：方向鎖定門檻 10px；速度取最近 100ms 樣本、最後樣本早於放手 50ms 以上視為 0；甩動 500px/s；直接關閉 1000px/s；面板投射減速率 .99（project 係數 0.099s）；通知 .998（0.499s）；橡皮筋常數 .55；拖曳後 click 攔截 350ms；列長按 500ms（沿用 `watchlist-page.tsx:37`）；圖表長按 450ms（沿用 `trade-chart.tsx:80`）。

非手勢 CSS 轉場（不用 `linear()`）：`EASE.out = cubic-bezier(.2,.8,.2,1)`、`EASE.sheet = cubic-bezier(.32,.72,0,1)`；`DUR.press 80ms`、`DUR.fade 150ms`、`DUR.tone 200ms`、`DUR.thumb 240ms`、`DUR.bar 120ms linear`、`DUR.flash 600ms`、`DUR.flashGap 350ms`。JS 彈簧無法執行時（§5.1 同步模式）元件直接到終點，不另寫 CSS 關鍵影格。

---

## 5. 動態與手勢核心

### 5.1 `src/mobile/motion/spring.ts`（約 0.9 KiB gzip）

```ts
export interface SpringConfig { zeta: number; response: number }   // 0 < zeta ≤ 1；>1 以 Math.min 防呆
export const SPRINGS: Record<'default'|'snappy'|'sheet'|'sheetFling'|'toast'|'bump', SpringConfig>;
export interface SpringHandle {
  stop(): { value: number; velocity: number };   // 回傳畫面上的當下值
  retarget(to: number, velocity?: number): void; // 以當下值與速度為新初值（速度連續）
  value(): number; velocity(): number; readonly done: boolean;
}
export function animateSpring(o: { from: number; to: number; velocity?: number; config: SpringConfig;
  restDelta?: number /* 0.5（px）；opacity／scale 用 0.001 */; restSpeed?: number /* 5 px/s */;
  onUpdate(value: number, velocity: number): void; onRest?(): void; }): SpringHandle;
export function animateTween(o: { from: number; to: number; durationMs: number; onUpdate(v: number): void; onRest?(): void }): SpringHandle; // 減少動態的 150ms 淡入淡出
export function springAt(c: SpringConfig, x0: number, v0: number, t: number): { x: number; v: number }; // 純函式
export function project(velocityPxPerS: number, decelerationRate: number): number; // (v/1000)·d/(1−d)
export function rubberband(offset: number, dimension: number, c = 0.55): number;   // sign·|o|·dim·c/(dim + c·|o|)
export function canAnimate(el: unknown): el is HTMLElement;
export function setMotionClockForTest(clock: { now(): number; frame(cb: (t: number) => void): number; cancel(id: number): void } | null): void;
```

解析解（x 為相對目標的位移，x0=from−to，v0=velocity）：
- ζ<1：ωd=ω0√(1−ζ²)；`x(t)=e^(−ζω0t)·(x0·cos ωd t + ((v0+ζω0x0)/ωd)·sin ωd t)`；`v(t)=e^(−ζω0t)·(v0·cos ωd t − ((ζω0v0+ω0²x0)/ωd)·sin ωd t)`。
- ζ=1：`x(t)=e^(−ω0t)·(x0+(v0+ω0x0)t)`；`v(t)=e^(−ω0t)·(v0−ω0(v0+ω0x0)t)`。
- 靜止：|x|<restDelta 且 |v|<restSpeed，最後一次 `onUpdate(to, 0)` 再 `onRest()`。

規則：
- 全部動畫共用一個 rAF 迴圈，沒有動畫時停止；`onUpdate` 直接寫 `element.style`（transform、opacity），不觸發 React render；開始時加 `will-change: transform`，靜止後移除並把 0 位移寫成 `transform: none`。
- **同步模式**（立即呼叫 `onUpdate(to,0)`＋`onRest()`）條件，任一成立即同步：沒有 `window`／`document`／`requestAnimationFrame`；目標元素不是已連到文件的 DOM 節點（`canAnimate(el)` 為假，例如 react-test-renderer 的 ref 為 null 或 node mock 沒有 `style`／`isConnected`）；`document.visibilityState === 'hidden'`；減少動態開啟（減少動態時呼叫端改用 `animateTween` 做 150ms 淡入淡出，淡入淡出同樣受前三項同步條件約束）。
- 注意：`trade-chart.test.tsx:165` 會 stub `requestAnimationFrame`，所以「有沒有 rAF」不能單獨作為判斷，必須同時看目標節點。
- 寫 style 的 helper 必須容忍 node mock（沒有 `style` 物件時不寫、不丟錯）。

### 5.2 `src/mobile/motion/gesture.ts`（約 0.9 KiB gzip）

```ts
export class VelocityTracker { reset(): void; add(t: number, pos: number): void; velocity(now: number): number } // px/s；最近 100ms 最小平方斜率；最後樣本 >50ms 前 → 0
export function usePointerDrag(o: {
  axis: 'x' | 'y'; slop?: number /* 10；把手類 touch-action:none 可設 0 */;
  canStart?(e: PointerLike): boolean; onStart?(i: DragInfo): void; onMove?(i: DragInfo): void;
  onEnd?(i: DragInfo & { velocity: number; cancelled: boolean }): void;
}): { onPointerDown; onPointerMove; onPointerUp; onPointerCancel; onLostPointerCapture }; // 回傳 React props
export function suppressClicksAfterDrag(el: Element, ms = 350): void; // capture 階段攔 click（stopPropagation＋preventDefault）
export const DRAG_EXCLUDE_SELECTOR = 'button, a, input, select, textarea, [role="slider"], [data-sheet-nodrag]';
```

- 一律回傳 React props（不以 ref 綁原生監聽），既有測試直接呼叫 `props.onPointerDown(...)` 必須仍可運作。
- 事件欄位容錯：只在 `e.isPrimary === false` 時拒絕（測試的假事件沒有 isPrimary）；`e.pointerType === 'mouse' && e.button > 0` 拒絕；時間取 `e.timeStamp || clock.now()`；`e.currentTarget.setPointerCapture?.(id)`；只追蹤第一個指標。
- 方向鎖定：位移超過 slop 後比較 |dx|、|dy|，不屬本軸立即放棄並交還原生捲動；確定軸向後才 capture。
- pointercancel、lostpointercapture 走取消路徑（velocity 0、`cancelled: true`）。

### 5.3 `motion/prefs.ts`、`motion/haptics.ts`、`lib/ui-settings.ts`

- `prefs.ts`：`prefersReducedMotion()`、`subscribeReducedMotion(cb)`、`useReducedMotion()`（matchMedia `(prefers-reduced-motion: reduce)` 並監聽 change；沒有 matchMedia 時為 false）；`transparencyReduced()`（`html[data-sj-transparency="reduced"]`，或屬性不存在且 `(prefers-reduced-transparency: reduce)` 成立）。本輪不提供 App 內「減少動態」開關（只跟系統）。
- `ui-settings.ts`（新 localStorage 鍵 `'sj-mobile-ui-v1'`，不動 `mobile-device-settings.ts` 及其測試）：
  ```ts
  export interface MobileUiSettings { transparency: 'system' | 'reduced' | 'full'; uiHaptics: boolean }
  export function sanitizeMobileUiSettings(v: unknown): MobileUiSettings; // 預設 { transparency: 'system', uiHaptics: true }
  export function getMobileUiSettings(); setMobileUiSettings(patch); useMobileUiSettings(); subscribeMobileUiSettings(cb);
  ```
  第一次載入且沒有儲存值時：非 iOS（沒有 `GestureEvent`）且 `navigator.hardwareConcurrency <= 4` 或 `navigator.deviceMemory <= 3` → `transparency: 'reduced'` 並寫回；讀寫包 try/catch，失敗只在本次有效。
- `haptics.ts`：`haptic(kind: 'threshold' | 'longPress' | 'bound')` 分別震 8ms、8ms、12ms；只在 `uiHaptics` 為真且 `vibrationSupported()`（沿用 `mobile-device-settings.ts:90`）時呼叫，例外一律吞掉；iOS 一律不執行，也不使用隱藏 switch 觸發觸覺的技巧。成交震動沿用既有設定不變。

### 5.4 `lib/sheet-stack.ts` 與 `ui/sheet-context.ts`

```ts
// lib/sheet-stack.ts
export interface SheetStackEntry { layer: 'sheet' | 'confirm'; getPanel(): HTMLElement | null;
  isDismissible(): boolean; requestClose(): void; }
export function registerSheet(e: SheetStackEntry): { id: number; unregister(): void };
export function useSheetStack(): { depth: number; topId: number | null; indexOf(id: number): number }; // useSyncExternalStore
```
- 排序：confirm 層永遠在 sheet 層之上，同層依註冊先後。
- depth 由 0→1 時安裝一組 document capture 監聽，回到 0 時移除：`Escape` 只交給最上層且只在 `isDismissible()` 為真時呼叫 `requestClose()`；`Tab` 在最上層面板內循環。各面板不再自掛 document keydown。
- `ui/sheet-context.ts`：
  ```ts
  export const SheetRootContext = createContext<HTMLElement | null | 'inline'>('inline'); // 預設 inline＝測試與獨立渲染
  export interface SheetPresence { phase: 'entering' | 'open' | 'exiting'; settled: boolean; shownAt: number; isExiting(): boolean }
  export const SheetPresenceContext = createContext<SheetPresence>({ phase: 'open', settled: true, shownAt: 0, isExiting: () => false });
  export const SheetFooterTargetContext = createContext<HTMLElement | null>(null);
  ```

---

## 6. 元件規格

### 6.1 BottomSheet v2（重寫 `components/bottom-sheet.tsx`、`styles/sheet.css.ts`）

**API（既有 props 與匯出全部相容）**

```ts
export interface BottomSheetProps {
  open: boolean; onClose(): void; title?: ReactNode; children: ReactNode;
  dismissible?: boolean;               // 預設 true
  layer?: 'sheet' | 'confirm';         // 預設 'sheet'
  ariaLabel?: string; testId?: string; tone?: 'buy' | 'sell' | null;
  detent?: 'fit' | 'large';            // 新增，預設 'fit'
  footer?: ReactNode;                  // 新增，固定在底部、不隨內容捲動
  pinned?: ReactNode;                  // 新增（第一階段實作時補上），固定在標題列下方、不隨內容捲動、不在拖曳區
  initialFocus?: 'title' | 'panel';    // 新增，預設 'title'（沒有 title 時 panel）
  onExited?(): void;                   // 新增，退場結束或同步卸載後呼叫
}
export const DISMISS_DRAG_PX = 80;     // 保留
export function sheetReleaseDecision(i: { y: number; vy: number; height: number; dismissible: boolean }): 'dismiss' | 'stay';
export function SheetFooter(p: { children: ReactNode }): JSX.Element; // §6.2
```

元件識別維持匯出名 `BottomSheet`（`orders-page.test.tsx:667`、`order-action-sheet.test.tsx:85` 以 `n.type === BottomSheet` 找元件）。

**DOM 與 testId**

```
backdrop  data-testid=`${testId}-backdrop`（退場中 `${testId}-closing-backdrop`）data-layer data-stacked
└ panel   role=dialog aria-modal aria-labelledby|aria-label tabIndex=-1
          data-testid=`${testId}`（退場中 `${testId}-closing`）data-tone data-detent data-phase
          退場中 inert＋aria-hidden＋pointer-events:none
  ├ toneLayer×2（aria-hidden，buy／sell 各一，opacity 交叉淡化 200ms）
  ├ grabArea data-testid=`${testId}-grab`：把手 36×5＋標題列（h2 sheetTitle＋關閉 IconButton，aria-label「關閉」，只在 dismissible 時出現）
  ├ pinned（data-sheet-pinned；只在 pinned prop 不為 null／undefined 時出現）
  ├ body（唯一捲動區，data-sheet-body）
  └ footer（data-sheet-footer；footer prop 與 SheetFooter portal 的目標）
```

- **Portal**：`SheetRootContext` 為元素時 `createPortal` 到殼層的 `#sj-sheet-root`；為 `'inline'`（預設、測試、無 provider）時原地渲染；為 `null`（provider 已存在但節點尚未掛上）時該幀不渲染。backdrop 根節點對 React 的 `onClick`、`onPointerDown` 呼叫 `stopPropagation()`，避免 portal 事件冒泡到頁面中的 React 祖先；keydown 不攔。
- **生命週期**（可動畫時）：`closed →（open=true）註冊 sheet-stack、記住觸發元素、entering（從面板高度以 spring.sheet 到 0）→ open（settled=true）→（open=false）立即解除註冊、還原焦點、exiting（凍結最後一次的 children、title、tone、footer、pinned、dismissible；從目前位置以 spring.sheet 帶當下速度到面板高度；暗化幕同步淡出）→ closed（render null、onExited）`。退場中又 open=true：從目前位置反向進場並重新註冊、`shownAt` 重設。
- **同步模式**（§5.1）：open 立即為 open（settled=true）、關閉立即卸載（既有 `toHaveLength(0)` 斷言不變）。
- **暗化幕**：`opacity = 1 − y / height`（夾 0–1），背景 `rgba(0,0,0,var(sj.scrim))`；`data-stacked="true"`（下面還有面板）時用 `sj.scrimStack`。
- **堆疊後退**：本面板已註冊但不是最上層 → 以 spring.sheet 驅動 p∈[0,1]：`transform: translateY(y − 6p px) scale(1 − .06p)`、`transform-origin: top center`；減少動態時不縮放、只靠上層暗化幕。z-index＝層級基準＋10×堆疊序（寫在 backdrop 的 React style，非動畫屬性）。
- **拖曳（只限 grabArea）**：`touch-action: none`；起點符合 `DRAG_EXCLUDE_SELECTOR` 不開始；可關閉時 1:1 跟手並保留抓取偏移（動畫中被抓住：停止彈簧，以畫面上的位置為起點）；往上超出 0 時顯示 `−rubberband(−y, height, .55)`。
- **不可關閉（dismissible=false）**：按把手或點暗化幕 → 面板以 spring.bump 往下輕彈 6px 再回原位；不跟手、不呼叫 onClose；Esc 與關閉鈕不存在／無效。拖曳途中變成不可關閉 → 立即取消拖曳並回到 0（沿用 T6，`bottom-sheet.tsx:63-77` 的「依當下 dismissible」語意）。
- **放手**：
  ```ts
  export function sheetReleaseDecision({ y, vy, height, dismissible }) {
    if (!dismissible || !(y > 0)) return 'stay';
    if (vy >= 1000 && y > 10) return 'dismiss';                       // 快速下甩
    if (!(height > 0)) return y >= DISMISS_DRAG_PX ? 'dismiss' : 'stay'; // 量不到高度：沿用舊規則
    const projected = y + project(vy, 0.99);                           // vy × 0.099
    return projected >= Math.max(DISMISS_DRAG_PX, height * 0.5) ? 'dismiss' : 'stay';
  }
  ```
  `dismiss`：呼叫 `onClose()`，保持目前位置；open 變 false 時以放手速度進入退場（|vy|≥500 用 sheetFling，否則 sheet）；下一幀 open 仍為 true（父層拒絕）→ 以 spring.sheet 回 0。`stay`：以放手速度用 spring.sheet（|vy|≥500 用 sheetFling）回 0。
- **測試相容的後備位移**：無法動畫時（`panelRef` 為 null 或 node mock），拖曳位移改存 React state，panel 的 React `style` 恰為 `offset > 0 ? { transform: \`translateY(${offset}px)\` } : undefined`（格式與現行完全一致，`bottom-sheet.test.tsx:34、46、54`）。可動畫時 React `style` 恆為 undefined，避免 React 覆寫直接寫入的 transform。
- **焦點**：進場時移到 h2（`tabIndex=-1`）或 panel；Tab 由 sheet-stack 在最上層循環；退場開始即還原到觸發元素（仍連到文件且不在 inert 區時）。
- **背景隔離**：由殼層依 `useSheetStack().depth > 0` 對狀態列容器、mainWrap、底部 chrome 設 `inert` 並同時設 `aria-hidden="true"`（iOS 15.4 沒有 inert）；只在 SheetRoot 為真實元素（portal 生效）時才設，避免把仍原地渲染的面板一起隔離。
- **鍵盤**：`hooks/use-keyboard-inset.ts` 監聽 `visualViewport` resize／scroll，`inset = max(0, innerHeight − vv.height − vv.offsetTop)` 寫入 backdrop 的 `--sj-kb`；backdrop `padding-bottom: var(--sj-kb)`，panel `max-height: calc(100% − var(--sj-sheet-top) − var(--sj-kb, 0px))`。實機若 iOS 15 偏移異常，後備為 inset=0（footer 隨面板），並對聚焦輸入框 `scrollIntoView({ block: 'nearest' })`。
- **尺寸**：`fit`＝內容高度、上限 `100% − --sj-sheet-top − --sj-kb`；`large`＝固定該上限高度。所有面板頂端都不進入狀態列區域（取代 `sheet.css.ts:27` 的 `calc(100% - 24px)`）。寬度上限 640px 置中（沿用）。
- **外觀**：panel 背景 `vars.color.panel`、上緣圓角 16、e3；toneLayer 各自 `border-radius: inherit`、`background-image` 兩層 upDim（或 downDim）`linear-gradient`、`box-shadow: inset 0 3px 0 0 <up|down>`（3px 方向色條跟著圓角）；`data-tone` 切換時兩層 opacity 交叉淡化 200ms；`prefers-contrast: more` 只疊一層並加 1px borderBright 上框。
- **pinned（固定區）**：第一階段實作時新增，本規格原本沒有寫到。放在標題列下方、body 之上，`flex: 0 0 auto`（`styles/sheet.css.ts` 的 `pinned`，左右內距同 body），視窗變矮時 body 先縮到 0，固定區不縮、不捲動；不在 grabArea 內，從這裡往下拖不會關閉面板。用途限於必須一直看得到的安全資訊，目前只有確認面板的環境橫幅（`order-confirm-sheet.tsx`，§7.5、§10 S6）。退場時與 children、footer 一起凍結。
- **SheetLoadError**（`route-error-boundary.tsx:120-124`）自動使用 v2。

### 6.2 SheetFooter

`SheetFooter({ children })`：讀 `SheetFooterTargetContext`，有目標時 `createPortal(children, target)`，否則原地渲染（測試維持原地）。供 state 在 `TicketForm`（以 `ticket.seq` 為 key，`order-ticket-sheet.tsx:90`）內的下單面板把狀態行與 CTA 放進固定 footer；不把 `useMobileTicket` 提到 `OrderTicketSheet`。footer：上緣髮絲線、背景透明（面板著色層透出）、內距 `8px 16px`、與 body 同為 panel 的 flex 子元素（body 捲動不經過 footer）。

### 6.3 SlideToConfirm v2（`components/slide-to-confirm.tsx`、`controls.css.ts` 滑塊段落）

**保留**：`SLIDE_CONFIRM_THRESHOLD = 0.8`、`SLIDE_HANDLE_SPAN_PX = 54`、`SLIDE_KEY_STEP = 0.25`、`slideProgress()`、`slideReached()`、`SlideTone`、所有 props（label、onConfirm、disabled、disabledReason、tone、resetKey、testId）、`role=slider` 與 aria 屬性、鍵盤規則（←↓ −25%、→↑ +25%、End、Home／Esc 歸零、≥80% 才接受 Enter／Space）、觸發一次後鎖定、`resetKey` 改變重新啟用、停用時立即歸零、所有 data-testid（`${testId}`、`-fill`、`-handle`）、`aria-valuetext` 文字（含「按 Enter 確認」）。

**新增 props**：`armDelayMs?: number`（預設 300）。

**狀態表**

| 狀態 | 條件 | 視覺 | 語意 |
|---|---|---|---|
| 未就緒 | 所在面板未 settled 且距 `max(presence.shownAt, 最近一次 resetKey 改變)` 未滿 armDelayMs | 把手 opacity .5 | 忽略 pointerdown；鍵盤路徑不受影響 |
| 待命 | 預設 | 把手 ChevronsRight（白）；軌道文字 label；提示「按住把手向右滑到底後放開以確認」 | valuenow 0 |
| 拖曳 | pointerdown 後 | 把手 `translateX(p·travel)`、填充 `scaleX((p·travel+54)/W)`（origin left），由彈簧引擎直接寫 style；label opacity `1 − p/0.6` | valuenow 每跨 5% 更新一次 React state |
| 就緒 | **p ≥ 0.8（與送出條件完全一致）** | 把手換 Check、軌道 2px tone 色框、提示改「放開即送出，往回滑可取消」 | 退回 <0.8 立即恢復 |
| 回彈 | 放手且 `slideReached(final)` 為假 | 以放手速度換算的進度速度、spring.default 回 0，畫面值夾在 ≥0（不過頭） | valuenow → 0 |
| 已確認 | `fire()` | 把手停終點 Check、label「已確認」、元件 pointer-events none | aria-disabled true |
| 停用 | disabled | 軌道 opacity .5；原因列 role=status（amber 圖示＋foreground 文字） | tabIndex -1 |

**送出判定（不可更動）**：放手時 `final = slideProgress(startProgress, e.clientX − startX, travel)`，`!inactive && slideReached(final)` 才 `fire()`；速度只用於未達門檻時的回彈初速；不用投射、不用遲滯、不吸附。行程量不到（≤0）時進度恆為 0（沿用）。

**中止條件**（一律回 0、不送出）：pointercancel、lostpointercapture、disabled 變真、`visibilitychange` 為 hidden、所在面板 `presence.isExiting()` 為真。

**觸覺**：p 由 <0.8 越過 0.8 時 `haptic('threshold')` 一次；需退回 <0.77 才會再震（0.77 遲滯只用於震動節流，不影響視覺與判定）。

**外觀**：軌道 56px pill、`islandBg`＋1px borderBright；填充色 tone 的 Dim（upDim／downDim／dangerDim／accentDim）；把手 48px 圓、tone 實心＋`inkLarge`；鍵盤焦點環 2px foreground。

**AT 實機關卡（B1 合併前必做）**：在 iOS 15.4／16／17／18 的 VoiceOver 與 Android TalkBack 驗證：(a) 上下滑調整是否送出方向鍵事件；(b) 雙擊是否送出 click。依結果擇一啟用（旗標 `SLIDE_AT_FALLBACK`）：
- 增減可用、Enter 不可用：把手在**靜止**且進度 ≥0.8、最近 350ms 內沒有指標拖曳時，接受 click 作為確認。
- 增減不可用：加視覺隱藏的原生 `<input type="range" min=0 max=100 step=25>` 綁同一進度，並以同一規則（≥0.8 後另一個明確動作）確認。
- 不論哪種都不得改成單擊直接送出。

### 6.4 ToastHost v2（`components/toast-host.tsx`、`styles/toast.css.ts`）

**不變**：`MAX_TOASTS = 3`、`TTL_MS`（deal 6s、ok／info 5s、err／warn 9s）、`noticeToastKind()`、`OUTCOME_UNKNOWN_KEYWORD`、`useRevealText` 遮蔽、alert／status 分類、`aria-live="polite"` 容器。

**雙錨點（取代 `toast.css.ts:10` 的 safe+52px）**：
- **底部模式**（沒有任何面板開啟）：容器 fixed，左右 `8px＋safe`，`bottom: calc(var(--sj-tabbar-h) + var(--sj-accessory-h) + 8px)`；通知卡從下方升起、往下滑走。不遮頁首、不遮狀態列、不遮交易鍵列。
- **頂部精簡模式**（`useSheetStack().depth > 0`）：只顯示前景一則的單行膠囊，`top: calc(env(safe-area-inset-top) + 4px)`、高度 `calc(max(44px, 2.75rem) − 8px)`，完全落在已被暗化幕壓暗、且為 inert 的狀態列區域內，不壓到面板把手與標題；其餘以「+N」計數。點膠囊展開內文 5 秒（使用者主動）。面板內已重複呈現路由與環境（下單面板第一列、確認面板環境橫幅）。
- 模式切換時現有通知以 150ms 淡出淡入換到新錨點，不跨螢幕滑動。

**疊放**：DOM 依時間（舊→新）；前景＝最新的 err／warn，若沒有則最新一則；其餘在前景後方以 `scale(.95)／(.90)`、錯開 6px／12px 露出邊緣（底部模式往上露、頂部模式往下露）。點疊放區展開為垂直排列（間距 8px），5 秒無互動或只剩一則時收合。超過 3 則時先淘汰最舊的非 alert（deal／ok／info），全是 alert 才淘汰最舊。

**單則結構**：外層 `div`，`data-testid="toast-item"`，`role` 為 alert（err、warn）或 status，`className` **只放** `styles.toast[kind]`（前景、深度等狀態用 `data-front`、`data-depth`）；內部順序：圖示 svg（不包 span）→ 標題 span（warn 用 `styles.titleWarn`）→ 內文 span → 關閉 IconButton（aria-label「關閉通知」）。thick 材質、圓角 16、e2；文字一律 foreground；kind 以圖示與左側 3px 色條區分（deal accent、ok success、err danger、warn amber、info borderBright）；有漲跌方向的內文行用 foreground 文字加 3px 方向色條。圖示只用 CheckCircle2（ok、deal）、TriangleAlert（err、warn，以顏色與標題文字區分）、Info。

**手勢**：底部模式往下拖 1:1、往上橡皮筋；放手 `projected = offset + project(v, .998)`，`projected > 40` 或 `v ≥ 500` 則以速度離場（spring.toast），否則回位；頂部模式鏡像（往上）。按住任一通知時暫停全部 TTL，放開以剩餘時間續算；拖曳後 350ms 內攔下 click。單則時點一下關閉（沿用）。減少動態：只淡入淡出。

**持續狀態就地化**（「結果未知」的長效提示不靠通知）：委託分頁徽章在 `useTradingState().queries.orders.needsReconcile` 為真時加 8px amber 點（aria-label 補「，待對帳」）；委託頁對帳 banner 常駐直到對帳完成（沿用 `orders-page.tsx:237-246`）。

### 6.5 StatusStrip v2 與 RouteBadge

`components/status-bar.tsx`、`styles/status-bar.css.ts`；純函式 `connectionLight()`、`statusBarAccount()` 與所有 data-testid、aria-label 不變。

- 高度 `TOUCH_MIN ＋ safe-top`，**不透明** `vars.color.panel`，下緣髮絲線；不再 sticky（位於捲動容器之外）。
- 非 LIVE 或 ResumeGate 非 ready：整條以 `::before`（`position:absolute; inset:0; z-index:-1; opacity:.14`）淡染狀態色（connecting／資料過期 amber、down／未恢復 danger、syncing accent），高度不變。
- 正式環境（目前路由 `simulation === false`）：下緣改 `inset 0 -2px 0 vars.color.danger`。
- 左：連線膠囊＝8px 狀態色圓點＋foreground 文字（callout 600）；非 LIVE 加 1px 狀態色框；同步中圓點改旋轉小環（減少動態時靜止）。
- 中：路由膠囊（flex 1、可省略號截斷）＝`永豐`＋環境實心小膠囊（正式：danger＋inkStrong 白字；模擬：accent＋inkStrong 白字；未確認：amber 實心黑字）＋` · `＋帳號（`mobileAccountLabel`）＋ChevronDown 14px；沒有帳戶時 amber 1px 框＋foreground「未選擇證券帳戶」。
- 右：未鎖＝LockOpen 16px＋「風控」（mutedForeground，對 panel 5.41）；已鎖＝danger 實心膠囊（inkStrong）＋Lock＋白字「已鎖單」。視覺隱藏的 `aria-live="polite"` 在鎖單狀態**改變**時宣告「已鎖單（只對本裝置有效）」／「已解除鎖單」；連線狀態維持 2 秒以上才宣告。
- 三段點擊區各 ≥ TOUCH_MIN；行為不變（連線詳情、帳戶切換、未鎖立即鎖、已鎖開解除鎖單面板）。
- RouteBadge：樣式移到新檔 `styles/route-badge.css.ts`（`controls.css.ts` 的舊 `routeBadge`／`routeBadgeLarge` 已在 B4 刪除）；外框膠囊（borderBright）＋foreground「送往 永豐 」＋環境實心小膠囊；可見文字串接後仍為 `routeBadgeText` 的「送往 {券商} {環境}」。

### 6.6 殼層：ShellSlot、TabBar、捲動記憶、HTML 屬性（`app.tsx`、`styles/layout.css.ts`）

```
.shell（position:relative；height: 100% → 100dvh；flex column；overflow hidden；設 --sj-* 變數；data-sheet-open）
├ .statusWrap（inert 目標）→ StatusBar
├ .mainWrap（flex:1；min-height:0；position:relative；inert 目標）
│   ├ main（position:absolute；inset:0；overflow-y:auto；
│   │       padding-bottom 與 scroll-padding-bottom = calc(var(--sj-tabbar-h) + var(--sj-accessory-h))；左右 safe）
│   └ .topSlot（position:absolute；top:0；left/right:0；z 11；pointer-events:none，子元素 auto）
├ .bottomStack（position:absolute；bottom:0；left/right:0；z 10；material.bar；inert 目標）
│   ├ .accessorySlot（ResizeObserver 量高 → --sj-accessory-h）
│   └ nav.tabBar（49px＋safe-bottom）
├ ToastHost
└ #sj-sheet-root（SheetRootContext 的目標）
```

- 不得對 `.mainWrap`、`main` 設 transform、filter、backdrop-filter、will-change、contain:paint（保護 fixed 全螢幕圖表）。
- `.shell`、`.mainWrap`、`main` 也不得建立疊層脈絡（z-index、isolation、opacity 等），`src/mobile` 也不得設定 `-webkit-overflow-scrolling`。WebKit（iOS Safari）會把帶 `touch` 值的捲動容器當成 z-index 0 的疊層脈絡，main 內所有 fixed 子孫（全螢幕圖表、原地渲染的面板）因此永遠畫在 `.bottomStack`（z 10）與 `.topSlot`（z 11）之下。實機案例：舊版「持倉 → 平倉說明」的「取消／繼續」被分頁列擋住。Chrome 不支援這個屬性，模擬器重現不了，因此由 `styles/layout-stacking.test.ts` 靜態檢查。iOS 13 起捲動容器預設就有慣性捲動，不需要它。
- `ui/shell-slots.tsx`：`ShellSlotsContext`（`{ top, bottom } | 'inline'`）與 `ShellSlot({ slot: 'top' | 'bottom', children })`：有目標時 portal，否則原地渲染（測試維持原地，testId 不變）。
- TabBar：lucide 24px（strokeWidth 1.75，active 2.25）＋caption 標籤；active 用 accent；未成交徽章 danger＋inkStrong 白字、>99 顯示 99+；待對帳 amber 點；點擊立即切換、無轉場；**再點目前分頁**：`preventDefault` 並 `main.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })`。
- 捲動記憶（`lib/scroll-memory.ts`，Map<routeKey, top>；routeKey＝`formatRoute(route)`，交易頁依代碼分開）：main 上被動 scroll 監聽（rAF 合併）記錄目前 routeKey 的 scrollTop；routeKey 改變時於殼層 layout effect 標記 `pending = newKey`，pending 期間不記錄；`<ScrollRestorer routeKey>` 放在 Suspense 內、RoutePage 之後，於 layout effect 還原（沒有紀錄則 0）並清除 pending。
- 頁面的 `Suspense` 以分頁名為 key（`<Suspense key={route.name}>`，第二階段後修正）：第一次切到延遲載入的分頁時，React 會把舊頁以隱藏的 Offscreen 保留，但隱藏不及於 portal，舊交易頁的交易鍵列（ShellSlot bottom）與精簡標頭（ShellSlot top）會留在殼層、仍可點擊。改用 key 後換分頁會卸載整個頁面樹；同一分頁內換商品（`#/trade/2330` → `#/trade/2317`）key 不變，不重掛。由 `app-shell.test.tsx` 覆蓋。
- `hooks/use-html-attributes.ts`：在 `<html>` 寫入 `data-sj-font-scale`（`useThemeSettings().fontScale`）與 `data-sj-transparency`（`ui-settings.transparency` 為 system 時移除屬性）；殼層 `data-sheet-open` 由 sheet-stack depth 決定。
- 選做：依主題於執行期更新 `meta[name=theme-color]` 為狀態列色（不改 mobile.html）。
- 選做：main 內容尾端哨兵（IntersectionObserver）可見時 `.bottomStack[data-edge="true"]`，`::before` 150ms 淡為 0、隱藏髮絲線（scroll edge）。

### 6.7 Segmented（`ui/segmented.tsx`，取代六種樣式）

```ts
interface SegmentedItem<T> { value: T; label: string; disabled?: boolean; testId?: string; ariaLabel?: string }
interface SegmentedProps<T extends string | number> {
  items: readonly SegmentedItem<T>[]; value: T | null; onChange(v: T): void;
  semantics: 'tabs' | 'toggle';   // tabs → role=tablist／tab＋aria-selected；toggle → role=group＋aria-pressed
  ariaLabel: string; size?: 'regular' | 'compact'; variant?: 'thumb' | 'scroll';
  disabled?: boolean;             // 整組（例如送出中）
  describedBy?: string;           // 停用原因元素 id
}
```

- 每段是原生 `<button>`，**可見文字恰為 label**（測試以 `btn('IOC')`、`btn('融資')` 等精確文字定位）；停用段維持原生 `disabled`（測試斷言 `props.disabled`），opacity .45。
- 停用原因：以 footnote 顯示在該組下方並 `aria-describedby` 關聯；`title` 可保留但不作唯一說明。
- thumb 變體：軌道 `sj.segTrack`、圓角 9、內距 2；拇指為絕對定位 span，寬 `calc((100% − 4px)/n)`、`transform: translateX(calc(100% * i))`、`sj.segThumb`＋e1＋`box-shadow` 疊 `0 0 0 1px accent`，CSS 轉場 transform 240ms `EASE.sheet`（轉場本身從目前值重新導向、可中途打斷）；value 為 null 時拇指 opacity 0。
- scroll 變體（排行種類）：可橫向捲動的膠囊列，選中 `accentDim` 底＋accent 文字（不移動拇指）。
- 尺寸：regular 外觀 TOUCH_MIN；compact 外觀 2.25rem、點擊區擴到 TOUCH_MIN。
- 對照：自選／排行、五檔／明細、排行種類、委託狀態用 `tabs`；週期、持倉市場、下單單位／信用／時段／效期／倉別、五檔整股／盤中零股、帳戶頁分段、全螢幕週期用 `toggle`。

### 6.8 DirectionToggle（`ui/direction-toggle.tsx`）

`DirectionToggle({ value: 'Buy' | 'Sell' | null, onChange, disabled })` → `role="group" aria-label="買賣方向"`，兩顆原生 button，可見文字恰為「買進」「賣出」，`aria-pressed`。版面 `grid 1fr 1fr`、`gap: 12px`、高 `CONTROL_LARGE`、圓角 12、`actionLabel` 字級。選中：tone 實心＋inkLarge＋白字＋lucide Check（svg，不產生文字節點）。未選：`islandBg`＋1.5px tone 色框＋tone 色文字（大字門檻：淺色綠 4.34、深色綠 7.61）。按下 scale .97。切換時面板著色交叉淡化 200ms、CTA 文字立即更新。

### 6.9 Stepper（`ui/stepper.tsx`）

```ts
Stepper({ value: string; onChange(text: string): void; onStep(delta: 1 | -1): void;
  inputMode: 'decimal' | 'numeric'; ariaLabel: string; decLabel: string; incLabel: string;
  testId?: string; disabled?: boolean; stepDisabled?: boolean; invalid?: boolean; onBlur?(): void;
  atMin?: boolean; atMax?: boolean; minText?: string; maxText?: string; flashKey?: unknown; unit?: string })
```

- 版面 `[－][輸入][＋]`：鍵 TOUCH_MIN 正方、`elevatedBg`＋1px borderBright 髮絲＋e1、圓角 8，**可見字元維持全形「－」「＋」**（`order-ticket-sheet.test.tsx:319、884` 以 `click('＋')` 定位），aria-label 沿用（「價格減一檔」「價格加一檔」「數量減一」「數量加一」）；輸入框 `islandBg`、`numLg`、置中、`aria-invalid` 時 amber 框。
- 點擊（click）走一步；按住 400ms 後每秒 8 步，持續 1.2 秒後每秒 16 步；發生過連續步進則吞掉隨後的 click（避免重複一步）；pointerup、pointercancel、pointerleave、lostpointercapture、window blur、visibilitychange、disabled、到達界限一律停止。
- 界限：`atMax` 時按＋（或 `atMin` 時按－）**不呼叫 onStep**，輸入框以 spring.bump 橫移 4px 回彈、顯示 footnote（role=status）`maxText／minText` 2 秒、`haptic('bound')`；減少動態時只顯示文字。
- `flashKey` 改變（外部帶入價格）：輸入框上的 accent 外框覆蓋層以 WAAPI opacity 1→0 400ms；減少動態改為靜態外框 600ms 後移除。

### 6.10 Chip、QuickChips、PopUpButton、IconButton、PageHeader

- **Chip**：外觀 2.25rem、點擊區 TOUCH_MIN、圓角 8、`elevatedBg`＋髮絲框、callout；選中 `segThumb`＋accent 環；停用 opacity .45 並在 aria-label 寫原因。可選 `dataPrice`：價格以 `data-price` 屬性＋`::after { content: attr(data-price) }` 顯示第二行（numSm、mutedForeground），**按鈕文字節點仍只有標籤**（測試 `btn('成交')`、`btn('買一')` 精確比對），aria-label 已含價格。
- **QuickChips**：快捷價 `grid-template-columns: repeat(6, minmax(0,1fr))`、間距 6px、高 48px 兩行（390 寬每格約 54.7px）；`html[data-sj-font-scale="1.3"]` 改 `repeat(3, …)` 兩列。數量預設 `repeat(4, …)`、單行 36px（零股 10／50／100／500）。取代 `order-ticket.css.ts:328-332`。
- **PopUpButton**：可見部分為「目前選項＋ChevronsUpDown 圖示」，底層原生 `<select>` 透明疊滿（opacity 0、字級 ≥16px），`data-testid`、`aria-label`、`value`、`onChange` 都在 select 上（`ticket-price-type`、`orders-account` 等測試不變）。
- **IconButton**：點擊區 44×44、圖示 18–24px、`aria-label` 必填、`pressed` 時 accentDim 底；面板關閉鈕為 30px 圓（`elevatedBg`）內 X 18px。
- **PageHeader**：`PageHeader({ title, actions })` → `h1.pageTitle`（文字不變）＋右側動作；高 TOUCH_MIN、左右 16。不做大標題收合。

### 6.11 GroupedSection、ListRow、ValueRow、InlineNote

- `GroupedSection({ header?, footer?, children, testId? })`：header／footer 為卡片外 footnote（mutedForeground）；卡片左右內縮 16、圓角 12、`groupedBg`；列間髮絲線從文字起點開始。
- `ListRow({ title, subtitle?, leading?, trailing?, chevron?, onClick?, href?, disabled?, testId? })`：min-height TOUCH_MIN、內距 11px 16px；可點列用 pressableRow；**按鈕內只放 title 文字**（副標或原因放在按鈕外並以 aria-describedby 關聯），以免破壞 `btn('改價')` 類精確比對。
- `ValueRow({ label, value, tone?, testId? })`：左 mutedForeground、右 foreground num；tone warn 時加 amber 圖示，文字仍 foreground。
- `InlineNote({ tone: 'warn' | 'danger' | 'info', children, action?, role?, testId? })`：`islandBg`、左側 3px tone 條、圖示（TriangleAlert／XCircle／Info）、foreground 文字、可選動作鍵（≥44px）；用於對帳、ResumeGateNote、價格過期、信用提醒、帳戶限制說明、組合商品不可下單。

### 6.12 PriceFlash、VolumeBar、RatioBar、ProgressBar

- `ui/price-flash.ts`：`usePriceFlash(ref, value, { enabled })`。與上一筆比較，上漲用 upFlash、下跌 downFlash 的絕對定位覆蓋層，`element.animate([{opacity:1},{opacity:0}], { duration: 600, easing: 'ease-out' })`；同一格距上次 <350ms 不閃；不閃：第一次渲染、資料來源切換（快照→成交）、金額遮蔽、元素不可見（共用 IntersectionObserver）、減少動態；沒有 `Element.prototype.animate` 時略過。套用：交易頁主價、自選列價格、持倉損益合計。不用 theme 的 flash 關鍵影格。
- `ui/bars.tsx`：VolumeBar（五檔每格，`transform: scaleX(量 ÷ 五檔最大量)`；買側 origin right、賣側 origin left；upDim／downDim；`transition: transform 120ms linear`）；RatioBar（兩個 span 分別 `scaleX(L/100)` origin left、`scaleX(R/100)` origin right，旁附百分比文字，取代 `trade.css.ts:411` 的 width 轉場）；ProgressBar（委託成交進度、持倉損益條，取代 `orders.css.ts:371`、`account.css.ts:399`）。數值寫在 React `style.transform`（非手勢），減少動態由全域規則取消轉場。

### 6.13 Skeleton、EmptyState

- Skeleton：muted 圓角 6 色塊，opacity 1.2 秒在 .55 與 1 間脈動（減少動態靜止）；容器 `role=status` 並保留視覺隱藏的原文字（如「委託載入中…」「自選清單載入中…」「載入中…」），既有文字斷言不變。
- EmptyState：40px lucide 線條圖示（mutedForeground）＋標題（沿用既有空狀態常數與 data-testid）＋subhead 說明＋一個主要動作（例如自選「搜尋並加入」）。

### 6.14 Pressable 與 primitives（純 CSS，0 KiB JS）

- `main.tsx` 加 `document.addEventListener('touchstart', () => {}, { passive: true })`（iOS Safari 需要文件上有 touchstart 監聽 `:active` 才生效）。
- `pressable`（按鈕）：`&:not(:disabled):active { scale: .97; transition: scale 80ms ease-out }`，放開 `transition: scale 220ms cubic-bezier(.32,.72,0,1)`；實心填色另以 `::after` 黑色 .10 opacity 加深；減少動態時不縮放、只加深。
- `pressableRow`（捲動容器內的列）：`::after` foreground 色、opacity 0；`:active::after { opacity: .08; transition: opacity 0s linear 80ms }`（延後 80ms 才亮，開始捲動時瀏覽器取消 :active 就不會閃），放開 150ms 淡出。
- `srOnly`、`hairlineTop/Bottom`、`focusRing`（2px accent、offset 2px；著色面板與材質上改 foreground）、`fill.{up,down,accent,danger}.{strong,large}`、`island`。

---

## 7. 畫面規格（390×844、字級小、safe-top 47、safe-bottom 34）

### 7.1 殼層

狀態列 91px（不透明）→ 內容（main 捲動，內容從底部 chrome 下方捲過）→ 底部 chrome（交易頁 72px 交易鍵列＋分頁列 83px，同一片 bar 材質，頂端一條髮絲線）。通知：無面板時在底部 chrome 上方 8px；有面板時為狀態列區域內的單行膠囊。任何面板頂端停在 `--sj-sheet-top`（99px），狀態列永遠露出（被暗化）。

### 7.2 自選、排行、搜尋

```
自選                                        (搜尋)(編輯)   ← PageHeader 44
[        自選        |        排行        ]（tabs，regular 44）
商品                                          漲跌幅 ⇅    ← 28，右側為指標切換鍵
2330                              1,085   [ +1.40% ]      ← 列 56（contentBg）
台積電                                                     ← subhead mutedForeground
```

- 列：左 headline 代碼＋subhead 名稱（試撮時名稱旁 amber 框「試撮」）；右 numMd 價格（漲跌色，PriceFlash）＋漲跌膠囊（實心 up／down＋inkStrong 白字 numSm 600，min-width 4.75rem、高 1.75rem、圓角 6；平盤 `elevatedBg`＋foreground）。髮絲線左內縮 16。
- 指標切換鍵（`data-testid="watch-metric-toggle"`，表頭右側，不放在列按鈕內避免巢狀互動）：在「漲跌幅／漲跌／總量」循環，存 localStorage，列的 aria-label 永遠含全部資訊（沿用 `watchlist-page.tsx:243`）。
- 排行：Segmented scroll 變體（tablist 語意不變）；caption「更新於 hh:mm:ss」＋更新 IconButton（冷卻秒數沿用）；列首名次（numSm mutedForeground）；不顯示走勢圖。
- 列表載入：6 列 Skeleton；空清單 EmptyState（Star 圖示、沿用空狀態文字、［搜尋並加入］）；錯誤：InlineNote danger＋［重試］。
- 長按 500ms（沿用）：`haptic('longPress')`，開啟操作面板（ListRow 樣式）：開啟交易頁、**買進…**、**賣出…**（新增，只呼叫 `openTicket({ code, action, source: 'other' })`，之後仍需預覽與滑動確認）、移到最上、上移、下移、從自選移除（danger、沿用兩段式確認與「與桌面共用」說明）。編輯模式列尾 ⋯ 沿用。
- 自選列不顯示迷你走勢（不新增任何 K 線請求）；日內區間條列入第二輪。
- 搜尋面板：large；搜尋框為 body 內 `position: sticky; top: 0` 的 `islandBg` 欄（不模糊）；結果列與自選列同樣式，尾端「加入／已加入」Chip。選做：開啟鍵 handler 內以 `flushSync` 掛載面板後同步 `focus()` 輸入框（iOS 只允許手勢同一呼叫堆疊叫出鍵盤，需實機確認）。

**第二階段實作差異**（以程式碼為準）：

- 排行更新鍵不是純圖示 IconButton，而是 compact 文字鍵，可見文字仍為「⟳ 更新（N）」（`ranking-list.test` 精確比對，§14）。
- 搜尋結果列尾的鍵是原生 button 套用 `ui/chip.css` 的 chip class，不是 `ui/Chip` 元件；文字維持「加入自選／已在自選」，不是上文的「加入／已加入」（`search-sheet.test` 斷言 children 為字串）。
- 操作面板的「從自選移除」用自訂 danger 列按鈕，不是 ListRow（測試以 `data-testid="watch-remove"` 取得 onClick，ListRow 的 testId 掛在外層）。
- 排行列不接表頭的指標切換，固定顯示：漲跌在價格下方、漲跌% 用膠囊（測試要求 `ranking-change` 與 `ranking-pct` 同時存在）。
- 操作面板的「買進…／賣出…」對指數（IND）與組合商品不顯示，比照交易頁的 tradable 判斷（上文沒寫到的防呆）。
- 頁面不套用 `layout.page` 的 16px 內距，改由各區塊自帶左右 16px（PageHeader 已有內距），清單列可延伸到螢幕邊緣。
- 指標切換鍵設 `zIndex: 1`（第二階段後修正）：原本 `::before` 擴張的點擊區下半部被第一列（`position: relative`、DOM 在後）蓋住，實際可點高度不足 44px，點偏下會進入第一檔商品。由 `styles/watchlist-hit-area.test.ts` 覆蓋。
- 未做：選做的 `flushSync` 同步聚焦搜尋框（面板以 transform 進場時聚焦 input，iOS 可能捲動或位移，需實機確認後再加）；開啟後焦點仍在面板標題。
- 待實機確認：iOS／Android 長按觸發與 Android 震動；pressableRow 80ms 延遲加深在快速捲動時不閃；200 列捲動時 PriceFlash 效能；iOS 15.4 面板內 sticky 搜尋框；字級「大」配 360 寬長名稱的列寬；淺色主題捲到底時 main 底部內距區的底色差。總量膠囊的單位沿用桌面（股票視為張、期權為口），需以實際資料確認。

### 7.3 交易頁（含選價列、全螢幕）

```
2330 台積電  上市  [可當沖]                                   24  （h1 文字不變）
1,085  ▲15 (+1.40%)  [漲停][參考價][試撮 1,090]                36  numHero；哨兵在此列下緣
開 1,065  高 1,090  均 1,078.50  總 3.6萬張                     18  統計格 4×2（caption 標籤＋numSm 值）
參 1,070  低 1,060  單 3張       額 392.1億                     18
漲停 1,175 · 跌停 963                                         16  footnote
[走勢|1分|5分|15分|60分|日]（toggle，compact）                  44
圖表（42dvh，min 220、max 520；沿用）
長按圖表選價位（首次才顯示）                     [指標] [全螢幕]   44  Chip；testid 不變
[五檔|明細]（tabs）                         [整股|盤中零股]       44
內外盤比 58%（內盤） ▕████▒▒▏ 42%（外盤）                     24
委買量  買價 │ 賣價  委賣量                                     20
▒▒120  1,084 │ 1,085  88▒▒   × 5 列（每列 44，VolumeBar）
316 ◀ 64%（買） ▕███▒▒▏ （賣）36% ▶ 173                       28
GroupedSection：持倉：現股 3 張 · 均價 1,052.5 · +97,500 ／ 未成交：2 筆 ›
──────── 底部 chrome：[ 買 進 ] 12px [ 賣 出 ]（CONTROL_LARGE）＋分頁列 ────────
```

- 價量全面改系統字 tabular（移除 `trade.css.ts` 9 處 mono）；統計格、標頭文字格式與 data-testid 全部沿用（`trade-price`、`trade-stats`、`trade-stat-*`、`trade-limit`、`trade-simtrade`、`trade-info`、`trade-summary`、`trade-working-link`、`trade-buy`、`trade-sell`）。
- 交易鍵列：以 `ShellSlot slot="bottom"` 放進底部配件槽（測試原地渲染）；實心 up／down＋inkLarge、白字 actionLabel、文字「買 進」「賣 出」不變；組合商品時停用並在上方顯示 InlineNote warn「組合商品不支援手機下單」。
- 精簡標頭（`data-testid="trade-compact"`，不得重用其他 testid）：主價列下緣哨兵以 IntersectionObserver（root＝main）偵測離開時，於 `ShellSlot slot="top"` 顯示 40px **實心** panel＋下緣髮絲線：「2330 台積電」（subhead 600）＋numMd 價格＋numSm 漲跌；opacity＋translateY(−8px→0) 200ms CSS 轉場。沒有 IntersectionObserver（測試）時不顯示。
- 五檔（`depth-ladder.tsx`）：每格加 VolumeBar（從中線往外長）；最佳一檔價 600；自己的委託「我 買2」為 accent 外框小膠囊；點價格格開下單面板只帶價（沿用 `onPick`）；**ticket 變體也顯示內外盤比**（移除 `:139` 的 `ticket ? null :`）；比例條改 RatioBar。整股／盤中零股改 Segmented compact toggle（`depth-odd-toggle` 保留）。
- 選價列（`trade.css.ts:231-264`）：圖表底部、**實心** panel（不模糊）、圓角 12、e2、內距 8：［以 1,080 買進］［以 1,080 賣出］（CONTROL_LARGE、實心＋inkLarge、間距 12）＋「取消」文字鍵 44px；以 translateY(100%→0) 220ms `EASE.sheet` 升起、沿原路收回（減少動態淡入淡出）；文字與 `chart-pick` 不變；只開下單面板。長按進入追蹤時 `haptic('longPress')`。
- 全螢幕（`chart.css.ts:128-219`）：上下列實心 panel（canvas 上方不模糊）；買賣鍵升到 CONTROL_LARGE、間距 12；進出不加動畫（沿用）。
- 明細（`tick-list.tsx`）：列高 2rem、num 樣式、最新一列 150ms 淡入。

**第二階段實作差異**（以程式碼為準）：

- 內嵌五檔顯示內外盤比後，`depth-ladder.test.tsx` 原本「ticket 變體不顯示內外盤比」的斷言與本節衝突，已刪除，改由新增案例驗證「ticket 變體顯示內外盤比」與「沒有內外盤量（或試撮）時仍隱藏」（§14 刻意更新 3）。
- 長按（圖表與自選列）呼叫 `haptic('longPress')`：只在 Android 且使用者開啟「介面觸覺回饋」時震動，iOS 不震（`motion/haptics.ts`）。
- 選價列收回：另渲染一個 `chart-pick-closing` 殘影節點（`aria-hidden`＋`inert`）播放沿原路收回的動畫，`chart-pick` 本身在選完或取消時立即移除，測試與輔助技術不會看到兩份選價列。
- 精簡標頭（`trade-compact`）設 `aria-hidden`：內容與頁面 h1、主價重複，且沒有互動。
- 整股／盤中零股切換仍在五檔區塊內，沒有與「五檔｜明細」同列（與上方示意圖不同）。
- 未做：字級「大」時五檔表頭改縮寫（§4.7）。
- 選價列出現時（非全螢幕）以沒有 transform 的外層 `scrollIntoView({ block: 'nearest' })`，靠 main 的 `scroll-padding-bottom` 停在交易鍵列與分頁列之上（第二階段後修正：小螢幕或開副圖時原本會落在底部 chrome 後面）；減少動態時不平滑。
- 持倉摘要卡的「未成交：N 筆 ›」連結外包一層 `workingLinkRow`（第二階段後修正）：GroupedSection 的列間髮絲線（`card > * + *::after`）與連結 pressableRow 的按壓層原本共用同一個 `::after`，兩者都失效；現在髮絲線落在外層，`::after` 只當按壓層。
- 精簡標頭顯示期間，main 的 `scroll-padding-top` 設為 `SIZE.compactBarH`，隱藏或卸載時移除（第二階段後修正）。原因：遮擋檢查發現 scrollIntoView 或焦點移動會把週期列停在精簡標頭後面。

### 7.4 下單面板（`order-ticket-sheet.tsx`、`ticket/*`、`order-ticket.css.ts`）

使用 `BottomSheet detent="large"`、`tone` 跟方向、`title`＝「2330 台積電」、`dismissible={!busy}`。

```
y=99 ┌ 把手 36×5                                                   ┐ 17
     │ 2330 台積電                                          (X)    │ 44   ← grabArea
     ├──────────── body（捲動；左右 16；區塊間 12）──────────────┤
     │ [送往 永豐 |正式|]  永豐 9A95-***67（證券）(鎖)  [可當沖]       │ 28
     │ ┌ 中性島 ─────────────────────────────────────────────┐ │
     │ │ ▲1,085  ▲+15 +1.40%  快照          單:46　總:36,368 張 │ │ 36
     │ └──────────────────────────────────────────────────────┘ │
     │ [■■■ ✓ 買進 ■■■]       12px       [     賣出     ]           │ 56
     │ [整股|零股]（compact）        [現股 / 盤中 / ROD  ⌄]          │ 44
     │ 價格   快照收盤 ▲1,085                         [限價 ⇅]      │ 20
     │ [－] [            1085             ] [＋]                 │ 44
     │ [買一][賣一][成交][漲停][跌停][平盤]（6 欄兩行）               │ 48
     │ 數量                                      1 張＝1,000 股     │ 20
     │ [－] [              1              ] [＋]   張            │ 44
     │ [ 1 ][ 2 ][ 5 ][ 10 ]                                      │ 36
     │ ┌ 中性島：剩餘交易額度 │ 預估價金；下方交易成本（估）──────┐ │ 72
     │ （提示：信用提醒／資料可能過期／價格可能過期／偏離提醒）        │
     │ 五檔（中性島，含內外盤比）                                    │
     ├──────────── footer（固定，髮絲線）────────────────────────┤
     │ 限價 1,085 × 1 張 ≈ 1,085,000 元（或第一個停用原因）          │ 20
     │ [■■■■■ 預覽買進委託 · 2330 · 1 張 · 限價 1,085 ■■■■■]       │ 56
     └ safe-bottom 34                                              ┘
```

高度預算：large 面板 745px＝把手與標題 61＋footer 134＋body 可視 550；body 至資訊島共 540px，常用路徑與資訊雙欄不必捲動，五檔在下方；字級標準／大時 body 捲動、footer 固定。

規格：
1. **第一列**：RouteBadge；`data-testid="ticket-account"` 的帳戶文字（保留 `永豐 9A95-0123456（證券）` 格式，可去掉前綴「帳戶　」）；Lock 圖示 IconButton（aria-label「帳戶已固定，說明」）切換一行 InlineNote info「面板開啟期間不能切換帳戶；要換帳戶請關閉面板後到「帳戶」頁。」（取代常駐兩行 `:192`）；`ticket-daytrade-tag`（文字沿用 `dayTradeTag()`）。列可換行。沒有帳戶時 InlineNote warn 顯示既有文字。
2. **精簡報價**（`ticket-quote-row.tsx`）：放進中性島；**移除重複的商品名**（`:34`）；`ticket-quote-price`、`ticket-quote-change`、`ticket-quote-volume` 文字格式不變（`'單:46　總:36,368 張'`）；價格 1.1875rem/700 漲跌色（大字）。
3. **方向**：DirectionToggle（§6.8）；移除 26px 大字列，`data-testid="ticket-direction"` 改為 `srOnly` 的 `<p aria-live="polite">`，文字不變（「買進」「融資買進」「請選擇買進或賣出」…）。方向四重呈現：面板著色、3px 方向色條、選中鍵實心＋Check、CTA 完整動作文字。
4. **單位與條件**：同列（`grid 1fr 1fr`、gap 8）：整股／零股 Segmented compact toggle；條件摘要鈕（`ticket-cond-summary`、文字沿用 `conditionSummary()`、aria-expanded、ChevronDown 旋轉 200ms）。展開區（`ticket-cond-panel`）在 `islandBg` 中性島內：信用、時段、效期三組 Segmented toggle（各組下方 footnote 寫停用原因並 aria-describedby）、現股當沖先賣切換（沿用 `ticket-daytrade`）；展開／收合高度立即改變、內容 150ms 淡入（不做高度動畫）。期權改為倉別（4 段）與效期兩組。
5. **價格**：標籤列「價格」（footnote 500 foreground）＋`ticket-live-price`（文字不變；數字 foreground、▲▼ 用漲跌色，§4.8 規則 8）＋右側 PopUpButton 價別（`ticket-price-type`）；Stepper（`ticket-price`、`inputMode=decimal`；`atMax = limit_up>0 && price>=limit_up` 文字「已到漲停」、`atMin` 同理「已到跌停」；市價時 stepDisabled）；`ticket-price-source` 提示、tickWarn（role=alert）、`ticket-price-stale`（「使用此價格」）改 InlineNote。**限價偏離提醒**：限價且最新價來源為真實成交時，`|限價 − 成交| / 成交` 超過股票 3%、期權 1.5%（常數 `PRICE_DEVIATION_WARN`）顯示 footnote「偏離成交價 +4.2%」（amber 條＋foreground，`data-testid="ticket-deviation"`），只提醒、不阻擋、不改價。
6. **快捷價**：QuickChips 6 欄兩行（標籤＋`data-price`），aria-label 沿用 `${label} ${price}`／`${label}（無資料）`；點選呼叫既有 `t.pickPrice()` 並遞增 Stepper `flashKey`；五檔點價同樣遞增。
7. **數量**：標籤列「數量」＋右側 footnote「1 張＝1,000 股」（零股「以股計（1～999 股）」）；Stepper（`ticket-qty`、`inputMode=numeric`，aria-label `數量（張）` 沿用；`atMin = qty<=1`「已達最小數量」、`atMax = qty>=上限`「已達單筆上限」）；單位字放輸入框右側；預設 4 欄 Chip。
8. **資訊**：`ticket-info.tsx` 的 `ticket-limit`、`ticket-estimate`、`ticket-cost` 放進同一中性島兩欄（footnote mutedForeground 標籤、numMd 值、備註 footnote）。
9. **提示卡**：信用提醒（`ticket-credit-hint`、「改用融券（回補）」鍵）、資料可能過期勾選（`ticket-stale-ack`，44px）＋重試，全部 InlineNote warn。
10. **footer（SheetFooter）**：狀態行優先序：`ticket-feedback`（not-sent：role=alert、danger XCircle＋foreground；cancelled：foreground）→ `ticket-problem`（role=status，文字仍為「⚠ ＋原因」，前方 3px amber 條）→ 摘要 `ticket-summary`「限價 1,085 × 1 張 ≈ 1,085,000 元」（期權「名目 … 元」；金額經 `maskMoney`）。CTA `ticket-preview`：可見文字**恰為** `t.previewText`（`order-ticket-sheet.test.tsx:467、667` 精確比對）或「送出中…」（前方 CSS 轉環，減少動態靜止）；1.1875rem/700、可換兩行、min-height CONTROL_LARGE、圓角 12；有方向時 tone 實心＋inkLarge，未選方向時 `islandBg`＋borderBright＋foreground「請先選擇買進或賣出」並停用；按下時先 `blur()` 目前聚焦的輸入框，再呼叫既有 `t.submit()`。
11. **內嵌五檔**：footnote 標題「五檔」＋中性島內 DepthLadder ticket 變體（含內外盤比）；盤後零股沿用 `ticket-no-depth` 文字。
12. **送出中**：所有控制停用（沿用）、關閉鈕隱藏（`order-ticket-sheet.test.tsx:654`）、面板只能輕彈；確認面板疊上時本面板縮小並變暗，取消後回原狀、欄位保留、狀態行顯示「已取消」。
13. **退場**：BottomSheet 凍結 children 期間，TicketForm 仍掛載；`use-mobile-ticket.ts` 的回饋判斷改為 `alive = mounted.current && !presence.isExiting()`（`SheetPresenceContext` 以 ref getter 提供），退場中的「未送出」改走 `notify`，與卸載後一致（§10 S4 測試）。
14. **第一列的鎖說明鍵**（第二階段後修正）：IconButton 以負外距不撐高第一列，但第一列緊貼面板 body 頂端，body 又是上內距 0 的捲動容器，往上超出的約 8px 會被裁掉、落在拖曳區，實際可點高度不足 44px。現在 `metaRow` 以同一個 `LOCK_OVERHANG` 當上內距讓出這段（`styles/order-ticket-hit-area.test.ts`）。

### 7.5 確認面板與其他確認類面板

**OrderConfirmSheet**（`order-confirm-sheet.tsx`、`order-confirm.css.ts`）：`BottomSheet detent="fit" layer="confirm"`、tone 依 `request.action`、`footer` 放滑塊與取消。

```
把手／委託確認                                              (X)＝取消
[■■■■■■■■■■■■■■  正式環境  ■■■■■■■■■■■■■■]   envBanner，全寬實心
融資買進  台積電 2330                                          confirmAction 方向色（大字）＋sheetTitle 名稱＋subhead 代碼（foreground）
┌ 中性島 ──────────────────────────────────────────────┐
│ 價格                                           1,085 │  ValueRow
│ 最新成交價（有 livePriceCode 時）     (!) 行情中斷     │  amber 圖示＋foreground
│ 數量                                           1 張  │
│ 帳戶                                 永豐 9A95-***67  │  privacyAccountLabel
└──────────────────────────────────────────────────────┘
備註（confirm-note，footnote foreground）
── footer ──────────────────────────────────────────────
( >> )        滑動確認 融資買進 2330                    56   SlideToConfirm（tone、armDelayMs 300）
按住把手向右滑到底後放開以確認（或停用原因）
[                         取消                        ]  44
```

- 環境橫幅（`confirm-env`，文字仍為 `confirmEnvText()`）放在 BottomSheet 的 `pinned` 固定區（§6.1），body 捲動時仍在標題下方：正式 danger＋inkLarge 白字＋ShieldAlert；模擬 accent＋inkLarge 白字；未確認 amber 實心＋黑字。取代原本 1.5rem/800 外框字。
- 不另外計算任何數值，只呈現 `OrderConfirmRequest` 既有欄位（沿用）；`confirmBlockReason`、`confirmActionText`、`CONFIRM_TEXT`、ResumeGate 自動取消與通知全部不變。
- **退場**：host 以 `lastEntryRef` 快取最後一筆，`shown = current ?? lastEntryRef.current`；`<BottomSheet open={current !== null}>` 用 `shown` 的內容；`open` 為假時滑塊 `disabled`。`onExited` 後清空快取。`approve()`、`cancel()` 的 entry id 與 `approvedIds` 檢查原封不動（第二道防線）。同步模式下關閉即卸載，既有 `sheetOpen()` 類斷言不變。
- 核准後立即沿原路退場（lib 已清空 pending）；送出進度與結果回到下單面板 CTA 與通知，不讓確認面板停留等待 lib。
- 取消：取消鈕、X、點暗化幕、下拉、Esc 全部只呼叫既有 `cancel()`。

**委託操作面板**（`order-action-sheet.tsx`，樣式改用新檔 `styles/order-action.css.ts`，`orders.css.ts` 本塊不動）：流程不變（選單 → 改價／減量／刪單子畫面 → 滑動確認）。頂部 GroupedSection 摘要（方向小膠囊、條件、ProgressBar 成交進度沿用 aria-label、路由、時間、書號）；選單為 ListRow（Pencil「改價」、Minus「減量」、Trash2「刪單」danger；按鈕文字恰為動作名；不可用原因放按鈕外）；子畫面用 Stepper（aria-label「新的委託價格」「新的剩餘數量（張）」沿用）＋footer SlideToConfirm（改價、減量 neutral；刪單 danger；label 文字沿用）＋「返回」文字鍵。`kind` 為 price／qty／cancel 時直接進入對應子畫面（沿用 `openOrderAction(tradeId, kind)`）。

**全部刪單、刪除已選、平倉說明、解除鎖單**：沿用各自內容與流程，換成 GroupedSection／InlineNote／footer 滑塊版型；送出中 `dismissible=false` 只輕彈；批次進度以 aria-live 宣告（沿用文字）。

### 7.6 委託（`orders-page.tsx`、`order-detail-sheet.tsx`、`orders.css.ts`）

```
委託                                        [⟳ 更新]       ← PageHeader；可見文字維持「⟳ 更新（N）」
[未成交 3|已成交|全部|成交]（tabs，testid orders-tab-* 不變）
[帳戶：全部 ⇅]（PopUpButton，orders-account）     點委託列查看明細 [選取]   ← orders-select-toolbar
InlineNote warn：待對帳…［對帳］（orders-reconcile）
(買) 2330 台積電                                  限價 1,080   ← 方向小膠囊實心＋inkStrong
整股 · 現股 · ROD · 送往 永豐 正式 · 09:12:03                   ← subhead mutedForeground
▕██░░▏ 成交 1／2 張 · 剩 1                    [部分成交]        ← ProgressBar＋狀態外框膠囊（foreground 文字）
[改價] [減量] [刪單]                                           ← 只在未成交；與列按鈕為兄弟節點
[            全部刪單（3 筆）            ]                      ← 列表尾端 danger 框，不黏住
```

- 列上動作 Chip（`order-row-price`、`order-row-qty`、`order-row-cancel`）只呼叫 `openOrderAction(id, 'price'|'qty'|'cancel')`；改價、減量受既有閘門停用規則，刪單不受限（沿用）。
- 選取模式：勾選圈 44px、列內容右移；`orders-select-toolbar`（已選 N 筆、全選／全不選、完成）與「刪除已選（N 筆）」（`orders-cancel-selected`）以 `ShellSlot slot="bottom"` 放在分頁列上方（測試原地渲染）；按下開批次刪單面板（仍需滑動確認）。切分頁或帳戶清除選取（沿用）。
- 成交分頁：精簡列＋尾端合計 GroupedSection（遮蔽沿用）。載入 Skeleton（保留「委託載入中…」）；空狀態 EmptyState（`orders-empty` 文字沿用）。
- 明細面板：large、GroupedSection＋成交時間軸（圓點＋細線）。

### 7.7 持倉（`positions-page.tsx`、`position-summary.tsx`、`position-esun-details.tsx`、`positions.css.ts`）

- 頁首 PageHeader「持倉」＋⟳（6 秒冷卻沿用）；分組型頁面底色。
- 摘要卡（GroupedSection）：caption「未實現損益合計（估）」＋numHero（漲跌色、正負號、PriceFlash、遮蔽時不閃）；下方雙欄股票市值、期貨權益數與風險指標（RatioBar＋等級文字＋狀態色）。
- Segmented toggle［全部｜股票｜期貨｜選擇權］；PopUpButton 帳戶、排序；對帳／ResumeGateNote 用 InlineNote。
- 依帳戶分組：footnote 組標頭（沿用文字）＋GroupedSection；每筆：代碼名稱、條件小膠囊、「多／空 N 張」（實心＋inkStrong）、損益 numMd；第二行均價、現價、報酬率 numSm；股票第三行昨餘、成本、市值（testid 沿用）；損益條改 `transform: scaleX(r)`（中線為 0 往兩側）；動作列［平倉］（**中性外框樣式**，避免與新單買賣鍵混淆）［加碼］［看圖 ›］與玉山「庫存明細」（立即展開＋150ms 淡入）。
- 平倉流程不變（說明面板 → lib 確認面板 → 滑動確認）；加碼跨帳戶先開切換說明面板（沿用）。
- 測試：`positions-page.test.tsx:450-451` 由 `style.width === '50%'` 改為 `style.transform === 'scaleX(0.5)'`（唯一必要的斷言更新之一，§14）。

**第二階段實作差異**（§7.6、§7.7，以程式碼為準）：

- 列上 Chip 的 testid 仍是 `order-price-button`、`order-qty-button`、`order-cancel-button`，不是上文的 `order-row-*`（所有 testid 不變，既有測試依賴）。
- 委託列「三行版型」：OrderLines 的結構屬於 `order-action-sheet.tsx`（B3a），不改結構，只用 `orders.css.ts` 的 class 調整外觀（方向膠囊以 CSS `order` 排最前、狀態膠囊靠右）。有券商訊息、已取消量或路由時仍會多出第 4、5 行；同一份樣式也套用到委託操作面板的摘要。
- 「刪除已選」用 danger 外框而非實心，避免在台灣配色下與紅色買進鍵混淆。
- 委託頁的更新鍵保留文字「⟳ 更新（N）」（精確文字測試）；持倉頁的 ⟳ 改用 IconButton（RotateCw），aria-label、testid 與「請按「⟳」」說明文字不變。
- 兩頁都改用自己的 page class（左右內距 0，邊距由 PageHeader、GroupedSection 與各區塊自帶 16px＋安全區），不再用 `layout.page`，避免邊距疊成兩倍。
- 持倉風險指標用 ProgressBar（滿格 300%，100% 危險線約在三分之一），不是 RatioBar：只有一個數值、沒有左右兩段。等級文字保留，數值文字改為 foreground。
- 持倉組標頭的損益小計改 foreground 加正負號，不用漲跌色（§4.8 規則 9：頁面底色上不放漲跌色小字）。
- 平倉說明與切換帳戶面板仍是 `{closeKey !== null && <CloseSheet open />}` 條件掛載，沒有退場動畫；改成常駐 `open={…}` 會在退場期間凍結內容，屬於行為變更，本階段只改樣式。
- 平倉、全部刪單、批次刪單面板的版面改為滑塊與取消放 SheetFooter、回饋改 InlineNote；送出函式、閘門、busy／resetKey 與結果未知處理不變。
- 委託明細面板依上文設為 `detent="large"`，內容少時面板也撐到最大高度。
- `orders.css.ts` 中舊委託操作面板的樣式（改用 `order-action.css.ts` 後已無引用）與未使用的 `warn` 已在 B4 刪除。
- 待實機確認：選取工具列在 bar 材質上的可讀性與 `--sj-accessory-h` 讓出的空間、面板開啟時材質轉實心、iOS 15.4 的 `accent-color` 勾選框（更舊版本顯示預設樣式）、三種字級下時間軸圓點對齊、字級「大」時持倉列與摘要卡改欄、持倉損益合計 PriceFlash 不過度閃爍。

### 7.8 帳戶與 HTTPS 說明頁

- 帳戶頁維持同一頁的區塊順序（`account-page.tsx:45-57`），不改讀取與刷新時機；`account-ui.tsx` 的 `Card`、`CollapsibleCard`、`Item`、`Switch`、`Segmented` 改為 GroupedSection 外觀（標題移到卡片外 footnote、資訊列 ≥44px、髮絲分隔），props 與 testId 不變；CollapsibleCard 展開立即、內容 150ms 淡入、chevron 旋轉；Switch 拇指改 `transform: translateX`（取代 `account.css.ts:189` 的 left 轉場）。
- 顯示區（`display-card.tsx`）新增「降低透明度：跟隨系統／開／關」Segmented（寫 `ui-settings.transparency`，立即改寫 html 屬性）。本裝置區（`device-settings-section.tsx`）新增「介面觸覺回饋（Android）」Switch（`ui-settings.uiHaptics`）。風控區註腳「此鎖定只對本裝置有效」沿用。
- HTTPS 說明頁（`secure-context-gate.tsx`、`gate.css.ts`）：仍不建立任何連線；頁面 `overflow-x: hidden`、`overflow-wrap: anywhere`；診斷表 `grid-template-columns: auto minmax(0, 1fr)`；網址與診斷值保留 `SELECTABLE`（已用於 `secure-context-gate.tsx` 與 `diagnostics-card.tsx`）；步驟改編號卡；靜態、無材質、無動畫。裁切原因以 390 寬行動模擬 @2x 重拍確認。

**第二階段實作差異**（以程式碼為準）：

- CollapsibleCard 的標題放在卡片內第一列（整列可點、≥44px、headline 字級、chevron 在右側旋轉），不是移到卡片外的 footnote：已實現損益、玉山帳務概覽、預收／圈存預設收合，標題在卡片外時收合後只剩一行孤立的灰色小字。Card 的標題仍依上文放在卡片外 footnote。
- Switch 開啟色由 success（綠）改為 accent（§4.8 規則 5：accent 用於開關，綠色留給 LIVE 等狀態）。
- Item 的 warn 色調改為 foreground 文字＋amber 圖示，不再用 amber 文字（§4.8 規則 4、§6.11）；warning、badgeWarn、confirmWarn 同樣改為 foreground 文字，amber 只留給左側條與框線。
- 期貨風險指標條與流量條改用 ProgressBar（scaleX，§6.12）；上文沒有列出，但原本的 width 轉場違反「只動畫 transform／opacity」。
- 展開鍵所在列（持倉明細、玉山明細等）文字色由 mutedForeground 改為 accent，提示可點（§4.8 規則 5）。
- HTTPS 說明頁診斷表的值改為靠左對齊（UA、來源等長值換行後較好讀）；區網提示文字與 SELECTABLE 不變。
- `account-page.tsx` 未改：區塊順序與讀取時機原本就符合本節。
- 待實機確認：390 寬 @2x 有無水平溢出；字級「大」時漲跌配色分段（「台灣（紅漲綠跌）」「國際（綠漲紅跌）」）可能放不下（`ui/segmented` 為 nowrap 且不裁切）；淺色主題 smallButton 只靠 e1 陰影分界的對比；dt／dd 固定行高後多行值與標籤頂端對齊的觀感。

---

## 8. 手勢歸屬與放手計算

| 區域 | 歸屬 | 規則 |
|---|---|---|
| 面板把手與標題區 | 面板 | 垂直 1:1；起點符合 `DRAG_EXCLUDE_SELECTOR` 不拖；放手用 `sheetReleaseDecision` |
| 面板內容區 | 原生捲動 | 本輪不接手下拉（第二輪需實機原型） |
| 滑塊把手 | 滑塊 | `touch-action: none`＋pointer capture；面板永遠不接手 |
| 圖表（`data-allow-pinch`） | lightweight-charts | 水平平移、雙指縮放、長按 450ms 選價；垂直滑動捲頁；其他區域的雙指一律由 gesture-guard 擋（不變） |
| 清單列 | 列 | 點擊、長按 500ms（移動 >10px 取消，沿用）；垂直為捲動 |
| 通知 | 通知 | 垂直往錨點邊緣拖曳；`toastRelease` |
| 步進鍵 | 步進鍵 | 點擊一步；按住連續 |
| 全站 | — | 不設計雙擊手勢；維持 `touch-action: manipulation` |

放手公式：
- 面板：見 §6.1；`project(v, .99) = v × 0.099`；dismissible=false 永遠 `stay`。
- 通知：`projected = offset + project(v, .998)`；底部模式 `projected > 40 || v >= 500` 離場；頂部模式 `projected < −40 || v <= −500` 離場。
- 滑塊：只看 `slideReached(final)`；速度只作回彈初速。
- 每個「放手」都以速度正負號判斷使用者往哪走；送出門檻永遠不看速度。

---

## 9. 減少動態、降低透明度、提高對比

**減少動態（`prefers-reduced-motion: reduce`）**：
- 保留 `layout.css.ts:52-60` 全域保底規則（animation／transition 0.01ms）。
- JS 驅動：面板、通知改 `animateTween` 150ms 淡入淡出，不位移、不縮放；堆疊下層只加暗；拖曳仍 1:1，放手直接定位；滑塊回 0 瞬間完成，但**仍必須實際滑到 ≥80%**（安全規則不變）。
- 關閉：跳價閃爍、骨架脈動、同步中轉環、按壓縮放（保留加深）、步進撞界橫移（保留文字）、選價列位移（改淡入）。分段拇指、精簡標頭、著色交叉淡化由全域規則變為瞬間。

**降低透明度**：`html[data-sj-transparency="reduced"]`（App 內開關或低階 Android 預設）或系統 `prefers-reduced-transparency: reduce`（屬性非 full 時）→ 所有材質實心、`backdrop-filter: none`。

**提高對比（`prefers-contrast: more`）**：材質實心＋1px borderBright；髮絲線改 1px borderBright；方向著色只疊一層；分段 accent 環改 2px；焦點環 3px。

---

## 10. 交易安全不變式（每條都要有自動化測試）

| # | 不變式 | 自動化測試 |
|---|---|---|
| S1 | 送出只有一條路：新單＝預覽 → `requestOrderConfirm()` 確認面板滑動；改價／減量／刪單／全部刪單／批次刪單＝各自面板滑動；平倉＝說明 → lib 確認面板滑動；解除鎖單＝滑動。所有新入口只呼叫 `openTicket`／`openOrderAction`／開說明面板 | mock `src/lib` 的送單、改單、刪單函式：自選操作面板「買進…／賣出…」、列上改價／減量／刪單 Chip、五檔點價、圖表選價、持倉加碼 → 只呼叫 openTicket／openOrderAction，lib 送出函式呼叫次數 0 |
| S2 | 門檻只看放手位置；armDelay；中止條件 | 0.7 高速甩動（帶 timeStamp）放手 → 不送；越過 0.8 退到 0.75 放手 → 不送；未就緒期間 pointerdown 無效（以 `SheetPresenceContext` 提供 `settled:false` 並 stub 時鐘）；lostpointercapture、visibility hidden、presence 退場 → 歸零不送；既有 8 個案例不改 |
| S3 | 手勢互不干擾 | 面板 grabArea 起點為 `[role=slider]`、input、button 時不拖；拖曳後 350ms 內 click 被攔下 |
| S4 | 退場凍結 | 以 `createNodeMock` 提供 `{ style:{}, isConnected:true, getBoundingClientRect }` 並注入假時鐘：確認面板核准後 → panel testId 為 `order-confirm-sheet-closing`、`aria-hidden`、`inert`、滑塊 disabled、再觸發 onConfirm 不會第二次 `resolveOrderConfirm(true)`；退場中新請求到達 → 新 entry id、滑塊重置、armDelay 重新計時；use-mobile-ticket 在 presence 退場中遇到 not-sent → `notify` 而非 setFeedback |
| S5 | 不可關閉就真的關不掉 | dismissible=false：grab pointerdown＋pointerup、點暗化幕、Esc（sheet-stack）、關閉鈕皆不呼叫 onClose；既有 T6 四案不改 |
| S6 | 方向與環境一定看得到 | ticket：`data-tone`、`ticket-direction` 文字、方向鍵 aria-pressed、CTA 文字同步；RouteBadge 在第一列；確認面板 `confirm-env`；面板 max-height 不超過 `--sj-sheet-top`；有面板時通知為頂部精簡模式 |
| S7 | 顏色規則 | 靜態檢查：`src/mobile` 不出現 `wickUp`、`wickDown`、`flash-up`、`flash-down`、`fontWeight: 800`、漲跌 hex；§4.8 對比表以單元測試重算（ink 後 ≥ 門檻） |
| S8 | 結果未知 | 不提供重送鍵（沿用 `order-ticket-sheet.test.tsx:643`）；warn 在疊放中為前景、淘汰時最後被淘汰、按住暫停 TTL；needsReconcile 時委託分頁有 amber 點 |
| S9 | 不擴張範圍 | 程式審查清單：無一鍵下單、圖上拖曳改價、價格拖曳、觸價／括號／條件單、批次市價平倉、背景執行、標頭滑動換商品、列滑到底執行 |

---

## 11. 無障礙

- 觸控：所有可點元素 ≥ `max(44px, 2.75rem)`；compact 元件以擴大點擊區達成且不重疊；買賣相關鍵 ≥56px、間距 12px。
- 字級：全部 rem；三檔字級逐頁驗收不截斷；大字級版面切換由 `html[data-sj-font-scale]` 控制。
- 焦點：焦點環 2px accent offset 2px（著色面板與材質上 foreground）；面板 `role=dialog`、`aria-modal`、`aria-labelledby`，焦點移入、Tab 循環、關閉還原；背景 inert＋aria-hidden。
- 宣告：即時價格不放 aria-live；只宣告方向動作（ticket-direction）、鎖單變化、連線狀態（2 秒去抖）、停用原因、批次進度；通知沿用 alert／status。
- 手勢皆有按鈕等價物：長按操作面板 ↔ 編輯模式「更多操作」鈕；滑塊 ↔ 鍵盤（與 AT 後備）；通知滑走 ↔ 關閉鈕。
- 不只靠顏色：▲▼、正負號、買／賣、多／空、正式／模擬文字；選取有拇指位置、Check 與 aria 狀態。
- 縮放與選取：頁面仍禁止手勢縮放與選取，輸入框、`SELECTABLE` 與診斷值例外；圖表可雙指縮放。

---

## 12. 相容性（iOS／iPadOS 15.4+ Safari、Android Chrome 最新兩版）

| 需求 | 寫法 |
|---|---|
| 半透明材質 | 透明元素＋`isolation:isolate`＋`::before` 以 opacity 疊 vars 底色；`WebkitBackdropFilter` 與 `backdropFilter` 並寫（Safari 18 前只認前綴）；`@supports not (…)` 後備實心 |
| 疊色 | 多層 `linear-gradient`（不用 color-mix）；`rgba(0,0,0,var(--x))` 可在 15.4 使用 |
| 緩動 | JS 彈簧＋`cubic-bezier`（不用 linear()） |
| 依內容切版 | `html[data-sj-font-scale]`、`data-*`（不用 :has()、容器查詢） |
| inert | 15.5 起；15.4 同設 aria-hidden＋焦點循環 |
| overscroll-behavior | 16 起；不依賴（面板不接手內容下拉） |
| prefers-reduced-transparency | iOS Safari 不支援 → App 內開關 |
| Vibration API | iOS 無 → 視覺回饋 |
| 個別 transform 屬性 `scale` | Safari 14.1、Chrome 104 起 |
| 其他可用 | `dvh`、`:focus-visible`、`scrollTo({behavior:'smooth'})`（15.4）、Pointer Events＋setPointerCapture、ResizeObserver、IntersectionObserver、visualViewport、`Element.animate`、`env(safe-area-inset-*)`、`max()`、`content: attr()` |
| 建置 | `vite.config.ts` target `['es2020','safari13']` 不變；新程式只用 ES2020 |
| 寬度 | 以 390 設計，360–430 驗收；≥700px 面板置中最大 640px（沿用） |

已知風險：Safari 對做 transform 動畫中的圓角 backdrop-filter 元素可能暫時畫成直角（通知）；必要時動畫期間 `::before` opacity 1、靜止後恢復。

---

## 13. 效能與體積預算

- 只動畫 transform／opacity；手勢與彈簧在同一 rAF 迴圈直接寫 style，拖曳中不 setState（滑塊只在跨 5% 與門檻時更新語意 state）；will-change 只在動畫期間。
- 模糊層：底部 chrome 一片＋通知；面板開啟時 chrome 實心；canvas 上方與 sticky 列不模糊。
- 即時資料節流沿用：行情 50ms 合併、自選列 100ms、圖表 100ms；PriceFlash 同格 ≥350ms、只閃可見格；量條 120ms scaleX。
- 不新增任何網路請求（不做迷你走勢）。
- 低階 Android 預設降低透明度；Chrome DevTools 4× CPU 降速下面板拖曳、滑塊、自選 200 列捲動 p95 幀時間 ≤16.7ms、無 >50ms long task；實機 30 分鐘記憶體不持續成長。
- 首屏 JS（gzip）增量估計：spring＋tween 0.9、gesture 0.9、prefs／haptics／ui-settings 0.5、sheet-stack＋sheet-context 0.5、BottomSheet v2 增量 2.0、SlideToConfirm v2 增量 0.6、ToastHost v2 增量 0.9、殼層（slots、捲動記憶、html 屬性、狀態列）0.9、Segmented＋IconButton＋PageHeader 0.7、新增 lucide 圖示約 9 個 1.5 → **合計約 9.4 KiB**（目標首屏 ≤218 KiB，上限增量 10 KiB）。Stepper、DirectionToggle、QuickChips、PopUpButton、Grouped、InlineNote 等落在既有 lazy chunk。CSS（gzip）增量 ≤12 KiB。
- 量測：`pnpm exec vite build --config vite.fork.config.ts` 後依規格 §9.4 加總 `dist/mobile.html` 引用的 script 與 modulepreload gzip 大小，PR 附前後數字。
- **實測（第二階段後）**：手機首屏 JS（gzip）**226.3 KiB**，超出本節目標 ≤218 KiB 約 8 KiB；仍在硬性上限 400 KB 內（規格 §9.4）。**待辦**：找出超出目標的增量來源（逐 chunk 比對第一階段前後的建置），能延後載入的移到 lazy chunk；若確認無法壓回，需由使用者決定是否放寬目標。

---

## 14. 既有測試相容表

| 測試 | 要求 | 本規格的對應 |
|---|---|---|
| `bottom-sheet.test.tsx`（T6 四案） | 拖曳中 `panel().props.style` 精確為 `{ transform: 'translateY(90px)' }`、取消後 undefined | §6.1 測試後備位移；斷言不改 |
| `slide-to-confirm.test.tsx` | 直接呼叫 handle 的 React props；aria-valuenow；鍵盤規則 | §5.2 回傳 React props、§6.3 保留全部 |
| `order-confirm-sheet.test.tsx` | 關閉後立即不存在 | 同步模式立即卸載 |
| `order-ticket-sheet.test.tsx` | `ticket-direction` 文字、`ticket-preview` 精確文字、`btn('買進')`、`btn('＋')`、`btn('成交')` 精確文字與 aria-label、`props.disabled`、`aria-pressed`、`ticket-quote-*` 格式、`ticket-account` 包含字串、送出中無「關閉」 | §6.7–§6.10、§7.4 全部保留 |
| `order-action-sheet.test.tsx`、`orders-page.test.tsx` | `n.type === BottomSheet`；aria-label「價格加一檔」；`'⟳ 更新（6）'` 精確文字；各 testid | 元件識別與文字保留 |
| `trade-chart.test.tsx` | stub rAF；`chart-pick`、`chart-indicators`、`chart-fs-enter`；委託線標籤 `style.top` | §5.1 同步模式看節點；圖表邏輯不動 |
| `status-bar.test.tsx` | 路由文字 toContain | 文字保留 |
| `app.test.tsx` | `mobile-shell`、`mobile-tab-bar` 等存在；mock BottomSheet | 結構可改、testid 保留；ResizeObserver 等需守衛 |
| **刻意更新 1** `toast-host.test.tsx:24` | 以 `button` 找通知 | 改為 `n.props['data-testid'] === 'toast-item'`；className、role、第一個 span 為標題、內文、DOM 順序斷言不變 |
| **刻意更新 2** `positions-page.test.tsx:451` | `style.width === '50%'` | 改 `style.transform === 'scaleX(0.5)'` |
| **刻意更新 3** `depth-ladder.test.tsx`（第二階段） | 「ticket 變體不顯示內外盤比」 | 與 §7.3「ticket 變體也顯示內外盤比」衝突，刪除該斷言；改由新增案例驗證 ticket 變體顯示內外盤比（aria-label 文字標示內盤／外盤）、沒有內外盤量或試撮時仍隱藏 |
| **刻意更新 4** `styles/primitives.test.ts`（B4） | `controls.routeBadge` 的鍵為 production／simulation／unknown | 舊 `routeBadge` 匯出已無引用並刪除（樣式在 `route-badge.css.ts`，§6.5），刪除該斷言；button、tradeButton、滑塊的斷言不變 |

其他測試不得降低斷言；新增測試見 §10 與各區塊。

---

## 15. 實作區塊、順序與分派

依 CLAUDE.md：B1-*、B3a 涉及手勢與交易確認，由主代理（或 opus 實作）完成並交 deep-reviewer 覆核安全不變式；B0、B2、B3b–e 為範圍明確的工程任務交 code-worker；檔案定位與截圖清單蒐集可用 fast-reader，判讀由主代理。每個區塊結束都要 `pnpm test` 全綠與對應截圖。

```
B0-tokens ─┐
B0-motion ─┼─ B0-ui ─┬─ B2-shell（inert 開關待 B1-sheet）──────────────┐
           │         │                                                 │
           └─ B1-sheet → B1-slide → B1-confirm → B3a-order-entry → G1 ─┼─ B3b／B3c／B3d／B3e（平行）→ B4
              B1-toast（B0 後即可平行）                                  │
```

- **G1 使用者審閱關卡**（B3a 完成後）：提供 390×844 @2x 截圖組（四主題 × 下單面板買進／賣出／未選方向／條件展開、確認面板正式／模擬／未確認、狀態列四種狀態、底部 chrome 材質）與一段實機錄影（面板開關、滑塊、通知），請使用者確認：inkLarge／inkStrong 造成的紅綠深淺、方向鍵形式、雙層整面著色＋中性島、實心漲跌膠囊、通知雙錨點。通過後才做 B3b–B3e 的視覺定稿。
- **AT 關卡**（B1-slide 合併前）：§6.3。
- 每塊的檔案、相依與範圍見結構化輸出 implementation_blocks。

---

## 16. 風險與待驗證

1. VoiceOver／TalkBack 操作自訂滑塊（§6.3 關卡）。
2. iOS 15.4 的 aria-modal 與 aria-hidden 後備能否把 VoiceOver 焦點限制在面板內。
3. visualViewport 鍵盤高度在 iOS 15／16／17／18 的偏移差異（後備見 §6.1）。
4. 圓角 backdrop-filter 在 transform 動畫中的渲染（通知）。
5. 低階 Android 模糊成本；降低透明度預設啟發式是否誤判。
6. portal 後 React 事件冒泡：backdrop 已攔 click／pointerdown；需確認沒有頁面依賴面板事件冒泡到祖先。
7. 捲動記憶與 Suspense 首次載入的時序（單元測試＋實機）。
8. gesture-guard 只在 WebKit 安裝 touchmove（B4，實機確認 Android 遵守 user-scalable=no 後才改，並更新 `gesture-guard.test.ts`）。
9. 淺色綠對白 4.34（theme 層級，另案）。
10. 通知雙錨點的使用者接受度（G1）。
11. 面板退場期間 TicketForm 多存活約 0.3–0.5 秒仍訂閱行情：無副作用，但 `onBusyChange(false)` 須在真正卸載時呼叫（沿用 `order-ticket-sheet.tsx:116`）。
12. 首屏 JS（gzip）第二階段後為 226.3 KiB，超出目標 ≤218 KiB 約 8 KiB（§13 待辦）。
13. 第二階段各畫面的實機項目（§7.2、§7.7、§7.8 的「待實機確認」，以及 §7.3 的長按震動與選價列捲動）尚未驗收；實機驗收清單見規格 §14.3。

---

## 17. 第二輪候選與不做清單

**第二輪候選（需各自原型與實機驗證）**：面板內容捲到頂再下拉接手（非被動 touchmove，只在 10px 門檻內且 cancelable 時 preventDefault）；長按 ContextMenu（只開面板）；FLIP 版面動畫；交易頁 ☆ 加入自選；自選列日內區間條（`src/lib/day-range.ts`，不發請求）；委託與持倉下拉更新（僅 iOS 16＋與 Chrome，受 6 秒冷卻）；列水平滑動揭示按鈕（不做滑到底執行）。

**不做**：一鍵／閃電下單、圖上拖曳改價、價格拖曳調整（scrub）、觸價／括號／條件單、批次市價平倉、背景執行、交易頁標頭左右滑切換商品、列滑到底直接執行、預設逐列迷你走勢、修改 `src/lib` 交易邏輯或確認佇列、修改 theme 色票、修改 mobile.html。
