// src/mobile/ui/direction-toggle.css.ts — 買賣方向鍵（設計規格 §6.8、§11）
// 兩顆 ≥56px、間距 12px（px，不隨字級）、圓角 12、actionLabel 字級。
// 選中：tone 實心＋inkLarge＋白字（primitives fill.<up|down>.large）；未選：islandBg＋1.5px tone 框＋tone 文字。
// 買進＝vars.color.up、賣出＝vars.color.down（隨台灣／國際配色）。按下 scale .97（pressable）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from '../styles/theme-vars.css';
import { RADIUS, SIZE, TRADE_BUTTON_GAP } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';

export const group = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: TRADE_BUTTON_GAP,
    minWidth: 0,
});

const keyBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.375rem',
    minWidth: 0,
    minHeight: SIZE.controlLarge,
    margin: 0,
    padding: '0 0.75rem',
    borderRadius: RADIUS.lg,
    borderWidth: '1.5px',
    borderStyle: 'solid',
    ...TEXT.actionLabel,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

/** 未選：中性島底＋tone 框與文字（大字門檻） */
export const off = styleVariants({
    up: [keyBase, { background: sj.islandBg, borderColor: vars.color.up, color: vars.color.up }],
    down: [keyBase, { background: sj.islandBg, borderColor: vars.color.down, color: vars.color.down }],
});

/** 選中：與 fill.<tone>.large 併用；框線透明維持同尺寸 */
export const on = style([keyBase, { borderColor: 'transparent' }]);

export const check = style({
    flex: '0 0 auto',
    width: '1.125rem',
    height: '1.125rem',
});
