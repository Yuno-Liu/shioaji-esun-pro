// src/components/hud-header-env.test.tsx — Unit & component tests for Header Environment Detection & Switcher

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { storage } = vi.hoisted(() => {
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
    return { storage };
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

const esunAccount: Account = {
    account_type: 'S',
    broker_id: ESUN_BROKER_CODE,
    account_id: '0664718',
    signed: true,
    username: '玉山證券',
    person_id: 'A123456789',
};

let mockAccounts: Account[] = [sinopacAccount, esunAccount];
let mockSelectedStock: Account | null = sinopacAccount;
let mockSelectedFutures: Account | null = null;
const listeners = new Set<() => void>();

vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({
        accounts: mockAccounts,
        selectedStock: mockSelectedStock,
        selectedFutures: mockSelectedFutures,
    }),
    selectAccount: (acc: Account) => {
        if (acc.account_type === 'S') mockSelectedStock = acc;
        else mockSelectedFutures = acc;
        listeners.forEach((l) => l());
    },
    ensureAccounts: vi.fn(),
    registerExternalAccounts: (ext: Account[]) => {
        for (const a of ext) {
            if (!mockAccounts.some(ma => ma.broker_id === a.broker_id && ma.account_id === a.account_id)) {
                mockAccounts.push(a);
            }
        }
        listeners.forEach((l) => l());
    },
    getAccountState: () => ({
        accounts: mockAccounts,
        selectedStock: mockSelectedStock,
        selectedFutures: mockSelectedFutures,
    }),
}));

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
    fetchInfo: async () => ({ simulation: true }),
}));

import { esunTradeService } from '../lib/esun';
import { HudHeader } from './hud-header';

function extractText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(extractText).join(' ');
    if (node.children) return extractText(node.children);
    return '';
}

describe('HudHeader Environment Detection & Switcher', () => {
    let view: ReactTestRenderer | undefined;

    const baseProps = {
        profiles: [],
        currentWorkspace: { id: 'default', name: '預設', tabs: [], blocks: [], layout: [] },
        onOpenPanelLibrary: vi.fn(),
        onSaveProfile: vi.fn(),
        onLoadProfile: vi.fn(),
        onDeleteProfile: vi.fn(),
        onRenameProfile: vi.fn(),
        onResetWorkspace: vi.fn(),
        onLoadPreset: vi.fn(),
    };

    beforeEach(async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mockAccounts = [sinopacAccount, esunAccount];
        mockSelectedStock = sinopacAccount;
        mockSelectedFutures = null;
        await esunTradeService.switchEnvironment('SIMULATION');
    });

    afterEach(async () => {
        if (view) {
            await act(async () => {
                view?.unmount();
            });
            view = undefined;
        }
        vi.unstubAllGlobals();
    });

    it('displays Sinopac broker tag and environment when Sinopac account is active', async () => {
        mockSelectedStock = sinopacAccount;

        await act(async () => {
            view = create(createElement(HudHeader, baseProps));
        });

        const badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(badge).toBeDefined();

        const badgeText = extractText(badge);
        expect(badgeText).toContain('永豐');
        expect(badgeText).toContain('模擬環境');
    });

    it('automatically switches to reflect Esun environment when Esun account is selected', async () => {
        mockSelectedStock = esunAccount;
        await esunTradeService.switchEnvironment('SIMULATION');

        await act(async () => {
            view = create(createElement(HudHeader, baseProps));
        });

        const badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        const badgeText = extractText(badge);
        expect(badgeText).toContain('玉山');
        expect(badgeText).toContain('模擬環境');
    });

    it('opens switcher menu on badge click and switches Esun to PRODUCTION and back to SIMULATION', async () => {
        mockSelectedStock = esunAccount;
        await esunTradeService.switchEnvironment('SIMULATION');

        await act(async () => {
            view = create(createElement(HudHeader, baseProps));
        });

        const badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });

        // 1. Click to open menu
        await act(async () => {
            badge.props.onClick();
        });

        const menu = view!.root.findByProps({ 'data-testid': 'header-env-menu' });
        expect(menu).toBeDefined();

        // 2. Click PRODUCTION option
        const prodOpt = view!.root.findByProps({ 'data-testid': 'env-option-production' });
        expect(extractText(prodOpt)).toContain('無 Environment 資訊 (僅 Entry)');
        expect(extractText(prodOpt)).toContain('https://esuntradingapi.esunsec.com.tw/api/v1');

        await act(async () => {
            await prodOpt.props.onClick();
        });

        expect(esunTradeService.getEnvironment()).toBe('PRODUCTION');
        expect(esunTradeService.isSimulation()).toBe(false);

        // Badge should now show 正式環境
        const updatedBadge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(extractText(updatedBadge)).toContain('正式環境');

        // 3. Re-open menu and click SIMULATION option
        await act(async () => {
            updatedBadge.props.onClick();
        });

        const simOpt = view!.root.findByProps({ 'data-testid': 'env-option-simulation' });
        expect(extractText(simOpt)).toContain('Environment = SIMULATION');
        expect(extractText(simOpt)).toContain('https://esuntradingapi-simulation.esunsec.com.tw/api/v1');

        await act(async () => {
            await simOpt.props.onClick();
        });

        expect(esunTradeService.getEnvironment()).toBe('SIMULATION');
        expect(esunTradeService.isSimulation()).toBe(true);

        const badgeAfter = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(extractText(badgeAfter)).toContain('模擬環境');
    });

    it('allows switching active account between Sinopac and Esun directly from the menu', async () => {
        mockSelectedStock = sinopacAccount;

        await act(async () => {
            view = create(createElement(HudHeader, baseProps));
        });

        // Initially Sinopac
        let badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(extractText(badge)).toContain('永豐');

        // Open menu
        await act(async () => {
            badge.props.onClick();
        });

        // Find the account button for Esun
        const menu = view!.root.findByProps({ 'data-testid': 'header-env-menu' });
        const allButtons = menu.findAllByType('button');
        const accountButtons = allButtons.filter((el) => extractText(el).includes('0664718'));
        expect(accountButtons.length).toBeGreaterThan(0);

        // Click to switch account to Esun
        await act(async () => {
            accountButtons[0]?.props.onClick();
        });

        // Re-render with new selection
        await act(async () => {
            view?.update(createElement(HudHeader, baseProps));
        });

        badge = view!.root.findByProps({ 'data-testid': 'header-env-badge' });
        expect(extractText(badge)).toContain('玉山');
    });
});
