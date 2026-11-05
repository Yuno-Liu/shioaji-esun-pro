// src/mobile/styles/order-ticket.css.ts — 下單面板（order-ticket-sheet.tsx、ticket/*；設計規格 §7.4、§4.8）
// 版面：第一列（路由、帳戶、鎖說明、當沖）→ 精簡報價島 → 方向鍵 → 單位＋條件 → 價格 → 快捷價 → 數量 → 資訊島
// → 提示 → 五檔島；狀態行與 CTA 在 SheetFooter（固定 footer）。
// 顏色規則（§4.8）：著色面板上直接承載的文字只用 foreground；含漲跌色小字或 mutedForeground 的區塊放 islandBg 中性島；
// 買賣與漲跌顏色只用 vars.color.up／down；實心填色疊黑用 primitives 的 fill（≥1.1875rem 粗體用 inkLarge）。
// 相容：不用 color-mix()、:has()、CSS linear()；只動畫 transform／opacity；減少動態時停止轉環與淡入。
import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { DUR, EASE, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

export const form = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

/** 著色面板上的註腳：一律 foreground（§4.8 規則 6） */
export const footnote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.foreground,
});

/** 中性島內的次要文字（mutedForeground 只放在 islandBg 上） */
export const muted = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

// ---- 第一列：路由、帳戶、鎖說明、當沖 ----

export const metaRow = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${SPACE.s1} ${SPACE.s2}`,
    minWidth: 0,
});

export const account = style({
    ...TEXT.subhead,
    fontWeight: 500,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
    minWidth: 0,
});

/** 鎖說明鍵（IconButton）在列中不撐高整列：外觀小、點擊區仍 44px */
export const lockButton = style({
    margin: `calc((${TOUCH_MIN} - 1.75rem) / -2) 0`,
});

export const tag = style({
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '1.5rem',
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.pill,
    border: `1px solid ${vars.color.borderBright}`,
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

// ---- 精簡報價（中性島） ----

export const quoteRow = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: `${SPACE.s1} ${SPACE.s2}`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    minWidth: 0,
    '@media': {
        [MORE_CONTRAST]: { boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}` },
    },
});

export const quoteMain = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    minWidth: 0,
});

const DIR_COLOR = { up: vars.color.up, down: vars.color.down, flat: vars.color.flat } as const;

/** 主價：1.1875rem／700 漲跌色（大字門檻） */
export const quotePrice = styleVariants(DIR_COLOR, color => [{
    ...NUMERIC,
    fontSize: '1.1875rem',
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: '-0.01em',
    color,
}]);

export const quoteChange = styleVariants(DIR_COLOR, color => [{
    ...NUMERIC,
    ...NUM.numSm,
    fontWeight: 600,
    color,
}]);

export const quoteVolume = style({
    ...NUMERIC,
    ...NUM.numSm,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

// ---- 單位＋條件（同列） ----

export const condRow = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    alignItems: 'center',
    gap: SPACE.s2,
});

/** 條件摘要鈕：外觀 2.25rem（與 compact 分段同高），點擊區以 ::before 擴到 TOUCH_MIN */
export const condSummary = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s1,
    minHeight: SIZE.controlCompact,
    width: '100%',
    minWidth: 0,
    margin: 0,
    padding: `0 ${SPACE.s2} 0 ${SPACE.s3}`,
    boxSizing: 'border-box',
    borderRadius: RADIUS.md,
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    color: vars.color.foreground,
    ...TEXT.callout,
    fontWeight: 600,
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&::before': { content: '""', position: 'absolute', left: 0, right: 0, top: '-4px', bottom: '-4px' },
        '&:disabled': { opacity: 0.45 },
    },
});

export const condSummaryText = style({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const chevron = style({
    flex: '0 0 auto',
    width: '1rem',
    height: '1rem',
    transition: `transform ${DUR.tone}ms ${EASE.out}`,
    selectors: {
        '[aria-expanded="true"] > &': { transform: 'rotate(180deg)' },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
});

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

/** 展開區：中性島；高度立即改變、內容 150ms 淡入（不做高度動畫） */
export const condPanel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    padding: SPACE.s3,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    animation: `${fadeIn} ${DUR.fade}ms ease-out`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
        [MORE_CONTRAST]: { boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}` },
    },
});

export const fieldBlock = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
});

/** 欄位標籤：footnote 500 foreground */
export const fieldLabel = style({
    ...TEXT.footnote,
    fontWeight: 500,
    color: vars.color.foreground,
});

/** 中性島內的欄位標籤（可用 mutedForeground） */
export const islandLabel = style({
    ...TEXT.footnote,
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

/** 中性島內的停用原因與說明 */
export const islandNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 現股當沖先賣（切換鍵） */
const daytradeBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s1_5,
    minHeight: TOUCH_MIN,
    width: '100%',
    margin: 0,
    padding: `0 ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    ...TEXT.callout,
    fontWeight: 600,
    color: vars.color.foreground,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

export const daytradeToggle = styleVariants({
    on: [daytradeBase, { background: vars.color.downDim, border: `1.5px solid ${vars.color.down}` }],
    off: [daytradeBase, { background: sj.elevatedBg, border: `1px solid ${vars.color.borderBright}` }],
});

export const checkIcon = style({ width: '1rem', height: '1rem', flex: '0 0 auto' });

// ---- 價格／數量 ----

/** 標籤列：左「價格」＋即時價；右價別 PopUpButton */
export const labelRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minHeight: '1.25rem',
    minWidth: 0,
});

export const labelGroup = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    minWidth: 0,
});

