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
6. 自選列無限制地逐列 `fetchKbars` 迷你走勢（P2，`src/components/sparkline.tsx:8-47`，抵觸規格 §9.1／§9.3）。2026-11-06 依使用者參考圖改版，改為只讀可見列、有請求上限、可關閉的版本，見 §7.2；在共用 `main` 上 `scroll-snap`；交易頁標頭左右滑切換商品。
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
- 字級「大」（`html[data-sj-font-scale="1.3"]`）：統計格 2 欄、快捷價 3×2、五檔表頭改縮寫（不用容器查詢；只縮量欄：委買量→買量、委賣量→賣量，價欄不變）。
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
- 伺服器未連線提示（2026-11-09，移植上游 #384 的 `WebServerHint`）：連線詳情面板在動作區最上方顯示 warn InlineNote（role=status）「**伺服器未連線。**」＋「若剛切換永豐模擬／正式（改 .env 的 SJ_PRODUCTION），請在伺服器執行 docker compose up -d 重新啟動 Shioaji server；其他情況請確認伺服器與網路。」。黏著判斷同上游：串流 down 出現、重連中（connecting／stale）維持、LIVE 才消失，從未 down 過的 connecting 不顯示；判斷與文字在 `lib/server-down-hint.ts`（模組層共用，帳戶 › 連線同一份），由常駐的 StatusBar 追蹤（面板關閉時不 render 子元件）。狀態列本身不加任何文字；不發請求、沒有按鈕（S1）。
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
- 分頁 6 個（加入「產業」後；第 1 期改名為「市場」，lucide Activity）：自選、交易、市場、委託、持倉、帳戶（`lib/hash-router.ts` 的 `MOBILE_TABS`）。欄數寫在 `layout.css.ts` 的 `tabBar`：`gridTemplateColumns: 'repeat(6, minmax(0, 1fr))'`，不用 inline style（`app-shell.test.tsx` 檢查）。360 寬每欄 60px；字級放大到 root 20px 時 TOUCH_MIN 為 55px，6 × 55 = 330 ≤ 360。
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

**通知中心與前景憑證提醒**（第 1 期；以程式碼為準）：

- 狀態列依序為連線｜路由｜通知鈴｜風控。鈴是 IconButton（`status-notices`），無障礙名稱「通知」或「通知，N 則未讀」；右上 danger 實心徽章（>99 顯示 99+，aria-hidden）。鈴圖示以 `createLucideIcon` 建立較短的路徑（lucide 目前的 Bell 首屏多約 200 bytes）。
- 來源是 `src/lib/trade.ts` 的記憶體通知紀錄（最多 200 則，重新整理後清空）。未讀＝ts 晚於上次開啟或關閉通知中心的時間，只存在記憶體；通知內容不寫入任何儲存。
- 通知中心 `notice-center-sheet`（延遲載入 BottomSheet，第一次開啟才掛載；retryableLazy＋ModuleErrorBoundary＋SheetLoadError）：
  - 新的在上；每則有時間（今天 HH:mm:ss，其他日期 MM/DD，跨年加年）、種類圖示＋文字（成功／錯誤／待核對／訊息；沿用 toast 的 `noticeToastKind`，「結果未知」為待核對）、標題、內文。
  - 遮蔽與 ToastHost 完全相同（`useRevealTextCompat`），之後才打開隱私開關也會重新遮蔽。
  - 空狀態「沒有通知」；［全部清除］兩段式（第一次按變成「確定清除 N 則通知」，再按才清除；關閉面板或有新通知時回到第一段），因為清除無法復原，紀錄可能含待核對的結果未知。
  - 面板樣式用 inline style（顏色沿用 toast.css），不另開 `.css.ts`，避免首屏預載對照表多一個檔名。
- 字級大時狀態列各段左右內距 0.5rem → 0.25rem；寬 ≤400px 且字級大時隱藏路由的 ⌄（純裝飾）；路由膠囊先縮帳號、再縮券商名，環境膠囊不縮。
- 前景憑證到期提醒（`lib/ca-expiry-check.ts`，與通知中心同一個延遲載入 chunk，殼層閒置預載的最後一項載入後執行一次；省流量時也執行）：
  - 每次開啟 App 最多一次；每個台北日最多一次（localStorage `sj-mobile-ca-check-date` 只存日期，請求發出前寫入）。帳戶載入完成才判斷，最多等 60 秒。
  - 永豐：GET `/api/v1/health` 的 `ca_expires_in_days`／`ca_expired`（帳戶頁伺服器卡 60 秒內讀過或讀取中就沿用同一個 promise）；玉山：每位 person_id 一次 `fetchCaExpire`（GET `/esun/ca_expiretime`）。
  - 已過期或剩 ≤30 天時 `notify()` 一則（多個券商合併）：已過期或 ≤7 天為錯誤，其餘為訊息；文字只有券商名、剩餘天數與日期，並指向「帳戶頁」，不含 person_id 或帳號。失敗不通知、當天不重試。

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
- 排行：Segmented scroll 變體（tablist 語意不變）；caption「更新於 hh:mm:ss」＋更新 IconButton（冷卻秒數沿用）。列與自選共用 `components/quote-row.tsx`（使用者要求「排行的顯示方式也要跟自選一樣」）：第一行名次（名稱前的 numSm 小字，也寫進無障礙名稱）＋名稱；第二行代碼（合約快取有時加市場標記）、處置徽章、附加資訊（成交值排行顯示值、高低價差排行顯示價差，其餘顯示量）；右側成交價與「漲跌 漲跌幅」純文字（依漲跌著色）；迷你走勢；列尾星號（加入自選／已在自選，44px IconButton，只呼叫 onAdd）與快速下單鍵（只呼叫 `openTicket`，不帶方向）。排行是快照資料，不訂閱即時行情。
- 排行迷你走勢：沿用自選的限制（只有可見列、每檔每時段上限、K 線佇列同時 ≤2、帳戶頁可關閉）。排行資料沒有交易所，可見、可畫走勢、開關開啟、合約不在快取的列，經 `lib/ranking-spark-contracts.ts` 以 `ensureContract(code)` 解析一次：同時 ≤2、同一代碼去重、列不可見或開關關閉或離開排行時取消未開始的解析、失敗後 5 分鐘內不重試、開關關閉時 0 個。解析成功後列顯示市場標記與走勢。請求上限見 §13。
- 列表載入：6 列 Skeleton；空清單 EmptyState（Star 圖示、沿用空狀態文字、［搜尋並加入］）；錯誤：InlineNote danger＋［重試］。
- 長按 500ms（沿用）：`haptic('longPress')`，開啟操作面板（ListRow 樣式）：開啟交易頁、**買進…**、**賣出…**（新增，只呼叫 `openTicket({ code, action, source: 'other' })`，之後仍需預覽與滑動確認）、移到最上、上移、下移、從自選移除（danger、沿用兩段式確認與「與桌面共用」說明）。編輯模式列尾 ⋯ 沿用。
- **依使用者參考圖改版（2026-11-06）**。使用者提供另一家券商 App 的自選畫面作參考，只參考版面與資訊結構，不使用對方的品牌、標誌或圖示：
  - 列（64px）：左側第一行名稱（單行省略），第二行代碼＋市場標記（上市→市、上櫃→櫃、興櫃→興、期貨→期、選擇權→權、指數→指）＋試撮／處置徽章。代碼與市場標記不縮，空間不足時由名稱省略吸收。右側第一行成交價（依漲跌著色，保留 PriceFlash），第二行「漲跌 漲跌幅」純文字（帶正負號、依漲跌著色，不再用實心膠囊）。
  - 表頭「名稱｜指標切換（漲跌 漲跌幅 ↔ 總量，兩態；舊值 'chg' 讀成 'pct'）｜編輯」。編輯鍵從頁首移到表頭（testid `watch-edit` 不變；aria-label「編輯自選」／「完成編輯」，含可見文字）。
  - 迷你走勢（使用者要求，有限制地做）：canvas 畫目前或最近一個交易時段的 1 分 K 收盤折線＋淡色面積，昨收虛線為基準並決定顏色。即時成交依分鐘寫入尾段。
    - 只有可見列掛載（不可見列沒有 canvas、不排 rAF、不讀 K 線）。
    - 每檔每時段最多 2 次成功讀取：盤中讀過的，收盤後再補一次。休市時段往前補找一次。失敗或盤中資料不足時，15 分鐘後重試。佇列同時 ≤2，未開始的請求在列離開畫面時取消。
    - 模組延遲載入加閒置預載，載入前與失敗時都是同尺寸空白佔位。
    - 可在帳戶頁「顯示」關閉（`sj-mobile-watch-spark`，預設開啟），關閉後不發 K 線請求。窄螢幕（≤400px）且字級大時不顯示也不請求。
    - 指數與組合商品不畫。
  - 處置徽章：`GET /api/v1/data/regulatory_punish`，模組層快取，自選頁可見時最多每 30 分鐘一次，失敗靜默。參考圖的「注」（注意股）與「N 天後除息」沒有資料來源，不做。
  - 列尾快速下單鍵 `watch-row-ticket`（44px，只呼叫 `openTicket({ code, source: 'other' })`，不帶方向）。指數與組合商品放同寬的 aria-hidden 佔位，讓各列對齊；編輯模式維持「⋯」。
  - 多個清單時以 Segmented scroll 分頁（`watch-list-tabs`／`watch-list-tab-<id>`，tablist）取代 PopUpButton，選中分頁自動捲入可見範圍。只有一個清單時不顯示分頁。
  - 底部指數列 `ShellSlot bottom`：加權（IX0001）與櫃買（IX0043）。用 `retainContractQuotes` 帶型別訂閱，不經合約解析；收盤後或首次開啟沒有即時資料時，以快照（10 分鐘最多一次）作後備。文字一律 foreground，方向以有色 SVG 三角形表示；字級大時數值與漲跌幅上下排列。點擊開該指數的交易頁。
  - 搜尋面板改為延遲載入（第一次開啟才掛載，失敗時面板顯示載入失敗與重試），讓首屏仍在目標內。
- 搜尋面板：large；搜尋框為 body 內 `position: sticky; top: 0` 的 `islandBg` 欄（不模糊）；結果列與自選列同樣式，尾端「加入／已加入」Chip。選做：開啟鍵 handler 內以 `flushSync` 掛載面板後同步 `focus()` 輸入框（iOS 只允許手勢同一呼叫堆疊叫出鍵盤，需實機確認）。

**自選增減與排序**（使用者要求「自選要增加可增加或減少的功能」與手指拖曳排序；以程式碼為準）：

- 新增清單：清單列最後的「＋」（`watch-list-add`）開清單名稱面板（`components/watch-list-sheet.tsx`，延遲載入、閒置預載，第一次要求才掛載）。名稱去頭尾空白，空白或與其他清單同名不送出；成功才關閉面板。
- 編輯模式（表頭「編輯」）：目前清單「重新命名」（`renameCurrentList`，改名會換清單 id；失敗時面板與編輯模式保持並顯示原因）、「刪除清單」（兩段式確認；只剩一個清單時停用；失敗顯示原因並保持編輯模式）。刪除清單鍵的 aria-label 以可見文字開頭：「刪除清單「名稱」」→ 確認時「確定刪除「名稱」清單」（WCAG 2.5.3）。空清單也顯示編輯鍵，才能重新命名或刪除。
- 編輯模式每列：列首「−」開移除確認面板（沿用操作面板的移除流程與文字）；列尾「⋯」（操作面板）加握把；清單底部「加入股票」列（56px）開既有搜尋面板。編輯模式不顯示迷你走勢，讓出寬度給名稱。
- 握把拖曳排序（`lib/watch-reorder.ts`）：手勢規則見 §8；放手位置有變才呼叫一次 `reorderSymbol`（hook 每次是 GET＋PUT＋GET）。清單載入中（loading）、結構更新中（structureBusy）、載入失敗（loadError）或清單不可寫入時停用握把（`canReorderList`）。握把 aria-label「拖曳以調整 代碼 名稱 的位置」、`aria-keyshortcuts="ArrowUp ArrowDown"`：↑／↓ 一次移一格，忽略按住不放的自動重複（`event.repeat`）與寫入中，移動後焦點回到被移動那列的握把，可連續移動。操作面板的上移、下移、移到最上保留。
- 編輯模式延遲載入（第 1 期第 0 步，首屏 218.9 → 217.6 KiB）：
  - 列首「−」、列尾「⋯」＋握把與 `useListReorder` 放在 `components/watch-edit-controls.tsx`（約 2.4 KiB gzip），經 `lib/deferred-modules.ts` 的 `loadWatchEditControls` 以三個 `retryableLazy` 載入；非編輯模式不載入。
  - 列仍由自選頁渲染（QuoteRow 的 leading／trailing），進出編輯模式不重掛列。`useListReorder` 包成不渲染畫面的 `WatchEditReorder`，只在編輯模式且有清單時掛載，以 onChange 交回 { dragging, blocked, grip }，卸載時傳 null。
  - 載入前與載入失敗時，列首、列尾是同尺寸空白佔位（aria-hidden，握把不做事）；失敗在清單上方顯示「載入失敗」＋［重試］（`watch-edit-load-error`），重試或再次進入編輯模式會重新 import。
  - 殼層閒置預載呼叫自選頁匯出的 `preloadWatchEditControls`（三個 lazy 的 `preload()`），第一次進入編輯模式直接出現按鈕，不閃空白佔位（`watchlist-edit-preload.test.tsx`）。
  - `watch-reorder` 不 import `motion/prefs`（減少動態由呼叫端傳入 `reducedMotion`），避免 prefs 被拆成另一個首屏 chunk。
- 清單管理請求只在使用者操作時發出；交易安全：以上入口都不呼叫送單、改單、刪單函式（`watchlist-edit.test.tsx`）。

**「持倉」分段**（第 3 批，使用者要求「除了自選、排行以外增加一個持倉，根據持倉分頁有的股票自動動態的加入，預設不可使用者手動新增或刪除」；使用者選定「全部持倉」「同自選列＋持倉標記」；以程式碼為準）：

- 分段改為「自選｜排行｜持倉」，分段選擇在模組層保留；從編輯模式切走會結束編輯。「持倉」分段沒有任何編輯入口：不顯示清單分頁、「＋」、編輯、多選、拖曳排序，也不顯示表頭的指標切換鍵（列沿用自選目前的指標）；表頭只有「名稱｜排序」（檢視排序，第 6 批，見下方「持倉排序」）。頁首搜尋鍵照舊（加入的是目前的自選清單）。
- 列表 `components/holdings-list.tsx` 延遲載入（`loadHoldingsList`，比照排行，閒置時預載）；條件、方向、數量、對帳文字抽到 `lib/position-text.ts`，與持倉頁共用（持倉頁仍匯出同名函式）。
- 資料：與持倉頁同一份 `useTradingState().positions`（各帳戶，股票、ETF、權證、期貨、選擇權全部）。持倉由殼層在 App 啟動時讀取（分頁列的 `useTradingState()` 啟動 lib/trading-state，連線後讀一次，之後由成交回報與持倉頁「⟳」更新），本分段不觸發讀取、不輪詢；合約由 lib/trading-state 預先 `ensureContract`，本分段只讀快取。
- 合併：依「股票帳戶（S）／期權帳戶（F）＋代碼」合併成一列（多帳戶、多條件、玉山與永豐同時持有都只一列），順序為第一次出現的順序（持倉頁的券商順序）；持倉增減時即時更新；合併只看帳戶、代碼、方向、條件、數量，只有現價變動時不重算。
- 列：與自選列相同（`QuoteRow`：成交價、漲跌、迷你走勢依設定、快速下單鍵），代碼後加持倉標記，分成「條件 方向」「數量」「等 N 筆」幾段，放不下時在段之間換行（360 寬字級 1.3 實測列高約 92px，不重疊）；遮蔽金額時數量以 `maskMoney` 遮蔽；無障礙名稱附「，持倉 …」。合約未載入的列不顯示快速下單鍵（同寬佔位）。
- 價格：沒有即時成交（盤後、週末、冷門商品、剛進頁）時以持倉的現價當快照備援（與持倉頁同一個值，不另發請求），漲跌以合約參考價推算；有即時成交後以即時價為準（瀏覽器實測發現原本全是「—」後補上）。
- 狀態：讀取中 Skeleton；沒有持倉 EmptyState「目前沒有持倉」；讀取失敗或待對帳 InlineNote（`reconcileText`）＋「前往持倉頁」（只 `navigate`）。
- 互動：點列開交易頁；長按操作面板只有「開啟交易頁」「買進…」「賣出…」（不能移動或移除）；快速下單鍵與買賣只呼叫 `openTicket`（用目前選取的帳戶，與持倉頁「加碼」依持倉帳戶不同）。
- 請求：切到「持倉」分段 0 個額外請求（只有可見列的行情訂閱與迷你走勢，與自選相同）。

**多選刪除與排序群組**（第 2 批，使用者要求；以程式碼為準）：

- 編輯模式的清單工具列：［重新命名］［刪除清單］［多選］［排序群組］；多選中「排序群組」換成三態［全選］。「多選」「排序群組」「全選」與編輯說明文字都在延遲載入的編輯 chunk（`WatchEditTools`，與列首、列尾鍵同一個 chunk，閒置預載）。
- 多選：
  - 每列列首換成勾選圈（`watch-row-select`，button role=checkbox、aria-checked，名稱如「選取 2330 台積電」，44px）；點列也是切換勾選，不開交易頁；多選中握把、↑／↓ 與「⋯」停用。
  - 底部配件槽：「已選 N 檔」［取消］［刪除 N 檔］→ 確認面板列出要移除的商品（「自選清單與桌面共用，移除後桌面也會看不到」）→ 逐檔 await hook 的 `removeSymbol`（每檔 DELETE＋GET 清單），顯示進度，進行中不可關閉。
  - 每檔開始前確認仍是同一個清單、沒有載入中／結構更新中／載入失敗；呼叫後等到該檔真的從清單消失才算移除（最多 2 秒；hook 忙碌時 `removeSymbol` 會靜默返回，不能只看有沒有丟錯）。清單忙碌、出錯或換清單時停止，最後一則通知說明移除幾檔、幾檔未移除。
- 排序群組（`watch-group-sort`）：面板列出每個清單（名稱、檔數），以握把拖曳或 ↑／↓ 調整；↑／↓ 移動後焦點留在該列（到頂或到底時移到另一個方向鍵）。
  - 伺服器的自選清單沒有順序欄位，也沒有排序 API；不可用刪除再重建來換順序（會換 id、有遺失資料的風險）。順序只存在這台裝置的 localStorage `sj-mobile-watch-list-order-v1`（清單 id 陣列，`lib/watch-list-order.ts`），桌面與其他裝置仍是伺服器順序；0 個請求。
  - 顯示：已存的 id 依序在前，其他清單依伺服器順序接在後面（新清單在最後）；已刪除的 id 略過，下次存檔時移除；格式不對或儲存空間不可用時當作沒有設定。hook 刪除清單後的預設清單仍取伺服器順序的第一個。
  - 自選頁的清單分頁與交易頁 ☆ 面板都依這個順序。
  - 多選刪除群組（使用者要求「排序群組的時候也支援多選刪除，刪除時須使用者確認」）：
    - 面板的「選取」（`watch-group-select`，aria-pressed）進入選取模式：每列勾選鍵（`watch-group-check`，role=checkbox，名稱如「選取群組「主要」（7 檔）」，44px），點列也可切換；握把與 ↑／↓ 隱藏；目前清單標「（目前）」（排序模式也標）；不提供全選。
    - 底部「已選 N 個」［取消］［刪除 N 個群組］：沒選、全部選取（至少保留一個群組）、清單忙碌或載入失敗時停用並寫出原因。
    - **刪除前一定要確認**：同一面板切到確認畫面（不開巢狀面板），標題「刪除 N 個群組？」（焦點移到標題）、各群組與檔數、合計、警語「自選清單與桌面共用，刪除後桌面也會看不到，無法復原。」；含目前群組時另寫「刪除後會切換到其他群組並結束編輯模式」。［返回］（焦點回到刪除鍵）或［確定刪除 N 個群組］；按確定前 0 個請求。
    - 執行：先依序刪非目前群組（lib `deleteWatchlist`，每個 1 次 DELETE），目前群組最後交給 hook 的 `deleteCurrentList`（排進該清單的寫入佇列，刪完切到伺服器順序的第一個清單）；第一個失敗就停止。hook 還不知道的刪除（沒刪到目前群組，或中途失敗）最後 `emitWatchlistChanged` 重新讀取一次。進行中顯示進度、面板不可關閉。
    - 結束：一則摘要（只刪目前群組時由 hook 的「已刪除清單」說明，不重複）；刪掉的 id 從裝置的群組順序移除；焦點回到「選取」（只剩一個群組時改到群組列表）。
    - 含目前群組時，hook 切換清單、列表載入中，自選頁照既有規則結束編輯模式（同工具列「刪除清單」），面板跟著關閉；刪除流程改讀常駐 WatchlistProvider 的最新狀態（`getLatestMobileWatchlist()`），面板卸載後仍能正確判斷與回報（瀏覽器實測曾發現誤報「更新中」，已修正並加測試）。
    - 請求數：刪 2 個非目前群組＝DELETE×2＋重新讀取一次（GET 清單＋目前清單每檔合約資訊＋快照）；刪目前群組＋另 1 個＝DELETE×2＋GET 清單＋新清單載入，不另外重新讀取。
- 版面：編輯模式列首、列尾都有鍵，比一般列少約 44px；窄螢幕＋字級「大」時「漲跌 漲跌幅」放不下就換成兩行（只套用在列首有鍵的列），不往左溢出蓋到代碼（360 寬、字級 1.3 實測）。
- 交易安全：多選、全選、確認面板、排序群組只做清單管理或裝置偏好，不呼叫送單、改單、刪單，也不開下單或委託面板（§10 S1 表）。

**固定清單「股期近月」「股期遠月」與自選排序**（第 4 批，2026-11-09，使用者要求；以程式碼為準）：

