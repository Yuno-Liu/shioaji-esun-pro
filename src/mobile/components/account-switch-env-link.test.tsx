// 帳戶切換面板底部的「玉山模擬／正式切換」：只關閉面板並跳到帳戶 › 連線的交易環境區塊（lib/account-jump），本面板不切換環境
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ navigate: vi.fn(), switchEnvironment: vi.fn() }));
vi.mock('../lib/hash-router', () => ({ navigate: m.navigate }));
vi.mock('../../lib/account-store', () => ({
    useAccounts: () => ({ accounts: [], loaded: true, loadError: null, selectedStock: null, selectedFutures: null }),
    selectAccount: vi.fn(),
}));
vi.mock('../../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../../lib/esun', () => ({
    isEsunAccount: () => false,
    useEsunEnvironment: () => ({ environment: 'SIMULATION' }),
    esunTradeService: { switchEnvironment: m.switchEnvironment },
}));
vi.mock('../../lib/account-identity', () => ({ accountMatches: () => false }));
vi.mock('../../lib/order-confirm', () => ({
    accountConfirmLabel: () => '',
    privacyAccountLabel: (s: string) => s,
    getPendingOrderConfirm: () => null,
    subscribeOrderConfirm: () => () => undefined,
}));
vi.mock('../../lib/order-route', () => ({ orderRouteOf: () => ({ simulation: true }), routeEnvText: () => '模擬' }));
vi.mock('../../lib/privacy', () => ({ usePrivacyMode: () => false }));
vi.mock('../../lib/server-info-store', () => ({ useServerInfo: () => ({ simulation: true }) }));

import { onAccountJump, takeAccountJump } from '../lib/account-jump';
import { AccountSwitchSheet } from './account-switch-sheet';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.navigate.mockClear();
    takeAccountJump('account-env-switch');
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('AccountSwitchSheet — E.SUN environment link', () => {
    it('explains SinoPac is server-side; the link closes the sheet and jumps to 帳戶 › 連線 without switching', async () => {
        const onClose = vi.fn();
        const heard = vi.fn();
        const stop = onAccountJump(heard);
        await act(async () => { view = create(createElement(AccountSwitchSheet, { open: true, onClose })); });
        expect(text(view!.root)).toContain('永豐模擬／正式由伺服器部署決定');
        const link = view!.root.find(n => n.props['data-testid'] === 'account-env-link' && n.type === 'button');
        await act(async () => { link.props.onClick(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(m.navigate).toHaveBeenCalledWith({ name: 'account' });
        expect(heard).toHaveBeenCalledTimes(1);
        expect(takeAccountJump('other')).toBe(false);
        expect(takeAccountJump('account-env-switch')).toBe(true);
        expect(takeAccountJump('account-env-switch')).toBe(false); // 一次性
        expect(m.switchEnvironment).not.toHaveBeenCalled();
        stop();
    });
});
