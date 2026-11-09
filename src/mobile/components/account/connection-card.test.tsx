// 帳戶 › 連線：伺服器未連線提示（上游 #384 移植）。黏著判斷與狀態列面板共用 lib/server-down-hint.ts：
// 狀態列先看到 down，之後才開啟帳戶頁、串流重連中，也要顯示；LIVE 消失；從未 down 過的 connecting 不顯示；提示內沒有按鈕（S1）。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    stream: 'live' as 'live' | 'connecting' | 'down' | 'stale',
}));
vi.mock('../../../hooks/use-stream', () => ({ useStreamStatus: () => m.stream }));
vi.mock('../../../lib/esun', () => ({
    isEsunAccount: () => false,
    esunTradeService: {
        subscribe: () => () => undefined,
        getBridgeHealth: () => null,
        refreshHealth: async () => null,
    },
}));
vi.mock('../../../lib/esun/stream', () => ({ getEsunStreamStatus: () => 'idle' }));
vi.mock('../../../lib/stream', () => ({ getLastHeartbeat: () => 0, streamConnectionEpoch: () => 1 }));
vi.mock('./env-switch-section', () => ({ EnvSwitchSection: () => createElement('div', { 'data-testid': 'stub-env-switch' }) }));
vi.mock('./esun-reconnect-section', () => ({ EsunReconnectSection: () => null }));

import { trackServerLost } from '../../lib/server-down-hint';
import { ConnectionCard } from './connection-card';

let view: ReactTestRenderer | undefined;
const render = async () => { await act(async () => { view = create(createElement(ConnectionCard)); }); };
const rerender = async () => { await act(async () => { view!.update(createElement(ConnectionCard)); }); };
const hint = (): ReactTestInstance[] => view!.root.findAll(n => n.props['data-testid'] === 'conn-server-down' && typeof n.type === 'string');
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.stream = 'live';
    trackServerLost('live');
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('帳戶 › 連線：伺服器未連線提示', () => {
    it('down 顯示（Docker 用語、role=status、無按鈕）→ connecting 維持 → LIVE 消失', async () => {
        m.stream = 'down';
        await render();
        expect(hint()).toHaveLength(1);
        expect(hint()[0]!.props.role).toBe('status');
        const text = textOf(hint()[0]!);
        expect(text).toContain('伺服器未連線。');
        expect(text).toContain('SJ_PRODUCTION');
        expect(text).toContain('docker compose up -d');
        expect(hint()[0]!.findAll(n => n.type === 'button' || n.type === 'a')).toHaveLength(0);
        m.stream = 'connecting';
        await rerender();
        expect(hint()).toHaveLength(1);
        m.stream = 'live';
        await rerender();
        expect(hint()).toHaveLength(0);
    });

    it('別處（狀態列）先看到 down，之後才掛載、串流重連中：仍顯示', async () => {
        trackServerLost('down');
        m.stream = 'connecting';
        await render();
        expect(hint()).toHaveLength(1);
    });

    it('從未 down 過的 connecting 不顯示；交易環境區塊照常掛載', async () => {
        m.stream = 'connecting';
        await render();
        expect(hint()).toHaveLength(0);
        expect(view!.root.findAll(n => n.props['data-testid'] === 'stub-env-switch')).toHaveLength(1);
    });
});
