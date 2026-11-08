// src/mobile/styles/status-bar.css.ts — 全域狀態列 v2（設計規格 §6.5、§4.6、§4.8）與帳戶切換面板
// - 高度 TOUCH_MIN＋safe-top、不透明 panel、下緣髮絲線；位於捲動容器之外（殼層 statusWrap），不 sticky、不用材質。
// - 非 LIVE（含 ResumeGate 非 ready）：整條以 ::before 淡染狀態色（opacity .14，高度不變）。
// - 正式環境：下緣改 inset 2px danger。
// - 狀態色固定（§4.8 規則 10）：success LIVE、amber 連線中／資料過期、danger 中斷／未恢復、accent 同步中。
// - 加入通知鈴後的窄螢幕（360 寬、字級大、資料過期＋已鎖單）：環境膠囊永遠不被裁切——
//   字級大時各段左右內距 0.5rem → 0.25rem；路由膠囊內先縮帳號、再縮券商名（省略號），環境膠囊不縮；
//   寬 ≤400px 且字級大時不顯示路由的 ⌄（純裝飾，aria-hidden；按鈕名稱仍是「切換帳戶」）。
import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { focusRing, hairlineBottom, inkLayer, pressableRow } from './primitives.css';
import { sj } from './theme-vars.css';
import { LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, SPACE, TOUCH_MIN } from './tokens';
import { TEXT } from './typography.css';

/** 字級「大」（use-html-attributes 設在 html 上） */
const FONT_LARGE = 'html[data-sj-font-scale="1.3"] &';

const TONE_COLOR = {
    live: vars.color.success,
    connecting: vars.color.amber,
    down: vars.color.danger,
    syncing: vars.color.accent,
} as const;

export const bar = style([hairlineBottom, {
    position: 'relative',
    isolation: 'isolate',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    boxSizing: 'content-box',
    height: TOUCH_MIN,
    paddingTop: SAFE_TOP,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    background: vars.color.panel,
    fontSize: TEXT.callout.fontSize,
    selectors: {
        // 非 LIVE：整條淡染（不透明底＋14% 狀態色，文字仍 foreground）
        '&::before': {
            content: '""',
            position: 'absolute',
            inset: 0,
            zIndex: -1,
            pointerEvents: 'none',
            opacity: 0,
        },
        '&[data-tone="connecting"]::before': { background: TONE_COLOR.connecting, opacity: 0.14 },
        '&[data-tone="down"]::before': { background: TONE_COLOR.down, opacity: 0.14 },
        '&[data-tone="syncing"]::before': { background: TONE_COLOR.syncing, opacity: 0.14 },
        // 正式環境：下緣 2px danger（取代髮絲線的視覺）
        '&[data-env="production"]': { boxShadow: `inset 0 -2px 0 ${vars.color.danger}` },
    },
}]);

