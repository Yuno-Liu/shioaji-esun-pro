// src/mobile/styles/env-switch-overlay.css.ts — 玉山環境切換「結果確認中」的非模態橫幅（components/env-switch-overlay.tsx；延遲載入）
import { style } from '@vanilla-extract/css';
import { SHELL_VAR, Z } from './tokens';

/** 狀態列下方、通知之下：不攔背景操作（永豐照常），只有橫幅本身可讀 */
export const banner = style({
    position: 'fixed',
    left: '16px',
    right: '16px',
    top: `calc(var(${SHELL_VAR.stripH}) + 8px)`,
    zIndex: Z.toast - 1,
    pointerEvents: 'none',
});
