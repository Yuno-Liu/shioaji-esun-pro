// src/mobile/styles/watchlist.css.ts — 自選、排行與搜尋面板（設計規格 §7.2、§4.7、§4.8、§6.12–§6.14）
// - 頁面表面 contentBg（淺色主題含漲跌色文字的清單放白底，§4.8 規則 9）；頁首與分段用 ui/* 共用元件。
// - 自選列 64px（依使用者參考圖改版）：左第一行名稱 headline、第二行代碼＋市場標記＋徽章（試撮、處置）；
//   右第一行成交價（比 numMd 大一級、漲跌色＋PriceFlash 覆蓋層）、第二行「漲跌 漲跌幅」或總量（純文字、漲跌色）；
//   迷你走勢 canvas（可在帳戶頁關閉）；列尾快速下單鍵 IconButton 44（指數、組合商品不顯示）。
// - 排行列沿用漲跌膠囊（pill：實心 up／down＋inkStrong 白字 numSm 600；平盤 elevatedBg＋foreground）。
// - 底部指數列（indexStrip）放在殼層配件槽（bar 材質上：標籤、數值、漲跌幅文字一律 foreground，方向以有色 ▲▼ 圖形表示）。
// - 髮絲線左內縮 16；捲動容器內的列用 pressableRow（延後 80ms 加深）。
// - 顏色只用 vars／sj；漲跌只用 vars.color.up／down 並附 ▲▼ 或正負號；不用 color-mix()、:has()、linear()；
//   只動畫 opacity（按壓、骨架、跳價閃爍皆由共用元件處理）。
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { LOW_DPR, MORE_CONTRAST, RADIUS, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

/** 頁面左右邊距（＋安全區；main 已讓出安全區時 env() 在直式為 0） */
const PAD_X = SPACE.s4;
const HAIRLINE = `0.5px solid ${vars.color.border}`;

// ---- 頁面 ----

export const page = style({
    minHeight: '100%',
    paddingBottom: SPACE.s6,
    background: sj.contentBg,
    color: vars.color.foreground,
});

/** 頁首下方的控制區（分段、清單切換、說明）：左右 16 */
export const controls = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `${SPACE.s1} calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${PAD_X} + ${SAFE_LEFT})`,
    minWidth: 0,
});

/** 多個自選清單的分頁（Segmented scroll 變體）：不撐出頁寬，自己橫向捲動 */
export const listTabs = style({
    minWidth: 0,
});

export const listName = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 狀態與錯誤區（InlineNote 等）：左右 16 */
export const stateBlock = style({
    padding: `${SPACE.s2} calc(${PAD_X} + ${SAFE_RIGHT}) 0 calc(${PAD_X} + ${SAFE_LEFT})`,
});

// ---- 表頭（名稱｜指標切換鍵｜編輯） ----

/** 表頭高 TOUCH_MIN（編輯鍵 44px）；指標切換鍵外觀 28px，擴張點擊區仍落在表頭內 */
export const listHeader = style([{
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s3,
    minHeight: TOUCH_MIN,
    padding: `0 calc(${SPACE.s1} + ${SAFE_RIGHT}) 0 calc(${PAD_X} + ${SAFE_LEFT})`,
    borderBottom: HAIRLINE,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    '@media': {
        [LOW_DPR]: { borderBottomWidth: '1px' },
        [MORE_CONTRAST]: { borderBottom: `1px solid ${vars.color.borderBright}` },
    },
}]);

