// 盤中異動的訂閱控制（每個「規則 × 市場」一個鍵）：
// - sync 只送差異；同一鍵在頁內最多持有 1 份。
// - 失敗不自動重試；retry() 只對失敗的鍵各再送 1 次；失敗的鍵移除時不退訂（lib 沒有為它加 ref-count）。
// - 訂閱中被移除：等結果，成功才退訂 1 次。
// - 全部移除（離開或退到背景）＝成功的鍵各退訂 1 次。
import { describe, expect, it, vi } from 'vitest';
import type { SignalKey } from './signal-model';
import { SignalSubscriptions, type SignalSubscriptionApi } from './signal-subscriptions';

function deferred() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function setup(fail: (key: SignalKey) => boolean = () => false) {
    const api = {
        subscribe: vi.fn((key: SignalKey) => (fail(key) ? Promise.reject(new Error('boom')) : Promise.resolve())),
        unsubscribe: vi.fn(() => Promise.resolve()),
    } satisfies SignalSubscriptionApi;
    const onChange = vi.fn();
    return { api, onChange, subs: new SignalSubscriptions(api, onChange) };
}

const flush = () => new Promise(r => setTimeout(r, 0));
const keysOf = (calls: unknown[][]) => calls.map(c => c[0]).sort();

describe('SignalSubscriptions', () => {
    it('sync 只送差異，重複 sync 同一組不送任何請求', async () => {
        const { api, subs } = setup();
        subs.sync(['TSE:trade_price_surge', 'OTC:trade_price_surge']);
        await flush();
        expect(api.subscribe).toHaveBeenCalledTimes(2);
        expect(subs.coverage()).toEqual({ total: 2, ok: 2, pending: 0, failed: 0 });

        subs.sync(['OTC:trade_price_surge', 'TSE:trade_price_surge']);
        await flush();
        expect(api.subscribe).toHaveBeenCalledTimes(2);
        expect(api.unsubscribe).not.toHaveBeenCalled();

        subs.sync(['OTC:trade_price_surge', 'TSE:volume_burst']);
        await flush();
        expect(api.subscribe).toHaveBeenCalledTimes(3);
        expect(api.subscribe.mock.calls[2]![0]).toBe('TSE:volume_burst');
        expect(keysOf(api.unsubscribe.mock.calls)).toEqual(['TSE:trade_price_surge']);
    });

    it('全部移除：成功的鍵各退訂 1 次；再全部加回：各訂閱 1 次', async () => {
        const { api, subs } = setup();
        const keys: SignalKey[] = ['TSE:trade_price_surge', 'TSE:trade_price_drop', 'OTC:trade_price_surge'];
        subs.sync(keys);
        await flush();
        subs.sync([]);
        await flush();
        expect(api.unsubscribe).toHaveBeenCalledTimes(3);
        expect(subs.coverage()).toEqual({ total: 0, ok: 0, pending: 0, failed: 0 });
        subs.sync(keys);
        await flush();
        expect(api.subscribe).toHaveBeenCalledTimes(6);
    });

    it('失敗不自動重試；retry 只對失敗的鍵各送 1 次；失敗的鍵移除時不退訂', async () => {
        let failing = true;
        const { api, subs } = setup(key => failing && key.startsWith('OTC'));
        subs.sync(['TSE:volume_burst', 'OTC:volume_burst', 'OTC:suspend']);
        await flush();
        expect(subs.coverage()).toEqual({ total: 3, ok: 1, pending: 0, failed: 2 });
        // 時間經過也不重送
        await new Promise(r => setTimeout(r, 30));
        expect(api.subscribe).toHaveBeenCalledTimes(3);

        failing = false;
        subs.retry();
        expect(subs.coverage().pending).toBe(2);
        await flush();
        expect(api.subscribe).toHaveBeenCalledTimes(5);
        expect(keysOf(api.subscribe.mock.calls.slice(3))).toEqual(['OTC:suspend', 'OTC:volume_burst']);
        expect(subs.coverage()).toEqual({ total: 3, ok: 3, pending: 0, failed: 0 });

        // 沒有失敗的鍵時 retry 不送
        subs.retry();
        expect(api.subscribe).toHaveBeenCalledTimes(5);
    });

    it('失敗的鍵移除：不呼叫 unsubscribe', async () => {
        const { api, subs } = setup(() => true);
        subs.sync(['TSE:suspend']);
        await flush();
        subs.sync([]);
        await flush();
        expect(api.unsubscribe).not.toHaveBeenCalled();
    });

    it('訂閱中被移除：等結果，成功才退訂 1 次；失敗則 0 次', async () => {
        const ok = deferred();
        const bad = deferred();
        const api = {
            subscribe: vi.fn((key: SignalKey) => (key === 'TSE:suspend' ? ok.promise : bad.promise)),
            unsubscribe: vi.fn(() => Promise.resolve()),
        };
        const subs = new SignalSubscriptions(api, () => undefined);
        subs.sync(['TSE:suspend', 'OTC:suspend']);
        subs.sync([]);
        await flush();
        expect(api.unsubscribe).not.toHaveBeenCalled();
        ok.resolve();
        bad.reject(new Error('x'));
        await flush();
        expect(api.unsubscribe).toHaveBeenCalledTimes(1);
        expect(api.unsubscribe).toHaveBeenCalledWith('TSE:suspend');
        // 被移除的鍵結果晚到，不影響覆蓋率
        expect(subs.coverage()).toEqual({ total: 0, ok: 0, pending: 0, failed: 0 });
    });

    it('退訂失敗只吞掉', async () => {
        const { api, subs } = setup();
        api.unsubscribe.mockImplementation(() => Promise.reject(new Error('offline')));
        subs.sync(['TSE:suspend']);
        await flush();
        subs.sync([]);
        await flush();
        expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    });
});
