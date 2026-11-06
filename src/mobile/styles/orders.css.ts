// src/mobile/styles/orders.css.ts — 委託頁、委託明細面板、全部刪單／批次刪單面板（routes/orders-page.tsx、
// components/order-detail-sheet.tsx）與委託操作面板共用的 OrderLines／OrderBadges（components/order-action-sheet.tsx）。
// 設計規格 §7.6：清單型頁面（contentBg）、列間髮絲線從文字起點開始、方向小膠囊實心＋inkStrong、狀態外框膠囊 foreground 文字、
// 列上 Chip（改價／減量／刪單）、選取工具列在底部配件槽（bar 材質上：foreground 文字、字重加一級）。
// 觸控目標 ≥ 44px；買賣一律有文字，買賣色只用 vars.color.up／down；狀態色（danger／amber／success）不隨配色翻轉。
// 只動畫 transform／opacity；不用 color-mix()、:has()、容器查詢。
import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill, focusRing, pressable, pressableRow } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const INSET_X = `calc(${SPACE.s4} + ${SAFE_LEFT})`;
const INSET_R = `calc(${SPACE.s4} + ${SAFE_RIGHT})`;
const HAIRLINE = `0.5px solid ${vars.color.border}`;

/** 列間髮絲線（畫在後一列上緣，從文字起點 16px 開始）；低密度 1px、提高對比 1px borderBright */
function hairlineBetween(selector: string) {
    globalStyle(`${selector}::before`, {
        content: '""',
        position: 'absolute',
        top: 0,
        left: INSET_X,
        right: 0,
        height: 0,
        borderTop: HAIRLINE,
        pointerEvents: 'none',
        '@media': {
            [LOW_DPR]: { borderTopWidth: '1px' },
            [MORE_CONTRAST]: { borderTop: `1px solid ${vars.color.borderBright}` },
        },
    });
}

// ---- 頁面 ----

/** 清單型頁面：contentBg（深色 background、淺色 panel 白底，§4.8 規則 9）；左右邊距由各區塊自帶（16＋安全區） */
export const page = style({
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: `${SPACE.s1} 0 ${SPACE.s6}`,
    background: sj.contentBg,
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

/** 頁首「⟳ 更新（N）」：tinted 文字鍵（accent），可見文字不變 */
export const refreshButton = style([pressable, focusRing, {
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s3}`,
    margin: 0,
    border: 'none',
    borderRadius: RADIUS.pill,
    background: 'transparent',
    color: vars.color.accent,
    ...TEXT.callout,
    fontWeight: 600,
    ...NUMERIC,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { color: vars.color.mutedForeground, cursor: 'default' },
    },
}]);

// ---- 分頁與帳戶篩選 ----

export const tabsWrap = style({
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
    minWidth: 0,
});

/** 帳戶 PopUpButton＋「點委託列查看明細 [選取]」 */
export const filterRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${SPACE.s2} ${SPACE.s3}`,
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
    minWidth: 0,
});

export const accountPicker = style({
    flex: '0 1 auto',
    maxWidth: '100%',
});

/** 選取工具列（一般模式，在帳戶篩選右側） */
export const toolbar = style({
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACE.s2,
    minWidth: 0,
});

export const toolbarText = style({
    flex: '0 1 auto',
    minWidth: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 小型文字鍵（選取、全選、完成）：44px 點擊區、accent 文字 */
export const textButton = style([pressable, focusRing, {
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${SPACE.s2}`,
    margin: 0,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.accent,
    ...TEXT.callout,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/** 頁內 InlineNote（對帳）左右邊距 */
export const noteWrap = style({
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
    minWidth: 0,
});

// ---- 委託列 ----

export const list = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    minWidth: 0,
});

export const row = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    selectors: {
        '&[data-selected="true"]': { background: vars.color.accentDim },
    },
});
hairlineBetween(`${row} + ${row}`);

/** 委託列主體（點開委託明細；選取模式切換勾選）：整列按壓加深（延後 80ms） */
export const rowMain = style([pressableRow, {
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    flex: '1 1 auto',
    width: '100%',
    minWidth: 0,
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    margin: 0,
    padding: `0.6875rem ${INSET_R} 0.6875rem ${INSET_X}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    selectors: {
        '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
}]);

/** 有列上動作時：主體下緣留 8px，列上 Chip 的擴張點擊區不與主體重疊 */
export const rowMainWithActions = style({
    paddingBottom: SPACE.s2,
});

/** 選取模式：勾選圈＋列主體（列內容右移） */
export const rowSelectable = style({
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
});

/** 勾選框的觸控區（44px） */
export const checkHit = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    paddingLeft: SAFE_LEFT,
    marginLeft: SPACE.s1,
    cursor: 'pointer',
});

/** 勾選圈（原生 checkbox；accent-color 15.4 起支援，舊版顯示預設樣式） */
export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
    margin: 0,
    accentColor: vars.color.accent,
    cursor: 'pointer',
});

/** 選取模式的列主體：左側已有勾選圈，左內距縮小 */
globalStyle(`${rowSelectable} > ${rowMain}`, {
    paddingLeft: SPACE.s1,
});

/** 列上動作（改價／減量／刪單）：與列主體為兄弟節點；Chip 外觀 36px、點擊區 44px */
export const rowActions = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    padding: `${SPACE.s1} ${INSET_R} 0.6875rem ${INSET_X}`,
});