/**
 * 指標切換鍵：外觀 28px 文字鍵，點擊區以 ::before 上下擴到 TOUCH_MIN（左右各擴 8px）。
 * 下方的擴張區會與第一列重疊（字級預設 8px，字級放大時 TOUCH_MIN 隨 rem 變大、可到約 14px）：
 * 列（li.rowItem 與列按鈕）是 position relative、DOM 在後，不設 z-index 時會畫在擴張區之上而搶走點擊，
 * 實際可點高度只剩約 36–43px，點在表頭下緣稍下方會開成第一檔商品的交易頁。
 * 所以切換鍵 zIndex 1，讓擴張區畫在第一列之上；第一列最矮 56px，被蓋掉上緣後仍 ≥ 44px。
 * main 不是疊層脈絡（layout.css.ts 殼層規則），zIndex 1 仍低於上方插槽與底部 chrome（Z.bars 起）。
 * 上方擴張區落在控制區的下內距（SPACE.s2）；字級放大時可能多出數 px，蓋到控制區最後一個元素的下緣（既有行為）。
 */
export const metricToggle = style({
    position: 'relative',
    zIndex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    minHeight: '28px',
    margin: 0,
    padding: 0,
    border: 'none',
    background: 'transparent',
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.accent,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            left: '-8px',
            right: '-8px',
            top: `calc((28px - ${TOUCH_MIN}) / 2)`,
            bottom: `calc((28px - ${TOUCH_MIN}) / 2)`,
        },
    },
});

export const headerName = style({
    flex: '1 1 auto',
    minWidth: 0,
});

/** 編輯鍵（watch-edit）：鉛筆＋文字，點擊區 TOUCH_MIN；編輯中 aria-pressed 時 accent */
export const editButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s1,
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&[aria-pressed="true"]': { color: vars.color.accent, fontWeight: 600, background: vars.color.accentDim },
    },
});

export const metricIcon = style({
    width: '0.875rem',
    height: '0.875rem',
    flex: '0 0 auto',
});

// ---- 清單與列 ----

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
});

/** 列容器：髮絲線畫在列底、從文字起點（左 16）開始；最後一列不畫 */
export const rowItem = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    selectors: {
        '&:not(:last-child)::after': {
            content: '""',
            position: 'absolute',
            left: `calc(${PAD_X} + ${SAFE_LEFT})`,
            right: 0,
            bottom: 0,
            height: 0,
            borderBottom: HAIRLINE,
            pointerEvents: 'none',
        },
    },
    '@media': {
        [LOW_DPR]: { selectors: { '&:not(:last-child)::after': { borderBottomWidth: '1px' } } },
        [MORE_CONTRAST]: { selectors: { '&:not(:last-child)::after': { borderBottom: `1px solid ${vars.color.borderBright}` } } },
    },
});

/** 整列可點（開交易頁），長按開操作面板；禁止 iOS 長按選字／彈出選單 */
export const row = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'grid',
    // 名稱欄最窄＝其 min-content：名稱（rowTitle 不計入）與第二行的代碼＋市場標記（rowMetaKey），代碼不被擠到截斷
    gridTemplateColumns: 'minmax(min-content, 1fr) auto auto',
    alignItems: 'center',
    columnGap: SPACE.s3,
    minHeight: '64px',
    margin: 0,
    padding: `${SPACE.s1_5} calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s1_5} calc(${PAD_X} + ${SAFE_LEFT})`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'pan-y',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { boxShadow: `inset 0 0 0 3px ${vars.color.accent}` } } },
    },
});

/** 列尾有鍵（快速下單、編輯模式「⋯」，或指數／組合商品的同寬佔位）：右邊距交給列尾鍵；自選列一律套用 */
export const rowHasTrailing = style({
    paddingRight: SPACE.s1,
});

/** 開啟迷你走勢：名稱｜數字｜走勢 */
export const rowWithSpark = style({
    gridTemplateColumns: 'minmax(min-content, 1fr) auto auto',
});

/** 不顯示迷你走勢（設定關閉，或窄螢幕＋字級「大」）：名稱｜數字，數字欄靠右延伸 */
export const rowNoSpark = style({
    gridTemplateColumns: 'minmax(min-content, 1fr) auto',
});

export const rowName = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.0625rem',
    minWidth: 0,
});

export const rowTitleLine = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    minWidth: 0,
});

