// src/mobile/styles/order-action.css.ts — 委託操作面板（components/order-action-sheet.tsx；設計規格 §7.5）
// 頂部 GroupedSection 摘要 → 選單 ListRow（改價／減量／刪單）或子畫面（Stepper）→ footer 滑塊＋「返回」。
// 委託頁共用的 OrderLines／OrderBadges 仍用 orders.css.ts（本檔不改它）；成交進度改 ui/bars 的 ProgressBar（scaleX）。
// 刪單用 danger（狀態色，不隨配色翻轉）；不用 color-mix()、:has()；只動畫 transform／opacity。
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { RADIUS, SPACE, TOUCH_MIN } from './tokens';
import { TEXT } from './typography.css';

export const body = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    minWidth: 0,
});

// GroupedSection 預設左右內縮 16（頁面用）；面板 body 已有內距，這裡歸零
globalStyle(`${body} section`, { marginLeft: 0, marginRight: 0 });

/** 摘要卡內容（OrderLines） */
export const summary = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1,
    padding: `0.6875rem ${SPACE.s4}`,
    minWidth: 0,
    ...TEXT.subhead,
});

/** 成交進度條外框（role=progressbar 在這層；視覺由 ProgressBar 的軌道與 scaleX 填色呈現） */
export const progress = style({
    display: 'block',
    flex: '1 1 100%',
    width: '100%',
    minWidth: 0,
});

/** 刪單列：標題文字與圖示用 danger */
export const dangerRow = style({});
globalStyle(`${dangerRow} button`, { color: vars.color.danger });

export const rowIcon = style({ width: '1.25rem', height: '1.25rem' });
export const rowIconDanger = style([rowIcon, { color: vars.color.danger }]);

export const fieldBlock = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s1_5,
    minWidth: 0,
});

export const fieldLabel = style({
    ...TEXT.footnote,
    fontWeight: 500,
    color: vars.color.foreground,
});

/** 檢查結果（新價格問題、減量說明） */
export const note = style({
    margin: 0,
    ...TEXT.subhead,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

/** 第一個停用原因：foreground＋前方 3px amber 條 */
export const problem = style({
    margin: 0,
    paddingLeft: SPACE.s2,
    ...TEXT.subhead,
    color: vars.color.foreground,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
    overflowWrap: 'anywhere',
});

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

export const gateText = style({ display: 'block' });

export const footerStack = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    minWidth: 0,
});

/** 「返回」文字鍵：整列寬、44px 點擊區、accent 文字 */
export const backButton = style({
    minHeight: TOUCH_MIN,
    width: '100%',
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
});
