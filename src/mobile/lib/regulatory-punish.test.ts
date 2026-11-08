// 處置股清單（lib/regulatory-punish.ts）：最多每 30 分鐘讀一次、失敗靜默保留舊值、同時只有一個請求。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiGet: m.apiGet }));

import { PUNISH_PATH, PUNISH_REFRESH_MS, refreshPunishedCodes, resetPunishedCodesForTest, usePunishedCodes, usePunishedListLoaded } from './regulatory-punish';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetPunishedCodesForTest();
    m.apiGet.mockReset();
});

describe('refreshPunishedCodes', () => {
    it('間隔內不重複讀取；進行中不重複送出；失敗保留上次結果', async () => {
        m.apiGet.mockResolvedValueOnce({ code: ['2317', 3, '6274'] });
        const t0 = 1_000_000;
        refreshPunishedCodes(t0);
        refreshPunishedCodes(t0);
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        expect(m.apiGet).toHaveBeenCalledWith(PUNISH_PATH);
        await flush();
        refreshPunishedCodes(t0 + PUNISH_REFRESH_MS - 1);
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        m.apiGet.mockRejectedValueOnce(new Error('503'));
        refreshPunishedCodes(t0 + PUNISH_REFRESH_MS);
        expect(m.apiGet).toHaveBeenCalledTimes(2);
        await flush();
        // 失敗後同樣等一個間隔
        refreshPunishedCodes(t0 + PUNISH_REFRESH_MS + 1);
        expect(m.apiGet).toHaveBeenCalledTimes(2);
    });

    it('usePunishedCodes：active 才讀；回傳代碼集合（非字串值略過）', async () => {
        m.apiGet.mockResolvedValue({ code: ['2317', 3] });
        let seen: ReadonlySet<string> = new Set();
        function Probe({ active }: { active: boolean }) {
            seen = usePunishedCodes(active);
            return null;
        }
        const view = create(createElement(Probe, { active: false }));
        await act(async () => { await flush(); });
        expect(m.apiGet).not.toHaveBeenCalled();
        await act(async () => { view.update(createElement(Probe, { active: true })); });
        await act(async () => { await flush(); });
        expect(m.apiGet).toHaveBeenCalledTimes(1);
        expect([...seen]).toEqual(['2317']);
        await act(async () => view.unmount());
    });

    it('usePunishedListLoaded：成功讀到名單（code 為陣列）才為 true；失敗、格式不符都維持 false', async () => {
        let loaded: boolean | undefined;
        function Probe() {
            loaded = usePunishedListLoaded();
            return null;
        }
        let view: ReturnType<typeof create> | undefined;
        await act(async () => { view = create(createElement(Probe)); });
        expect(loaded).toBe(false);
        const t0 = 2_000_000;
        m.apiGet.mockRejectedValueOnce(new Error('503'));
        refreshPunishedCodes(t0);
        await act(async () => { await flush(); });
        expect(loaded).toBe(false);
        m.apiGet.mockResolvedValueOnce({ message: 'oops' });
        refreshPunishedCodes(t0 + PUNISH_REFRESH_MS);
        await act(async () => { await flush(); });
        expect(loaded).toBe(false);
        m.apiGet.mockResolvedValueOnce({ code: [] });
        refreshPunishedCodes(t0 + 2 * PUNISH_REFRESH_MS);
        await act(async () => { await flush(); });
        expect(loaded).toBe(true);
        // 之後失敗：保留已取得（舊名單仍有效）
        m.apiGet.mockRejectedValueOnce(new Error('503'));
        refreshPunishedCodes(t0 + 3 * PUNISH_REFRESH_MS);
        await act(async () => { await flush(); });
        expect(loaded).toBe(true);
        await act(async () => view?.unmount());
    });
});
