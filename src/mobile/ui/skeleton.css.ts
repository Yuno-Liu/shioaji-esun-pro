// src/mobile/ui/skeleton.css.ts — 載入骨架（設計規格 §6.13）
// muted 圓角 6 色塊，opacity 1.2 秒在 .55 與 1 間脈動（只動畫 opacity）；減少動態靜止。
import { keyframes, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { RADIUS, REDUCED_MOTION, SPACE } from '../styles/tokens';

const pulse = keyframes({
    '0%': { opacity: 1 },
    '50%': { opacity: 0.55 },
    '100%': { opacity: 1 },
});

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    padding: `${SPACE.s3} ${SPACE.s4}`,
    minWidth: 0,
});

export const row = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s4,
});

export const block = style({
    display: 'block',
    height: '0.875rem',
    borderRadius: RADIUS.sm,
    background: vars.color.muted,
    animation: `${pulse} 1.2s ease-in-out infinite`,
    '@media': {
        [REDUCED_MOTION]: { animation: 'none' },
    },
});

export const blockWide = style({ width: '45%' });
export const blockNarrow = style({ width: '22%' });
