// src/lib/esun/stream.test.ts — 玉山回報串流：只有擁有者連線、事件轉送、session、狀態與重建（C-09 / §5）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({
    owner: true,
    ownerListeners: new Set<() => void>(),
    named: new Map<string, Set<(raw: string) => void>>(),
    published: [] as { name: string; raw: string }[],
}));

vi.mock('../stream', () => ({
    isStreamOwner: () => bus.owner,
    subscribeStreamOwner: (l: () => void) => { bus.ownerListeners.add(l); return () => bus.ownerListeners.delete(l); },
    onStreamEvent: (name: string, l: (raw: string) => void) => {
        const set = bus.named.get(name) ?? new Set();
        set.add(l);
        bus.named.set(name, set);
        return () => set.delete(l);
    },
    // 與 stream.ts 相同：order_event 進回報管線，其他名稱交給本視窗的具名監聽者
    publishStreamEvent: (name: string, raw: string) => {
        bus.published.push({ name, raw });
        if (name !== 'order_event') bus.named.get(name)?.forEach(l => l(raw));
    },
}));

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    private handlers = new Map<string, ((e: { data: string }) => void)[]>();
    constructor(readonly url: string) { FakeEventSource.instances.push(this); }
    addEventListener(name: string, h: (e: { data: string }) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), h]); }
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    fire(name: string, data: unknown) { for (const h of this.handlers.get(name) ?? []) h({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
    fail(closed = false) { this.readyState = closed ? 2 : 0; this.onerror?.(); }
}

import { MockEsunDriver } from './mock-driver';
import { esunTradeService } from './service';
import { ensureEsunOrderStream, getEsunStreamStatus, onEsunStreamSignal, stopEsunOrderStream, type EsunStreamSignal } from './stream';

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
const published = (name: string) => bus.published.filter(p => p.name === name);

describe('E.SUN order stream', () => {
    let seen: EsunStreamSignal[];
    let stopSignals: () => void;

    beforeEach(async () => {
        vi.stubGlobal('EventSource', FakeEventSource);
        FakeEventSource.instances = [];
        bus.owner = true;
        bus.published = [];
        esunTradeService.setDriver(new MockEsunDriver());
        await esunTradeService.switchEnvironment('SIMULATION');
        seen = [];
        stopSignals = onEsunStreamSignal(s => seen.push(s));
    });

    afterEach(() => {
        stopSignals();
        stopEsunOrderStream();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('connects only in the stream-owner window and follows ownership', () => {
        bus.owner = false;
        ensureEsunOrderStream();
        expect(FakeEventSource.instances).toHaveLength(0);
        bus.owner = true;
        bus.ownerListeners.forEach(l => l());
        expect(latest().url).toBe('/esun/stream/orders');
        bus.owner = false;
        bus.ownerListeners.forEach(l => l());
        expect(latest().closed).toBe(true);
    });

    it('converts order / deal events into the shared report pipeline', () => {
        ensureEsunOrderStream();
        latest().open();
        latest().fire('order', {
            event_id: 'boot1-1', seq: 1, ts: '2026-10-23T09:05:12+08:00', environment: 'SIMULATION',
            account: { broker_id: '8840', account_id: '1234567' }, op_type: 'New',
            ord_no: 'C0001', stock_no: '2884', buy_sell: 'B', ap_code: '1', od_price: 25, org_qty: 1, org_qty_share: 1000, err_code: '00000000',
        });
        const [report] = published('order_event');
        const body = JSON.parse(report!.raw).data.StockOrder;
        expect(body).toMatchObject({ event_id: 'v1:esun-sim:boot1:1', order: { id: 'C0001', account: { broker_id: '8840-SIM', account_id: '1234567' } } });
    });

    it('drops events of another environment and re-syncs the session', () => {
        const refresh = vi.spyOn(esunTradeService, 'refreshHealth');
        ensureEsunOrderStream();
        latest().open();
        refresh.mockClear();
        latest().fire('order', { event_id: 'boot1-2', seq: 2, environment: 'PRODUCTION', ord_no: 'C1', stock_no: '2884', buy_sell: 'B', org_qty: 1 });
        expect(published('order_event')).toHaveLength(0);
        expect(refresh).toHaveBeenCalled();
    });

    it('applies session events to the environment snapshot of every window', () => {
        ensureEsunOrderStream();
        latest().open();
        const generation = (esunTradeService.getSessionGeneration() ?? 0) + 1;
        latest().fire('session', { generation, environment: 'PRODUCTION', account: { broker_id: '8840', account_id: '1234567' }, loggedIn: true, reason: 'switch' });
        expect(published('esun_session')).toHaveLength(1);
        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
        expect(esunTradeService.getAccounts()[0]?.broker_id).toBe('8840');
    });

    it('reports down / reconnected through the native reconnect (keeps Last-Event-ID)', () => {
        ensureEsunOrderStream();
        const source = latest();
        source.open();
        expect(getEsunStreamStatus()).toBe('live');
        source.fail(false); // CONNECTING：瀏覽器自己重連，帶 Last-Event-ID
        expect(getEsunStreamStatus()).toBe('down');
        expect(FakeEventSource.instances).toHaveLength(1);
        source.open();
        expect(seen.map(s => s.kind)).toEqual(['down', 'reconnected']);
    });

    it('ignores the resync of the first connection but forwards it after a lost connection', () => {
        vi.useFakeTimers();
        ensureEsunOrderStream();
        latest().open();
        latest().fire('resync', { reason: 'no Last-Event-ID' });
        expect(seen.some(s => s.kind === 'resync')).toBe(false);
        latest().fail(true); // CLOSED：自行以退避重建（新連線沒有 Last-Event-ID）
        vi.advanceTimersByTime(1_000);
        expect(FakeEventSource.instances).toHaveLength(2);
        latest().open();
        latest().fire('resync', { reason: 'buffer exceeded' });
        expect(seen.some(s => s.kind === 'resync')).toBe(true);
    });

    it('forwards a resync that follows a native reconnect of the same connection', () => {
        ensureEsunOrderStream();
        const source = latest();
        source.open();
        source.fail(false);
        source.open();
        source.fire('resync', { reason: 'Last-Event-ID outside the buffer' });
        expect(seen.map(s => s.kind)).toEqual(['down', 'reconnected', 'resync']);
    });

    it('treats a silent stream as stale and reconnects', () => {
        vi.useFakeTimers();
        ensureEsunOrderStream();
        latest().open();
        vi.advanceTimersByTime(85_000);
        expect(FakeEventSource.instances[0]!.closed).toBe(true);
        expect(getEsunStreamStatus()).toBe('down');
        vi.advanceTimersByTime(1_000);
        expect(FakeEventSource.instances).toHaveLength(2);
    });
});
