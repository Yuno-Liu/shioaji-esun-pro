// src/components/header-env-menu.tsx — 頂欄「券商／帳號／環境」徽章與選單（fork 專屬）
// 上游 hud-header 只留掛載點。重點：
// - 股票與期貨各自的下單路由（券商＋帳號＋環境）都顯示；任一路由為正式就以正式紅色警示。
// - 永豐環境一律以伺服器 /api/v1/info 的 simulation（server-info-store，與送單閘門同源）為準，
//   選單只顯示唯讀狀態並引導到伺服器管理；頂欄不提供「只改標籤」的切換。
// - 玉山環境在 bridge 回報前顯示「未知」；切正式前需明確確認；切換中鎖定；失敗依回傳 ok:false 回饋。

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { invalidateAllQueries } from '../hooks/use-query';
import {
    accountFor,
    ensureAccounts,
    registerExternalAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import { canTrade } from '../lib/account-tradable';
import {
    ESUN_PRODUCTION_ENTRY,
    ESUN_SIMULATION_ENTRY,
    esunTradeService,
    isEsunAccount,
    useEsunEnvironment,
    type EsunBridgeHealth,
    type EsunEnvironment,
} from '../lib/esun';
import { useServerInfo } from '../lib/server-info-store';
import { fetchInfo } from '../lib/shioaji';
import { notify } from '../lib/trade';
import { refreshTradingState, refreshTradingStateForModeChange } from '../lib/trading-state';
import type { Account } from '../lib/types/portfolio';
import { AsyncStatus } from './async-status';
import * as hud from './hud-header.css';
import * as styles from './header-env-menu.css';

export type RouteEnv = 'sim' | 'prod' | 'unknown';
export type RouteBroker = 'sinopac' | 'esun';

export interface HeaderRoute {
    market: 'S' | 'F';
    broker: RouteBroker;
    account: Account | null;
    env: RouteEnv;
}

const BROKER_SHORT: Record<RouteBroker, string> = { sinopac: '永豐', esun: '玉山' };
const BROKER_NAME: Record<RouteBroker, string> = { sinopac: '永豐金證券', esun: '玉山證券' };
const MARKET_SHORT: Record<'S' | 'F', string> = { S: '證', F: '期' };
const MARKET_NAME: Record<'S' | 'F', string> = { S: '證券', F: '期貨' };
const ENV_LABEL: Record<RouteEnv, string> = { sim: '模擬環境', prod: '正式環境', unknown: '環境未知' };
const ENV_SHORT: Record<RouteEnv, string> = { sim: '模擬', prod: '正式', unknown: '未知' };

// bridge 斷線時以退避重試取得環境（2s、4s…上限 60s，最多 6 次；開啟選單時也會再探測）
const BRIDGE_RETRY_MAX = 6;

export function envOf(simulation: boolean | null | undefined): RouteEnv {
    return simulation === true ? 'sim' : simulation === false ? 'prod' : 'unknown';
}

function healthHasEnv(h: EsunBridgeHealth | null | undefined): boolean {
    return h?.environment === 'SIMULATION' || h?.environment === 'PRODUCTION';
}

function sameAccount(a: Account | null | undefined, b: Account | null | undefined): boolean {
    return !!a && !!b && a.broker_id === b.broker_id && a.account_id === b.account_id && a.account_type === b.account_type;
}

/** 股票／期貨各自實際送單的路由：未選帳號時由永豐伺服器預設帳號承接。
 * 某市場沒有任何帳號就不列；完全沒有帳號時至少列出永豐證券路由。 */
export function describeRoutes(input: {
    accounts: Account[];
    selectedStock: Account | null;
    selectedFutures: Account | null;
    sinopacEnv: RouteEnv;
    esunEnv: RouteEnv;
}): HeaderRoute[] {
    const routes: HeaderRoute[] = [];
    for (const market of ['S', 'F'] as const) {
        const account = (market === 'S' ? input.selectedStock : input.selectedFutures) ?? null;
        if (!account && !input.accounts.some((a) => a.account_type === market)) continue;
        const broker: RouteBroker = isEsunAccount(account) ? 'esun' : 'sinopac';
        routes.push({ market, broker, account, env: broker === 'esun' ? input.esunEnv : input.sinopacEnv });
    }
    if (routes.length === 0) {
        routes.push({ market: 'S', broker: 'sinopac', account: null, env: input.sinopacEnv });
    }
    return routes;
}

/** 任一路由為正式 → 正式；否則任一未知 → 未知；全部模擬才算模擬 */
export function overallEnv(routes: HeaderRoute[]): RouteEnv {
    if (routes.some((r) => r.env === 'prod')) return 'prod';
    if (routes.some((r) => r.env === 'unknown')) return 'unknown';
    return 'sim';
}

export function routesLabel(routes: HeaderRoute[]): string {
    const brokers = new Set(routes.map((r) => r.broker));
    if (brokers.size === 1) {
        const first = routes[0]!;
        return `${BROKER_SHORT[first.broker]} ${ENV_LABEL[overallEnv(routes)]}`;
    }
    return routes
        .map((r) => `${MARKET_SHORT[r.market]} ${BROKER_SHORT[r.broker]} ${ENV_SHORT[r.env]}`)
        .join(' ｜ ');
}

function accountText(acc: Account | null): string {
    return acc ? `${acc.broker_id}-${acc.account_id}` : '伺服器預設帳號';
}

export function HeaderEnvMenu({
    externalLabel = null,
    onOpenServerManager,
}: {
    /** 永豐伺服器由其他程式啟動時的說明（上游 externalServerLabel）；null = 自己管理的伺服器 */
    externalLabel?: string | null;
    onOpenServerManager?: () => void;
}) {
    const { accounts, selectedStock, selectedFutures } = useAccounts();
    const esunEnv = useEsunEnvironment();
    const serverInfo = useServerInfo();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState<EsunEnvironment | null>(null);
    const [confirmProd, setConfirmProd] = useState(false);
    const [linking, setLinking] = useState(false);
    const [bridgeHealth, setBridgeHealth] = useState<EsunBridgeHealth | null>(() => esunTradeService.getBridgeHealth());
    // 玉山環境是否已由 bridge 確認（health 回報或 bridge 確認的切換）；未確認一律顯示「未知」
    const [esunConfirmed, setEsunConfirmed] = useState(() => healthHasEnv(esunTradeService.getBridgeHealth()));
    const switchingRef = useRef(false);
    const badgeRef = useRef<HTMLButtonElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        ensureAccounts();
        let cancelled = false;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const probe = () => {
            void esunTradeService
                .connectBridge()
                .catch(() => null)
                .then((health) => {
                    if (cancelled) return;
                    if (health) {
                        setBridgeHealth(health);
                        if (healthHasEnv(health)) setEsunConfirmed(true);
                        return;
                    }
                    if (attempt >= BRIDGE_RETRY_MAX) return;
                    const delay = Math.min(60_000, 2_000 * 2 ** attempt);
                    attempt += 1;
                    timer = setTimeout(probe, delay);
                });
        };
        probe();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    const close = (restoreFocus = false) => {
        setOpen(false);
        setConfirmProd(false);
        if (restoreFocus) badgeRef.current?.focus();
    };

    useEffect(() => {
        if (!open) return;
        const first = popoverRef.current?.querySelector<HTMLElement>('button:not([disabled])');
        first?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    const sinopacEnv = envOf(serverInfo?.simulation);
    const esunRouteEnv: RouteEnv = esunConfirmed ? (esunEnv.isSimulation ? 'sim' : 'prod') : 'unknown';
    const routes = describeRoutes({ accounts, selectedStock, selectedFutures, sinopacEnv, esunEnv: esunRouteEnv });
    const badgeEnv = overallEnv(routes);
    const badgeText = routesLabel(routes);
    const hasSinopacRoute = routes.some((r) => r.broker === 'sinopac');

    const esunAccounts = accounts.filter((a) => isEsunAccount(a));
    const bridgeConnected = bridgeHealth !== null;
    const showEsunSection = bridgeConnected || esunAccounts.length > 0 || routes.some((r) => r.broker === 'esun');
    const simProfile = esunEnv.configProfiles.SIMULATION;
    const prodProfile = esunEnv.configProfiles.PRODUCTION;
    const locked = switching !== null;

    const badgeClass =
        badgeEnv === 'prod' ? hud.prodBadge : badgeEnv === 'sim' ? hud.simBadge : styles.unknownBadge;

    const toggle = () => {
        if (open) {
            close();
            return;
        }
        setOpen(true);
        setConfirmProd(false);
        if (showEsunSection) {
            void esunTradeService
                .refreshConfigProfiles()
                .catch(() => undefined)
                .then(() => {
                    // 第一次連上 bridge（開啟選單前尚未連線）：以 health 回報的環境為準
                    const h = esunTradeService.getBridgeHealth();
                    if (h && !bridgeHealth) {
                        setBridgeHealth(h);
                        if (healthHasEnv(h)) setEsunConfirmed(true);
                    }
                });
        }
        if (sinopacEnv === 'unknown') void fetchInfo().catch(() => undefined);
    };

    const pickAccount = (acc: Account) => {
        if (locked) return;
        if (!canTrade(acc)) {
            notify({ kind: 'err', title: '無法切換帳號', body: `${accountText(acc)} 尚未簽署，正式或未知模式下不可用於下單` });
            return;
        }
        selectAccount(acc);
        const market = acc.account_type === 'S' || acc.account_type === 'F' ? acc.account_type : null;
        if (market && !sameAccount(accountFor(market), acc)) {
            notify({ kind: 'err', title: '無法切換帳號', body: `${accountText(acc)} 目前不可用於下單` });
            return;
        }
        invalidateAllQueries();
        void refreshTradingState('all');
        notify({
            kind: 'ok',
            title: '帳號切換',
            body: `${market ? MARKET_NAME[market] : ''}改走 ${isEsunAccount(acc) ? BROKER_NAME.esun : BROKER_NAME.sinopac} ${accountText(acc)}`,
        });
    };

    const linkEsunBridge = async () => {
        if (linking) return;
        setLinking(true);
        try {
            const health = await esunTradeService.connectBridge().catch(() => null);
            if (health) {
                setBridgeHealth(health);
                if (healthHasEnv(health)) setEsunConfirmed(true);
            }
            const found = esunTradeService.getAccounts();
            if (health && found.length > 0) {
                registerExternalAccounts(found);
                notify({ kind: 'ok', title: '玉山證券', body: `已取得 ${found.length} 個玉山帳號，請於清單中選擇` });
            } else {
                notify({
                    kind: 'err',
                    title: '玉山證券',
                    body: health ? '玉山 bridge 已連線但尚未登入帳號' : '無法連線玉山 bridge（/esun/health）',
                });
            }
        } finally {
            setLinking(false);
        }
    };

    const runEsunSwitch = async (target: EsunEnvironment) => {
        if (switchingRef.current) return;
        switchingRef.current = true;
        setSwitching(target);
        setConfirmProd(false);
        const label = target === 'SIMULATION' ? '模擬環境' : '正式環境';
        try {
            const res = await esunTradeService.switchEnvironment(target);
            if (!res.ok) {
                notify({ kind: 'err', title: '環境切換失敗', body: res.error || `無法切換至${label}` });
                return;
            }
            invalidateAllQueries();
            void refreshTradingStateForModeChange();
            if (res.bridgeUpdated === false) {
                // bridge 沒有確認這次切換：不採信本地標籤，改顯示「未知」
                setEsunConfirmed(false);
                notify({
                    kind: 'err',
                    title: '環境切換未確認',
                    body: '玉山 bridge 沒有確認環境切換，環境標示改為「未知」；請確認 bridge 狀態後重試',
                });
                return;
            }
            setEsunConfirmed(true);
            const fallbackFile = target === 'SIMULATION' ? simProfile?.fileName : prodProfile?.fileName;
            notify({
                kind: 'ok',
                title: '環境切換',
                body: `已切換玉山證券至${label}${res.activeConfigFile ?? fallbackFile ? `（${res.activeConfigFile ?? fallbackFile}）` : ''}`,
            });
            close(true);
        } catch (err) {
            notify({ kind: 'err', title: '環境切換失敗', body: err instanceof Error ? err.message : String(err) });
        } finally {
            switchingRef.current = false;
            setSwitching(null);
        }
    };

    const requestEsunSwitch = (target: EsunEnvironment) => {
        if (switchingRef.current || !bridgeConnected) return;
        if (!esunTradeService.isEnvironmentAvailable(target)) return;
        if (esunConfirmed && esunEnv.environment === target) return;
        if (target === 'PRODUCTION') {
            setConfirmProd(true);
            return;
        }
        void runEsunSwitch(target);
    };

    const renderEsunOption = (target: EsunEnvironment) => {
        const isSim = target === 'SIMULATION';
        const profile = isSim ? simProfile : prodProfile;
        const disabled = !profile?.available || !bridgeConnected || locked;
        const active = esunConfirmed && esunEnv.environment === target;
        const fileName = profile?.fileName ?? (isSim ? 'esun-config.simulation.ini' : 'esun-config.production.ini');
        const cls = !profile?.available || !bridgeConnected
            ? styles.optionDisabled
            : active
              ? isSim ? styles.optionActive : styles.optionProdActive
              : isSim ? styles.option : styles.optionProd;
        return (
            <button
                type="button"
                data-testid={isSim ? 'env-option-simulation' : 'env-option-production'}
                disabled={disabled}
                aria-disabled={disabled}
                aria-pressed={active}
                className={cls}
                onClick={() => {
                    if (disabled) return;
                    requestEsunSwitch(target);
                }}
            >
                <span className={styles.optionTop}>
                    <span className={styles.optionLabel}>{isSim ? '模擬環境 (SIMULATION)' : '正式環境 (PRODUCTION)'}</span>
                    {profile?.available ? (
                        <span className={styles.configFileBadge}>{fileName}</span>
                    ) : (
                        <span className={styles.missingConfigBadge}>未提供設定檔 (不可選)</span>
                    )}
                    {active && <Check size={12} className={styles.checkIcon} />}
                </span>
                <span className={styles.optionSubtitle}>
                    {profile?.available ? (
                        <>
                            <span className={styles.line}>設定檔: {fileName}</span>
                            <span className={styles.line}>{isSim ? 'Environment = SIMULATION' : '無 Environment 資訊 (僅 Entry)'}</span>
                            <span className={styles.line}>Entry = {isSim ? ESUN_SIMULATION_ENTRY : ESUN_PRODUCTION_ENTRY}</span>
                            {!isSim && <span className={styles.line}>以真實帳戶下單，切換前需再次確認</span>}
                        </>
                    ) : (
                        <>
                            <span className={styles.line}>未偵測到{isSim ? '模擬' : '正式'}環境設定檔，請於專案根目錄提供：</span>
                            <span className={styles.line}>
                                {isSim
                                    ? 'esun-config.simulation.ini（或 esun-config.sim.ini）'
                                    : 'esun-config.production.ini（或 esun-config.prod.ini）'}
                            </span>
                        </>
                    )}
                </span>
            </button>
        );
    };

    return (
        <div className={styles.wrap}>
            <button
                ref={badgeRef}
                type="button"
                className={`${badgeClass} ${styles.badgeButton}`}
                data-testid="header-env-badge"
                data-env={badgeEnv}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? 'header-env-menu' : undefined}
                onClick={toggle}
                title={`${routes
                    .map((r) => `${MARKET_NAME[r.market]}：${BROKER_NAME[r.broker]} ${accountText(r.account)} ${ENV_SHORT[r.env]}`)
                    .join('；')}${externalLabel && hasSinopacRoute ? `；${externalLabel}` : ''}（點擊查看路由與切換）`}
            >
                {routes.length > 1 && new Set(routes.map((r) => r.broker)).size > 1 ? (
                    routes.map((r, idx) => (
                        <span key={r.market}>
                            {idx > 0 && <span className={styles.badgeSep}>｜</span>}
                            {`${MARKET_SHORT[r.market]} ${BROKER_SHORT[r.broker]} ${ENV_SHORT[r.env]}`}
                        </span>
                    ))
                ) : (
                    <>
                        <span className={styles.badgeBroker}>{BROKER_SHORT[routes[0]!.broker]}</span>
                        <span>{ENV_LABEL[badgeEnv]}</span>
                    </>
                )}
                {externalLabel && hasSinopacRoute && <span className={hud.externalTag}>· 外部伺服器</span>}
                <ChevronDown size={11} className={styles.chevron} />
            </button>

            {open && (
                <>
                    <div className={styles.backdrop} onClick={() => close()} />
                    <div
                        ref={popoverRef}
                        id="header-env-menu"
                        className={styles.popover}
                        data-testid="header-env-menu"
                        role="dialog"
                        aria-label="下單路由、帳號與交易環境"
                        aria-busy={locked}
                    >
                        <div className={styles.section}>
                            <div className={styles.sectionHeader}>
                                <span className={styles.sectionTitle}>目前下單路由</span>
                                <span className={styles.envTag[badgeEnv]}>{badgeText}</span>
                            </div>
                            <div className={styles.routeList} data-testid="header-env-routes">
                                {routes.map((r) => (
                                    <div key={r.market} className={styles.routeRow} data-testid={`header-route-${r.market}`}>
                                        <span className={styles.routeMarket}>{MARKET_NAME[r.market]}</span>
                                        <span className={styles.brokerTag[r.broker]}>{BROKER_SHORT[r.broker]}</span>
                                        <span className={styles.routeAccount}>{accountText(r.account)}</span>
                                        <span className={styles.envTag[r.env]}>{ENV_SHORT[r.env]}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className={styles.section}>
                            <div className={styles.sectionHeader}>
                                <span className={styles.sectionTitle}>帳號切換（依證券／期貨分別生效）</span>
                            </div>
                            <div className={styles.accountList}>
                                {accounts.map((acc) => {
                                    const isEsun = isEsunAccount(acc);
                                    const selected = acc.account_type === 'F' ? selectedFutures : selectedStock;
                                    const isSelected = sameAccount(selected, acc);
                                    const tradable = canTrade(acc);
                                    return (
                                        <button
                                            key={`${acc.broker_id}-${acc.account_id}-${acc.account_type}`}
                                            type="button"
                                            className={isSelected ? styles.accountItemActive : styles.accountItem}
                                            disabled={locked || !tradable}
                                            aria-pressed={isSelected}
                                            title={tradable ? undefined : '此帳號尚未簽署，正式或未知模式下不可用於下單'}
                                            onClick={() => pickAccount(acc)}
                                        >
                                            <span className={isEsun ? styles.brokerTag.esun : styles.brokerTag.sinopac}>
                                                {isEsun ? '玉山' : '永豐'}
                                            </span>
                                            <span className={styles.accountName}>
                                                {acc.broker_id}-{acc.account_id} ({acc.account_type === 'F' ? '期貨' : '證券'})
                                            </span>
                                            {!tradable && <span className={styles.accountNote}>未簽署</span>}
                                            {isSelected && <Check size={12} className={styles.checkIcon} />}
                                        </button>
                                    );
                                })}
                                {esunAccounts.length === 0 && (
                                    <button
                                        type="button"
                                        className={styles.linkBtn}
                                        data-testid="esun-link-bridge"
                                        disabled={linking || locked}
                                        onClick={() => void linkEsunBridge()}
                                    >
                                        {linking ? '連線玉山 bridge 中…' : '＋ 連線玉山 bridge 取得帳號'}
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className={styles.section} data-testid="sinopac-env-readonly">
                            <div className={styles.sectionHeader}>
                                <span className={styles.sectionTitle}>永豐金證券環境（唯讀）</span>
                                <span className={styles.envTag[sinopacEnv]}>{ENV_SHORT[sinopacEnv]}</span>
                            </div>
                            <div className={styles.readonlyRow}>
                                <span className={styles.optionSubtitle}>
                                    <span className={styles.line}>
                                        以 Shioaji 伺服器 /api/v1/info 回報為準
                                        {sinopacEnv === 'unknown' ? '（尚未取得伺服器資訊）' : ''}
                                    </span>
                                    <span className={styles.line}>要切換模擬／正式，請到伺服器管理調整模式並重啟伺服器</span>
                                </span>
                                {onOpenServerManager && (
                                    <button
                                        type="button"
                                        className={styles.linkBtn}
                                        data-testid="sinopac-open-server-manager"
                                        onClick={() => {
                                            close();
                                            onOpenServerManager();
                                        }}
                                    >
                                        開啟伺服器管理
                                    </button>
                                )}
                            </div>
                        </div>

                        {showEsunSection && (
                            <div className={styles.section}>
                                <div className={styles.sectionHeader}>
                                    <span className={styles.sectionTitle}>玉山證券環境切換</span>
                                    <span className={styles.envTag[esunRouteEnv]}>{ENV_SHORT[esunRouteEnv]}</span>
                                </div>
                                {locked && (
                                    <AsyncStatus
                                        phase="loading"
                                        size={12}
                                        text={`切換至${switching === 'SIMULATION' ? '模擬' : '正式'}環境中…`}
                                    />
                                )}
                                {!bridgeConnected && (
                                    <span className={styles.accountNote}>尚未連線玉山 bridge，暫時無法切換環境</span>
                                )}
                                {confirmProd ? (
                                    <div className={styles.confirmBox} role="alertdialog" aria-label="確認切換至正式環境" data-testid="env-confirm-production-box">
                                        <span className={styles.confirmTitle}>確認切換玉山證券至正式環境？</span>
                                        <span>切換後將以真實帳戶下單，委託會送到交易所並可能成交。</span>
                                        <span className={styles.optionSubtitle}>
                                            <span className={styles.line}>
                                                帳號：{esunAccounts.length > 0 ? esunAccounts.map(accountText).join('、') : '由 bridge 登入帳號決定'}
                                            </span>
                                            <span className={styles.line}>設定檔：{prodProfile?.fileName ?? 'esun-config.production.ini'}</span>
                                            <span className={styles.line}>Entry：{ESUN_PRODUCTION_ENTRY}</span>
                                        </span>
                                        <span className={styles.confirmActions}>
                                            <button
                                                type="button"
                                                className={styles.cancelBtn}
                                                data-testid="env-confirm-cancel"
                                                onClick={() => setConfirmProd(false)}
                                            >
                                                取消
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.dangerBtn}
                                                data-testid="env-confirm-production"
                                                disabled={locked}
                                                onClick={() => runEsunSwitch('PRODUCTION')}
                                            >
                                                確認切換至正式環境
                                            </button>
                                        </span>
                                    </div>
                                ) : (
                                    <div className={styles.optionGroup}>
                                        {renderEsunOption('SIMULATION')}
                                        {renderEsunOption('PRODUCTION')}
                                    </div>
                                )}
                                <div className={styles.footerHint}>
                                    命名規範：測試 esun-config.simulation.ini ／ 正式 esun-config.production.ini
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
