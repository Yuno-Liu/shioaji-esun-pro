// 設計 tokens（設計規格 docs/fork/mobile-design.md §4、§10 S7）：
// - metrics.ts 原匯出名與值相容（TOUCH_MIN 改 max(44px, 2.75rem)、TRADE_BUTTON_MIN_HEIGHT 維持 56px、Z 原鍵值不變）
// - §4.8 對比表以 theme.css.ts 的實際色值重算：實心填色疊黑（ink）後白字 ≥ 門檻（小字 4.5、大字 3）
// - §4.9 彈簧 k／c 與規格表一致
// - 靜態檢查：本區塊檔案不使用 iOS 15.4 不支援的語法、800 字重、theme 的 wick／flash
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as metrics from './metrics';
import { DUR, EASE, GESTURE, RADIUS, SIZE, SPACE, SPRING, THEME_ALPHA, TOUCH_MIN, Z } from './tokens';

const stylesDir = fileURLToPath(new URL('.', import.meta.url));
const mobileDir = join(stylesDir, '..');
const themeSource = readFileSync(join(mobileDir, '..', 'theme.css.ts'), 'utf8');

// ---- 色彩工具（WCAG 2.x 相對亮度；sRGB 疊色與瀏覽器合成一致） ----

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const hex = (h: string): Rgb => {
    const s = h.replace('#', '');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as Rgb;
};
const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** top 以 alpha 疊在 bottom 上 */
const over = ([r, g, b]: Rgb, alpha: number, [r0, g0, b0]: Rgb): Rgb => [r * alpha + r0 * (1 - alpha), g * alpha + g0 * (1 - alpha), b * alpha + b0 * (1 - alpha)];
const rgba = (s: string): [Rgb, number] => {
    const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(s);
    if (!m) throw new Error(`not rgba: ${s}`);
    return [[Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4])];
};

