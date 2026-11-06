// src/mobile/styles/device-settings.css.ts — 帳戶頁「交易成本」「本裝置」「玉山重新連線」區塊的補充樣式
// 卡片、設定列、開關、分段沿用 account.css.ts；這裡只放這三個區塊才有的欄位列與確認框（設計規格 §7.8、§4.8）。
// 狀態色（警示／錯誤）用 amber／danger，不隨漲跌配色翻轉；amber 只用於框線、左側條與實心底（黑字），不用 amber 小字。
// 不使用 color-mix()／:has() 等 iOS 15.4 不支援的語法；只動畫 transform／opacity（pressable）。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { focusRing, pressable } from './primitives.css';
import { sj } from './theme-vars.css';
import { RADIUS, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { TEXT } from './typography.css';

/** 數字欄位列：標籤＋輸入＋單位 */
export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: `${SIZE.rowPadY} 0 0`,
    boxSizing: 'border-box',
});

export const fieldLabel = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.body,
});

export const unit = style({
    flex: '0 0 2rem',
    color: vars.color.mutedForeground,
    ...TEXT.subhead,
});

export const fieldError = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.danger,
});

/** 重新連線確認框（inline alertdialog）：中性島＋amber 框線 */
export const confirmBox = style([focusRing, {
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    minWidth: 0,
    margin: `${SPACE.s2} 0`,
    padding: SPACE.s3,
    borderRadius: RADIUS.lg,
    border: `1px solid ${vars.color.amber}`,
    background: sj.islandBg,
}]);

export const confirmTitle = style({
    margin: 0,
    ...TEXT.headline,
    fontWeight: 700,
});

export const confirmText = style({
    margin: 0,
    ...TEXT.subhead,
    lineHeight: 1.5,
});

/** 警告句：foreground 粗體＋3px amber 左側條 */
export const confirmWarn = style({
    margin: 0,
    padding: `0 0 0 ${SPACE.s2}`,
    borderLeft: `3px solid ${vars.color.amber}`,
    ...TEXT.subhead,
    lineHeight: 1.5,
    fontWeight: 700,
    color: vars.color.foreground,
});

export const confirmActions = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: SPACE.s3,
});

const actionBase = style([pressable, focusRing, {
    minHeight: TOUCH_MIN,
    minWidth: 0,
    margin: 0,
    padding: `0 ${SPACE.s2}`,
    borderRadius: RADIUS.lg,
    ...TEXT.callout,
    fontWeight: 700,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
}]);

// 淺色主題島與 elevatedBg 同為 panel：以框線分出按鍵邊界
export const cancelButton = style([actionBase, {
    border: `1px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    color: vars.color.foreground,
}]);

/** amber 實心＋黑字（黑字對 amber 深 9.54、淺 6.11） */
export const confirmButton = style([actionBase, {
    border: 'none',
    background: vars.color.amber,
    color: '#000000',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

/** 錯誤或鎖定說明 */
export const alertText = style({
    margin: `${SPACE.s1} 0 ${SPACE.s2}`,
    ...TEXT.footnote,
    color: vars.color.danger,
});
