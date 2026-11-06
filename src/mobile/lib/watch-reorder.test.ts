// 拖曳排序的純函式：落點索引（以其他列中線判斷）、讓位位移、自動捲動速度
import { describe, expect, it } from 'vitest';
import { autoScrollSpeed, REORDER_EDGE_PX, REORDER_MAX_SPEED, reorderIndex, reorderShift } from './watch-reorder';

const rows = [0, 1, 2, 3].map(i => ({ top: i * 64, height: 64 })); // 中線 32、96、160、224

describe('reorderIndex', () => {
    it('沒有越過相鄰列的中線就留在原位', () => {
        expect(reorderIndex(rows, 1, 0)).toBe(1);
        expect(reorderIndex(rows, 1, 63)).toBe(1); // 中心 159 < 160
        expect(reorderIndex(rows, 1, -63)).toBe(1); // 中心 33 > 32
    });
    it('往下越過幾條中線就往下幾格；往上同理；不超出頭尾', () => {
        expect(reorderIndex(rows, 1, 65)).toBe(2);
        expect(reorderIndex(rows, 1, 129)).toBe(3);
        expect(reorderIndex(rows, 1, 999)).toBe(3);
        expect(reorderIndex(rows, 2, -65)).toBe(1);
        expect(reorderIndex(rows, 2, -999)).toBe(0);
    });
    it('索引無效時原樣回傳', () => {
        expect(reorderIndex(rows, 9, 100)).toBe(9);
    });
});

describe('reorderShift', () => {
    it('往下拖：中間的列上移一列高；往上拖：中間的列下移；其他不動', () => {
        expect([0, 1, 2, 3].map(i => reorderShift(i, 0, 2, 64))).toEqual([0, -64, -64, 0]);
        expect([0, 1, 2, 3].map(i => reorderShift(i, 3, 1, 64))).toEqual([0, 64, 64, 0]);
        expect([0, 1, 2, 3].map(i => reorderShift(i, 2, 2, 64))).toEqual([0, 0, 0, 0]);
    });
});

describe('autoScrollSpeed', () => {
    it('上下緣 REORDER_EDGE_PX 內線性加速，最多 REORDER_MAX_SPEED；中間不捲', () => {
        expect(autoScrollSpeed(300, 0, 600)).toBe(0);
        expect(autoScrollSpeed(600 - REORDER_EDGE_PX + 1, 0, 600)).toBe(1);
        expect(autoScrollSpeed(600, 0, 600)).toBe(REORDER_MAX_SPEED);
        expect(autoScrollSpeed(900, 0, 600)).toBe(REORDER_MAX_SPEED);
        expect(autoScrollSpeed(0, 0, 600)).toBe(-REORDER_MAX_SPEED);
        expect(autoScrollSpeed(REORDER_EDGE_PX / 2, 0, 600)).toBe(-REORDER_MAX_SPEED / 2);
    });
});
