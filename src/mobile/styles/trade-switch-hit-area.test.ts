// 交易頁切換商品鍵的有效點擊區（靜態檢查；jsdom 沒有版面）
//
// 標頭標題鍵：外觀是 h1 文字（約 22px 行高），以 expandHit 的 ::before 上下擴到 TOUCH_MIN；擴張區往下與主價列重疊，
// 主價（lastPrice）是 position relative、DOM 在後，標題鍵不設 zIndex 時主價會畫在擴張區之上搶走點擊。
// 精簡標頭切換鍵：外觀 SIZE.compactBarH（40px），::before 從頂端起固定高 44px（不用 TOUCH_MIN：它隨 rem 放大，
// 字級大時會多攔精簡標頭下方週期、圖表、五檔的點擊；也不往上擴，上方是狀態列）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./trade.css.ts', import.meta.url), 'utf8');

function styleBlock(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`trade.css.ts 找不到 ${name}`);
    const next = source.indexOf('\nexport ', start + 1);
    return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe('切換商品鍵點擊區', () => {
    it('標頭標題鍵：組合 expandHit（上下擴到 TOUCH_MIN）＋zIndex 1；文字沿用 h1（font／color inherit）', () => {
        const block = styleBlock('titleButton');
        expect(block).toMatch(/style\(\[expandHit,/);
        expect(block).toMatch(/zIndex:\s*1\b/);
        expect(block).toMatch(/font:\s*'inherit'/);
        expect(block).toMatch(/color:\s*'inherit'/);
    });

    it('精簡標頭切換鍵：高 compactBarH，::before 從頂端起固定 44px（不隨 rem 放大、不往上擴）；只動畫 opacity', () => {
        const block = styleBlock('compactSwitch');
        expect(block).toMatch(/height:\s*SIZE\.compactBarH/);
        expect(source).toMatch(/const COMPACT_SWITCH_HIT_H = '44px';/);
        const before = block.slice(block.indexOf("'&::before'"), block.indexOf("'&::after'"));
        expect(before).toMatch(/top:\s*0\b/);
        expect(before).toMatch(/height:\s*COMPACT_SWITCH_HIT_H\b/);
        expect(before).not.toMatch(/TOUCH_MIN|rem\b|bottom:|inset:|top:\s*['`-]/);
        expect(block).not.toMatch(/transition:[^\n]*(transform|height|width|top)/);
    });
});
