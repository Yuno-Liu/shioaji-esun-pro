// src/mobile/styles/trade.css.ts — 交易頁：標頭、精簡標頭、圖表、選價列、五檔、明細、持倉摘要、交易鍵列
// （規格 §6.2、§11；設計規格 docs/fork/mobile-design.md §7.3）
//
// - 價量一律系統字 tabular（typography NUM／NUMERIC），不再用 theme 的等寬字族；字重不超過 700。
// - 漲跌與買賣顏色只用 vars.color.up／down；實心填色以 primitives 的 fill（inkLarge／inkStrong 疊黑）。
// - 精簡標頭、選價列為不透明 panel（canvas 與捲動內容上方不模糊）；只動畫 transform／opacity。
// - 量條、比例條用 ui/bars（scaleX），不再以 width 轉場。
import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill, focusRing, hairlineBottom, pressable, pressableRow } from './primitives.css';
import { elevation, sj } from './theme-vars.css';
import { DUR, EASE, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN, TRADE_BUTTON_GAP } from './tokens';
import { NUM, NUMERIC, TEXT } from './typography.css';

/** 字級「大」（§4.7）：統計格 2 欄等版面切換 */
const FONT_LARGE = 'html[data-sj-font-scale="1.3"] &';

const ellipsis = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
} as const;

/** 清單型頁面表面（§4.2 contentBg：深色 background、淺色 panel 白底，漲跌色字對比較高） */
export const page = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100%',
    background: sj.contentBg,
});

// ---- 標頭 ----

export const header = style({
    padding: `${SPACE.s2} ${SPACE.s4} ${SPACE.s1}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
});

export const titleRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: SPACE.s2,
    flexWrap: 'wrap',
});

export const title = style({
    margin: 0,
    ...TEXT.sheetTitle,
});

export const subtle = style({
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

export const priceRow = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: `2px ${SPACE.s2}`,
    flexWrap: 'wrap',
    ...NUMERIC,
});

/** 主價（numHero）；同時是跳價閃爍覆蓋層的宿主 */
export const lastPrice = style({
    position: 'relative',
    isolation: 'isolate',
    padding: '0 2px',
    borderRadius: RADIUS.sm,
    ...NUM.numHero,
    ...NUMERIC,
});

export const dirText = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.foreground },
});

export const change = style({
    ...NUM.numMd,
    ...NUMERIC,
});

/** 價格旁的標示（「參考價」「試撮 X」「可當沖」）：外框小膠囊，文字標示不只靠顏色 */
export const badge = style({
    alignSelf: 'center',
    padding: '0 6px',
    borderRadius: RADIUS.sm,
    border: `1px solid ${vars.color.borderBright}`,
    color: vars.color.mutedForeground,
    ...TEXT.footnote,
    fontWeight: 500,
    lineHeight: 1.6,
    whiteSpace: 'nowrap',
    ...NUMERIC,
});

/** 漲停／跌停：實心 up／down＋inkStrong 白字（小字）；文字本身已標示「漲停」「跌停」 */
export const badgeTone = styleVariants({
    up: [fill.up.strong, { borderColor: 'transparent', color: '#ffffff', fontWeight: 700 }],
    down: [fill.down.strong, { borderColor: 'transparent', color: '#ffffff', fontWeight: 700 }],
});

export const infoRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: `2px ${SPACE.s2}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    ...NUMERIC,
});

export const infoUp = style({ color: vars.color.up });
export const infoDown = style({ color: vars.color.down });

/** 統計格：開 高 均 總／參 低 單 額（4×2；字級「大」改 2 欄） */
export const statsGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: `2px ${SPACE.s3}`,
    margin: `${SPACE.s1} 0 0`,
    ...NUMERIC,
    selectors: {
        [FONT_LARGE]: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    },
});

export const statCell = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: SPACE.s1,
    minWidth: 0,
});