- 固定清單（`components/futures-list.tsx`、`lib/futures-lists.ts`，延遲載入 `loadFuturesList`）：
  - 清單分頁最後固定接「股期近月」「股期遠月」（分頁值 `fut:near`／`fut:next`）；所以只有一個自己的清單時也一定顯示分頁。選擇在模組層保留，不呼叫 `setActiveList`。
  - 範圍（使用者選「一般＋小型」）：`spec_kind 'stock_fut'`、`underlying_kind 'S'`、乘數 2000（一般）或 100（小型）；調整型契約（其他乘數）、ETF 期貨、指數與商品期貨不列。近月取 `<root>R1`、遠月取 `<root>R2` 的 `target_code`；沒有 R2 的標的不在遠月；最後交易日已過的不列。2026-11-09 實際資料：近月 307（一般 256＋小型 51）、遠月 304。
  - 列代碼用**實際月份代碼**（例如 CDFK6，不用 CDFR1）：點列、長按買進／賣出、快速下單鍵、交易頁下單面板與五檔都直接開實際月份合約，下單面板、預覽與確認面板顯示的就是實際送出的合約；行情、快照、K 線也以實際代碼查詢，不需要連續月別名。列名稱去掉月份（「台積電期貨」「小型台積電期貨」），第二行「代碼 期 標的代號」。開交易頁或下單面板前，若合約快取沒有這檔，以清單資料 `primeContract`（只放使用者點的那一檔，不會讓 `refreshCachedContracts` 逐檔重抓 300 檔）。
  - 不存到永豐伺服器、不能編輯（同「持倉」分段）：沒有「＋」新增清單、編輯、多選、排序群組、移除；長按只有「開啟交易頁」「買進…」「賣出…」；快速下單鍵與買賣只呼叫 `openTicket`（之後仍需預覽與滑動確認）。
  - 資料：`fetchFutures({})`（一次 GET，約 1.86 MB JSON／118 KB gzip，2,559 檔）只在第一次開啟固定清單時讀，依台北日期快取（兩個分頁共用）；分頁停留跨過午夜重新讀取；伺服器推送期貨合約清單變更（contract 事件 `base_changed`）時只清快取，下次開啟才重讀。讀取中 Skeleton、失敗 InlineNote＋［重試］。
  - 請求：清單每個台北日 1 次；每次開啟 1 次批次快照（≤500 檔一批，列的價格備援，同自選清單載入時的快照，也是股價類排序的依據）；每列合約請求 0（名稱、參考價取自清單資料，不經 `useQuote` → `ensureContract`）；可見列只訂 Tick（不訂 BidAsk）；迷你走勢依設定只讀可見列。約 300 列時，捲動中進入可見範圍的列等捲動停下 200ms 才訂閱與讀 K 線（`createSettledTracker`），快速滑過整份清單不會一路訂閱上百檔。
- 排序（`components/watch-sort.tsx`、`lib/watch-sort.ts`，延遲載入 `loadWatchSort`）：
  - 表頭「名稱｜排序｜指標切換｜編輯」；排序鍵開選項面板：自訂順序（只有自己的清單；伺服器順序，預設）、股票代號、股價、漲幅%、漲跌。固定清單沒有自訂順序，預設股票代號（標的代號，同一標的一般在小型前）。再點目前的選項＝反向；預設方向：代號由小到大，股價、漲幅%、漲跌由大到小；沒有資料的列不論方向都在最後。
  - 只是檢視順序，絕不寫回伺服器清單；編輯模式不顯示排序鍵、一律伺服器順序（拖曳、多選刪除照舊）；排序檢視中長按面板不顯示移到最上／上移／下移（它們依伺服器順序）。
  - 股價類排序：選擇時（或開啟已設定股價類排序的清單時）取一次批次快照（lib `fetchSnapshots`，每批 ≤500 檔；5 秒內沿用），表頭第二行「排序依據 HH:MM:SS」＋［⟳］（間隔 ≥5 秒）；之後即時行情只更新列上的數字，不自動重排。連續月代碼（TXFR1）的快照以 `target_code` 對應。
  - 偏好依清單 id 存在本裝置 `sj-mobile-watch-sort-v1`（`{ [清單 id]: { key, dir } }`）；清單改名會換 id，排序回到預設。
- 版面：表頭可換行（排序依據列在第二行）；360 寬字級 1.3 與 390 寬字級小實測無水平溢出、排序鍵與［⟳］點擊區 ≥44px。360 寬字級 1.3 時，價格五位數以上的小型合約第二行的標的代號會換行（列高 92px，比照徽章換行規則）。
- 交易安全：排序鍵、選項面板、［⟳］、固定清單分頁不呼叫送單、改單、刪單，也不開委託面板（§10 S1 表）。

**持倉排序**（第 6 批，2026-11-09，使用者要求「自選持倉也要有排序功能」；以程式碼為準）：

- 重用自選清單的排序鍵（`components/watch-sort.tsx`、`lib/watch-sort.ts`）：「持倉」分段表頭「名稱｜排序」（`holdings-header`，固定清單的表頭樣式）；選項「持倉順序」（合併順序，即持倉頁的券商順序，預設）、股票代號、股價、漲幅%、漲跌；再點目前的選項＝反向，預設方向同自選（代號由小到大，股價類由大到小）。`WatchSort` 新增 `manualLabel`、`manualText`、`footer` 讓「自訂順序」那一項顯示為「持倉順序」（說明「持倉頁的順序」，面板說明「不會改動持倉」）。
- 列以合併鍵（`S:`／`F:`＋代碼）識別（`SortItem.id`；同代碼的股票帳戶與期權帳戶持倉各一列），股票代號以字串比較（00878 在 1101 前，期貨代碼在數字後）。
- 股價類排序：選擇時（或開啟已設定股價類排序時）取一次批次快照（lib `fetchSnapshots`，≤500 檔一批；5 秒內沿用），表頭第二行「排序依據 HH:MM:SS」＋［⟳］（間隔 ≥5 秒）；之後即時行情只更新列上的數字，不自動重排。合約取自合約快取（lib/trading-state 已預先解析）；尚未解析的持倉（`resolved: false`）不送進快照請求，排在最後，解析完成後下一次排序依據才納入。沒有資料（沒有成交、快照沒有）的列不論方向都在最後；排序結果交回前新增的持倉先接在最後，不會少列。
- 偏好存在這台裝置，與自選排序同一個 localStorage 鍵 `sj-mobile-watch-sort-v1`，清單 id `pos:holdings`（`HOLDINGS_SORT_ID`；與伺服器清單 id、固定清單 `fut:…` 分開）。
- 請求：持倉順序與股票代號 0 個；股價類每次排序依據 1 個批次快照 POST。只改顯示順序，不改持倉、不寫回任何伺服器資料；排序鍵、選項面板、［⟳］不開下單面板（§10 S1 表）。

**第二階段實作差異**（以程式碼為準）：

- 排行更新鍵不是純圖示 IconButton，而是 compact 文字鍵，可見文字仍為「⟳ 更新（N）」（`ranking-list.test` 精確比對，§14）。
- 第 1 期新增（以程式碼為準）：
  - 排行種類依序為漲幅、跌幅、漲價差、跌價差、成交量、成交值、成交筆數、高低價差。
    - 漲價差／跌價差用 ChangePriceRank（ascending 依 shioaji#207 反轉：漲價差 true、跌價差 false），前端再依漲跌（元）排序。
    - 成交筆數用 TickCountRank，保留伺服器名次，第二行仍顯示量（`rank_value` 的語意未確認，不當成筆數顯示）。
    - 新種類沿用同一個 scanner 端點與 30 秒快取、15 秒冷卻。
  - 排行篩選晶片（aria-pressed）：排除處置、排除 ETF（代碼 00 開頭）、排除權證（6 碼、03–08 或 7 開頭）。
    - 只過濾已取回的名單，名次維持過濾前；狀態列寫「已排除 N 檔」；全部被排除時顯示篩選專用的空狀態。
    - 處置名單還沒取得時「排除處置」不隱藏任何列，並就地說明。篩選只記在模組層，重開 App 後全部關閉。
    - scanner 不帶交易所，所以沒有上市／上櫃篩選。
  - 自選列與排行列的日內區間小條：價格欄正下方 2px 細軌，2×6px 標記現價在今日最低→最高之間的位置（aria-hidden，絕對定位，不改列高與名稱欄寬）。
    - 列按鈕的無障礙名稱補上「今日最低 X 最高 Y，現價位於區間 N%」。
    - 資料：自選用即時 tick 優先，其次指數、快照；排行用 scanner 的 high／low。缺資料、最高＝最低、試撮時不顯示；不畫參考價刻度（首屏體積）。
- 搜尋結果列尾的鍵是原生 button 套用 `ui/chip.css` 的 chip class，不是 `ui/Chip` 元件；文字維持「加入自選／已在自選」，不是上文的「加入／已加入」（`search-sheet.test` 斷言 children 為字串）。
- 操作面板的「從自選移除」用自訂 danger 列按鈕，不是 ListRow（測試以 `data-testid="watch-remove"` 取得 onClick，ListRow 的 testId 掛在外層）。
- 排行列不接表頭的指標切換，固定顯示「漲跌 漲跌幅」純文字（`ranking-change`）；原本的漲跌% 膠囊（`ranking-pct`）已隨改用 QuoteRow 移除（§14 刻意更新 8）。
- 操作面板的「買進…／賣出…」對指數（IND）與組合商品不顯示，比照交易頁的 tradable 判斷（上文沒寫到的防呆）。
- 頁面不套用 `layout.page` 的 16px 內距，改由各區塊自帶左右 16px（PageHeader 已有內距），清單列可延伸到螢幕邊緣。
- 指標切換鍵設 `zIndex: 1`（第二階段後修正）：原本 `::before` 擴張的點擊區下半部被第一列（`position: relative`、DOM 在後）蓋住，實際可點高度不足 44px，點偏下會進入第一檔商品。由 `styles/watchlist-hit-area.test.ts` 覆蓋。
- 未做：選做的 `flushSync` 同步聚焦搜尋框（面板以 transform 進場時聚焦 input，iOS 可能捲動或位移，需實機確認後再加）；開啟後焦點仍在面板標題。
- 待實機確認：iOS／Android 長按觸發與 Android 震動；pressableRow 80ms 延遲加深在快速捲動時不閃；200 列捲動時 PriceFlash 效能；iOS 15.4 面板內 sticky 搜尋框；字級「大」配 360 寬長名稱的列寬；淺色主題捲到底時 main 底部內距區的底色差。總量膠囊的單位沿用桌面（股票視為張、期權為口），需以實際資料確認。

**漲停／跌停標示**（第 5 批，2026-11-09，使用者要求「漲停跌停的股票增加背景顏色讓使用者快速了解股票漲停或跌停」；以程式碼為準）：

- 判斷：即時列（自選、持倉、股期清單、成分股）用 `lib/limit-hit.ts` 的 `quoteLimit`：真實成交價等於合約 `limit_up`／`limit_down`；差距小於半個最小跳動（0.005）視為相等，不用浮點數相等。漲跌停 ≤ 0 或缺少、指數（IND）、試撮價、參考價都不標示。排行是 scanner 快照，以 `change_type` 為準（`ranking-list.tsx` 的 `rankingLimit`，經 `RowQuoteView.limit` 傳給 QuoteRow）：1＝漲停、5＝跌停，2／3／4 不是；2026-11-09 以正式 sidecar 唯讀 POST `/api/v1/data/scanner` 確認（漲幅前 30 的 +10.00% 全為 1；−10.00%／−9.95%／−9.92%／−9.87% 為 5；−9.62% 為 4）。0 個請求、不需要合約快取。
- 外觀：成交價格改實心 up／down 底疊 inkStrong＋白字（同 `fill.*.strong` 的底色與疊黑，單一 class、不含按壓加深），價格前以 `::before` 放 caption「漲停」「跌停」小標（`watchlist.css.ts` 的 `limitPrice`；文字在 CSS，不佔首屏 JS）。顏色隨漲跌配色：台灣漲停紅底、跌停綠底，國際相反。第二行「漲跌 漲跌幅」仍是漲跌色文字。
- 對比（`tokens.test.ts` 依四種主題重算白字對 up／down＋inkStrong；瀏覽器以實際計算樣式量到相同數字）：深色紅 6.69、深色綠 4.85、淺色紅 5.81、淺色綠 4.99。台灣與國際只是紅綠對調，四種主題都 ≥ 4.5。
- 範圍：所有 QuoteRow（自選、排行、持倉分段；固定股期清單也走 QuoteRow），即時列以 `quoteContract` 的漲跌停判斷；排行在任何寬度、合約不在快取時都以 `change_type` 標示。產業說明面板的成分股列同樣標示（§7.9）。
- 無障礙：列按鈕的無障礙名稱在價格前加「漲停」「跌停」（例：「2330 台積電 上市，漲停 1,175，漲 ▲105.00 +9.81%…」）；小標是 CSS 產生的文字，列按鈕有 aria-label，不會重複朗讀。
- 版面：小標讓價格欄多約 2.5 字寬。窄螢幕（≤400px）＋字級「大」的排行列（列尾有星號＋下單鍵）只保留實心底、不顯示 `::before` 小標，名稱欄最小 4.5rem（名次＋約 3 個字）、「漲跌 漲跌幅」放不下時換成兩行（`watchlist.css.ts` 以 `html[data-sj-font-scale="1.3"] [data-testid="ranking-row"]` 選取，純 CSS、首屏 JS 0 bytes）；360 寬字級 1.3 實測名稱欄 76px（約 3.9 字），「台積電」完整顯示，列高不變（原本就是三行）；無障礙名稱仍含「漲停／跌停」。自選、持倉在 360 寬字級 1.3 照常顯示小標；360／390 寬都沒有水平溢出。

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
[五檔|明細|公司]（tabs）                    [整股|盤中零股]       44
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
- 漲停／跌停（第 5 批，2026-11-09）：主價（`trade-price` 第一格）在成交或快照價等於漲跌停價時改實心 up／down 底＋白字（`fill[limit].strong`，`data-limit`），旁邊沿用原本的「漲停／跌停」實心徽章（`trade-limit`）；參考價、試撮、指數不標示。判斷與報價列共用 `lib/limit-hit.ts`（容差半個最小跳動）。

**第二階段實作差異**（以程式碼為準）：

- 內嵌五檔顯示內外盤比後，`depth-ladder.test.tsx` 原本「ticket 變體不顯示內外盤比」的斷言與本節衝突，已刪除，改由新增案例驗證「ticket 變體顯示內外盤比」與「沒有內外盤量（或試撮）時仍隱藏」（§14 刻意更新 3）。
- 長按（圖表與自選列）呼叫 `haptic('longPress')`：只在 Android 且使用者開啟「介面觸覺回饋」時震動，iOS 不震（`motion/haptics.ts`）。
- 選價列收回：另渲染一個 `chart-pick-closing` 殘影節點（`aria-hidden`＋`inert`）播放沿原路收回的動畫，`chart-pick` 本身在選完或取消時立即移除，測試與輔助技術不會看到兩份選價列。
- 精簡標頭（`trade-compact`）設 `aria-hidden`：內容與頁面 h1、主價重複；唯一的互動（切換商品）是 aria-hidden 之外的兄弟按鈕 `trade-compact-switch`。
- 整股／盤中零股切換與「五檔｜明細」同列（收尾）。
  - 零股狀態由 trade-page 持有。DepthLadder 改為受控（`oddLot` prop，頁面與 ticket 變體共用），不再自帶切換鍵；交易頁在分頁列右側渲染匯出的 `DepthOddToggle`（testid `depth-odd-toggle` 不變）。是否可切換只看 `depthOddCapable(contract)`（股票才可以）。
  - 「明細」「公司」分頁時切換鍵不渲染，但保留同寬空位，避免分頁跳動；零股狀態也保留。原本切到明細會卸載五檔，回來時重設為整股，這是刻意的行為差異。
  - 列寬以 rem 計（加入「公司」分頁後）：分頁 8.5rem、切換鍵 9.5rem（仍不小於「盤中零股」兩段所需的 9.25rem）、間距 0.75rem，合計 18.75rem。390 寬字級標準與 360 寬字級小同列；375 與 360 寬字級標準、以及字級大時，切換鍵換到第二行靠右（改版前 360 寬字級標準是同列）。換行後各自一行都放得下（`styles/trade-depth-layout.test.ts`）。
  - 零股五檔點價仍開零股下單面板（帶 `lot: 'IntradayOdd'`）。
- 字級「大」時五檔表頭縮寫（收尾）：量欄同時渲染完整與縮寫兩個 span。縮寫 aria-hidden；字級大時完整標籤以 clip 視覺隱藏（不用 display:none）。交易頁與下單面板內嵌五檔共用。靜態檢查在 `styles/trade-depth-layout.test.ts`。
- 選價列出現時（非全螢幕）以沒有 transform 的外層 `scrollIntoView({ block: 'nearest' })`，靠 main 的 `scroll-padding-bottom` 停在交易鍵列與分頁列之上（第二階段後修正：小螢幕或開副圖時原本會落在底部 chrome 後面）；減少動態時不平滑。
- 持倉摘要卡的「未成交：N 筆 ›」連結外包一層 `workingLinkRow`（第二階段後修正）：GroupedSection 的列間髮絲線（`card > * + *::after`）與連結 pressableRow 的按壓層原本共用同一個 `::after`，兩者都失效；現在髮絲線落在外層，`::after` 只當按壓層。
- 精簡標頭顯示期間，main 的 `scroll-padding-top` 設為 `SIZE.compactBarH`，隱藏或卸載時移除（第二階段後修正）。原因：遮擋檢查發現 scrollIntoView 或焦點移動會把週期列停在精簡標頭後面。
- **快速切換商品**（使用者需求：「股票代號及名稱那邊可以增加快速搜尋（支持模糊查詢）讓使用者可以快速切換股票」）：
  - 入口：標頭 h1 內的按鈕 `trade-switch`（aria-haspopup=dialog、aria-expanded、aria-label「切換商品，目前 <代碼> <名稱>」；名稱後 ChevronDown；點擊區以 expandHit 擴到 TOUCH_MIN）。精簡標頭顯示時另有 `trade-compact-switch`：它是 aria-hidden 精簡標頭的兄弟節點，只在顯示時渲染；點擊區固定只補到 44px，不隨 rem 放大。
  - 面板 `trade-switch-sheet`：標題「切換商品」，large。搜尋欄與結果列同自選搜尋，共用 `hooks/use-product-search`（debounce 250ms、上限 10、AbortController；面板退場中暫停，只取消不清空）。模糊比對沿用上游 `searchProducts`：代碼前綴、名稱子字串、跳字模糊、別名、加「期」查期貨。結果列整列＝切換，列尾只保留「加入自選」，目前商品標「目前」、點了只關閉。
  - 空白查詢：「最近查看」（`lib/recent-codes`，localStorage `sj-mobile-recent-codes`，最多 10 筆，只存代碼、名稱、種類）與「自選」（取殼層已載入的自選清單，不發新請求）。
  - 切換：`navigate(..., { replace: true })`，返回鍵回到進交易頁之前的畫面；`ui.currentCode` 由既有路由 effect 更新；選了其他商品後，面板退場結束才把焦點移到新頁的切換鍵。
  - 開啟即可打字：點擊 handler 內以 flushSync 提交面板，再於同一手勢聚焦 `lib/focus-proxy` 的暫時 input 叫出 iOS 鍵盤。面板進場完成後焦點移到搜尋框，並帶入已打的字；輸入法組字中則延到 compositionend，最多 800ms，逾時只移焦點、不帶標記文字。所有關閉與卸載路徑都會移除暫時 input。
  - 交易安全：只查詢與導覽，openTicket／openOrderAction／lib 送出函式 0 次（trade-page.test）；下單或確認面板開啟時殼層 inert，標頭不可點。§17「標頭左右滑切換商品」仍不做，點擊開搜尋不在此列。

**公司分頁**（「五檔｜明細｜公司」；使用者需求原文見規格 §6.2；以程式碼為準）：

- 入口與載入：分頁 `trade-panel-company`。`components/company/load-company-tab.ts` 是延遲載入入口（作法同 `lib/deferred-modules`，可 `vi.mock`），外包 `retryableLazy`＋`ModuleErrorBoundary`（`company-load-error`）＋Skeleton「公司資料載入中…」。切到「公司」才 import 並讀資料，不閒置預載；第一次切入後以 `hidden` 保持掛載（`trade-company`），子分頁狀態保留。
- 資料：只走 `hooks/use-company-data`（shioaji-data，sha256 驗證＋IndexedDB 快取）。不支援的商品（同桌面 `companyTarget`：指數、指數期權、沒有標的的商品）與不在收錄範圍（ETF 等）顯示「此商品沒有公司資料」。
- 版面：標頭（代碼、名稱、市場、英文簡稱、價格與漲跌或「收盤 日期」、交易所產業別、研究分類 l1 › l2 › l3、個股期權的「XXX 標的」）、指標 2×2（市值、本益比＋近四季 EPS、月營收＋年增、毛利率／淨利率）；子分頁 Segmented tabs「概覽｜財務｜上下游 N｜來源 N」（同桌面帶筆數：上下游為已研究時所有關係列數，來源為研究出處筆數、0 時不顯示）；頁尾是第三方／官方資料標示、官方日期、shioaji-data 版本、離線快取與［重新檢查］。各區塊與桌面 `company-panel.tsx` 的逐項對照在 `company-tab.test.tsx` 的 `DESKTOP_BLOCKS`。
- 即時資料（與桌面相同來源）：
  - 股票的價格用本頁已訂閱的同一檔報價（refcount 共用，不新增訂閱）。個股期貨／選擇權的標的公司在公司分頁 active 時訂閱標的報價；沒有即時成交時以 shioaji-data 每日收盤顯示「收盤 日期」。
  - 上下游列的即時漲跌幅經 `hooks/use-live-snapshots`（`components/company/relation-quotes.ts`），只在「上下游」子分頁顯示且公司分頁 active 時讀取與訂閱。對象是目前看得到的上市櫃列，去重後一次最多 20 檔（桌面 40；手機減半，因為每檔訂閱 Tick＋BidAsk 兩筆，40 檔會一次送 80 筆，可能觸及永豐行情訂閱 50 次／5 秒），同一代碼 30 秒內不重讀快照。沒有即時資料的列顯示資料時點。
- 重繪：即時價只在 memo 的 `SummaryCard`（標頭價格、市值、本益比）訂閱，每筆成交只重繪這張卡；子分頁與頁尾以 memo 隔開，成員名單排序以 useMemo 快取。切回五檔或明細時 `active=false`：改呼叫 `useQuote(null)`、不讀快照、不訂閱上下游與標的，隱藏期間不隨成交重繪；標頭仍持有同一檔的 refcount，切回時不重新訂閱。
- 與桌面的差異：多顯示「統一編號」（資料集 `tax_id`，使用者明確要求），英文簡稱與市場也列進基本資料；manifest 與 `sources.json` 的免責說明都顯示（相同時去重）；桌面只放在滑鼠提示的說明（第三方資料 AI 整理提醒、快取說明、媒體報導說明、主要／兼營階段）改為可見或視覺隱藏文字；月營收表預設 6 個月、可展開到 36 個月（取代桌面長條提示的年增、月增）；表格可橫向捲動、產業鏈上／中／下游改直式三列；上下游即時漲跌一次最多 20 檔（桌面 40）。
- 交易安全：只導覽（上市櫃關聯公司整列 `navigate` 開該股交易頁）與開外部連結（只接受 http／https，新分頁＋`rel="noopener noreferrer"`）；不呼叫 `openTicket`／`openOrderAction`，送單、改單、刪單 0 次（`company-tab.test.tsx` S1；`trade-page.test.tsx` S1 另加一輪「切到公司後點全部」）。
- 估值與體質卡（第 1 期，`components/company/valuation-card.tsx`、`valuation.ts`）：財務子分頁頂部，只在有財報檔時顯示；只用同一份財報檔，不另發請求。
  - 指標 2×2：
    - 股價淨值比：即時價或收盤 ÷ 最新一季每股參考淨值。
    - 負債比：負債總計 ÷ 資產總計。
    - 盈餘品質：近四季營業現金流合計 ÷ 淨利合計（淨利為歸屬母公司業主），附文字結論「營業現金流高於／低於淨利」。
    - 今年累計 EPS：`income_ytd` 的基本每股盈餘，對照去年同期與年增率；去年同期 ≤ 0 時不算成長率。
  - 近 8 季獲利金額表：單季營收、毛利、營業利益、淨利，億元。金融業沒有毛利與營業利益時不顯示那兩欄。
  - 缺資料、季別不連續或分母不為正時顯示「—」＋原因，不推估。
  - 只有 P/B 一格隨成交重繪：`live-price.ts` 由標頭與 P/B 共用，同一檔 refcount，不新增訂閱。卡片沒有按鈕（S1）。

