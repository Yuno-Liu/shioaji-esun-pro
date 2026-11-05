// src/mobile/styles/layout.css.ts — 手機殼層版面：100dvh、安全區、底部分頁（規格 §5.1、§11）
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { INPUT_FONT_SIZE, REDUCED_MOTION, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, TOUCH_MIN, Z } from './metrics';

// 只由手機入口載入：不影響桌面 index.html
globalStyle('html', {
    WebkitTextSizeAdjust: '100%',
    textSizeAdjust: '100%',
});

// 使用者需求「手勢縮放或選取到文字可以禁止嗎」：
// - touch-action: manipulation：保留捲動與雙指手勢，但停用雙擊放大（頁面雙指縮放由 lib/gesture-guard.ts 擋）。
//   瀏覽器以元素與祖先的 touch-action 取交集，圖表容器自己的 touch-action（例如 none）仍然生效。
// - -webkit-user-select（iOS 15.4 只認前綴）＋user-select：整頁不可選取文字；
//   -webkit-touch-callout: none：長按不跳出 iOS 的拷貝／查詢選單。輸入欄位與 .selectable 在下方恢復。
globalStyle('html, body', {
    touchAction: 'manipulation',
});

globalStyle('body', {
    overscrollBehavior: 'none',
    WebkitTapHighlightColor: 'transparent',
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', sans-serif",
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
});

/**
 * 可選取／長按複製的全域類別（不經 vanilla-extract 雜湊）：需要讓使用者複製回報的值（網址、診斷值、UA、建置版本）
 * 在 className 加上 SELECTABLE，下方的全域規則會恢復選取（-webkit-user-select／user-select: text）與 iOS 長按選單。
 */
export const SELECTABLE = 'selectable';

/** 恢復選取與長按選單的選擇器（輸入欄位、contenteditable、.selectable 及其子孫） */
export const SELECTABLE_RESTORE_SELECTOR = `input, textarea, [contenteditable]:not([contenteditable="false"]), .${SELECTABLE}, .${SELECTABLE} *`;

// 可輸入與明確標示可選取（className 加 SELECTABLE）的區域恢復選取與長按選單；
// iOS 在祖先為 -webkit-user-select: none 時輸入框可能無法定位游標，需明確設回 text
globalStyle(SELECTABLE_RESTORE_SELECTOR, {
    WebkitUserSelect: 'text',
    userSelect: 'text',
    WebkitTouchCallout: 'default',
});

// iOS Safari 對字級 < 16px 的輸入欄位聚焦時會自動放大
globalStyle('input, select, textarea', {
    fontSize: INPUT_FONT_SIZE,
});

globalStyle('*, *::before, *::after', {
    '@media': {
        [REDUCED_MOTION]: {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
        },
    },
});

export const shell = style({
    display: 'flex',
    flexDirection: 'column',
    // 不用 100vh（行動瀏覽器網址列會讓 100vh 超出可視區）；不支援 dvh 時退回 100%
    height: ['100%', '100dvh'],
    width: '100%',
    overflow: 'hidden',
    background: vars.color.background,
    color: vars.color.foreground,
});

export const main = style({
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
});

export const tabBar = style({
    position: 'sticky',
    bottom: 0,
    zIndex: Z.bars,
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    background: vars.color.panel,
    borderTop: `1px solid ${vars.color.border}`,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
});

export const tab = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    minHeight: '52px',
    minWidth: TOUCH_MIN,
    color: vars.color.mutedForeground,
    textDecoration: 'none',
    fontSize: '0.75rem',
    selectors: {
        '&[aria-current="page"]': { color: vars.color.accent, fontWeight: 600 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const tabBadge = style({
    position: 'absolute',
    top: '4px',
    left: 'calc(50% + 6px)',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    borderRadius: '9px',
    background: vars.color.danger,
    color: '#ffffff',
    fontSize: '0.6875rem',
    fontWeight: 700,
    lineHeight: '18px',
    textAlign: 'center',
});

export const page = style({
    padding: `${vars.space.md} ${vars.space.md} ${vars.space.lg}`,
});

export const pageTitle = style({
    margin: `0 0 ${vars.space.sm}`,
    fontSize: '1.25rem',
    fontWeight: 700,
});

export const placeholder = style({
    margin: 0,
    color: vars.color.mutedForeground,
});

/** 分頁模組第一次載入時的佔位（app.tsx 的 Suspense fallback） */
export const routeLoading = style({
    margin: 0,
    padding: '32px 16px',
    textAlign: 'center',
    color: vars.color.mutedForeground,
});

/** 延遲載入模組失敗時的提示（components/route-error-boundary.tsx） */
export const moduleError = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: vars.space.md,
    padding: '32px 16px',
    textAlign: 'center',
});

export const moduleErrorText = style({
    margin: 0,
    color: vars.color.foreground,
});

export const moduleErrorActions = style({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: vars.space.sm,
});
