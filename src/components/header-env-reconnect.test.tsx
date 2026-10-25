// src/components/header-env-reconnect.test.tsx — 頂欄環境選單：玉山登入失效提示與「重新連線」
// 測試資料全部是合成的佔位值（不是真實帳號）。

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => {
    const storage = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
    };
    (globalThis as any).window = Object.assign(new EventTarget(), {
        addEventListener: () => {},
        removeEventListener: () => {},
    });
    return {
        mocks: {
            notify: vi.fn(),
            invalidateAllQueries: vi.fn(),
            refreshTradingState: vi.fn(async () => undefined),
            refreshTradingStateForModeChange: vi.fn(async () => undefined),
        },
    };
});

vi.mock('../lib/sounds', () => ({ playOrder: vi.fn(), playDeal: vi.fn(), playError: vi.fn(), playAlert: vi.fn() }));

import type { Account } from '../lib/types/portfolio';
import { ESUN_BROKER_CODE } from '../lib/esun';

// 測試用佔位帳號（不是真實帳號）
const esunAccount: Account = {
    account_type: 'S',
    broker_id: ESUN_BROKER_CODE,
    account_id: '0000001',
    signed: true,
    username: '玉山證券',
    person_id: 'A123456789',
};

vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({ accounts: [esunAccount], selectedAccount: esunAccount, selectedStock: esunAccount, selectedFutures: null }),
    getActiveAccount: () => esunAccount,
    selectAccount: vi.fn(),
    accountFor: () => esunAccount,
    ensureAccounts: vi.fn(),
    registerExternalAccounts: vi.fn(),
    replaceExternalAccountsForBroker: vi.fn(),
    getAccountState: () => ({ accounts: [esunAccount], selectedAccount: esunAccount, selectedStock: esunAccount, selectedFutures: null }),
}));
vi.mock('../lib/server-info-store', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, useServerInfo: () => ({ simulation: true }), knownServerInfo: () => ({ simulation: true }) };
});
vi.mock('../lib/trading-state', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        refreshTradingState: mocks.refreshTradingState,
        refreshTradingStateForModeChange: mocks.refreshTradingStateForModeChange,
    };
});
vi.mock('../hooks/use-query', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, invalidateAllQueries: mocks.invalidateAllQueries };
});
vi.mock('../lib/trade', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, notify: mocks.notify };
});
vi.mock('../lib/privacy', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, usePrivacyMode: () => false };
});
vi.mock('../lib/shioaji', () => ({ fetchInfo: vi.fn(async () => ({ simulation: true })) }));

import { esunTradeService, type EsunBridgeHealth, type EsunReconnectResult } from '../lib/esun';
import { ESUN_HEALTH_RECHECK_DELAYS, ESUN_LOGIN_LOCK_WARNING, esunSessionLost, HeaderEnvMenu } from './header-env-menu';

function extractText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join(' ');
    if (node.children) return extractText(node.children);
    return '';
}

const LIVE: EsunBridgeHealth = {
    ok: true,
    configured: true,
    problems: [],
    environment: 'SIMULATION',
    account: null,
    loggedIn: true,
    loginError: null,
};
const EXPIRED: EsunBridgeHealth = {
    ...LIVE,
    loggedIn: false,
    sessionExpired: true,
    sessionExpiredAt: '2026-01-02T00:00:05+08:00',
    loginError: '玉山登入已於換日失效，請以「重新連線」手動重新登入',
};

