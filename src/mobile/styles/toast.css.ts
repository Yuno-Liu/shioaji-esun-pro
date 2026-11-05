// src/mobile/styles/toast.css.ts — 通知（規格 §5.5）
import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { REDUCED_MOTION, SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, Z } from './metrics';

const dropIn = keyframes({ from: { transform: 'translateY(-12px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } });

export const stack = style({
    position: 'fixed',
    top: `calc(${SAFE_TOP} + 52px)`,
    left: `calc(${SAFE_LEFT} + 8px)`,
    right: `calc(${SAFE_RIGHT} + 8px)`,
    zIndex: Z.toast,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    pointerEvents: 'none',
});

const toastBase = style({
    pointerEvents: 'auto',
    display: 'block',
    width: '100%',
    padding: '10px 12px',
    borderRadius: vars.radius.lg,
    border: '1px solid',
    borderLeftWidth: '4px',
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
    textAlign: 'left',
    fontSize: '0.9375rem',
    animation: `${dropIn} 160ms ease-out`,
    '@media': { [REDUCED_MOTION]: { animation: 'none' } },
});

export const toast = styleVariants({
    deal: [toastBase, { borderColor: vars.color.accent }],
    ok: [toastBase, { borderColor: vars.color.success }],
    err: [toastBase, { borderColor: vars.color.danger }],
    info: [toastBase, { borderColor: vars.color.borderBright }],
});

export const title = style({ display: 'block', fontWeight: 700, marginBottom: '2px' });

export const line = styleVariants({
    plain: { display: 'block', color: vars.color.foreground },
    up: { display: 'block', color: vars.color.up },
    down: { display: 'block', color: vars.color.down },
});
