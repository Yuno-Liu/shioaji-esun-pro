// src/mobile/ui/page-header.css.ts — 頁首（設計規格 §6.10、§4.7 pageTitle）
// 高 TOUCH_MIN、左右 16（＋安全區）；h1 用 pageTitle；不做大標題收合。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { SAFE_LEFT, SAFE_RIGHT, SPACE, TOUCH_MIN } from '../styles/tokens';
import { TEXT } from '../styles/typography.css';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s2,
    minHeight: TOUCH_MIN,
    paddingLeft: `calc(${SPACE.s4} + ${SAFE_LEFT})`,
    paddingRight: `calc(${SPACE.s4} + ${SAFE_RIGHT})`,
    minWidth: 0,
});

export const title = style({
    flex: '1 1 auto',
    minWidth: 0,
    margin: 0,
    ...TEXT.pageTitle,
    color: vars.color.foreground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const actions = style({
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1,
    // 圖示鍵 44×44 的視覺邊緣對齊右邊距
    marginRight: '-0.625rem',
});
