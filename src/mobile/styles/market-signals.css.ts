// src/mobile/styles/market-signals.css.ts — 「市場 → 盤中異動」（設計規格 §4、§6.10、§6.11、§11、§12）
// - 頁面外框沿用 sector.css 的 page（由 routes/market-page.tsx 提供）；篩選區的左右內縮在這裡另寫一份（與 sector.css inset 相同），
//   不從本 chunk 匯入 sector.css，以免它被切成獨立 chunk、多一筆首屏預載清單項目。
// - 篩選：Chip 換行排列（flex-wrap，360 寬＋字級 1.3 不橫向捲動）；列與列之間留 8px 垂直間距（Chip 點擊區上下擴到 TOUCH_MIN）。
// - 訊號列是整列按鈕（≥ TOUCH_MIN），兩行：名稱＋代碼｜成交價；時間・市場・訊號標籤・補充｜漲跌。
//   訊號與漲跌都有文字（標籤、正負號），顏色只是輔助；試撮以文字徽章標示。
// - 只用 transform／opacity 轉場，減少動態時取消；不用 color-mix()、:has()、容器查詢。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { DUR, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

const TONE_COLOR = { up: vars.color.up, down: vars.color.down, flat: vars.color.foreground } as const;

/** 頁面上的非卡片區塊：左右 16＋安全區（同 sector.css inset） */
export const inset = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    paddingLeft: `calc(${SPACE.s4} + ${SAFE_LEFT})`,
    paddingRight: `calc(${SPACE.s4} + ${SAFE_RIGHT})`,
    minWidth: 0,
});

export const filterGroup = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: SPACE.s2,
    rowGap: SPACE.s2,
    minWidth: 0,
});

export const filterLabel = style({
    flex: '0 0 auto',
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    marginRight: SPACE.s1,
});

export const statusLine = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

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
        '&:focus-visible::before': { opacity: 1, background: 'transparent', boxShadow: `inset 0 0 0 2px ${vars.color.accent}` },
    },
    '@media': { [REDUCED_MOTION]: { selectors: { '&::before': { transition: 'none' } } } },
});

export const rowTop = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s3,
    minWidth: 0,
});

export const rowTitle = style({
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'baseline',
    gap: SPACE.s1_5,
    minWidth: 0,
    overflow: 'hidden',
});

export const rowName = style({
    minWidth: 0,
    ...TEXT.headline,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const rowCode = style({
    flex: '0 0 auto',
    ...NUM.numSm,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

export const price = style({
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: SPACE.s1,
    ...NUM.numMd,
    ...NUMERIC,
});

/** 試撮徽章：文字＋框線（不只靠顏色） */
export const simBadge = style({
    flex: '0 0 auto',
    padding: '0 0.3125rem',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.mutedForeground}`,
    ...TEXT.caption,
    color: vars.color.foreground,
    background: sj.elevatedBg,
    whiteSpace: 'nowrap',
});

export const rowMeta = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: SPACE.s3,
    rowGap: '0.125rem',
    minWidth: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
});

export const metaLeft = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: SPACE.s2,
    rowGap: '0.125rem',
    minWidth: 0,
});

export const time = style({
    ...NUM.numSm,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

const labelBase = style({ fontWeight: 600, whiteSpace: 'nowrap' });

export const ruleLabel = styleVariants(TONE_COLOR, color => [labelBase, { color }]);

const changeBase = style({ ...NUM.numSm, ...NUMERIC, whiteSpace: 'nowrap', marginLeft: 'auto' });

export const change = styleVariants({ ...TONE_COLOR, flat: vars.color.flat }, color => [changeBase, { color }]);
