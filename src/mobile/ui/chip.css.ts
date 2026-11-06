// src/mobile/ui/chip.css.ts — Chip（設計規格 §6.10）與 compact 控制共用的點擊區擴張
// 外觀 2.25rem、點擊區擴到 TOUCH_MIN；圓角 8；elevatedBg＋髮絲框；callout 字級；選中 segThumb＋accent 環；停用 opacity .45。
// dataPrice：價格以 data-price 屬性＋::after { content: attr(data-price) } 顯示第二行（numSm、mutedForeground），
// 按鈕文字節點仍只有標籤。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { elevation, sj } from '../styles/theme-vars.css';
import { MORE_CONTRAST, RADIUS, SIZE, TOUCH_MIN } from '../styles/tokens';
import { NUM, NUMERIC, TEXT } from '../styles/typography.css';

/**
 * compact 控制（外觀 36px）的點擊區：::before 上下擴到 TOUCH_MIN（左右不擴，避免與相鄰鍵重疊）。
 * 元素本身需 position: relative；相鄰元素須留 ≥8px 垂直間距。
 */
export const expandHit = style({
    position: 'relative',
    selectors: {
        '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            right: 0,
            // 絕對定位的 top／bottom 百分比相對於自身高度：(高度 − TOUCH_MIN) ÷ 2，外觀已 ≥ TOUCH_MIN 時為 0 或正值（不縮小）
            top: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
            bottom: `min(0px, calc((100% - ${TOUCH_MIN}) / 2))`,
        },
    },
});

export const chip = style([expandHit, {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    minHeight: SIZE.controlCompact,
    padding: '0 0.625rem',
    margin: 0,
    borderRadius: RADIUS.md,
    border: `0.5px solid ${vars.color.border}`,
    background: sj.elevatedBg,
    boxShadow: elevation.e1,
    color: vars.color.foreground,
    ...TEXT.callout,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&[aria-pressed="true"]': {
            background: sj.segThumb,
            boxShadow: `${elevation.e1}, 0 0 0 1px ${vars.color.accent}`,
            fontWeight: 600,
        },
        '&:disabled': { opacity: 0.45, cursor: 'default' },
        // 第二行價格（attr 只讀屬性，不產生文字節點）
        '&[data-price]::after': {
            content: 'attr(data-price)',
            display: 'block',
            ...NUM.numSm,
            ...NUMERIC,
            color: vars.color.mutedForeground,
        },
    },
    '@media': {
        [MORE_CONTRAST]: {
            border: `1px solid ${vars.color.borderBright}`,
            selectors: { '&[aria-pressed="true"]': { boxShadow: `${elevation.e1}, 0 0 0 2px ${vars.color.accent}` } },
        },
    },
}]);

/** 有價格第二行時：兩行高 48px（快捷價） */
export const twoLine = style({
    minHeight: '48px',
    lineHeight: 1.2,
    padding: '0 0.25rem',
});

/** 標籤（單行省略；裁切只在內層 span，不裁按鈕的擴張點擊區） */
export const label = style({
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});
