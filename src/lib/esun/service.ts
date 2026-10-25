// src/lib/esun/service.ts — E.SUN Securities trading and portfolio service manager
//
// 環境與 session 一律以 esun-bridge 回報為準（health、環境切換回應、SSE session 事件）：
// - 本地只保存「目前看到的 bridge 狀態」快照；切換失敗或 bridge 離線時不改本地環境。
// - 玉山帳戶鍵含環境（模擬帳戶 broker_id 加 -SIM），每筆委託帶 expected_environment／
//   expected_account，bridge 環境已被其他視窗或裝置切換時回 409（確定未送出）。
// - 委託回應只回報「已送出」；刪單、改價、改量的實際結果交給回讀與回報確認。

import { useSyncExternalStore } from 'react';
import type { ContractBase } from '../types/contract';
import type { OrderResult, OrderStatusInfo, StockOrderReq, Trade } from '../types/order';
import type { Account, AccountBalance, StockPosition } from '../types/portfolio';
import { getAccountState, replaceExternalAccountsForBroker } from '../account-store';
import { getCachedContract } from '../contracts-cache';
import { isOddLot, ODD_LOT_NO_PRICE_UPDATE } from '../odd-lot';
import type {
    Settlement,
    StockProfitLoss,
    ProfitLossSummaryTotal,
    TradingLimits,
    ReserveStocksSummary,
} from '../shioaji';
import type { IEsunTradeDriver, EsunBridgeHealth } from './adapter';
import { MockEsunDriver } from './mock-driver';
import {
    esunAccountForEnvironment,
    esunApCodeFor,
    esunEnvironmentOfAccount,
    esunOrderId,
    esunQuantityUnitFor,
    esunRetCode,
    esunRetMessage,
    formatEsunErrorMessage,
    fromEsunInventoryToPosition,
    fromEsunOrderResponse,
    fromEsunOrderResult,
    fromEsunTransactionsToProfitLoss,
    isEsunAccount,
    sortEsunOrderResultsOldestFirst,
    isEsunBroker,
    isEsunFailureCode,
    toEsunMutationPayload,
    toEsunOrderPayload,
    validateEsunOrderPriceMutation,
    validateEsunOrderQtyMutation,
    validateEsunStockOrder,
} from './order-mapping';
import {
    ESUN_BROKER_CODE,
    ESUN_PRODUCTION_ENTRY,
    ESUN_SIMULATION_ENTRY,
    type EsunEnvironment,
    type EsunConfigProfilesMap,
    type EsunMutationGuard,
    type EsunOrderResult,
    type EsunSessionInfo,
    createDefaultEsunConfigProfiles,
} from './types';
import { HttpEsunDriver, UnavailableEsunDriver } from './http-driver';
import {
    parseEsunBalanceDetail,
    parseEsunInventoryDetails,
    parseEsunMarketStatusDetail,
    parseEsunRealizedTransactionDetails,
    parseEsunTradeStatusDetail,
    setEsunInventoryDetails,
    setEsunOrderMetaSnapshot,
    setEsunTransactionDetails,
    type EsunAccountOverview,
} from './account-details';

