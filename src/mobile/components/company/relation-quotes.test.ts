// 上下游列的即時漲跌幅（relation-quotes.ts）：讀取對象（上市櫃、去重、最多 20 檔）與快照批次的 30 秒最短間隔。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entity, RelationRow } from '../../../lib/company-data/types';
import type { ContractBase } from '../../../lib/types/contract';

const m = vi.hoisted(() => ({ fetchSnapshots: vi.fn() }));
vi.mock('../../../lib/shioaji', () => ({ fetchSnapshots: m.fetchSnapshots }));

import {
    fetchRelationSnapshots,
    RELATION_LIVE_LIMIT,
    RELATION_SNAPSHOT_MIN_MS,
    relationContracts,
    resetRelationSnapshotsForTest,
} from './relation-quotes';

const row = (id: string): RelationRow => ({ id, name: id, detail: null, as_of: null, confidence: 'high', evidence_level: 'primary', edge: 'supplies' } as RelationRow);
const entity = (id: string, market?: string): Entity => ({ id, kind: 'company', name: id, market });
const stk = (code: string, exchange: 'TSE' | 'OTC' = 'TSE'): ContractBase => ({ code, exchange, security_type: 'STK', target_code: null });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:00:00+08:00'));
    resetRelationSnapshotsForTest();
    m.fetchSnapshots.mockReset();
    m.fetchSnapshots.mockImplementation(async (contracts: { code: string }[]) => contracts.map(c => ({ code: c.code, change_rate: 1 })));
});

describe('relationContracts', () => {
    it('只取實體索引標為上市（TSE）／上櫃（OTC）的台股；非台股、興櫃、未知略過；同代碼去重', () => {
        const index = new Map([
            ['tw.2317', entity('tw.2317', 'twse')],
            ['tw.6488', entity('tw.6488', 'tpex')],
            ['tw.7777', entity('tw.7777', 'esb')],
            ['us.AAPL', entity('us.AAPL')],
        ]);
        const rows = [row('tw.2317'), row('tw.6488'), row('tw.7777'), row('us.AAPL'), row('tw.9999'), row('tw.2317')];
        expect(relationContracts(rows, index)).toEqual([stk('2317'), stk('6488', 'OTC')]);
        expect(relationContracts(rows, null)).toEqual([]);
    });

    it('一次最多 20 檔（依出現順序；每檔 Tick＋BidAsk 兩筆訂閱，合計最多 40 筆，低於永豐 50 次／5 秒）', () => {
        expect(RELATION_LIVE_LIMIT).toBe(20);
        const codes = Array.from({ length: 50 }, (_, i) => String(1101 + i));
        const index = new Map(codes.map(c => [`tw.${c}`, entity(`tw.${c}`, 'twse')]));
        const out = relationContracts(codes.map(c => row(`tw.${c}`)), index);
        expect(out).toHaveLength(RELATION_LIVE_LIMIT);
        expect(out.map(c => c.code)).toEqual(codes.slice(0, RELATION_LIVE_LIMIT));
    });
});

describe('fetchRelationSnapshots', () => {
    it('30 秒內讀過的代碼沿用上次結果，只讀其餘的；滿 30 秒才重讀', async () => {
        const a = [stk('2317'), stk('2454')];
        expect((await fetchRelationSnapshots(a)).map(s => s.code)).toEqual(['2317', '2454']);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        // 展開後多一檔：只讀新的那檔
        const b = [...a, stk('3034')];
        expect((await fetchRelationSnapshots(b)).map(s => s.code)).toEqual(['2317', '2454', '3034']);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(2);
        expect(m.fetchSnapshots.mock.calls[1]![0]).toEqual([stk('3034')]);
        // 收合回原本的組合：全部 30 秒內讀過，不發請求
        vi.setSystemTime(Date.now() + RELATION_SNAPSHOT_MIN_MS - 1);
        await fetchRelationSnapshots(a);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(2);
        // 滿 30 秒：2317、2454 重讀（3034 晚 0 秒讀過，同樣已滿）
        vi.setSystemTime(Date.now() + 1);
        await fetchRelationSnapshots(b);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(3);
        expect(m.fetchSnapshots.mock.calls[2]![0]).toEqual(b);
        for (const [batch] of m.fetchSnapshots.mock.calls) expect((batch as unknown[]).length).toBeLessThanOrEqual(RELATION_LIVE_LIMIT);
    });

    it('伺服器沒回的代碼也記錄時間（30 秒內不重讀）；失敗時丟錯且不記錄', async () => {
        m.fetchSnapshots.mockResolvedValueOnce([]);
        expect(await fetchRelationSnapshots([stk('2317')])).toEqual([]);
        await fetchRelationSnapshots([stk('2317')]);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(1);
        m.fetchSnapshots.mockRejectedValueOnce(new Error('503'));
        await expect(fetchRelationSnapshots([stk('2454')])).rejects.toThrow('503');
        await fetchRelationSnapshots([stk('2454')]);
        expect(m.fetchSnapshots).toHaveBeenCalledTimes(3);
    });
});
