// src/mobile/styles/status-bar.css.ts — 全域狀態列（規格 §5.2）
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, TOUCH_MIN, Z } from './metrics';

export const bar = style({
    position: 'sticky',
    top: 0,
    zIndex: Z.bars,
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    paddingTop: SAFE_TOP,
    paddingLeft: SAFE_LEFT,
    paddingRight: SAFE_RIGHT,
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
    fontSize: '0.875rem',
});

const segment = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: TOUCH_MIN,
    padding: `0 ${vars.space.sm}`,
    border: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: 'inherit',
    whiteSpace: 'nowrap',
    selectors: {
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '-2px' },
    },
});

export const connection = style([segment, { flex: '0 0 auto', fontWeight: 700 }]);
export const route = style([segment, { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', justifyContent: 'center' }]);
export const routeText = style({ overflow: 'hidden', textOverflow: 'ellipsis' });
export const risk = style([segment, { flex: '0 0 auto' }]);

export const dot = styleVariants({
    live: { width: '10px', height: '10px', borderRadius: '5px', background: vars.color.success },
    connecting: { width: '10px', height: '10px', borderRadius: '5px', background: vars.color.amber },
    down: { width: '10px', height: '10px', borderRadius: '5px', background: vars.color.danger },
    syncing: { width: '10px', height: '10px', borderRadius: '5px', background: vars.color.accent },
});

export const lightText = styleVariants({
    live: { color: vars.color.success },
    connecting: { color: vars.color.amber },
    down: { color: vars.color.danger },
    syncing: { color: vars.color.accent },
});

export const riskLocked = style({
    color: vars.color.danger,
    fontWeight: 700,
});

export const riskOpen = style({
    color: vars.color.mutedForeground,
});

export const detailList = style({
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${vars.space.xs} ${vars.space.md}`,
    fontSize: '0.9375rem',
});

export const detailTerm = style({ color: vars.color.mutedForeground });
export const detailValue = style({ margin: 0, wordBreak: 'break-all' });

export const sheetActions = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    marginTop: vars.space.md,
});

export const note = style({
    margin: `${vars.space.sm} 0 0`,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
});

// ---- 帳戶切換面板（account-switch-sheet.tsx）----

export const group = style({ marginBottom: vars.space.md });
export const groupTitle = style({
    margin: `0 0 ${vars.space.xs}`,
    fontSize: '0.8125rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
});

export const accountRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    width: '100%',
    minHeight: '52px',
    padding: `${vars.space.sm} ${vars.space.md}`,
    marginBottom: vars.space.xs,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '1rem',
    textAlign: 'left',
    selectors: {
        '&[aria-pressed="true"]': { borderColor: vars.color.accent, boxShadow: `inset 0 0 0 1px ${vars.color.accent}` },
        '&:disabled': { opacity: 0.55 },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '2px' },
    },
});

export const accountMain = style({ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' });
export const accountSub = style({ fontSize: '0.8125rem', color: vars.color.mutedForeground });
export const accountWarn = style({ fontSize: '0.8125rem', color: vars.color.amber });
export const lockNotice = style({
    margin: `0 0 ${vars.space.md}`,
    padding: vars.space.sm,
    borderRadius: vars.radius.md,
    background: vars.color.muted,
    color: vars.color.amber,
    fontSize: '0.875rem',
});
