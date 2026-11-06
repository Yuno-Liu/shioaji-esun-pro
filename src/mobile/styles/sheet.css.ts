// src/mobile/styles/sheet.css.ts — 共用底部面板 v2（bottom-sheet.tsx；設計規格 §4.4–§4.6、§6.1、§6.2、§9）
//
// - 面板、暗化幕都不透明（安全資訊永遠不透明）；不用 color-mix、:has()、linear()。
// - 位移與暗化幕的 opacity 由 bottom-sheet.tsx 以彈簧直接寫 style（只動畫 transform／opacity）；這裡不寫進場關鍵影格。
// - 方向著色：兩個 toneLayer（buy／sell）各疊兩層 upDim／downDim 與 3px 方向色條，以 opacity 交叉淡化 200ms；
//   提高對比時只疊一層並加 1px borderBright 上框。
// - 面板頂端一律不進入狀態列區域：max-height 以 --sj-sheet-top（殼層提供，沒有時用同公式的後備值）計算；
//   鍵盤高度 --sj-kb 寫在 backdrop，以 padding-bottom 讓出（百分比高度以 backdrop 內容區為基準，不重複扣）。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { focusRing, hairlineTop } from './primitives.css';
import { elevation, scrimColor } from './theme-vars.css';
import { TEXT } from './typography.css';
import { DUR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_BOTTOM, SPACE, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, SHELL_VAR, TOUCH_MIN, Z } from './tokens';

/** 面板可用的最高位置（殼層未提供 --sj-sheet-top 時：狀態列高度＋8px） */
const SHEET_TOP = `var(${SHELL_VAR.sheetTop}, calc(${TOUCH_MIN} + ${SAFE_TOP} + 8px))`;

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: Z.sheet,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    boxSizing: 'border-box',
    paddingBottom: `var(${SHELL_VAR.kb}, 0px)`,
    selectors: {
        // 退場中：不再攔截點擊（下方頁面立即可用），面板內也不再接受操作
        '&[data-phase="exiting"]': { pointerEvents: 'none' },
    },
});

export const backdropConfirm = style({ zIndex: Z.confirm });

/** 暗化幕：opacity 由 JS 依面板位置寫入（1 − y／height）；pointer-events none，點擊由 backdrop 本身判斷 */
export const scrim = style({
    position: 'absolute',
    inset: 0,
    background: scrimColor.base,
    pointerEvents: 'none',
    selectors: {
        '[data-stacked="true"] > &': { background: scrimColor.stack },
    },
});

export const panel = style({
    position: 'relative',
    isolation: 'isolate',
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '640px',
    maxHeight: `calc(100% - ${SHEET_TOP})`,
    display: 'flex',
    flexDirection: 'column',
    background: vars.color.panel,
    color: vars.color.foreground,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    boxShadow: elevation.e3,
    paddingBottom: SAFE_BOTTOM,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    transformOrigin: 'top center',
    outline: 'none',
    selectors: {
        '&[data-detent="large"]': { height: `calc(100% - ${SHEET_TOP})` },
        '&[data-phase="exiting"]': { pointerEvents: 'none' },
    },
});

/** 方向著色層：在 panel 底色之上、內容之下（isolation 內 z-index −1） */
const toneLayerBase = style({
    position: 'absolute',
    inset: 0,
    zIndex: -1,
    borderRadius: 'inherit',
    pointerEvents: 'none',
    opacity: 0,
    transition: `opacity ${DUR.tone}ms ease-out`,
    '@media': { [REDUCED_MOTION]: { transition: 'none' } },
});

const toneLayerOf = (tone: 'buy' | 'sell', dim: string, color: string) => style([toneLayerBase, {
    backgroundImage: `linear-gradient(${dim}, ${dim}), linear-gradient(${dim}, ${dim})`,
    boxShadow: `inset 0 3px 0 0 ${color}`,
    selectors: {
        [`[data-tone="${tone}"] > &`]: { opacity: 1 },
    },
    '@media': {
        [MORE_CONTRAST]: {
            backgroundImage: `linear-gradient(${dim}, ${dim})`,
            boxShadow: `inset 0 3px 0 0 ${color}, inset 0 4px 0 0 ${vars.color.borderBright}`,
        },
    },
}]);

export const toneLayer = {
    buy: toneLayerOf('buy', vars.color.upDim, vars.color.up),
    sell: toneLayerOf('sell', vars.color.downDim, vars.color.down),
} as const;

/** 拖曳區（把手＋標題）：touch-action none，往下拖曳關閉；內容區維持原生捲動 */
export const grabArea = style({
    flex: '0 0 auto',
    touchAction: 'none',
    cursor: 'grab',
    paddingTop: '6px',
    userSelect: 'none',
    WebkitUserSelect: 'none',
});

export const handle = style({
    width: '36px',
    height: '5px',
    margin: '0 auto 4px',
    borderRadius: '3px',
    background: vars.color.borderBright,
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.xs} 0 ${vars.space.md}`,
});

export const title = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    ...TEXT.sheetTitle,
    outline: 'none',
});

/** 關閉鈕：點擊區 TOUCH_MIN、外觀為 30px 圓形底 */
export const closeButton = style([focusRing, {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: TOUCH_MIN,
    minHeight: TOUCH_MIN,
    padding: 0,
    border: 'none',
    borderRadius: RADIUS.pill,
    background: 'transparent',
    color: vars.color.foreground,
}]);

export const closeGlyph = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '30px',
    height: '30px',
    borderRadius: RADIUS.pill,
    background: vars.color.muted,
});

/** 標題列下方的固定區（pinned）：不捲動、不縮（body 先縮到 0），放必須一直看得到的安全資訊（確認面板環境橫幅，§10 S6） */
export const pinned = style({
    flex: '0 0 auto',
    padding: `0 ${vars.space.md} ${SPACE.s3}`,
});

/** 唯一捲動區（pinned 之下） */
export const body = style({
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: `0 ${vars.space.md} ${vars.space.md}`,
    overscrollBehavior: 'contain',
});

/** 固定 footer：與 body 同為 panel 的 flex 子元素（body 捲動不經過 footer）；背景透明讓著色層透出 */
export const footer = style([hairlineTop, {
    flex: '0 0 auto',
    padding: '8px 16px',
    background: 'transparent',
    selectors: {
        '&:empty': { display: 'none' },
    },
}]);
