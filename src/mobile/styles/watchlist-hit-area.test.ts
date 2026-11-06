// 自選表頭指標切換鍵（watch-metric-toggle）的有效點擊區（靜態檢查；jsdom 沒有版面）
//
// 外觀 28px，以 ::before 上下擴到 TOUCH_MIN。下方擴張區與第一列重疊；列（li.rowItem、列按鈕）是 position relative、
// DOM 在後，切換鍵不設 z-index 時列會畫在擴張區之上搶走點擊（點表頭下緣稍下方會開成第一檔的交易頁）。
// 守住：切換鍵 position relative＋zIndex 1，列不設 z-index，且 zIndex 低於殼層 chrome。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Z } from './tokens';

const source = readFileSync(new URL('./watchlist.css.ts', import.meta.url), 'utf8');

/** 取出 `export const <name> = style(` 起到下一個頂層 export 之前的原始碼 */
function styleBlock(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`watchlist.css.ts 找不到 ${name}`);
    const next = source.indexOf('\nexport ', start + 1);
    return next < 0 ? source.slice(start) : source.slice(start, next);
}

const zIndexOf = (block: string): number | null => {
    const hit = /\bzIndex:\s*(\d+)/.exec(block);
    return hit ? Number(hit[1]) : null;
};

describe('自選表頭指標切換鍵點擊區', () => {
    it('切換鍵 position relative＋zIndex 1，擴張點擊區畫在第一列之上', () => {
        const toggle = styleBlock('metricToggle');
        expect(toggle).toMatch(/position:\s*'relative'/);
        expect(zIndexOf(toggle)).toBe(1);
        // ::before 上下擴到 TOUCH_MIN
        expect(toggle).toMatch(/'&::before'/);
        expect(toggle).toMatch(/top:\s*`calc\(\(28px - \$\{TOUCH_MIN\}\) \/ 2\)`/);
        expect(toggle).toMatch(/bottom:\s*`calc\(\(28px - \$\{TOUCH_MIN\}\) \/ 2\)`/);
    });

    it('列容器與列按鈕不設 z-index（否則會再蓋回擴張區）', () => {
        expect(zIndexOf(styleBlock('rowItem'))).toBeNull();
        expect(zIndexOf(styleBlock('row'))).toBeNull();
        expect(zIndexOf(styleBlock('listHeader'))).toBeNull();
    });

    it('zIndex 低於殼層 chrome（不會蓋到上方插槽與底部 chrome）', () => {
        expect(zIndexOf(styleBlock('metricToggle'))!).toBeLessThan(Z.bars);
    });
});
