// src/mobile/styles/primitives.css.ts — Pressable 與共用 CSS primitives（設計規格 §6.14、§4.5、§4.8，純 CSS、0 KiB JS）
// - iOS Safari 的 :active 需要文件上有 touchstart 監聽（main.tsx 以被動監聽補上）。
// - 只動畫 transform 類（scale）與 opacity；減少動態時不縮放、只加深。
// - 實心填色＝底色＋黑色 linear-gradient 疊層（不混色）；白字只用 #ffffff；漲跌與買賣色只用 vars.color.up／down。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { bar, thick } from './material.css';
import { sj } from './theme-vars.css';
import { DUR, EASE, LOW_DPR, MORE_CONTRAST, RADIUS, REDUCED_MOTION } from './tokens';

// ---- Pressable ----

/** 按鈕按壓：按下 80ms 縮到 .97，放開 220ms 回彈；停用時不縮放 */
export const pressable = style({
    transition: `scale ${DUR.release}ms ${EASE.sheet}`,
    selectors: {
        '&:not(:disabled):active': { scale: '0.97', transition: `scale ${DUR.press}ms ease-out` },
    },
    '@media': {
        [REDUCED_MOTION]: {
            transition: 'none',
            selectors: { '&:not(:disabled):active': { scale: 'none', transition: 'none' } },
        },
    },
});

/** 捲動容器內的列：延後 80ms 才亮（開始捲動時瀏覽器取消 :active 就不會閃），放開 150ms 淡出 */
export const pressableRow = style({
    position: 'relative',
    selectors: {
        '&::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: vars.color.foreground,
            opacity: 0,
            pointerEvents: 'none',
            transition: `opacity ${DUR.fade}ms ease-out`,
        },
        '&:not(:disabled):active::after': {
            opacity: 0.08,
            transition: `opacity 0s linear ${DUR.press}ms`,
        },
    },
});

// ---- 無障礙與線條 ----

/** 視覺隱藏但保留給輔助技術 */
export const srOnly = style({
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
});

const HAIRLINE = `0.5px solid ${vars.color.border}`;
const HAIRLINE_CONTRAST = `1px solid ${vars.color.borderBright}`;

/** 髮絲線：0.5px border；低密度螢幕 1px；提高對比 1px borderBright */
export const hairlineTop = style({
    borderTop: HAIRLINE,
    '@media': {
        [LOW_DPR]: { borderTopWidth: '1px' },
        [MORE_CONTRAST]: { borderTop: HAIRLINE_CONTRAST },
    },
});
export const hairlineBottom = style({
    borderBottom: HAIRLINE,
    '@media': {
        [LOW_DPR]: { borderBottomWidth: '1px' },
        [MORE_CONTRAST]: { borderBottom: HAIRLINE_CONTRAST },
    },
});

/** 焦點環：2px accent、offset 2px；方向著色面板（data-tone）與材質上改 foreground；提高對比 3px */
export const focusRing = style({
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
        [`[data-tone="buy"] &:focus-visible, [data-tone="sell"] &:focus-visible, ${bar} &:focus-visible, ${thick} &:focus-visible`]: {
            outlineColor: vars.color.foreground,
        },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-visible': { outlineWidth: '3px' } } },
    },
});

// ---- 實心填色（§4.8 規則 3） ----

/** 實心填色的底色鍵：買賣與漲跌只用 up／down；accent 為互動；danger 為狀態（不隨配色翻轉） */
export type FillTone = 'up' | 'down' | 'accent' | 'danger';
/** strong＝小字（inkStrong）；large＝≥1.1875rem 粗體或純圖示（inkLarge） */
export type FillInk = 'strong' | 'large';

const FILL_COLOR: Record<FillTone, string> = {
    up: vars.color.up,
    down: vars.color.down,
    accent: vars.color.accent,
    danger: vars.color.danger,
};

const INK_VAR: Record<FillInk, string> = { strong: sj.inkStrong, large: sj.inkLarge };

const inkGradient = (ink: FillInk) => {
    const layer = `rgba(0,0,0,${INK_VAR[ink]})`;
    return `linear-gradient(${layer}, ${layer})`;
};

/** 實心填色疊黑的 background-image：同色兩端點的 linear-gradient＝一層均勻黑色 rgba(0,0,0,ink)（.css.ts 只能匯出純值） */
export const inkLayer: Record<FillInk, string> = { strong: inkGradient('strong'), large: inkGradient('large') };

/** 按壓加深：::after 黑色 opacity .10（減少動態同樣加深，只是不縮放） */
const fillPressDarken = style({
    position: 'relative',
    selectors: {
        '&::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            background: '#000000',
            opacity: 0,
            pointerEvents: 'none',
        },
        '&:not(:disabled):active::after': { opacity: 0.1 },
    },
});

function fillClass(tone: FillTone, ink: FillInk) {
    return style([fillPressDarken, {
        backgroundColor: FILL_COLOR[tone],
        backgroundImage: inkLayer[ink],
        // 疊層也鋪到 border 底下，透明框線時不露出未加深的一圈
        backgroundOrigin: 'border-box',
        color: '#ffffff',
    }]);
}

const fillPair = (tone: FillTone) => ({ strong: fillClass(tone, 'strong'), large: fillClass(tone, 'large') });

/** fill.<tone>.<ink>：例如交易鍵 fill.up.large、漲跌膠囊 fill.down.strong */
export const fill: Record<FillTone, Record<FillInk, string>> = {
    up: fillPair('up'),
    down: fillPair('down'),
    accent: fillPair('accent'),
    danger: fillPair('danger'),
};

// ---- 中性島（§4.8 規則 7） ----

/** 面板內中性島：含漲跌色小字或 mutedForeground 的區塊放這裡 */
export const island = style({
    background: sj.islandBg,
    borderRadius: RADIUS.md,
});
