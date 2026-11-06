// src/mobile/styles/toast.css.ts — 通知 v2（設計規格 docs/fork/mobile-design.md §6.4、§4.6、§9、§12）
//
// - 雙錨點：底部模式（沒有面板）在分頁列／配件列上方；頂部精簡模式（有面板，容器 data-anchor="top"）
//   是狀態列區域內的單行膠囊，只顯示前景一則，其餘視覺隱藏（仍留給輔助技術）並以「+N」計數。
// - 疊放：所有卡片放在同一個 grid 格（grid-area 1/1），以 data-depth 的個別 transform 屬性 scale／translate
//   錯開露出邊緣；JS 彈簧只寫 element.style.transform（進出場、拖曳），兩者自動相乘、互不覆寫。
//   展開（data-expanded="true"）時各占一列、間距 8px。
// - thick 材質（material.css.ts）、圓角 16、e2；文字一律 foreground；kind 以圖示顏色與左側 3px 色條區分。
//   只有前景那則（data-front="true"）保留 backdrop-filter；疊放在後、頂部隱藏、退場中的一律實心（STACKED_SOLID），
//   同畫面模糊層 ≤ 3（§0.2 第 13 項：底部 chrome 1 ＋ 通知 1）。面板開啟（殼層 data-sheet-open）、降低透明度、
//   提高對比、不支援 backdrop-filter 時由 thick 本身改為全部實心。
// - 只動畫 transform／opacity；減少動態時 CSS 轉場關閉（JS 端改淡入淡出）。不用 color-mix、:has()、linear()。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { thick } from './material.css';
import { focusRing } from './primitives.css';
import { TEXT } from './typography.css';
import {
    DUR,
    EASE,
    ELEVATION,
    RADIUS,
    REDUCED_MOTION,
    SAFE_BOTTOM,
    SAFE_LEFT,
    SAFE_RIGHT,
    SAFE_TOP,
    SHELL_VAR,
    SIZE,
    TOUCH_MIN,
    Z,
} from './tokens';

/** 底部錨點：分頁列（含 safe-bottom）＋配件列＋8px；殼層變數尚未設定時退回預設值 */
const BOTTOM_ANCHOR = `calc(var(${SHELL_VAR.tabbarH}, calc(${SIZE.tabbarH} + ${SAFE_BOTTOM})) + var(${SHELL_VAR.accessoryH}, 0px) + 8px)`;
/** 頂部精簡膠囊高度：狀態列高度 − 8px（上下各留 4px，完全落在狀態列區域內） */
const PILL_H = `calc(${TOUCH_MIN} - 8px)`;

export const stack = style({
    position: 'fixed',
    left: `calc(${SAFE_LEFT} + 8px)`,
    right: `calc(${SAFE_RIGHT} + 8px)`,
    bottom: BOTTOM_ANCHOR,
    // 寬螢幕置中（fixed＋left/right＋max-width＋margin auto）
    maxWidth: '640px',
    marginLeft: 'auto',
    marginRight: 'auto',
    zIndex: Z.toast,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'end',
    pointerEvents: 'none',
    selectors: {
        '&[data-expanded="true"]': { rowGap: '8px' },
        '&[data-anchor="top"]': {
            top: `calc(${SAFE_TOP} + 4px)`,
            bottom: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '6px',
        },
    },
});

const TOP = `${stack}[data-anchor="top"]`;

/**
 * 非前景通知改實心（停用模糊、::before 底色不透明）。
 * 特異度 .toastBase[data-front] (0,2,0)／(0,2,1) 高於 thick 的 .thick／.thick::before，可覆寫其模糊與半透明底。
 */
export const STACKED_SOLID = {
    '&[data-front="false"]': { WebkitBackdropFilter: 'none', backdropFilter: 'none' },
    '&[data-front="false"]::before': { opacity: 1 },
} as const;
const TOP_COMPACT = `${stack}[data-anchor="top"]:not([data-expanded="true"])`;

