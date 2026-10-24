// src/components/hud-header-env.test.tsx — 頂欄券商／帳號／環境徽章與選單（header-env-menu.tsx）

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { storage, mocks } = vi.hoisted(() => {
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
        storage,
        mocks: {
            notify: vi.fn(),
            fetchInfo: vi.fn(),
            refreshTradingState: vi.fn(async () => undefined),
            refreshTradingStateForModeChange: vi.fn(async () => undefined),
            serverInfo: { simulation: true } as { simulation: boolean } | undefined,
        },
    };
});

vi.mock('../lib/sounds', () => ({
    playOrder: vi.fn(),
    playDeal: vi.fn(),
    playError: vi.fn(),
    playAlert: vi.fn(),
}));

import type { Account } from '../lib/types/portfolio';
import { ESUN_BROKER_CODE } from '../lib/esun';

const sinopacAccount: Account = {
    account_type: 'S',
    broker_id: '9A95',
    account_id: '9807421',
    signed: true,
    username: '永豐證券',
    person_id: 'A123456789',
};

const sinopacFutures: Account = {
    account_type: 'F',
    broker_id: 'F002000',
    account_id: '1234567',
    signed: true,
    username: '永豐期貨',
    person_id: 'A123456789',
};

const unsignedSinopac: Account = {
    account_type: 'S',
    broker_id: '9A95',
    account_id: '1111111',
    signed: false,
    username: '永豐證券',
    person_id: 'A123456789',
};

// 測試用佔位帳號（不是真實帳號）
const esunAccount: Account = {
    account_type: 'S',
    broker_id: ESUN_BROKER_CODE,
    account_id: '0000001',
    signed: true,
    username: '玉山證券',
    person_id: 'A123456789',
};

let mockAccounts: Account[] = [sinopacAccount, esunAccount];
let mockSelectedAccount: Account | null = sinopacAccount;
let mockSelectedStock: Account | null = sinopacAccount;
let mockSelectedFutures: Account | null = null;

vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({
        accounts: mockAccounts,
        selectedAccount: mockSelectedAccount,
        selectedStock: mockSelectedStock,
        selectedFutures: mockSelectedFutures,
    }),
    getActiveAccount: (s?: any) => s?.selectedAccount ?? s?.selectedStock ?? s?.selectedFutures ?? null,
    selectAccount: (acc: Account) => {
        // 與真實 selectAccount 一致：不可交易的帳號靜默拒絕
        if (!(mocks.serverInfo?.simulation === true || acc.signed === true)) return;
        mockSelectedAccount = acc;
        if (acc.account_type === 'S') mockSelectedStock = acc;
        else mockSelectedFutures = acc;
    },
    accountFor: (type: 'S' | 'F') => (type === 'S' ? mockSelectedStock : mockSelectedFutures) ?? undefined,
    ensureAccounts: vi.fn(),
    registerExternalAccounts: (ext: Account[]) => {
        for (const a of ext) {
            if (!mockAccounts.some(ma => ma.broker_id === a.broker_id && ma.account_id === a.account_id)) {
                mockAccounts = [...mockAccounts, a];
            }
        }
    },
    getAccountState: () => ({
        accounts: mockAccounts,
        selectedAccount: mockSelectedAccount,
        selectedStock: mockSelectedStock,
        selectedFutures: mockSelectedFutures,
    }),
}));

vi.mock('../lib/server-info-store', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerInfo: () => mocks.serverInfo,
        knownServerInfo: () => mocks.serverInfo,
    };
});
vi.mock('../lib/trading-state', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        refreshTradingState: mocks.refreshTradingState,
        refreshTradingStateForModeChange: mocks.refreshTradingStateForModeChange,
    };
});
vi.mock('../lib/trade', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, notify: mocks.notify };
});
vi.mock('../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../lib/header-items', () => ({
    useHeaderItems: () => ({
        symbolSearch: false,
        bankBalance: false,
        liveStatus: true,
        layoutLibrary: false,
        flashAll: false,
        clock: false,
    }),
}));
vi.mock('../lib/privacy', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        maskMoney: (m: string) => m,
        usePrivacyMoney: () => false,
        usePrivacyMode: () => false,
    };
});
vi.mock('../lib/risk', () => ({ useRiskSettings: () => ({ locked: false }), setRiskSettings: vi.fn() }));
vi.mock('../lib/tauri', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        appVersion: async () => '0.1.0',
        checkForUpdates: vi.fn(),
        listenTrayEvents: async () => () => {},
        openFlashTiles: vi.fn(),
    };
});
vi.mock('../lib/server-adoption', () => ({
    useServerAttachment: () => ({ kind: 'managed' }),
    externalServerLabel: () => '',
}));
vi.mock('../lib/shioaji', () => ({
    fetchInfo: mocks.fetchInfo,
}));

