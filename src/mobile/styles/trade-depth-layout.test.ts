// 交易頁五檔版面的靜態檢查（jsdom 沒有版面與 html 屬性選擇器的計算樣式）：
// - 字級「大」表頭縮寫（設計規格 §4.7）：以 html[data-sj-font-scale="1.3"] 切換，不用容器查詢、:has()；
//   完整標籤改為視覺隱藏（不是 display:none，輔助技術仍讀得到），縮寫預設 display:none。
// - 「五檔｜明細」與［整股｜盤中零股］同列（§7.3）：rem 寬度預算，360 寬字級大時換行、其他字級同列。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./trade.css.ts', import.meta.url), 'utf8');
const segmentedSource = readFileSync(new URL('../ui/segmented.css.ts', import.meta.url), 'utf8');
const typographySource = readFileSync(new URL('./typography.css.ts', import.meta.url), 'utf8');

/** 取出 `export const <name> = style(` 起到下一個頂層 export 之前的原始碼 */
function styleBlock(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`trade.css.ts 找不到 ${name}`);
    const next = source.indexOf('\nexport ', start + 1);
    return next < 0 ? source.slice(start) : source.slice(start, next);
}

const rem = (re: RegExp, src: string): number => {
    const hit = re.exec(src);
    if (!hit) throw new Error(`找不到 ${re}`);
    return Number(hit[1]);
};

describe('五檔表頭縮寫（字級「大」）', () => {
    it('FONT_LARGE 是 html 屬性選擇器；整份樣式不用容器查詢、:has()、color-mix', () => {
        expect(source).toContain(`const FONT_LARGE = 'html[data-sj-font-scale="1.3"] &';`);
        expect(source).not.toMatch(/@container|containerType|:has\(|color-mix/);
    });

    it('完整標籤：預設可見；字級大時視覺隱藏（clip＋1px，非 display:none，仍留給輔助技術）', () => {
        const full = styleBlock('depthHeadFull');
        expect(full).toMatch(/\[FONT_LARGE\]:\s*\{/);
        expect(full).toMatch(/position:\s*'absolute'/);
        expect(full).toMatch(/clip:\s*'rect\(0, 0, 0, 0\)'/);
        expect(full).toMatch(/width:\s*'1px'/);
        expect(full).not.toMatch(/display:\s*'none'/);
        expect(full).not.toMatch(/visibility/);
    });

    it('縮寫：預設 display:none；只在字級大時顯示', () => {
        const short = styleBlock('depthHeadShort');
        expect(short).toMatch(/^export const depthHeadShort = style\(\{\s*display:\s*'none',/);
        expect(short).toMatch(/\[FONT_LARGE\]:\s*\{\s*display:\s*'inline'\s*\}/);
    });
});

describe('「五檔｜明細」＋整股／盤中零股同列', () => {
    const tabsBasis = rem(/flex:\s*'1 1 ([\d.]+)rem'/, styleBlock('panelTabs'));
    const toggleBasis = rem(/flex:\s*'0 0 ([\d.]+)rem'/, styleBlock('oddToggleSlot'));
    const gap = 0.75; // controlRow gap SPACE.s3
    const padX = 1; // controlRow 左右 SPACE.s4
    const callout = rem(/callout:\s*spec\('([\d.]+)rem'/, typographySource);
    const segPadX = rem(/padding:\s*'0 ([\d.]+)rem'/, segmentedSource);

    it('列可換行（行距 s2，compact 擴張點擊區不重疊）；切換鍵靠右、不縮', () => {
        const row = styleBlock('panelRow');
        expect(row).toMatch(/style\(\[controlRow,/);
        expect(row).toMatch(/flexWrap:\s*'wrap'/);
        expect(row).toMatch(/rowGap:\s*SPACE\.s2/);
        expect(styleBlock('controlRow')).toMatch(/gap:\s*SPACE\.s3/);
        expect(styleBlock('oddToggleSlot')).toMatch(/marginLeft:\s*'auto'/);
    });

    it('寬度預算：切換鍵容得下「盤中零股」、分頁容得下「五檔／明細」（rem 隨字級等比）', () => {
        // Segmented 每段等寬：文字 callout × 字數＋左右內距；軌道內距 2px×2（以字級小 16px 換算 0.25rem，偏保守）
        const track = 0.25;
        expect(toggleBasis).toBeGreaterThanOrEqual(2 * (4 * callout + 2 * segPadX) + track);
        expect(tabsBasis).toBeGreaterThanOrEqual(2 * (2 * callout + 2 * segPadX) + track);
    });

    it('360 寬：字級大（1.3）換行、字級標準（1.15）與小（1）同列', () => {
        const need = tabsBasis + gap + toggleBasis;
        const available = (scale: number) => (360 - 2 * padX * 16 * scale) / (16 * scale);
        expect(available(1.3)).toBeLessThan(need);
        expect(available(1.15)).toBeGreaterThanOrEqual(need);
        expect(available(1)).toBeGreaterThanOrEqual(need);
        // 換行後各自一行也放得下（不溢出）
        expect(available(1.3)).toBeGreaterThanOrEqual(toggleBasis);
    });

    it('舊的五檔區塊內工具列樣式已移除', () => {
        expect(source).not.toMatch(/ladderToolbar/);
    });
});
