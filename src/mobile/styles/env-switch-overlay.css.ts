// src/mobile/styles/env-switch-overlay.css.ts — 玉山環境切換「結果確認中」的非模態橫幅（components/env-switch-overlay.tsx；延遲載入）
import { style } from '@vanilla-extract/css';
import { SHELL_VAR, Z } from './tokens';

/**
 * 狀態列下方：不攔背景操作（永豐照常），只有橫幅本身可讀。
 * 層級在所有面板之下（Z.sheet - 1）：打開的面板一律蓋過橫幅，下單面板第一列的 RouteBadge（環境）
 * 必須看得到（設計規格 §10 S6）；面板內另有自己的說明（例如玉山下單面板的 ticketProblem）。
 */
export const banner = style({
    position: 'fixed',
    left: '16px',
    right: '16px',
    top: `calc(var(${SHELL_VAR.stripH}) + 8px)`,
    zIndex: Z.sheet - 1,
    pointerEvents: 'none',
});
