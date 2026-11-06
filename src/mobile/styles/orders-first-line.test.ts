// 委託列與成交列第一行的靜態檢查（jsdom 沒有版面計算）：名稱載入後不可換行造成列高變化。
// - 第一行（rowMain > line:first-child；dealRow 沿用 rowMain）不換行；
// - 只有商品（instrument）可縮，名稱單行省略號；代碼、買賣膠囊、徽章、成交時間不縮、不換行（維持可見）；
// - 規則宣告在 instrument 之後（vanilla-extract 的 const 不可提前引用）；不用 :has()、容器查詢、color-mix（iOS 15.4）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./orders.css.ts', import.meta.url), 'utf8');
const ordersPage = readFileSync(new URL('../routes/orders-page.tsx', import.meta.url), 'utf8');
const actionSheet = readFileSync(new URL('../components/order-action-sheet.tsx', import.meta.url), 'utf8');

/** 取出 `export const <name> = style(` 起到下一個頂層 export 之前的原始碼 */
function styleBlock(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`orders.css.ts 找不到 ${name}`);
    const next = source.indexOf('\nexport ', start + 1);
    return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe('委託列／成交列第一行不換行', () => {
    it('第一行選擇器涵蓋委託列與成交列（dealRow 組合 rowMain）', () => {
        expect(source).toContain('const FIRST_LINE = `${rowMain} > ${line}:first-child`;');
        expect(source).toMatch(/export const dealRow = style\(\[rowMain,/);
    });

    it('第一行 nowrap；所有子項目預設不縮、不換行', () => {
        expect(source).toMatch(/globalStyle\(FIRST_LINE, \{ \.\.\.TEXT\.headline, flexWrap: 'nowrap' \}\);/);
        expect(source).toMatch(/globalStyle\(`\$\{FIRST_LINE\} > \*`, \{ flexShrink: 0, whiteSpace: 'nowrap' \}\);/);
    });

    it('只有商品可縮（權重高於 > *），且宣告在 instrument 之後', () => {
        const rule = 'globalStyle(`${FIRST_LINE} > ${instrument}`, { flexShrink: 1, minWidth: 0 });';
        expect(source).toContain(rule);
        expect(source.indexOf(rule)).toBeGreaterThan(source.indexOf('export const instrument = style('));
        expect(source.indexOf(rule)).toBeGreaterThan(source.indexOf('export const instrumentCode = style('));
    });

    it('名稱單行省略號；代碼不縮；商品本身不換行', () => {
        const name = styleBlock('instrumentName');
        expect(name).toMatch(/minWidth: 0/);
        expect(name).toMatch(/overflow: 'hidden'/);
        expect(name).toMatch(/textOverflow: 'ellipsis'/);
        expect(styleBlock('instrumentCode')).toMatch(/flexShrink: 0/);
        const inst = styleBlock('instrument');
        expect(inst).toMatch(/whiteSpace: 'nowrap'/);
        expect(inst).toMatch(/minWidth: 0/);
    });

    it('第一行的組成：委託列＝商品＋買賣膠囊＋徽章；成交列＝商品＋買賣膠囊＋成交時間', () => {
        expect(actionSheet).toMatch(/<span className=\{styles\.line\}>\s*<TradeInstrument trade=\{trade\} \/>\s*<span className=\{styles\.side\[[^\]]+\]\} data-testid='order-side'>[^<]*<\/span>\s*<OrderBadges trade=\{trade\} \/>\s*<\/span>/);
        expect(ordersPage).toMatch(/<span className=\{styles\.line\}>\s*<TradeInstrument trade=\{t\} testId='deal-instrument' \/>\s*<span className=\{styles\.side\[[^\]]+\]\} data-testid='deal-side'>[^<]*<\/span>\s*<span className=\{styles\.lineEnd\} data-testid='deal-time'>/);
    });

    it('不用 :has()、容器查詢、color-mix（iOS 15.4）', () => {
        // 去掉註解行（檔頭註解本身寫著「不用 color-mix()、:has()」）
        const code = source.split('\n').filter(l => !/^\s*(\/\/|\/\*\*|\*)/.test(l)).join('\n');
        expect(code).not.toMatch(/@container|containerType|:has\(|color-mix/);
    });
});
