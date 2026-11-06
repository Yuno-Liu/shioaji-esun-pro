// 設計規格 §4.2、§4.6、§4.7、§6.14：CSS 模組可在 vanilla-extract 下編譯，匯出鍵完整；controls 既有匯出鍵不變
import { describe, expect, it } from 'vitest';
import * as controls from './controls.css';
import { bar, thick } from './material.css';
import { fill, focusRing, hairlineBottom, hairlineTop, inkLayer, island, pressable, pressableRow, srOnly } from './primitives.css';
import { elevation, scrimColor, sj } from './theme-vars.css';
import { NUM, num, tabular, TEXT, text } from './typography.css';

const isClass = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
/** composed 是否包含 part 的全部 class（組合樣式會展開成多個 class） */
const composes = (composed: string, part: string) => part.split(' ').every(c => composed.split(' ').includes(c));

describe('theme-vars（§4.2）', () => {
    it('13 個語意變數皆為 CSS 變數', () => {
        const keys = ['contentBg', 'groupedBg', 'islandBg', 'elevatedBg', 'segTrack', 'segThumb', 'inkStrong', 'inkLarge', 'scrim', 'scrimStack', 'barAlpha', 'thickAlpha', 'edgeLight'];
        expect(Object.keys(sj).sort()).toEqual([...keys].sort());
        for (const v of Object.values(sj)) expect(v).toMatch(/^var\(--[\w-]+\)$/);
        expect(new Set(Object.values(sj)).size).toBe(keys.length);
    });

    it('陰影 e1／e3 疊上緣受光線、暗化幕只用黑色 rgba', () => {
        expect(elevation.e1).toContain(sj.edgeLight);
        expect(elevation.e3).toContain(sj.edgeLight);
        expect(elevation.e2).not.toContain('inset');
        expect(scrimColor.base).toBe(`rgba(0,0,0,${sj.scrim})`);
        expect(scrimColor.stack).toBe(`rgba(0,0,0,${sj.scrimStack})`);
    });
});

describe('primitives（§6.14）', () => {
    it('fill 四色 × 兩級皆為不同 class，ink 疊層用對應變數', () => {
        const classes = (['up', 'down', 'accent', 'danger'] as const).flatMap(t => [fill[t].strong, fill[t].large]);
        expect(classes.every(isClass)).toBe(true);
        expect(new Set(classes).size).toBe(8);
        expect(inkLayer.strong).toBe(`linear-gradient(rgba(0,0,0,${sj.inkStrong}), rgba(0,0,0,${sj.inkStrong}))`);
        expect(inkLayer.large).toBe(`linear-gradient(rgba(0,0,0,${sj.inkLarge}), rgba(0,0,0,${sj.inkLarge}))`);
    });

    it('其餘 primitives 與材質皆有 class', () => {
        for (const c of [pressable, pressableRow, srOnly, hairlineTop, hairlineBottom, focusRing, island, bar, thick]) {
            expect(isClass(c)).toBe(true);
        }
        expect(bar).not.toBe(thick);
    });
});

describe('typography（§4.7）', () => {
    it('字級鍵完整、字重只用 400／500／600／700、負字距只在數字', () => {
        expect(Object.keys(TEXT)).toEqual(['pageTitle', 'sheetTitle', 'headline', 'body', 'callout', 'subhead', 'footnote', 'caption', 'actionLabel', 'confirmAction', 'envBanner']);
        expect(Object.keys(NUM)).toEqual(['numHero', 'numLg', 'numMd', 'numSm']);
        for (const s of [...Object.values(TEXT), ...Object.values(NUM)]) expect([400, 500, 600, 700]).toContain(s.fontWeight);
        for (const s of Object.values(TEXT)) expect(s.letterSpacing.startsWith('-')).toBe(false);
        expect(TEXT.actionLabel).toMatchObject({ fontSize: '1.1875rem', fontWeight: 700 });
        expect(TEXT.caption.fontSize).toBe('0.6875rem');
        expect(Object.keys(text)).toEqual(Object.keys(TEXT));
        expect(Object.keys(num)).toEqual(Object.keys(NUM));
        // num 組合 tabular
        for (const c of Object.values(num)) expect(c.split(' ')).toContain(tabular);
    });
});

describe('controls（既有匯出相容）', () => {
    it('button／tradeButton 鍵不變，實心鍵組合 fill 與 pressable', () => {
        expect(Object.keys(controls.button).sort()).toEqual(['danger', 'ghost', 'neutral', 'primary']);
        expect(Object.keys(controls.tradeButton).sort()).toEqual(['buy', 'sell']);
        expect(composes(controls.button.primary, fill.accent.strong)).toBe(true);
        expect(composes(controls.button.danger, fill.danger.strong)).toBe(true);
        expect(composes(controls.tradeButton.buy, fill.up.large)).toBe(true);
        expect(composes(controls.tradeButton.sell, fill.down.large)).toBe(true);
        for (const c of [...Object.values(controls.button), ...Object.values(controls.tradeButton)]) {
            expect(composes(c, pressable)).toBe(true);
        }
        // 滑塊段落仍在（路由徽章樣式已移到 route-badge.css.ts）
        expect(isClass(controls.slideTrack)).toBe(true);
        expect(Object.keys(controls.slideHandle).sort()).toEqual(['buy', 'danger', 'neutral', 'sell']);
    });
});