import { esunTradeService, HttpEsunDriver, MockEsunDriver, type EsunBridgeHealth } from '../lib/esun';
import { describeRoutes, HeaderEnvMenu, overallEnv, routesLabel } from './header-env-menu';
import { HudHeader } from './hud-header';

function extractText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join(' ');
    if (node.children) return extractText(node.children);
    return '';
}

const health = (environment: 'SIMULATION' | 'PRODUCTION' | null): EsunBridgeHealth => ({
    ok: true,
    configured: true,
    problems: [],
    environment,
    account: null,
    loggedIn: true,
    loginError: null,
});

const PROFILES = {
    SIMULATION: {
        available: true,
        fileName: 'esun-config.simulation.ini',
        expectedFileName: 'esun-config.simulation.ini',
        aliases: ['esun-config.simulation.ini', 'esun-config.sim.ini'],
        entry: 'https://esuntradingapi-simulation.esunsec.com.tw/api/v1',
    },
    PRODUCTION: {
        available: true,
        fileName: 'esun-config.production.ini',
        expectedFileName: 'esun-config.production.ini',
        aliases: ['esun-config.production.ini', 'esun-config.prod.ini'],
        entry: 'https://esuntradingapi.esunsec.com.tw/api/v1',
    },
};

describe('HeaderEnvMenu', () => {
    let view: ReactTestRenderer | undefined;
    let bridge: EsunBridgeHealth | null;

    const render = async () => {
        await act(async () => {
            view = create(createElement(HeaderEnvMenu, { onOpenServerManager: vi.fn() }));
        });
    };
    const find = (testId: string) => view!.root.findByProps({ 'data-testid': testId });
    const findAll = (testId: string) => view!.root.findAll((n) => n.props['data-testid'] === testId && typeof n.type === 'string');
    const badgeText = () => extractText(find('header-env-badge'));
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

    beforeEach(async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.clearAllMocks();
        storage.clear();
        mocks.serverInfo = { simulation: true };
        mocks.fetchInfo.mockResolvedValue({ simulation: true });
        bridge = health('SIMULATION');
        vi.spyOn(esunTradeService, 'connectBridge').mockImplementation(async () => bridge);
        vi.spyOn(esunTradeService, 'getBridgeHealth').mockImplementation(() => bridge);
        vi.spyOn(esunTradeService, 'refreshConfigProfiles').mockImplementation(async () => esunTradeService.getConfigProfiles());
        esunTradeService.setDriver(new MockEsunDriver());
        esunTradeService.setConfigProfiles(PROFILES, 'esun-config.simulation.ini');
        await esunTradeService.switchEnvironment('SIMULATION');
        mockAccounts = [sinopacAccount, esunAccount];
        mockSelectedAccount = sinopacAccount;
        mockSelectedStock = sinopacAccount;
        mockSelectedFutures = null;
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

    it('永豐徽章跟隨 /api/v1/info 的 simulation（模擬）', async () => {
        await render();
        expect(badgeText()).toContain('永豐');
        expect(badgeText()).toContain('模擬環境');
        expect(find('header-env-badge').props['data-env']).toBe('sim');
    });

    it('永豐伺服器為正式時徽章顯示正式紅色，選單內沒有任何永豐切換選項', async () => {
        mocks.serverInfo = { simulation: false };
        await render();
        expect(badgeText()).toContain('正式環境');
        expect(find('header-env-badge').props['data-env']).toBe('prod');
        await openMenu();
        const readonly = find('sinopac-env-readonly');
        expect(extractText(readonly)).toContain('/api/v1/info');
        // 唯讀區只有「開啟伺服器管理」按鈕，沒有模擬／正式切換
        const buttons = readonly.findAllByType('button');
        expect(buttons).toHaveLength(1);
        expect(extractText(buttons[0])).toContain('伺服器管理');
        // 永豐路由時不渲染玉山環境選項以外的切換；也不寫入舊的 override
        expect(storage.has('shioaji_simulation_override')).toBe(false);
        expect(badgeText()).toContain('正式環境');
    });

    it('永豐模式未知（/info 失敗或尚未回應）時顯示「環境未知」而非模擬', async () => {
        mocks.serverInfo = undefined;
        mocks.fetchInfo.mockRejectedValue(new Error('offline'));
        await render();
        expect(badgeText()).toContain('環境未知');
        expect(badgeText()).not.toContain('模擬');
        expect(find('header-env-badge').props['data-env']).toBe('unknown');
        await openMenu();
        // 開啟選單時會重新探測 /info
        expect(mocks.fetchInfo).toHaveBeenCalled();
    });

    it('「開啟伺服器管理」引導到既有的伺服器模式設定流程', async () => {
        const onOpenServerManager = vi.fn();
        await act(async () => {
            view = create(createElement(HeaderEnvMenu, { onOpenServerManager }));
        });
        await openMenu();
        await click(find('sinopac-open-server-manager'));
        expect(onOpenServerManager).toHaveBeenCalledTimes(1);
        expect(view!.root.findAll((n) => n.props['data-testid'] === 'header-env-menu')).toHaveLength(0);
    });

    it('玉山 bridge 尚未回報時環境顯示「未知」，且不能切換', async () => {
        bridge = null;
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        await render();
        expect(badgeText()).toContain('玉山');
        expect(badgeText()).toContain('環境未知');
        await openMenu();
        expect(find('env-option-simulation').props.disabled).toBe(true);
        expect(find('env-option-production').props.disabled).toBe(true);
    });

    it('股票走玉山模擬、期貨走永豐正式時，兩條路由都顯示且徽章以正式警示', async () => {
        mocks.serverInfo = { simulation: false };
        mockAccounts = [sinopacAccount, esunAccount, sinopacFutures];
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        mockSelectedFutures = sinopacFutures;
        await render();
        const text = badgeText();
        expect(text).toContain('證 玉山 模擬');
        expect(text).toContain('期 永豐 正式');
        expect(find('header-env-badge').props['data-env']).toBe('prod');
        await openMenu();
        expect(extractText(find('header-route-S'))).toContain(`${ESUN_BROKER_CODE}-${esunAccount.account_id}`);
        expect(extractText(find('header-route-F'))).toContain('正式');
    });

    it('切到玉山正式前要求明確確認；取消不會切換', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        const spy = vi.spyOn(esunTradeService, 'switchEnvironment');
        await render();
        await openMenu();
        const prodOpt = find('env-option-production');
        expect(extractText(prodOpt)).toContain('無 Environment 資訊 (僅 Entry)');
        expect(extractText(prodOpt)).toContain('https://esuntradingapi.esunsec.com.tw/api/v1');
        await click(prodOpt);
        expect(spy).not.toHaveBeenCalled();
        expect(extractText(find('env-confirm-production-box'))).toContain('真實帳戶');
        await click(find('env-confirm-cancel'));
        expect(spy).not.toHaveBeenCalled();
        expect(esunTradeService.getEnvironment()).toBe('SIMULATION');
        expect(badgeText()).toContain('模擬環境');
    });

    it('確認後切到玉山正式，再切回模擬（模擬不需確認）', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        await render();
        await openMenu();
        await click(find('env-option-production'));
        await click(find('env-confirm-production'));
        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
        expect(badgeText()).toContain('正式環境');
        expect(mocks.refreshTradingStateForModeChange).toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok' }));

        await openMenu();
        const simOpt = find('env-option-simulation');
        expect(extractText(simOpt)).toContain('Environment = SIMULATION');
        await click(simOpt);
        expect(esunTradeService.getEnvironment()).toBe('SIMULATION');
        expect(badgeText()).toContain('模擬環境');
    });

    it('切換進行中鎖定選項，連點不會送出第二個請求', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        await esunTradeService.switchEnvironment('PRODUCTION');
        let resolve!: (v: any) => void;
        const spy = vi.spyOn(esunTradeService, 'switchEnvironment').mockImplementation(
            () => new Promise((r) => { resolve = r; }),
        );
        await render();
        await openMenu();
        await act(async () => {
            find('env-option-simulation').props.onClick();
        });
        expect(find('env-option-simulation').props.disabled).toBe(true);
        expect(find('env-option-production').props.disabled).toBe(true);
        await act(async () => {
            find('env-option-simulation').props.onClick();
        });
        expect(spy).toHaveBeenCalledTimes(1);
        await act(async () => {
            resolve({ ok: false, environment: 'PRODUCTION', entry: '', bridgeUpdated: false, error: 'bridge 忙碌' });
        });
    });

    it('switchEnvironment 回傳 ok:false 時顯示失敗、徽章不變', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        await esunTradeService.switchEnvironment('PRODUCTION');
        vi.spyOn(esunTradeService, 'switchEnvironment').mockResolvedValue({
            ok: false,
            environment: 'PRODUCTION',
            entry: '',
            bridgeUpdated: false,
            error: '未提供 esun-config.simulation.ini',
        });
        await render();
        await openMenu();
        await click(find('env-option-simulation'));
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', body: '未提供 esun-config.simulation.ini' }));
        expect(badgeText()).toContain('正式環境');
        expect(mocks.refreshTradingStateForModeChange).not.toHaveBeenCalled();
    });

    it('bridge 回 HTTP 400 時不得顯示「模擬」（以實際 HttpEsunDriver 驗證）', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        await esunTradeService.switchEnvironment('PRODUCTION');
        const fetch400 = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '未提供 esun-config.simulation.ini 設定檔' }), { status: 400 }));
        esunTradeService.setDriver(new HttpEsunDriver('', fetch400 as any));
        await render();
        expect(badgeText()).toContain('正式環境');
        await openMenu();
        await click(find('env-option-simulation'));
        expect(fetch400).toHaveBeenCalled();
        expect(badgeText()).not.toContain('模擬');
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err' }));
    });

    it('可直接在選單切換股票帳號到玉山，並給出成功回饋', async () => {
        await render();
        expect(badgeText()).toContain('永豐');
        await openMenu();
        const menu = find('header-env-menu');
        const target = menu.findAllByType('button').find((el) => extractText(el).includes(esunAccount.account_id));
        expect(target).toBeDefined();
        await click(target!);
        await act(async () => {
            view?.update(createElement(HeaderEnvMenu, { onOpenServerManager: vi.fn() }));
        });
        expect(badgeText()).toContain('玉山');
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ok', title: '帳號切換' }));
        expect(mocks.refreshTradingState).toHaveBeenCalledWith('all');
    });

    it('未簽署帳號在正式模式下停用並標示，點擊時回饋失敗而不重新整理查詢', async () => {
        mocks.serverInfo = { simulation: false };
        mockAccounts = [sinopacAccount, unsignedSinopac, esunAccount];
        await render();
        await openMenu();
        const menu = find('header-env-menu');
        const btn = menu.findAllByType('button').find((el) => extractText(el).includes(unsignedSinopac.account_id))!;
        expect(btn.props.disabled).toBe(true);
        expect(extractText(btn)).toContain('未簽署');
        await click(btn);
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', title: '無法切換帳號' }));
        expect(mocks.refreshTradingState).not.toHaveBeenCalled();
        expect(mockSelectedStock).toBe(sinopacAccount);
    });

    it('沒有玉山帳號時不捏造帳號，只提供連線 bridge', async () => {
        mockAccounts = [sinopacAccount];
        bridge = null;
        await render();
        await openMenu();
        const link = find('esun-link-bridge');
        expect(extractText(link)).toContain('連線玉山 bridge');
        await click(link);
        expect(esunTradeService.connectBridge).toHaveBeenCalled();
        expect(mockAccounts).toEqual([sinopacAccount]);
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err' }));
    });

    it('缺少正式設定檔時停用正式選項', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        esunTradeService.setConfigProfiles({
            ...PROFILES,
            PRODUCTION: { ...PROFILES.PRODUCTION, available: false, fileName: null },
        }, 'esun-config.simulation.ini');
        await render();
        await openMenu();
        const prodOpt = find('env-option-production');
        expect(prodOpt.props.disabled).toBe(true);
        expect(prodOpt.props['aria-disabled']).toBe(true);
        expect(extractText(prodOpt)).toContain('未提供設定檔 (不可選)');
        expect(extractText(prodOpt)).toContain('esun-config.production.ini');
        await click(prodOpt);
        expect(findAll('env-confirm-production-box')).toHaveLength(0);
        expect(esunTradeService.getEnvironment()).toBe('SIMULATION');
    });

    it('缺少模擬設定檔時停用模擬選項', async () => {
        mockSelectedStock = esunAccount; mockSelectedAccount = esunAccount;
        esunTradeService.setConfigProfiles({
            ...PROFILES,
            SIMULATION: { ...PROFILES.SIMULATION, available: false, fileName: null },
        }, 'esun-config.production.ini');
        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
        await render();
        await openMenu();
        const simOpt = find('env-option-simulation');
        expect(simOpt.props.disabled).toBe(true);
        expect(extractText(simOpt)).toContain('未提供設定檔 (不可選)');
        expect(extractText(simOpt)).toContain('esun-config.simulation.ini');
        await click(simOpt);
        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
    });

    it('選單為 dialog 語意，徽章宣告 aria-haspopup=dialog', async () => {
        await render();
        expect(find('header-env-badge').props['aria-haspopup']).toBe('dialog');
        await openMenu();
        expect(find('header-env-menu').props.role).toBe('dialog');
        expect(find('header-env-badge').props['aria-expanded']).toBe(true);
    });
});