/**
 * 自選列第一行：名稱（headline、單行省略）。空間不足時由這裡省略吸收。
 * width 0＋minWidth 100%：不計入名稱欄的 min-content（長名稱不撐寬欄位），版面上仍佔滿整欄。
 */
export const rowTitle = style({
    ...TEXT.headline,
    fontWeight: 500,
    color: vars.color.foreground,
    width: 0,
    minWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 自選列第二行：代碼＋市場標記（rowMetaKey）＋徽章；放不下時徽章換到下一行，不裁切 */
export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACE.s1,
    rowGap: '0.125rem',
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

/** 代碼＋市場標記：同一組、不縮、不換行、不省略（代碼是關鍵資訊） */
export const rowMetaKey = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
});

export const rowMetaCode = style({
    ...NUMERIC,
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
});

/** 市場標記（市／櫃／興／期／權／指） */
export const marketTag = style({
    flex: '0 0 auto',
});

/** 處置徽章：紅色（danger，狀態色不隨漲跌配色翻轉）外框，小字 foreground（§4.8 規則 4） */
export const punishBadge = style({
    flex: '0 0 auto',
    padding: '0 0.25rem',
    borderRadius: RADIUS.xs,
    border: `1px solid ${vars.color.danger}`,
    ...TEXT.caption,
    color: vars.color.foreground,
});

export const rowCode = style({
    ...TEXT.headline,
    ...NUMERIC,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowSub = style({
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 試撮（simtrade）徽章：揭示價不是成交，文字＋amber 框線（小字一律 foreground，§4.8 規則 4） */
export const simBadge = style({
    flex: '0 0 auto',
    padding: '0 0.25rem',
    borderRadius: RADIUS.xs,
    border: `1px solid ${vars.color.amber}`,
    ...TEXT.caption,
    color: vars.color.foreground,
});

/** 價格欄：價格（＋閃爍覆蓋層）與第二行 */
export const priceCell = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '0.0625rem',
    minWidth: 0,
});

/** 價格：numMd、漲跌色；閃爍覆蓋層的定位基準（ui/price-flash.css 的 host 另行套用） */
export const rowPrice = style({
    padding: '0 0.25rem',
    margin: '0 -0.25rem',
    borderRadius: RADIUS.xs,
    ...NUM.numMd,
    ...NUMERIC,
    textAlign: 'right',
    whiteSpace: 'nowrap',
});

/** 自選列成交價：比 numMd 大一級（1.0625rem）、漲跌色 */
export const rowPriceLarge = style({
    fontSize: '1.0625rem',
    lineHeight: 1.25,
});

/** 自選列第二行（漲跌 漲跌幅／總量）：純文字 numSm，字距略開 */
export const rowChange = style({
    ...NUM.numSm,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    textAlign: 'right',
    wordSpacing: '0.375rem',
});

/** 迷你走勢 canvas（px 固定，不隨字級；字級「大」時縮窄讓出名稱欄） */
export const spark = style({
    display: 'block',
    width: '56px',
    height: '32px',
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { width: '40px' },
    },
});

/** 價格下的第二行（排行的漲跌、量）：numSm */
export const priceSub = style({
    ...NUM.numSm,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    textAlign: 'right',
});

export const tone = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

const pillBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    boxSizing: 'border-box',
    minWidth: '4.75rem',
    height: '1.75rem',
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.sm,
    ...NUM.numSm,
    ...NUMERIC,
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

/**
 * 漲跌膠囊：up／down 為實心填色＋inkStrong 白字（搭配 primitives 的 fill.<tone>.strong 提供底色與疊黑）；
 * flat 與無方向指標（總量）為 elevatedBg＋foreground。
 */
export const pill = styleVariants({
    up: [pillBase],
    down: [pillBase],
    flat: [pillBase, { background: sj.elevatedBg, color: vars.color.foreground, boxShadow: `inset 0 0 0 0.5px ${vars.color.border}` }],
});

/** 列尾鍵（編輯模式「⋯」、排行「＋」）：IconButton 44×44，靠右對齊頁邊距 */
export const rowTrailing = style({
    alignSelf: 'center',
    marginRight: `calc(${SPACE.s1} + ${SAFE_RIGHT})`,
    color: vars.color.mutedForeground,
});

/** 指數、組合商品沒有快速下單鍵：與 IconButton 同寬（TOUCH_MIN）的空白佔位，讓價格欄、走勢欄與其他列對齊 */
export const ticketSpacer = style({
    display: 'block',
    flex: '0 0 auto',
    width: TOUCH_MIN,
    height: TOUCH_MIN,
});

// ---- 底部指數列（ShellSlot bottom → 配件槽，bar 材質上） ----

export const indexStrip = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    padding: `0 calc(${SPACE.s2} + ${SAFE_RIGHT}) 0 calc(${SPACE.s2} + ${SAFE_LEFT})`,
});

