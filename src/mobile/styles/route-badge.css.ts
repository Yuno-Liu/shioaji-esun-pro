// src/mobile/styles/route-badge.css.ts — 送單路由徽章與環境小膠囊（設計規格 §6.5、§4.8）
// - 外框膠囊（borderBright）＋foreground「送往 永豐 」＋環境實心小膠囊；沒有路由（未選擇帳戶）時 amber 框。
// - 環境小膠囊（狀態列、帳戶切換面板、RouteBadge 共用）：正式＝danger＋inkStrong 白字、模擬＝accent＋inkStrong 白字、
//   環境未確認＝amber 實心黑字（§4.8 規則 4、10：狀態色固定、不隨配色翻轉）。
// 路由徽章樣式只在這裡（controls.css.ts 的舊 routeBadge 匯出已在 B4 刪除）。
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { fill } from './primitives.css';
import { RADIUS } from './tokens';
import { TEXT } from './typography.css';

const envBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    flex: '0 0 auto',
    padding: '1px 6px',
    borderRadius: RADIUS.xs,
    fontSize: TEXT.caption.fontSize,
    fontWeight: 700,
    lineHeight: TEXT.caption.lineHeight,
    letterSpacing: TEXT.caption.letterSpacing,
    whiteSpace: 'nowrap',
});

/** 環境實心小膠囊：鍵與 RouteTone 相同 */
export const envPill = styleVariants({
    production: [envBase, fill.danger.strong],
    simulation: [envBase, fill.accent.strong],
    unknown: [envBase, { background: vars.color.amber, color: '#000000' }],
});

const badgeBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    maxWidth: '100%',
    padding: '2px 4px 2px 10px',
    borderRadius: RADIUS.pill,
    border: `1px solid ${vars.color.borderBright}`,
    background: 'transparent',
    color: vars.color.foreground,
    fontSize: TEXT.callout.fontSize,
    fontWeight: 600,
    lineHeight: TEXT.callout.lineHeight,
    whiteSpace: 'nowrap',
});

/** RouteBadge 外框：有路由時 borderBright；沒有路由時 amber 框＋右側內距對稱 */
export const badge = styleVariants({
    production: [badgeBase],
    simulation: [badgeBase],
    unknown: [badgeBase],
    none: [badgeBase, { borderColor: vars.color.amber, paddingRight: '10px' }],
});

/** 下單面板等需要較大字的位置 */
export const badgeLarge = style({
    padding: '4px 6px 4px 12px',
    fontSize: TEXT.headline.fontSize,
});