describe('HudHeader 掛載 HeaderEnvMenu', () => {
    it('頂欄渲染環境徽章', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.serverInfo = { simulation: true };
        mocks.fetchInfo.mockResolvedValue({ simulation: true });
        mockAccounts = [sinopacAccount];
        mockSelectedStock = sinopacAccount; mockSelectedAccount = sinopacAccount;
        vi.spyOn(esunTradeService, 'connectBridge').mockResolvedValue(null);
        let view: ReactTestRenderer | undefined;
        await act(async () => {
            view = create(createElement(HudHeader, {
                profiles: [],
                currentWorkspace: { id: 'default', name: '預設', tabs: [], blocks: [], layout: [] } as any,
                onOpenPanelLibrary: vi.fn(),
                onSaveProfile: vi.fn(),
                onLoadProfile: vi.fn(),
                onDeleteProfile: vi.fn(),
                onRenameProfile: vi.fn(),
                onResetWorkspace: vi.fn(),
                onLoadPreset: vi.fn(),
            } as any));
        });
        const badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(extractText(badge)).toContain('永豐');
        expect(extractText(badge)).toContain('模擬環境');
        await act(async () => view!.unmount());
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
});

describe('describeRoutes', () => {
    it('沒有任何帳號時列出永豐證券預設路由', () => {
        const routes = describeRoutes({ accounts: [], selectedStock: null, selectedFutures: null, sinopacEnv: 'unknown', esunEnv: 'sim' });
        expect(routes).toEqual([{ market: 'S', broker: 'sinopac', account: null, env: 'unknown' }]);
        expect(overallEnv(routes)).toBe('unknown');
        expect(routesLabel(routes)).toBe('永豐 環境未知');
    });

    it('有期貨帳號但未選取時，期貨路由由永豐伺服器預設帳號承接', () => {
        const routes = describeRoutes({
            accounts: [esunAccount, sinopacFutures],
            selectedStock: esunAccount,
            selectedFutures: null,
            sinopacEnv: 'prod',
            esunEnv: 'sim',
        });
        expect(routes.map((r) => [r.market, r.broker, r.env])).toEqual([
            ['S', 'esun', 'sim'],
            ['F', 'sinopac', 'prod'],
        ]);
        expect(overallEnv(routes)).toBe('prod');
        expect(routesLabel(routes)).toBe('證 玉山 模擬 ｜ 期 永豐 正式');
    });
});
