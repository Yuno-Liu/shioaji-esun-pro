// src/components/hud-header.tsx — top status bar. 主題/帳號/版面/風控規則
// 都收斂進統一設定 dialog（settings-dialog.tsx）；header 只留高頻操作：
// 伺服器狀態、Kill Switch（一鍵鎖定/解鎖）、新增面板、閃電全開、設定。

import { Check, ChevronDown, LayoutGrid, Lock, Settings, Undo2, Unlock, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStreamStatus } from '../hooks/use-stream';
import { useHeaderItems } from '../lib/header-items';
import { setRiskSettings, useRiskSettings } from '../lib/risk';
import { fetchInfo } from '../lib/shioaji';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import {
    appVersion,
    checkForUpdates,
    listenTrayEvents,
    openFlashTiles,
    type FlashTileLayout,
} from '../lib/tauri';
import { fmtMoney } from '../lib/utils/format';
import type { WatchItem } from '../hooks/use-watchlist';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Profile, Workspace } from '../lib/workspace';
import { HeaderSymbolSearch } from './header-symbol-search';
import { LayoutLibrary } from './layout-library';
import { MarketBar } from './market-bar';
import { ServerManager } from './server-manager';
import { ForeignServerChip } from './foreign-server-chip';
import { externalServerLabel, useServerAttachment } from '../lib/server-adoption';
import { SettingsDialog } from './settings-dialog';
import { flashPopoutParams, reseedPopoutFlashAccounts } from '../lib/flash-account';
import { mainFlashSelection } from '../lib/order-account';
import { ensureAccounts, getActiveAccount, registerExternalAccounts, selectAccount, useAccounts } from '../lib/account-store';
import { invalidateAllQueries } from '../hooks/use-query';
import { refreshTradingState, refreshTradingStateForModeChange } from '../lib/trading-state';
import {
    ESUN_PRODUCTION_ENTRY,
    ESUN_SIMULATION_ENTRY,
    esunTradeService,
    isEsunAccount,
    useEsunEnvironment,
} from '../lib/esun';
import { notify } from '../lib/trade';
import * as styles from './hud-header.css';

const STATUS_LABEL = {
    live: 'LIVE',
    connecting: 'SYNC',
    down: 'LOST',
    stale: 'STALE',
} as const;

function Menu({
    label,
    children,
}: {
    label: React.ReactNode;
    children: (close: () => void) => React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className={styles.settingsWrap}>
            <button
                className={styles.resetBtn}
                onClick={() => setOpen((o) => !o)}
            >
                {label}
            </button>
            {open && (
                <>
                    <div
                        className={styles.popoverBackdrop}
                        onClick={() => setOpen(false)}
                    />
                    <div className={styles.popover}>
                        {children(() => setOpen(false))}
                    </div>
                </>
            )}
        </div>
    );
}

// Kill Switch 一鍵可達：鎖定中紅色＋脈動，一鍵解鎖。規則設定在設定 dialog
// 的風控分類（同一 useRiskSettings store，兩處自然同步）。
function KillSwitchButton() {
    const risk = useRiskSettings();
    return (
        <button
            className={risk.locked ? styles.killHeaderOn : styles.resetBtn}
            title={
                risk.locked
                    ? '風控鎖定中 — 點擊解除鎖定（恢復下單）'
                    : '鎖定下單 Kill Switch（規則設定在「設定 → 風控」）'
            }
            onClick={() => setRiskSettings({ locked: !risk.locked })}
        >
            {risk.locked ? (
                <>
                    <Unlock size={11} style={{ verticalAlign: '-1px' }} />{' '}
                    風控鎖定
                </>
            ) : (
                <>
                    <Lock size={11} style={{ verticalAlign: '-1px' }} /> 風控
                </>
            )}
        </button>
    );
}

