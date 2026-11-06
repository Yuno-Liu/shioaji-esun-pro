// src/mobile/ui/price-flash.css.ts — 跳價閃爍覆蓋層（設計規格 §6.12、§4.8 規則 1）
// 絕對定位覆蓋層，平時 opacity 0；usePriceFlash 寫入 upFlash／downFlash 底色後以 WAAPI 動畫 opacity 1→0。
// 不用 theme 的 flash 關鍵影格（那組動畫 background）。
import { style } from '@vanilla-extract/css';

/** 放覆蓋層的格子（若本身未定位） */
export const host = style({
    position: 'relative',
    isolation: 'isolate',
});

/** 覆蓋層：在文字之下（z-index −1，配合 host 的 isolation） */
export const overlay = style({
    position: 'absolute',
    inset: 0,
    zIndex: -1,
    borderRadius: 'inherit',
    opacity: 0,
    pointerEvents: 'none',
});
