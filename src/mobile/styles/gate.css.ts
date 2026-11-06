// src/mobile/styles/gate.css.ts — 「需要 HTTPS」說明頁（規格 R1；設計規格 §7.8）
// 靜態、無材質、無動畫；GroupedSection 外觀（標題在卡片外 footnote、groupedBg 卡片）。
// 不溢出：頁面 overflow-x hidden、overflow-wrap anywhere；診斷表 auto＋minmax(0, 1fr)；
// 網址與診斷值保留 SELECTABLE（元件端加上）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { LOW_DPR, MORE_CONTRAST, RADIUS, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { TEXT } from './typography.css';

const HAIRLINE = `0.5px solid ${vars.color.border}`;

export const page = style({
    boxSizing: 'border-box',
    width: '100%',
    height: ['100%', '100dvh'],
    overflowY: 'auto',
    overflowX: 'hidden',
    overflowWrap: 'anywhere',
    padding: `calc(${SAFE_TOP} + ${SPACE.s6}) calc(${SAFE_RIGHT} + ${SPACE.s4}) calc(${SAFE_BOTTOM} + ${SPACE.s6}) calc(${SAFE_LEFT} + ${SPACE.s4})`,
    background: vars.color.background,
    color: vars.color.foreground,
    ...TEXT.body,
});

/** 內容欄：寬螢幕置中、最大 640px */
export const inner = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s6,
    minWidth: 0,
    maxWidth: '640px',
    margin: '0 auto',
});

export const title = style({
    margin: 0,
    padding: `0 ${SPACE.s4}`,
    ...TEXT.pageTitle,
    color: vars.color.danger,
});

export const section = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
});

/** 卡片外標題（footnote、mutedForeground） */
export const heading = style({
    margin: 0,
    padding: `0 ${SPACE.s4}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const card = style({
    minWidth: 0,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
});

export const text = style({
    margin: 0,
    selectors: { '& + &': { marginTop: SPACE.s2 } },
});

/** 編號卡：每一項一張卡，左側圓形編號（CSS counter，ol 保留清單語意） */
export const list = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    counterReset: 'sj-step',
});

export const step = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    alignItems: 'start',
    columnGap: SPACE.s3,
    minWidth: 0,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    counterIncrement: 'sj-step',
    selectors: {
        '&::before': {
            content: 'counter(sj-step)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '1.5rem',
            height: '1.5rem',
            borderRadius: RADIUS.pill,
            background: sj.islandBg,
            color: vars.color.foreground,
            ...TEXT.caption,
            fontVariantNumeric: 'tabular-nums',
        },
    },
});

export const stepBody = style({ minWidth: 0 });

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8125rem',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
});

export const diag = style({
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    columnGap: SPACE.s3,
    minWidth: 0,
    padding: `0 ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    ...TEXT.subhead,
});

const cell = {
    minWidth: 0,
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `${SIZE.rowPadY} 0`,
    lineHeight: '1.35rem',
} as const;

export const term = style({
    ...cell,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    selectors: { '&:not(:first-child)': { borderTop: HAIRLINE } },
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { selectors: { '&:not(:first-child)': { borderTop: `1px solid ${vars.color.borderBright}` } } },
    },
});

export const value = style({
    ...cell,
    margin: 0,
    fontFamily: vars.font.mono,
    // 長值（UA、來源）換行後靠左較好讀
    textAlign: 'left',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    selectors: { [`${term}:not(:first-child) + &`]: { borderTop: HAIRLINE } },
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { selectors: { [`${term}:not(:first-child) + &`]: { borderTop: `1px solid ${vars.color.borderBright}` } } },
    },
});

export const flag = styleVariants({
    ok: { color: vars.color.success, fontWeight: 700 },
    bad: { color: vars.color.danger, fontWeight: 700 },
});