export const statLabel = style({
    flex: '0 0 auto',
    margin: 0,
    ...TEXT.caption,
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const statValue = style({
    margin: 0,
    ...ellipsis,
    ...NUM.numSm,
    ...NUMERIC,
});

/** 主價列下緣哨兵（IntersectionObserver 偵測離開 main 頂端 → 顯示精簡標頭） */
export const sentinel = style({
    height: '1px',
    marginTop: '-1px',
    pointerEvents: 'none',
});

// ---- 精簡標頭（ShellSlot top；實心 panel，不模糊） ----

export const compactBar = style([hairlineBottom, {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    boxSizing: 'border-box',
    height: SIZE.compactBarH,
    padding: `0 calc(${SPACE.s4} + ${SAFE_RIGHT}) 0 calc(${SPACE.s4} + ${SAFE_LEFT})`,
    background: vars.color.panel,
    color: vars.color.foreground,
    opacity: 0,
    transform: 'translateY(-8px)',
    transition: `opacity ${DUR.tone}ms ${EASE.out}, transform ${DUR.tone}ms ${EASE.out}`,
    selectors: {
        '&[data-visible="true"]': { opacity: 1, transform: 'none' },
        // 隱藏時不攔點擊（topSlot 的子元素預設可點）
        '&:not([data-visible="true"])': { pointerEvents: 'none' },
    },
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
    },
}]);

export const compactTitle = style({
    flex: '0 1 auto',
    ...ellipsis,
    ...TEXT.subhead,
    fontWeight: 600,
});

export const compactPrice = style({
    flex: '0 0 auto',
    marginLeft: 'auto',
    ...NUM.numMd,
    ...NUMERIC,
});

export const compactChange = style({
    flex: '0 0 auto',
    ...NUM.numSm,
    ...NUMERIC,
});

// ---- 分段列（週期、五檔／明細） ----

/** Segmented 外距列：左右 16、上下 4（compact 的擴張點擊區不與相鄰列重疊） */
export const controlRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s3,
    padding: `${SPACE.s1} ${SPACE.s4}`,
    minWidth: 0,
});

export const controlGrow = style({
    flex: '1 1 auto',
    minWidth: 0,
});

// ---- 圖表 ----

export const chartWrap = style({
    position: 'relative',
    height: '42dvh',
    minHeight: '220px',
    maxHeight: '520px',
    // 單指水平平移、雙指縮放交給 lightweight-charts（handleScroll／handleScale）；垂直滑動仍可捲動頁面
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
});

export const chartHost = style({
    position: 'absolute',
    inset: 0,
});

export const chartOverlay = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s2,
    color: vars.color.mutedForeground,
    ...TEXT.callout,
    pointerEvents: 'none',
});

export const chartOverlayAction = style({
    pointerEvents: 'auto',
});

export const chartNote = style({
    margin: 0,
    padding: `2px ${SPACE.s4}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 委託線標籤：可見膠囊較小，但點擊區至少 44px 高 */
export const orderLabel = style([focusRing, {
    position: 'absolute',
    left: SPACE.s1,
    transform: 'translateY(-50%)',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: 0,
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    zIndex: 2,
}]);

/** 委託線膠囊：實心 up／down＋inkStrong 白字（小字） */
const orderPillBase = style({
    padding: '2px 8px',
    borderRadius: RADIUS.sm,
    ...TEXT.footnote,
    fontWeight: 700,
    whiteSpace: 'nowrap',
    color: '#ffffff',
    ...NUMERIC,
});

export const orderPill = styleVariants({
    buy: [fill.up.strong, orderPillBase],
    sell: [fill.down.strong, orderPillBase],
});

// ---- 選價列（長按放開後浮出；實心 panel、不模糊；由圖表底部升起） ----

const pickRise = keyframes({
    from: { transform: 'translateY(100%)', opacity: 0 },
    to: { transform: 'none', opacity: 1 },
});

const pickSink = keyframes({
    from: { transform: 'none', opacity: 1 },
    to: { transform: 'translateY(100%)', opacity: 0 },
});

const pickFadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const pickFadeOut = keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });

/** 收回動畫時間（trade-chart 以此移除收回中的選價列） */
export const PICK_EXIT_MS = 220;

const pickBarBase = style({
    position: 'absolute',
    left: SPACE.s2,
    right: SPACE.s2,
    bottom: SPACE.s2,
    zIndex: 3,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: TRADE_BUTTON_GAP,
    padding: SPACE.s2,
    borderRadius: RADIUS.lg,
    background: vars.color.panel,
    border: `0.5px solid ${vars.color.borderBright}`,
    boxShadow: elevation.e2,
});

export const pickBar = style([pickBarBase, {
    animation: `${pickRise} ${PICK_EXIT_MS}ms ${EASE.sheet} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: `${pickFadeIn} ${DUR.fade}ms ease-out both` },
    },
}]);

/** 沿原路收回（不可點：aria-hidden＋inert＋pointer-events none，內容是 span 不是按鈕） */
export const pickBarClosing = style([pickBarBase, {
    pointerEvents: 'none',
    animation: `${pickSink} ${PICK_EXIT_MS}ms ${EASE.sheet} both`,
    '@media': {
        [REDUCED_MOTION]: { animation: `${pickFadeOut} ${DUR.fade}ms ease-out both` },
    },
}]);

