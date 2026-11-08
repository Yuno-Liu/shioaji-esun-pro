// 盤中異動的純資料邏輯：
// - 規則家族、標籤與桌面 market-pulse-panel 一致（13 個 preset 全部分到 4 個家族，每個都有中文標籤）。
// - 篩選：預設急漲跌＋上市上櫃；localStorage 壞資料回預設；讀寫例外不外拋。
// - 訂閱鍵＝規則 × 市場；清單依篩選、最新在前、最多 100 筆，且一律回傳新陣列（lib 的陣列原地變動）。
// - quote 的價格與漲跌（文字帶正負號）、試撮、補充說明、遺漏提示；名稱只讀記憶體（不查詢）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScannerRule, ScannerSignalEvent } from '../../../lib/types/market';

const m = vi.hoisted(() => ({
    contracts: new Map<string, { code: string; name: string }>(),
    etf: new Map<string, { name: string }>(),
    equity: new Map<string, { name: string; aliases: string[] }>(),
}));
vi.mock('../../../lib/contracts-cache', () => ({ getCachedContract: (code: string) => m.contracts.get(code) }));
vi.mock('../../../lib/etf-runtime-catalog', () => ({ etfNameForLive: (code: string, ex: string) => m.etf.get(`${ex}:${code}`) }));
vi.mock('../../../lib/stock-runtime-catalog', () => ({ equityNameForLive: (ex: string, code: string) => m.equity.get(`${ex}:${code}`) }));

import {
    DEFAULT_SIGNAL_FILTERS,
    FAMILY_RULES,
    gapText,
    loadSignalFilters,
    normalizeSignalFilters,
    parseSignalKey,
    RULE_LABELS,
    ruleTone,
    saveSignalFilters,
    SIGNAL_FAMILIES,
    SIGNAL_FILTERS_KEY,
    signalDetail,
    signalKeys,
    signalName,
    signalQuote,
    toggleExchange,
    toggleFamily,
    visibleSignals,
} from './signal-model';

const ALL_RULES: ScannerRule[] = [
    'bid_near_limit_up', 'bid_touch_limit_up', 'limit_up_unlocked', 'ask_near_limit_down', 'ask_touch_limit_down', 'limit_down_unlocked',
    'trade_price_surge', 'trade_price_drop', 'bid_price_surge', 'ask_price_drop', 'volume_burst', 'simtrade', 'suspend',
];

function sig(over: Partial<ScannerSignalEvent> & { code?: string; time?: string; close?: string; diff?: string; sim?: boolean } = {}): ScannerSignalEvent {
    return {
        scanner: over.scanner ?? 'trade_price_surge',
        region: 'TW',
        security_type: 'STK',
        exchange: over.exchange ?? 'TSE',
        quote: { code: over.code ?? '2330', date: '2026-11-06', time: over.time ?? '09:01:02.123456', close: over.close, diff_price: over.diff, simtrade: over.sim },
        extra: over.extra ?? {},
        received_at: 0,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    m.contracts.clear();
    m.etf.clear();
    m.equity.clear();
});

describe('規則與標籤', () => {
    it('13 個 preset 都屬於恰好一個家族，且都有中文標籤', () => {
        const grouped = SIGNAL_FAMILIES.flatMap(f => FAMILY_RULES[f]);
        expect([...grouped].sort()).toEqual([...ALL_RULES].sort());
        expect(new Set(grouped).size).toBe(13);
        for (const r of ALL_RULES) expect(RULE_LABELS[r]).toMatch(/\S/);
    });

    it('方向只作輔助：跌／drop → down，漲／surge → up，其餘 flat', () => {
        expect(ruleTone('ask_touch_limit_down')).toBe('down');
        expect(ruleTone('trade_price_drop')).toBe('down');
        expect(ruleTone('bid_touch_limit_up')).toBe('up');
        expect(ruleTone('bid_price_surge')).toBe('up');
        expect(ruleTone('volume_burst')).toBe('flat');
        expect(ruleTone('suspend')).toBe('flat');
    });
});

describe('篩選', () => {
    it('預設：急漲跌、上市＋上櫃 → 4 規則 × 2 市場＝8 個訂閱鍵', () => {
        expect(DEFAULT_SIGNAL_FILTERS).toEqual({ families: ['move'], exchanges: ['TSE', 'OTC'] });
        const keys = signalKeys(DEFAULT_SIGNAL_FILTERS);
        expect(keys).toHaveLength(8);
        expect(keys).toContain('OTC:ask_price_drop');
        expect(parseSignalKey('OTC:ask_price_drop')).toEqual({ exchange: 'OTC', rule: 'ask_price_drop' });
    });

    it('全選＝13 × 2＝26 個鍵；沒選家族或市場＝0', () => {
        expect(signalKeys({ families: [...SIGNAL_FAMILIES], exchanges: ['TSE', 'OTC'] })).toHaveLength(26);
        expect(signalKeys({ families: [], exchanges: ['TSE'] })).toEqual([]);
        expect(signalKeys({ families: ['limit'], exchanges: [] })).toEqual([]);
    });

    it('切換保持固定順序', () => {
        const f = toggleFamily(toggleFamily(DEFAULT_SIGNAL_FILTERS, 'state'), 'limit');
        expect(f.families).toEqual(['limit', 'move', 'state']);
        expect(toggleFamily(f, 'move').families).toEqual(['limit', 'state']);
        expect(toggleExchange(DEFAULT_SIGNAL_FILTERS, 'TSE').exchanges).toEqual(['OTC']);
        expect(toggleExchange({ families: [], exchanges: ['OTC'] }, 'TSE').exchanges).toEqual(['TSE', 'OTC']);
    });

    it('壞資料回預設或丟掉不認得的值', () => {
        expect(normalizeSignalFilters(null)).toBe(DEFAULT_SIGNAL_FILTERS);
        expect(normalizeSignalFilters({ families: 'move' })).toBe(DEFAULT_SIGNAL_FILTERS);
        expect(normalizeSignalFilters({ families: ['x', 'volume', 'volume'], exchanges: ['OES', 'OTC'] })).toEqual({ families: ['volume'], exchanges: ['OTC'] });
    });

    it('localStorage 讀寫：成功時往返；例外時回預設、不外拋', () => {
        const store = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
        expect(loadSignalFilters()).toBe(DEFAULT_SIGNAL_FILTERS);
        saveSignalFilters({ families: ['limit', 'volume'], exchanges: ['OTC'] });
        expect(JSON.parse(store.get(SIGNAL_FILTERS_KEY)!)).toEqual({ families: ['limit', 'volume'], exchanges: ['OTC'] });
        expect(loadSignalFilters()).toEqual({ families: ['limit', 'volume'], exchanges: ['OTC'] });
        store.set(SIGNAL_FILTERS_KEY, '{not json');
        expect(loadSignalFilters()).toBe(DEFAULT_SIGNAL_FILTERS);

        vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } });
        expect(loadSignalFilters()).toBe(DEFAULT_SIGNAL_FILTERS);
        expect(() => saveSignalFilters(DEFAULT_SIGNAL_FILTERS)).not.toThrow();
    });
});