// ⚡全開 layout picker: thumbnails first, windows open per the chosen
// arrangement. Flash ladders are tall and narrow, so the practical
// layouts are full-height strips side by side.
const FLASH_LAYOUTS: (FlashTileLayout & { key: string; label: string })[] = [
    { key: 's8', label: '8 長條', cols: 8, rows: 1, region: 'full' },
    { key: 's6', label: '6 長條', cols: 6, rows: 1, region: 'full' },
    { key: 's4', label: '4 長條', cols: 4, rows: 1, region: 'full' },
    { key: 's3', label: '3 長條', cols: 3, rows: 1, region: 'full' },
    { key: 'right4', label: '右側直欄', cols: 1, rows: 4, region: 'right' },
];

function FlashThumb({ layout }: { layout: FlashTileLayout }) {
    const regionStyle: React.CSSProperties =
        layout.region === 'right'
            ? { top: 1, bottom: 1, right: 1, width: '26%' }
            : layout.region === 'bottom'
              ? { left: 1, right: 1, bottom: 1, height: '34%' }
              : { inset: 1 };
    return (
        <span className={styles.flashThumb}>
            <span
                className={styles.flashThumbRegion}
                style={{
                    ...regionStyle,
                    gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
                }}
            >
                {Array.from({ length: layout.cols * layout.rows }).map(
                    (_, i) => (
                        <span key={i} className={styles.flashThumbCell} />
                    ),
                )}
            </span>
        </span>
    );
}