/** 選價買賣鍵：CONTROL_LARGE、實心＋inkLarge、白字 actionLabel（大字門檻） */
const pickButtonBase = style([pressable, focusRing, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    minWidth: 0,
    minHeight: SIZE.controlLarge,
    padding: `0 ${SPACE.s1_5}`,
    borderRadius: RADIUS.lg,
    border: 'none',
    color: '#ffffff',
    ...TEXT.actionLabel,
    lineHeight: 1.15,
    textAlign: 'center',
    ...NUMERIC,
}]);

export const pickButton = styleVariants({
    buy: [pickButtonBase, fill.up.large],
    sell: [pickButtonBase, fill.down.large],
    cancel: [pickButtonBase, {
        minHeight: TOUCH_MIN,
        minWidth: TOUCH_MIN,
        padding: `0 ${SPACE.s2}`,
        background: 'transparent',
        color: vars.color.foreground,
        ...TEXT.callout,
        fontWeight: 600,
    }],
});

// ---- 五檔（買賣同列） ----

export const ladder = style({
    display: 'flex',
    flexDirection: 'column',
    padding: `${SPACE.s1} ${SPACE.s4}`,
    ...NUMERIC,
});

/** 下單面板內嵌：不留左右外距（面板自己有），其餘結構相同 */
export const ladderCompact = style({
    display: 'flex',
    flexDirection: 'column',
    padding: 0,
    ...NUMERIC,
});

const DEPTH_CELL_PAD = SPACE.s2;

export const depthHead = style([hairlineBottom, {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    columnGap: '1px',
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
    padding: `${SPACE.s1} 0`,
}]);

export const depthHeadVol = style({ paddingLeft: DEPTH_CELL_PAD, textAlign: 'left' });
export const depthHeadPrice = style({ padding: `0 ${DEPTH_CELL_PAD}`, textAlign: 'center' });
export const depthHeadVolRight = style({ paddingRight: DEPTH_CELL_PAD, textAlign: 'right' });

export const depthRow = style([hairlineBottom, {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    columnGap: '1px',
}]);

/** 每格：量條（VolumeBar，絕對定位）在下，量與價（position: relative）在上 */
const depthCellBase = style([pressableRow, focusRing, {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: SPACE.s1,
    minHeight: TOUCH_MIN,
    width: '100%',
    minWidth: 0,
    padding: `0 ${DEPTH_CELL_PAD}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    overflow: 'hidden',
    ...NUM.numSm,
    ...NUMERIC,
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
}]);

/** 買側：委買量靠左、買價靠右；賣側：賣價靠左、委賣量靠右（兩價在中間相鄰，量條從中線往外長） */
export const depthCell = styleVariants({
    bid: [depthCellBase, { textAlign: 'right' }],
    ask: [depthCellBase, { textAlign: 'left' }],
});

const depthVolBase = style({
    position: 'relative',
    ...ellipsis,
});

/** 量貼外側：買側靠左、賣側靠右 */
export const depthVol = styleVariants({
    bid: [depthVolBase, { textAlign: 'left' }],
    ask: [depthVolBase, { textAlign: 'right' }],
});

const depthPriceBase = style({
    position: 'relative',
    minWidth: 0,
    ...NUM.numMd,
    fontWeight: 500,
    display: 'flex',
    flexDirection: 'column',
    whiteSpace: 'nowrap',
});

/** 價格貼中線：買價靠右、賣價靠左 */
export const depthPrice = styleVariants({
    bid: [depthPriceBase, { alignItems: 'flex-end' }],
    ask: [depthPriceBase, { alignItems: 'flex-start' }],
});

/** 最佳一檔價 600 */
export const depthBest = style({ fontWeight: 600 });

export const depthTotal = style([hairlineBottom, {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: SPACE.s2,
    minHeight: '36px',
    padding: `0 ${DEPTH_CELL_PAD}`,
    ...NUM.numSm,
    ...NUMERIC,
}]);

export const depthTotalVol = style({ ...ellipsis, fontWeight: 600, textAlign: 'left' });
export const depthTotalVolRight = style({ ...ellipsis, fontWeight: 600, textAlign: 'right' });
export const depthTotalLabel = style({ ...TEXT.footnote, color: vars.color.mutedForeground, whiteSpace: 'nowrap' });

// ---- 比例條（五檔買賣比、內外盤比；條本身是 ui/bars 的 RatioBar） ----

export const ratio = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: '28px',
    padding: `0 ${DEPTH_CELL_PAD}`,
    ...TEXT.footnote,
});

export const ratioText = style({
    flex: '0 0 auto',
    ...NUM.numSm,
    fontWeight: 600,
    ...NUMERIC,
    whiteSpace: 'nowrap',
});

/** RatioBar 的外框（軌道寬 100%，由這層決定伸縮） */
export const ratioTrack = style({
    flex: '1 1 auto',
    minWidth: '40px',
    display: 'block',
});

export const innerOuter = style([ratio, {
    flexWrap: 'wrap',
    rowGap: '2px',
    paddingTop: SPACE.s1,
    paddingBottom: SPACE.s1,
}]);

export const innerOuterLabel = style({
    flex: '0 0 auto',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

/** 自己的委託「我 買2」：accent 外框小膠囊 */
export const ladderMine = style({
    display: 'inline-block',
    marginTop: '1px',
    padding: '0 5px',
    borderRadius: RADIUS.xs,
    border: `1px solid ${vars.color.accent}`,
    color: vars.color.accent,
    ...TEXT.caption,
});

/** 整股／盤中零股切換（Segmented compact）所在列 */
export const ladderToolbar = style({
    display: 'flex',
    justifyContent: 'flex-end',
    padding: `${SPACE.s1} 0`,
});

export const ladderToolbarControl = style({
    flex: '0 1 13rem',
    minWidth: 0,
});

/** 次要動作鍵（重試、重新載入）：elevatedBg＋髮絲框 */
export const toggle = style([pressable, focusRing, {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${SPACE.s4}`,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.borderBright}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
}]);