**當沖資訊列與「籌碼與當沖」面板**（第 1 期；以程式碼為準）：

- 位置：標頭最下方，在統計格、漲跌停列之後。整列是一顆按鈕 `trade-info-strip`（aria-haspopup=dialog、aria-expanded、高度 ≥ TOUCH_MIN）。
  - 一般文件流，不在殼層槽，不用 fixed／sticky／absolute。
  - 膠囊可換行、不截斷，最後是「說明 ›」。
- 膠囊依序（`lib/trade-info.ts`，testid `trade-info-*`）：
  - 可當沖／先賣，只有 STK（合約 `day_trade`）：「可當沖・可先賣」「僅先買後賣」「不可當沖」。
  - 漲跌停狀態：
    - 鎖漲停：價位在漲停、最佳委買在漲停且委賣已空。
    - 漲停未鎖。
    - 漲停：五檔兩側都空，無法判斷。
    - 接近漲停：距停板 ≤ 參考價的 1%。
    - 跌停同理。
    - 只看成交或快照價。只有在停板時才讀含五檔的報價判斷是否鎖住，與五檔共用訂閱；平常資訊列不隨五檔重繪。
  - 振幅小條＋「振幅 x.xx%」：振幅＝（最高 − 最低）÷ 參考價。
    - 有漲跌停的股票與期貨：用 `lib/day-range` 以參考價為中心的尺。
    - 選擇權、指數、權證：整條是今日最低到最高。
    - 附視覺隱藏的位置文字。
  - 量比，只有 STK（`lib/volume-ratio`）：今日累計量 ÷ 前一交易日量；快照日期與成交不同時不顯示。
  - 處置股，只有 STK。
  - 期貨只有漲跌停與振幅；選擇權、指數只有振幅；指數沒有資料時整列不渲染。
  - 同一交易日檢查（同桌面 quote-board 的 sameDay；`lib/trade-info` 的 `sameTradingDay`）：報價推出的參考價（現價 − 串流或快照的漲跌）與合約參考價相差半個跳動以上時，兩者不是同一個交易日（盤前開 App 的除權息、分割日；期貨夜盤時合約仍是日盤的參考價與漲跌停）。此時不判停板、小條改畫最低到最高、振幅以報價自身的參考價計。
  - 選擇權不判停板：跌停只是最小跳動的地板（同桌面），只顯示振幅。
- 面板 `trade-chips-sheet`（`components/trade-info/trade-chips-sheet.tsx`）：第一次點資訊列才 import（retryableLazy＋ModuleErrorBoundary＋SheetLoadError），唯讀。內容：
  - 融資融券：成數、單位、可否；停資、停券時寫出原因（成數或單位為 0）。
  - 可借券源（`short_stock_sources`）與合約上的資券餘額。
  - 處置狀態：名單還沒成功取得過時寫「處置名單尚未取得」（`usePunishedListLoaded`），不當成未處置。
  - 當沖資格與規則：證交稅取自 `lib/day-trade-tax`；期權、權證、指數各自說明。
  - 資訊列各項目的定義。
  - 查詢失敗時顯示［重新查詢融資融券與券源］，只重讀失敗的那一項。
  - 融資融券與券源顯示資料時間（`update_time`、`datetime`，MM/DD HH:mm）：每檔每天只讀一次，早上的數字整天沿用；並註明下單時券商會重新查詢，以下單當下為準（下單流程本來就會以 `loadCreditEnquire({ fresh: true })` 再查）。
  - 按［重新查詢］後按鍵會消失，焦點先移到「融資融券」標題（tabIndex −1），不掉到面板外。
- 交易安全：資訊列與面板不呼叫 `openTicket`／`openOrderAction` 或任何送單、改單、刪單函式（§10 S1 表）。

**圖表輕點資訊列**（第 2 批，使用者要求：點選走勢圖要顯示當前價格、漲跌%數、漲跌價差；以程式碼為準）：

- 輕點圖表（移動 <10px 且 <450ms）在該分鐘或該根 K 線釘住十字線，圖例上方顯示資訊列（`chart-readout`，`lib/chart-readout.ts`）：
  - 走勢：時間 HH:mm、該分鐘價格（依跳動價位格式化）、漲跌（▲▼＋差額）與漲跌幅（正負號、2 位小數）。基準與走勢基準線相同＝合約參考價；參考價 ≤ 0（例如指數）時只顯示價格。
  - K 線：該根的「收」與「較前一根」收盤的漲跌與幅度；日 K 時間為 MM/DD；第一根只顯示收盤。
  - 差額不吸附到跳動價位（參考價與成交價可能落在不同級距，例如 99.9 → 100.5 差 0.6），小數位取兩邊級距的較大者。
  - 方向以 ▲／▼ 與正負號標示，不只靠顏色；無障礙名稱寫「上漲／下跌／平盤」。
- 再點同一點（12px 內）或按 ✕（`chart-readout-close`，「關閉價格資訊」）關閉；點別處移到新位置；拖動平移不顯示。長按追蹤時資訊列跟著十字線，放開後照舊升起選價列（不會直接送單）。
- 只有資訊列元件訂閱自己的小 store，跳價不重繪整個圖表元件。圖表下方提示：走勢「點一下看價格與漲跌；長按選價位，放開開啟下單面板」，K 線「點一下看收盤與漲跌；長按選價位」（日 K 仍為聚合說明）。
- 交易安全：輕點只顯示資訊，不開下單面板、不送單；選價列流程不變（§10 S1 表）。
- 資訊列也附該根的量（第 2 批，使用者要求「走勢圖新增成交量」）：順序［時間］［價格］［漲跌］［量 1,234 ✕］，量放在漲跌之後（不夾在價格與漲跌之間），千分位整數、單位同量座標（股票為張），不上色（量沒有方向）；無障礙名稱加「成交量 1,234」；指數不附。［漲跌］與［量 ✕］各自成組換行，✕ 不會單獨落到下一行。

**圖表長按選價下單設定**（使用者要求「交易的圖表目前是可以點選圖表價格下單，改成用設定方式讓使用者自己決定是否開啟這樣功能」；預設關由主代理決定，避免誤開下單面板；以程式碼為準）：

- 設定：帳戶 › 本裝置「圖表長按選價下單」Switch（`device-chart-pick`），存 `sj-mobile-device-v1` 的 `chartPricePick`（`lib/mobile-device-settings.ts`，讀寫包 try/catch，storage 不可用時只在本次有效），**預設關**；舊資料沒有這個欄位時視為關。
- 交易圖表以 `useMobileDeviceSettings()` 讀取，切換後已開著的交易頁立即套用（不重建圖表）；關閉時已浮出的選價列一併收起，長按途中關閉則放開不浮出。走勢與 K 線、直向與橫向全螢幕同一規則。
- 關閉時長按＝看價格：十字線照樣由程式庫追蹤模式跟著手指、資訊列顯示該根，放開時釘在放開的那一根（同輕點的 `chart-readout`；只釘住、不因「同一點」收起；落在價格軸不切換漲跌停）。不浮出選價列、不呼叫 `openTicket`、不觸發 `haptic('longPress')`。
- 提示文字（`chartToolNote`）關閉時不提長按：走勢可切換漲跌停「點圖看價格；點價格軸看漲跌停」、不能切換「點圖看價格」，K 線「點一下看收盤與漲跌」（日 K 仍為聚合說明）；開啟時維持原文。
- 不受影響：輕點資訊列、點價格軸切換漲跌停範圍、點委託線標籤開委託操作面板（管理既有委託）、全螢幕買進／賣出鍵（只開下單面板）。開啟時行為與原本完全相同。

**走勢成交量副圖**（第 2 批，使用者要求「交易-走勢圖新增成交量」；以程式碼為準）：

- 原本走勢的量疊在價格區底部 20%，而且與走勢的漲跌填色同色（`upVol`／`downVol`），幾乎看不出來。改為價格下方獨立的 pane 1（高 `PANE_HEIGHT_PX` 96），外框沿用 `frame[1]` 加高，價格區不縮小（360×780 實測價格 pane 297px，與沒有副圖時相同）。
- 副圖右側為量的座標，左上小標「成交量 N」（平時為最新一分鐘；輕點或追蹤時為該分鐘）。
- 量柱：本分鐘收盤對前一分鐘收盤（第一根對參考價），漲 `upVol`、跌 `downVol`（跟隨使用者配色，比價格線淡），平盤中性灰。K 線的量維持疊在主圖底部。
- 指數、量全為 0 或沒有資料時不建副圖；建圖時先預留高度，沒有量才收回，之後第一筆有量的成交才建立（外框在那一刻加高）。
- 副圖內長按不選價、輕點不顯示資訊列（沿用 K 線副圖的 `mainPaneHeightRef`）。
- 一般模式下外框高度改變（退出全螢幕、副圖晚建、網址列收合）時把副圖拉回 96（程式庫會依比例重分配；每個外框高度只校正一次）；全螢幕依比例分配（直向約 447／144，橫向約 129／42，橫向時量的刻度可能省略，只剩圖例數值）。這個校正也修正了 K 線指標副圖退出全螢幕後變高的既有問題。
- 副圖分隔線改用主題框線色，並關閉拖曳改高度（`enableResize: false`，手機上避免誤拖；K 線副圖同樣適用）。

**走勢 X 軸固定與漲跌停範圍**（第 3 批，使用者要求「交易走勢圖 固定 X 軸不要縮放 Y 軸設定預設目前樣子 再點選右邊價格時可以顯示漲停~跌停的範圍」；以程式碼為準）：

- X 軸固定為整個交易時段（股票 09:00–13:30；期貨依 `win` 為日盤或夜盤）：隱藏的 axisSeries 在時段每分鐘放空白點（股票 270、期貨日盤 300、夜盤 840 點），線隨時間往右長，右側未到的時段留白；量與買賣力副圖共用同一條時間軸。主 series 不加空白點，盤中每分鐘新增 K 棒照舊 `update`。
- 走勢關閉拖移、縮放、滾輪、軸拖曳、雙擊重設與慣性捲動，也不放行雙指（平台手勢防護照常擋下）；`fixLeftEdge`＋`lockVisibleTimeRangeOnResize`、`minBarSpacing` 0.01（夜盤 840 分鐘放得進手機寬度），在套用歷史、換時段、尺寸改變時 `fitContent`。不用 `fixRightEdge`（它把右端鎖在最後一根有資料的點，會切掉右側留白）。垂直與水平滑動交給頁面捲動（實測在走勢圖上垂直拖曳可捲動頁面）。K 線維持可拖移、可縮放。
- 輕點、「同一點」判斷與圖例取值改以「時段內第幾分鐘」換算邏輯位置，依時間吸附到最近有成交的一根；點在右側留白處吸附到最後一根。
- Y 軸預設維持自動範圍。輕點主圖右側價格軸（沿用 tap 門檻：移動 <10px、未達長按；x 在價格軸、y 在主圖 pane 內）切換「漲跌停範圍」：主圖 Y 軸固定為 [跌停, 漲停]（主 series 的 `autoscaleInfoProvider`；均價線不參與；價格線本來就不參與），並畫出漲停、跌停線（股票原有，期權補畫，標籤「漲停」「跌停」，跟隨漲跌配色）。主圖圖例前出現「漲跌停範圍」按鈕（aria-pressed，名稱「漲跌停範圍（點一下回到自動範圍）」，觸控高 44px），點它或再點價格軸回到自動。點價格軸不出資訊列、不選價；長按價格軸仍是選價。副圖的價格軸不觸發。
- 狀態放在模組層（`lib/chart-limit-range.ts`），本次使用期間換檔、換週期沿用，預設自動，不存 storage；指數或漲跌停不是正數（或漲停 ≤ 跌停）的商品不切換、不顯示按鈕。
- 提示文字：可切換時為「點圖看價格，長按選價；點價格軸看漲跌停」（360 寬字級 1.3 三行、不溢出），不能切換時維持原本的提示。
- 另修既有問題：程式庫上層 canvas（十字線）z-index 為 2，圖例只有 1，圖例裡的按鈕（含資訊列 ✕）觸控時點不到；圖例 z-index 改為 2（圖例本身 pointer-events none，不擋圖表手勢）。

**走勢副圖：分時買賣力、大單／小單買賣力**（第 2 批，使用者要求；使用者選定「依成交金額分大單」「走勢副圖、股票＋ETF」；以程式碼為準）：

- 開關：走勢模式的「指標」面板新增「走勢副圖」一區（只在走勢出現）：［分時買賣力］［大單／小單買賣力］兩個開關，開啟大單／小單時才出現門檻選擇（單筆成交金額 ≥ 100／300／500／1千萬／2千萬，預設 500 萬）。存在本機 `sj-mobile-line-indicators-v1`（不改既有 `sj-mobile-indicators-v1`），預設兩個都關閉。指數、期貨、選擇權、權證停用並說明。
- 資料（`lib/line-flow.ts`）：開啟時才以 `fetchHistoryTicks` 下載當日全部逐筆（POST `/api/v1/data/ticks`），O(n) 彙總成每分鐘外盤（tick_type 1）、內盤（tick_type 2）量；之後由既有 `onAnyTick` 累加（沿用頁面的報價訂閱，不另訂閱、不輪詢）。請求期間緩衝即時成交，只接在最後一筆歷史之後（同一時間略過與歷史相同的筆數），不重複、不漏。
- 真實資料核對（唯讀查詢永豐 sidecar，2330，2026-11-06）：25,158 筆、未壓縮 1.5 MB（經 nginx gzip 實際下載約 375 KB）；量的單位為張（加總 97,065＝快照總量）；時間為 ISO 含微秒；tick_type 只有 1／2；沒有試撮筆。單筆金額中位數約 214 萬、前 10% 約 1,052 萬，預設 500 萬能分出大小單。
- **不計入買賣力**：tick_type 0、零股、試撮、09:00 前；**開盤集合競價**（當日盤中第一筆且在 09:00:30 前，不論 tick_type）與 **13:25 起**（收盤集合競價、盤後定價）。集合競價沒有主動買賣方，真實資料開盤那筆 9,656 張標內盤、收盤 5,833 張標外盤，約占全天 16%，計入會讓累積線一開盤就偏移近萬張；冷門股開盤沒有撮合時，09:00:30 之後的第一筆照常計。成交量副圖不受影響。面板說明加註「不含開盤、收盤集合競價」。
- 分時買賣力副圖：外盤正柱（漲色）、內盤負柱（跌色），疊一條累積淨買力線（Σ(外盤 − 內盤)，灰，不顯示座標的疊加刻度）。圖例平時為當日累計「外 N 內 N／外盤比 x%／累積淨 ±N」，輕點或追蹤時為該分鐘（累積值到該分鐘為止）。單位張（寫在面板說明，圖例不寫以免超寬）。
- 大單／小單副圖：依單筆成交金額（價格 × 張 × 1000）≥ 門檻分大單、其餘為小單，兩條累積淨買線（大單紫、小單青）加 0 線。每筆成交對 5 個門檻各記一份，改門檻只重算、不重抓。面板說明「為估算，非實際投資人身分」。
- 版面：副圖排在量之後（量 pane 1、分時買賣力 pane 2、大單／小單其後），外框沿用副圖加高（新增 `frame[3]`），一般模式以 stretch factor 一次把每個副圖校正為 96px（逐一 setHeight 會把差額攤到其他副圖）；全螢幕依比例分配（橫向每個副圖約 28px）。副圖內長按不選價、輕點不出資訊列。讀取中、失敗、尚無成交就地寫在圖例；沒有成交時不建這兩個副圖。
- 請求：關閉時 0；開啟時每檔每日 1 次（記憶體快取，以代碼＋日期為鍵，最多 8 份；換檔、換週期再回到走勢沿用）。失敗不自動重試，重開指標或重新進入走勢且距失敗 ≥ 30 秒才重抓；只有以 `total_volume` 偵測到漏量（例如離開這檔、報價訂閱被釋放後回來）才再抓，最多每 120 秒一次。
- 效能：真實資料 2.5 萬筆彙總約 22 ms（桌機）；JSON 解析與彙總在主執行緒，實機需量測。

**標頭 ☆ 與指標快速範本**（第 1 期；第 2 批 ☆ 改為多清單面板；以程式碼為準）：

- 標頭上半改成［名稱列＋主價列｜☆］兩欄。☆（`trade-watch-star`，44px IconButton）開「加入自選」面板（第 2 批；第 1 期只切換目前清單）：
  - 面板（`components/watch-picker-sheet.tsx`，第一次按 ☆ 才延遲載入）依這台裝置的群組順序列出每個清單：原生勾選框、名稱、檔數，目前清單標「（目前）」。勾選代表商品在該清單（以代碼＋商品類別比對伺服器清單）。按「完成」才送出差異；「取消」或關閉捨棄；沒有清單時顯示空狀態（這裡不建立清單）。
  - 送出依序執行：目前清單走殼層常駐 WatchlistProvider 的 `addSymbol`（帶已載入的合約，不重新解析）／`removeSymbol`；其他清單走 lib 的 `addWatchlistContracts`／`removeWatchlistContracts`（hook 只能改目前清單）。有改到其他清單或有失敗時，最後 `emitWatchlistChanged({ source: 'user' })` 一次，hook 重新讀取（GET 清單＋重新載入目前清單）。
  - 目前清單的移出先檢查 hook 不在載入中／結構更新中、本機列表有這檔（否則 `removeSymbol` 會靜默返回），不符時記為失敗，不回報假的「已移出」。
  - 結果一則 `notify` 摘要（例如「已加入 1 個清單、移出 1 個清單」；失敗時列出清單與原因）。
  - ☆ 實心＝已在任一清單；無障礙名稱如「自選：已在 主要、觀察」「自選：未加入」。清單載入中、更新中、載入失敗、合約未載入、組合商品時停用，原因寫進無障礙名稱；套用中只標 aria-disabled、不設 disabled（IconButton 的 `ariaDisabled`），聚焦中的按鈕不會失去焦點。
  - 長名稱或多徽章時名稱列、主價列可能多換一行（標頭最多高約 35px），不重疊。
- 指標面板「快速範本」：
  - 當沖＝VWAP、MA(5)、MA(20)＋MACD(12,26,9)；波段＝MA(5)、MA(20)、MA(60)＋KD(9,3,3)；長線＝MA(20)、MA(60)、MA(120)＋RSI(14)；三者成交量都開。
  - 套用＝整份取代並寫進 `sj-mobile-indicators-v1`，不跳確認；之後就地顯示「已套用」＋［復原］（一步），復原後焦點回到該範本的套用鍵。
  - 套用後設定再被改動，復原就失效。復原只在面板列表頁有效，進入參數編輯或關閉面板就沒了。

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

**委託操作面板**（`order-action-sheet.tsx`，樣式改用新檔 `styles/order-action.css.ts`，`orders.css.ts` 本塊不動）：流程不變（選單 → 改價／減量／刪單子畫面 → 滑動確認）。頂部 GroupedSection 摘要（方向小膠囊、條件、ProgressBar 成交進度沿用 aria-label、路由、時間、書號）；選單為 ListRow（Pencil「改價」、Minus「減量」、Trash2「刪單」danger；按鈕文字恰為動作名；不可用原因放按鈕外）；子畫面用 Stepper（aria-label「新的委託價格」「新的剩餘數量（張）」沿用）＋footer SlideToConfirm（改價、減量 neutral；刪單 danger；label 文字沿用）＋「返回」文字鍵。`kind` 為 price／qty／cancel 時直接進入對應子畫面（沿用 `openOrderAction(tradeId, kind)`）。面板標題（也是對話框名稱）為「委託操作 名稱 代碼」，與委託明細面板「委託明細 名稱 代碼」一致；名稱還沒到時只有代碼（名稱規則見 §7.6）。

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
- **名稱規則**（委託列、成交列、委託明細與委託操作面板的摘要、帳戶頁已實現損益列；`lib/contract-names.ts`）：商品一律名稱為主、代碼為次（「名稱 代碼」，aria-label 也含兩者）。名稱來源依序為資料本身的名稱（`trade.contract.name`、損益列或玉山成交明細的 name）→ 全域合約快取（`useContract`）→ 都沒有時以 `ensureContract(code)` 查一次。每個不重複代碼本 session 最多查一次，失敗或查到的名稱就是代碼（例如權證）不重試，只顯示代碼。只讀合約，不訂閱行情、不送委託。委託列與成交列的第一行不換行（`orders.css.ts` 的 FIRST_LINE：`flexWrap: 'nowrap'`）：只有名稱以省略號縮短，代碼、買賣膠囊、徽章與時間不縮，名稱到達時列高不變（`orders-first-line.test.ts`）。

### 7.7 持倉（`positions-page.tsx`、`position-summary.tsx`、`position-esun-details.tsx`、`positions.css.ts`）

- 頁首 PageHeader「持倉」＋⟳（6 秒冷卻沿用）；分組型頁面底色。
- 摘要卡（GroupedSection）：caption「未實現損益合計（估）」＋numHero（漲跌色、正負號、PriceFlash、遮蔽時不閃）；下方雙欄股票市值、期貨權益數與風險指標（RatioBar＋等級文字＋狀態色）。
- Segmented toggle［全部｜股票｜期貨｜選擇權］；PopUpButton 帳戶、排序；對帳／ResumeGateNote 用 InlineNote。
- 依帳戶分組：footnote 組標頭（沿用文字）＋GroupedSection；每筆：代碼名稱、條件小膠囊、「多／空 N 張」（實心＋inkStrong）、損益 numMd；第二行均價、現價、報酬率 numSm；股票第三行昨餘、成本、市值（testid 沿用）；損益條改 `transform: scaleX(r)`（中線為 0 往兩側）；動作列［平倉］（**中性外框樣式**，避免與新單買賣鍵混淆）［加碼］［看圖 ›］與玉山「庫存明細」（立即展開＋150ms 淡入）。
- 平倉流程不變（說明面板 → lib 確認面板 → 滑動確認）；加碼跨帳戶先開切換說明面板（沿用）。
- 權證持倉（2026-11 上游同步後）：
  - 權證與股票走同一條下單路徑（lib `contractMarket`），可在持倉頁平倉。
  - 權證沒有零股，有零股時在說明面板前就說明原因。
  - 權證的合約資料沒有漲跌停價，整張平倉是市價 IOC，不需要漲跌停價；只有零股腳需要。
  - 玉山帳戶在說明面板就以玉山規則逐腳檢查。玉山目前不支援權證，超過 499 張的整張腳也一樣，「繼續」停用並寫明原因。
  - 逐筆明細、下單面板與交易頁持倉摘要的權證量單位為「張」。
