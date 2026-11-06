// src/mobile/ui/segmented.css.ts — 全站唯一的分段控制（設計規格 §6.7、§4.8 規則 5）
// thumb：軌道 segTrack、圓角 9、內距 2；拇指絕對定位、寬 (100% − 4px)/n、translateX(100%·i)，
//        segThumb＋e1＋1px accent 環（深色拇指與軌道亮度差小，靠 accent 環達 ≥3:1）；
//        只轉場 transform（240ms EASE.sheet，CSS 轉場從目前值重新導向、可中途打斷）與 opacity。
// scroll：可橫向捲動的膠囊列，選中 accentDim 底＋accent 文字。
// 尺寸：regular 外觀 TOUCH_MIN；compact 外觀 2.25rem、點擊區擴到 TOUCH_MIN。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { elevation, sj } from '../styles/theme-vars.css';
import { DUR, EASE, MORE_CONTRAST, RADIUS, REDUCED_MOTION, SIZE } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';
import { expandHit } from './chip.css';

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    minWidth: 0,
});

const trackBase = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    minWidth: 0,
    padding: '2px',
    borderRadius: RADIUS.segTrack,
    background: sj.segTrack,
});

export const track = styleVariants({
    regular: [trackBase, { minHeight: SIZE.controlRegular }],
    compact: [trackBase, { minHeight: SIZE.controlCompact }],
});

export const thumb = style({
    position: 'absolute',
    top: '2px',
    bottom: '2px',
    left: '2px',
    borderRadius: RADIUS.segThumb,
    background: sj.segThumb,
    boxShadow: `${elevation.e1}, 0 0 0 1px ${vars.color.accent}`,
    pointerEvents: 'none',
    transition: `transform ${DUR.thumb}ms ${EASE.sheet}, opacity ${DUR.fade}ms ease-out`,
    '@media': {
        [REDUCED_MOTION]: { transition: 'none' },
        [MORE_CONTRAST]: { boxShadow: `${elevation.e1}, 0 0 0 2px ${vars.color.accent}` },
    },
});

const segmentBase = style([expandHit, {
    flex: '1 1 0',
    minWidth: 0,
    zIndex: 1,
    margin: 0,
    padding: '0 0.5rem',
    border: 'none',
    borderRadius: RADIUS.segThumb,
    background: 'transparent',
    color: vars.color.mutedForeground,
    ...TEXT.callout,
    // 不設 overflow：會裁掉 ::before 擴張的點擊區
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    // 只動畫 transform／opacity：文字顏色隨拇指即時切換，不做顏色轉場
    selectors: {
        '&[aria-selected="true"], &[aria-pressed="true"]': { color: vars.color.foreground, fontWeight: 600 },
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
}]);

export const segment = segmentBase;

// ---- scroll 變體 ----

export const scroller = style({
    display: 'flex',
    gap: '0.375rem',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none',
    // 不設 WebkitOverflowScrolling：iOS 13 起預設即慣性捲動，且 WebKit 會因它建立疊層脈絡（styles/layout-stacking.test.ts）
    // 上下各留 4px：compact 膠囊的擴張點擊區不被裁切
    padding: '4px 0',
    selectors: { '&::-webkit-scrollbar': { display: 'none' } },
});

export const pill = style([expandHit, {
    flex: '0 0 auto',
    minHeight: SIZE.controlCompact,
    margin: 0,
    padding: '0 0.875rem',
    border: 'none',
    borderRadius: RADIUS.pill,
    background: sj.segTrack,
    color: vars.color.mutedForeground,
    ...TEXT.callout,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&[aria-selected="true"], &[aria-pressed="true"]': { background: vars.color.accentDim, color: vars.color.accent, fontWeight: 600 },
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
    '@media': {
        [MORE_CONTRAST]: {
            selectors: { '&[aria-selected="true"], &[aria-pressed="true"]': { boxShadow: `inset 0 0 0 2px ${vars.color.accent}` } },
        },
    },
}]);

/** 停用原因（footnote，組下方） */
export const note = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});
