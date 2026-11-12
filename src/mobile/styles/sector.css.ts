// src/mobile/styles/sector.css.ts — 產業流向分頁與產業說明面板（設計規格 §4、§6.11–§6.13、§11、§12）
// - 分組型頁面：background 底＋GroupedSection 卡片（groupedBg；淺色主題為白底），含漲跌色文字的摘要與產業列都在卡片內
//   （§4.8 規則 9）；頁面底色上的說明只用 mutedForeground。
// - 漲跌與流向色一律 vars.color.up／down（跟隨台灣／國際配色），並附 ▲▼ 或正負號；平盤與「—」用 flat。
// - 產業列是整列按鈕（≥ TOUCH_MIN），按下延後 80ms 加深（同 pressableRow）；數字 tabular。
// - 淨流入橫條：中線為 0，流入向右（up）、流出向左（down），只寫 transform: scaleX，減少動態時不轉場。
// - 不用 color-mix()、:has()、容器查詢、linear()；只動畫 transform／opacity。
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { DUR, EASE, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const INSET_L = `calc(${SPACE.s4} + ${SAFE_LEFT})`;
const INSET_R = `calc(${SPACE.s4} + ${SAFE_RIGHT})`;

const TONE_COLOR = { up: vars.color.up, down: vars.color.down, flat: vars.color.flat } as const;

// ---- 頁面 ----

export const page = style({
    boxSizing: 'border-box',
    minHeight: '100%',
    padding: `${SPACE.s1} 0 ${SPACE.s6}`,
    background: vars.color.background,
    color: vars.color.foreground,
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

/** 頁面上的非卡片區塊（分段、排序、說明）：左右 16＋安全區 */
export const inset = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    paddingLeft: INSET_L,
    paddingRight: INSET_R,
    minWidth: 0,
});

/** 頁面底色上的說明（mutedForeground 小字，不含漲跌色） */
export const pageNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

// ---- 頂部摘要（流入前 3／流出前 3） ----

export const summary = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: SPACE.s3,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    minWidth: 0,
});

export const summaryCol = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
});

export const summaryTitle = style({
    margin: 0,
    ...TEXT.caption,
    color: vars.color.mutedForeground,
});

export const summaryList = style({
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    minWidth: 0,
});

export const summaryItem = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minWidth: 0,
    ...TEXT.subhead,
});

export const summaryName = style({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: vars.color.foreground,
});

export const summaryEmpty = style({
    margin: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

// ---- 產業列 ----

export const row = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    width: '100%',
    minHeight: TOUCH_MIN,
    margin: 0,
    padding: `0.625rem ${SPACE.s4}`,
    boxSizing: 'border-box',
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
    minWidth: 0,
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            inset: 0,
            background: vars.color.foreground,
            opacity: 0,
            pointerEvents: 'none',
            transition: `opacity ${DUR.fade}ms ease-out`,
        },
        '&:active::before': { opacity: 0.08, transition: `opacity 0s linear ${DUR.press}ms` },
        // 卡片 overflow hidden：焦點環畫在內側
        '&:focus-visible::before': { opacity: 1, background: 'transparent', boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
});

export const rowTop = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s3,
    minWidth: 0,
});

export const rowName = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.headline,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

const pctBase = style({
    flex: '0 0 auto',
    ...NUM.numMd,
    ...NUMERIC,
});

export const pct = styleVariants(TONE_COLOR, color => [pctBase, { color }]);

export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: SPACE.s3,
    rowGap: '0.125rem',
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const metaItem = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: SPACE.s1,
    whiteSpace: 'nowrap',
});

const numBase = style({
    ...NUM.numSm,
    ...NUMERIC,
});

/** 列與摘要裡的數字：flat 為 foreground（成交值等不帶方向的數字也用它） */
export const num = styleVariants({ up: vars.color.up, down: vars.color.down, flat: vars.color.foreground, none: vars.color.flat }, color => [numBase, { color }]);

// ---- 淨流入橫條（中線為 0） ----

export const flowBar = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2px',
    height: '4px',
    marginTop: '0.125rem',
});

/**
 * 軌道：mutedForeground 低透明（::before＋opacity，不用 color-mix）。原 border 色在卡片上只有 1.08:1（深色）／1.30:1（淺色）；
 * mutedForeground×0.4 對卡片 深色 1.83:1、淺色 1.75:1。填色是後面的絕對定位兄弟，畫在 ::before 之上。
 */
export const half = style({
    position: 'relative',
    display: 'block',
    overflow: 'hidden',
    borderRadius: '2px',
    '::before': {
        content: '""',
        position: 'absolute',
        inset: 0,
        background: vars.color.mutedForeground,
        opacity: 0.4,
    },
});

const fillBase = style({
    position: 'absolute',
    inset: 0,
    transition: `transform 200ms ${EASE.out}`,
    '@media': { [REDUCED_MOTION]: { transition: 'none' } },
});

/** 流出：由中線往左長（origin right）；流入：由中線往右長（origin left） */
export const fillOut = style([fillBase, { transformOrigin: 'right center', background: vars.color.down }]);
export const fillIn = style([fillBase, { transformOrigin: 'left center', background: vars.color.up }]);

// ---- 說明面板 ----

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s4,
    paddingBottom: SPACE.s2,
    minWidth: 0,
});

// 面板已有左右內距：GroupedSection 不再內縮（同 positions／order-action 面板）
globalStyle(`${sheetBody} section`, { marginLeft: 0, marginRight: 0 });

export const valueTone = styleVariants(TONE_COLOR, color => ({ color }));

export const spark = style({
    display: 'block',
    width: '100%',
    height: '56px',
    padding: `${SPACE.s2} ${SPACE.s4}`,
    boxSizing: 'border-box',
    overflow: 'visible',
});

/** 零軸：mutedForeground×0.6（原 border 色在卡片／面板上 1.08–1.30:1；改後對卡片 深色 2.59、淺色 2.44，對面板 2.64／2.44），仍淡於資料線 */
export const sparkZero = style({
    stroke: vars.color.mutedForeground,
    strokeOpacity: 0.6,
    strokeWidth: 1,
    strokeDasharray: '3 3',
});

export const sparkLine = styleVariants(TONE_COLOR, color => ({
    fill: 'none',
    stroke: color,
    strokeWidth: 1.75,
    strokeLinejoin: 'round',
    strokeLinecap: 'round',
}));

export const sheetNote = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

// ---- 說明面板的成分股列（成交值前 10 檔；點列開交易頁） ----
// 列沿用產業列 row 的按壓與焦點；名稱 headline、代碼 mutedForeground；成交價漲跌色，漲停／跌停時改實心 up／down 底＋白字
// （primitives fill.*.strong，§4.8 ≥4.5:1）並加「漲停／跌停」小標（watchlist.css limitTag）。

export const memberTitle = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: SPACE.s1_5,
    flex: '1 1 auto',
    minWidth: 0,
});

export const memberCode = style({
    flex: '0 0 auto',
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

export const memberPrice = style({
    flex: '0 0 auto',
    padding: '0 0.25rem',
    margin: '0 -0.25rem',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    ...NUM.numMd,
    ...NUMERIC,
});

export const memberEmpty = style({
    margin: 0,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});