const toastBase = style({
    pointerEvents: 'auto',
    gridArea: '1 / 1',
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    columnGap: '10px',
    rowGap: '2px',
    alignItems: 'start',
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    padding: '10px 8px 10px 12px',
    borderRadius: RADIUS.xl,
    borderLeft: '3px solid transparent',
    boxShadow: ELEVATION.e2,
    color: vars.color.foreground,
    textAlign: 'left',
    // 拖曳由 JS 接手；卡片內不需要原生捲動或選取
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    cursor: 'default',
    // 底部模式疊放往上露：以上緣為原點縮放再上移
    transformOrigin: 'top center',
    transition: `scale ${DUR.thumb}ms ${EASE.out}, translate ${DUR.thumb}ms ${EASE.out}`,
    selectors: {
        '&[data-depth="0"]': { zIndex: 3 },
        '&[data-depth="1"]': { zIndex: 2, scale: '0.95', translate: '0 -6px' },
        '&[data-depth="2"]': { zIndex: 1, scale: '0.9', translate: '0 -12px' },
        '&[data-leaving="true"]': { pointerEvents: 'none' },
        ...STACKED_SOLID,
        [`${stack}[data-expanded="true"] &`]: { gridArea: 'auto', scale: 'none', translate: 'none' },
        // 頂部精簡模式：前景一則為單行膠囊
        [`${TOP} &`]: {
            flex: '1 1 auto',
            alignItems: 'center',
            scale: 'none',
            translate: 'none',
            transformOrigin: 'bottom center',
        },
        [`${TOP_COMPACT} &`]: {
            height: PILL_H,
            padding: '0 2px 0 12px',
            borderRadius: RADIUS.pill,
            alignContent: 'center',
        },
        // 頂部模式的非前景：視覺隱藏但保留給輔助技術（role=alert／status 仍會宣告）
        [`${TOP} &[data-front="false"]`]: {
            position: 'absolute',
            width: '1px',
            height: '1px',
            padding: 0,
            margin: '-1px',
            overflow: 'hidden',
            clip: 'rect(0, 0, 0, 0)',
            whiteSpace: 'nowrap',
            border: 0,
            boxShadow: 'none',
        },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
});

/** 單則外層 className 只放這組（狀態用 data-front／data-depth／data-leaving） */
export const toast = styleVariants({
    deal: [thick, toastBase, { borderLeftColor: vars.color.accent }],
    ok: [thick, toastBase, { borderLeftColor: vars.color.success }],
    err: [thick, toastBase, { borderLeftColor: vars.color.danger }],
    /** 結果未知：琥珀色條與圖示（文字仍為 foreground，§4.8 規則 4），與確定未送出的紅色區分 */
    warn: [thick, toastBase, { borderLeftColor: vars.color.amber }],
    info: [thick, toastBase, { borderLeftColor: vars.color.borderBright }],
});

const iconBase = style({
    gridColumn: '1',
    gridRow: '1',
    flex: 'none',
    width: '18px',
    height: '18px',
    marginTop: '1px',
    selectors: {
        [`${TOP} &`]: { marginTop: 0 },
    },
});

export const icon = styleVariants({
    deal: [iconBase, { color: vars.color.accent }],
    ok: [iconBase, { color: vars.color.success }],
    err: [iconBase, { color: vars.color.danger }],
    warn: [iconBase, { color: vars.color.amber }],
    info: [iconBase, { color: vars.color.foreground }],
});

/** 材質上的文字字重加一級（§4.6） */
export const title = style({
    ...TEXT.headline,
    fontWeight: 700,
    gridColumn: '2',
    gridRow: '1',
    display: 'block',
    minWidth: 0,
    overflowWrap: 'anywhere',
    selectors: {
        [`${TOP_COMPACT} &`]: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    },
});
/** 結果未知的標題：獨立 class（文字仍 foreground；琥珀色只用於圖示與色條） */
export const titleWarn = style([title, { color: vars.color.foreground }]);

const lineBase = style({
    ...TEXT.subhead,
    fontWeight: 500,
    gridColumn: '2',
    display: 'block',
    minWidth: 0,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
    selectors: {
        [`${TOP_COMPACT} &`]: { display: 'none' },
    },
});

/** 內文行：有漲跌方向時 foreground 文字加 3px 方向色條（買賣與漲跌色只用 vars.color.up／down） */
export const line = styleVariants({
    plain: [lineBase],
    up: [lineBase, { borderLeft: `3px solid ${vars.color.up}`, paddingLeft: '6px' }],
    down: [lineBase, { borderLeft: `3px solid ${vars.color.down}`, paddingLeft: '6px' }],
});

/** 關閉鈕：外觀 36px，點擊區以 ::after 擴到 44px */
export const close = style([
    focusRing,
    {
        gridColumn: '3',
        gridRow: '1',
        alignSelf: 'start',
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: SIZE.controlCompact,
        height: SIZE.controlCompact,
        margin: '-6px 0',
        padding: 0,
        border: 0,
        borderRadius: RADIUS.pill,
        background: 'transparent',
        color: vars.color.foreground,
        cursor: 'pointer',
        selectors: {
            '&::after': { content: '""', position: 'absolute', inset: '-4px' },
            [`${TOP} &`]: { alignSelf: 'center', margin: 0 },
        },
    },
]);

/** 頂部精簡模式的「+N」計數 */
export const more = style({
    ...TEXT.caption,
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    height: PILL_H,
    minWidth: PILL_H,
    padding: '0 10px',
    borderRadius: RADIUS.pill,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    boxShadow: ELEVATION.e2,
    pointerEvents: 'none',
    fontVariantNumeric: 'tabular-nums',
});
