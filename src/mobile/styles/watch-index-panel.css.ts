// src/mobile/styles/watch-index-panel.css.ts — 自選頁底部指數列的展開面板（components/watch-index-panel.tsx；隨面板延遲載入）
// - bar 材質上（殼層配件槽）：標籤、指數、漲跌、成交金額文字一律 foreground（設計規格 §4.6、§4.8 規則 6／8）；
//   方向只由有色的 ▲▼ 圖形（watchlist.css indexArrow＋tone）表示；走勢線顏色由 WatchSparkline 依昨收決定。
// - 兩欄等寬（minmax(0, 1fr)），欄間一條髮絲線；右端的收合鍵在 watchlist.css indexToggle（外層 indexBar）。
// - 360 寬＋字級「大」（html[data-sj-font-scale="1.3"]）每欄約 140px：數字不截斷、不裁切（沒有 overflow／ellipsis）。
//   指數大字在字級「大」縮小一級；漲跌點數與漲跌幅、「成交金額」與金額放不下時各自整段換行（nowrap 片段＋flex-wrap）。
// - 走勢圖高 3.75rem、寬度填滿該欄、兩欄底部對齊（canvas 依 clientWidth／clientHeight 與 devicePixelRatio 設定點陣；尺寸改變時重畫）。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { SPACE } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const LARGE = 'html[data-sj-font-scale="1.3"] &';

export const panel = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    paddingBottom: SPACE.s1,
});

/** 一欄（按鈕）：直向排列、靠左；點按只導頁到該指數交易頁 */
export const column = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    minWidth: 0,
    margin: 0,
    padding: `${SPACE.s1_5} ${SPACE.s2} 0`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        // 兩欄之間一條髮絲線（不用 :has()）
        '& + &': { boxShadow: `inset 0.5px 0 0 ${vars.color.border}` },
        [LARGE]: { padding: `${SPACE.s1_5} ${SPACE.s1} 0` },
    },
});

/** 文字區（標籤到預估）：佔滿走勢以上的高度，兩欄行數不同時走勢圖仍底部對齊 */
export const info = style({
    flex: '1 0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
    minWidth: 0,
    paddingBottom: SPACE.s1,
});

export const label = style({
    ...TEXT.subhead,
    fontWeight: 600,
    color: vars.color.foreground,
});

/** 指數（大字）：不換行；字級「大」縮小一級（360 寬每欄約 140px） */
export const value = style({
    ...NUM.numLg,
    ...NUMERIC,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    selectors: {
        [LARGE]: { fontSize: '1.0625rem' },
    },
});

/** ▲▼＋漲跌點數＋漲跌幅：放不下時漲跌幅整段換到下一行 */
export const change = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACE.s1,
    rowGap: 0,
    ...NUM.numSm,
    ...NUMERIC,
    fontWeight: 600,
    color: vars.color.foreground,
});

/** 成交金額：「成交金額」與「10,033 億」各自不換行，放不下時金額整段換到下一行 */
export const amount = style({
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: SPACE.s1,
    rowGap: 0,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.foreground,
});

/** 盤中預估成交金額（小字） */
export const estimate = style({
    ...TEXT.caption,
    ...NUMERIC,
    fontWeight: 400,
    color: vars.color.foreground,
});

export const nowrap = style({ whiteSpace: 'nowrap' });

/** 當日走勢面積圖：寬度填滿該欄、高 3.75rem */
export const chart = style({
    display: 'block',
    width: '100%',
    height: '3.75rem',
});