/** esun-bridge 位址：預設同源（由 Vite proxy / Docker 轉發 /esun） */
export function bridgeBase(): string {
    try {
        return String((import.meta as any).env?.VITE_ESUN_BRIDGE_BASE ?? '').replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function mutationNotStartedError(message: string): Error & { mutationNotStarted: true } {
    return Object.assign(new Error(message), {
        mutationNotStarted: true as const,
    });
}

function outcomeUnknownError(message: string): Error & { mutationOutcomeUnknown: true; orderOutcomeUnknown: true } {
    return Object.assign(new Error(message), {
        mutationOutcomeUnknown: true as const,
        orderOutcomeUnknown: true as const,
    });
}

const ENV_LABEL: Record<EsunEnvironment, string> = { SIMULATION: '模擬環境', PRODUCTION: '正式環境' };
const ENV_STORAGE_KEY = 'esun_trading_environment';
const MISMATCH_CODES = new Set(['ESUN_ENV_MISMATCH', 'ESUN_ACCOUNT_MISMATCH']);

function defaultDriver(): IEsunTradeDriver {
    try {
        const env = (import.meta as any).env;
        if (env?.VITE_ESUN_DRIVER === 'mock') return new MockEsunDriver();
    } catch {
        // non-vite environment
    }
    return new UnavailableEsunDriver();
}

const entryFor = (env: EsunEnvironment) => env === 'SIMULATION' ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY;
const isEnv = (v: unknown): v is EsunEnvironment => v === 'SIMULATION' || v === 'PRODUCTION';
const sameAccount = (a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'>, b: Pick<Account, 'account_type' | 'broker_id' | 'account_id'>) =>
    a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id;

/** bridge 回報的狀態（health、切換回應、session 事件的共同欄位） */
interface BridgeState {
    environment?: EsunEnvironment | string | null;
    entry?: string | null;
    activeConfigFile?: string | null;
    configProfiles?: Partial<EsunConfigProfilesMap>;
    account?: { broker_id: string; account_id: string } | null;
    sessionGeneration?: number | null;
    accounts?: Account[];
}

export interface EsunSwitchResult {
    ok: boolean;
    environment: EsunEnvironment;
    entry: string;
    bridgeUpdated: boolean;
    account?: { broker_id: string; account_id: string } | null;
    activeConfigFile?: string | null;
    availableEnvironments?: EsunEnvironment[];
    configProfiles?: EsunConfigProfilesMap;
    error?: string;
}

export interface EsunEnvironmentSnapshot {
    environment: EsunEnvironment;
    isSimulation: boolean;
    entry: string;
    activeConfigFile: string | null;
    configProfiles: EsunConfigProfilesMap;
    availableEnvironments: EsunEnvironment[];
    /** bridge 已回報目前環境；false 時畫面應顯示「未知」，不可預設為模擬 */
    environmentKnown: boolean;
    /** 環境切換進行中（選單應鎖定） */
    switching: boolean;
    /** bridge session 代次（未知為 null） */
    sessionGeneration: number | null;
    /** 已連上 esun-bridge */
    bridgeConnected: boolean;
}

/** 重新連線（POST /esun/auth/reconnect）的結果 */
export interface EsunReconnectResult {
    ok: boolean;
    /**
     * 重新連線後重新讀取的 health。失敗時讀不到則為最後看到的 health；
     * 成功但讀不到時為 null（舊的 health 仍是失效狀態，不可沿用；呼叫端應顯示「狀態確認中」並稍後重讀）
     */
    health: EsunBridgeHealth | null;
    environment?: EsunEnvironment | null;
    sessionGeneration?: number | null;
    error?: string;
    /** bridge 錯誤碼（例：LOGIN_FAILED、ESUN_SESSION_BUSY、CONFIG_ERROR） */
    code?: string;
}

type DispatchOpts = { beforeDispatch?: () => void };

export class EsunTradeService {
    private driver: IEsunTradeDriver;
    private accounts: Account[] = [];
    private bridgeProbe: Promise<EsunBridgeHealth | null> | null = null;
    private bridgeHealth: EsunBridgeHealth | null = null;
    private environment: EsunEnvironment = 'SIMULATION';
    private environmentKnown = false;
    private sessionGeneration: number | null = null;
    private entryUrl: string = ESUN_SIMULATION_ENTRY;
    private configProfiles: EsunConfigProfilesMap = createDefaultEsunConfigProfiles(true, true);
    private activeConfigFile: string | null = null;
    private switchInFlight: Promise<EsunSwitchResult> | null = null;
    private reconnectInFlight: Promise<EsunReconnectResult> | null = null;
    // 每次採用切換／session 結果就 +1：在那之前發出的 health 回應（沒有代次可比時）一律丟棄
    private stateVersion = 0;
    private listeners = new Set<() => void>();
    private snapshot!: EsunEnvironmentSnapshot;

    constructor(initialDriver?: IEsunTradeDriver) {
        this.driver = initialDriver ?? defaultDriver();
        try {
            // 只是上次看到的環境（顯示用提示），不代表 bridge 目前的環境：environmentKnown 仍為 false
            const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(ENV_STORAGE_KEY) : null;
            if (isEnv(saved)) {
                this.environment = saved;
                this.entryUrl = entryFor(saved);
            }
        } catch {
            // ignore
        }
        this.updateSnapshot();
    }

    /**
     * 連線 esun-bridge（同源 /esun/*）：成功即改用 HttpEsunDriver 並註冊玉山帳戶。
     * 成功結果快取；失敗時保留 fail-closed 驅動，下一次呼叫會重新探測。
     */
    connectBridge(driver: HttpEsunDriver = new HttpEsunDriver(bridgeBase())): Promise<EsunBridgeHealth | null> {
        if (!this.bridgeProbe) {
            this.bridgeProbe = (async () => {
                const version = this.stateVersion;
                try {
                    const health = await driver.health(3_000);
                    let accounts: Account[] = [];
                    try {
                        accounts = await driver.accounts(3_000);
                    } catch {
                        // ignore accounts query error if driver.health succeeded
                    }
                    this.bridgeHealth = health;
                    this.setDriver(driver);
                    this.applyBridgeState({ ...health, accounts }, version);
                    if (!health.configured || health.loginError) {
                        console.warn(
                            '[esun] esun-bridge 已連線但尚未可下單：',
                            health.loginError ?? (health.problems ?? []).join('；'),
                        );
                    }
                    this.updateSnapshot();
                    this.emit();
                    return health;
                } catch {
                    this.bridgeProbe = null;
                    return null;
                }
            })();
        }
        return this.bridgeProbe;
    }

    private computeSnapshot(): EsunEnvironmentSnapshot {
        return {
            environment: this.environment,
            isSimulation: this.environment === 'SIMULATION',
            entry: this.entryUrl,
            activeConfigFile: this.activeConfigFile,
            configProfiles: {
                SIMULATION: { ...this.configProfiles.SIMULATION },
                PRODUCTION: { ...this.configProfiles.PRODUCTION },
            },
            availableEnvironments: this.getAvailableEnvironments(),
            environmentKnown: this.environmentKnown,
            switching: this.switchInFlight !== null,
            sessionGeneration: this.sessionGeneration,
            bridgeConnected: this.driver.name === 'http-bridge' || this.bridgeHealth !== null,
        };
    }

    private updateSnapshot(): void {
        this.snapshot = this.computeSnapshot();
    }

    getSnapshot(): EsunEnvironmentSnapshot {
        return this.snapshot;
    }

    getConfigProfiles(): EsunConfigProfilesMap {
        return {
            SIMULATION: { ...this.configProfiles.SIMULATION },
            PRODUCTION: { ...this.configProfiles.PRODUCTION },
        };
    }

    getAvailableEnvironments(): EsunEnvironment[] {
        const envs: EsunEnvironment[] = [];
        if (this.configProfiles.SIMULATION?.available) envs.push('SIMULATION');
        if (this.configProfiles.PRODUCTION?.available) envs.push('PRODUCTION');
        return envs;
    }

    getActiveConfigFile(): string | null {
        return this.activeConfigFile;
    }

    isEnvironmentAvailable(env: EsunEnvironment): boolean {
        return Boolean(this.configProfiles[env]?.available);
    }

    /** bridge 已回報目前環境 */
    isEnvironmentKnown(): boolean {
        return this.environmentKnown;
    }

    /** 最後看到的 bridge session 代次 */
    getSessionGeneration(): number | null {
        return this.sessionGeneration;
    }

    setConfigProfiles(profiles: Partial<EsunConfigProfilesMap>, activeConfigFile?: string | null): void {
        this.mergeConfigProfiles(profiles, activeConfigFile);
        this.updateSnapshot();
        this.emit();
    }

    private mergeConfigProfiles(profiles: Partial<EsunConfigProfilesMap>, activeConfigFile?: string | null): void {
        if (profiles.SIMULATION) {
            this.configProfiles.SIMULATION = { ...this.configProfiles.SIMULATION, ...profiles.SIMULATION };
        }
        if (profiles.PRODUCTION) {
            this.configProfiles.PRODUCTION = { ...this.configProfiles.PRODUCTION, ...profiles.PRODUCTION };
        }
        if (activeConfigFile !== undefined) {
            this.activeConfigFile = activeConfigFile;
        }

        // 尚未得知 bridge 環境時，顯示用的預設環境跟著可用設定檔走；
        // bridge 已回報環境後只以 bridge 為準（設定檔偵測絕不改寫目前環境）
        if (!this.environmentKnown && !this.configProfiles[this.environment]?.available) {
            const other: EsunEnvironment = this.environment === 'SIMULATION' ? 'PRODUCTION' : 'SIMULATION';
            if (this.configProfiles[other]?.available) {
                this.environment = other;
                this.entryUrl = entryFor(other);
                if (!this.activeConfigFile) {
                    this.activeConfigFile = this.configProfiles[other]?.fileName;
                }
            }
        }
    }

    /**
     * 採用 bridge 回報的狀態。`version`：請求開始時的 stateVersion；有 session 代次時
     * 以代次判斷新舊，沒有代次時，請求期間若已採用過切換／session 結果就丟棄這份回應。
     */
    private applyBridgeState(state: BridgeState, version: number | null): boolean {
        const generation = typeof state.sessionGeneration === 'number' ? state.sessionGeneration : null;
        if (generation !== null && this.sessionGeneration !== null) {
            if (generation < this.sessionGeneration) return false;
        } else if (version !== null && version !== this.stateVersion) {
            return false;
        }
        if (state.configProfiles) this.mergeConfigProfiles(state.configProfiles, state.activeConfigFile);
        else if (state.activeConfigFile !== undefined) this.activeConfigFile = state.activeConfigFile;
        if (generation !== null) this.sessionGeneration = generation;
        const env = isEnv(state.environment) ? state.environment : null;
        if (!env) {
            // bridge 不知道自己的環境（未設定）：不能替玉山帳戶指定環境，全部撤下
            if (state.environment === null) {
                this.environmentKnown = false;
                this.setEsunAccounts([]);
            }
            return true;
        }
        this.environment = env;
        this.environmentKnown = true;
        this.entryUrl = state.entry || entryFor(env);
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(ENV_STORAGE_KEY, env);
        } catch {
            // ignore
        }
        const listed = (state.accounts ?? []).filter(a => a && a.account_id);
        const fromBridge = listed.length > 0
            ? listed.map(a => esunAccountForEnvironment(a, env))
            : state.account?.account_id ? [esunAccountForEnvironment(state.account, env)] : null;
        if (fromBridge) {
            // 同一個帳號在 /esun/accounts 已有完整資料（person_id）時沿用
            const merged = fromBridge.map(a => this.accounts.find(old => sameAccount(old, a) && old.person_id) ?? a);
            this.setEsunAccounts(merged);
        } else if (this.accounts.some(a => esunEnvironmentOfAccount(a) !== env)) {
            // 換了環境但這次沒有帳號資訊：舊環境的帳戶一律撤下
            this.setEsunAccounts(this.accounts.filter(a => esunEnvironmentOfAccount(a) === env));
        }
        return true;
    }

    /** 替換玉山帳戶，並同步到帳戶清單（帳戶清單已載入永豐帳戶時才同步，避免改變預設選取） */
    private setEsunAccounts(next: Account[]): void {
        const key = (list: Account[]) => list.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}:${a.person_id}`).join('|');
        if (key(next) === key(this.accounts)) return;
        this.accounts = [...next];
        syncEsunAccountsToStore(this.accounts);
    }

    /** 重新讀取 bridge health 並採用（例如 409 環境不符、SSE 重連、切換後確認） */
    async refreshHealth(timeoutMs = 3_000): Promise<EsunBridgeHealth | null> {
        if (!this.driver.health) {
            return this.connectBridge();
        }
        const version = this.stateVersion;
        try {
            const health = await this.driver.health(timeoutMs);
            this.bridgeHealth = health;
            if (this.applyBridgeState(health, version)) {
                this.updateSnapshot();
                this.emit();
            }
            return health;
        } catch {
            return null;
        }
    }

    async refreshConfigProfiles(): Promise<EsunConfigProfilesMap> {
        await this.refreshHealth(2_000);
        return this.getConfigProfiles();
    }

    /** SSE `session` 事件：bridge 登入／切換／登出後的 session 狀態 */
    applySession(info: EsunSessionInfo): void {
        const env = isEnv(info.environment) ? info.environment : null;
        const generation = typeof info.generation === 'number' ? info.generation : null;
        const state: BridgeState = {
            ...(env || info.environment === null ? { environment: env } : {}),
            ...(info.account !== undefined ? { account: info.account } : {}),
            sessionGeneration: generation,
        };
        if (generation === null || this.sessionGeneration === null || generation >= this.sessionGeneration) {
            if (env !== null || info.environment === null) this.stateVersion++;
            if (this.applyBridgeState(state, null)) {
                this.updateSnapshot();
                this.emit();
            }
        }
        // 事件只帶摘要：再讀一次 health 取完整狀態（設定檔、帳號 person_id）
        void this.refreshHealth();
    }

    getEnvironment(): EsunEnvironment {
        return this.environment;
    }

    getEntryUrl(): string {
        return this.entryUrl;
    }

    isSimulation(): boolean {
        return this.environment === 'SIMULATION';
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(): void {
        this.listeners.forEach((l) => l());
    }

    private switchResult(ok: boolean, extra: Partial<EsunSwitchResult> = {}): EsunSwitchResult {
        return {
            ok,
            environment: this.environment,
            entry: this.entryUrl,
            bridgeUpdated: ok,
            activeConfigFile: this.activeConfigFile,
            availableEnvironments: this.getAvailableEnvironments(),
            configProfiles: this.getConfigProfiles(),
            ...extra,
        };
    }

    /**
     * 切換 bridge 的交易環境。只有 bridge 明確回報成功且環境等於目標時才更新本地狀態；
     * 任何錯誤（離線、逾時、HTTP 4xx/5xx、環境不符）都回 ok:false 並保留原環境。
     * 同一時間只允許一個切換。
     */
    switchEnvironment(targetEnv: EsunEnvironment): Promise<EsunSwitchResult> {
        if (!this.isEnvironmentAvailable(targetEnv)) {
            const expected = this.configProfiles[targetEnv]?.expectedFileName || `esun-config.${targetEnv.toLowerCase()}.ini`;
            return Promise.resolve(this.switchResult(false, { error: `未提供 ${expected} 設定檔，無法切換至 ${targetEnv}` }));
        }
        if (this.switchInFlight) {
            return Promise.resolve(this.switchResult(false, { error: '玉山環境切換進行中，請稍候' }));
        }
        if (this.reconnectInFlight) {
            return Promise.resolve(this.switchResult(false, { error: '玉山重新連線進行中，請稍候再切換環境' }));
        }
        const driver = this.driver;
        if (!driver.switchEnvironment) {
            return Promise.resolve(this.switchResult(false, { error: '玉山下單服務 (esun-bridge) 未連線，無法切換環境' }));
        }
        const run = (async (): Promise<EsunSwitchResult> => {
            let res: Awaited<ReturnType<NonNullable<IEsunTradeDriver['switchEnvironment']>>>;
            try {
                res = await driver.switchEnvironment!(targetEnv);
            } catch (e) {
                void this.refreshHealth();
                return this.switchResult(false, { error: `玉山環境切換失敗：${e instanceof Error ? e.message : String(e)}` });
            }
            if (!res || res.ok === false) {
                void this.refreshHealth();
                return this.switchResult(false, { error: res?.error || res?.message || '玉山環境切換失敗' });
            }
            if (res.environment !== targetEnv) {
                void this.refreshHealth();
                return this.switchResult(false, {
                    error: `玉山 bridge 回報的環境（${res.environment ?? '未知'}）與要求的 ${targetEnv} 不符，未切換`,
                });
            }
            let accounts: Account[] = [];
            if (driver.accounts) {
                try {
                    accounts = await driver.accounts(2_000);
                } catch {
                    // 帳號清單讀取失敗：改用切換回應的帳號
                }
            }
            this.stateVersion++;
            const applied = this.applyBridgeState({
                environment: res.environment,
                entry: res.entry,
                activeConfigFile: res.activeConfigFile ?? this.configProfiles[targetEnv]?.fileName ?? null,
                configProfiles: res.configProfiles,
                account: res.account ?? null,
                sessionGeneration: typeof res.sessionGeneration === 'number' ? res.sessionGeneration : null,
                accounts,
            }, null);
            this.updateSnapshot();
            this.emit();
            // 以 bridge 的 health 最後確認一次（例如另一個視窗同時又切換）
            void this.refreshHealth();
            if (!applied) {
                // 切換回應的 session 代次比已採用的舊：bridge 已被其他操作改到更新的 session，不能回報成功
                return this.switchResult(false, { error: '玉山 bridge 已有更新的 session，這次切換結果未採用；請確認目前環境後再操作' });
            }
            return this.switchResult(true, { environment: res.environment, account: res.account ?? null });
        })();
        this.switchInFlight = run;
        this.updateSnapshot();
        this.emit();
        return run.finally(() => {
            this.switchInFlight = null;
            this.updateSnapshot();
            this.emit();
        });
    }

    /**
     * 以目前設定檔重新登入券商（台北換日 token 失效後）。成功後先採用回應的 session 代次
     * （trading-state 的 session 代次 hook 據此做委託權威重讀），再立即重新讀取 health；
     * 帳務查詢由呼叫端 invalidateAllQueries。失敗回 ok:false 與錯誤說明，不丟出。
     * 同一時間只有一個請求：進行中再呼叫會拿到同一個結果（不論 force）。
     * opts.force：登入熔斷鎖住且憑證未變時，bridge 回 423 ESUN_CREDENTIALS_UNCHANGED，
     * 只有使用者明確確認後才可帶 force:true 強制重試一次；其他情況一律不帶。
     */
    reconnect(opts?: { force?: boolean }): Promise<EsunReconnectResult> {
        if (this.reconnectInFlight) return this.reconnectInFlight;
        const driver = this.driver;
        if (!driver.reconnect) {
            return Promise.resolve({ ok: false, health: this.bridgeHealth, error: '玉山下單服務 (esun-bridge) 未連線，無法重新連線' });
        }
        if (this.switchInFlight) {
            return Promise.resolve({ ok: false, health: this.bridgeHealth, error: '玉山環境切換進行中，請稍候再重新連線', code: 'ESUN_SESSION_BUSY' });
        }
        const run = (async (): Promise<EsunReconnectResult> => {
            const failed = async (error: string, code?: string): Promise<EsunReconnectResult> => {
                const health = await this.refreshHealth();
                return { ok: false, health: health ?? this.bridgeHealth, error, ...(code ? { code } : {}) };
            };
            let res: Awaited<ReturnType<NonNullable<IEsunTradeDriver['reconnect']>>>;
            try {
                res = opts?.force === true ? await driver.reconnect!({ force: true }) : await driver.reconnect!();
            } catch (e) {
                const code = (e as { code?: unknown } | null)?.code;
                return failed(`玉山重新連線失敗：${e instanceof Error ? e.message : String(e)}`, typeof code === 'string' ? code : undefined);
            }
            if (!res || res.ok === false) {
                return failed(`玉山重新連線失敗：${res?.error || res?.message || '玉山 bridge 未回報成功'}`, res?.code);
            }
            // 先採用回應的 session 代次：即使接著讀 health 失敗，session 代次 hook 仍會觸發權威重讀
            if (typeof res.sessionGeneration === 'number'
                && this.applyBridgeState({ sessionGeneration: res.sessionGeneration }, null)) {
                this.updateSnapshot();
                this.emit();
            }
            const health = await this.refreshHealth(5_000);
            return {
                ok: true,
                // 讀不到 health 時回 null：舊的 health 仍是登入失效，沿用會與成功結果矛盾
                health,
                environment: isEnv(res.environment) ? res.environment : health && isEnv(health.environment) ? health.environment : null,
                sessionGeneration: typeof res.sessionGeneration === 'number' ? res.sessionGeneration : health?.sessionGeneration ?? null,
            };
        })();
        const pending = run.finally(() => {
            if (this.reconnectInFlight === pending) this.reconnectInFlight = null;
        });
        this.reconnectInFlight = pending;
        return pending;
    }

    /** 重新連線請求進行中 */
    isReconnecting(): boolean {
        return this.reconnectInFlight !== null;
    }

    /**
     * 註冊玉山帳戶。未指定時使用 bridge 回報的帳號（bridge 尚未回報則丟出錯誤，
     * 絕不捏造帳號）；以字串指定時套用目前 bridge 回報的環境。
     */
    registerEsunAccount(accountOrId?: string | Account): Account {
        if (accountOrId && typeof accountOrId !== 'string') {
            this.registerAccount(accountOrId);
            return accountOrId;
        }
        if (!accountOrId) {
            const known = this.accounts[0];
            if (!known) throw new Error('玉山下單服務尚未回報帳號，無法加入玉山帳戶；請先連線 esun-bridge');
            return known;
        }
        if (!this.environmentKnown) {
            throw new Error('玉山交易環境尚未確認（esun-bridge 未回報），無法加入玉山帳戶');
        }
        const raw = accountOrId.trim();
        let brokerId = ESUN_BROKER_CODE;
        let accountId = raw;
        if (raw.length === 11 && isEsunBroker(raw.slice(0, 4))) {
            brokerId = raw.slice(0, 4);
            accountId = raw.slice(4);
        }
        const acc = esunAccountForEnvironment({ broker_id: brokerId, account_id: accountId }, this.environment);
        this.registerAccount(acc);
        return acc;
    }

    getBridgeHealth(): EsunBridgeHealth | null {
        return this.bridgeHealth;
    }

    getDriver(): IEsunTradeDriver {
        return this.driver;
    }

    setDriver(driver: IEsunTradeDriver): void {
        this.driver = driver;
        this.updateSnapshot();
    }

    registerAccount(account: Account): void {
        if (!this.accounts.some(a => a.broker_id === account.broker_id && a.account_id === account.account_id)) {
            this.accounts.push(account);
        }
    }

    clearAccounts(): void {
        this.accounts = [];
    }

    getAccounts(): Account[] {
        return [...this.accounts];
    }

    /** 查詢憑證效期（失敗照常丟出，不回空字串假裝沒有憑證） */
    async fetchCaExpire(personId?: string): Promise<string> {
        if (!this.driver.getCaExpire) throw new Error('玉山下單服務未提供憑證效期查詢');
        const res = await this.driver.getCaExpire(personId);
        return res?.ca_expiretime || '';
    }

    /**
     * 每筆 mutation 的環境／帳號綁定：帳戶鍵決定預期環境（模擬帳戶帶 -SIM）。
     * 本地已知 bridge 目前在另一個環境時直接拒絕（確定未送出）；最後仍由 bridge 比對。
     */
    mutationGuard(account: Account): EsunMutationGuard {
        const expected = esunEnvironmentOfAccount(account);
        if (!expected) throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        if (this.environmentKnown && expected !== this.environment) {
            throw mutationNotStartedError(
                `玉山目前為${ENV_LABEL[this.environment]}，此帳戶屬於${ENV_LABEL[expected]}；這筆沒有送出，請確認環境後重新操作`,
            );
        }
        return { expected_environment: expected, expected_account: account.account_id };
    }

    /** bridge 回 409（環境或帳號不符）：重新同步環境快照並改寫成使用者看得懂的說明 */
    private explainMismatch(error: unknown): unknown {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code !== 'string' || !MISMATCH_CODES.has(code)) return error;
        void this.refreshHealth();
        const actual = (error as { environment?: unknown }).environment;
        const where = isEnv(actual) ? `已切換為${ENV_LABEL[actual]}` : '的環境或帳號已變更';
        const message = `玉山下單服務${where}（可能由其他視窗或裝置切換），這筆沒有送出；請確認畫面上的環境後重新操作`;
        return Object.assign(error as object, { message });
    }

    private runBeforeDispatch(opts?: DispatchOpts): void {
        try {
            opts?.beforeDispatch?.();
        } catch (e) {
            // 送出前被呼叫端擋下：確定沒有送出
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { mutationNotStarted: true as const });
        }
    }

    /** 送出玉山證券現貨委託 */
    async placeStockOrder(
        contract: ContractBase,
        order: StockOrderReq,
        account: Account,
        opts?: { beforeDispatch?: () => void; onResponse?: (res: Response) => void },
    ): Promise<Trade> {
        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const problem = validateEsunStockOrder(contract, order);
        if (problem) {
            throw mutationNotStartedError(problem);
        }

        const guard = this.mutationGuard(account);
        this.runBeforeDispatch(opts);

        const payload = toEsunOrderPayload(contract, order);
        let res: Awaited<ReturnType<IEsunTradeDriver['placeOrder']>>;
        try {
            res = await this.driver.placeOrder(payload, { guard });
        } catch (e) {
            throw this.explainMismatch(e);
        }

        const retCode = esunRetCode(res);
        if (isEsunFailureCode(retCode)) {
            // 券商明確拒單：委託沒有成立
            throw mutationNotStartedError(`玉山證券下單失敗：${formatEsunErrorMessage(retCode, esunRetMessage(res))}`);
        }
        if (!esunOrderId(res)) {
            // 已受理卻沒有委託編號：無法追蹤，結果視為未知（不可重送）
            throw outcomeUnknownError('玉山已回應下單請求但沒有委託編號，委託結果不確定；請先查詢委託，勿直接重送');
        }

        if (opts?.onResponse) {
            try {
                opts.onResponse(new Response(JSON.stringify(res), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }));
            } catch {
                // a display hook cannot fail an accepted order
            }
        }

        return fromEsunOrderResponse(res, contract, order, account);
    }

    /** 解析 Trade／(contract, order)／tradeId 三種呼叫形式 */
    private resolveTarget(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | Account | number,
        rest: unknown[],
        kind: 'cancel' | 'value',
    ): { trade: Trade; full: boolean; value?: number; account: Account; opts?: DispatchOpts } {
        const blankStatus = (order: OrderResult): OrderStatusInfo => ({
            id: order.id, status: 'Submitted', status_code: '', msg: '',
            order_quantity: order.quantity, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [],
        });
        const contractOnly: ContractBase = { code: '', security_type: 'STK', exchange: 'TSE', target_code: null };
        if (typeof arg1 === 'string') {
            const order: OrderResult = { id: arg1, seqno: arg1, ordno: arg1, action: 'Buy', price: 0, quantity: 0 };
            if (kind === 'cancel') return { trade: { contract: contractOnly, order, status: blankStatus(order) }, full: false, account: arg2 as Account, opts: rest[0] as DispatchOpts };
            return { trade: { contract: contractOnly, order, status: blankStatus(order) }, full: false, value: arg2 as number, account: rest[0] as Account, opts: rest[1] as DispatchOpts };
        }
        if ('contract' in arg1 && 'order' in arg1) {
            const trade = arg1 as Trade;
            if (kind === 'cancel') return { trade, full: true, account: arg2 as Account, opts: rest[0] as DispatchOpts };
            return { trade, full: true, value: arg2 as number, account: rest[0] as Account, opts: rest[1] as DispatchOpts };
        }
        const order = arg2 as OrderResult;
        const trade: Trade = { contract: arg1 as ContractBase, order, status: blankStatus(order) };
        if (kind === 'cancel') return { trade, full: false, account: rest[0] as Account, opts: rest[1] as DispatchOpts };
        return { trade, full: false, value: rest[0] as number, account: rest[1] as Account, opts: rest[2] as DispatchOpts };
    }

    /** 送出後只回報「已送出」：保留原委託狀態，不偽造成交、取消或改價結果 */
    private sentTrade(trade: Trade, res: Record<string, unknown>, msg: string): Trade {
        return {
            contract: trade.contract,
            order: trade.order,
            status: { ...trade.status, status_code: esunRetCode(res) ?? trade.status.status_code, msg },
        };
    }

    private orderNumber(order: OrderResult): string {
        return (order.ordno || order.id || order.seqno || '').trim();
    }

    /**
     * 刪單（刪除全部剩餘量）。HTTP 成功只代表「已送出」，回傳的 Trade 不是取消確認；
     * 呼叫端必須以同帳戶回讀（刪單確認）判定結果。
     * 支援 signatures:
     * - cancelOrder(tradeId, account, opts?)
     * - cancelOrder(contract, order, account, opts?)
     * - cancelOrder(trade, account, opts?)
     */
    async cancelOrder(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | Account,
        arg3?: Account | { beforeDispatch?: () => void },
        arg4?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        const { trade, full, account, opts } = this.resolveTarget(arg1, arg2, [arg3, arg4], 'cancel');

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = this.orderNumber(trade.order);
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法刪單');
        }

        const guard = this.mutationGuard(account);
        this.runBeforeDispatch(opts);

        let res: Awaited<ReturnType<IEsunTradeDriver['cancelOrder']>>;
        try {
            res = await this.driver.cancelOrder(ordNo, full ? toEsunMutationPayload(trade) : { stockNo: trade.contract.code }, { guard });
        } catch (e) {
            throw this.explainMismatch(e);
        }

        const retCode = esunRetCode(res);
        if (isEsunFailureCode(retCode)) {
            throw mutationNotStartedError(`玉山證券刪單失敗：${formatEsunErrorMessage(retCode, esunRetMessage(res))}`);
        }

        return this.sentTrade(trade, res, '刪單已送出，等待回報或回讀確認');
    }

    /**
     * 修改委託價格（ROD 限價、非預約單、非零股）。回傳的 Trade 只代表「已送出」。
     * 支援 signatures:
     * - updateOrderPrice(tradeId, price, account, opts?)
     * - updateOrderPrice(contract, order, price, account, opts?)
     * - updateOrderPrice(trade, price, account, opts?)
     */
    async updateOrderPrice(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | number,
        arg3: number | Account,
        arg4?: Account | { beforeDispatch?: () => void },
        arg5?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        const target = this.resolveTarget(arg1, arg2, [arg3, arg4, arg5], 'value');
        const { trade, full, account, opts } = target;
        const newPrice = target.value as number;

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = this.orderNumber(trade.order);
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法改價');
        }

        if (isOddLot(trade.order.order_lot)) {
            throw mutationNotStartedError(ODD_LOT_NO_PRICE_UPDATE);
        }
        if (full) {
            const validationErr = validateEsunOrderPriceMutation(trade, newPrice);
            if (validationErr) {
                throw mutationNotStartedError(validationErr);
            }
        } else {
            if (trade.order.order_type && trade.order.order_type !== 'ROD') {
                throw mutationNotStartedError('玉山證券僅支援 ROD 限價單改價');
            }
            if (trade.order.price_type && trade.order.price_type !== 'LMT') {
                throw mutationNotStartedError('玉山證券僅支援 ROD 限價單改價');
            }
            if (!Number.isFinite(newPrice) || newPrice <= 0) {
                throw mutationNotStartedError('改價需要大於 0 的有效價格');
            }
        }

        const guard = this.mutationGuard(account);
        this.runBeforeDispatch(opts);

        let res: Awaited<ReturnType<IEsunTradeDriver['replacePrice']>>;
        try {
            res = await this.driver.replacePrice(ordNo, newPrice, full ? toEsunMutationPayload(trade) : { stockNo: trade.contract.code }, { guard });
        } catch (e) {
            throw this.explainMismatch(e);
        }

        const retCode = esunRetCode(res);
        if (isEsunFailureCode(retCode)) {
            throw mutationNotStartedError(`玉山證券改價失敗：${formatEsunErrorMessage(retCode, esunRetMessage(res))}`);
        }

        return this.sentTrade(trade, res, `改價 ${newPrice} 已送出，等待回報確認`);
    }

    /**
     * 減量：第二個數值參數是「減少量」（與上游 updateOrderQty 相同語意，委託列以
     * 「目前剩餘 − 新剩餘」呼叫），必須 0 < 減少量 ≤ 剩餘量；單位為 App 單位
     * （整股／盤後為張，零股為股），送 bridge 時附 quantity_unit。回傳的 Trade 只代表「已送出」。
     * 支援 signatures:
     * - updateOrderQty(tradeId, reduction, account, opts?)
     * - updateOrderQty(contract, order, reduction, account, opts?)
     * - updateOrderQty(trade, reduction, account, opts?)
     */
    async updateOrderQty(
        arg1: ContractBase | string | Trade,
        arg2: OrderResult | number,
        arg3: number | Account,
        arg4?: Account | { beforeDispatch?: () => void },
        arg5?: { beforeDispatch?: () => void },
    ): Promise<Trade> {
        const target = this.resolveTarget(arg1, arg2, [arg3, arg4, arg5], 'value');
        const { trade, full, account, opts } = target;
        const reduction = target.value as number;

        if (!isEsunAccount(account)) {
            throw mutationNotStartedError('指定的帳戶非玉山證券帳戶');
        }

        const ordNo = this.orderNumber(trade.order);
        if (!ordNo) {
            throw mutationNotStartedError('缺少玉山證券委託編號，無法改量');
        }

        if (!full && !(trade.order.quantity > 0)) {
            // 只有委託編號、不知道剩餘量：無法驗證減少量，不送出
            if (!Number.isSafeInteger(reduction) || reduction <= 0) throw mutationNotStartedError('減量數量必須為正整數');
            throw mutationNotStartedError('缺少玉山委託的剩餘數量，無法確認減量；請先更新委託');
        }
        const validationErr = validateEsunOrderQtyMutation(trade, reduction);
        if (validationErr) {
            throw mutationNotStartedError(validationErr);
        }

        const guard = this.mutationGuard(account);
        this.runBeforeDispatch(opts);

        const unit = esunQuantityUnitFor(esunApCodeFor(trade.order, trade.contract));
        let res: Awaited<ReturnType<IEsunTradeDriver['replaceQuantity']>>;
        try {
            res = await this.driver.replaceQuantity(ordNo, reduction, full ? toEsunMutationPayload(trade) : { stockNo: trade.contract.code }, { guard, unit });
        } catch (e) {
            throw this.explainMismatch(e);
        }

        const retCode = esunRetCode(res);
        if (isEsunFailureCode(retCode)) {
            throw mutationNotStartedError(`玉山證券改量失敗：${formatEsunErrorMessage(retCode, esunRetMessage(res))}`);
        }

        return this.sentTrade(trade, res, `減量 ${reduction}${unit === 'share' ? ' 股' : ' 張'} 已送出，等待回報確認`);
    }

    /** 查詢帳戶必須是 bridge 目前登入的玉山帳戶（帳戶鍵含環境） */
    private assertQueryAccount(account: Account): void {
        if (!isEsunAccount(account)) {
            throw new Error('指定的帳戶非玉山證券帳戶');
        }
        const env = esunEnvironmentOfAccount(account);
        if (this.environmentKnown && env !== this.environment) {
            throw new Error(`玉山目前為${ENV_LABEL[this.environment]}，此帳戶屬於${ENV_LABEL[env!]}；已停止查詢`);
        }
        if (this.accounts.length > 0 && !this.accounts.some(a => a.broker_id === account.broker_id && a.account_id === account.account_id)) {
            throw new Error('此玉山帳戶不是 esun-bridge 目前登入的帳戶；已停止查詢');
        }
    }

    private missing(what: string): never {
        throw new Error(`玉山下單服務未提供${what}查詢`);
    }

    /** 委託列中缺少識別欄位而略過的筆數（最近一次讀取） */
    lastSkippedOrderRows = 0;

    /**
     * 查詢玉山委託。回傳順序依 (ord_date, ord_time) 由舊到新（上游約定：陣列由舊到新，UI 反轉成
     * 最新在前）；同時以這次快照整批取代該帳戶的委託中繼資料（預約單、有效交易日、委託時間、可否取消）。
     */
    async fetchTrades(account: Account, refresh = false): Promise<Trade[]> {
        this.assertQueryAccount(account);
        if (!this.driver.getOrders) this.missing('委託');
        const results: EsunOrderResult[] = await this.driver.getOrders(refresh);
        if (!Array.isArray(results)) throw new Error('玉山委託回應格式錯誤');
        const sorted = sortEsunOrderResultsOldestFirst(results);
        const exchangeOf = (code: string) => getCachedContract(code)?.exchange ?? undefined;
        const trades = sorted.map(r => fromEsunOrderResult(r, account, { exchangeOf }));
        this.lastSkippedOrderRows = trades.filter(t => t === null).length;
        setEsunOrderMetaSnapshot(account, sorted);
        return trades.filter((t): t is Trade => t !== null);
    }

    /**
     * 查詢持股庫存與未實現損益。driver 提供原始列時只打一次請求，同一批列同時產生
     * StockPosition（回傳）與完整庫存明細（寫入 account-details 的庫存明細 store）。
     */
    async fetchPositions(account: Account, unit: 'Common' | 'Share' = 'Common'): Promise<StockPosition[]> {
        this.assertQueryAccount(account);
        if (this.driver.getInventories) {
            const rows = await this.driver.getInventories(unit);
            if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
                throw new Error('玉山庫存回應格式錯誤');
            }
            const positions = rows.map((item, idx) => fromEsunInventoryToPosition(item, unit, idx + 1));
            setEsunInventoryDetails(account, parseEsunInventoryDetails(rows));
            return positions;
        }
        if (!this.driver.getPositions) this.missing('庫存');
        return this.driver.getPositions(unit);
    }

    /**
     * 帳務總覽：餘額、交易額度、市場狀態三個請求並行。市場狀態失敗 → marketStatus 為 null；
     * 餘額或交易額度失敗 → 整體 reject（訊息標明哪一項失敗）。
     */
    async fetchAccountOverview(account: Account): Promise<EsunAccountOverview> {
        this.assertQueryAccount(account);
        const driver = this.driver;
        if (!driver.getBalanceRaw) this.missing('餘額');
        if (!driver.getTradeStatusRaw) this.missing('交易額度');
        const failed = (what: string) => (e: unknown): never => {
            const reason = e instanceof Error ? e.message : String(e);
            throw Object.assign(new Error(`玉山${what}查詢失敗：${reason}`), { cause: e });
        };
        const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
        const [balance, tradeStatus, marketStatus] = await Promise.all([
            driver.getBalanceRaw().then(raw => {
                if (!isRecord(raw)) throw new Error('回應格式錯誤');
                return parseEsunBalanceDetail(raw);
            }).catch(failed('銀行餘額')),
            driver.getTradeStatusRaw().then(raw => {
                if (!isRecord(raw)) throw new Error('回應格式錯誤');
                return parseEsunTradeStatusDetail(raw);
            }).catch(failed('交易額度')),
            (driver.getMarketStatusRaw ? driver.getMarketStatusRaw() : Promise.resolve(null))
                .then(raw => (isRecord(raw) ? parseEsunMarketStatusDetail(raw) : null))
                .catch(() => null),
        ]);
        return { balance, tradeStatus, marketStatus };
    }

    /** 查詢銀行餘額與圈存 */
    async fetchAccountBalance(account: Account): Promise<AccountBalance> {
        this.assertQueryAccount(account);
        if (!this.driver.getBalance) this.missing('餘額');
        return this.driver.getBalance();
    }

    /** 查詢 T+2 交割款 */
    async fetchSettlements(account: Account): Promise<Settlement[]> {
        this.assertQueryAccount(account);
        if (!this.driver.getSettlements) this.missing('交割款');
        return this.driver.getSettlements();
    }

    /**
     * 查詢歷史成交與已實現損益。driver 提供原始列時只打一次請求，同一批列同時產生
     * StockProfitLoss[]（回傳）與已實現列的成交明細（以帳戶＋傳入的 beginDate／endDate 為鍵寫入 store，
     * 順序與回傳的列一致）。
     */
    async fetchProfitLoss(
        account: Account,
        beginDate = '',
        endDate = '',
    ): Promise<StockProfitLoss[]> {
        this.assertQueryAccount(account);
        if (this.driver.getTransactions) {
            const rows = await this.driver.getTransactions(beginDate, endDate);
            if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) {
                throw new Error('玉山已實現損益回應格式錯誤');
            }
            const list = fromEsunTransactionsToProfitLoss(rows);
            setEsunTransactionDetails(account, beginDate, endDate, parseEsunRealizedTransactionDetails(rows));
            return list;
        }
        if (!this.driver.getProfitLoss) this.missing('已實現損益');
        return this.driver.getProfitLoss(beginDate, endDate);
    }

    /** 查詢歷史成交與已實現損益彙總 */
    async fetchProfitLossSummary(
        account: Account,
        beginDate = '',
        endDate = '',
    ): Promise<ProfitLossSummaryTotal> {
        this.assertQueryAccount(account);
        if (!this.driver.getProfitLossSummary) this.missing('已實現損益彙總');
        return this.driver.getProfitLossSummary(beginDate, endDate);
    }

    /** 查詢交易額度與信用權限 */
    async fetchTradingLimits(account: Account): Promise<TradingLimits> {
        this.assertQueryAccount(account);
        if (!this.driver.getTradingLimits) this.missing('交易額度');
        return this.driver.getTradingLimits();
    }

    /** 查詢圈存摘要 */
    async fetchStockReserveSummary(account: Account): Promise<ReserveStocksSummary> {
        this.assertQueryAccount(account);
        if (!this.driver.getStockReserveSummary) this.missing('圈存');
        const summary = await this.driver.getStockReserveSummary();
        return { ...summary, account };
    }
}

/** 把玉山帳戶同步到全域帳戶清單（清單已載入永豐帳戶時才同步，避免玉山被當成預設帳戶） */
function syncEsunAccountsToStore(accounts: Account[]): void {
    const state = getAccountState();
    if (!state.accounts.some(a => !isEsunAccount(a))) return;
    const current = state.accounts.filter(isEsunAccount);
    const key = (list: Account[]) => list.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}`).sort().join('|');
    if (key(current) === key(accounts) && current.every(a => accounts.some(b => sameAccount(a, b) && a.person_id === b.person_id))) return;
    replaceExternalAccountsForBroker(isEsunBroker, accounts);
}

export const esunTradeService = new EsunTradeService();

export function useEsunEnvironment(): {
    environment: EsunEnvironment;
    isSimulation: boolean;
    entry: string;
    activeConfigFile: string | null;
    configProfiles: EsunConfigProfilesMap;
    availableEnvironments: EsunEnvironment[];
    /** bridge 已回報目前環境；false 時顯示「未知」 */
    environmentKnown: boolean;
    /** 環境切換進行中 */
    switching: boolean;
    sessionGeneration: number | null;
    bridgeConnected: boolean;
    isEnvironmentAvailable: (env: EsunEnvironment) => boolean;
    switchEnvironment: (env: EsunEnvironment) => Promise<EsunSwitchResult>;
    refreshConfigProfiles: () => Promise<EsunConfigProfilesMap>;
} {
    const snap = useSyncExternalStore(
        (l) => esunTradeService.subscribe(l),
        () => esunTradeService.getSnapshot(),
    );
    return {
        environment: snap.environment,
        isSimulation: snap.isSimulation,
        entry: snap.entry,
        activeConfigFile: snap.activeConfigFile,
        configProfiles: snap.configProfiles,
        availableEnvironments: snap.availableEnvironments,
        environmentKnown: snap.environmentKnown,
        switching: snap.switching,
        sessionGeneration: snap.sessionGeneration,
        bridgeConnected: snap.bridgeConnected,
        isEnvironmentAvailable: (env: EsunEnvironment) => esunTradeService.isEnvironmentAvailable(env),
        switchEnvironment: (target: EsunEnvironment) => esunTradeService.switchEnvironment(target),
        refreshConfigProfiles: () => esunTradeService.refreshConfigProfiles(),
    };
}
