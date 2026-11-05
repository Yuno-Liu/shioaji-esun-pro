// src/mobile/styles/controls.css.ts — 共用控制項：按鈕、買賣鍵、滑動確認、徽章（規格 §5.3、§11）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { REDUCED_MOTION, TOUCH_MIN, TRADE_BUTTON_GAP, TRADE_BUTTON_MIN_HEIGHT } from './metrics';
import { fill, pressable } from './primitives.css';
import { sj } from './theme-vars.css';
import { DUR, RADIUS } from './tokens';

// 底色不寫在 buttonBase：同權重時 CSS 以規則先後決定，buttonBase 在 primitives 之後輸出，
// 若在此寫 background 簡寫會蓋過 fill 的 backgroundColor／backgroundImage（設計規格 §4.8 規則 3、§6.14）
const buttonBase = style([pressable, {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${vars.space.md}`,
    borderRadius: vars.radius.lg,
    border: `1px solid ${vars.color.borderBright}`,
    color: vars.color.foreground,
    fontSize: '1rem',
    fontWeight: 600,
    selectors: {
        '&:disabled': { opacity: 0.45 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
}]);

/** 實心按鈕：1rem 小字 → inkStrong 疊黑（深色白字／accent 5.80、白字／紅 6.69） */
const filledButton = { borderColor: 'transparent', color: '#ffffff' } as const;

export const button = styleVariants({
    neutral: [buttonBase, { background: vars.color.panelRaised }],
    primary: [buttonBase, fill.accent.strong, filledButton],
    danger: [buttonBase, fill.danger.strong, filledButton],
    ghost: [buttonBase, { background: 'transparent', borderColor: 'transparent' }],
});

/** 買進／賣出兩鍵：高度 ≥ 56px、間距 ≥ 12px；買賣一律有文字，不只靠顏色 */
export const tradeButtonRow = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
});

/** 字級 1.1875rem 粗體（typography actionLabel）才符合大字門檻，可用 inkLarge（深色白字／綠 3.41、白字／紅 4.87） */
const tradeButtonBase = style([buttonBase, {
    minHeight: TRADE_BUTTON_MIN_HEIGHT,
    fontSize: '1.1875rem',
    fontWeight: 700,
    color: '#ffffff',
    border: 'none',
}]);

export const tradeButton = styleVariants({
    buy: [tradeButtonBase, fill.up.large],
    sell: [tradeButtonBase, fill.down.large],
});

// ---- 滑動確認（slide-to-confirm.tsx；設計規格 §6.3）----
// 把手 translateX、填充位移、軌道文字 opacity 由 slide-to-confirm.tsx 以彈簧直接寫 style（只動畫 transform／opacity）；
// 這裡的值是進度 0 的初始狀態，JS 不能執行時畫面仍正確。

/** 把手寬度＋左右留白（48px＋3px×2；與 slide-to-confirm.tsx 的 SLIDE_HANDLE_SPAN_PX 一致） */
const SLIDE_HANDLE_SPAN = 54;

export const slideWrap = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    selectors: {
        // 已確認：元件不再接受指標
        '&[data-done="true"]': { pointerEvents: 'none' },
    },
});

/** 軌道：56px pill、中性島底＋1px borderBright；停用 opacity .5 */
export const slideTrack = style({
    position: 'relative',
    height: TRADE_BUTTON_MIN_HEIGHT,
    boxSizing: 'border-box',
    borderRadius: RADIUS.pill,
    background: sj.islandBg,
    border: `1px solid ${vars.color.borderBright}`,
    overflow: 'hidden',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    selectors: {
        '&[data-disabled="true"]': { opacity: 0.5 },
    },
});

/** 就緒（p ≥ 0.8，與送出條件一致）：2px tone 色框（inset box-shadow，不改版面、不做動畫） */
const readyRing = (color: string) => ({
    selectors: { '&[data-ready="true"]': { boxShadow: `inset 0 0 0 2px ${color}` } },
});
export const slideTrackReady = styleVariants({
    neutral: readyRing(vars.color.accent),
    buy: readyRing(vars.color.up),
    sell: readyRing(vars.color.down),
    danger: readyRing(vars.color.danger),
});

export const slideFill = styleVariants({
    neutral: { background: vars.color.accentDim },
    buy: { background: vars.color.upDim },
    sell: { background: vars.color.downDim },
    danger: { background: vars.color.dangerDim },
});

/**
 * 填充：與軌道等寬、右緣起始在軌道左緣外，以 translateX(p·travel + 54px) 露出「軌道左緣到把手右緣」。
 * 用位移而非 scaleX：不需量軌道寬度，旋轉或字級改變時進度 0 的外觀仍正確（軌道 overflow hidden 裁切）。
 */
export const slideFillBase = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: '100%',
    width: '100%',
    transform: `translateX(${SLIDE_HANDLE_SPAN}px)`,
    pointerEvents: 'none',
});

export const slideLabel = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `0 ${TRADE_BUTTON_MIN_HEIGHT}`,
    fontSize: '1rem',
    fontWeight: 600,
    color: vars.color.foreground,
    pointerEvents: 'none',
    textAlign: 'center',
});

/** 把手：48px 圓、tone 實心＋inkLarge（純圖示）；未就緒（進場保護）opacity .5；鍵盤焦點環 2px foreground */
const slideHandleBase = style({
    position: 'absolute',
    top: '3px',
    left: '3px',
    width: '48px',
    height: '48px',
    borderRadius: RADIUS.pill,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    cursor: 'grab',
    touchAction: 'none',
    transition: `opacity ${DUR.fade}ms ease-out`,
    selectors: {
        '&[data-dragging="true"]': { cursor: 'grabbing' },
        '[data-armed="false"] > &': { opacity: 0.5 },
        '&:focus-visible': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '2px' },
    },
    '@media': { [REDUCED_MOTION]: { transition: 'none' } },
});

export const slideHandle = styleVariants({
    neutral: [fill.accent.large, slideHandleBase],
    buy: [fill.up.large, slideHandleBase],
    sell: [fill.down.large, slideHandleBase],
    danger: [fill.danger.large, slideHandleBase],
});

/** 提示：面板上直接承載的文字只用 foreground（著色面板對比，§4.8 規則 6） */
export const slideHint = style({
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.35,
    color: vars.color.foreground,
});

/** 停用原因：amber 圖示＋foreground 文字（淺色 amber 對白只有 3.44，不用 amber 小字） */
export const slideDisabledReason = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.4,
    color: vars.color.foreground,
});

export const slideReasonIcon = style({
    flex: '0 0 auto',
    marginTop: '0.15em',
    color: vars.color.amber,
});

// ---- 送單路由徽章（route-badge.tsx）----

const routeBadgeBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: vars.radius.md,
    fontSize: '0.8125rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    border: '1px solid',
});

export const routeBadge = styleVariants({
    /** 正式：醒目的 danger 色框 */
    production: [routeBadgeBase, { borderColor: vars.color.danger, color: vars.color.danger, background: vars.color.dangerDim }],
    /** 模擬：accent 色 */
    simulation: [routeBadgeBase, { borderColor: vars.color.accent, color: vars.color.accent, background: vars.color.accentDim }],
    /** 環境未確認 */
    unknown: [routeBadgeBase, { borderColor: vars.color.amber, color: vars.color.amber, background: 'transparent' }],
});

export const routeBadgeLarge = style({
    fontSize: '1.0625rem',
    padding: '4px 12px',
});
