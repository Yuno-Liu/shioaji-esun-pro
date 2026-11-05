// src/mobile/styles/device-settings.css.ts — 帳戶頁「交易成本」「本裝置」「玉山重新連線」區塊的補充樣式
// 卡片、設定列、開關、分段沿用 account.css.ts；這裡只放這三個區塊才有的欄位列與確認框。
// 狀態色（警示／錯誤）用 amber／danger，不隨漲跌配色翻轉；不使用 color-mix()／:has() 等 iOS 15.4 不支援的語法。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { TOUCH_MIN } from './metrics';

/** 數字欄位列：標籤＋輸入＋單位 */
export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: '52px',
});

export const fieldLabel = style({
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '0.9375rem',
});

export const unit = style({
    flex: '0 0 2rem',
    color: vars.color.mutedForeground,
    fontSize: '0.875rem',
});

export const fieldError = style({
    margin: 0,
    fontSize: '0.8125rem',
    color: vars.color.danger,
});

/** 重新連線確認框（inline alertdialog） */
export const confirmBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    marginTop: vars.space.sm,
    padding: vars.space.sm,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.amber}`,
    background: vars.color.panelRaised,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const confirmTitle = style({
    margin: 0,
    fontSize: '0.9375rem',
    fontWeight: 700,
});

export const confirmText = style({
    margin: 0,
    fontSize: '0.875rem',
    lineHeight: 1.5,
});

export const confirmWarn = style({
    margin: 0,
    fontSize: '0.875rem',
    lineHeight: 1.5,
    fontWeight: 700,
    color: vars.color.amber,
});

export const confirmActions = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.sm,
});

const actionBase = {
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    borderRadius: vars.radius.lg,
    fontSize: '0.9375rem',
    fontWeight: 700,
} as const;

export const cancelButton = style({
    ...actionBase,
    border: `1px solid ${vars.color.borderBright}`,
    background: vars.color.panel,
    color: vars.color.foreground,
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const confirmButton = style({
    ...actionBase,
    border: `1px solid ${vars.color.amber}`,
    background: vars.color.amber,
    color: '#000000',
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

/** 錯誤或鎖定說明 */
export const alertText = style({
    margin: `${vars.space.xs} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.danger,
});