- 測試：`positions-page.test.tsx:450-451` 由 `style.width === '50%'` 改為 `style.transform === 'scaleX(0.5)'`（唯一必要的斷言更新之一，§14）。

**淨損益、損益兩平價與今日額度列**（使用者要求；計算規則與法源見規格 §6.6；以程式碼為準）：

- 摘要卡 caption 改為「未實現淨損益合計（估）」：股票列加總淨損益（含手續費折數與證交稅），期權加總券商損益。有列無法計算淨損益時不猜，只加總可計算的列並在下方標「合計待確認：N 筆無法計算淨損益，未計入」（`position-total-pending`），全部無法計算時合計顯示「—」；含期權時註明「期貨／選擇權以券商損益計，未扣費稅」（`position-total-deriv`）。全部為股票時的報酬率＝淨損益 ÷ 成本。
- 股票列：主數字為淨損益；行尾（rowMeta）小字並列券商損益（`position-broker-pnl`）。報酬率、分組小計、損益條、「損益／報酬率」排序都用淨損益，整頁一致（`position-metrics.ts` 不改，排序與合計由頁面自行計算）。期權列維持券商損益並標「券商損益・未扣費稅」。
- 「損益兩平」列（`position-pnl-info`，島狀 `islandBg`、≥44pt、整列可點、chevron）：兩平價（依跳動價位格式化）、現價高於／低於兩平價的文字（不只靠顏色），以及標籤：手續費 X 折、當沖稅率 0.15%、「今日已收盤・一般稅率」、「當沖空單未回補」、「未判斷當沖」、「估算」、「未含融資利息」、「融資利息估算」。無法兩平（例如極小額零股空單）時顯示「—」。
- 計算明細面板（`components/position-pnl-sheet.tsx`，點「損益兩平」列開啟，只讀）：成本、買進手續費、預估賣出／回補手續費（依退佣方式說明「月退：最低 20 元也會退佣」或「即折：最低 20 元不打折」）、稅率與稅額、借券費、融資利息（計到 T+2、未計國定假日；缺價分批「估算」、缺股數「未含」）、兩平價、券商損益（未依上列費稅）；估算的項目逐一標示，金額與股數遵守遮蔽金額（兩平價為價格，同均價不遮蔽）。面板內沒有平倉、加碼或下單入口（`positions-page.test.tsx` S1）。
- 今日額度列（`components/account/today-limits.tsx`）：摘要卡下方一行，標籤帶券商名稱「永豐 今日剩餘額度」或「玉山 今日剩餘額度」（玉山的值為「估算剩餘 X」，下方一行「上限 L；今日買進 已成交 A＋未成交 B；估算，玉山只提供上限」），顯示規則同 §7.8。帳戶跟著持倉頁篩選：篩選單一證券帳戶時顯示該帳戶，全部或期貨篩選時沿用目前選取的證券帳戶；只看期貨或沒有證券帳戶時隱藏。點擊以 `openTodayLimits()` 跳到帳戶頁額度卡（§7.8）。查詢同步丟錯時只隱藏這一行（錯誤邊界），非同步失敗顯示「暫時無法取得」；持倉列、合計與平倉入口不受影響。

**詳細｜精簡切換**（使用者要求：單一持股佔太多版面，讓使用者自己決定要看詳細資訊或只看簡單狀態；以程式碼為準）：

- 切換鍵：篩選列行尾的 Segmented toggle［詳細｜精簡］（compact 尺寸、`role=group`、aria-label「持倉顯示方式」、各段 aria-pressed；testid `position-view`、`position-view-detail`、`position-view-compact`）。預設「詳細」，與改版前相同。
- 記住選擇（`lib/positions-view.ts`）：localStorage `sj-mobile-positions-view`，只有值為 `compact` 時是精簡，其他值一律視為詳細；讀寫都 try/catch，沒有 localStorage 也照常運作。點目前已選的那一段不重寫。
- 精簡列（`PositionCompactRow`，整列一顆 button，字級小約 60px 高）：
  - 左欄第一行是名稱（沒有商品資料時顯示代碼），第二行是代碼、條件膠囊（現股、融資、融券、期貨、選擇權）、多空與數量（例如「多 3張+500股」「空 1 口」，文字加顏色）。
  - 右欄第一行是淨損益，與詳細卡片、摘要合計、組小計用同一個值（`rowPnlOf`），漲跌色加正負號。第二行是報酬率，後接兩平狀態文字「已過兩平／未達兩平／等於兩平」。期權顯示「券商・未扣費稅」；無法計算淨損益的列顯示「淨損益待確認」。
  - 第二列（第 2 批，`position-compact-price`、`position-compact-ref`）：「現價 X」＋「兩平價 Y」（股票，依跳動價位格式化，算不出為「—」）；期權沒有兩平模型、不估費用，改顯示「均價 Y」並明確標示。價格不遮蔽（同詳細卡片的均價、兩平價）。只有跳價的那一列重繪。
  - 按鈕的無障礙名稱包含損益名稱（淨損益，或「損益（券商，未扣費稅）」）與報酬率的文字標籤，不只是數字。
  - 金額遮蔽：淨損益與數量走 `maskMoney`；報酬率不含金額，不遮蔽（與詳細卡片相同）。
  - 版面：第二行的代碼、條件膠囊、多空數量都不縮、不省略，空間不夠時整項換到下一行，只有名稱以省略號縮短（左欄 `minmax(min-content, 1fr)`，名稱 `width: 0; min-width: 100%`）。字級「大」時右欄第二行的報酬率與兩平狀態改上下排列。換行會讓列變高：390 寬字級小的股票列約 60px，期權列約 75px；360 寬時期權列最高約 109px（`styles/positions-compact-layout.test.ts`，CDP 以 360／390／430 寬 × 三檔字級實測，沒有截斷或溢出）。
- 展開：點精簡列就地展開該列的詳細卡片（手風琴，`aria-expanded`，展開時 `aria-controls` 指向展開區），再點一下收合；可同時展開多列，展開或收合一列時其他列不會跳動。展開區不重複第一行（代碼、條件、數量、淨損益已在精簡列上），其餘與詳細卡片相同：券商損益、均價／現價／報酬率／昨餘／成本／市值、損益兩平列、損益條、玉山庫存明細，以及平倉、加碼、看圖。展開的淡入與 chevron 旋轉在減少動態時關閉。
- 摘要卡在精簡模式改用 compact 版面（內距與間距縮小、合計改 numLg），內容不變。帳戶分組、組小計、篩選、排序、對帳與 ResumeGate 提示照常。
- 效能：精簡模式只渲染精簡列；詳細卡片只在展開時才掛載（含 `useContract`、兩平列與按鈕），未展開的列沒有詳細卡片的子樹。
- 切換時保留捲動位置：先記下切換鍵在畫面上的位置，內容重排後（`useLayoutEffect`）把位移補回捲動容器，切換鍵不會跳離手指。
- 交易安全：沒有新增送單入口。平倉（說明面板 → lib 確認面板 → 滑動）與加碼（`openTicket` 或切換帳戶面板）完全沿用既有流程（§10 S1）。

**多選市價出清**（第 2 批，使用者要求：多選或全選後市價出清，特別注意現股、融資、融券。使用者選定「預覽＋一次滑動全部送出」、範圍「股票＋期貨」、可跨帳戶；以程式碼為準）：

- 進入：標頭「選取」（`position-select-mode`，aria-pressed）。詳細與精簡兩種檢視的每列都有勾選鍵（`position-select`，button role=checkbox、aria-checked，名稱「選取 代碼 名稱 條件 多空 數量」，≥ TOUCH_MIN；遮蔽金額時名稱裡的數量遮蔽）；帳戶組標頭與底部各有三態「全選」。
- 範圍：股票（現股、融資、融券、現股當沖）與期貨。選擇權不列入，勾選鍵停用並顯示「選擇權不列入批次市價出清，請逐筆平倉」。其他不可列入的原因與單筆平倉相同（`closePlanFor`：商品資料未載入、帳戶不可交易、信用部位非整張、玉山規則等）。
- 選取模式：詳細列整個動作列（平倉、加碼、看圖、庫存明細）隱藏；精簡列不展開、去掉 chevron；點列切換選取。底部配件槽（ShellSlot bottom）：「已選 N 筆」［全選］［取消］與「市價出清 N 筆」。離開選取模式或改篩選時清除選取；已選持倉消失、數量改變或變成不可列入時移出選取並說明。
- 預覽面板（`components/batch-exit-sheet.tsx`，延遲載入，進入選取模式時預載）：
  - 標題「市價出清 N 筆」；依帳戶分組，組標頭＝券商與遮蔽帳號＋環境標籤（正式／模擬／未確認，與路由徽章同一算法）。
  - 每筆列出名稱代碼、條件與多空數量、動作（例如「市價融資賣出」「市價融券買進」）與實際送出的各腳：整張市價 IOC（信用部位帶融資／融券）；零股以跌停（賣）／漲停（買）價盤中零股限價；期貨市價 IOC 平倉。
  - 數量一律明碼，遮蔽金額時也一樣：預覽是送出前唯一看得到數量的畫面，與單筆確認面板相同規則。
  - 警語：市價 IOC 可能以不利價格成交、未成交部分自動取消；非交易時段送出會被券商拒絕。含正式環境帳戶時另有強警示（danger）。
  - 滑塊「滑動送出 N 筆」：任一組環境未確認、單筆平倉或另一個批次進行中、下單面板／委託操作面板／確認進行中、閘門不允許時停用並顯示原因；清單、各組環境、停用原因改變時歸零（拖曳中也中止）。
- 送出（`lib/batch-exit.ts` 的 `runBatchExit`）：滑動一次後依序逐筆送出，筆與筆之間至少 300ms。
  - 每筆送出前以最新持倉重新驗證（同一持倉、數量、方向，`closePlanFor` 重算後相同），不同就「略過（持倉已變動）」並繼續。
  - 閘門（`batchGateProblem`）不允許就停止其餘：手動下單確認設定仍開啟、畫面在前景、與滑動時同一次前景（resumeSeq 沒變）、連線、ResumeGate 允許新單。
  - 每筆仍經 `executeClose`（`placeStockExitByShares`／`placeQuickOrder`，beforeSend＝`closeBeforeSend`）與 lib 的 `requestOrderConfirm`；確認由 `lib/batch-exit-auth` 逐欄比對後自動核准，不顯示確認面板（§10 S10）。
  - 結果：成功＝已送出；確認被拒（內容或環境不符、非預期的確認、等待伺服器模式逾時）＝這筆未送出並中止其餘；未送出（券商拒絕等 mutationNotStarted）＝記錄原因，閘門仍允許就繼續；結果未知＝通知、對帳並停止，不重送（S8）。整張已送出而零股腳失敗時一律算結果未知，不會報成未送出。
  - 執行中面板不可關閉，每筆顯示等待／送出中／已送出／未送出（原因）／略過／結果未知。
  - 「停止剩餘」與離開持倉頁（`abortBatchExit`）：已核准、送出中的那一筆無法取消；尚未核准的那一筆（例如仍在等待伺服器模式）由根層確認面板立即取消；之後不再送。
  - 結束時顯示摘要並送一則只有筆數的通知（全部送出 ok、有結果未知 err、其他 info），然後離開選取模式。
- 請求數：每筆一次確認（lib 每次確認讀一次 `/info`）；股票有整張也有零股時送 2 筆委託，否則 1 筆；期貨 1 筆。
- 已知限制：
  - 非交易時段每一筆都會被券商拒絕成「未送出」，但閘門仍允許，所以會逐筆繼續（全部未成立，沒有風險）。
  - 執行中切換隱私模式會讓帳戶標籤不符而中止整批（保守）。
  - 持倉 id 是列索引：執行中重讀完整快照（手動或對帳）可能讓後續各筆被標「略過」（fail-safe）。
  - 批次是模組層狀態：離開持倉頁後，送出中的那一筆完成前批次仍在進行；這段期間其他流程的確認會被拒絕（顯示已取消），持倉頁的平倉鍵也停用。

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
- 顯示區（`display-card.tsx`）新增「降低透明度：跟隨系統／開／關」Segmented（寫 `ui-settings.transparency`，立即改寫 html 屬性）。本裝置區（`device-settings-section.tsx`）新增「介面觸覺回饋（Android）」Switch（`ui-settings.uiHaptics`）。風控區註腳「此鎖定只對本裝置有效」沿用。2026-11-09 更正註腳：原本寫「不會同步到桌面」，但鎖定存在與桌面共用的 `sj-pro-risk`（同源 localStorage），同一瀏覽器開啟的桌面網頁版也會套用，改為「此鎖定只對本裝置有效（存在這個瀏覽器，同一瀏覽器開啟的桌面網頁版也會套用）；不會同步到其他裝置或其他瀏覽器，也沒有伺服器端總開關。」（`account-page.test.tsx` 鎖住這段文字）。
- 本裝置區新增「圖表長按選價下單」Switch（`device-chart-pick`，`sj-mobile-device-v1` 的 `chartPricePick`，預設關；說明「開啟後長按交易圖表選價位…關閉時長按只看價格。」），交易圖表即時套用（§7.3）。
- HTTPS 說明頁（`secure-context-gate.tsx`、`gate.css.ts`）：仍不建立任何連線；頁面 `overflow-x: hidden`、`overflow-wrap: anywhere`；診斷表 `grid-template-columns: auto minmax(0, 1fr)`；網址與診斷值保留 `SELECTABLE`（已用於 `secure-context-gate.tsx` 與 `diagnostics-card.tsx`）；步驟改編號卡；靜態、無材質、無動畫。裁切原因以 390 寬行動模擬 @2x 重拍確認。
- 第 1 期起說明頁只在非 secure context 時才載入（`app.tsx` 的 MobileApp 以 retryableLazy 載入 `gate/secure-context-gate`）。載入中與載入失敗時顯示最小的靜態說明（`secure-context-gate-fallback`：「需要 HTTPS」「無法下單」）；兩者都不 bootstrap、不開串流、不掛載交易畫面（`secure-context-gate.test.tsx`、`secure-context-gate-lazy.test.tsx`）。

**第二階段實作差異**（以程式碼為準）：

- CollapsibleCard 的標題放在卡片內第一列（整列可點、≥44px、headline 字級、chevron 在右側旋轉），不是移到卡片外的 footnote：已實現損益、玉山帳務概覽、預收／圈存預設收合，標題在卡片外時收合後只剩一行孤立的灰色小字。Card 的標題仍依上文放在卡片外 footnote。
- Switch 開啟色由 success（綠）改為 accent（§4.8 規則 5：accent 用於開關，綠色留給 LIVE 等狀態）。
- Item 的 warn 色調改為 foreground 文字＋amber 圖示，不再用 amber 文字（§4.8 規則 4、§6.11）；warning、badgeWarn、confirmWarn 同樣改為 foreground 文字，amber 只留給左側條與框線。
- 期貨風險指標條與流量條改用 ProgressBar（scaleX，§6.12）；上文沒有列出，但原本的 width 轉場違反「只動畫 transform／opacity」。
- 展開鍵所在列（持倉明細、玉山明細等）文字色由 mutedForeground 改為 accent，提示可點（§4.8 規則 5）。
- HTTPS 說明頁診斷表的值改為靠左對齊（UA、來源等長值換行後較好讀）；區網提示文字與 SELECTABLE 不變。
- `account-page.tsx` 未改：區塊順序與讀取時機原本就符合本節。
- 待實機確認：390 寬 @2x 有無水平溢出；字級「大」時漲跌配色分段（「台灣（紅漲綠跌）」「國際（綠漲紅跌）」）可能放不下（`ui/segmented` 為 nowrap 且不裁切）；淺色主題 smallButton 只靠 e1 陰影分界的對比；dt／dd 固定行高後多行值與標籤頂端對齊的觀感。

**今日剩餘交易額度**（使用者要求置頂；以程式碼為準，本節「區塊順序不變」的原則因此例外）：

- 帳戶頁區塊順序改為：今日剩餘交易額度（`components/account/limits-card.tsx`，置頂）→ 帳號 → 資金（股票＋期貨）→ 交割行事曆 → 已實現損益 → 玉山帳務概覽。讀取與刷新時機不變（共用 `hooks/use-trading-limits`，模組層快取 60 秒、手動重新整理有最短間隔）。
- 顯示規則（`components/account/today-limits.tsx`，持倉頁額度列共用）：永豐以現股今日可用為主值，已用與總額度有資料時一併顯示；玉山只提供上限（lib 會把缺的可用補成上限，不可當剩餘或可用），主值改為「估算剩餘」（下一項）。模擬環境或非 08:30–15:00（`limitsLookEmpty`）顯示「—」並說明，不顯示 0 元。沒有證券帳戶而只選期貨帳戶時，說明期貨沒有每日交易額度。金額遵守遮蔽金額。
- **即時化**（2026-11-09，使用者要求「今日剩餘交易量計算」「即便沒成交但是未成交包含交易量也要及時計算」，玉山選定「只扣買進」；以程式碼為準）：
  - 玉山估算剩餘（`lib/esun-limit-estimate.ts`、`hooks/use-esun-limit-estimate.ts`）：估算剩餘＝現股額度上限 − Σ 該帳戶今日買進委託（已成交＋未成交）。已成交＝逐筆成交 Σ 數量 × 成交價（缺逐筆的差額以委託價估）；未成交＝剩餘量 × 委託價（改價後優先），市價或沒有價格以合約漲停價保守估，仍無法判定價格的不計入並註明。單位：交易狀態中玉山整股／盤後定價以張、盤中零股／盤後零股／興櫃以股（`fromEsunOrderResult`），一律換成股數計金額。已取消、失敗（被拒）只計已成交；結果未知（PendingSubmit、Inactive、帶 `esun_unresolved_failure` 或數量矛盾的列）以未成交計並註明「含 N 筆結果未知的委託」；委託待對帳、委託尚未讀取也會註明。賣出一律不計；融資、融券只列上限。資料只來自既有的額度快取與 `useTradingState().trades`（委託查詢＋玉山回報投影），回報一到就重算，不另發任何查詢。額度卡主值「現股 估算剩餘」＋「估算」徽章，下方「上限 L；今日買進 已成交 A＋未成交 B」，卡片說明改為「玉山只提供額度上限；估算剩餘以本 App 委託清單中今日的買進委託（已成交＋未成交）計算，賣出不計，可能與券商數字不同。」；持倉頁一行、下單面板（現股「估算剩餘額度 X 元」）用同一個估算與同一份文字，金額一律 maskMoney。模擬環境或空資料照舊顯示「—」。
  - 永豐自動重查（`hooks/use-trading-limits.ts`）：永豐證券帳戶的委託列在共用交易狀態中新增或狀態、成交量、取消量、價格改變（新委託回應、刪改單、成交）→ 只重查該帳戶。去抖 2 秒合併連續事件（持續不斷時最晚在第一筆後 6 秒）；絕不違反 10 秒最短間隔（排在最早允許的時間）；事件後已有任何查詢開始就視為已涵蓋；只查正在顯示的帳戶（沒有顯示時記下，顯示時補查一次）；頁面隱藏時不查，回到可見補查一次；第一次讀到委託只當基準。期貨與玉山帳戶不因事件重查。
  - 瀏覽器假資料實測（360 寬字級 1.3）：玉山新單 3 張 @1,050 → 部分成交 1 張 @1,045 → 刪單，估算剩餘依序 $5,000,000 → $1,850,000 → $1,855,000 → $3,955,000，每步回報後 63～109ms 更新，期間額度查詢 0 次；永豐首次查詢後 7.9 秒的事件在 10.0 秒重查（最短間隔），21.9／22.9／23.9 秒的連續事件合併成 26.0 秒一次；送單、改單、刪單 0 次，無水平溢出。首屏 JS +12 bytes（`order-mapping` 多匯出 2 個既有函式與延遲 chunk 改名，程式碼都在延遲載入的帳戶、持倉、下單 chunk）。
- 從持倉頁額度列跳來（`openTodayLimits()`）：卡片掛載時消化跳轉請求，把捲動與聚焦延到 `queueMicrotask`，在殼層 `ScrollRestorer` 還原記住的捲動位置之後才 `scrollIntoView` 並聚焦（`preventScroll`），StrictMode 下只執行一次（`account-page.test.tsx`）。不發額外請求。
- 已實現損益列的商品名稱：名稱為主、代碼為次，規則同 §7.6 末的「名稱規則」；玉山列直接用成交明細的名稱，不查詢。

**已實現損益自訂區間**（第 3 批，使用者要求「帳戶損益查詢增加自訂日期範圍但最大範圍不能超過限制」；以程式碼為準）：

- 期間改為五個：今日／本週／本月／近 30 天／自訂（`PNL_PERIODS`）。五個等寬分段在 360 寬放不下（字級 1.3 時「近 30 天」會壓到鄰段），改用 `ui/segmented` 新增的 `wrap` 變體：與 scroll 同樣的膠囊，放不下時換行，列間 8px（擴張點擊區不重疊）。
- 選「自訂」時出現起日、迄日兩個原生 `<input type="date">`（手機開系統日期選擇器）；`<label>` 包住 input，可見標籤即無障礙名稱；外觀沿用 `numberInput`（≥44px、≥16px 字級），字級 1.3 改單欄。`max`：迄日＝台北今天、起日＝迄日；`min`：起日＝迄日 − 179 天。min／max 只是選擇器提示，手動輸入仍由程式驗證。
- 驗證（`lib/account-pnl.ts` `customRangeProblem`，依序）：「請選擇起日。」／「請選擇迄日。」；「起日不是有效的日期。」／「迄日不是有效的日期。」；「迄日不能晚於今天（YYYY-MM-DD）。」；「起日不能晚於迄日。」；「區間最多 180 天（目前 N 天）。」。不合法時沒有查詢 key：「查詢」停用、原因以 role=status 顯示在日期欄下方（input 標 aria-invalid 並以 aria-describedby 關聯），不送出任何請求，也不自動修正日期。
- 上限：兩家券商一律最多 180 天、含起訖日（迄日 − 起日 ≤ 179），比 lib 的 `clampEsunDateRange180Days`（允許相差 180 天）更嚴，所以玉山查詢區間永遠不會被裁切，畫面上的區間就是實際查詢的區間。
- 起訖存在模組層（本次使用期間保留，切換期間或離開帳戶頁再回來都還在；不寫 localStorage 等任何 storage）；第一次切到自訂帶近 30 天（今天 − 29 到今天）。日期列顯示目前區間與天數（「2026-10-11 ～ 2026-11-09（台北日期，共 30 天）」），結果以區間為 key，列表永遠對應這一列。
- 讀取：切到自訂或改了起日／迄日就是新的區間 key，回到「按「查詢」讀取」，按「查詢」前 0 個請求；送出的 begin／end 就是畫面上的起訖日。
- 頻率：所選帳戶含玉山時，所有已實現損益查詢（不分區間）共用滑動視窗「任意 60 秒最多 4 次」（`PNL_ESUN_QUERIES_PER_MIN`；`lib/account-on-demand` 的 gate `{ name, max, windowMs }`）；滿了「查詢」停用並顯示到最舊一次滑出視窗的剩餘秒數（與冷卻倒數取大者），玉山說明改為「玉山已實現損益最長查詢 180 天，每分鐘最多查詢 4 次。」。依據：bridge 的 `profit_loss_limiter` 限 10 次／分，只在快取未命中時取額度（`_cached_query`：single-flight 填充鎖之後、快取鍵＝日期區間、TTL 10 秒）；每次查詢發出 2 個同區間 GET `/esun/portfolio/profit-loss`（列表＋彙總），通常只占 1 個額度、最壞 2 個，4 次 ≤ 8 < 10，留空間給同一個 bridge 上的桌面版。只有永豐帳戶時不套用視窗，維持原本「同一區間＋帳戶 30 秒不重查」。