export const indexCell = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s2}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        // 兩格之間一條髮絲線（不用 :has()）
        '& + &': { boxShadow: `inset 0.5px 0 0 ${vars.color.border}` },
    },
});

export const indexLabel = style({
    flex: '0 0 auto',
    ...TEXT.subhead,
    fontWeight: 600,
    color: vars.color.foreground,
});

/**
 * 指數值與漲跌幅：bar 材質上的文字一律 foreground（設計規格 §4.6；§4.8 規則 6、8），方向只由有色的 ▲▼ 圖形（indexArrow）表示。
 * 不截斷、不裁切：放得下時一行；放不下時漲跌幅自動換到值的下一行（flex-wrap，靠右）。
 * 字級「大」固定上下排列（360／390 寬時一行放不下：標籤＋值＋漲跌幅約 200px，格內只有約 150px）。
 */
export const indexValue = style({
    flex: '1 1 auto',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    columnGap: SPACE.s1_5,
    rowGap: 0,
    minWidth: 0,
    ...NUM.numSm,
    ...NUMERIC,
    fontWeight: 600,
    color: vars.color.foreground,
    textAlign: 'right',
    selectors: {
        'html[data-sj-font-scale="1.3"] &': { flexDirection: 'column', alignItems: 'flex-end' },
    },
});

/** 指數值：foreground、不換行 */
export const indexNum = style({
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

/** 漲跌幅（帶正負號）：foreground、不換行；前面是方向圖形 */
export const indexPct = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.1875rem',
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

/** 方向圖形（SVG 三角形，aria-hidden）：顏色由 tone.up／down 提供（圖形門檻 3:1，§4.8 規則 8）；尺寸隨字級 */
export const indexArrow = style({
    display: 'block',
    flex: '0 0 auto',
    width: '0.5rem',
    height: '0.5rem',
});

// ---- 長按操作面板 ----

export const actionSheet = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s4,
    paddingTop: SPACE.s1,
});

// GroupedSection 預設左右內縮 16（頁面用）；面板 body 已有內距，這裡歸零（同 order-action.css.ts）
globalStyle(`${actionSheet} section`, { marginLeft: 0, marginRight: 0 });

/** 買／賣方向小膠囊（ListRow leading；文字＋實心 up／down，fill.<tone>.strong 提供底色） */
export const sideBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: RADIUS.sm,
    ...TEXT.caption,
    fontWeight: 700,
});

