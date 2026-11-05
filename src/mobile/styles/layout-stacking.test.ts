// 殼層疊層脈絡回歸測試（使用者回報：iPhone 上「持倉 → 平倉說明」的「取消／繼續」被底部分頁列擋住）
//
// 根因：WebKit（iOS Safari）把設了 -webkit-overflow-scrolling 為 touch 的捲動容器當成 z-index 0 的疊層脈絡；
// main 內所有 position:fixed 的子孫（舊版原地渲染的面板、全螢幕圖表）因此永遠畫在 .bottomStack（z 10）／
// .topSlot（z 11）之下。Chrome 不支援該屬性，桌面模擬器看不出來，所以用靜態檢查守住：
// 1. src/mobile（非測試檔）不得設定該屬性（iOS 13 起捲動容器預設即有慣性捲動）。
// 2. .shell、.mainWrap、main 不得建立疊層脈絡或成為 fixed 子孫的定位基準（layout.css.ts 檔頭的殼層規則）。
// 3. 面板一律 portal 到 main 之外的 #sj-sheet-root（app.tsx），面板 backdrop 的 z-index 高於底部 chrome。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Z } from './tokens';

const stylesDir = fileURLToPath(new URL('.', import.meta.url));
const mobileDir = join(stylesDir, '..');
const layoutSource = readFileSync(join(stylesDir, 'layout.css.ts'), 'utf8');

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
}

/** 取出 `export const <name> = style(` 起到下一個頂層 export 之前的原始碼 */
function styleBlock(src: string, name: string): string {
    const start = src.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`layout.css.ts 找不到 ${name}`);
    const next = src.indexOf('\nexport ', start + 1);
    return next < 0 ? src.slice(start) : src.slice(start, next);
}

/** 會建立疊層脈絡、或讓祖先成為 fixed 子孫定位基準的屬性（vanilla-extract 的駝峰鍵） */
const STACKING_KEYS = [
    'zIndex',
    'isolation',
    'opacity',
    'transform',
    'translate',
    'rotate',
    'scale',
    'perspective',
    'filter',
    'backdropFilter',
    'WebkitBackdropFilter',
    'willChange',
    'contain',
    'mixBlendMode',
    'clipPath',
    'mask',
    'maskImage',
    'WebkitMaskImage',
];

describe('殼層疊層脈絡（iOS：main 內的 fixed 子孫不可被底部 chrome 蓋住）', () => {
    it('src/mobile 不設定 -webkit-overflow-scrolling（WebKit 會因此建立 z-index 0 的疊層脈絡）', () => {
        const files = sourceFiles(mobileDir);
        expect(files.length).toBeGreaterThan(50);
        const offenders = files.filter(f => /WebkitOverflowScrolling\s*:|-webkit-overflow-scrolling\s*:/.test(readFileSync(f, 'utf8')));
        expect(offenders).toEqual([]);
    });

    it.each(['shell', 'mainWrap', 'main'])('.%s 不建立疊層脈絡、不成為 fixed 子孫的定位基準', name => {
        const block = styleBlock(layoutSource, name);
        const found = STACKING_KEYS.filter(key => new RegExp(`(^|[\\s{,])${key}\\s*:`).test(block));
        expect(found, `${name}: ${found.join(', ')}`).toEqual([]);
    });

    it('面板與確認面板的 z-index 高於底部 chrome、精簡標頭、配件槽與全螢幕圖表；通知最上層', () => {
        const chrome = Math.max(Z.bars, Z.compactBar, Z.accessory, Z.fullscreenChart);
        expect(Z.sheet).toBeGreaterThan(chrome);
        expect(Z.confirm).toBeGreaterThan(Z.sheet);
        expect(Z.toast).toBeGreaterThan(Z.confirm);
    });
});