**交易環境（玉山模擬／正式切換）**（2026-11-09，使用者要求「手機板切換模擬/正式讓手機板也可以設定切換」；以程式碼為準）：

- 位置：帳戶 › 連線，「玉山重新連線」之後（`components/account/env-switch-section.tsx`）。永豐列唯讀（`/api/v1/info` 的 simulation），附說明「改 .env 的 SJ_PRODUCTION 後執行 docker compose up -d 重新啟動；手機與桌面都只顯示、不能切換」。玉山列顯示目前環境（切換中、未連線、環境未確認另有文字）；下方兩個選項列沿用帳戶切換面板的列樣式＋環境膠囊：目前環境打勾、停用；沒有設定檔的選項停用並寫「未提供 esun-config.*.ini（不可選）」；共同的擋下原因寫在選項下方。
- 確認面板：切正式＝danger InlineNote「正式環境的委託是真實下單，會動用真實資金與庫存。」＋SlideToConfirm（danger），沒有可直接切換的按鈕；切模擬＝主要按鈕「確定切換至模擬環境」（風險降低的方向、不會動用真實資金，仍是「點選項 → 面板內按確定」兩步，與 §10 S2 只把滑動留給真錢動作一致；桌面切模擬甚至不需確認）。切換中面板不可關閉（dismissible false、取消停用、Esc 無效）。開啟面板時重新讀一次 bridge health：bridge 停止時 lib 仍保留舊的 health，不重讀會被當成已連線；讀取中與讀不到時停用；關閉面板時就把探測結果歸零，下次開啟的第一次渲染不會沿用上次的結果。
- 擋下條件（`lib/esun-env-switch.ts` 的 `esunSwitchBlock`，依序）：切換進行中（mobile-store 的 `envSwitch` 或 `getSnapshot().switching`）、重新連線進行中、正在確認 bridge、bridge 未連線／停止、另一個裝置或分頁正在切換（health `envSwitchInProgress`）、登入熔斷鎖定、`health.ok` 為假、目標設定檔不存在、已是目前環境、下單面板開啟（`getMobileUi().ticket`）、委託操作面板開啟（`orderAction`）、委託確認進行中（`getPendingOrderConfirm()`）、多選出清進行中（`isBatchExitActive()`）、新單／平倉／刪單送出中（`lib/trading-activity.ts` 的 `beginOrderDispatch` 計數：`submitMobileOrder`、`executeClose`、批次刪單與全部刪單——含全部刪單先讀委託的階段——整段都計入；lib 的確認在送出前就結束、新單送出也不經 `onTradeMutation`，所以「下單面板開啟」與「委託確認進行中」都不足以涵蓋送出中的新單與單筆平倉）、刪改單送出中（首屏 `lib/trade-mutation-tracker.ts` 開機就訂閱 lib `onTradeMutation` 的 begin／settled，含同源其他分頁；120 秒未 settled 視為結束）、牽涉玉山的待對帳（`esunReconcilePending`：委託或持倉 needsReconcile，且原因訊息是玉山／bridge 的，或有「刪改單結果待確認」且交易狀態裡有玉山委託或沒有帳戶的委託列——lib 的原因沒有帳戶資訊，後者保守視為牽涉玉山；換環境後舊環境帳戶就讀不到、無法核對。原因只有玉山回報串流中斷時仍擋，但說明改為「玉山回報串流中斷，恢復連線（或按『重新檢查玉山』）後才能切換」）。面板內即時顯示原因；滑動或按確定的當下 `runEsunEnvSwitch` 再判斷一次，被擋下時不送出並通知原因。
- 送出與之後（同桌面 `header-env-menu.tsx` 的 runEsunSwitch）：只呼叫 `esunTradeService.switchEnvironment(target)`，而且只有這一個 await 在 try 裡；成功後 `invalidateAllQueries()`、`refreshTradingStateForModeChange()`、通知「環境切換：已切換玉山證券至○○環境（設定檔）」各自包住，任何一步丟錯都不會把成功回報成失敗，然後關閉面板。bridge 明確回錯誤（409 委託處理中／剛有委託／忙碌、設定檔不存在、登入失敗…）＝確定失敗：再讀一次 health（看到目標環境才算已切換），通知「環境切換失敗」＋bridge 原文，面板保留並顯示。回應逾時、連線中斷、閘道錯誤（HTTP 5xx 沒有 bridge 本文）、回應格式錯誤＝結果不明（文字判斷有契約測試 `esun-switch-error-contract.test.ts`：以假 fetch 走真正的 HttpEsunDriver／EsunTradeService 產生這些訊息）：進入「環境切換結果確認中」（玉山閘門不放開），依 `ESUN_HEALTH_RECHECK_DELAYS`（2／4／8／16／30 秒）重讀 health——看到目標環境＝已切換（照成功處理，通知註明「回應遺失，已由 bridge 狀態確認」）；最後讀到的是原環境且 `envSwitchInProgress` 為假＝失敗（註明已確認仍為原環境）；bridge 仍在切換或一直讀不到＝「環境切換結果未知」，請使用者到帳戶 › 連線確認目前環境。重讀排程刻意走完、不提早判失敗：排隊或延遲的切換請求可能在提早結束之後才開始，等完整個排程才是誠實的結果。玉山帳戶換成新環境的帳戶（模擬帳戶 broker_id 帶 `-SIM`）與選取帳戶的對應由 esunTradeService（`replaceExternalAccountsForBroker`）處理，與桌面同一條路徑。交易額度、玉山帳務概覽、已實現損益、交割款的快取鍵都含 broker_id 或環境，切換後讀新鍵；帳戶路由徽章在清單與單筆面板（持倉列、平倉說明、委託列與委託操作面板、委託詳細、批次刪單、多選出清）改以該列帳戶判斷環境（`route-badge.tsx` 的 `rowRoute`／`useRowRoute`），切換後殘留的舊環境列不會被標成目前環境；下單面板仍顯示即時路由。同時只送一次。切換與結果確認中「玉山重新連線」停用。
- 換頁也擋得住、只擋玉山（深度審查 CRITICAL-1；複審 2a）：確認面板是帳戶頁的狀態，系統返回手勢或改 hash 會卸載它；切換狀態因此放在首屏的 mobile-store（`envSwitch`），殼層（`app.tsx`）在第一次切換時掛載根層 `EnvSwitchOverlay`（`components/env-switch-overlay.tsx`），之後保持掛載，不隨路由卸載；它的模組由帳戶頁 chunk 靜態帶入（開始切換時已在記憶體），殼層以 lazy 取用，載入失敗時不渲染（送單閘門仍有效）。等待 bridge 回應（switching，前端最長 30 秒）時是不可關閉的面板（layer confirm、背景 inert）蓋住畫面：這段期間玉山帳戶與路由隨時會換、玉山資料不可信，時間有上限，也是使用者剛按下切換、本來就在等待的時候；結果確認中（checking，最長約 60 秒）改為不攔操作的橫幅（層級 `Z.sheet - 1`，在所有面板之下：打開的面板一律蓋過它，下單面板第一列的環境標示保持可見，§10 S6；最終實測發現原本的 `Z.toast - 1` 會蓋住面板頂端後修正）（`env-switch-banner`，role=status），永豐照常可用；帳戶頁的確認面板此時也可以關閉（只顯示「正在確認是否已切換」，結果另外通知），玉山閘門不因關面板而放開。送單閘門只擋玉山帳戶（`assertNoEnvSwitch(account)`；帳戶不明時視同玉山）：`submitMobileOrder`（確認前、確認後、beforeDispatch）、`executeClose`／`closeBeforeSend(account)`、委託操作面板的改價／減量／刪單（呼叫 lib 前與刪單的 beforeSend）、一律丟出「玉山環境切換中，這筆玉山委託沒有送出（永豐不受影響）」（mutationNotStarted）；委託頁批次刪單（含玉山委託時整批不送，呼叫前與每筆 beforeSend）與全部刪單（有玉山帳戶時不送）是一整批，連永豐也沒送，改用專用文字「玉山環境切換中，整批（含永豐）都沒有送出；請稍後再試或改為逐筆刪單」。`openTicket`／`openOrderAction` 不再擋（永豐要能下單）；玉山帳戶的下單面板以 `ticketProblem` 的「玉山環境切換中，暫時不能送出玉山委託」停用預覽。lib 的改價、減量沒有 beforeSend，切換開始後才進入 lib 的那一筆由 bridge 拒絕（下一項）。
- bridge 端互斥（`server/esun_trade_server.py`，複審後改為只在換 session 的瞬間互斥）：網路登入期間（`client.login()` 沒有逾時參數，SDK 不提供）舊 session 照常服務所有委託，包括正式環境的刪單；登入成功後才標記「換 session 窗口」（`_claim_swap_window`），在 `SWITCH_SWAP_DRAIN_SECONDS`（15 秒）內等進行中的委託請求結束、且距最後一筆委託回應滿 `MUTATION_QUIET_SECONDS`（10 秒）再安裝新 session；等不到就先結束窗口、再直接丟掉新 client（它還沒開 WebSocket；不呼叫 `logout()`——SDK 的 logout 是否有全域影響未驗證，可能弄壞仍在使用的舊 session）回 409 `ESUN_MUTATIONS_IN_FLIGHT`，原 session 不變。成功時 session 指標一換好就結束窗口（`_install_session` 的 after_swap），關舊 WebSocket、開新 WebSocket 時不持有。窗口內新的委託請求（HTTP 層 `try_begin_request_mutation`，與窗口在同一個條件鎖下）回 409 `ESUN_SWITCH_IN_PROGRESS` not_sent，直接呼叫時 `_mutation_prelude` 也拒絕，沒有委託跨越 session 交換。切換開始時若有委託進行中回 409 `ESUN_MUTATIONS_IN_FLIGHT`、最後一筆真正送到 SDK 的委託回應後 10 秒內回 409 `ESUN_RECENT_MUTATION`（附 retryAfter；讓刪單後的確認讀取與兩腳平倉不被另一個裝置的切換拆開；在 HTTP 層或 prelude 就被拒絕的請求——切換中、環境不符、session 失效、頻率限制——不重設靜默期）。所有離開路徑（200／400／409／429／502／503／例外）都清除標記。`/esun/health` 新增 `envSwitchInProgress`（切換持有 session 鎖期間為真），手機據此判斷結果與擋下第二個切換。409 的文字原樣顯示在手機面板（其他分頁、桌面同樣受保護）。
- 狀態列帳戶切換面板底部改為「永豐模擬／正式由伺服器部署決定，只能顯示；玉山可在帳戶 › 連線切換。」＋［玉山模擬／正式切換］：關閉面板、跳到帳戶頁本區塊並聚焦（`lib/account-jump.ts`，作法同今日額度跳轉）；本身不切換環境，也沒有第二個切換介面。
- 瀏覽器假資料實測（360 寬、字級 1.3）：模擬 → 正式（點把手一下不送出；滑動後切換中面板不可關閉）→ 狀態列、持倉頁、委託頁變正式、選取帳戶 8840-SIM → 8840；切回模擬時 bridge 回登入失敗，面板顯示錯誤、環境不變；再按確定切回模擬；bridge 停止、登入鎖定、bridge 異常、正式設定檔不存在都停用並說明；委託請求 0。
- 體積：首屏 gzip 223,496（main 42fad7de）→ 223,713（+217 B：mobile-store 的切換狀態、刪改單追蹤、狀態列連結與匯出綁定）；加上下一條的伺服器未連線提示後實測 223,999（14 個 JS，距 ≤219 KiB 目標 224,256 剩 257 B，之後首屏新增需先刪減）；根層面板（含橫幅樣式）與 `trading-activity` 是延遲 chunk，帳戶頁 chunk 約 +3.1 KB。曾試過把面板與閘門模組放進首屏：rolldown 會把 mobile-store 另切成共用 chunk，首屏多約 1.1 KB 超出預算，因此改為延遲載入面板。
- 伺服器未連線提示（2026-11-09，移植上游 #384）：帳戶 › 連線的永豐區塊（連線世代下方）在串流中斷過且尚未回到 LIVE 時顯示與狀態列連線面板相同的 warn InlineNote（`components/server-down-hint.tsx`，判斷共用 `lib/server-down-hint.ts` 的模組層狀態：狀態列先看到 down、之後才開帳戶頁且重連中，也會顯示）。用語與上方永豐唯讀說明一致（改 .env 的 SJ_PRODUCTION → docker compose up -d）；不發請求、沒有按鈕（S1）。首屏 gzip 223,639 → 223,962（+323 B，文字與 InlineNote 包裝都在首屏的狀態列）。

### 7.9 市場（`#/market`、`#/market/signals`，`routes/market-page.tsx`）

第 1 期把底部「產業」分頁改為「市場」（以程式碼為準）：

- 頁首「市場」＋Segmented tabs［產業流向｜盤中異動］。第三段「大盤節奏」是第 2 期，不顯示也不放佔位。
- 路由：`#/market`＝產業流向、`#/market/signals`＝盤中異動。舊書籤 `#/sector` 解析為 `#/market`，以 replace 正規化。內部 MobileTab id 由 `sector` 改為 `market`。
- 切換分段用 `navigate(..., { replace: true })`，不新增歷史紀錄；底部分頁仍是一般導覽。
- 兩個分段的根元素不同，切換時頁首重新掛載：切換前焦點在分段上時，掛載後把焦點移到新選取的分段（觸控點擊沒有聚焦時不搶焦點）。
- 市場分頁連結帶回本 session 上次的分段（sessionStorage `sj-mobile-market-segment`，例外時回到產業流向）。
- 產業流向只在該分段掛載（下方原本的產業流向內容不變）；切到盤中異動時卸載並釋放它的訂閱。兩個分段根元素不同，切換時頁首重新掛載，分段拇指沒有滑動動畫。

#### 產業流向（分段一，`routes/sector-page.tsx`）


- 資料來源（重用桌面既有的純資料邏輯，不修改 `src/lib`）：`lib/sector-flow-ic` 的 `useIcSectorFlow(true)` 在本頁掛載期間 retain 上市（IX0001）／上櫃（IX0043）的群組指標串流（成交值、加權漲跌兩個投影），並由 `icFlowRecorder` 記錄每分鐘資金流向（成交值增量 × 加權漲跌方向）；`lib/index-components` 的 `getIcState` 提供名稱、加權漲跌、成交值（建底快照或串流，`calculated_at` 新者勝）。建底查詢由 lib 依 ADR 0001 管理，本頁不自行查詢、不輪詢、不逐檔查詢。畫面最多每秒依 store 重算一次。
- 版面：PageHeader「產業流向」；市場 Segmented（上市｜上櫃）；「資金流向摘要（自開啟本頁起）」GroupedSection，流入前 3、流出前 3；排序 Segmented scroll（資金流向｜近5分｜漲跌幅｜成交值，第 6 批，見下）；產業列 GroupedSection「上市 N 個產業」。列：第一行產業名稱＋加權漲跌（漲跌色）；第二行「成交」「5分」（近 5 分淨流入）「累計」（累計淨流入）；下方淨流入橫條（中線為 0，流出往左、流入往右，scaleX）。點列開產業說明面板（BottomSheet）：加權漲跌、成交值、成分檔數、占本市場產業成交值合計、漲幅名次、建底參考權重、近 5 分與累計淨流入、每分鐘累計淨流入走勢，全部來自既有資料（0 個額外請求）；「今日」之後另列成分股（見下）。每次進入回到「上市」；排序記在這台裝置（第 6 批）。
- 產業列排序（第 6 批，2026-11-09，使用者要求「市場-產業流向新增排序功能」；`sector-model.ts` 的 `sortSectorRowsBy`）：原本五段（資金流入、資金流出、漲幅、跌幅、成交值）改為四個對應列上數字的選項——資金流向（累計淨流入）、近5分（近 5 分淨流入）、漲跌幅（加權漲跌）、成交值；再點目前的選項＝反向（選中的段顯示 ↓／↑，無障礙名稱含目前方向與再點一次的方向）。換選項時一律由大到小（流入、漲、成交值大的在前）。預設資金流向 ↓（由淨流入到淨流出），與原本的預設「資金流入」順序相同。沒有資料（null；流向不可用時資金流向、近5分一律視為沒有）的列不論方向都在最後；同值依成交值大到小、再依產業代碼。偏好存在這台裝置 localStorage `sj-mobile-sector-sort-v1`（`{ key, dir }`，上市、上櫃共用；讀寫失敗只在本次有效）。只排序頁面上已有的資料，0 個請求。摘要前 3 與漲幅名次仍用原本的內部排序。
- 說明文字：「資金流向自開啟本頁起累計（離開本頁的時段不計入），以每分鐘成交值增量依加權漲跌方向估算。」`icFlowRecorder` 是 lib 共用且依交易日保存、沒有公開的重設方法，同一交易日離開後再進入時累計會接續前一段（離開的空窗不計入）。
- 流向狀態（`sector-model.ts` 的 `flowStatusOf`，是否顯示只看有沒有量到成交值增量，與時段無關）：
  - live：盤中、已量到 → 顯示流向。
  - ended：收盤、已量到 → 保留今日量到的流向，提示「已收盤・以下為今日開啟本頁期間量到的資金流向（離開本頁的時段不計入）。」
  - waiting：盤中、還沒量到 → 流向「—」，說明收到更新後顯示。
  - closed：收盤、沒有量測（盤後才開啟、週末、休市）→ 流向「—」並說明非交易時段；漲跌與成交值仍以最近一次建底快照顯示。
- 錯誤、重試與冷卻（`components/sector/sector-retry.ts`）：
  - 429：顯示「今日資料額度已用盡」，不自動重試，盤中收到即時串流後自動補上。
  - 非 429 建底錯誤：顯示錯誤與［重試］。錯誤後 60 秒內再進入本頁不 retain（不自動建底、不訂閱），提示即時更新暫停；冷卻結束或按［重試］才開始 retain。
  - ［重試］是租約：以 retain 再持有一次到頁面卸載（不 retain 後立刻 release）。只有建底失敗時，retain 一條訂閱正常的投影（只加 ref-count，不送 subscribe）觸發 lib 重新建底；有投影訂閱失敗時只 retain 失敗的那條，實際重送 1 次 subscribe，卸載時與頁面本身的 release 一起只退訂 1 次。其他投影的錯誤提示不會被清掉。
- 成分股（第 5 批，2026-11-09，使用者問「產業流向 可以看到個股的嗎」；`components/sector/sector-members.tsx`）：說明面板「今日」之後、資金流向之前列出該產業成交值前 10 檔。
  - 資料：與桌面「產業全景」下鑽相同的群組內排行投影 `retainIndexComponents(指數, { kind: 'ranking', target: 'component', metric: 'amount', order: 'desc', limit: 10, group })`（published matrix 每組最多 10 檔）。每列 `IcRankingEntry` 已有價格、漲跌、漲跌幅、成交值、權重，不另訂個股行情；建底已就緒時立即由建底快照投出，串流更新隨頁面每秒重算。
  - 訂閱：面板開啟時 retain 1 條，關閉、換產業、換市場、離開本頁時 release（subscribe 1、unsubscribe 1，不重新建底）。產業頁在建底錯誤冷卻中（`sector-retry.ts`）時不 retain，只顯示已快取的列（沒有時「暫無成分股資料。」）；訂閱失敗只顯示原因，不自動重試。
  - 排序：預設成交值由大到小；［成交值｜漲跌幅］（Segmented compact）只重排同一批 10 檔，卡片下方說明。
  - 列：名稱＋代碼（名稱到達前只顯示代碼）｜成交價（漲跌色；漲跌停時同報價列的實心底＋小標）；第二行成交值、權重、漲跌與漲跌幅。名稱只為面板中實際看得到的列查合約（`lib/contract-names`，同盤中異動）；查到的合約也帶漲跌停價。投影為試撮時不標示漲跌停。
  - 點列：關閉面板並 `navigate` 到交易頁；沒有下單、改單、刪單入口（S1）。
- 交易安全：產業列與說明面板沒有任何下單、改單、刪單入口（`sector-page.test.tsx` S1）。延遲載入（頁面 chunk 加 `sector-flow-ic` 共用 chunk），列入殼層閒置預載。

#### 盤中異動（分段二，`components/market/market-signals.tsx`）

- 延遲載入的獨立 chunk，市場頁掛載後閒置時預載（不在殼層預載清單，首屏 0 位元組；省流量時不預載；iOS 沒有 requestIdleCallback，掛載當下就抓）。
- 資料：`lib/market-pulse` 的 scanner 訊號（retainMarketPulseStreams 只掛上既有 SSE 的監聽，不另開連線）；以 `subscribeMarketSignal`／`unsubscribeMarketSignal` 訂閱「規則 × 市場」鍵（`components/market/signal-subscriptions.ts`）。
- 訂閱只在盤中異動分段掛載且頁面在前景時：離開、切換分段、退到背景或卸載時，對成功的鍵各退訂 1 次；失敗的鍵不退訂（lib 沒有替它加 ref-count）。回前景依目前篩選重新訂閱。
- 釋放寬限 1.5 秒（`RELEASE_GRACE_MS`，模組層，同行情訂閱的釋放寬限）：釋放的鍵先寄放，寬限內再要（切回盤中異動分段、篩選來回切換、短暫切到背景）就沿用原本的訂閱，不送 unsubscribe 與重新 subscribe；寬限結束才退訂。失敗的鍵不寄放。
- 篩選：訊號家族（漲跌停、急漲跌、爆量、狀態）多選 Chip＋市場（上市、上櫃）；存 localStorage `sj-mobile-signal-filters-v1`；預設與桌面相同：急漲跌＋上市＋上櫃（8 個鍵，全選 26 個）。篩選改變只送差異。
- 狀態列「已訂閱 n/m」；部分失敗用 InlineNote warn 說明不會自動重試＋［重試］（只重送失敗的鍵）；串流重連遺漏用 InlineNote「串流重連期間遺漏 N 筆訊號（起–迄）」。
- 列（最新在前，最多 100 列，畫面每 500ms 最多依 snapshot.version 重算一次）：第一行名稱＋代碼｜（試撮徽章）成交價；第二行時間・上市／上櫃・訊號文字（方向色輔助）・補充（急漲跌幅度、爆量金額、觸發價）｜漲跌（帶正負號與漲跌幅）。
- 名稱（第 5 批，2026-11-09 改，使用者要求「盤中異動股票要加股票名字」）：先讀記憶體（合約快取、ETF 內建目錄、上市櫃公司目錄）。部署環境的 nginx 沒有 `/metadata/*` 路由（回 SPA 的 index.html，200 text/html），公司目錄讀不到；因此仍沒有名稱的「可見」列以 `lib/contract-names` 向永豐查一次合約：整段共用一個 IntersectionObserver（`quote-row` 的 `useVisibilityTracker`＋`contract-names` 的 `useVisibleRowName`）、每個代碼本 session 最多 1 次、同時 ≤2、排隊中變不可見就取消（不算用掉）、失敗不重試，不讀外部網站。名稱到達前只顯示代碼，之後「名稱 代碼」。`useContractName` 一律訂閱該代碼的合約快取，名稱來自非響應式來源時合約到達也會重繪。
- 沒有訊號時說明：盤中異動只在交易時段即時推送；只列出本分段開啟期間收到的訊號，離開或 App 在背景的時段不會補上（lib 保留最近 250 筆，再次進入會看到之前收到的）。
- 交易安全：點列只 `navigate({ name: 'trade', code })`；沒有下單、聲音、震動（前景提醒是第 2 期）。

