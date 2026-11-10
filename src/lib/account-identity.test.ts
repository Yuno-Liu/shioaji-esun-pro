import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountMatches, newPopoutWindowId } from './account-identity';
import { accountMatches as upstreamAccountMatches } from './flash-account';

type Acc = { account_type: string; broker_id: string; account_id: string };
type Args = Parameters<typeof upstreamAccountMatches>;

describe('fork accountMatches 與上游 flash-account 同一語意', () => {
    const base: Acc = { account_type: 'S', broker_id: '9A95', account_id: '1234567' };
    const values: (Acc | null | undefined)[] = [
        null,
        undefined,
        base,
        { ...base },
        { ...base, account_type: 'F' },
        { ...base, broker_id: '8840' },
        { ...base, account_id: '7654321' },
        { ...base, broker_id: '' },
        { ...base, account_id: '' },
        { account_type: 'F', broker_id: 'F002000', account_id: '1234567' },
    ];

    it('每一組 (a, b) 的結果都和上游相同', () => {
        for (const a of values) {
            for (const b of values) {
                const args = [a, b] as Args;
                expect(accountMatches(...args), JSON.stringify([a, b])).toBe(upstreamAccountMatches(...args));
            }
        }
    });

    it('同一帳戶才算相同；缺漏一律不算', () => {
        const same = (a: Acc | null | undefined, b: Acc | null | undefined) => accountMatches(...([a, b] as Args));
        expect(same(base, { ...base })).toBe(true);
        expect(same(base, { ...base, account_type: 'F' })).toBe(false);
        expect(same({ ...base, broker_id: '' }, { ...base, broker_id: '' })).toBe(false);
        expect(same(null, base)).toBe(false);
        expect(same(base, undefined)).toBe(false);
    });
});

describe('newPopoutWindowId', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('每次都不同且非空', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newPopoutWindowId()));
        expect(ids.size).toBe(50);
        for (const id of ids) expect(id.length).toBeGreaterThan(0);
    });

    it('沒有 crypto.randomUUID 時改用時間＋亂數', () => {
        vi.stubGlobal('crypto', {});
        const a = newPopoutWindowId();
        const b = newPopoutWindowId();
        expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
        expect(a).not.toBe(b);
    });
});
