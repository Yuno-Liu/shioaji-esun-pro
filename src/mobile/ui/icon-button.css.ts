// src/mobile/ui/icon-button.css.ts — 圖示鍵（設計規格 §6.10）
// 點擊區 44×44（隨字級放大）、圖示 18–24px；pressed 時 accentDim 底；面板關閉鈕為 30px 圓（elevatedBg）內 X 18px。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from '../styles/theme-vars.css';
import { RADIUS, TOUCH_MIN } from '../styles/tokens';

const base = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    margin: 0,
    padding: 0,
    border: 'none',
    borderRadius: RADIUS.pill,
    background: 'transparent',
    color: vars.color.foreground,
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

export const button = styleVariants({
    regular: [base, {
        borderRadius: RADIUS.lg,
        selectors: {
            '&[aria-pressed="true"]': { background: vars.color.accentDim, color: vars.color.accent },
        },
    }],
    // 關閉鈕：點擊區仍 44×44，可見為 30px 圓
    close: [base, {
        color: vars.color.mutedForeground,
        selectors: {
            '&::after': {
                content: '""',
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: '30px',
                height: '30px',
                marginTop: '-15px',
                marginLeft: '-15px',
                borderRadius: RADIUS.pill,
                background: sj.elevatedBg,
                zIndex: 0,
            },
        },
    }],
});

/** 圖示在圓底之上 */
export const icon = style({
    position: 'relative',
    zIndex: 1,
    flex: '0 0 auto',
});