/** 即時成交價：數字 foreground（§4.8 規則 8），▲▼ 另用漲跌色 */
export const livePrice = style({
    ...NUMERIC,
    ...TEXT.footnote,
    fontWeight: 500,
    color: vars.color.foreground,
});

export const liveArrow = styleVariants(DIR_COLOR, color => [{ color }]);

/** 價別 PopUpButton：靠右、不撐滿 */
export const priceType = style({
    flex: '0 0 auto',
    minWidth: '6rem',
});

/** 限價偏離提醒：amber 條＋foreground（只提醒、不阻擋） */
export const deviation = style([footnote, {
    ...NUMERIC,
    padding: `${SPACE.s1} 0 ${SPACE.s1} ${SPACE.s2}`,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
}]);

// ---- 資訊（中性島兩欄） ----

export const infoIsland = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${SPACE.s2} ${SPACE.s3}`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    minWidth: 0,
    '@media': {
        [MORE_CONTRAST]: { boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}` },
    },
});

export const infoCell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    selectors: {
        '&:only-child': { gridColumn: '1 / -1' },
    },
});

export const infoLabel = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const infoValue = style({
    ...NUMERIC,
    ...NUM.numMd,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const costRow = style({
    gridColumn: '1 / -1',
    margin: 0,
    ...NUMERIC,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

// ---- 提示 ----

export const checkboxLabel = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    cursor: 'pointer',
});

export const checkbox = style({
    width: '22px',
    height: '22px',
    flex: '0 0 auto',
    margin: 0,
});

// ---- footer：狀態行＋CTA ----

export const footerStack = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    minWidth: 0,
});

const statusBase = style({
    margin: 0,
    ...TEXT.subhead,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

/** 第一個停用原因：文字「⚠ ＋原因」，前方 3px amber 條 */
export const problem = style([statusBase, {
    paddingLeft: SPACE.s2,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
}]);

export const feedback = styleVariants({
    cancelled: [statusBase],
    'not-sent': [statusBase, { display: 'flex', alignItems: 'flex-start', gap: SPACE.s1_5, fontWeight: 600 }],
});

export const feedbackIcon = style({
    flex: '0 0 auto',
    width: '1rem',
    height: '1rem',
    marginTop: '0.125rem',
    color: vars.color.danger,
});

/** 摘要「限價 1,085 × 1 張 ≈ 1,085,000 元」 */
export const summary = style([statusBase, NUMERIC]);

const ctaBase = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s2,
    minHeight: SIZE.controlLarge,
    width: '100%',
    margin: 0,
    padding: `${SPACE.s1_5} ${SPACE.s3}`,
    boxSizing: 'border-box',
    borderRadius: RADIUS.lg,
    border: 'none',
    ...TEXT.actionLabel,
    textAlign: 'center',
    overflowWrap: 'anywhere',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

/** 有方向時再疊 primitives 的 fill.up／down.large（實心＋inkLarge＋白字） */
export const cta = styleVariants({
    tone: [ctaBase],
    none: [ctaBase, {
        background: sj.islandBg,
        boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}`,
        color: vars.color.foreground,
    }],
});

const spin = keyframes({ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } });

/** 送出中轉環（只動畫 transform；減少動態靜止） */
export const spinner = style({
    flex: '0 0 auto',
    width: '1em',
    height: '1em',
    boxSizing: 'border-box',
    borderRadius: '50%',
    border: '2px solid currentColor',
    borderRightColor: 'transparent',
    animation: `${spin} 0.8s linear infinite`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

// ---- 內嵌五檔（中性島） ----

export const ladderSection = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
});

export const ladderIsland = style({
    padding: SPACE.s2,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    minWidth: 0,
});