describe('清單', () => {
    it('依篩選過濾、保持最新在前、最多 limit 筆，回傳新陣列', () => {
        const source = [
            sig({ code: 'A1', scanner: 'trade_price_surge', exchange: 'OTC' }),
            sig({ code: 'B1', scanner: 'volume_burst' }),
            sig({ code: 'C1', scanner: 'trade_price_drop' }),
            sig({ code: 'D1', scanner: 'bid_price_surge' }),
        ];
        const out = visibleSignals(source, DEFAULT_SIGNAL_FILTERS);
        expect(out.map(s => s.quote.code)).toEqual(['A1', 'C1', 'D1']);
        expect(out).not.toBe(source);
        expect(visibleSignals(source, { families: ['move'], exchanges: ['TSE'] }, 1).map(s => s.quote.code)).toEqual(['C1']);
        const many = Array.from({ length: 250 }, (_, i) => sig({ code: `${1000 + i}` }));
        expect(visibleSignals(many, DEFAULT_SIGNAL_FILTERS)).toHaveLength(100);
    });

    it('成交價與漲跌（文字帶正負號與漲跌幅）', () => {
        expect(signalQuote(sig({ close: '110.5', diff: '10.5' }))).toEqual({ price: '110.5', change: '+10.5 (+10.50%)', tone: 'up', simtrade: false });
        expect(signalQuote(sig({ close: '90', diff: '-10' }))).toEqual({ price: '90', change: '−10 (−10.00%)', tone: 'down', simtrade: false });
        expect(signalQuote(sig({ close: '100', diff: '0' }))).toMatchObject({ change: '0 (0.00%)', tone: 'flat' });
        expect(signalQuote(sig({}))).toEqual({ price: null, change: null, tone: 'flat', simtrade: false });
    });

    it('試撮：quote.simtrade 或規則本身是 simtrade', () => {
        expect(signalQuote(sig({ close: '50', diff: '1', sim: true })).simtrade).toBe(true);
        expect(signalQuote(sig({ scanner: 'simtrade' })).simtrade).toBe(true);
    });

    it('補充說明：爆量金額、急漲跌幅度、漲跌停觸發價', () => {
        expect(signalDetail('volume_burst', { amount: '250000000' })).toBe('2.50 億');
        expect(signalDetail('volume_burst', { amount: 3_500_000 })).toBe('350 萬');
        expect(signalDetail('volume_burst', {})).toBe('');
        expect(signalDetail('trade_price_surge', { change_percent: '1.234' })).toBe('+1.23%');
        expect(signalDetail('ask_price_drop', { change_percent: -2 })).toBe('-2.00%');
        expect(signalDetail('trade_price_drop', {})).toBe('');
        expect(signalDetail('bid_touch_limit_up', { trigger_price: '123.50' })).toBe('123.5');
        expect(signalDetail('suspend', {})).toBe('');
    });

    it('遺漏提示含筆數與時間範圍', () => {
        expect(gapText({ dropped_count: 12, first_time: '09:00:01.5', last_time: '09:03:00', subscriptions: [], received_at: 0 }))
            .toBe('串流重連期間遺漏 12 筆訊號（09:00:01–09:03:00），該時段的異動未列出。');
    });
});

describe('名稱只讀記憶體', () => {
    it('合約快取 → ETF 目錄 → 上市櫃公司目錄；名稱等於代碼或都沒有時回 null', () => {
        expect(signalName('2330', 'TSE')).toBeNull();
        m.equity.set('TSE:2330', { name: '台積電', aliases: [] });
        expect(signalName('2330', 'TSE')).toBe('台積電');
        expect(signalName('2330', 'OTC')).toBeNull();
        m.contracts.set('2330', { code: '2330', name: '台積電(券商)' });
        expect(signalName('2330', 'TSE')).toBe('台積電(券商)');
        m.etf.set('TSE:0050', { name: '元大台灣50' });
        expect(signalName('0050', 'TSE')).toBe('元大台灣50');
        m.contracts.set('03001P', { code: '03001P', name: '03001P' });
        expect(signalName('03001P', 'TSE')).toBeNull();
    });
});
