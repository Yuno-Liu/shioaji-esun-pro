// src/mobile/styles/material.css.ts — 半透明材質 bar／thick 與後備（設計規格 §4.6、§9、§12）
// theme 色為不透明 hex，不混色：透明元素＋isolation＋::before 以 opacity 疊 vars 底色；
// WebkitBackdropFilter 與 backdropFilter 並寫（Safari 18 前只認前綴）。
// 只用於底部 chrome（交易鍵列＋分頁列共用一片）與通知；狀態列、面板、資料區一律不透明。
// 降低透明度（App 內 html[data-sj-transparency="reduced"]，或系統 prefers-reduced-transparency 且屬性非 full）、
// 面板開啟（殼層 data-sheet-open="true"）、不支援 backdrop-filter、提高對比 → 全部實心。不動畫 blur 半徑。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { MORE_CONTRAST, REDUCED_TRANSPARENCY } from './tokens';

const NO_FILTER = { WebkitBackdropFilter: 'none', backdropFilter: 'none' } as const;
const SOLID = { opacity: 1 } as const;
const NO_BACKDROP_SUPPORT = 'not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))';

function material(blur: string, background: string, alpha: string) {
    const filter = `blur(${blur}) saturate(180%)`;
    return style({
        position: 'relative',
        isolation: 'isolate',
        background: 'transparent',
        WebkitBackdropFilter: filter,
        backdropFilter: filter,
        selectors: {
            '&::before': {
                content: '""',
                position: 'absolute',
                inset: 0,
                zIndex: -1,
                pointerEvents: 'none',
                borderRadius: 'inherit',
                background,
                opacity: alpha,
            },
            '[data-sheet-open="true"] &': NO_FILTER,
            '[data-sheet-open="true"] &::before': SOLID,
            'html[data-sj-transparency="reduced"] &': NO_FILTER,
            'html[data-sj-transparency="reduced"] &::before': SOLID,
        },
        '@supports': {
            [NO_BACKDROP_SUPPORT]: { selectors: { '&::before': SOLID } },
        },
        '@media': {
            [REDUCED_TRANSPARENCY]: {
                selectors: {
                    'html:not([data-sj-transparency="full"]) &': NO_FILTER,
                    'html:not([data-sj-transparency="full"]) &::before': SOLID,
                },
            },
            [MORE_CONTRAST]: {
                ...NO_FILTER,
                boxShadow: `inset 0 1px 0 ${vars.color.borderBright}`,
                selectors: { '&::before': SOLID },
            },
        },
    });
}

/** 底部 chrome（交易鍵列＋分頁列共用一片） */
export const bar = material('20px', vars.color.panel, sj.barAlpha);

/** 通知 */
export const thick = material('30px', vars.color.panelRaised, sj.thickAlpha);
