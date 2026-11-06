// 持倉精簡列的版面（靜態檢查；node 環境沒有版面）
//
// 第二行（代碼＋條件膠囊＋多空數量）：三項都不縮、不省略；放不下時整項換行（不裁切）。
// 先前只有多空數量可縮，360／390 寬或字級「標準／大」時會被截成「多 1…」「多 3張+…」或只剩「…」，誤讀數量。
// 名稱（第一行）負責省略且不撐寬左欄；左欄最窄＝第二行最寬一項。右欄第二行可換行，字級「大」固定上下排列。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./positions.css.ts', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../routes/positions-page.tsx', import.meta.url), 'utf8');
/** 去掉 // 與 /* *\/ 註解（只檢查程式碼） */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取出 `[export ]const <name> = style(` 起到下一個頂層宣告之前的程式碼 */
function styleBlock(name: string): string {
    const m = new RegExp(`^(export )?const ${name} = style\\(`, 'm').exec(source);
    if (!m) throw new Error(`找不到 ${name}`);
    const rest = source.slice(m.index + 1);
    const next = rest.search(/\n(export |const |globalStyle\(|\/\*\*|\/\/)/);
    return code(next < 0 ? rest : rest.slice(0, next));
}

const FONT_LARGE = `'html[data-sj-font-scale="1.3"] &'`;

describe('精簡列第二行：代碼、條件、多空數量不縮、不省略', () => {
    it('三項都 flex 0 0 auto、nowrap，沒有 overflow／ellipsis／minWidth 0', () => {
        for (const name of ['compactCode', 'compactTag', 'compactSideBase']) {
            const block = styleBlock(name);
            expect(block, name).toMatch(/flex:\s*'0 0 auto'/);
            expect(block, name).not.toMatch(/overflow/i);
            expect(block, name).not.toMatch(/textOverflow|ellipsis/);
            expect(block, name).not.toMatch(/minWidth:\s*0/);
            expect(block, name).not.toMatch(/flexShrink:\s*[1-9]/);
        }
        expect(styleBlock('compactCode')).toMatch(/whiteSpace:\s*'nowrap'/);
        expect(styleBlock('compactSideBase')).toMatch(/whiteSpace:\s*'nowrap'/);
        // 膠囊沿用 tag（nowrap）並併上 compactTag
        expect(styleBlock('tag')).toMatch(/whiteSpace:\s*'nowrap'/);
        expect(pageSource).toMatch(/className=\{`\$\{styles\.tag\} \$\{styles\.compactTag\}`\}>\{positionCondText\(p, contract\)\}/);
    });

    it('第二行可換行、不裁切；名稱（第一行）負責省略且不計入左欄 min-content', () => {
        const meta = styleBlock('compactMeta');
        expect(meta).toMatch(/flexWrap:\s*'wrap'/);
        expect(meta).not.toMatch(/overflow/);
        expect(meta).not.toMatch(/textOverflow/);
        const name = styleBlock('compactName');
        expect(name).toMatch(/textOverflow:\s*'ellipsis'/);
        expect(name).toMatch(/overflow:\s*'hidden'/);
        expect(name).toMatch(/width:\s*0/);
        expect(name).toMatch(/minWidth:\s*'100%'/);
    });

    it('左欄最窄為 min-content，不會被右欄擠到 0', () => {
        const row = styleBlock('compactRow');
        expect(row).toMatch(/gridTemplateColumns:\s*'minmax\(min-content, 1fr\)/);
        expect(row).not.toMatch(/minmax\(0,/);
    });
});

describe('精簡列右欄：放不下時換行，字級「大」上下排列', () => {
    it('右側第二行可換行、靠右，不裁切', () => {
        const sub = styleBlock('compactSub');
        expect(sub).toMatch(/flexWrap:\s*'wrap'/);
        expect(sub).toMatch(/justifyContent:\s*'flex-end'/);
        expect(sub).not.toMatch(/overflow/);
        expect(sub).not.toMatch(/textOverflow/);
    });

    it('字級「大」固定上下排列（以 html[data-sj-font-scale] 切換）', () => {
        const sub = styleBlock('compactSub');
        expect(sub).toContain(FONT_LARGE);
        const large = sub.slice(sub.indexOf(FONT_LARGE));
        expect(large).toMatch(/flexDirection:\s*'column'/);
        expect(large).toMatch(/alignItems:\s*'flex-end'/);
    });

    it('損益與右欄不裁切', () => {
        for (const name of ['compactRight', 'compactPnl']) {
            const block = styleBlock(name);
            expect(block, name).not.toMatch(/overflow/);
            expect(block, name).not.toMatch(/textOverflow/);
        }
    });
});
