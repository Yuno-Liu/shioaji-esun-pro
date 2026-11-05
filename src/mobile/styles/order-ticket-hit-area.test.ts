// 下單面板第一列的鎖說明鍵點擊區（遮擋檢查：上緣被面板 body 裁掉、落在拖曳區，實際可點高度不足 44px）
// jsdom 沒有版面，以原始碼靜態檢查：鎖說明鍵的負外距與第一列的上內距出自同一個常數。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'order-ticket.css.ts'), 'utf8');

function block(name: string): string {
    const start = source.indexOf(`export const ${name} = style(`);
    if (start < 0) throw new Error(`order-ticket.css.ts 找不到 ${name}`);
    const end = source.indexOf('\n});', start);
    return source.slice(start, end);
}

describe('下單面板鎖說明鍵的點擊區', () => {
    it('超出量為 (TOUCH_MIN − 1.75rem) / 2', () => {
        expect(source).toMatch(/const LOCK_OVERHANG = `calc\(\(\$\{TOUCH_MIN\} - 1\.75rem\) \/ 2\)`;/);
    });

    it('鎖說明鍵以負外距不撐高整列', () => {
        expect(block('lockButton')).toMatch(/margin: `calc\(-1 \* \$\{LOCK_OVERHANG\}\) 0`/);
    });

    it('第一列以同樣的上內距讓出超出部分（第一列緊貼 body 頂端，否則上緣被裁掉）', () => {
        expect(block('metaRow')).toMatch(/paddingTop: LOCK_OVERHANG/);
    });
});
