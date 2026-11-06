// lib/contract-names：名稱來源順序（資料本身 → 合約快取 → 查一次）、每個不重複代碼最多一次合約查詢、
// 查詢失敗或名稱即代碼時只顯示代碼且不重試、已實現損益列的查詢代碼。以 vi.mock 隔離合約快取，不打任何 API。
import { createElement, Fragment, useSyncExternalStore } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({
    cache: new Map<string, { code: string; name: string }>(),
    listeners: new Set<() => void>(),
    names: {} as Record<string, string>,
    ensure: vi.fn(),
}));

vi.mock('../../lib/contracts-cache', () => ({
    useContract: (code: string | null) => useSyncExternalStore(
        (l: () => void) => { c.listeners.add(l); return () => { c.listeners.delete(l); }; },
        () => (code ? c.cache.get(code) : undefined),
    ),
    ensureContract: (code: string, type?: string) => c.ensure(code, type),
}));

import { instrumentText, realizedLookupCode, resetContractNamesForTest, useContractName } from './contract-names';

function Probe({ code, known, type }: { code: string | null; known?: string; type?: 'STK' | 'FUT' }) {
    const name = useContractName(code, known, type);
    return createElement('span', { 'data-code': code }, name ?? `(${code})`);
}

let view: ReactTestRenderer | undefined;
async function render(items: { code: string | null; known?: string; type?: 'STK' | 'FUT' }[]) {
    await act(async () => {
        view = create(createElement(Fragment, null, ...items.map((p, i) => createElement(Probe, { key: i, ...p }))));
    });
}
const texts = () => view!.root.findAllByType('span').map(s => String(s.children[0]));

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetContractNamesForTest();
    c.cache.clear();
    c.listeners.clear();
    c.names = {};
    c.ensure.mockReset().mockImplementation(async (code: string) => {
        const name = c.names[code];
        if (!name) throw new Error('not found');
        const info = { code, name };
        c.cache.set(code, info);
        c.listeners.forEach(l => l());
        return info;
    });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('useContractName', () => {
    it('uses the name carried by the data without reading the cache or querying', async () => {
        await render([{ code: '2330', known: '台積電' }]);
        expect(texts()).toEqual(['台積電']);
        expect(c.ensure).not.toHaveBeenCalled();
    });

    it('uses a cached contract without querying', async () => {
        c.cache.set('2317', { code: '2317', name: '鴻海' });
        await render([{ code: '2317' }]);
        expect(texts()).toEqual(['鴻海']);
        expect(c.ensure).not.toHaveBeenCalled();
    });

    it('queries each distinct code once, shows the code until the name arrives, then the name', async () => {
        c.names = { '2330': '台積電', TXFL6: '臺股期貨12' };
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const impl = c.ensure.getMockImplementation()!;
        c.ensure.mockImplementation(async (code: string, type?: string) => { await gate; return impl(code, type); });
        await render([{ code: '2330' }, { code: '2330' }, { code: 'TXFL6', type: 'FUT' }, { code: '2330' }, { code: 'TXFL6', type: 'FUT' }]);
        // 名稱載入前只顯示代碼
        expect(texts()).toEqual(['(2330)', '(2330)', '(TXFL6)', '(2330)', '(TXFL6)']);
        expect(c.ensure).toHaveBeenCalledTimes(2);
        expect(c.ensure).toHaveBeenCalledWith('2330', undefined);
        expect(c.ensure).toHaveBeenCalledWith('TXFL6', 'FUT');
        await act(async () => { release(); await gate; });
        expect(texts()).toEqual(['台積電', '台積電', '臺股期貨12', '台積電', '臺股期貨12']);
        expect(c.ensure).toHaveBeenCalledTimes(2);
    });

    it('a failed lookup shows only the code and is not retried on re-render or re-mount', async () => {
        await render([{ code: '9999' }, { code: '9999' }]);
        expect(texts()).toEqual(['(9999)', '(9999)']);
        expect(c.ensure).toHaveBeenCalledTimes(1);
        await act(async () => view!.unmount());
        await render([{ code: '9999' }]);
        expect(texts()).toEqual(['(9999)']);
        expect(c.ensure).toHaveBeenCalledTimes(1);
    });

    it('treats a name equal to the code (warrants) as no name', async () => {
        c.cache.set('03001P', { code: '03001P', name: '03001P' });
        await render([{ code: '03001P', known: '' }]);
        expect(texts()).toEqual(['(03001P)']);
    });

    it('does nothing without a code', async () => {
        await render([{ code: null }]);
        expect(c.ensure).not.toHaveBeenCalled();
    });
});

describe('helpers', () => {
    it('instrumentText puts the name first', () => {
        expect(instrumentText('2330', '台積電')).toBe('台積電 2330');
        expect(instrumentText('2330', null)).toBe('2330');
    });

    it('realizedLookupCode normalizes and maps the futures long format to the contract code', () => {
        expect(realizedLookupCode(' 2330 ', 'S')).toBe('2330');
        expect(realizedLookupCode('TMF202610', 'F')).toBe('TMFJ6');
        expect(realizedLookupCode('txfl6', 'F')).toBe('TXFL6');
    });
});
