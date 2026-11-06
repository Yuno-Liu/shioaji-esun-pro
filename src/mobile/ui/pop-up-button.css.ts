// src/mobile/ui/pop-up-button.css.ts — 原生 select 的彈出鍵外觀（設計規格 §6.10）
// 可見部分為「目前選項＋ChevronsUpDown」，底層原生 <select> 透明疊滿（opacity 0、字級 ≥16px）接收點擊。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { elevation, sj } from '../styles/theme-vars.css';
import { INPUT_FONT_SIZE, MORE_CONTRAST, RADIUS, TOUCH_MIN } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';

export const root = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    minWidth: 0,
    minHeight: TOUCH_MIN,
    padding: '0 0.625rem 0 0.75rem',
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    '@media': {
        [MORE_CONTRAST]: { border: `1px solid ${vars.color.borderBright}` },
    },
});

export const disabled = style({
    opacity: 0.45,
});

export const current = style({
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const chevron = style({
    flex: '0 0 auto',
    width: '1rem',
    height: '1rem',
    color: vars.color.mutedForeground,
});

/** 透明疊滿的原生 select：真正的互動元件（testid、aria-label、value、onChange 都在這裡） */
export const select = style({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 0,
    border: 'none',
    opacity: 0,
    fontSize: INPUT_FONT_SIZE,
    cursor: 'pointer',
    appearance: 'none',
    WebkitAppearance: 'none',
    selectors: {
        '&:disabled': { cursor: 'default' },
    },
});

/** select 透明時焦點環畫在外層（focus-within） */
export const focusWithin = style({
    selectors: {
        '&:focus-within': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
    '@media': {
        [MORE_CONTRAST]: { selectors: { '&:focus-within': { outlineWidth: '3px' } } },
    },
});
