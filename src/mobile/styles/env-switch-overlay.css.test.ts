// 玉山環境切換「結果確認中」橫幅的層級：必須在所有面板之下，打開的下單面板第一列（RouteBadge，設計規格 §10 S6）
// 不可被橫幅蓋住。以原始碼文字檢查（同 tokens.test.ts 的作法，.css.ts 不在測試環境編譯）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Z } from './tokens';

const src = readFileSync(new URL('./env-switch-overlay.css.ts', import.meta.url), 'utf8');

describe('env-switch banner layer', () => {
    it('sits below every sheet layer so an open ticket keeps its RouteBadge visible', () => {
        expect(src).toContain('zIndex: Z.sheet - 1,');
        expect(src).not.toMatch(/zIndex:\s*Z\.(toast|confirm)\b/);
        expect(Z.sheet - 1).toBeLessThan(Z.sheet);
        expect(Z.sheet - 1).toBeGreaterThan(Z.fullscreenChart);
    });
});