---

## 8. 手勢歸屬與放手計算

| 區域 | 歸屬 | 規則 |
|---|---|---|
| 面板把手與標題區 | 面板 | 垂直 1:1；起點符合 `DRAG_EXCLUDE_SELECTOR` 不拖；放手用 `sheetReleaseDecision` |
| 面板內容區 | 原生捲動 | 本輪不接手下拉（第二輪需實機原型） |
| 滑塊把手 | 滑塊 | `touch-action: none`＋pointer capture；面板永遠不接手 |
| 圖表（`data-allow-pinch`） | lightweight-charts | 水平平移、雙指縮放、長按 450ms 選價；垂直滑動捲頁；其他區域的雙指一律由 gesture-guard 擋（不變） |
| 清單列 | 列 | 點擊、長按 500ms（移動 >10px 取消，沿用）；垂直為捲動。自選編輯模式只有握把能拖，列的其他區域照常垂直捲動 |
| 自選編輯模式握把 | 握把 | `touch-action: none`＋pointer capture；移動 >4px 才算拖曳；被拖的列以 transform 跟手指、其他列以 transform 讓位（減少動態時不做讓位動畫）；靠近 main 可視上下緣 56px 內自動捲動（底部扣掉分頁列與配件槽）；放手位置有變才呼叫 `reorderSymbol` 一次；pointercancel／失去 capture 還原；拖曳中與放手後 350ms 擋下列點擊與長按；停用條件見 §7.2 |
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
| S1 | 送出只有一條路：新單＝預覽 → `requestOrderConfirm()` 確認面板滑動；改價／減量／刪單／全部刪單／批次刪單＝各自面板滑動；平倉＝說明 → lib 確認面板滑動；多選市價出清＝預覽面板滑動一次，每筆仍經 `requestOrderConfirm()`、由批次授權逐欄比對後自動核准（S10）；解除鎖單＝滑動。所有新入口只呼叫 `openTicket`／`openOrderAction`／開說明面板 | mock `src/lib` 的送單、改單、刪單函式：自選操作面板「買進…／賣出…」、列上改價／減量／刪單 Chip、五檔點價、圖表選價、持倉加碼 → 只呼叫 openTicket／openOrderAction，lib 送出函式呼叫次數 0 |
| S2 | 門檻只看放手位置；armDelay；中止條件 | 0.7 高速甩動（帶 timeStamp）放手 → 不送；越過 0.8 退到 0.75 放手 → 不送；未就緒期間 pointerdown 無效（以 `SheetPresenceContext` 提供 `settled:false` 並 stub 時鐘）；lostpointercapture、visibility hidden、presence 退場 → 歸零不送；既有 8 個案例不改 |
| S3 | 手勢互不干擾 | 面板 grabArea 起點為 `[role=slider]`、input、button 時不拖；拖曳後 350ms 內 click 被攔下 |
| S4 | 退場凍結 | 以 `createNodeMock` 提供 `{ style:{}, isConnected:true, getBoundingClientRect }` 並注入假時鐘：確認面板核准後 → panel testId 為 `order-confirm-sheet-closing`、`aria-hidden`、`inert`、滑塊 disabled、再觸發 onConfirm 不會第二次 `resolveOrderConfirm(true)`；退場中新請求到達 → 新 entry id、滑塊重置、armDelay 重新計時；use-mobile-ticket 在 presence 退場中遇到 not-sent → `notify` 而非 setFeedback |
| S5 | 不可關閉就真的關不掉 | dismissible=false：grab pointerdown＋pointerup、點暗化幕、Esc（sheet-stack）、關閉鈕皆不呼叫 onClose；既有 T6 四案不改 |
| S6 | 方向與環境一定看得到 | ticket：`data-tone`、`ticket-direction` 文字、方向鍵 aria-pressed、CTA 文字同步；RouteBadge 在第一列；確認面板 `confirm-env`；面板 max-height 不超過 `--sj-sheet-top`；有面板時通知為頂部精簡模式 |
| S7 | 顏色規則 | 靜態檢查：`src/mobile` 不出現 `wickUp`、`wickDown`、`flash-up`、`flash-down`、`fontWeight: 800`、漲跌 hex；§4.8 對比表以單元測試重算（ink 後 ≥ 門檻） |
| S8 | 結果未知 | 不提供重送鍵（沿用 `order-ticket-sheet.test.tsx:643`）；warn 在疊放中為前景、淘汰時最後被淘汰、按住暫停 TTL；needsReconcile 時委託分頁有 amber 點 |
| S9 | 不擴張範圍 | 程式審查清單：無一鍵下單、圖上拖曳改價、價格拖曳、觸價／括號／條件單、無確認的批次市價平倉（多選市價出清須預覽並滑動一次，S10）、背景執行、標頭滑動換商品、列滑到底執行 |
| S10 | 批次授權只核准使用者預覽過的內容（第 2 批） | `lib/batch-exit-auth` 是唯一會自動核准確認的地方：只在批次進行中、每筆 arm 一次（核准後立即清除），且代碼、買賣、數量、市價（price null）、單位、信用名稱、無 livePriceCode、帳戶標籤（決定當下以 `accountConfirmLabel` 重算）、環境（等於預覽顯示的布林值，null 一定不符）都相符、modeUnavailable／serverChanged 皆為假時才核准；其他請求一律拒絕並中止整批。等待伺服器模式最多 10 秒（計時器設旗標，不比對牆鐘）。使用者停止或離開持倉頁（`abortBatchExit`）時取消尚未核准的那一筆。批次中確認面板不渲染；沒有批次時行為不變。測試：`batch-exit-auth.test.ts`、`order-confirm-sheet.test.tsx`（批次段）、`batch-exit.test.ts`、`positions-page.test.tsx`（多選市價出清、S1）；瀏覽器以假資料實測送出內容（§16） |

S1 的新入口與測試對照（都 mock `src/lib` 的送單、改單、刪單函式並斷言 0 次）：

| 入口 | 允許的呼叫 | 測試 |
|---|---|---|
| 排行列尾快速下單鍵、星號 | 下單鍵只 `openTicket`（不帶方向、source other）；星號只加入自選 | `ranking-list.test.tsx` |
| 自選清單增減與排序（＋、重新命名、刪除清單、列首「−」、加入股票、握把） | 只做清單管理與開搜尋面板 | `watchlist-edit.test.tsx` |
| 交易頁「公司」分頁（關聯公司、外部連結、子分頁、重試） | 只 `navigate` 與開外部連結，不呼叫 `openTicket`／`openOrderAction` | `company-tab.test.tsx`；`trade-page.test.tsx` 的 S1 另加「切到公司後點全部」一輪 |
| 產業頁與產業說明面板 | 沒有下單入口；按遍所有按鈕 | `sector-page.test.tsx` |
| 委託列、成交列、委託操作面板的名稱顯示 | 列上 Chip 只 `openOrderAction` | `orders-names.test.tsx` |
| 持倉「損益兩平」列與計算明細面板、今日額度列 | 只開唯讀面板或導覽到帳戶頁；面板內沒有平倉、加碼鍵，平倉流程不變 | `positions-page.test.tsx` |
| 持倉「詳細｜精簡」切換、精簡列與展開 | 切換只改顯示方式；精簡列只展開或收合；展開後的平倉、加碼沿用既有流程（說明面板或 `openTicket`） | `positions-page.test.tsx` |
| 交易頁當沖資訊列、「籌碼與當沖」面板（含［重新查詢］） | 只開唯讀面板；［重新查詢］只重讀融資融券與券源 | `trade-chips-sheet.test.tsx`；`trade-page.test.tsx` 的「TradePage 當沖資訊列」，以及原本按遍全頁按鈕的 S1 |
| 公司分頁「估值與體質」卡 | 沒有按鈕 | `valuation-card.test.tsx` |
| 自選編輯鍵延遲載入（佔位、［重試］） | 只做清單管理；［重試］只重新 import | `watchlist-deferred.test.tsx`、`watchlist-edit-preload.test.tsx` |
| 市場頁分段、盤中異動篩選、［重試］、訊號列 | 分段只 `navigate`（replace）；訊號列只 `navigate({ name: 'trade', code })`；POST 只有 scanner 的 subscribe／unsubscribe | `market-signals.test.tsx`、`market-page.test.tsx` |
| 排行新種類、篩選晶片 | 只切換與過濾；列尾下單鍵、星號沿用原規則 | `ranking-list.test.tsx` |
| 指標快速範本（套用、復原） | 只改圖表設定 | `indicator-sheet.test.tsx` |
| 自選列與排行列日內區間小條 | 不可點；點列只開交易頁 | `quote-row.test.tsx` |
| 交易頁標頭 ☆ 與「加入自選」面板（勾選、取消、完成） | 只開面板；面板只呼叫 hook 的 `addSymbol`／`removeSymbol`（目前清單）、lib 的 `addWatchlistContracts`／`removeWatchlistContracts`（其他清單）與 `emitWatchlistChanged` | `trade-page.test.tsx`、`watch-picker-sheet.test.tsx`、`trade-watch-picker-lazy.test.tsx` |
| 交易圖表輕點資訊列（輕點、✕、再點同一點）、走勢成交量副圖與「圖表長按選價下單」設定（帳戶 › 本裝置，預設關） | 只顯示資訊；量副圖內長按不選價；設定關閉時長按只看價格（走勢／K 線、直向／全螢幕都不浮出選價列，`openTicket` 0 次）；開啟時長按選價列流程不變；Switch 只寫本裝置設定 | `trade-chart.test.tsx`、`device-settings-section.test.tsx`、`mobile-device-settings.test.ts` |
| 走勢點價格軸切換漲跌停範圍、「漲跌停範圍」按鈕 | 只改 Y 軸範圍與價格線，不出資訊列、不選價、不呼叫送單函式 | `trade-chart.test.tsx` |
| 自選多選刪除、全選、確認面板、排序群組（↑↓、握把） | 只做清單管理（`removeSymbol`）或裝置偏好（localStorage），不開下單或委託面板 | `watchlist-multi.test.tsx`、`watchlist-group-sort.test.tsx`、`watch-edit-controls.test.tsx` |
| 自選頁「持倉」分段（點列、長按面板、快速下單鍵、分段切換、「前往持倉頁」） | 只呼叫 `navigate` 或 `openTicket`（只開下單面板，之後仍需預覽與滑動確認），沒有任何編輯入口 | `holdings-list.test.tsx`、`watchlist-holdings-lazy.test.tsx` |
| 走勢副圖指標（分時買賣力、大單／小單的開關與門檻） | 只改本機設定與讀取當日逐筆（唯讀），不呼叫送單函式、不開下單面板；副圖內長按不選價 | `indicator-sheet.test.tsx`、`trade-chart.test.tsx`、`line-flow.test.ts` |
| 排序群組的多選刪除群組（選取、勾選、取消、刪除、返回、確定刪除） | 只刪除自選清單（lib `deleteWatchlist`、hook `deleteCurrentList`），不呼叫送單、改單、刪單，也不開 `openTicket`／`openOrderAction` | `watchlist-group-delete.test.tsx`、`watch-group-delete.test.tsx` |
| 持倉選取模式（選取、勾選、全選、取消、開關預覽） | 滑動前不送單、不開下單面板與委託面板；送出只在預覽滑動後經 `runBatchExit` → `executeClose`（S10） | `positions-page.test.tsx` |
| 帳戶 › 連線「交易環境」（選項、確認面板、滑動、確定、取消）與狀態列［玉山模擬／正式切換］ | 只呼叫 `esunTradeService.switchEnvironment()` 與切換後的 `invalidateAllQueries`／`refreshTradingStateForModeChange`；不呼叫永豐或玉山的送單、改單、刪單，也不開下單或委託面板 | `env-switch-section.test.tsx`、`account-switch-env-link.test.tsx` |
| 通知中心（狀態列鈴、面板、［全部清除］兩段、SheetLoadError 重試） | 只開唯讀面板與清除記憶體通知紀錄 | `status-bar-notices.test.tsx`、`notice-center-sheet.test.tsx` |
| 漲停／跌停標示（報價列、交易頁主價）、盤中異動名稱查詢、產業說明面板成分股（排序、點列） | 只改顯示；名稱只讀合約（`ensureContract`）；成分股只 retain／release 群組內排行投影，點列只關面板並 `navigate` 到交易頁 | `quote-row.test.tsx`、`trade-page.test.tsx`、`market-signals.test.tsx`、`sector-page.test.tsx`（S1） |
| 已實現損益自訂區間（期間膠囊、起日／迄日、查詢） | 只改起訖日（模組層）或發出唯讀損益查詢（`fetchProfitLoss`／`fetchProfitLossSummary`），不呼叫送單、改單、刪單，也不開下單或委託面板 | `account-page.test.tsx`、`account-pnl.test.ts`、`account-on-demand.test.ts` |
| 自選固定清單「股期近月／遠月」（分頁、點列、長按面板、快速下單鍵、［重試］）與清單排序（排序鍵、選項面板、［⟳］） | 點列只 `navigate`；下單鍵與買賣只 `openTicket`（實際月份代碼，之後仍需預覽與滑動確認）；排序只改顯示順序與本裝置偏好，不寫回伺服器清單 | `futures-list.test.tsx`、`watchlist-futures-sort.test.tsx`、`mobile-order.test.ts`（實際月份合約） |
| 持倉分段排序（排序鍵、選項面板、［⟳］）與產業列排序（四個排序段、再點反向） | 只改顯示順序與本裝置偏好；持倉排序只發排序依據的批次快照，產業排序 0 個請求；不呼叫送單、改單、刪單，也不開 `openTicket`／`openOrderAction` | `holdings-sort.test.tsx`、`sector-page.test.tsx`（S1）、`sector-model.test.ts` |

---

## 11. 無障礙

- 觸控：所有可點元素 ≥ `max(44px, 2.75rem)`；compact 元件以擴大點擊區達成且不重疊；買賣相關鍵 ≥56px、間距 12px。
- 字級：全部 rem；三檔字級逐頁驗收不截斷；大字級版面切換由 `html[data-sj-font-scale]` 控制。
- 焦點：焦點環 2px accent offset 2px（著色面板與材質上 foreground）；面板 `role=dialog`、`aria-modal`、`aria-labelledby`，焦點移入、Tab 循環、關閉還原；背景 inert＋aria-hidden。
- 宣告：即時價格不放 aria-live；只宣告方向動作（ticket-direction）、鎖單變化、連線狀態（2 秒去抖）、停用原因、批次進度；通知沿用 alert／status。
- 手勢皆有按鈕等價物：長按操作面板 ↔ 編輯模式「更多操作」鈕；滑塊 ↔ 鍵盤（與 AT 後備）；通知滑走 ↔ 關閉鈕；自選握把拖曳排序 ↔ 操作面板的上移、下移、移到最上，以及握把上的 ↑／↓（一次一格、忽略自動重複，移動後焦點回到握把）。
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
- 自選改版後，每次進入自選頁的請求上限如下（自選清單本身由 WatchlistProvider 常駐讀取，不另計）：
  - 處置清單 GET ≤1（30 分鐘內 0）。
  - 指數快照 POST ≤1（10 分鐘內 0）。
  - 合約解析 0。
  - Quote 訂閱：指數 2 筆，加上可見列。
  - K 線 POST：每個可見的可交易列 ≤1；休市時段補找時 ≤2；同時 ≤2；關閉開關時 0。
  - 送單、改單、刪單 0。
  - 清單管理（新增、重新命名、刪除清單、移除、排序）只在使用者操作時發出；排序每次放手（或每按一次方向鍵）是一次 `reorderSymbol`（GET＋PUT＋GET），方向鍵忽略自動重複。
- 每次進入「排行」分段（排行本身的讀取沿用 30 秒快取、15 秒冷卻）：
  - 處置清單 GET ≤1（與自選共用模組層快取，30 分鐘內 0；沒有排行資料時不讀）。
  - 合約 GET（只為迷你走勢）：每種排行最多「捲到可見、且不在合約快取的不同代碼數」個，上限 30；同時 ≤2、同一代碼去重；失敗後 5 分鐘內不重試；同 session 已解析的代碼 0；開關關閉時 0。
  - K 線 POST：只給可見且合約已在快取（或剛解析完成）的股票列，每檔每時段上限與佇列同自選；開關關閉時 0。
  - Quote 訂閱 0（排行是快照資料）；送單、改單、刪單 0。
- 交易頁「公司」分頁（都只在切到「公司」之後才發生）：
  - shioaji-data（經 `lib/company-data`，sha256 驗證＋IndexedDB 快取）：manifest 每 10 分鐘 ≤1；公司檔、財報、themes、market、sources 各 ≤1（記憶體或 IndexedDB 命中時 0）；entities 只在切到上下游或展開名單時 ≤1。按［重新檢查］或［重試］強制重抓 manifest 1 次。
  - 上下游即時漲跌（只在「上下游」子分頁且 active）：快照 POST 每批 ≤20 檔、同代碼 30 秒內不重讀；行情訂閱每檔 Tick＋BidAsk 兩筆，最多 20 檔＝40 筆，離開子分頁或切走時釋放（`RELEASE_GRACE_MS`）。
  - 個股期貨／選擇權：active 時訂閱標的公司報價 1 檔；股票與本頁同一檔共用 refcount，0 筆新訂閱。
  - 合約解析 0；送單、改單、刪單 0。
- 每次進入產業頁：
  - 群組指標訂閱 4 筆（2 指數 × 2 投影；離開時退訂 4 筆）。
  - 建底 POST `/api/v1/data/index_components`：每指數每 session 首次 ≤1（共 ≤2），日切再 1；503 暖機由 lib 既有退避重試；429 不重試。再次進入、切換市場、重連時 0。
  - 非 429 建底錯誤後 60 秒內再進入：0 筆（不 retain、不訂閱）。手動［重試］每按一次：建底失敗的指數建底 1 筆；訂閱失敗的投影各 subscribe 1 筆（離開時與原本的一起只退訂 1 筆）。
  - 產業說明面板成分股（第 5 批）：每次開啟（不在冷卻中）subscribe 1、關閉 unsubscribe 1；建底 0。名稱：面板中看得到、且合約不在快取的不同代碼各 1 次合約查詢（base＋info 兩個 GET；session 內每代碼 1 次、同時 ≤2），最多 10。
  - K 線、報價 0；送單、改單、刪單 0。
- 委託、成交、已實現損益的名稱查詢：每個不重複代碼本 session 最多 1 個合約 GET（資料本身有名稱或合約快取命中時 0；失敗不重試）；FUT／OPT 合約解析時 lib 會連帶預取升降單位表。
- 持倉頁今日額度列：共用 `use-trading-limits` 模組層快取（60 秒 TTL、手動最短 10 秒），每個證券帳戶每 60 秒最多 1 次查詢，與帳戶頁額度卡、下單面板共用；期貨帳戶不查。淨損益與兩平價是純計算，新增請求 0。
- 交易頁當沖資訊列與「籌碼與當沖」面板（第 1 期）：
  - 每次進入交易頁：處置清單 GET ≤1，只有 STK 且頁面在前景；與自選頁共用模組層快取，30 分鐘內 0。資訊列其他請求 0。
  - 開面板（只有 STK）：credit_enquire POST 與 short_stock_sources POST 各 ≤1，以每檔每個台北交易日計（`lib/trade-chips`）。credit_enquire 與下單面板共用 `loadCreditEnquire` 的成功快取。
  - 失敗不自動重試；使用者每按一次［重新查詢］，只重讀失敗的那一項各 1 次。
  - 期權與指數 0；送單、改單、刪單 0。
- 估值與體質卡：新增請求 0（用同一份財報檔）；P/B 用公司分頁已有的報價（同一檔 refcount）。
- 每次進入盤中異動分段（或回到前景）：
  - scanner subscribe：每個「規則 × 市場」鍵 1 次（預設 8、全選 26）；篩選改變只送差異；離開、切換分段、退到背景時對成功的鍵各 unsubscribe 1 次。
  - 釋放寬限 1.5 秒：寬限內切回分段、篩選來回或短暫切到背景都是 0 個請求；超過寬限才退訂，之後再進入照上列計。
  - 失敗不自動重試；［重試］每按一次只對失敗的鍵各送 1 次。例外：lib `updateCapabilitySubscription` 對暫時性錯誤（逾時、5xx）本身會退避重試 2、4、8、15 秒，單一鍵單次 subscribe 最多 5 個 POST（桌面相同，lib 既有行為）。
  - SSE 不另開連線；名稱（第 5 批）：仍沒有名稱的可見列各 1 次合約查詢（base＋info 兩個 GET；session 內每代碼 1 次、同時 ≤2、失敗不重試），上限為捲到可見範圍的不同代碼數（最多 100 列）；`/metadata/equity/*` GET ≤3（與搜尋共用，60 分鐘內 0）。
  - K 線、報價訂閱、快照 0；送單、改單、刪單 0。產業流向分段的請求同原本「每次進入產業頁」，只在該分段顯示時發生。
