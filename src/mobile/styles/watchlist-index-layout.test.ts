// 自選頁底部指數列與列尾佔位的樣式（靜態檢查；node 環境沒有版面）
//
// 指數列（設計規格 §4.6、§4.8 規則 6／8）：bar 材質上的文字一律 vars.color.foreground；方向由有色 ▲▼ 圖形表示。
// 字級「大」（html[data-sj-font-scale="1.3"]）在 360／390 寬時一行放不下（標籤＋值＋漲跌幅約 200px，格內約 150px）：
// 值與漲跌幅上下排列；其他字級放不下時自動換行。守住：不裁切（沒有 overflow hidden／ellipsis）、文字不 nowrap 擠出格外的單一行。
// 列尾佔位：與快速下單 IconButton 同寬（TOUCH_MIN），指數／組合商品列才與其他列對齊。
// 自選列第二行：代碼＋市場標記不縮、不省略；空間不足時名稱（第一行）省略、徽章換行。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./watchlist.css.ts', import.meta.url), 'utf8');
const iconButtonSource = readFileSync(new URL('../ui/icon-button.css.ts', import.meta.url), 'utf8');
const stripSource = readFileSync(new URL('../components/watch-index-strip.tsx', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('./watch-index-panel.css.ts', import.meta.url), 'utf8');
/** 去掉 // 與 /* *\/ 註解（只檢查程式碼） */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取出 `export const <name> = style(` 起到下一個頂層 export 之前的原始碼（不含前面的註解） */
function styleBlock(name: string, src = source): string {
    const start = src.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`找不到 ${name}`);
    const next = src.indexOf('\nexport ', start + 1);
    const block = next < 0 ? src.slice(start) : src.slice(start, next);
    // 去掉區塊尾端、屬於下一個 export 的 JSDoc
    const doc = block.lastIndexOf('\n/**');
    return doc > 0 ? block.slice(0, doc) : block;
}

const FONT_LARGE = `'html[data-sj-font-scale="1.3"] &'`;