/** 從 src/theme.css.ts 讀出 Palette 原始色值（theme 改色時本測試自動以新值重算） */
function palette(name: 'dark' | 'light'): (key: string) => string {
    const start = themeSource.indexOf(`const ${name}: Palette = {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = themeSource.slice(start, themeSource.indexOf('\n};', start));
    const map = new Map([...body.matchAll(/(\w+):\s*'([^']+)'/g)].map(m => [m[1] ?? '', m[2] ?? '']));
    return key => {
        const v = map.get(key);
        if (!v) throw new Error(`theme.css.ts ${name}.${key} not found`);
        return v;
    };
}

const MODES = ['dark', 'light'] as const;

describe('metrics.ts 相容（保留原匯出名）', () => {
    it('原值與新值', () => {
        expect(metrics.TOUCH_MIN).toBe('max(44px, 2.75rem)');
        expect(metrics.TRADE_BUTTON_MIN_HEIGHT).toBe('56px');
        expect(metrics.TRADE_BUTTON_GAP).toBe('12px');
        expect(metrics.INPUT_FONT_SIZE).toBe('max(16px, 1rem)');
        expect(metrics.SAFE_TOP).toBe('env(safe-area-inset-top, 0px)');
        expect(metrics.SAFE_BOTTOM).toBe('env(safe-area-inset-bottom, 0px)');
        expect(metrics.SAFE_LEFT).toBe('env(safe-area-inset-left, 0px)');
        expect(metrics.SAFE_RIGHT).toBe('env(safe-area-inset-right, 0px)');
        expect(metrics.REDUCED_MOTION).toBe('(prefers-reduced-motion: reduce)');
        expect(metrics.TOUCH_MIN).toBe(TOUCH_MIN);
    });

    it('Z 原鍵值不變、擴充鍵依 §4.5 排序', () => {
        expect(metrics.Z).toBe(Z);
        expect(Z).toMatchObject({ bars: 10, sheet: 100, confirm: 200, toast: 300 });
        const order = [Z.bars, Z.compactBar, Z.accessory, Z.fullscreenChart, Z.sheet, Z.confirm, Z.toast];
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(new Set(order).size).toBe(order.length);
        // 面板堆疊最多 9 層仍低於確認面板
        expect(Z.sheet + Z.sheetStep * 9).toBeLessThan(Z.confirm);
    });
});

describe('§4.3／§4.4／§4.9 數值', () => {
    it('間距、尺寸、圓角', () => {
        expect(SPACE).toEqual({ s1: '0.25rem', s1_5: '0.375rem', s2: '0.5rem', s3: '0.75rem', s4: '1rem', s5: '1.25rem', s6: '1.5rem', s8: '2rem' });
        expect(SIZE.controlLarge).toBe('max(56px, 3.5rem)');
        expect(SIZE.controlCompact).toBe('2.25rem');
        expect(SIZE.slideTrack).toBe('56px');
        expect(SIZE.slideHandle).toBe('48px');
        expect(RADIUS).toMatchObject({ xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px', pill: '999px', segTrack: '9px', segThumb: '7px' });
    });

    it('彈簧 k＝(2π/response)²、c＝2ζ·2π/response 與規格表一致', () => {
        const table: Record<keyof typeof SPRING, [number, number]> = {
            default: [322.3, 35.9],
            snappy: [815.7, 57.12],
            sheet: [385.5, 39.27],
            sheetFling: [438.6, 34.35],
            toast: [273.4, 29.76],
            bump: [631.7, 27.65],
        };
        for (const [name, [k, c]] of Object.entries(table) as [keyof typeof SPRING, [number, number]][]) {
            const { zeta, response } = SPRING[name];
            const w0 = (2 * Math.PI) / response;
            expect(w0 * w0, name).toBeCloseTo(k, 0);
            expect(2 * zeta * w0, name).toBeCloseTo(c, 1);
            expect(zeta).toBeGreaterThan(0);
            expect(zeta).toBeLessThanOrEqual(1);
        }
    });

    it('手勢與轉場常數', () => {
        expect(GESTURE).toMatchObject({ lockSlop: 10, flingVelocity: 500, dismissVelocity: 1000, sheetDeceleration: 0.99, toastDeceleration: 0.998, rubberband: 0.55, clickSuppressMs: 350 });
        expect(DUR).toMatchObject({ press: 80, fade: 150, tone: 200, thumb: 240, bar: 120, flash: 600, flashGap: 350 });
        expect(EASE.out).toBe('cubic-bezier(.2,.8,.2,1)');
        expect(EASE.sheet).toBe('cubic-bezier(.32,.72,0,1)');
    });

    it('§4.2 主題映射不透明度', () => {
        expect(THEME_ALPHA.dark).toEqual({ inkStrong: 0.28, inkLarge: 0.12, scrim: 0.56, scrimStack: 0.24, barAlpha: 0.72, thickAlpha: 0.86 });
        expect(THEME_ALPHA.light).toEqual({ inkStrong: 0.08, inkLarge: 0, scrim: 0.36, scrimStack: 0.24, barAlpha: 0.8, thickAlpha: 0.9 });
    });
});

describe('§4.8 對比實算（以 theme.css.ts 色值重算）', () => {
    // up／down 依配色在紅綠之間翻轉；success＝綠；danger 自上游 #393 起是獨立的朱紅（不再等於漲跌紅），也要單獨驗。
    // 紅、綠、accent、danger 四色涵蓋四種主題的所有實心填色
    const FILLS = ['red', 'green', 'accent', 'danger'] as const;

    it.each(MODES)('%s：白字／實心填色＋inkStrong ≥ 4.5、＋inkLarge ≥ 3（大字）', mode => {
        const p = palette(mode);
        const ink = THEME_ALPHA[mode];
        for (const c of FILLS) {
            const base = hex(p(c));
            expect(contrast(WHITE, over(BLACK, ink.inkStrong, base)), `${mode} ${c} strong`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(WHITE, over(BLACK, ink.inkLarge, base)), `${mode} ${c} large`).toBeGreaterThanOrEqual(3);
            // 疊黑只會讓白字對比變好
            expect(ink.inkStrong).toBeGreaterThanOrEqual(ink.inkLarge);
        }
        // amber 實心＋黑字
        expect(contrast(BLACK, hex(p('amber')))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(MODES)('%s：重現規格 §4.8 對比表', mode => {
        const p = palette(mode);
        const ink = THEME_ALPHA[mode];
        const red = hex(p('red'));
        const green = hex(p('green'));
        const accent = hex(p('accent'));
        const panel = hex(p('panel'));
        const twice = (dim: string) => {
            const [c, a] = rgba(dim);
            return over(c, a, over(c, a, panel));
        };
        const buy2 = twice(p('redDim')); // 台灣配色買進＝up＝紅
        const sell2 = twice(p('greenDim'));
        const buy1 = over(...rgba(p('redDim')), panel);
        const island = hex(mode === 'dark' ? p('inset') : p('panel'));
        const bg = hex(p('background'));

        const expected: Record<string, [number, number]> = {
            whiteRed: [3.9, 5.08],
            whiteRedStrong: [6.69, 5.81],
            whiteRedLarge: [4.87, 5.08],
            whiteGreen: [2.68, 4.34],
            whiteGreenStrong: [4.85, 4.99],
            whiteGreenLarge: [3.41, 4.34],
            whiteAccent: [3.31, 4.9],
            whiteAccentStrong: [5.8, 5.61],
            whiteAccentLarge: [4.17, 4.9],
            blackAmber: [9.54, 6.11],
            redOnBuy2: [3.94, 3.74],
            greenOnSell2: [5.04, 3.39],
            redOnSell2: [3.46, 3.97],
            mutedOnBuy2: [4.24, 3.97],
            mutedOnBuy1: [4.9, 4.6],
            fgOnBuy2: [11.05, 11.46],
            redOnIsland: [5.23, 5.08],
            greenOnIsland: [7.61, 4.34],
            mutedOnIsland: [5.64, 5.38],
            redOnBg: [5.39, 4.45],
            greenOnBg: [7.84, 3.8],
        };
        const actual: Record<string, number> = {
            whiteRed: contrast(WHITE, red),
            whiteRedStrong: contrast(WHITE, over(BLACK, ink.inkStrong, red)),
            whiteRedLarge: contrast(WHITE, over(BLACK, ink.inkLarge, red)),
            whiteGreen: contrast(WHITE, green),
            whiteGreenStrong: contrast(WHITE, over(BLACK, ink.inkStrong, green)),
            whiteGreenLarge: contrast(WHITE, over(BLACK, ink.inkLarge, green)),
            whiteAccent: contrast(WHITE, accent),
            whiteAccentStrong: contrast(WHITE, over(BLACK, ink.inkStrong, accent)),
            whiteAccentLarge: contrast(WHITE, over(BLACK, ink.inkLarge, accent)),
            blackAmber: contrast(BLACK, hex(p('amber'))),
            redOnBuy2: contrast(red, buy2),
            greenOnSell2: contrast(green, sell2),
            redOnSell2: contrast(red, sell2),
            mutedOnBuy2: contrast(hex(p('mutedForeground')), buy2),
            mutedOnBuy1: contrast(hex(p('mutedForeground')), buy1),
            fgOnBuy2: contrast(hex(p('foreground')), buy2),
            redOnIsland: contrast(red, island),
            greenOnIsland: contrast(green, island),
            mutedOnIsland: contrast(hex(p('mutedForeground')), island),
            redOnBg: contrast(red, bg),
            greenOnBg: contrast(green, bg),
        };
        const col = mode === 'dark' ? 0 : 1;
        for (const [key, values] of Object.entries(expected)) {
            const got = actual[key] ?? Number.NaN;
            // 規格表取兩位小數，容許 ±0.02 的四捨五入差
            expect(Math.abs(got - values[col]), `${mode} ${key}=${got.toFixed(3)}`).toBeLessThanOrEqual(0.02);
        }
    });

    it('§4.8 規則 6–7 的依據：著色面板上 mutedForeground 與漲跌色小字不足 4.5，中性島上足夠（淺色綠 4.34 為 theme 層級已知問題）', () => {
        for (const mode of MODES) {
            const p = palette(mode);
            const island = hex(mode === 'dark' ? p('inset') : p('panel'));
            expect(contrast(hex(p('red')), island)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(hex(p('mutedForeground')), island)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(hex(p('foreground')), island)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(hex(palette('dark')('green')), hex(palette('dark')('inset')))).toBeGreaterThanOrEqual(4.5);
    });
});

describe('五檔量條（ui/bars VolumeBar；§6.12）', () => {
    it.each(MODES)('%s：價格疊在單層量條上；量的長短由實心 up／down 底邊條標示（對 panel 達圖形 3:1）', mode => {
        const p = palette(mode);
        const panel = hex(p('panel'));
        const red = hex(p('red'));
        const green = hex(p('green'));
        const buy1 = over(...rgba(p('redDim')), panel); // 台灣配色買進＝up＝紅
        const sell1 = over(...rgba(p('greenDim')), panel);
        // 填色維持單層：深色紅字對買進量條 4.54（不得再加深，否則 numMd 一般字級的漲跌色價格低於 4.5）
        const expected: Record<string, [number, number]> = { redOnBuy1: [4.54, 4.33], greenOnSell1: [6.22, 3.82], redOnSell1: [4.27, 4.47] };
        const actual: Record<string, number> = { redOnBuy1: contrast(red, buy1), greenOnSell1: contrast(green, sell1), redOnSell1: contrast(red, sell1) };
        const col = mode === 'dark' ? 0 : 1;
        for (const [key, values] of Object.entries(expected)) {
            expect(Math.abs((actual[key] ?? Number.NaN) - values[col]), `${mode} ${key}=${actual[key]?.toFixed(3)}`).toBeLessThanOrEqual(0.02);
        }
        if (mode === 'dark') expect(actual.redOnBuy1).toBeGreaterThanOrEqual(4.5);
        // 淡色填色本身幾乎看不出來（約 1.1:1），所以要靠邊條
        expect(contrast(buy1, panel)).toBeLessThan(1.3);
        // 邊條（實心 up／down，兩種配色都是紅或綠）對 panel ≥ 3:1
        expect(contrast(red, panel)).toBeGreaterThanOrEqual(3);
        expect(contrast(green, panel)).toBeGreaterThanOrEqual(3);
    });

    it('bars.css.ts：量條填色用單層 upDim／downDim、邊條用實心 up／down（不自訂漲跌 hex）', () => {
        const src = readFileSync(join(mobileDir, 'ui', 'bars.css.ts'), 'utf8');
        expect(src).toMatch(/buy: \[volumeBase, \{[^}]*backgroundColor: vars\.color\.upDim, backgroundImage: `linear-gradient\(\$\{vars\.color\.up\}, \$\{vars\.color\.up\}\)`/);
        expect(src).toMatch(/sell: \[volumeBase, \{[^}]*backgroundColor: vars\.color\.downDim, backgroundImage: `linear-gradient\(\$\{vars\.color\.down\}, \$\{vars\.color\.down\}\)`/);
        expect(src).toMatch(/backgroundSize: `100% \$\{VOLUME_EDGE\}`/);
        expect(src).toMatch(/backgroundPosition: 'left bottom'/);
        expect(/#[0-9a-f]{6}/i.test(src)).toBe(false);
    });
});

describe('漲停／跌停實心底（報價列、交易頁主價、產業成分股；§7.2）', () => {
    // up／down 依配色翻轉：台灣 up＝紅、down＝綠；國際 up＝綠、down＝紅（theme.css.ts makeTokens）
    const SCHEMES = { tw: { up: 'red', down: 'green' }, intl: { up: 'green', down: 'red' } } as const;

    it.each(MODES.flatMap(mode => (['tw', 'intl'] as const).map(scheme => [mode, scheme] as const)))(
        '%s-%s：白字「漲停／跌停」小標與價格／up、down＋inkStrong ≥ 4.5',
        (mode, scheme) => {
            const p = palette(mode);
            const ink = THEME_ALPHA[mode].inkStrong;
            for (const dir of ['up', 'down'] as const) {
                const ratio = contrast(WHITE, over(BLACK, ink, hex(p(SCHEMES[scheme][dir]))));
                expect(ratio, `${mode}-${scheme} ${dir}=${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
            }
        },
    );

    it('漲停／跌停底一律是 up／down＋inkStrong（小字），不用 inkLarge、不自訂漲跌 hex', () => {
        // 報價列與成分股列用 watchlist.css 的 limitPrice（up／down 底＋inkLayer.strong＋白字＋::before 小標），交易頁主價直接用 fill[limit].strong
        const css = readFileSync(join(stylesDir, 'watchlist.css.ts'), 'utf8');
        const block = css.slice(css.indexOf('const limitFill'), css.indexOf('export const limitPrice'));
        expect(block).toMatch(/backgroundImage: inkLayer\.strong/);
        expect(block).not.toMatch(/inkLayer\.large/);
        expect(block).toMatch(/color: '#ffffff'/);
        expect(css).toMatch(/up: limitFill\(vars\.color\.up, '漲停'\)/);
        expect(css).toMatch(/down: limitFill\(vars\.color\.down, '跌停'\)/);
        // 窄螢幕＋字級「大」只在排行列隱藏 ::before 小標（實心底保留）；自選、持倉不受影響
        expect(css).toContain(`const NARROW_RANKING = 'html[data-sj-font-scale="1.3"] [data-testid="ranking-row"]';`);
        expect(css).toContain("globalStyle(`${NARROW_RANKING} ${c}::before`, narrowOnly({ display: 'none' }));");
        expect(css).toContain("'@media': { '(max-width: 400px)': rule }");
        const uses: [string, RegExp][] = [
            ['components/quote-row.tsx', /styles\.limitPrice\[limit\]/],
            ['components/sector/sector-members.tsx', /limitPrice\[limit\]/],
            ['routes/trade-page.tsx', /fill\[limit\]\.strong/],
        ];
        for (const [f, re] of uses) {
            const src = readFileSync(join(mobileDir, f), 'utf8');
            expect(src, f).toMatch(re);
            expect(src, f).not.toMatch(/fill\[limit\]\.large|fill\.(up|down)\.large/);
            expect(/#(?:f23645|16b389|d6213a|0a8a66)/i.test(src), f).toBe(false);
        }
    });
});

