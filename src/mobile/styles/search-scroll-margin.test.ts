// 搜尋面板（自選搜尋、交易頁切換商品）結果列的捲動讓位
// 遮擋檢查：橫向 844×390 時面板矮，scrollIntoView／焦點移動把「目前商品」列停在 sticky 搜尋欄底下。
// jsdom 沒有版面，以原始碼靜態檢查：結果列的鍵以 scroll-margin-top 讓出搜尋欄高度，且高度與搜尋欄的內距、輸入框一致。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'watchlist.css.ts'), 'utf8');

function block(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`watchlist.css.ts 找不到 ${name}`);
    return source.slice(start, source.indexOf('\n});', start));
}

describe('搜尋面板結果列不被 sticky 搜尋欄蓋住', () => {
    it('搜尋欄高度＝上內距 s1＋輸入框 TOUCH_MIN＋下內距 s2', () => {
        expect(block('searchBar')).toMatch(/position: 'sticky'/);
        expect(block('searchBar')).toMatch(/padding: `\$\{SPACE\.s1\} \$\{vars\.space\.md\} \$\{SPACE\.s2\}`/);
        expect(block('searchInput')).toMatch(/minHeight: TOUCH_MIN/);
        expect(source).toMatch(/export const SEARCH_BAR_H = `calc\(\$\{TOUCH_MIN\} \+ \$\{SPACE\.s1\} \+ \$\{SPACE\.s2\}\)`;/);
    });

    it('結果列的鍵以 scroll-margin-top 讓出搜尋欄高度', () => {
        expect(source).toMatch(/globalStyle\(`\$\{resultItem\} button`, \{ scrollMarginTop: SEARCH_BAR_H \}\);/);
    });
});