describe('底部指數列：文字 foreground、方向圖形著色', () => {
    it('數值與漲跌幅的樣式只用 foreground，不含漲跌色', () => {
        for (const name of ['indexValue', 'indexNum', 'indexPct', 'indexLabel']) {
            const block = styleBlock(name);
            expect(block, name).toMatch(/color:\s*vars\.color\.foreground/);
            expect(block, name).not.toMatch(/vars\.color\.(up|down|flat|mutedForeground)/);
        }
    });

    it('元件：值與漲跌幅不套 tone；只有方向 SVG 套 tone，且 aria-hidden', () => {
        expect(stripSource).toMatch(/className=\{styles\.indexValue\} aria-hidden='true'/);
        expect(stripSource).toMatch(/className=\{styles\.indexNum\}/);
        expect(stripSource).toMatch(/className=\{styles\.indexPct\}/);
        // tone 只出現在方向圖形
        const toneUses = stripSource.match(/styles\.tone\[/g) ?? [];
        expect(toneUses).toHaveLength(1);
        expect(stripSource).toMatch(/className=\{`\$\{styles\.indexArrow\} \$\{styles\.tone\[dir\]\}`\}/);
        expect(stripSource).toMatch(/<svg[\s\S]*?aria-hidden='true'[\s\S]*?focusable='false'/);
        expect(code(stripSource)).not.toMatch(/[▲▼]/);
    });
});

describe('底部指數列：字級「大」不裁切、不溢出', () => {
    it('值容器可換行、可縮（minWidth 0、flex 1 1 auto），沒有 overflow hidden／ellipsis', () => {
        const block = styleBlock('indexValue');
        expect(block).toMatch(/flexWrap:\s*'wrap'/);
        expect(block).toMatch(/flex:\s*'1 1 auto'/);
        expect(block).toMatch(/minWidth:\s*0/);
        expect(block).toMatch(/justifyContent:\s*'flex-end'/);
        expect(block).not.toMatch(/overflow:/);
        expect(block).not.toMatch(/textOverflow/);
        expect(block).not.toMatch(/whiteSpace:\s*'nowrap'/);
    });

    it('字級「大」固定上下排列（以 html[data-sj-font-scale] 切換，不用容器查詢、:has()）', () => {
        const block = styleBlock('indexValue');
        expect(block).toContain(FONT_LARGE);
        const large = block.slice(block.indexOf(FONT_LARGE));
        expect(large).toMatch(/flexDirection:\s*'column'/);
        expect(large).toMatch(/alignItems:\s*'flex-end'/);
        expect(code(source)).not.toMatch(/@container|:has\(|color-mix\(/);
    });

    it('格與標籤不裁切；格的最小高度 TOUCH_MIN（兩行時自動長高）', () => {
        const cell = styleBlock('indexCell');
        expect(cell).not.toMatch(/overflow:/);
        expect(cell).not.toMatch(/\bheight:/);
        expect(cell).toMatch(/minHeight:\s*TOUCH_MIN/);
        expect(styleBlock('indexLabel')).toMatch(/flex:\s*'0 0 auto'/);
        // 圖形尺寸以 rem 計，隨字級
        expect(styleBlock('indexArrow')).toMatch(/width:\s*'0\.5rem'/);
    });
});

describe('底部指數列：收合／展開鍵與展開面板', () => {
    it('切換鍵點擊區 TOUCH_MIN×TOUCH_MIN、不縮；圖示 foreground', () => {
        const block = styleBlock('indexToggle');
        expect(block).toMatch(/width:\s*TOUCH_MIN/);
        expect(block).toMatch(/height:\s*TOUCH_MIN/);
        expect(block).toMatch(/flex:\s*'0 0 auto'/);
        expect(block).toMatch(/color:\s*vars\.color\.foreground/);
        expect(styleBlock('indexBody')).toMatch(/minWidth:\s*0/);
    });

    it('字級「大」：格可換行（值換到標籤下一行，不溢出）', () => {
        const cell = styleBlock('indexCell');
        expect(cell.slice(cell.indexOf(FONT_LARGE))).toMatch(/flexWrap:\s*'wrap'/);
    });

    it('面板文字只用 foreground、不裁切；兩欄 minmax(0, 1fr)；走勢填滿欄寬', () => {
        const src = code(panelCss);
        expect(src).not.toMatch(/vars\.color\.(up|down|flat|mutedForeground)/);
        expect(src).not.toMatch(/overflow|textOverflow|ellipsis/);
        expect(src).not.toMatch(/@container|:has\(|color-mix\(/);
        for (const name of ['label', 'value', 'change', 'amount', 'estimate']) {
            expect(styleBlock(name, panelCss), name).toMatch(/color:\s*vars\.color\.foreground/);
        }
        expect(styleBlock('panel', panelCss)).toMatch(/gridTemplateColumns:\s*'repeat\(2, minmax\(0, 1fr\)\)'/);
        expect(styleBlock('column', panelCss)).toMatch(/minWidth:\s*0/);
        expect(styleBlock('chart', panelCss)).toMatch(/width:\s*'100%'/);
        // 漲跌與成交金額放不下時整段換行；指數大字在字級「大」縮小
        expect(styleBlock('change', panelCss)).toMatch(/flexWrap:\s*'wrap'/);
        expect(styleBlock('amount', panelCss)).toMatch(/flexWrap:\s*'wrap'/);
        expect(styleBlock('value', panelCss)).toMatch(/\[LARGE\]:\s*\{\s*fontSize/);
    });
});

describe('自選列第二行：代碼與市場標記不縮、不省略（360px＋字級「大」實測代碼被省略成「6.」）', () => {
    it('代碼、市場標記與其外層組 flex 0 0 auto、nowrap，沒有 overflow／ellipsis／minWidth 0', () => {
        for (const name of ['rowMetaKey', 'rowMetaCode', 'marketTag']) {
            const block = code(styleBlock(name));
            expect(block, name).toMatch(/flex:\s*'0 0 auto'/);
            expect(block, name).not.toMatch(/overflow/i);
            expect(block, name).not.toMatch(/textOverflow|ellipsis/);
            expect(block, name).not.toMatch(/minWidth:\s*0/);
            expect(block, name).not.toMatch(/flexShrink:\s*[1-9]/);
        }
        expect(code(styleBlock('rowMetaKey'))).toMatch(/whiteSpace:\s*'nowrap'/);
        expect(code(styleBlock('rowMetaCode'))).toMatch(/whiteSpace:\s*'nowrap'/);
    });

    it('第二行可換行、不裁切（徽章放不下時換行）；名稱（第一行）負責省略', () => {
        const meta = code(styleBlock('rowMeta'));
        expect(meta).toMatch(/flexWrap:\s*'wrap'/);
        expect(meta).not.toMatch(/overflow/);
        expect(meta).not.toMatch(/textOverflow/);
        const title = code(styleBlock('rowTitle'));
        expect(title).toMatch(/textOverflow:\s*'ellipsis'/);
        expect(title).toMatch(/overflow:\s*'hidden'/);
        // 名稱不計入名稱欄 min-content（長名稱不撐寬），版面上仍佔滿整欄
        expect(title).toMatch(/width:\s*0/);
        expect(title).toMatch(/minWidth:\s*'100%'/);
    });

    it('名稱欄最窄為 min-content（＝代碼＋市場標記），不會被數字欄擠到 0', () => {
        for (const name of ['row', 'rowWithSpark', 'rowNoSpark']) {
            const block = code(styleBlock(name));
            expect(block, name).toMatch(/gridTemplateColumns:\s*'minmax\(min-content, 1fr\)/);
            expect(block, name).not.toMatch(/minmax\(0,/);
        }
    });
});

describe('列尾佔位與快速下單鍵同寬', () => {
    it('ticketSpacer 寬高 TOUCH_MIN，與 IconButton 相同', () => {
        const spacer = styleBlock('ticketSpacer');
        expect(spacer).toMatch(/width:\s*TOUCH_MIN/);
        expect(spacer).toMatch(/height:\s*TOUCH_MIN/);
        expect(spacer).toMatch(/flex:\s*'0 0 auto'/);
        expect(iconButtonSource).toMatch(/width:\s*TOUCH_MIN/);
    });
});