describe('§10 S7／§12 靜態檢查', () => {
    const OWN_FILES = ['tokens.ts', 'metrics.ts', 'theme-vars.css.ts', 'material.css.ts', 'typography.css.ts', 'primitives.css.ts', 'controls.css.ts'];
    const FORBIDDEN: [string, RegExp][] = [
        ['color-mix', /color-mix\s*\(/],
        [':has()', /:has\(/],
        ['CSS linear() 緩動', /(?<![-\w])linear\(/],
        ['容器查詢', /@container/],
        ['800 字重', /fontWeight:\s*['"]?800/],
        ['theme wick 色', /wick(Up|Down)/],
        ['theme flash 關鍵影格', /flash-(up|down)/],
        ['mono 字型', /vars\.font\.mono/],
    ];

    it.each(OWN_FILES)('%s 不含禁用語法', file => {
        const src = readFileSync(join(stylesDir, file), 'utf8');
        for (const [label, re] of FORBIDDEN) expect(re.test(src), `${file}: ${label}`).toBe(false);
    });

    it('src/mobile（非測試檔）不引用 vars.color.wickUp／wickDown 與 theme 的 flash 關鍵影格', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(full);
            }
        };
        walk(mobileDir);
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const src = readFileSync(f, 'utf8');
            expect(/color\.wick(Up|Down)/.test(src), f).toBe(false);
            expect(/['"`]flash-(up|down)['"`]/.test(src), f).toBe(false);
        }
    });
});