- 排行新種類只在使用者切到那一種時讀同一個 scanner 端點（同快取與冷卻）；篩選、日內區間小條、指標範本新增請求 0；☆ 只在點擊時走既有的自選新增／移除流程。
- 前景憑證到期提醒（每個台北日最多一次，請求發出前記下日期）：GET `/api/v1/health` ≤1（有永豐帳戶時；帳戶頁 60 秒內讀過或讀取中就沿用）；GET `/esun/ca_expiretime` 每位玉山 person_id ≤1；失敗不通知、當天不重試。通知中心本身新增請求 0。
- 低階 Android 預設降低透明度；Chrome DevTools 4× CPU 降速下面板拖曳、滑塊、自選 200 列捲動 p95 幀時間 ≤16.7ms、無 >50ms long task；實機 30 分鐘記憶體不持續成長。
- 首屏 JS（gzip）增量估計：spring＋tween 0.9、gesture 0.9、prefs／haptics／ui-settings 0.5、sheet-stack＋sheet-context 0.5、BottomSheet v2 增量 2.0、SlideToConfirm v2 增量 0.6、ToastHost v2 增量 0.9、殼層（slots、捲動記憶、html 屬性、狀態列）0.9、Segmented＋IconButton＋PageHeader 0.7、新增 lucide 圖示約 9 個 1.5 → **合計約 9.4 KiB**（目標首屏 ≤218 KiB，上限增量 10 KiB）。Stepper、DirectionToggle、QuickChips、PopUpButton、Grouped、InlineNote 等落在既有 lazy chunk。CSS（gzip）增量 ≤12 KiB。
- 量測：`pnpm exec vite build --config vite.fork.config.ts` 後依規格 §9.4 加總 `dist/mobile.html` 引用的 script 與 modulepreload gzip 大小，PR 附前後數字。
- **實測**：第二階段後手機首屏 JS（gzip）226.3 KiB，超出本節目標。收尾後降為 **214.7 KiB**（16 個 JS），已在目標 ≤218 KiB 內。作法：
  1. `vite.fork.config.ts` 在合併後把 lucide-react 排除出上游 vendor 群組，各入口只載入自己用到的圖示，約 −8 KiB。找不到上游 vendor 群組時不改。
  2. 自選頁「排行」分段延遲載入（`lib/deferred-modules.ts`，retryableLazy＋ModuleErrorBoundary＋閒置預載），約 −3 KiB。
  - 桌面 `index.html` 771.6 → 772.3 KiB；`approval.html` 79.2 KiB 不變。
  - 加入快速切換商品後：手機首屏 213.1 KiB（13 個 JS），mobile 入口 chunk 多 0.13 KiB（共用搜尋 hook），新面板只在延遲載入的交易頁 chunk（約 +2.6 KiB）。
  - 自選改版後：手機首屏 211.3 KiB（13 個 JS）。迷你走勢（約 3.2 KiB gzip）與搜尋面板（約 4.0 KiB）改為延遲載入並閒置預載；只延遲走勢時是 215.1 KiB。（2026-11 上游同步後：搜尋面板本身 1.4 KiB，另需上游搜尋本體 `product-search` chunk 約 18.7 KiB，含 ETF 目錄；兩者都延遲載入並閒置預載。）
  - 加入排行同自選列、自選增減與排序、公司分頁、產業頁、名稱與額度、淨損益與兩平價後（最終整合實測）：手機首屏 **216.5 KiB**（16 個 JS），在目標 ≤218 KiB 內；桌面 `index.html` 771.7 KiB、`approval.html` 79.2 KiB。首屏會帶入 `quote-row.tsx`、`watch-reorder.ts`（自選頁靜態匯入）與產業分頁圖示、路由；JS 檔數由 13 變 16（審查時觀察到 bottom-sheet 成為獨立 chunk），增量未逐一拆分到各項功能。公司分頁（company-tab、use-company-data 與其 CSS）、產業頁（頁面 chunk、`sector-flow-ic` 共用 chunk 與 CSS）、清單名稱面板、損益明細面板都延遲載入，不在首屏（各代理整合前量測：公司分頁約 9.1＋6.6 KiB JS、2.2 KiB CSS；產業頁約 4.8＋6.0 KiB JS、1.2 KiB CSS）。距上限只剩約 1.5 KiB，之後再加首屏程式碼前需先拆分。
  - 刻意留在首屏的狀態列面板：帳戶切換、連線詳情與 ResumeGate 確認、解除鎖單。帳戶切換試過延遲載入，只省約 0.3 KiB，但載入中點了沒有回饋、殼層不會 inert，晚到的面板會疊在其他面板上並搶走焦點，所以撤回。
  - ~~已知小問題：排除 lucide 後有一個 77 bytes 的 vendor 轉接 chunk，檔名帶 rolldown 去重尾碼（雜湊 9 碼），不符合 nginx 長快取規則，會以 no-cache 提供。~~ 已修正（2026-11-06）：nginx 長快取 regex 接受第 9 碼為數字的雜湊檔名（`deploy/test_nginx_template.py` 以實際建置輸出驗證，見 [mobile.md](mobile.md#nginx-安全設定2026-11-06-安全稽核後補強)）。

**效能稽核後的優化**（2026-11-06；稽核以 headless Chrome、4× CPU 降速、390 寬量測，冷啟動 FCP 896ms、LCP 1512ms；以程式碼為準）：

- **延遲載入不再第一次掛起**（P3）：`retryableLazy` 新增 `preload()`。預載完成後第一次進入分頁或開面板直接渲染元件、不經 `React.lazy`，所以沒有「載入中」閃一下，也沒有 React 約 300ms 的 Suspense 揭示節流。預載失敗只吞掉，不標記失敗：之後照常走 lazy，失敗時仍由 ModuleErrorBoundary 顯示［重試］。殼層閒置預載對 5 個分頁與下單、委託操作面板改呼叫各自的 `preload()`；自選頁內的迷你走勢、搜尋、清單名稱面板、排行仍只預抓 chunk（第一次掛載會 suspend 一次，迷你走勢的 fallback 是同尺寸空白）。
- **閒置預載逐一排程**（P10，`lib/idle-prefetch.ts`）：原本同一個 idle callback 一次發出 11 個 `import()`（約 305 KiB gzip，並在約 2.2 秒處有 55–75ms 長任務）。現在每個模組各自一個 `requestIdleCallback`（timeout 2 秒），前一個載入結束才排下一個；沒有 `requestIdleCallback`（iOS Safari）時第一個在原本 1.5 秒的計時器中執行，之後間隔 100ms。`navigator.connection.saveData` 為真，或 `effectiveType` 為 slow-2g／2g／3g 時，只預載迷你走勢、下單面板與交易頁，其他等點擊再載。卸載殼層時取消尚未執行的排程。
- **數字格式化快取**（P1，`lib/num-format.ts`）：`toLocaleString(locale, options)` 每次都重建 Intl 格式器（headless Chrome 約 10–17µs／次），是交易頁與持倉頁重繪的最大 JS 熱點。手機版高頻路徑（五檔、明細、交易頁統計格與持倉摘要、圖表游標與線標籤、持倉頁、損益明細、玉山庫存明細、自選列、排行、委託頁、帳戶格式）改用以 locale＋選項為 key 快取的 `Intl.NumberFormat`（Node 微基準：帶選項 32.5µs → 0.57µs）。`src/lib` 不改，所以 `formatToTick`、`fmtInt`、`fmtCompactInt`、`fmtStockLots` 在手機版另有等價實作，以 4 萬筆以上的向量逐字比對 lib 版本（`num-format.test.ts`）；`fmtStockLots` 的張數照 lib 用執行環境預設語系，其他固定 en-US。**新程式請勿在渲染路徑直接呼叫帶選項的 `toLocaleString`**。
- **交易狀態只由葉節點訂閱**（P2）：持倉商品每筆成交，lib 都會重估市價並發布整份交易狀態。交易頁改由三個葉節點各自 `useTradingState()`：圖上的線（線的內容 key 沒變時沿用同一陣列，搭配 `memo(TradeChart)`）、五檔的委託標記（只傳 trades 給 `memo(DepthLadder)`）、持倉摘要與未成交筆數。持倉市價重估時標頭、五檔、圖表都不重繪（`trade-page.test.tsx` 以渲染次數驗證）。持倉頁的詳細列與精簡列用 `memo`＋只比該列實際用到欄位的比較函式（`rowPropsEqual`、`compactRowPropsEqual`；持倉物件比參考，淨損益比數值與結構），沒有跳價的列不重繪；本頁最大損益改變時全部列重繪以更新損益條比例。列的平倉、加碼經穩定的 `rowActions` 轉給最新一次提交的處理函式，略過重繪的列不會拿到過期的帳戶或閘門狀態（有專門測試）。
- **前後量測**（同一台機器、同一套 mock，headless Chrome 4× CPU 降速，自選 20 檔，每項量 10 秒；ae21ebc0 對 1e470f3）：
  - 交易頁每秒 10 筆：JS 237 → 111 ms/s，主執行緒 570 → 455 ms/s。
  - 交易頁每秒 50 筆加其他 7 檔：JS 261 → 112 ms/s，主執行緒 628 → 450 ms/s。
  - 持倉頁每秒 50 筆：JS 149 → 102 ms/s，主執行緒 360 → 314 ms/s。
  - 自選頁大致持平（每秒 300 筆 181 → 186 ms/s，在誤差內）。
  - 兩次都只有零星 1 筆 64–88ms 長任務。主執行緒其餘時間主要是樣式、版面與繪製（P12，需實機 trace 再處理）。
- **首屏**：本輪後手機首屏 **217.7 KiB**（16 個 JS），仍在 ≤218 KiB 內但只剩 0.3 KiB。增加的 1.2 KiB 是殼層必須常駐的閒置預載排程、`preload()` 與快取格式化（`lib/utils/ticksize` 原本就在首屏，沒有重複帶入）。桌面 `index.html` 771.6 KiB、`approval.html` 79.2 KiB 不變。**之後再加首屏程式碼前必須先拆分**，候選：自選編輯模式才用到的 `watch-reorder.ts` 改延遲載入。
- **上游同步後**（2026-11-06，上游 65 個提交）：手機首屏 **218.9 KiB**（16 個 JS），**超過本節目標 0.9 KiB**，仍遠低於規格 §9.4 的 400 KB。增加的 1.2 KiB 全在共用的 `src` chunk（上游 lib：搜尋改版、權證市場分類等），手機自有 chunk 沒變。下一步：把 `watch-reorder.ts` 拆成編輯模式才載入（`useListReorder` 由列表元件一直呼叫，需把編輯模式列表拆成延遲元件，另案處理）。桌面 `index.html` 802.7 KiB（上游新功能）、`approval.html` 79.3 KiB。
- **第 1 期**（2026-11-08）：
  - 第 0 步：自選編輯模式的編輯鍵與拖曳排序延遲載入（§7.2），首屏 218.9 → **217.6 KiB**（15 個 JS）。
  - 加入估值卡與當沖資訊列後：首屏 217.8 KiB（223,015 bytes，16 個 JS）。兩者都在延遲載入的 chunk：
    - 交易頁 chunk 21.7 → 22.9 KiB。
    - 「籌碼與當沖」面板約 3.6 KiB。
    - `volume-ratio` 共用 chunk 約 9.5 KiB（lib 的 volume-ratio、day-range 等），隨交易頁載入。
  - 螢幕常亮 `lib/wake-lock` 改為開關開啟且瀏覽器支援時才動態載入（`hooks/use-wake-lock`；開關預設關閉）：首屏 −494 bytes → 222,521 bytes（217.3 KiB）。帳戶頁設定區塊照常匯入同一個模組顯示狀態；載入完成前關掉開關或卸載不會啟動。
  - 加入「市場」分頁與盤中異動後：222,681 bytes（+171：分頁圖示與路由；市場頁 6.6 KiB＋CSS 1.2 KiB 取代原產業頁 5.5 KiB，盤中異動 4.2 KiB＋CSS 0.9 KiB、market-pulse 1.0 KiB，都延遲載入）。共用的 `stock-runtime-catalog` chunk 12.2 KiB（含 ETF 內建目錄）由搜尋與盤中異動共用，`product-search` chunk 因此由 19.3 降為 7.7 KiB。
  - 加入排行新種類與篩選、指標範本、日內區間小條、交易頁 ☆ 後：222,909 bytes（+228，全部來自自選列的日內區間小條；其餘都在延遲載入的 chunk）。
  - 加入通知中心與憑證提醒後：223,299 bytes（+390：精簡鈴路徑、未讀數訂閱、延遲面板外殼與載入入口），超出 218 KiB 目標 67 bytes。
  - 「需要 HTTPS」說明頁改為只在非 secure context 才載入（§7.8）：**222,187 bytes（217.0 KiB，15 個 JS）**，第 1 期全部功能加入後仍在目標內，剩約 1.0 KiB。
  - 深度審查修正後最終：222,197 bytes（217.0 KiB，15 個 JS）。
  - 桌面 `index.html` 802.9 → 805.2 KiB（38 → 43 個 JS）、`approval.html` 79.3 KiB 不變：桌面程式碼沒有改，但手機延遲載入的 chunk 與桌面共用了 lib 模組（`contract-cost`、`credit-eligibility`、`market-pulse`、`stock-runtime-catalog`、`volume-ratio`），rolldown 把它們拆成共用檔，桌面多 5 個請求，gzip 多約 2.3 KiB（raw 只多 1.4 KiB）。
  - 注意：在延遲載入的 chunk 新增 `.css.ts`，或匯入被打包在別的 chunk 的 tokens，會讓首屏 mobile.js 的預載對照表變長（約 +20 bytes）。
- **第 2 批**（2026-11-08：持倉精簡價格與多選市價出清、圖表輕點資訊列、自選多選刪除／☆ 多清單／排序群組，含深度審查修正）：首屏 **222,429 bytes（217.2 KiB，15 個 JS）**，在 223,232（218 KiB）內，剩約 0.8 KiB。
  - 首屏新增：批次授權 `lib/batch-exit-auth` 與確認面板的批次路徑（確認面板在首屏）、自選群組順序 `lib/watch-list-order` 與重繪接線、`emitWatchlistChanged`、編輯模式列的換行規則。自選編輯說明文字移進編輯 chunk，抵掉一部分。
  - 延遲載入（gzip）：持倉 chunk 24.0 KiB（第 1 期約 19.8 KiB）；出清預覽面板 2.0 KiB＋CSS 0.6 KiB（只有開預覽才載入，進入選取模式時預載）；自選編輯 chunk 5.6 KiB（含多選與排序群組）；☆ 面板 1.7 KiB＋CSS 0.5 KiB（交易頁再延遲載入）；圖表資訊列在交易頁 chunk（25.2 KiB）。
  - 預覽面板用自己的 `batch-exit.css.ts`、部分勾選用 CSS 橫線、☆ 面板用原生勾選框：避免與其他 chunk 共用 lucide 圖示或樣式而拆出新的共用 chunk，讓首屏預載清單變長。
  - 之後加入排序群組的多選刪除群組（常駐 WatchlistProvider 多了 `getLatestMobileWatchlist`、首屏 src chunk 多匯出 `deleteWatchlist`）與走勢成交量副圖（全在交易頁 chunk）：首屏 **222,513 bytes（217.3 KiB，15 個 JS）**，剩約 0.7 KiB。
  - 再加入走勢副圖指標（分時買賣力、大單／小單，全在交易頁 chunk）：首屏 **222,512 bytes**（不變）；交易頁 chunk 25.2 → 29.8 KiB。
- **第 3 批**（2026-11-08，自選頁「持倉」分段）：首屏 **222,666 bytes（217.4 KiB，15 個 JS）**，+154 bytes：分段標籤、lazy 入口與預載項目、預載對照表多兩個 chunk（holdings-list 1.9 KiB、與持倉頁共用的 position-text 0.6 KiB）。剩約 0.55 KiB。
- **第 3 批**（2026-11-09，走勢 X 軸固定與漲跌停範圍，全在交易頁 chunk）：首屏 **222,495 bytes**（不變，差異為 chunk 雜湊的 gzip 浮動）。
- **第 5 批**（2026-11-09，漲停／跌停標示、盤中異動名稱、產業成分股）：首屏 **222,772 bytes（15 個 JS）**，+85（相對 main 222,687；含後續排行以 change_type 標示與窄螢幕排行列 CSS）：`quoteLimit` 判斷、列上的 class 切換與無障礙名稱、`limitPrice` 兩個 class；「漲停／跌停」文字放在 CSS `::before`，不佔 JS。名稱查詢佇列（`lib/contract-names`）與成分股清單都在延遲載入的 chunk。試合併量測：＋股期固定清單（PR #12）**223,247 bytes**；＋PR #12＋今日額度即時化（PR #13）**223,254 bytes**，都在下一行調整後的 ≤219 KiB（224,256 bytes）內。
- **首屏目標調整**（2026-11-09，主代理決定）：手機首屏 JS（gzip）目標由 ≤218 KiB（223,232 bytes）放寬為 **≤219 KiB（224,256 bytes）**。原因：使用者要求的功能必須放在首屏共用程式碼——QuoteRow 的漲停／跌停標示（第 5 批）與股期固定清單的分頁與排序入口（PR #12），兩者都已先壓到最小（文字放 CSS、邏輯延遲載入）；之後任何首屏增量都要先在首屏刪減等量位元組。
- 未處理（需要修改 `src/lib`，R2 不允許，列入 §16）：trading-state 每筆 tick 重算全部持倉並發布、每秒以 BroadcastChannel 傳出整份 state（P2 根因、P14）；SSE 第一次連線就發 RECONNECT 合約刷新，冷啟動同一份合約抓 3 次（P4）；自選快照等全部合約 info 才讀，LCP 被最慢的一筆卡住（P5）；首屏帶入 Tauri 橋接、閃電下單模組、MockEsunDriver 與玉山整合（P6、P7、P8、P15，稽核估計合計約 50 KiB gzip）。
- **第 3 批**（2026-11-09，已實現損益自訂區間）：首屏 **222,529 bytes**（+17：segmented 的 wrap 變體在首屏 `ui/segmented`；卡片、日期欄、驗證與玉山視窗都在延遲載入的帳戶頁 chunk），在 223,232 內。
- **第 4 批**（2026-11-09，自選固定清單「股期近月／遠月」與排序）：首屏 **223,125 bytes（15 個 JS）**，+439：兩個分頁標籤、兩個 lazy 入口、顯示順序與排序鍵槽、固定清單時隱藏編輯入口、排序檢視隱藏上移／下移；清單與排序邏輯都在延遲載入的 `futures-list`（3.3 KiB gzip）與 `watch-sort`（2.8 KiB gzip）chunk，在 223,232 內。
- **第 6 批**（2026-11-09，持倉排序、產業列排序；以 accept/p5＝main＋PR #12／#13／#14 為基準 223,263）：首屏 **223,278 bytes**（+15），在 ≤219 KiB（224,256）內；持倉排序在延遲載入的 `holdings-list`（靜態匯入 `watch-sort`）、產業排序在市場頁 chunk，沒有新的首屏程式碼（差異為 chunk 雜湊的 gzip 浮動）。

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
| **刻意更新 5** `routes/watchlist-page.test.tsx`（自選改版） | 列訂閱斷言、清單選擇器、排行分段、「不讀 K 線」、表頭指標三案 | 使用者要求依參考圖改版：列訂閱斷言排除底部指數列的 IX0001／IX0043（可見列判斷不放寬）；PopUpButton 改分頁（`watch-list-tabs`）；「不讀 K 線」改為「走勢關閉時不讀 K 線」，並如實計算處置清單、指數快照、Quote 訂閱；膠囊改第二行文字，三態改兩態。S1、兩段式移除、長按與操作面板「買進…／賣出…」的斷言不變 |
| **刻意更新 4** `styles/primitives.test.ts`（B4） | `controls.routeBadge` 的鍵為 production／simulation／unknown | 舊 `routeBadge` 匯出已無引用並刪除（樣式在 `route-badge.css.ts`，§6.5），刪除該斷言；button、tradeButton、滑塊的斷言不變 |
| **刻意更新 6** `routes/trade-page.test.tsx`（公司分頁） | 分頁 aria-label「五檔與明細」；S1 的 clickAll 跳過「明細」 | aria-label 改「五檔、明細與公司」，並新增斷言分頁文字為［五檔, 明細, 公司］；S1 的 clickAll 同時跳過「明細」與「公司」，另加一輪「切到公司（替身）後再點全部」，範圍比原本大；以替身 mock `load-company-tab`，不讀 shioaji-data |
| **刻意更新 7** `styles/trade-depth-layout.test.ts`（公司分頁） | 分頁寬度預算 2 段；360 寬字級標準（1.15）同列 | 寬度預算改 3 段（更嚴格）；同列條件改為 390 寬字級標準與 360 寬字級小同列、360 寬字級標準與字級大換行，並新增換行後分頁與切換鍵各自放得下的斷言（§7.3） |
| **刻意更新 8** `components/ranking-list.test.tsx`（排行同自選列） | `ranking-change` 文字為「▲100.00」「▼5.00」；`ranking-pct` 膠囊文字與 `fill.up/down.strong`、`pill.flat` class | 排行改用與自選相同的兩行列（§7.2）：`ranking-change` 改為「+100.00 +10.00%」「-5.00 -10.00%」；膠囊案例改為「依漲跌著色、`ranking-pct` 不存在」。另新增 QuoteRow 版面、星號、快速下單鍵（S1）、處置徽章、迷你走勢合約解析（同時 ≤2、可見度、失敗 5 分鐘不重試、開關關閉 0）等案例；`src/lib/shioaji` 的 mock 擴充 |
| **刻意更新 9** `app.test.tsx`（自選增減） | 閒置預載清單為 ['watch-sparkline', 'search-sheet', 'ranking-list'] | 加入清單名稱面板：['watch-sparkline', 'search-sheet', 'watch-list-sheet', 'ranking-list']（兩處）；另新增「閒置預載包含產業分頁模組」與 sector-page mock。`watchlist-deferred.test.tsx`、`watchlist-ranking-lazy.test.tsx` 只在 `deferred-modules` mock 補上 `loadWatchListSheet`（與 `loadSearchSheet`），斷言不變 |
| **刻意更新 10** `routes/positions-page.test.tsx`（淨損益） | 合計、報酬率、組小計為券商損益 | 改用淨損益：「每列顯示」與「摘要卡」合計 '+127,500' → '+121,697'；「帳戶篩選」合計 '-1,000' → '—'，並新增「合計待確認：1 筆」（2317 沒有商品資料，不以券商損益代替）；「只看股票」合計報酬率 '（+2.65%）' → '（+2.49%）'；「依帳戶分組」補 2317、2454 商品資料，'損益 +87,500' → '損益 +75,891'，新增 headers[1] '損益 +18,741'；「持倉列」報酬率 '+2.65%' → '+2.49%'。淨損益區塊以 `vi.useFakeTimers({ toFake: ['Date'] })` 固定在台北 10:00（當沖減半只到 13:30）。平倉、加碼與 S1 斷言不變；新增額度列（含錯誤邊界）與淨損益案例 |
| **刻意更新 11** `routes/account-page.test.tsx`（名稱與額度） | 只 mock `realized-name` 的 `canonicalBrokerCode` | 補 `contracts-cache` 與 `realizedCodeCandidates` 的 mock（名稱查詢不打真實 API），沒有放寬斷言；新增名稱、額度卡置頂與顯示規則、ScrollRestorer 之後捲動的案例 |

同一分支新增、尚未進 main 的測試檔在審查修正時也有調整（不屬既有測試，列此備查）：`sector-model.test.ts` 的 `flowStatusOf([live], 'closed')` 由 'closed' 改為 'ended'（收盤後保留流向，§7.9）；`position-pnl.test.ts` 原本隱含即折的案例明寫 `rebateMode: 'instant'` 並補月退斷言，大量向量測試的「1 股 @1.23 空單無兩平價」改為「兩平價為 null 時必為空單且最低價位仍虧損」，另斷言即折時仍為 null。`app-shell.test.tsx`、`hash-router.test.ts` 只新增 #/sector 與 6 個分頁的案例。

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
12. 首屏 JS（gzip）：第二階段後 226.3 KiB，收尾後 214.7 KiB；加入快速切換商品後 213.1 KiB；自選改版後 211.3 KiB（迷你走勢與搜尋面板延遲載入）；加入排行同自選列、自選增減、公司分頁、產業頁、名稱與額度、淨損益後 216.5 KiB（16 個 JS）；效能稽核優化（preload、逐一閒置預載、快取格式化）後 **217.7 KiB**，在目標 ≤218 KiB 內但只剩約 0.3 KiB，下次加首屏程式碼前必須先拆分（§13）；上游同步（2026-11-06）後 218.9 KiB，因上游 lib 成長超過目標 0.9 KiB；第 1 期（2026-11-08）拆分 `watch-reorder.ts` 後 217.6 KiB，加入估值卡與當沖資訊列後 217.8 KiB，再把螢幕常亮改為開啟設定才載入後 217.3 KiB；第 1 期全部功能（市場分頁、排行、指標範本、日內區間小條、☆、通知中心）加入並把 HTTPS 說明頁改為延遲載入後 217.0 KiB（§13）。
13. 第二階段各畫面的實機項目（§7.2、§7.7、§7.8 的「待實機確認」，以及 §7.3 的長按震動與選價列捲動）尚未驗收；實機驗收清單見規格 §14.3。
14. 自選改版的實機項目：canvas 在 DPR 2／3 的清晰度與進出畫面時是否閃爍、200 列快速捲動、底部指數列在真實 bar 材質上的對比、以 ContractBase 直接訂閱 IX0001／IX0043 是否收到推播、第一次開搜尋面板的延遲、快速下單鍵與列的誤觸。
15. 本輪（排行同自選列、自選增減與排序、公司分頁、產業頁、名稱與額度、淨損益）的實機項目，都只有單元測試與靜態檢查，沒有實機或瀏覽器視覺 QA：
    - 排行列 360 寬、字級標準時列尾星號＋下單鍵（88px）＋走勢欄後名稱欄的寬度，附加資訊（量、價差）是否把名稱擠到過窄。
    - 握把拖曳：iOS／Android 的 pointer capture、靠近上下緣自動捲動的速度、拖曳中與放手後誤觸列點擊或長按。
    - 公司分頁：375 與 360 寬字級標準時「五檔｜明細｜公司」與整股／零股換成兩行的觀感；低階 Android 盤中開著公司分頁（或切回五檔）時五檔與圖表是否掉幀；上下游 20 檔訂閱在真實串流下是否觸及永豐行情訂閱上限；交易頁網址為非正規代碼時隱藏的公司分頁是否造成多一次退訂與重新訂閱。
    - 產業頁：盤中真實串流下的流向數字、橫條與走勢；串流在 13:30 是否送出 `market_phase` 為 closed 的事件（ended 狀態依賴它）；6 欄分頁列在 360 寬與字級大時的標籤可讀性。
    - 名稱與額度：sidecar 合約尚未就緒或網路暫斷時，名稱查詢失敗後整個 session 只顯示代碼（不重試）是否可接受；iOS 15.4 Safari 從持倉頁點額度列後是否停在額度卡、有沒有先閃到別的位置。
    - 淨損益：13:30 前後與晚上，持倉列標籤與淨損益是否正確切換（頁面不另設 13:30 計時器，跨過那一刻要等下一次重繪，例如報價更新）；與券商實際交割金額的差異（費稅分段四捨五入，可能差 1～2 元）。
16. 已知限制（上游共用模組，不在 fork 修改；之後由上游修正或另案處理）：
    - ~~`src/lib/utils/ticksize.ts` 的 `tickSizeFor` 對權證（WRT）使用股票檔位表~~：上游 978addc6（2026-11-06 同步）已加入權證的升降單位表（`warrantTick`），手機的價位格式化與損益兩平價直接沿用，已修正。
    - `src/lib/utils/contract-cost.ts` 的 `stockTaxRate` 把臺灣存託憑證（代號 91 開頭）、REITs（01xxxT）、ETN（代號 02 開頭）算成 0.3%，法定是 0.1%；`day-trade-tax.ts` 的一般股票判斷沿用同一套分類，當沖減半也可能誤套用到它們。
    - 極小額零股（跳動價位 × 股數小於 1 元）的淨損益因費稅以整數元捨入而不隨價格單調，兩平價只在估計值附近驗證交界，可能差 1 檔。
    - 債券 ETF 證交稅停徵目前寫到 2026-12-31（只限代號 B 結尾的被動式）。行政院 2026-10-01 通過修法草案，擬延長到 2036-12-31，並自 2027-01-01 納入主動式債券 ETF（代號 D 結尾），尚待立法院三讀；通過後需要更新共用模組。
    - 玉山庫存明細的融資利息估算沿用桌面元件 `src/components/esun-position-details.tsx` 的 `esunMarginLotEstimates`，仍計到今天，和手機損益明細的 T+2 不一致；玉山明細原有的券商「損益平衡價」與成本推導照舊保留。
17. 2026-11-06 安全與效能稽核後的殘留項目（需要修改 `src/lib`、部署環境或使用者決定，本輪未處理）：
    - 改價、減量只在呼叫 lib 之前同步檢查一次 ResumeGate 與 LIVE；lib 內 `prepareOrderMutation` 有 await，這段期間切到背景或進入 resyncing 仍會送出（稽核 F6）。要補需讓 `updateOrderPrice`／`updateOrderQty` 支援 `beforeDispatch`（上游 lib）。
    - Tailscale 方案沒有另外的使用者驗證，能連到主機 443 的 tailnet 裝置都能下單（F1）；目前以文件要求 ACL 只允許自己的裝置、不用 funnel（mobile.md）。可再加 nginx 檢查 `Tailscale-User-Login`，需先實測 serve 是否注入並移除偽造值。
    - 嚴格 CSP（F2）：手機版可用 `script-src 'self'`、`connect-src 'self' https://sinotrade.github.io`，但要先處理 mobile.html 的 inline 開機錯誤畫面腳本，並先以 Report-Only 在 iOS／Android 實測。
    - 部署掛載與容器權限（F9）：玉山 bridge 唯讀掛載整個專案根目錄（含 `.env`）、兩個 sidecar 共用 `./certs`、web 與永豐 sidecar 沒有 `no-new-privileges`；需在部署環境實測。
    - 遮蔽金額是否涵蓋委託數量（F11）：目前圖上委託線標籤與委託明細的數量不遮蔽，未成交賣單數量可推回持股量；屬政策決定。
    - 效能：trading-state 每筆 tick 重算全部持倉並發布、每秒以 BroadcastChannel 傳出整份 state；冷啟動合約重複抓 3 次；LCP 等全部合約 info；首屏帶入桌面專用與玉山模組（§13 末）。
    - 實機待確認：iOS 15.4（沒有 `requestIdleCallback`）預載後切分頁不再閃「載入中」；Android 省流量模式只預載必要模組；HSTS 生效後不要再用 `http://<機器>.ts.net:8080` 開啟；精簡列在 360／390 寬三檔字級的換行（期權列最高約 109px）。

18. 第 1 期的實機項目（目前只有單元測試與靜態檢查）：
    - 交易頁當沖資訊列：
      - 360 寬三種字級的換行，以及「說明 ›」靠右。
      - 振幅小條在深淺色主題的對比。
      - 標頭變高約 44px 後，首屏還看得到多少圖表。
      - iOS 15.4 第一次點資訊列到面板出現的延遲（fallback 為 null，載入期間沒有回饋）。
    - 「籌碼與當沖」面板：
      - 當沖規則與處置說明是通則文字，需人工核對。
      - 券源、融資融券單位、資券餘額照桌面顯示原始數字，單位待確認。
    - 自選編輯模式：
      - iOS 15.4／Android 第一次進入是否直接出現按鈕（已閒置預載）。
      - 握把拖曳、邊緣自動捲動、減少動態時跨 chunk 的行為。
      - 離線時佔位與「載入失敗」的版面。
    - 估值卡：金融業與虧損公司實際財報的顯示；P/B 在盤中與收盤後的價格來源。
    - 盤中異動：
      - 跨客戶端（未驗證）：capability ref-count 只存在各自瀏覽器的記憶體；若 sidecar 的 scanner 訂閱是全域的，手機退訂某個鍵可能讓桌面同一個鍵的訊號停掉，桌面仍以為自己有訂閱。產業頁的 index_components 也有同樣風險。實機確認方式：桌面開市場訊號，手機開再關盤中異動，看桌面是否仍收到。
      - 回前景會重新訂閱 8～26 個鍵；頻繁切換 App 時請求數跟著增加。
      - iOS 15.4 的 visibilitychange 時序、實際盤中訊號量與試撮、實際 gap 事件格式（研究文件說 1.7.1 沒有實例）。
      - 補充說明的急漲跌幅度（extra.change_percent）與當日漲跌幅是兩個不同數字，盤中確認讀者不會混淆。
    - 排行：在模擬環境唯讀確認 ChangePriceRank、TickCountRank 的 ascending 方向與 `rank_value` 語意；ETF（00 開頭）與權證代碼判斷是啟發式。
    - 日內區間小條：iOS 15.4 的 `--p` inline 變數、兩種主題下細軌的對比；期貨夜盤時 tick 的高低是該盤，不是整個交易日。
    - 交易頁 ☆：實心狀態的觀感。（第 1 期的「`removeSymbol` 忙碌時靜默返回、可能顯示已移出」已在第 2 批改為面板時以前置檢查修正。）
    - 深度審查列為需要實機確認的項目：
      - 切到背景（visibilitychange → hidden）時送出的 unsubscribe 可能被 iOS 丟掉；lib 仍會註銷該鍵，若 sidecar 的訂閱是全域的，可能留下伺服器端的訂閱（與上面的跨客戶端風險相關）。釋放寬限讓退訂延後 1.5 秒，iOS 在背景暫停計時器時會在回前景才處理。
      - 「鎖漲停／漲停未鎖」沒有排除 `bidask.simtrade`：13:25–13:30 收盤集合競價時會依試撮的五檔判斷，是否合理要看交易所的語意。
    - 通知中心與憑證提醒：
      - 鈴與徽章在 iOS 15.4 Safari、Android Chrome 的位置；360 寬、字級 1.15、「資料過期」加「已鎖單」時路由的 ⌄ 會被切掉一部分（純外觀，未修）。
      - 面板 chunk 還沒預載就按鈴時，會有短暫「點了沒反應」（已用閒置預載降低機率）。
      - 在正式帳戶只看 Network 的 GET 次數，確認提醒一天只出現一次；帳戶頁目前沒有顯示玉山憑證效期，但提醒文字指向帳戶頁；玉山帳戶若在初次載入之後才註冊，當次不檢查。
      - 永豐到期日以「台北今天＋ca_expires_in_days」推算；玉山日期格式依 bridge 測試資料（`2027/12/31`、`2027-12-31 HH:MM:SS`）。
19. 第 2 批（2026-11-08）。瀏覽器假資料實測（390 寬字級小、360 寬字級 1.3）：多選市價出清送出的 7 筆委託內容正確（現股、融資賣出、融券買進、零股以跌停價盤中零股限價、期貨 Cover，跨永豐證券、永豐期貨與玉山），選擇權排除，玉山 503 標「未送出」並繼續，確認面板全程未出現，滑動前 0 筆委託；自選多選刪除、☆ 多清單、排序群組的請求數與伺服器狀態正確，0 筆委託；圖表輕點、再點關閉、長按追蹤與 5 分 K「較前一根」正確，不蓋到圖例與價格軸；兩種寬度都沒有水平溢出、觸控目標 ≥44px。待實機確認（只在模擬環境）：
    - 多選市價出清：
      - 用小量部位實際跑一次：現股（含零股）、融資、融券、期貨，跨永豐與玉山帳戶；核對每筆委託內容與摘要。
      - 非交易時段送出時券商的拒絕訊息（應逐筆「未送出」）；玉山 bridge 回應慢時（每腳 15 秒逾時）的體驗。
      - 執行中切到背景再回來：應停止剩餘（畫面在背景或重新同步過），送出中的那一筆照常完成。
      - 360 寬、字級「大」時選取模式的版面（勾選鍵、底部工具列換行、組標頭「全選」）；最後一列能否捲到工具列上方。
      - VoiceOver／TalkBack 如何朗讀 role=checkbox 的按鈕與 `aria-checked="mixed"`；「全選」放在 GroupedSection 標頭內。
    - 玉山環境切換（2026-11-09）：假資料實測正確（§7.8；複審後的修正未重跑瀏覽器實測）。待實機確認：真實 bridge 切換所需時間（前端逾時 30 秒，登入沒有逾時）與切換期間其他頁面的畫面；切換後下單面板路由徽章、持倉、委託在真實 bridge 上的更新時機；正式設定檔登入失敗時的錯誤文字；同時在桌面與手機切換時（bridge 回 409）的訊息；換 session 窗口等待（最長 15 秒）加上登入時間超過前端 30 秒逾時時，手機進入結果確認的體驗；`esunReconcilePending` 以訊息文字與交易狀態判斷「牽涉玉山」，lib 原因沒有帳戶資訊，可能多擋（只有永豐的刪改單結果待確認、但交易狀態裡有玉山委託時）；桌面發起的切換手機只能從 health 得知（沒有輪詢，靠 bridge 409 保護）。
    - 交易圖表輕點：iOS／Android 上輕點與長按的區分（450ms、10px），與捲動、平移的衝突；資訊列在 360 寬、字級「大」時的換行。
    - 圖表長按選價下單設定（預設關）：假資料實測（360 寬字級 1.3，直向與橫向全螢幕、走勢與 K 線）關閉時長按 0 次選價列、0 個下單面板、0 個委託請求，放開後資訊列釘在該根（拖動後釘在放開處），開啟時四種組合都浮出選價列；iOS／Android 實機上長按放開後資訊列是否穩定釘住（程式庫追蹤模式在觸控放開時清十字線，由 crosshairMove 放回）待確認。
    - 自選頁「持倉」分段：假資料實測（390 寬字級小、360 寬字級 1.3：合併 2330 永豐＋玉山為「等 2 筆」、融資、融券、零股、期貨、選擇權都列出，0 額外請求、0 委託）。待實機確認：標記換行後的列高；同一檔多空並存時只看得到第一筆的方向（明細在持倉頁）；快速下單用目前選取的帳戶；合約解析失敗的代碼沒有名稱與下單鍵。
    - 走勢 X 軸固定與漲跌停範圍：假資料實測（半天資料右側留白、捏合／拖移／滾輪後不變、漲跌停範圍與還原、全螢幕直向與橫向、退出全螢幕）正確。待實機確認：iOS Safari 的實際手感（headless 的捲動手勢合成不可靠）；價格軸約 56px 寬，主圖那一段是否容易點中；漲跌停範圍下最高、最低、參考、現價的軸標籤擠在一起；圖例按鈕（含資訊列 ✕）在實機可點。
    - 走勢副圖指標：假資料實測（三個副圖的高度、圖例、副圖內長按與輕點、全螢幕、每次載入 1 次逐筆請求）正確，真實逐筆以唯讀查詢核對過格式與單位。待實機確認：大型股逐筆的 JSON 解析與彙總在手機主執行緒的耗時；橫向全螢幕三個副圖各約 28px 的可讀性；開著指標離開這檔再回來時因漏量多 1 次請求（最多每 120 秒）；排除集合競價後的數字與使用者習慣的看盤軟體是否一致；處置股（分盤集合競價）的內外盤標記沒有另外處理。
    - 走勢成交量副圖：假資料實測（深淺色、直向與橫向全螢幕、退出全螢幕、量副圖內長按與輕點）正確。待實機確認：「量全為 0、之後第一筆成交才建副圖」時外框加高與副圖高度校正（只有單元測試）；橫向全螢幕量副圖約 42px 時刻度省略是否可接受；量柱方向（對前一分鐘）與資訊列漲跌（對參考價）基準不同，使用者是否能理解。
    - 今日剩餘交易額度即時化（2026-11-09）：
      - 玉山：在真實交易日盤中，以小量買進（含部分成交後刪單、零股、市價）比對 App 的估算剩餘與玉山 App／網站自己的可用額度數字，確認差異來源（券商是否扣賣出、是否含手續費、市價單是否以漲停價圈額度、盤後定價與興櫃的計算）；估算只依本 App 看得到的今日委託，他處下單在回報或對帳前不會計入。
      - 永豐：盤中送出、刪改單、成交後，帳戶頁或持倉頁開著時約 2～10 秒內數字更新；Network 只看到該帳戶的 trading_limits，間隔不少於 10 秒；切到背景期間不查、回前景只補查一次（iOS 15.4 的 visibilitychange 時序）。
      - 360 寬字級「大」時持倉頁額度列的明細一行、下單面板額度欄的換行觀感。
    - 自選：
      - 排序群組面板內的握把拖曳是否與面板的下拉關閉手勢衝突；↑／↓ 後的焦點；群組順序只存在這台裝置（另一台裝置與桌面仍是伺服器順序）。
      - 多選刪除：底部配件槽與指數列並存時的高度；iOS 15.4 的 accent-color 勾選框外觀。
      - ☆ 面板：重新讀取的成本會隨目前清單的檔數增加（每檔一次合約資訊），大清單時留意。
      - 多選刪除群組：瀏覽器假資料實測（390 寬字級小、360 寬字級 1.3）確認畫面、0 請求直到確定、DELETE 次數、伺服器狀態、摘要與焦點都正確。待實機確認：確認畫面標題（tabIndex −1、無焦點框）的 VoiceOver／TalkBack 朗讀；360 寬字級「大」時底部「已選 N 個」、停用原因與兩顆鍵的換行；刪除目前群組後編輯模式結束，焦點落到頁面（與工具列「刪除清單」相同，未另外處理）。
    - 漲停／跌停、盤中異動名稱、產業成分股（第 5 批）：瀏覽器假資料實測（360 寬字級 1.3、390 寬字級小；深色、淺色；台灣與國際配色）：自選、排行、持倉、交易頁、成分股的漲停／跌停實心底與小標正確，白字對比 6.69／4.85（深色）、5.81／4.99（淺色），國際配色紅綠對調；無水平溢出。盤中異動 30 個沒有目錄名稱的代碼只查可見的 4–9 個、每代碼 1 次，捲動後新可見的才查、捲回不重查；成分股開啟 subscribe 1、關閉 unsubscribe 1、建底 0，名稱只查面板中看得到的列；送單 0。待實機確認：iOS／Android 上 `::before` 小標與實心底的字距與基線；VoiceOver／TalkBack 朗讀列的「漲停／跌停」；盤中真實資料的漲跌停價（字串或小數）是否都能判斷；真實 `index_components` 群組內排行的延遲與成交值單位；部署環境 `/metadata` 路由修好之前，盤中異動大量新代碼時合約查詢的量。
    - 已實現損益自訂區間：瀏覽器假資料實測（360 寬字級 1／1.15／1.3）：期間膠囊 4＋1、3＋2、3＋2 換行，無重疊、無文字溢出、無水平溢出，膠囊點擊區與日期欄 ≥44px，字級 1.3 日期欄單欄；只有永豐帳戶時切到自訂可立即查詢；選玉山帳戶時展開＋3 個不同區間共 4 次通過（8 個 GET profit-loss），第 5 次停用並顯示「查詢（55 秒）」。待實機確認：iOS（含 15.4）與 Android 的日期選擇器是否遵守 min／max（不遵守時仍由驗證擋下）；按日期欄的清除鍵後應顯示「請選擇起日。」；iOS 日期欄在 360 寬兩欄（字級 1／1.15）是否被內建最小寬度擠壓；字級 1 時膠囊 4＋1、「自訂」單獨一列的觀感；role=status 原因插入時螢幕閱讀器是否朗讀。
    - 自選固定清單與排序：假資料實測（390 寬字級小、360 寬字級 1.3；期貨清單用 2026-11-09 的公開合約資料）：近月 307、遠月 304 列；開啟近月＝清單 GET 1、快照 POST 1（307 檔）、合約解析 0、Tick 訂閱 9–10（只有可見列）；遠月同日不再讀清單；捲動 300 列 p95 16.7ms、0 個 >33ms 畫格，兩趟全捲只訂閱 9–11 檔；股價排序 1 次快照、［⟳］5 秒後才可按；自己的清單漲幅% 排序 1 次快照（7 檔）、編輯模式回到伺服器順序；下單面板標題為實際月份（PZFK6 信驊期貨 202611）；送單 0。待實機確認：iOS／Android 長按與捲動停下後訂閱的時機、300 列在低階手機的捲動、真實伺服器的期貨清單何時換月（換月後第一個交易日的近月是否已更新）、真實批次快照 300 檔的回應時間。
    - 持倉排序、產業列排序（第 6 批）：瀏覽器假資料實測（390 寬字級小、360 寬字級 1.3）：持倉 6 列（永豐證券＋玉山 2330 合併一列、期貨、選擇權）預設持倉順序、0 個快照；股價 ↓／↑、股票代號、漲幅% 順序正確，股價類每次排序依據 1 個批次快照（6 檔）、反向不重取，［⟳］5 秒後才可按、按下再 1 個；重新載入沿用偏好（`pos:holdings`）並取 1 個；表頭排序鍵與［⟳］點擊區 ≥44px，無水平溢出。產業列四段（資金流向 ↓ 預設、近5分、漲跌幅、成交值），再點反向、重新載入沿用；排序 0 個請求（360 寬字級 1.3 時排序段在膠囊列內橫向捲動，頁面無水平溢出）。送單 0。待實機確認：盤中真實流向資料時資金流向、近5分兩種方向的順序；持倉合約尚未解析（冷啟動、玉山獨有代碼）時排在最後、解析後下一次排序依據才納入的觀感；VoiceOver／TalkBack 朗讀排序段的方向與「再點一次」說明。
---

## 17. 第二輪候選與不做清單

**第二輪候選（需各自原型與實機驗證）**：面板內容捲到頂再下拉接手（非被動 touchmove，只在 10px 門檻內且 cancelable 時 preventDefault）；長按 ContextMenu（只開面板）；FLIP 版面動畫；交易頁 ☆ 加入自選；自選列日內區間條（`src/lib/day-range.ts`，不發請求）；委託與持倉下拉更新（僅 iOS 16＋與 Chrome，受 6 秒冷卻）；列水平滑動揭示按鈕（不做滑到底執行）。

**不做**：一鍵／閃電下單、圖上拖曳改價、價格拖曳調整（scrub）、觸價／括號／條件單、無確認的批次市價平倉（多選市價出清須預覽並滑動一次，§7.7、§10 S10）、背景執行、交易頁標頭左右滑切換商品、列滑到底直接執行、無限制的逐列迷你走勢（有限制的版本已依使用者要求實作，§7.2）、修改 `src/lib` 交易邏輯或確認佇列、修改 theme 色票、修改 mobile.html。
