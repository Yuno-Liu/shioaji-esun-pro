// src/components/trading-cost-settings.css.ts — 設定 → 交易成本（fork 元件樣式）

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const fieldLabel = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    width: '6.5rem',
    flexShrink: 0,
    alignSelf: 'center',
});

export const unit = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    alignSelf: 'center',
    minWidth: '1.6rem',
});

export const errorText = style({
    fontSize: '0.66rem',
    color: vars.color.danger,
    padding: '0 8px',
});