function FlashTilesMenu({ flashCodes }: { flashCodes: string[] }) {
    return (
        <Menu
            label={
                <>
                    <Zap size={11} style={{ verticalAlign: '-1px' }} /> 全開
                </>
            }
        >
            {(close) => (
                <>
                    <span className={styles.settingLabel}>
                        閃電下單全開 — 選擇排版
                    </span>
                    {FLASH_LAYOUTS.map((lay) => {
                        const count = Math.min(
                            flashCodes.length,
                            lay.cols * lay.rows,
                        );
                        return (
                            <button
                                key={lay.key}
                                className={styles.flashLayoutItem}
                                onClick={() => {
                                    close();
                                    const global = mainFlashSelection();
                                    void openFlashTiles(flashCodes, lay, (code) =>
                                        flashPopoutParams(undefined, global, `tile:${code}`),
                                        (_code, params) => {
                                            if (params.win) reseedPopoutFlashAccounts(params.win, undefined, global);
                                        },
                                    );
                                }}
                            >
                                <FlashThumb layout={lay} />
                                <span className={styles.flashLayoutLabel}>
                                    {lay.label}
                                    <span className={styles.presetDesc}>
                                        自選前 {count} 檔
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </>
            )}
        </Menu>
    );
}

export function HudHeader({
    accBalance,
    onOpenPanelLibrary,
    profiles,
    currentWorkspace,
    onSaveProfile,
    onLoadProfile,
    onDeleteProfile,
    onRenameProfile,
    onResetWorkspace,
    onLoadPreset,
    workspaceUndo = null,
    onUndoWorkspace,
    flashCodes = [],
    selected = null,
    watchlistItems = [],
    onSelectCode,
    onAddWatchlist,
}: {
    accBalance?: number;
    onOpenPanelLibrary: () => void;
    flashCodes?: string[];
    profiles: Profile[];
    currentWorkspace: Workspace;
    onSaveProfile: (name: string, icon?: string) => void;
    onLoadProfile: (name: string) => void;
    onDeleteProfile: (name: string) => void;
    onRenameProfile: (oldName: string, newName: string) => void;
    onResetWorkspace: () => void;
    onLoadPreset: (name: string) => void;
    // Agent 套用版面規格後可復原的那一步（#331）；null = 沒有可復原的變更
    workspaceUndo?: { label: string; at: number } | null;
    onUndoWorkspace?: () => void;
    selected?: ContractInfo | null;
    watchlistItems?: WatchItem[];
    onSelectCode?: (
        code: string,
        type?: SecurityType,
    ) => Promise<unknown> | unknown;
    onAddWatchlist?: (
        code: string,
        type?: SecurityType,
        resolved?: ContractInfo,
    ) => Promise<unknown>;
}) {
    const streamStatus = useStreamStatus();
    const privMoney = usePrivacyMoney();
    const headerItems = useHeaderItems();
    const [simulation, setSimulation] = useState<boolean | null>(null);
    const attachment = useServerAttachment();
    // #285: a server another program started is labelled as such
    const external = attachment.kind === 'external' ? attachment : null;
    const [appVer, setAppVer] = useState('');
    const [now, setNow] = useState(() => new Date());
    const [serverMgrOpen, setServerMgrOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [layoutLibOpen, setLayoutLibOpen] = useState(false);

    const accountState = useAccounts();
    const { accounts, selectedStock, selectedFutures } = accountState;
    const esunEnv = useEsunEnvironment();
    const [envMenuOpen, setEnvMenuOpen] = useState(false);

    useEffect(() => {
        ensureAccounts();
        void esunTradeService.connectBridge();
    }, []);

    useEffect(() => {
        if (!envMenuOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setEnvMenuOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [envMenuOpen]);

    const activeAccount = getActiveAccount(accountState);
    const isEsunActive = isEsunAccount(activeAccount);

    const simProfile = esunEnv.configProfiles.SIMULATION;
    const prodProfile = esunEnv.configProfiles.PRODUCTION;
    const isSimDisabled = isEsunActive && !simProfile?.available;
    const isProdDisabled = isEsunActive && !prodProfile?.available;

    const activeIsSimulation = isEsunActive
        ? esunEnv.isSimulation
        : (simulation !== null ? simulation : true);

    const activeBrokerName = isEsunActive ? '玉山證券' : '永豐金證券';
    const activeBrokerShort = isEsunActive ? '玉山' : '永豐';

    const showToast = (body: string) => {
        notify({ kind: 'ok', title: '環境切換', body });
    };

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        listenTrayEvents(() => setServerMgrOpen(true)).then((un) => {
            cleanup = un;
        });
        const t = setTimeout(() => checkForUpdates(true), 8000);
        return () => {
            cleanup?.();
            clearTimeout(t);
        };
    }, []);

    useEffect(() => {
        void appVersion().then(setAppVer);
    }, []);

    useEffect(() => {
        // retry until the server answers — a one-shot fetch loses the race
        // against a daemon that is still starting after an app update
        let done = false;
        const load = () =>
            fetchInfo()
                .then((info) => {
                    done = true;
                    clearInterval(retry);
                    setSimulation(info.simulation);
                })
                .catch(() => undefined);
        const retry = setInterval(() => {
            if (!done) void load();
        }, 5000);
        void load();
        const t = setInterval(() => setNow(new Date()), 1000);
        return () => {
            clearInterval(t);
            clearInterval(retry);
        };
    }, []);

    return (
        <header className={styles.header}>
            <div className={styles.logoBlock}>
                <span className={styles.logoMark} aria-hidden="true" />
                <span className={styles.logoMain}>Shioaji Pro</span>
                <span className={styles.logoSub}>
                    交易終端
                    {appVer && ` · App ${appVer}`}
                </span>
            </div>

            <div className={styles.envMenuWrap}>
                <button
                    type="button"
                    className={activeIsSimulation ? styles.simBadge : styles.prodBadge}
                    data-testid="header-env-badge"
                    aria-haspopup="menu"
                    aria-expanded={envMenuOpen}
                    onClick={() => {
                        setEnvMenuOpen((prev) => {
                            const next = !prev;
                            if (next && isEsunActive) {
                                void esunEnv.refreshConfigProfiles();
                            }
                            return next;
                        });
                    }}
                    title={`${activeBrokerName}：${activeIsSimulation ? '模擬環境' : '正式環境'}（點擊展開切換選單）`}
                >
                    <span className={styles.envBadgeBroker}>{activeBrokerShort}</span>
                    <span>{activeIsSimulation ? '模擬環境' : '正式環境'}</span>
                    {external && <span className={styles.externalTag}>· 外部伺服器</span>}
                    <ChevronDown size={11} className={styles.envChevron} />
                </button>

                {envMenuOpen && (
                    <>
                        <div
                            className={styles.popoverBackdrop}
                            onClick={() => setEnvMenuOpen(false)}
                        />
                        <div
                            className={styles.envPopover}
                            data-testid="header-env-menu"
                            role="menu"
                        >
                            {/* Section 1: 帳號切換 (判定依據) */}
                            <div className={styles.envSection}>
                                <div className={styles.envSectionHeader}>
                                    <span className={styles.envSectionTitle}>帳號切換（判定依據）</span>
                                    <span className={styles.envActiveTag}>目前：{activeBrokerName}</span>
                                </div>
                                <div className={styles.envAccountList}>
                                    {accounts.map((acc) => {
                                        const isEsun = isEsunAccount(acc);
                                        const isSelected = Boolean(
                                            activeAccount &&
                                            activeAccount.broker_id === acc.broker_id &&
                                            activeAccount.account_id === acc.account_id &&
                                            activeAccount.account_type === acc.account_type
                                        );
                                        return (
                                            <button
                                                key={`${acc.broker_id}-${acc.account_id}`}
                                                type="button"
                                                className={isSelected ? styles.envAccountItemActive : styles.envAccountItem}
                                                onClick={() => {
                                                    selectAccount(acc);
                                                    invalidateAllQueries();
                                                    void refreshTradingState('all');
                                                }}
                                            >
                                                <span className={isEsun ? styles.brokerBadgeEsun : styles.brokerBadgeSj}>
                                                    {isEsun ? '玉山' : '永豐'}
                                                </span>
                                                <span className={styles.envAccountName}>
                                                    {acc.broker_id}-{acc.account_id} ({acc.account_type === 'S' ? '證券' : '期貨'})
                                                </span>
                                                {isSelected && <Check size={12} className={styles.checkIcon} />}
                                            </button>
                                        );
                                    })}
                                    {!accounts.some(isEsunAccount) && (
                                        <button
                                            type="button"
                                            className={styles.envAccountAddBtn}
                                            onClick={() => {
                                                const acc = esunTradeService.registerEsunAccount('88400664718');
                                                registerExternalAccounts([acc]);
                                                selectAccount(acc);
                                                invalidateAllQueries();
                                                void refreshTradingState('all');
                                            }}
                                        >
                                            ＋ 切換至玉山證券 (8840-0664718)
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Section 2: 環境切換 */}
                            <div className={styles.envSection}>
                                <div className={styles.envSectionHeader}>
                                    <span className={styles.envSectionTitle}>交易環境切換 ({activeBrokerName})</span>
                                </div>
                                <div className={styles.envOptionGroup}>
                                    <button
                                        type="button"
                                        data-testid="env-option-simulation"
                                        disabled={isSimDisabled}
                                        aria-disabled={isSimDisabled}
                                        className={isSimDisabled ? styles.envOptionDisabled : (activeIsSimulation ? styles.envOptionActive : styles.envOption)}
                                        onClick={async () => {
                                            if (isSimDisabled) return;
                                            if (isEsunActive) {
                                                const res = await esunEnv.switchEnvironment('SIMULATION');
                                                if (res.ok) {
                                                    invalidateAllQueries();
                                                    void refreshTradingStateForModeChange();
                                                    showToast(`已切換玉山證券至模擬環境 (${res.activeConfigFile ?? simProfile?.fileName ?? 'esun-config.simulation.ini'})`);
                                                    setEnvMenuOpen(false);
                                                } else {
                                                    notify({ kind: 'err', title: '環境切換失敗', body: res.error || '無法切換至模擬環境' });
                                                }
                                            } else {
                                                setSimulation(true);
                                                try {
                                                    localStorage.setItem('shioaji_simulation_override', 'true');
                                                } catch {}
                                                invalidateAllQueries();
                                                void refreshTradingStateForModeChange();
                                                showToast('已切換永豐金證券至模擬環境');
                                                setEnvMenuOpen(false);
                                            }
                                        }}
                                    >
                                        <div className={styles.envOptionTop}>
                                            <span className={styles.envOptionLabel}>模擬環境 (SIMULATION)</span>
                                            {isEsunActive && (
                                                simProfile?.available ? (
                                                    <span className={styles.configFileBadge}>{simProfile.fileName ?? 'esun-config.simulation.ini'}</span>
                                                ) : (
                                                    <span className={styles.missingConfigBadge}>未提供設定檔 (不可選)</span>
                                                )
                                            )}
                                            {activeIsSimulation && <Check size={12} className={styles.checkIcon} />}
                                        </div>
                                        <div className={styles.envOptionSubtitle}>
                                            {isEsunActive ? (
                                                simProfile?.available ? (
                                                    <>
                                                        <div>設定檔: {simProfile.fileName ?? 'esun-config.simulation.ini'}</div>
                                                        <div>Environment = SIMULATION</div>
                                                        <div>Entry = {ESUN_SIMULATION_ENTRY}</div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div>未偵測到模擬環境設定檔，請於專案根目錄提供：</div>
                                                        <div>esun-config.simulation.ini（或 esun-config.sim.ini）</div>
                                                    </>
                                                )
                                            ) : (
                                                <div>Shioaji Simulation = True</div>
                                            )}
                                        </div>
                                    </button>

                                    <button
                                        type="button"
                                        data-testid="env-option-production"
                                        disabled={isProdDisabled}
                                        aria-disabled={isProdDisabled}
                                        className={isProdDisabled ? styles.envOptionDisabled : (!activeIsSimulation ? styles.envOptionActive : styles.envOption)}
                                        onClick={async () => {
                                            if (isProdDisabled) return;
                                            if (isEsunActive) {
                                                const res = await esunEnv.switchEnvironment('PRODUCTION');
                                                if (res.ok) {
                                                    invalidateAllQueries();
                                                    void refreshTradingStateForModeChange();
                                                    showToast(`已切換玉山證券至正式環境 (${res.activeConfigFile ?? prodProfile?.fileName ?? 'esun-config.production.ini'})`);
                                                    setEnvMenuOpen(false);
                                                } else {
                                                    notify({ kind: 'err', title: '環境切換失敗', body: res.error || '無法切換至正式環境' });
                                                }
                                            } else {
                                                setSimulation(false);
                                                try {
                                                    localStorage.setItem('shioaji_simulation_override', 'false');
                                                } catch {}
                                                invalidateAllQueries();
                                                void refreshTradingStateForModeChange();
                                                showToast('已切換永豐金證券至正式環境');
                                                setEnvMenuOpen(false);
                                            }
                                        }}
                                    >
                                        <div className={styles.envOptionTop}>
                                            <span className={styles.envOptionLabel}>正式環境 (PRODUCTION)</span>
                                            {isEsunActive && (
                                                prodProfile?.available ? (
                                                    <span className={styles.configFileBadge}>{prodProfile.fileName ?? 'esun-config.production.ini'}</span>
                                                ) : (
                                                    <span className={styles.missingConfigBadge}>未提供設定檔 (不可選)</span>
                                                )
                                            )}
                                            {!activeIsSimulation && <Check size={12} className={styles.checkIcon} />}
                                        </div>
                                        <div className={styles.envOptionSubtitle}>
                                            {isEsunActive ? (
                                                prodProfile?.available ? (
                                                    <>
                                                        <div>設定檔: {prodProfile.fileName ?? 'esun-config.production.ini'}</div>
                                                        <div>無 Environment 資訊 (僅 Entry)</div>
                                                        <div>Entry = {ESUN_PRODUCTION_ENTRY}</div>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div>未偵測到正式環境設定檔，請於專案根目錄提供：</div>
                                                        <div>esun-config.production.ini（或 esun-config.prod.ini）</div>
                                                    </>
                                                )
                                            ) : (
                                                <div>Shioaji Simulation = False</div>
                                            )}
                                        </div>
                                    </button>
                                </div>
                                {isEsunActive && (
                                    <div className={styles.menuFooterHint}>
                                        💡 命名規範：測試 esun-config.simulation.ini ／ 正式 esun-config.production.ini
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>
            <ForeignServerChip />

            {headerItems.symbolSearch && (
                <HeaderSymbolSearch
                    selected={selected}
                    watchlistItems={watchlistItems}
                    onSelectCode={onSelectCode}
                    onAddWatchlist={onAddWatchlist}
                />
            )}

            <MarketBar />

            <div className={styles.spacer} />

            {headerItems.bankBalance && accBalance !== undefined && (
                <div className={`${styles.chip} ${styles.infoAutoHide.second}`}>
                    <span className={styles.chipLabel}>銀行水位</span>
                    <span>{maskMoney(fmtMoney(accBalance), privMoney)}</span>
                </div>
            )}

            {headerItems.liveStatus && (
                <div className={styles.chip}>
                    <span className={styles.led[streamStatus]} />
                    <span>{STATUS_LABEL[streamStatus]}</span>
                </div>
            )}

            <ServerManager
                open={serverMgrOpen}
                onToggle={setServerMgrOpen}
            />
            <KillSwitchButton />
            <button
                className={styles.resetBtn}
                onClick={onOpenPanelLibrary}
            >
                ＋ 新增面板
            </button>
            {headerItems.layoutLibrary && (
                <button
                    className={styles.resetBtn}
                    title='版面庫（預設版面/我的版面/儲存目前版面）'
                    onClick={() => setLayoutLibOpen(true)}
                >
                    <LayoutGrid size={11} style={{ verticalAlign: '-1px' }} />{' '}
                    版面
                </button>
            )}
            {workspaceUndo && onUndoWorkspace && (
                <button
                    className={styles.resetBtn}
                    title={`復原 Agent 版面變更「${workspaceUndo.label}」（${new Date(workspaceUndo.at).toLocaleTimeString('en-GB', { hour12: false })}）`}
                    onClick={onUndoWorkspace}
                >
                    <Undo2 size={11} style={{ verticalAlign: '-1px' }} />{' '}
                    復原版面
                </button>
            )}
            {headerItems.flashAll && flashCodes.length > 0 && (
                <FlashTilesMenu flashCodes={flashCodes} />
            )}
            <button
                className={styles.resetBtn}
                title='設定（外觀/音效與隱私/帳號/風控/版面）'
                onClick={() => setSettingsOpen(true)}
            >
                <Settings size={11} style={{ verticalAlign: '-1px' }} /> 設定
            </button>
            <SettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onResetWorkspace={onResetWorkspace}
                onOpenLayoutLibrary={() => setLayoutLibOpen(true)}
            />
            <LayoutLibrary
                open={layoutLibOpen}
                onClose={() => setLayoutLibOpen(false)}
                profiles={profiles}
                currentWorkspace={currentWorkspace}
                onSaveProfile={onSaveProfile}
                onLoadProfile={onLoadProfile}
                onDeleteProfile={onDeleteProfile}
                onRenameProfile={onRenameProfile}
                onLoadPreset={onLoadPreset}
            />

            {headerItems.clock && (
                <span className={`${styles.clock} ${styles.infoAutoHide.first}`}>
                    {now.toLocaleTimeString('en-GB', { hour12: false })}
                </span>
            )}
        </header>
    );
}
