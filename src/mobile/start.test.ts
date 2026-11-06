// 手機入口啟動順序：initTheme → 字級預設（不論 secure）→ 強制下單確認 → 清除 Agent 活動紀錄 → （secure 才）bootstrap
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLog, trackActivity } from '../lib/activity';

const m = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../lib/boot', () => ({ bootstrap: () => m.calls.push('bootstrap') }));
vi.mock('../lib/risk', () => ({
    getRiskSettings: () => ({ confirmManualOrders: true }),
    setRiskSettings: () => undefined,
    subscribeRiskSettings: () => () => undefined,
}));
vi.mock('../lib/theme-store', () => ({ initTheme: () => m.calls.push('initTheme') }));
vi.mock('./lib/font-default', () => ({ applyMobileFontDefault: () => m.calls.push('fontDefault') }));

import { startMobile } from './start';

beforeEach(() => {
    m.calls.length = 0;
});

describe('startMobile', () => {
    it('非 secure：套用主題與字級預設，不 bootstrap', () => {
        startMobile(false);
        expect(m.calls).toEqual(['initTheme', 'fontDefault']);
    });

    it('secure：字級預設在 initTheme 之後、bootstrap 之前', () => {
        startMobile(true);
        expect(m.calls).toEqual(['initTheme', 'fontDefault', 'bootstrap']);
    });
});

// 安全稽核 F7：手機平倉／全部刪單經 lib/trade.ts 寫入桌面 Agent 活動紀錄；手機啟動時清掉（只清紀錄，不關觀察開關）
describe('startMobile — 清除桌面 Agent 活動紀錄', () => {
    const ACTIVITY_KEY = 'sj-agent-activity-v1';
    const OBSERVE_KEY = 'sj-agent-observe';
    function memoryStorage(seed: Record<string, string> = {}) {
        const data = new Map(Object.entries(seed));
        return {
            data,
            getItem: (k: string) => data.get(k) ?? null,
            setItem: (k: string, v: string) => { data.set(k, String(v)); },
            removeItem: (k: string) => { data.delete(k); },
        };
    }
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('移除 sj-agent-activity-v1，保留 sj-agent-observe 與其他設定', () => {
        const storage = memoryStorage({
            [ACTIVITY_KEY]: JSON.stringify([{ ts: 1, kind: '下單', detail: '2330 賣 1 @100' }]),
            [OBSERVE_KEY]: '1',
            other: 'keep',
        });
        vi.stubGlobal('localStorage', storage);
        startMobile(false);
        expect(storage.data.has(ACTIVITY_KEY)).toBe(false);
        expect(storage.data.get(OBSERVE_KEY)).toBe('1');
        expect(storage.data.get('other')).toBe('keep');
    });

    it('也清掉已載入記憶體的紀錄，之後的寫入不會把舊委託內容寫回', () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const storage = memoryStorage({ [OBSERVE_KEY]: '1' });
        vi.stubGlobal('localStorage', storage);
        trackActivity('下單', '2330 賣 1 @100');
        expect(activityLog()).toHaveLength(1);
        startMobile(false);
        expect(activityLog()).toEqual([]);
        vi.runAllTimers();
        expect(storage.data.get(ACTIVITY_KEY) ?? '').not.toContain('2330');
    });

    it('storage 讀寫丟例外（私密瀏覽、被封鎖）時照常啟動', () => {
        const boom = () => { throw new Error('SecurityError'); };
        vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
        expect(() => startMobile(true)).not.toThrow();
        expect(m.calls).toEqual(['initTheme', 'fontDefault', 'bootstrap']);
    });

    it('沒有 localStorage（非瀏覽器環境）時照常啟動', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(() => startMobile(false)).not.toThrow();
        expect(m.calls).toEqual(['initTheme', 'fontDefault']);
    });
});