export const emptyText = style({
    margin: 0,
    padding: `${SPACE.s4} 0`,
    textAlign: 'center',
    color: vars.color.mutedForeground,
    ...TEXT.callout,
});

// ---- 明細 ----

export const tickList = style({
    listStyle: 'none',
    margin: 0,
    padding: `0 ${SPACE.s4}`,
    ...NUM.numSm,
    ...NUMERIC,
});

/** 390px 寬：時間 8 字、價格、量可收縮（minmax(0, …)＋省略號），內外盤欄固定 */
const tickGrid = {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 0.8fr) 2em',
    columnGap: SPACE.s2,
    alignItems: 'center',
} as const;

export const tickHead = style([hairlineBottom, {
    ...tickGrid,
    padding: `${SPACE.s1} ${SPACE.s4}`,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
}]);

const tickFadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });

export const tickRow = style([hairlineBottom, {
    ...tickGrid,
    minHeight: '2rem',
}]);

/** 最新一列 150ms 淡入（只動畫 opacity；減少動態由全域規則取消） */
export const tickRowNew = style([tickRow, {
    animation: `${tickFadeIn} ${DUR.fade}ms ease-out both`,
    '@media': { [REDUCED_MOTION]: { animation: 'none' } },
}]);

export const tickTime = style({ ...ellipsis, color: vars.color.mutedForeground });
export const tickNum = style({ ...ellipsis, textAlign: 'right' });
export const tickPrice = style({ fontWeight: 600 });
export const tickSide = style({ textAlign: 'right', ...TEXT.footnote, fontWeight: 600, whiteSpace: 'nowrap' });

// ---- 持倉摘要、未成交（GroupedSection 內的列） ----

export const summaryWrap = style({
    padding: `${SPACE.s3} 0`,
});

export const summaryRow = style({
    display: 'flex',
    alignItems: 'center',
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `${SIZE.rowPadY} ${SIZE.rowPadX}`,
    ...TEXT.subhead,
    ...NUMERIC,
    color: vars.color.foreground,
});

export const summaryMuted = style({
    color: vars.color.mutedForeground,
});

export const workingLink = style([pressableRow, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: TOUCH_MIN,
    boxSizing: 'border-box',
    padding: `${SIZE.rowPadY} ${SIZE.rowPadX}`,
    color: vars.color.accent,
    textDecoration: 'none',
    ...TEXT.subhead,
    fontWeight: 600,
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
}]);

// ---- 交易鍵列（ShellSlot bottom → 底部 chrome 的 bar 材質上；本身不另設底色） ----

export const tradeBar = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    padding: `8px calc(${SPACE.s4} + ${SAFE_RIGHT}) 8px calc(${SPACE.s4} + ${SAFE_LEFT})`,
});

/** 交易鍵高度 CONTROL_LARGE（字級大時隨 rem 放大，至少 56px） */
export const tradeButtonSize = style({
    minHeight: SIZE.controlLarge,
});
