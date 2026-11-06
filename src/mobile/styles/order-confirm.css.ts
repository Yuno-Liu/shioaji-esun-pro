// src/mobile/styles/order-confirm.css.ts — 確認面板（order-confirm-sheet.tsx；設計規格 §7.5、§4.7、§4.8）
// - 環境橫幅（envBanner）：全寬實心。正式＝danger＋inkLarge 白字、模擬＝accent＋inkLarge 白字、未確認＝amber 實心＋黑字。
//   狀態色不隨台灣／國際配色翻轉；白字只用 #ffffff；疊黑用 linear-gradient（不用 color-mix，iOS 15.4 相容）。
// - 動作字（confirmAction 700）用方向色 vars.color.up／down（大字，§4.8 對比表 ≥3:1）；名稱與代碼用 foreground。
// - 含 mutedForeground 標籤的明細放在 islandBg 中性島（ValueRow）；著色面板上直接承載的文字只用 foreground。
// - 字重只用 400／500／600／700（禁用 800）；數字用同字族 tabular（不換 mono）。
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { island, inkLayer } from './primitives.css';
import { LOW_DPR, MORE_CONTRAST, RADIUS, SPACE, TOUCH_MIN } from './tokens';
import { NUMERIC, TEXT } from './typography.css';

export const content = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
});

// ---- 環境橫幅 ----

const envBase = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s2,
    width: '100%',
    boxSizing: 'border-box',
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.lg,
    textAlign: 'center',
    ...TEXT.envBanner,
    '@media': {
        // 提高對比：實心底再加 1px 框
        [MORE_CONTRAST]: { boxShadow: `inset 0 0 0 1px ${vars.color.borderBright}` },
    },
});

export const env = styleVariants({
    production: [envBase, {
        backgroundColor: vars.color.danger,
        backgroundImage: inkLayer.large,
        color: '#ffffff',
    }],
    simulation: [envBase, {
        backgroundColor: vars.color.accent,
        backgroundImage: inkLayer.large,
        color: '#ffffff',
    }],
    unknown: [envBase, {
        backgroundColor: vars.color.amber,
        color: '#000000',
    }],
});

export const envIcon = style({
    flex: '0 0 auto',
    width: '1.25rem',
    height: '1.25rem',
});

// ---- 動作列 ----

const actionBase = style({
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: `0 ${SPACE.s2}`,
    minWidth: 0,
});

export const actionLine = styleVariants({
    up: [actionBase, { color: vars.color.up }],
    down: [actionBase, { color: vars.color.down }],
});

/** 動作大字（含信用名稱）；顏色繼承 actionLine 的方向色 */
export const actionBig = style({
    ...TEXT.confirmAction,
});

export const contractName = style({
    ...TEXT.sheetTitle,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const contractCode = style({
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
});

// ---- 中性島明細 ----

export const details = style([island, {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    overflow: 'hidden',
}]);

// 列間髮絲線（低密度螢幕 1px、提高對比 1px borderBright）
globalStyle(`${details} > * + *`, {
    borderTop: `0.5px solid ${vars.color.border}`,
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: `1px solid ${vars.color.borderBright}` },
    },
});

// 帳戶、priceLabel 可能較長：數值可縮可換行，不撐破島
globalStyle(`${details} > * > :last-child`, {
    flexShrink: 1,
    minWidth: 0,
    overflowWrap: 'anywhere',
});

/** 備註：footnote、foreground（著色面板上直接承載的文字只用 foreground） */
export const note = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

// ---- footer：滑塊＋取消 ----

export const footer = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
});

export const cancelButton = style({
    minHeight: TOUCH_MIN,
    width: '100%',
    borderRadius: RADIUS.lg,
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.foreground,
    ...TEXT.callout,
    fontWeight: 600,
    selectors: {
        // 著色面板上焦點環用 foreground
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { outlineWidth: '3px' } } },
    },
});