/** 刪單 Chip：danger 文字（狀態色，不隨配色翻轉）；雙 class 權重高於 Chip 預設的 foreground */
export const chipDanger = style({
    selectors: {
        [`${rowActions} &`]: { color: vars.color.danger },
    },
});

// ---- OrderLines／OrderBadges（委託列、委託操作面板摘要、明細共用；全部是 span，可放在按鈕內） ----

export const line = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: `${SPACE.s1} ${SPACE.s1_5}`,
    flexWrap: 'wrap',
    minWidth: 0,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
});

/**
 * 委託列、成交列（dealRow 沿用 rowMain）第一行：名稱＋代碼放大到 headline；第二行的價量用 numMd。
 * 第一行不換行：名稱到達時只有名稱縮短（省略號），代碼、買賣膠囊、徽章與成交時間不縮、不換行，列高不變。
 */
const FIRST_LINE = `${rowMain} > ${line}:first-child`;
globalStyle(FIRST_LINE, { ...TEXT.headline, flexWrap: 'nowrap' });
globalStyle(`${FIRST_LINE} > *`, { flexShrink: 0, whiteSpace: 'nowrap' });

/**
 * 商品（名稱為主、代碼為次，同自選列）：單行不換行、名稱過長以省略號截斷；
 * 名稱載入前只顯示代碼，名稱到達時仍在同一行，列高不變。
 */
export const instrument = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: SPACE.s1_5,
    minWidth: 0,
    maxWidth: '100%',
    whiteSpace: 'nowrap',
});