describe('HeaderEnvMenu — 玉山登入失效與重新連線', () => {
    let view: ReactTestRenderer | undefined;
    let bridge: EsunBridgeHealth | null;
    let reconnect: ReturnType<typeof vi.fn<() => Promise<EsunReconnectResult>>>;

    const render = async () => {
        await act(async () => {
            view = create(createElement(HeaderEnvMenu, {}));
        });
    };
    const findAll = (testId: string) => view!.root.findAll((n) => n.props['data-testid'] === testId && typeof n.type === 'string');
    const find = (testId: string) => findAll(testId)[0]!;
    const openMenu = async () => {
        await act(async () => {
            find('header-env-badge').props.onClick();
        });
    };
    const click = async (el: ReactTestInstance) => {
        await act(async () => {
            await el.props.onClick();
        });
    };

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.clearAllMocks();
        bridge = EXPIRED;
        reconnect = vi.fn(async () => {
            bridge = LIVE;
            return { ok: true, health: LIVE, environment: 'SIMULATION', sessionGeneration: 2 } as EsunReconnectResult;
        });
        vi.spyOn(esunTradeService, 'connectBridge').mockImplementation(async () => bridge);
        vi.spyOn(esunTradeService, 'getBridgeHealth').mockImplementation(() => bridge);
        vi.spyOn(esunTradeService, 'refreshConfigProfiles').mockImplementation(async () => esunTradeService.getConfigProfiles());
        vi.spyOn(esunTradeService, 'reconnect').mockImplementation(reconnect);
    });

    afterEach(async () => {
        if (view) {
            await act(async () => {
                view?.unmount();
            });
            view = undefined;
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('esunSessionLost：loggedIn:false 或 sessionExpired:true 才算失效', () => {
        expect(esunSessionLost(null)).toBe(false);
        expect(esunSessionLost(LIVE)).toBe(false);
        expect(esunSessionLost({ ...LIVE, loggedIn: false })).toBe(true);
        expect(esunSessionLost({ ...LIVE, sessionExpired: true })).toBe(true);
    });

    it('失效時徽章與選單都顯示「玉山登入已失效」、loginError 與「重新連線」按鈕', async () => {
        await render();
        expect(extractText(find('esun-session-lost-badge'))).toContain('玉山登入失效');
        await openMenu();
        const alert = find('esun-session-lost');
        expect(extractText(alert)).toContain('玉山登入已失效');
        expect(extractText(find('esun-session-login-error'))).toBe(EXPIRED.loginError);
        expect(extractText(alert)).toContain('失效時間');
        const btn = find('esun-reconnect');
        expect(btn.props.disabled).toBe(false);
        expect(extractText(btn)).toContain('重新連線');
    });

    it('已登入或 bridge 未連線時不顯示失效提示', async () => {
        bridge = LIVE;
        await render();
        expect(findAll('esun-session-lost-badge')).toHaveLength(0);
        await openMenu();
        expect(findAll('esun-session-lost')).toHaveLength(0);
        await act(async () => view!.unmount());
        bridge = null;
        await render();
        await openMenu();
        expect(findAll('esun-session-lost')).toHaveLength(0);
        expect(findAll('esun-reconnect')).toHaveLength(0);
    });

    it('重新連線中停用按鈕並顯示進度；成功後提示並重新整理帳務', async () => {
        let release!: () => void;
        reconnect.mockImplementation(() => new Promise<EsunReconnectResult>((resolve) => {
            release = () => {
                bridge = LIVE;
                resolve({ ok: true, health: LIVE, environment: 'SIMULATION', sessionGeneration: 2 });
            };
        }));
        await render();
        await openMenu();
        await act(async () => {
            find('esun-reconnect').props.onClick();
        });
        const busy = find('esun-reconnect');
        expect(busy.props.disabled).toBe(true);
        expect(extractText(busy)).toContain('重新連線中');
        // 進行中再按也不會送第二次
        await act(async () => {
            busy.props.onClick();
        });
        expect(reconnect).toHaveBeenCalledTimes(1);
        // 進行中環境切換也鎖定
        expect(find('env-option-production').props.disabled).toBe(true);

        await act(async () => {
            release();
        });
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '玉山重新連線' }));
        expect(mocks.invalidateAllQueries).toHaveBeenCalledTimes(1);
        // 委託權威重讀只由 session 代次 hook 觸發（見 dispatch.test.ts），選單不再重複呼叫
        expect(mocks.refreshTradingStateForModeChange).not.toHaveBeenCalled();
        expect(mocks.refreshTradingState).not.toHaveBeenCalled();
        expect(findAll('esun-session-lost')).toHaveLength(0);
        expect(findAll('esun-session-lost-badge')).toHaveLength(0);
    });

    it('成功但讀不到 health：顯示「狀態確認中」、隱藏重新連線按鈕，排程重讀後恢復', async () => {
        vi.useFakeTimers();
        // 服務仍保有舊的失效 health；成功結果的 health 為 null
        reconnect.mockResolvedValue({ ok: true, health: null, environment: 'SIMULATION', sessionGeneration: 2 });
        const refresh = vi.spyOn(esunTradeService, 'refreshHealth').mockResolvedValueOnce(null).mockImplementation(async () => {
            bridge = LIVE;
            return LIVE;
        });
        await render();
        await openMenu();
        await click(find('esun-reconnect'));
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '玉山重新連線' }));
        expect(extractText(find('esun-health-confirming'))).toContain('狀態確認中');
        expect(findAll('esun-session-lost')).toHaveLength(0);
        expect(findAll('esun-reconnect')).toHaveLength(0);
        expect(findAll('esun-session-lost-badge')).toHaveLength(0);
        // 第一次重讀仍失敗 → 繼續確認中
        await act(async () => { await vi.advanceTimersByTimeAsync(ESUN_HEALTH_RECHECK_DELAYS[0]!); });
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(findAll('esun-health-confirming')).toHaveLength(1);
        // 第二次讀到已登入 → 結束確認中，不顯示失效
        await act(async () => { await vi.advanceTimersByTimeAsync(ESUN_HEALTH_RECHECK_DELAYS[1]!); });
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(findAll('esun-health-confirming')).toHaveLength(0);
        expect(findAll('esun-session-lost')).toHaveLength(0);
        vi.useRealTimers();
    });

    it('重讀全部失敗後回到最後看到的 health（仍失效時重新顯示重新連線）', async () => {
        vi.useFakeTimers();
        reconnect.mockResolvedValue({ ok: true, health: null, environment: 'SIMULATION', sessionGeneration: 2 });
        vi.spyOn(esunTradeService, 'refreshHealth').mockResolvedValue(null);
        await render();
        await openMenu();
        await click(find('esun-reconnect'));
        expect(findAll('esun-reconnect')).toHaveLength(0);
        for (const delay of ESUN_HEALTH_RECHECK_DELAYS) {
            await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
        }
        expect(findAll('esun-health-confirming')).toHaveLength(0);
        expect(findAll('esun-reconnect')).toHaveLength(1);
        vi.useRealTimers();
    });

    it('開啟選單時聚焦對話框本身，不聚焦任何有副作用的按鈕', async () => {
        const focused: string[] = [];
        await act(async () => {
            view = create(createElement(HeaderEnvMenu, {}), {
                createNodeMock: (el) => ({
                    focus: () => {
                        const props = el.props as Record<string, unknown>;
                        focused.push(`${String(el.type)}:${String(props['data-testid'] ?? props.role ?? '')}`);
                    },
                    querySelector: () => null,
                }),
            });
        });
        await openMenu();
        expect(focused).toEqual(['div:header-env-menu']);
        const dialog = find('header-env-menu');
        expect(dialog.props.tabIndex).toBe(-1);
        expect(dialog.props.role).toBe('dialog');
    });

    it('失敗時以錯誤通知顯示原因，不重新整理帳務，按鈕恢復可按', async () => {
        reconnect.mockResolvedValue({ ok: false, health: EXPIRED, error: '玉山重新連線失敗：玉山登入失敗：測試用錯誤', code: 'LOGIN_FAILED' });
        await render();
        await openMenu();
        await click(find('esun-reconnect'));
        expect(mocks.notify).toHaveBeenCalledWith({ kind: 'err', title: '玉山重新連線失敗', body: '玉山重新連線失敗：玉山登入失敗：測試用錯誤' });
        expect(mocks.invalidateAllQueries).not.toHaveBeenCalled();
        expect(mocks.refreshTradingStateForModeChange).not.toHaveBeenCalled();
        expect(find('esun-reconnect').props.disabled).toBe(false);
        expect(findAll('esun-session-lost')).toHaveLength(1);
    });

    it('登入熔斷鎖定中：先彈出鎖帳警告確認，取消不送出，確認才重新連線', async () => {
        bridge = { ...EXPIRED, loginLocked: true, loginLockReason: 'LOGIN_FAILED' };
        await render();
        await openMenu();
        await click(find('esun-reconnect'));
        expect(reconnect).not.toHaveBeenCalled();
        const box = find('esun-reconnect-confirm-box');
        expect(extractText(box)).toContain(ESUN_LOGIN_LOCK_WARNING);
        expect(ESUN_LOGIN_LOCK_WARNING).toContain('密碼連續錯誤 3 次會被玉山鎖帳');

        await click(find('esun-reconnect-cancel'));
        expect(findAll('esun-reconnect-confirm-box')).toHaveLength(0);
        expect(reconnect).not.toHaveBeenCalled();

        await click(find('esun-reconnect'));
        await click(find('esun-reconnect-confirm'));
        expect(reconnect).toHaveBeenCalledTimes(1);
        // 熔斷鎖定中且使用者確認 → 帶 force:true 強制重試一次
        expect(reconnect).toHaveBeenCalledWith({ force: true });
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '玉山重新連線' }));
    });

    it('確認框寫明強制重試與鎖帳風險；未鎖定時直接重新連線且不帶 force', async () => {
        expect(ESUN_LOGIN_LOCK_WARNING).toBe(
            '上次登入因密碼或憑證錯誤被鎖。若已確認設定正確（或已修改 .env 並重啟），按確定將強制重試一次；密碼連續錯誤 3 次會被玉山鎖帳',
        );
        await render();
        await openMenu();
        await click(find('esun-reconnect'));
        expect(findAll('esun-reconnect-confirm-box')).toHaveLength(0);
        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(reconnect.mock.calls[0]).toEqual([]);
    });
});