/** 移除列：與 ListRow 同版面，文字 danger（狀態色，不隨配色翻轉） */
export const dangerRow = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0.6875rem ${SPACE.s4}`,
    border: 'none',
    background: 'transparent',
    ...TEXT.headline,
    color: vars.color.danger,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

// ---- 排行（ranking-list.tsx） ----

export const rankControls = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `0 calc(${PAD_X} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${PAD_X} + ${SAFE_LEFT})`,
    minWidth: 0,
});

export const rankMeta = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    minWidth: 0,
});

/** 「更新於 hh:mm:ss」：caption 字級改 footnote（mutedForeground 在 contentBg 上） */
export const rankMetaText = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 更新鍵：compact 外觀（2.25rem）＋點擊區擴到 TOUCH_MIN（ui/chip.css 的 expandHit） */
export const rankRefresh = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: SIZE.controlCompact,
    padding: `0 ${SPACE.s3}`,
    margin: 0,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.elevatedBg,
    color: vars.color.foreground,
    ...TEXT.callout,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

/** 排行列：名次｜名稱代碼（＋量）｜成交價＋漲跌｜漲跌%膠囊 */
export const rankRow = style([row, {
    gridTemplateColumns: '1.5rem minmax(0, 1fr) auto auto',
    paddingRight: SPACE.s1,
}]);

export const rankNo = style({
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    textAlign: 'center',
});

// ---- 搜尋面板（search-sheet.tsx） ----

/** 搜尋欄：面板 body 內 sticky 頂端；不透明（面板底色），不模糊（§4.6：sticky 列不用 backdrop-filter） */
export const searchBar = style({
    position: 'sticky',
    top: 0,
    zIndex: 1,
    margin: `0 calc(-1 * ${vars.space.md})`,
    padding: `${SPACE.s1} ${vars.space.md} ${SPACE.s2}`,
    background: vars.color.panel,
});

export const searchInput = style({
    display: 'block',
    width: '100%',
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s3}`,
    boxSizing: 'border-box',
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.border}`,
    background: sj.islandBg,
    color: vars.color.foreground,
    // 輸入字級 ≥16px（避免 iOS 聚焦放大）
    fontSize: 'max(16px, 1rem)',
    WebkitAppearance: 'none',
    appearance: 'none',
    selectors: {
        '&::placeholder': { color: vars.color.mutedForeground },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

export const searchStatus = style({
    margin: `${SPACE.s2} 0`,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const resultList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
});

export const resultItem = style({
    position: 'relative',
    minWidth: 0,
    selectors: {
        '&:not(:last-child)': { borderBottom: HAIRLINE },
    },
    '@media': {
        [LOW_DPR]: { selectors: { '&:not(:last-child)': { borderBottomWidth: '1px' } } },
        [MORE_CONTRAST]: { selectors: { '&:not(:last-child)': { borderBottom: `1px solid ${vars.color.borderBright}` } } },
    },
});

/**
 * 搜尋面板 sticky 搜尋欄（searchBar）的高度：上內距＋輸入框（TOUCH_MIN）＋下內距。
 * 結果列的鍵以 scroll-margin-top 讓出這段，scrollIntoView 與焦點移動才不會把列停在搜尋欄底下
 * （遮擋檢查：橫向 844×390 時面板矮，「目前商品」列曾被搜尋欄蓋住）。自選搜尋與切換商品面板共用。
 */
export const SEARCH_BAR_H = `calc(${TOUCH_MIN} + ${SPACE.s1} + ${SPACE.s2})`;

globalStyle(`${resultItem} button`, { scrollMarginTop: SEARCH_BAR_H });

export const resultRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: '56px',
    minWidth: 0,
});

/** 結果主鍵（開交易頁）：與自選列同樣式（代碼 headline＋名稱、第二行種類） */
export const resultMain = style({
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: '0.0625rem',
    alignSelf: 'stretch',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `${SPACE.s1_5} 0`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}`, borderRadius: RADIUS.md },
    },
});

export const resultName = style({
    ...TEXT.headline,
    fontWeight: 400,
    color: vars.color.foreground,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

/** 結果列尾的晶片（加入自選、交易）：沿用 ui/chip.css 的 chip 外觀，再固定不換行 */
export const resultChip = style({
    flex: '0 0 auto',
});

/** 加入失敗訊息：小字一律 foreground，amber 只用於左側條（§4.8 規則 4） */
export const resultMessage = style({
    margin: `0 0 ${SPACE.s2}`,
});