export const instrumentName = style({
    ...TEXT.headline,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const instrumentCode = style({
    flexShrink: 0,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});
/** 委託列／成交列第一行：只有商品（名稱）可縮，名稱以省略號截斷；代碼在商品內不縮（instrumentCode） */
globalStyle(`${FIRST_LINE} > ${instrument}`, { flexShrink: 1, minWidth: 0 });

export const sub = style({
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

const sideBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    // 在 flex 列中排到最前面（「(買) 2330 台積電」）；非 flex 容器內無作用
    order: -1,
    minWidth: '1.5em',
    padding: '0 0.375rem',
    borderRadius: RADIUS.sm,
    ...TEXT.footnote,
    fontWeight: 700,
    lineHeight: 1.5,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
});

/** 方向小膠囊：實心 up／down＋inkStrong 白字（§4.8 規則 3），文字一律為買／賣（買進／賣出） */
export const side = styleVariants({
    Buy: [fill.up.strong, sideBase],
    Sell: [fill.down.strong, sideBase],
});

/** 委託狀態：外框膠囊、foreground 文字；排在該行最右 */
export const status = style({
    marginLeft: 'auto',
    padding: '0 0.375rem',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.borderBright}`,
    ...TEXT.footnote,
    fontWeight: 500,
    lineHeight: 1.5,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

/** 玉山預約：foreground 文字＋amber 外框 */
export const reservation = style({
    padding: '0 0.375rem',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.amber}`,
    ...TEXT.footnote,
    fontWeight: 600,
    lineHeight: 1.5,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

/** 券商訊息：foreground 小字＋3px amber 條 */
export const msg = style({
    ...TEXT.subhead,
    color: vars.color.foreground,
    paddingLeft: SPACE.s1_5,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
    overflowWrap: 'anywhere',
});

export const badges = style({
    display: 'inline-flex',
    flexWrap: 'wrap',
    gap: SPACE.s1,
});

const badgeBase = style({
    display: 'inline-block',
    padding: '0 0.3125rem',
    borderRadius: RADIUS.xs,
    border: `0.5px solid ${vars.color.border}`,
    ...TEXT.footnote,
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

/** 類別徽章：文字徽章（不只靠顏色）；信用 amber 框、當沖 accent 框，文字一律 foreground／mutedForeground */
export const badge = styleVariants({
    price: [badgeBase],
    tif: [badgeBase],
    octype: [badgeBase, { color: vars.color.foreground }],
    lot: [badgeBase, { color: vars.color.foreground }],
    credit: [badgeBase, { borderColor: vars.color.amber, color: vars.color.foreground }],
    daytrade: [badgeBase, { borderColor: vars.color.accent, color: vars.color.foreground }],
});

// ---- 空狀態、列表尾端 ----

/** EmptyState／Skeleton 外框（左右邊距） */
export const emptyWrap = style({
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
});

/** 列表尾端的「全部刪單（N 筆）」：danger 外框、不黏住 */
export const footer = style({
    display: 'flex',
    paddingLeft: INSET_X,
    paddingRight: INSET_R,
    marginTop: SPACE.s2,
});

export const cancelAllButton = style([pressable, focusRing, {
    width: '100%',
    minHeight: SIZE.controlLarge,
    margin: 0,
    padding: `0 ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    border: `1px solid ${vars.color.danger}`,
    background: 'transparent',
    color: vars.color.danger,
    ...TEXT.callout,
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

// ---- 選取模式：底部配件槽（ShellSlot bottom；bar 材質上的文字一律 foreground、字重加一級） ----

export const selectBar = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `${SPACE.s2} ${INSET_R} ${SPACE.s2} ${INSET_X}`,
    minWidth: 0,
});

export const selectBarRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minWidth: 0,
});

export const selectBarCount = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.callout,
    fontWeight: 600,
    ...NUMERIC,
    color: vars.color.foreground,
});

/** 「刪除已選（N 筆）」：danger 外框（不做實心，避免與台灣配色的紅色買進鍵混淆）；開批次刪單面板，仍需滑動確認 */
export const cancelSelectedButton = style([cancelAllButton, {
    minHeight: TOUCH_MIN,
    background: vars.color.panel,
}]);

// ---- 面板（全部刪單、刪除已選、委託明細） ----

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

// GroupedSection 預設左右內縮 16（頁面用）；面板 body 已有內距，這裡歸零
globalStyle(`${sheetBody} section`, { marginLeft: 0, marginRight: 0 });

/** 面板內的說明段落 */
export const sheetText = style({
    margin: 0,
    ...TEXT.body,
    color: vars.color.foreground,
});

/** 面板內的註腳（mutedForeground） */
export const sheetNote = style({
    margin: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const footerStack = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    minWidth: 0,
});

/** footer 的「取消」「關閉」：整列寬、44px、accent 文字鍵 */
export const sheetTextButton = style([pressable, focusRing, {
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    color: vars.color.accent,
    ...TEXT.callout,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/** 涉及帳戶：GroupedSection 內一列一帳戶 */
export const accountList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    minWidth: 0,
});

export const accountItem = style({
    position: 'relative',
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `0.6875rem ${SPACE.s4}`,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});
hairlineBetween(`${accountItem} + ${accountItem}`);
globalStyle(`${accountItem} + ${accountItem}::before`, { left: SPACE.s4 });

/** 批次刪單的委託清單與結果清單（可捲動） */
export const resultList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '40vh',
    overflowY: 'auto',
    minWidth: 0,
});

export const resultItem = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    padding: `0.5625rem ${SPACE.s4}`,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});
hairlineBetween(`${resultItem} + ${resultItem}`);
globalStyle(`${resultItem} + ${resultItem}::before`, { left: SPACE.s4 });

const resultBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    fontWeight: 600,
    color: vars.color.foreground,
    selectors: {
        '&::before': {
            content: '""',
            flex: '0 0 auto',
            width: '0.5rem',
            height: '0.5rem',
            borderRadius: RADIUS.pill,
        },
    },
});

/** 每筆結果：foreground 文字＋狀態色圓點（不只靠顏色，文字即結果） */
export const resultOk = style([resultBase, { selectors: { '&::before': { background: vars.color.success } } }]);
export const resultErr = style([resultBase, { selectors: { '&::before': { background: vars.color.danger } } }]);
export const resultWarn = style([resultBase, { selectors: { '&::before': { background: vars.color.amber } } }]);

// ---- 委託明細面板 ----

/** 明細標頭：方向膠囊、代碼名稱、狀態 */
export const detailHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1_5,
    flexWrap: 'wrap',
    minWidth: 0,
    ...TEXT.headline,
    color: vars.color.foreground,
});

/** 明細欄位列（同 ValueRow 外觀，但值可換行：帳戶、訊息等長字串不撐破版面） */
export const detailRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s3,
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `0.6875rem ${SPACE.s4}`,
    minWidth: 0,
});

export const detailTerm = style({
    flex: '0 0 auto',
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const detailValue = style({
    flex: '0 1 auto',
    minWidth: 0,
    margin: 0,
    ...NUM.numSm,
    fontSize: TEXT.subhead.fontSize,
    ...NUMERIC,
    color: vars.color.foreground,
    textAlign: 'right',
    overflowWrap: 'anywhere',
});

/** 成交進度列：進度條＋文字 */
export const detailProgress = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    flex: '1 1 auto',
    minWidth: 0,
    maxWidth: '14rem',
    justifyContent: 'flex-end',
});

/** 成交時間軸：圓點＋細線（純 CSS；文字節點不變） */
export const timeline = style({
    listStyle: 'none',
    margin: 0,
    padding: `${SPACE.s2} ${SPACE.s4}`,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const timelineItem = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'baseline',
    gap: SPACE.s1_5,
    flexWrap: 'wrap',
    padding: `${SPACE.s1_5} 0 ${SPACE.s1_5} ${SPACE.s5}`,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
    selectors: {
        // 細線：貫穿每一項的左側（第一項從圓點往下、最後一項到圓點為止）
        '&::before': {
            content: '""',
            position: 'absolute',
            left: '0.25rem',
            top: 0,
            bottom: 0,
            width: '1px',
            background: vars.color.borderBright,
        },
        '&:first-child::before': { top: '0.9375rem' },
        '&:last-child::before': { bottom: 'calc(100% - 0.9375rem)' },
        '&:only-child::before': { display: 'none' },
        // 圓點
        '&::after': {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 'calc(0.9375rem - 0.28125rem)',
            width: '0.5625rem',
            height: '0.5625rem',
            boxSizing: 'border-box',
            borderRadius: RADIUS.pill,
            border: `2px solid ${vars.color.accent}`,
            background: sj.groupedBg,
        },
        '&[data-testid="detail-deal"]::after': { background: vars.color.accent },
    },
});

export const timelineTime = style({
    minWidth: '5.5em',
    color: vars.color.mutedForeground,
});

/** 明細面板 footer 的改價／減量／刪單：三等分、44px；刪單 danger 外框 */
export const detailActions = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(5.5rem, 1fr))',
    gap: SPACE.s2,
});

const detailActionBase = style([pressable, focusRing, {
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.lg,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    fontWeight: 600,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
}]);

export const detailAction = styleVariants({
    neutral: [detailActionBase],
    danger: [detailActionBase, { border: `1px solid ${vars.color.danger}`, color: vars.color.danger, boxShadow: 'none' }],
});

// ---- 成交分頁 ----

export const dealRow = style([rowMain, {}]);

/** 成交列右側（時間、帳戶）推到行尾 */
export const lineEnd = style({
    marginLeft: 'auto',
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

/** 合計卡（GroupedSection 內） */
export const totals = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    padding: `0.6875rem ${SPACE.s4}`,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
    minWidth: 0,
});

export const totalsHead = style({
    ...TEXT.headline,
    ...NUMERIC,
});

// ---- 進場淡入（批次結果、明細切換；只動畫 opacity） ----

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const fade = style({
    animation: `${fadeIn} ${DUR.fade}ms ${EASE.out} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});
