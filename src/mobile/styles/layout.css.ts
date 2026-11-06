// src/mobile/styles/layout.css.ts — 手機殼層版面：100dvh、安全區、底部 chrome 與分頁（規格 §5.1、§11；設計規格 §6.6、§7.1）
import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import * as material from './material.css';
import { INPUT_FONT_SIZE, REDUCED_MOTION, SAFE_BOTTOM, SAFE_LEFT, SAFE_RIGHT, TOUCH_MIN, Z } from './metrics';
import { fill, focusRing, hairlineTop } from './primitives.css';
import { RADIUS, SHELL_VAR, SHELL_VAR_DEFAULTS } from './tokens';
import { TEXT } from './typography.css';

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

// ---- 殼層（設計規格 §6.6、§7.1） ----
//
// .shell（relative；100% → 100dvh；flex column；overflow hidden；--sj-* 變數；data-sheet-open）
// ├ .statusWrap（不透明狀態列，不在捲動容器內）
// ├ .mainWrap（flex 1）
// │   ├ main（absolute inset 0、唯一捲動容器；底部內距讓出底部 chrome，內容從 chrome 下方捲過）
// │   └ .topSlot（交易頁精簡標頭等，疊在內容上）
// ├ .bottomStack（absolute bottom；bar 材質一片：配件槽＋分頁列）
// ├ ToastHost
// └ #sj-sheet-root（面板 portal 目標）
//
// 重要：.shell、.mainWrap、main 不得有 transform／filter／backdrop-filter／will-change／contain:paint，
// 否則 main 內 position:fixed 的全螢幕圖表（chart.css.ts）與面板會改以該祖先定位而無法覆蓋全頁。
// 也不得建立疊層脈絡（z-index、isolation、opacity…），也不可設定 WebkitOverflowScrolling：
// WebKit（iOS Safari）會把帶 touch 值的捲動容器當成 z-index 0 的疊層脈絡，main 內 fixed 子孫因此永遠在
// .bottomStack（z 10）／.topSlot（z 11）之下（舊版「平倉說明」按鈕被分頁列擋住即此原因；Chrome 不支援該屬性，
// 模擬器重現不了）。iOS 13 起捲動容器預設就有慣性捲動，不需要它。styles/layout-stacking.test.ts 靜態檢查。
// 材質（backdrop-filter、isolation）只放在 .bottomStack（main 的兄弟節點）。

/** 底部 chrome 讓出的高度：分頁列＋配件槽（交易鍵列） */
const BOTTOM_CHROME = `calc(var(${SHELL_VAR.tabbarH}) + var(${SHELL_VAR.accessoryH}))`;

export const shell = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    // 不用 100vh（行動瀏覽器網址列會讓 100vh 超出可視區）；不支援 dvh 時退回 100%
    height: ['100%', '100dvh'],
    width: '100%',
    overflow: 'hidden',
    background: vars.color.background,
    color: vars.color.foreground,
    vars: { ...SHELL_VAR_DEFAULTS },
});

/** 狀態列容器（面板開啟時 inert＋aria-hidden 的目標）；不設 z-index：全螢幕圖表（z 50）仍可蓋過 */
export const statusWrap = style({
    position: 'relative',
    flex: '0 0 auto',
});

/** 內容區容器（inert 目標）：只提供 absolute main 的定位基準 */
export const mainWrap = style({
    position: 'relative',
    flex: '1 1 auto',
    minHeight: 0,
});

export const main = style({
    position: 'absolute',
    inset: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    paddingBottom: BOTTOM_CHROME,
    scrollPaddingBottom: BOTTOM_CHROME,
    outline: 'none',
});

/** 疊在內容上方的插槽（交易頁精簡標頭）：本身不攔點擊，子元素才可點 */
export const topSlot = style({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: Z.compactBar,
    pointerEvents: 'none',
});

globalStyle(`${topSlot} > *`, { pointerEvents: 'auto' });

/** 底部 chrome：配件槽（交易鍵列）＋分頁列共用一片 bar 材質，頂端一條髮絲線 */
export const bottomStack = style([material.bar, hairlineTop, {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: Z.bars,
}]);

/** 配件槽：ResizeObserver 量實際高度寫入 --sj-accessory-h；沒有內容時高度 0 */
export const accessorySlot = style({
    position: 'relative',
    zIndex: Z.accessory,
});

/** 面板 portal 目標（面板本身 position:fixed，這個節點高度為 0、不佔版面；不設 z-index 以免形成疊層脈絡） */
export const sheetRoot = style({
    flex: '0 0 auto',
});

export const tabBar = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    boxSizing: 'border-box',
    height: `var(${SHELL_VAR.tabbarH})`,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
});

/** 分頁：材質上的文字一律 foreground、字重加一級；active 用 accent（另以圖示線寬與 aria-current 區分） */
export const tab = style([focusRing, {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    color: vars.color.foreground,
    textDecoration: 'none',
    fontSize: TEXT.caption.fontSize,
    fontWeight: 600,
    lineHeight: TEXT.caption.lineHeight,
    letterSpacing: TEXT.caption.letterSpacing,
    selectors: {
        '&[aria-current="page"]': { color: vars.color.accent, fontWeight: 700 },
        '&:focus-visible': { outlineOffset: '-2px' },
    },
}]);

/** 圖示外框：徽章與待對帳點以它定位 */
export const tabIcon = style({
    position: 'relative',
    display: 'inline-flex',
    width: '24px',
    height: '24px',
});

/** 未成交徽章：danger＋inkStrong 白字（§4.8 規則 3），>99 顯示 99+ */
export const tabBadge = style([fill.danger.strong, {
    position: 'absolute',
    top: '-5px',
    left: 'calc(100% - 7px)',
    boxSizing: 'border-box',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    borderRadius: RADIUS.pill,
    fontSize: TEXT.caption.fontSize,
    fontWeight: 700,
    lineHeight: '18px',
    letterSpacing: 0,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    boxShadow: `0 0 0 1.5px ${vars.color.panel}`,
}]);

const dotBase = style({
    position: 'absolute',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: vars.color.amber,
    boxShadow: `0 0 0 1.5px ${vars.color.panel}`,
});

/** 待對帳 amber 點：沒有徽章時在右上，有徽章時移到左上避免重疊 */
export const tabDot = styleVariants({
    alone: [dotBase, { top: '-2px', right: '-3px' }],
    withBadge: [dotBase, { top: '-2px', left: '-3px' }],
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