const segment = style([focusRing, {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    padding: `0 ${SPACE.s2}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: 'inherit',
    whiteSpace: 'nowrap',
    selectors: {
        '&:focus-visible': { outlineOffset: '-2px' },
        [FONT_LARGE]: { padding: `0 ${SPACE.s1}` },
    },
}]);

export const connection = style([segment, pressableRow, { flex: '0 0 auto' }]);
export const route = style([segment, pressableRow, { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', justifyContent: 'center' }]);
export const risk = style([segment, pressableRow, { flex: '0 0 auto' }]);

// ---- 左：連線膠囊 ----

const pillBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    padding: '3px 8px',
    borderRadius: RADIUS.pill,
    border: '1px solid transparent',
    color: vars.color.foreground,
    fontSize: TEXT.callout.fontSize,
    fontWeight: 600,
    lineHeight: TEXT.callout.lineHeight,
});

/** 連線膠囊外框：非 LIVE 加 1px 狀態色框 */
export const connectionPill = styleVariants({
    live: [pillBase],
    connecting: [pillBase, { borderColor: TONE_COLOR.connecting }],
    down: [pillBase, { borderColor: TONE_COLOR.down }],
    syncing: [pillBase, { borderColor: TONE_COLOR.syncing }],
});

const dotBase = style({ flex: '0 0 auto', width: '8px', height: '8px', borderRadius: '50%' });

export const dot = styleVariants({
    live: [dotBase, { background: TONE_COLOR.live }],
    connecting: [dotBase, { background: TONE_COLOR.connecting }],
    down: [dotBase, { background: TONE_COLOR.down }],
    syncing: [dotBase, { background: TONE_COLOR.syncing }],
});

const spin = keyframes({ to: { transform: 'rotate(360deg)' } });

/** 同步中：旋轉小環（只動畫 transform；減少動態時靜止） */
export const syncRing = style({
    flex: '0 0 auto',
    boxSizing: 'border-box',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: `2px solid ${TONE_COLOR.syncing}`,
    borderTopColor: 'transparent',
    animation: `${spin} 0.9s linear infinite`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

// ---- 中：路由膠囊 ----

export const routePill = style([pillBase, {
    maxWidth: '100%',
    overflow: 'hidden',
    gap: '4px',
}]);

/**
 * 券商名（第一個子元素）：可縮到 0、以省略號截斷。帳號（routeText）的 flex-shrink 大得多，所以先縮帳號、帳號縮完才縮券商名；
 * 環境膠囊 flex none 不縮（不可用小於 1 的 flex-shrink：未凍結項目的係數和 < 1 時只分到等比例的負空間，會溢出）。
 */
globalStyle(`${routePill} > span:first-child`, { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' });

/** 沒有帳戶：amber 1px 框＋foreground 文字（§4.8 規則 4：amber 不當小字顏色） */
export const routeEmpty = style([pillBase, {
    maxWidth: '100%',
    overflow: 'hidden',
    gap: '4px',
    borderColor: vars.color.amber,
}]);

/** 帳戶載入中（無框） */
export const routeLoading = style([pillBase, { color: vars.color.mutedForeground, fontWeight: 500 }]);

/** 可省略號截斷的文字段 */
export const routeText = style({ minWidth: 0, flexShrink: 1000, overflow: 'hidden', textOverflow: 'ellipsis' });

export const chevron = style({
    flex: '0 0 auto',
    color: vars.color.mutedForeground,
    '@media': {
        'screen and (max-width: 400px)': { selectors: { [FONT_LARGE]: { display: 'none' } } },
    },
});

// ---- 右：風控 ----

/** 未鎖：LockOpen＋「風控」（mutedForeground，對 panel 5.41） */
export const riskOpen = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: vars.color.mutedForeground,
    fontWeight: 500,
});

/** 已鎖：danger 實心膠囊（inkStrong）＋Lock＋白字（實心底色由 primitives fill.danger.strong 提供） */
export const riskLocked = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px',
    borderRadius: RADIUS.pill,
    fontSize: TEXT.callout.fontSize,
    fontWeight: 700,
    lineHeight: TEXT.callout.lineHeight,
});

// ---- 連線詳情與解除鎖單面板 ----

export const detailList = style({
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${SPACE.s2} ${SPACE.s4}`,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    borderRadius: RADIUS.lg,
    background: sj.islandBg,
    fontSize: TEXT.body.fontSize,
    lineHeight: 1.35,
});

export const detailTerm = style({ color: vars.color.mutedForeground });
export const detailValue = style({ margin: 0, wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' });

export const sheetActions = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s2,
    marginTop: SPACE.s4,
});

export const note = style({
    margin: `${SPACE.s2} 0 0`,
    fontSize: TEXT.subhead.fontSize,
    lineHeight: TEXT.subhead.lineHeight,
    color: vars.color.mutedForeground,
});

// ---- 帳戶切換面板（account-switch-sheet.tsx）----

export const group = style({ marginBottom: SPACE.s4 });
export const groupTitle = style({
    margin: `0 0 ${SPACE.s1_5}`,
    padding: `0 ${SPACE.s1}`,
    fontSize: TEXT.footnote.fontSize,
    fontWeight: 600,
    letterSpacing: TEXT.footnote.letterSpacing,
    color: vars.color.mutedForeground,
});

/** 帳戶列外框（GroupedSection 外觀：圓角 12、groupedBg、列間髮絲線） */
export const groupCard = style({
    borderRadius: RADIUS.lg,
    background: sj.groupedBg,
    overflow: 'hidden',
});

export const accountRow = style([pressableRow, {
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s3,
    width: '100%',
    minHeight: '52px',
    padding: `${SPACE.s2} ${SPACE.s4}`,
    border: 'none',
    borderRadius: 0,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: '1rem',
    textAlign: 'left',
    selectors: {
        '& + &': { borderTop: `0.5px solid ${vars.color.border}` },
        '&[aria-pressed="true"]': { boxShadow: `inset 3px 0 0 ${vars.color.accent}` },
        '&:disabled': { opacity: 0.55 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
    '@media': {
        [LOW_DPR]: { selectors: { '& + &': { borderTopWidth: '1px' } } },
        [MORE_CONTRAST]: { selectors: { '& + &': { borderTop: `1px solid ${vars.color.borderBright}` } } },
    },
}]);

export const accountMain = style({ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' });
export const accountName = style({ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const accountSub = style({ fontSize: TEXT.subhead.fontSize, color: vars.color.mutedForeground });
/** 不可交易：foreground 文字＋amber 圖示（§4.8 規則 4） */
export const accountWarn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: TEXT.subhead.fontSize,
    color: vars.color.foreground,
});
export const warnIcon = style({ flex: '0 0 auto', color: vars.color.amber });
export const selectedIcon = style({ flex: '0 0 auto', color: vars.color.accent });

/** 鎖定提示：islandBg＋左側 3px amber 條、foreground 文字 */
export const lockNotice = style({
    margin: `0 0 ${SPACE.s4}`,
    padding: `${SPACE.s2} ${SPACE.s3}`,
    borderRadius: RADIUS.md,
    background: sj.islandBg,
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
    color: vars.color.foreground,
    fontSize: TEXT.callout.fontSize,
});

// ---- 通知鈴：IconButton（點擊區 TOUCH_MIN）＋未讀徽章（IconButton 的 children，以按鈕定位）----

/** 未讀數：danger 實心小膠囊白字（數字本身就是資訊，不只靠顏色）；不攔點擊、不隨字級放大到蓋住圖示 */
export const badge = style({
    position: 'absolute',
    top: '4px',
    right: '2px',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    boxSizing: 'border-box',
    borderRadius: RADIUS.pill,
    // 實心 danger＋inkStrong 疊黑（§4.8 規則 3：小字白字的對比）
    backgroundColor: vars.color.danger,
    backgroundImage: inkLayer.strong,
    color: '#ffffff',
    fontSize: '11px',
    fontWeight: 700,
    lineHeight: '18px',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    pointerEvents: 'none',
    zIndex: 2,
});
