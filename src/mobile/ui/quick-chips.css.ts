// src/mobile/ui/quick-chips.css.ts — 快捷價／快捷數量格（設計規格 §6.10；取代 order-ticket.css.ts 的 auto-fill 折行）
// 快捷價：6 欄、間距 6px、高 48px 兩行（390 寬每格約 54.7px）；字級「大」改 3 欄兩列（不用容器查詢）。
// 數量：4 欄、單行 36px（外觀；點擊區由 Chip 擴到 TOUCH_MIN，列與列之間留 8px）。
import { style, styleVariants } from '@vanilla-extract/css';

const gridBase = style({
    display: 'grid',
    width: '100%',
    minWidth: 0,
});

export const grid = styleVariants({
    price: [gridBase, {
        gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
        gap: '6px',
        selectors: {
            'html[data-sj-font-scale="1.3"] &': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', rowGap: '8px' },
        },
    }],
    qty: [gridBase, {
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        columnGap: '6px',
        // compact 晶片點擊區上下各擴 4px：列間 ≥8px 才不重疊
        rowGap: '8px',
    }],
});

/** 格內晶片撐滿欄寬 */
export const cell = style({
    width: '100%',
});
