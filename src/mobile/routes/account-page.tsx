// src/mobile/routes/account-page.tsx — 帳戶（規格 §6.7、§9.1、§10）
//
// MVP 區塊：帳號、資金、連線、伺服器、風控、顯示、診斷。額度、已實現損益、玉山重新連線屬 P1，顯示「即將提供」。
// - 資金：股票交割帳戶餘額＝useTradingState().funds（玉山帳戶在 src/lib 內部由 esunTradeService.fetchAccountBalance 取得）；
//   交割款＝src/lib/shioaji fetchSettlements（玉山帳戶在 src/lib 內部改走 esunTradeService.fetchSettlements）。
//   不自行輪詢（§9.1：永豐帳務 25 次／5 秒、玉山交割 3 次／分）；交割款在 SETTLEMENT_REUSE_MS 內重用上次結果。
// - 風控：一鍵鎖單、單筆上限、當日虧損上限。「手動下單確認」在手機版一律鎖定開啟、不可關閉（R4）；
//   這裡**不寫入** confirmManualOrders（那是桌面的設定）。鎖定只對本裝置有效（§10.6）。
// - 遮蔽金額：usePrivacyMoney＋maskMoney。

import { Lock, LockOpen } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useMonitorResource } from '../../hooks/use-monitor-resource';
import { useStreamStatus } from '../../hooks/use-stream';
import { useAccounts } from '../../lib/account-store';
import { esunTradeService, isEsunAccount, type EsunBridgeHealth } from '../../lib/esun';
import { getEsunStreamStatus } from '../../lib/esun/stream';
import { accountMatches } from '../../lib/flash-account';
import { maskMoney, setPrivacyMode, setPrivacyMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { setRiskSettings, useRiskSettings } from '../../lib/risk';
import { parseUsage, quotaState, type Usage } from '../../lib/server-monitor';
import { useServerInfo } from '../../lib/server-info-store';
import { settleDateLabel } from '../../lib/settle-date';
import { fetchHealth, fetchInfo, fetchSettlements, type Settlement } from '../../lib/shioaji';
import { getLastHeartbeat, streamConnectionEpoch, type StreamStatus } from '../../lib/stream';
import { setThemeSettings, useThemeSettings, type Convention, type FontScale, type ThemeMode } from '../../lib/theme-store';
import { useTradingState } from '../../lib/trading-state';
import type { Health } from '../../lib/types/health';
import type { Account, AccountFunds, Margin } from '../../lib/types/portfolio';
import { AccountSwitchSheet, mobileAccountLabel } from '../components/account-switch-sheet';
import { BottomSheet } from '../components/bottom-sheet';
import { RouteBadge, useOrderRoute } from '../components/route-badge';
import { SlideToConfirm } from '../components/slide-to-confirm';
import { readSecureContextDiagnostics } from '../lib/secure-context';
import * as controls from '../styles/controls.css';
import * as layout from '../styles/layout.css';
import * as styles from '../styles/account.css';

/** 交割款：這段時間內重用上次結果（玉山交割 25 秒快取、3 次／分；§9.1） */
export const SETTLEMENT_REUSE_MS = 30_000;
/** 伺服器資訊與玉山 health 的手動重新檢查冷卻 */
export const RECHECK_COOLDOWN_MS = 10_000;
/** 連線資訊（最後心跳、世代、玉山串流）是同步 getter：以這個間隔重新讀取 */
export const CONNECTION_REFRESH_MS = 2_000;
/** 每日流量重新讀取間隔 */
export const USAGE_REFRESH_MS = 60_000;

type Tone = 'normal' | 'muted' | 'accent' | 'good' | 'warn' | 'bad';

// ---------------------------------------------------------------------------
// 共用小元件與格式

function pad2(n: number) {
    return String(n).padStart(2, '0');
}

/** HH:mm:ss（本機時間）；沒有值顯示 — */
export function formatClock(ms: number | null | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 金額：$1,234；帶正負號時 +$1,234／−$1,234 */
export function formatTwd(v: number | undefined | null, signed = false): string {
    if (v === undefined || v === null || !Number.isFinite(v)) return '—';
    const abs = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (!signed) return `${v < 0 ? '−' : ''}$${abs}`;
    return v > 0 ? `+$${abs}` : v < 0 ? `−$${abs}` : '$0';
}

function mib(n: number): string {
    return `${(n / 1_048_576).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} MiB`;
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(t);
    }, [intervalMs]);
    return now;
}

function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        (l) => {
            if (typeof document === 'undefined') return () => undefined;
            document.addEventListener('visibilitychange', l);
            return () => document.removeEventListener('visibilitychange', l);
        },
        () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
        () => true,
    );
}

function Card({ title, extra, children, testId }: { title: string; extra?: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <section className={styles.card} data-testid={testId} aria-label={title}>
            <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>{title}</h2>
                {extra}
            </div>
            {children}
        </section>
    );
}

function Item({ term, children, tone = 'normal', testId }: { term: string; children: ReactNode; tone?: Tone; testId?: string }) {
    return (
        <>
            <dt className={styles.term}>{term}</dt>
            <dd className={`${styles.value} ${styles.tone[tone]}`} data-testid={testId}>{children}</dd>
        </>
    );
}

function Switch({ checked, onChange, label, disabled = false, testId }: { checked: boolean; onChange?: (next: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={styles.switchButton}
            onClick={() => { if (!disabled) onChange?.(!checked); }}
            data-testid={testId}
        >
            <span className={styles.switchTrack} aria-hidden='true'>
                <span className={styles.switchThumb} />
            </span>
        </button>
    );
}

function Segmented<T extends string | number>({ label, value, options, onChange, testId }: { label: string; value: T; options: { value: T; text: string }[]; onChange: (v: T) => void; testId?: string }) {
    return (
        <div className={styles.segmented} role='group' aria-label={label} data-testid={testId}>
            {options.map(o => (
                <button key={String(o.value)} type='button' className={styles.segment} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
                    {o.text}
                </button>
            ))}
        </div>
    );
}

function ComingSoon() {
    return <span className={styles.comingSoon}>即將提供</span>;
}

// ---------------------------------------------------------------------------
// 帳號

function brokerName(account: Account): string {
    return isEsunAccount(account) ? '玉山' : '永豐';
}

function AccountSlot({ label, account, priv }: { label: string; account: Account | null; priv: boolean }) {
    return (
        <div className={styles.slot}>
            <span className={styles.slotLabel}>{label}</span>
            <span className={styles.slotValue}>{account ? `${brokerName(account)} ${mobileAccountLabel(account, priv)}` : '未選擇'}</span>
            {account && <RouteBadge account={account} />}
        </div>
    );
}

function AccountsCard() {
    const state = useAccounts();
    const priv = usePrivacyMode();
    const [open, setOpen] = useState(false);
    return (
        <Card
            title='帳號'
            testId='account-accounts'
            extra={<button type='button' className={styles.smallButton} onClick={() => setOpen(true)} data-testid='account-switch-open'>切換帳戶</button>}
        >
            {!state.loaded && <p className={styles.note}>{state.loadError ? '帳戶載入失敗，請稍後再試。' : '帳戶載入中…'}</p>}
            <AccountSlot label='證券' account={state.selectedStock} priv={priv} />
            <AccountSlot label='期貨／選擇權' account={state.selectedFutures} priv={priv} />
            <AccountSwitchSheet open={open} onClose={() => setOpen(false)} />
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 資金

const settlementCache = new Map<string, { rows: Settlement[]; at: number }>();

/** 測試用：清除交割款快取 */
export function resetAccountPageCacheForTest(): void {
    settlementCache.clear();
}

function settlementKey(account: Account | null): string {
    return account ? `${account.account_type}:${account.broker_id}:${account.account_id}` : '';
}

interface SettlementState {
    key: string;
    rows: Settlement[] | null;
    at: number | null;
    loading: boolean;
    error: string | null;
}

function useSettlements(account: Account | null) {
    const key = settlementKey(account);
    const accountRef = useRef(account);
    accountRef.current = account;
    const [state, setState] = useState<SettlementState>(() => {
        const c = settlementCache.get(key);
        return { key, rows: c?.rows ?? null, at: c?.at ?? null, loading: false, error: null };
    });
    const [nonce, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        const acc = accountRef.current;
        const cached = settlementCache.get(key);
        if (!acc || !key) {
            setState({ key, rows: null, at: null, loading: false, error: null });
            return;
        }
        if (cached && Date.now() - cached.at < SETTLEMENT_REUSE_MS) {
            setState({ key, rows: cached.rows, at: cached.at, loading: false, error: null });
            return;
        }
        let active = true;
        setState(s => ({
            key,
            rows: s.key === key ? s.rows : cached?.rows ?? null,
            at: s.key === key ? s.at : cached?.at ?? null,
            loading: true,
            error: null,
        }));
        fetchSettlements(acc).then(
            rows => {
                const at = Date.now();
                settlementCache.set(key, { rows, at });
                if (active) setState({ key, rows, at, loading: false, error: null });
            },
            (e: unknown) => {
                if (active) setState(s => ({ ...s, key, loading: false, error: e instanceof Error && e.message ? e.message : '交割款查詢失敗' }));
            },
        );
        return () => { active = false; };
    }, [key, nonce]);

    const current = state.key === key ? state : { key, rows: null, at: null, loading: false, error: null };
    return { ...current, refresh: bump };
}

function fundsFor(funds: AccountFunds[] | undefined, account: Account | null): AccountFunds | undefined {
    if (!account) return undefined;
    return funds?.find(f => accountMatches(f.account, account));
}

function riskTone(margin: Margin): Tone {
    if (!(margin.initial_margin > 0 && margin.risk_indicator > 0)) return 'muted';
    if (margin.risk_indicator < 100) return 'bad';
    if (margin.risk_indicator < 200) return 'warn';
    return 'good';
}

function FundsCard() {
    const accounts = useAccounts();
    const trading = useTradingState();
    const privMoney = usePrivacyMoney();
    const now = useNow(5_000);
    const stock = accounts.selectedStock;
    const fut = accounts.selectedFutures;
    const stockRoute = useOrderRoute(stock);
    const futRoute = useOrderRoute(fut);
    const stockFunds = fundsFor(trading.funds, stock);
    const futFunds = fundsFor(trading.funds, fut);
    const settle = useSettlements(stock);
    const money = (v: number | undefined | null, signed = false) => maskMoney(formatTwd(v, signed), privMoney);

    const balance = stockFunds?.balance;
    const balanceSimBlank = stockRoute?.simulation === true && !!balance && balance.acc_balance === 0;
    const margin = futFunds?.margin;
    const marginSimBlank = futRoute?.simulation === true && !!margin
        && margin.equity === 0 && margin.initial_margin === 0 && margin.available_margin === 0 && margin.today_balance === 0;
    const settleRows = settle.rows ? [...settle.rows].sort((a, b) => a.T - b.T) : null;
    const canRefreshSettle = !!stock && !settle.loading && (settle.at === null || now - settle.at >= SETTLEMENT_REUSE_MS);

    return (
        <Card title='資金' testId='account-funds'>
            <h3 className={styles.subTitle}>股票{stock ? `（${brokerName(stock)}）` : ''}</h3>
            {!stock ? (
                <p className={styles.note}>尚未選擇證券帳戶。</p>
            ) : (
                <>
                    <dl className={styles.kv}>
                        <Item term='交割帳戶餘額' testId='funds-balance' tone={balanceSimBlank ? 'muted' : 'normal'}>
                            {balanceSimBlank ? '模擬環境無法查詢' : balance ? money(balance.acc_balance) : '—'}
                        </Item>
                        <Item term='資料時間' tone='muted'>{formatClock(stockFunds?.updatedAt)}</Item>
                    </dl>
                    {stockFunds?.error && <p className={styles.warning}>{stockFunds.error}</p>}
                    <h3 className={styles.subTitle}>交割款（正＝應收、負＝應付）</h3>
                    {settleRows && settleRows.length > 0 ? (
                        <dl className={styles.kv} data-testid='funds-settlements'>
                            {settleRows.map(row => (
                                <Item key={row.T} term={`${row.T === 0 ? 'T 日' : `T+${row.T}`} ${settleDateLabel(row.date)}`}>
                                    {money(row.amount, true)}
                                </Item>
                            ))}
                        </dl>
                    ) : (
                        <p className={styles.note}>{settle.loading ? '交割款查詢中…' : settleRows ? '沒有交割款資料。' : '—'}</p>
                    )}
                    {settle.error && <p className={styles.warning} role='alert'>{settle.error}</p>}
                    <div className={styles.actions}>
                        <span className={styles.note}>交割款資料時間 {formatClock(settle.at)}</span>
                        <button type='button' className={styles.smallButton} disabled={!canRefreshSettle} onClick={() => settle.refresh()} data-testid='funds-settle-refresh'>
                            更新交割款
                        </button>
                    </div>
                </>
            )}

            <h3 className={styles.subTitle}>期貨{fut ? `（${brokerName(fut)}）` : ''}</h3>
            {!fut ? (
                <p className={styles.note}>尚未選擇期貨帳戶。</p>
            ) : marginSimBlank ? (
                <p className={styles.note}>模擬環境無法查詢保證金。</p>
            ) : (
                <dl className={styles.kv}>
                    <Item term='權益數' testId='funds-equity'>{margin ? money(margin.equity) : '—'}</Item>
                    <Item term='可用保證金'>{margin ? money(margin.available_margin) : '—'}</Item>
                    <Item term='維持率' tone={margin ? riskTone(margin) : 'muted'}>
                        {margin && margin.initial_margin > 0 && margin.risk_indicator > 0 ? `${margin.risk_indicator.toFixed(1)}%` : '—'}
                    </Item>
                    <Item term='資料時間' tone='muted'>{formatClock(futFunds?.updatedAt)}</Item>
                </dl>
            )}
            {fut && futFunds?.error && <p className={styles.warning}>{futFunds.error}</p>}
            <p className={styles.note}>餘額與保證金隨帳務同步更新，不另外輪詢（避免觸及券商查詢頻率限制）。</p>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 連線

const STREAM_TEXT: Record<StreamStatus, string> = { live: 'LIVE', connecting: '連線中', down: '中斷', stale: '逾時（無心跳）' };
const STREAM_TONE: Record<StreamStatus, Tone> = { live: 'good', connecting: 'warn', down: 'bad', stale: 'bad' };
const ESUN_STREAM_TEXT: Record<string, string> = { idle: '未啟動', connecting: '連線中', live: 'LIVE', down: '中斷' };

function esunEnvText(h: EsunBridgeHealth): { text: string; tone: Tone } {
    if (h.environment === 'PRODUCTION') return { text: '正式', tone: 'bad' };
    if (h.environment === 'SIMULATION') return { text: '模擬', tone: 'accent' };
    return { text: '環境未確認', tone: 'warn' };
}

function useEsunHealth(): { health: EsunBridgeHealth | null; recheck: () => void; checking: boolean; canRecheck: boolean } {
    const [, force] = useReducer((n: number) => n + 1, 0);
    const [checking, setChecking] = useState(false);
    const [lastCheck, setLastCheck] = useState(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => esunTradeService.subscribe(force), []);
    const recheck = useCallback(() => {
        setChecking(true);
        setLastCheck(Date.now());
        void esunTradeService.refreshHealth().catch(() => null).finally(() => {
            if (!mounted.current) return;
            setChecking(false);
            force();
        });
    }, []);
    // 開啟頁面時讀一次（用 esunTradeService 既有的 health 取得方式，不自行 fetch）
    useEffect(() => { recheck(); }, [recheck]);
    const now = useNow(RECHECK_COOLDOWN_MS);
    return { health: esunTradeService.getBridgeHealth(), recheck, checking, canRecheck: !checking && now - lastCheck >= RECHECK_COOLDOWN_MS };
}

function ConnectionCard() {
    const stream = useStreamStatus();
    const now = useNow(CONNECTION_REFRESH_MS);
    const esun = useEsunHealth();
    const heartbeat = getLastHeartbeat();
    const ago = heartbeat ? Math.max(0, Math.round((now - heartbeat) / 1000)) : null;
    const h = esun.health;
    const esunStream = getEsunStreamStatus();

    return (
        <Card title='連線' testId='account-connection'>
            <h3 className={styles.subTitle}>永豐</h3>
            <dl className={styles.kv}>
                <Item term='行情串流' tone={STREAM_TONE[stream]} testId='conn-stream'>{STREAM_TEXT[stream]}</Item>
                <Item term='最後心跳'>{formatClock(heartbeat)}{ago !== null ? `（${ago} 秒前）` : ''}</Item>
                <Item term='連線世代'>{streamConnectionEpoch()}</Item>
            </dl>
            <h3 className={styles.subTitle}>玉山 bridge</h3>
            {!h ? (
                <p className={styles.note} data-testid='conn-esun-none'>{esun.checking ? '檢查中…' : '未連線或未設定玉山。'}</p>
            ) : (
                <dl className={styles.kv} data-testid='conn-esun'>
                    <Item term='設定' tone={h.configured ? 'normal' : 'warn'}>{h.configured ? '已設定' : '未設定'}</Item>
                    <Item term='登入' tone={h.loginLocked ? 'bad' : h.loggedIn ? 'good' : 'warn'}>
                        {h.loginLocked ? `登入已鎖定${h.loginLockReason ? `（${h.loginLockReason}）` : ''}` : h.loggedIn ? '已登入' : h.loginError ? `未登入（${h.loginError}）` : '未登入'}
                    </Item>
                    <Item term='環境' tone={esunEnvText(h).tone}>{esunEnvText(h).text}</Item>
                    <Item term='券商 session' tone={h.sessionExpired ? 'bad' : 'normal'}>{h.sessionExpired ? '已失效（委託會被拒絕）' : '有效'}</Item>
                    <Item term='券商 WebSocket' tone={h.wsConnected ? 'good' : 'warn'}>{h.wsConnected === undefined ? '—' : h.wsConnected ? '已連線' : '未連線'}</Item>
                </dl>
            )}
            <dl className={styles.kv}>
                <Item term='回報串流'>{ESUN_STREAM_TEXT[esunStream] ?? esunStream}</Item>
            </dl>
            <div className={styles.actions}>
                <button type='button' className={styles.smallButton} disabled={!esun.canRecheck} onClick={esun.recheck}>重新檢查玉山</button>
                <span className={styles.note}>玉山重新連線 <ComingSoon /></span>
            </div>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 伺服器

function caTone(health: Health | null): Tone {
    if (!health) return 'muted';
    if (health.ca_expired) return 'bad';
    const d = health.ca_expires_in_days;
    if (d === undefined) return 'muted';
    return d <= 7 ? 'bad' : d <= 30 ? 'warn' : 'normal';
}

function ServerCard() {
    const info = useServerInfo();
    const [health, setHealth] = useState<Health | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nonce, bump] = useReducer((n: number) => n + 1, 0);
    const [lastCheck, setLastCheck] = useState(0);
    const now = useNow(RECHECK_COOLDOWN_MS);
    const visible = useDocumentVisible();
    const usage = useMonitorResource<Usage>('/api/v1/auth/usage', visible, USAGE_REFRESH_MS, parseUsage);
    const quota = quotaState(usage.data);

    useEffect(() => {
        const controller = new AbortController();
        setLastCheck(Date.now());
        setError(null);
        fetchInfo().catch(() => undefined);
        fetchHealth({ signal: controller.signal }).then(
            h => { if (!controller.signal.aborted) setHealth(h); },
            () => { if (!controller.signal.aborted) setError('伺服器狀態讀取失敗'); },
        );
        return () => controller.abort();
    }, [nonce]);

    const mode = info?.simulation === true ? { text: '模擬', tone: 'accent' as Tone } : info?.simulation === false ? { text: '正式', tone: 'bad' as Tone } : { text: '未確認', tone: 'warn' as Tone };
    const ca = !health ? '—' : health.ca_expired ? '已過期' : health.ca_expires_in_days !== undefined ? `${health.ca_expires_in_days} 天` : '—';
    const quotaFill = quota.tone === 'danger' ? 'danger' : quota.tone === 'warning' ? 'warning' : quota.tone === 'muted' ? 'muted' : 'normal';

    return (
        <Card title='伺服器' testId='account-server'>
            <dl className={styles.kv}>
                <Item term='版本'>{info?.version ?? health?.version ?? '—'}</Item>
                <Item term='模擬／正式' tone={mode.tone} testId='server-mode'>{mode.text}</Item>
                <Item term='憑證剩餘' tone={caTone(health)}>{ca}</Item>
                {health?.session_recovering && <Item term='券商連線' tone='warn'>自動恢復中</Item>}
                <Item term='每日流量' tone={quota.tone === 'danger' ? 'bad' : quota.tone === 'warning' ? 'warn' : 'normal'} testId='server-usage'>
                    {usage.data ? `${mib(usage.data.bytes)} / ${usage.data.limit_bytes > 0 ? mib(usage.data.limit_bytes) : '未知'}` : usage.error ? '讀取失敗' : '—'}
                </Item>
            </dl>
            {usage.data && (
                <>
                    <div className={styles.meter} aria-hidden='true'>
                        <span className={styles.meterFill[quotaFill]} style={{ width: `${Math.min(100, Math.max(0, quota.percent ?? 0))}%` }} />
                    </div>
                    <p className={styles.note}>{quota.label}{quota.percent !== null ? `（${quota.percent.toFixed(1)}%）` : ''}</p>
                </>
            )}
            {error && <p className={styles.warning}>{error}</p>}
            <div className={styles.actions}>
                <button type='button' className={styles.smallButton} disabled={now - lastCheck < RECHECK_COOLDOWN_MS} onClick={bump}>重新讀取</button>
            </div>
            <p className={styles.note}>模擬／正式由伺服器部署決定，手機版不能切換。</p>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 風控

function parseLimit(raw: string): number | null {
    const s = raw.trim().replace(/,/g, '');
    if (s === '') return 0;
    if (!/^\d{1,9}$/.test(s)) return null;
    return Number(s);
}

function LimitInput({ label, hint, value, onCommit, masked, testId }: {
    label: string;
    hint: string;
    value: number;
    onCommit: (v: number) => void;
    masked: boolean;
    testId: string;
}) {
    const [draft, setDraft] = useState(String(value || ''));
    const [invalid, setInvalid] = useState(false);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) setDraft(String(value || ''));
    }, [value]);
    const commit = () => {
        editing.current = false;
        const v = parseLimit(draft);
        if (v === null) {
            setInvalid(true);
            setDraft(String(value || ''));
            return;
        }
        setInvalid(false);
        if (v !== value) onCommit(v);
        setDraft(String(v || ''));
    };
    return (
        <div className={styles.settingRow}>
            <span className={styles.settingLabel}>
                <span>{label}</span>
                <span className={styles.settingHint}>{invalid ? '請輸入 0 或正整數（0＝不限制）' : hint}</span>
            </span>
            <input
                className={styles.numberInput}
                type={masked ? 'password' : 'text'}
                inputMode='numeric'
                pattern='[0-9]*'
                enterKeyHint='done'
                autoComplete='off'
                aria-label={label}
                aria-invalid={invalid}
                placeholder='不限制'
                value={masked ? (value ? '•••••' : '') : draft}
                disabled={masked}
                onFocus={() => { editing.current = true; }}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as { blur?: () => void }).blur?.(); }}
                data-testid={testId}
            />
        </div>
    );
}

function RiskUnlockSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <BottomSheet open={open} onClose={onClose} title='解除鎖單' testId='account-risk-unlock-sheet'>
            <p className={styles.note}>解除後可以再下新單。此鎖定只對本裝置（這個瀏覽器）有效，不會影響桌面或其他裝置。</p>
            <div className={styles.actions}>
                <SlideToConfirm
                    label='滑動解除鎖單'
                    tone='danger'
                    testId='account-risk-unlock-slide'
                    onConfirm={() => {
                        setRiskSettings({ locked: false });
                        onClose();
                    }}
                />
            </div>
        </BottomSheet>
    );
}

function RiskCard() {
    const risk = useRiskSettings();
    const privMoney = usePrivacyMoney();
    const [unlockOpen, setUnlockOpen] = useState(false);
    useEffect(() => { if (!risk.locked) setUnlockOpen(false); }, [risk.locked]);

    return (
        <Card title='風控' testId='account-risk'>
            {risk.locked ? (
                <div className={styles.lockState.locked} role='status' data-testid='risk-lock-state'>
                    <Lock size={18} aria-hidden='true' /> 已鎖單：所有新單都會被擋下
                </div>
            ) : (
                <div className={styles.lockState.open} data-testid='risk-lock-state'>
                    <LockOpen size={18} aria-hidden='true' /> 未鎖單
                </div>
            )}
            <div className={styles.actions}>
                {risk.locked ? (
                    <button type='button' className={controls.button.neutral} onClick={() => setUnlockOpen(true)} data-testid='risk-unlock'>解除鎖單…</button>
                ) : (
                    <button type='button' className={controls.button.danger} onClick={() => setRiskSettings({ locked: true })} data-testid='risk-lock'>立即鎖單</button>
                )}
            </div>
            <p className={styles.deviceOnly} data-testid='risk-device-only'>
                此鎖定只對本裝置有效（這個瀏覽器）；不會同步到桌面或其他裝置，也沒有伺服器端總開關。
            </p>

            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>啟用下單限制</span>
                    <span className={styles.settingHint}>單筆上限與當日虧損上限</span>
                </span>
                <Switch checked={risk.enabled} label='啟用下單限制' onChange={v => setRiskSettings({ enabled: v })} testId='risk-enabled' />
            </div>
            <LimitInput
                label='單筆上限（張／口）'
                hint='0＝不限制；零股以張的比例計'
                value={risk.maxQty}
                masked={false}
                onCommit={v => setRiskSettings({ maxQty: v })}
                testId='risk-max-qty'
            />
            <LimitInput
                label='當日虧損上限（元）'
                hint={privMoney ? '關閉遮蔽金額後可編輯' : '0＝不限制；達上限後封鎖新單'}
                value={risk.maxDailyLoss}
                masked={privMoney}
                onCommit={v => setRiskSettings({ maxDailyLoss: v })}
                testId='risk-max-loss'
            />
            <div className={styles.settingRow} data-testid='risk-manual-confirm'>
                <span className={styles.settingLabel}>
                    <span>手動下單確認 <span className={styles.lockedOnBadge}><Lock size={12} aria-hidden='true' /> 鎖定開啟</span></span>
                    <span className={styles.settingHint}>手機版每筆委託一律經確認面板滑動確認，無法關閉。</span>
                </span>
                <Switch checked label='手動下單確認（鎖定開啟，無法關閉）' disabled testId='risk-manual-confirm-switch' />
            </div>
            <RiskUnlockSheet open={unlockOpen && risk.locked} onClose={() => setUnlockOpen(false)} />
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 顯示

function DisplayCard() {
    const theme = useThemeSettings();
    const privMoney = usePrivacyMoney();
    const priv = usePrivacyMode();
    const modes: { value: ThemeMode; text: string }[] = [
        { value: 'dark', text: '深色' },
        { value: 'light', text: '淺色' },
        ...(theme.custom || theme.mode === 'custom' ? [{ value: 'custom' as ThemeMode, text: '自訂' }] : []),
    ];
    return (
        <Card title='顯示' testId='account-display'>
            <div className={styles.settingBlock}>
                <span>主題</span>
                <Segmented label='主題' value={theme.mode} options={modes} onChange={mode => setThemeSettings({ mode })} testId='display-mode' />
            </div>
            <div className={styles.settingBlock}>
                <span>漲跌配色</span>
                <Segmented<Convention>
                    label='漲跌配色'
                    value={theme.convention}
                    options={[{ value: 'tw', text: '台灣（紅漲綠跌）' }, { value: 'intl', text: '國際（綠漲紅跌）' }]}
                    onChange={convention => setThemeSettings({ convention })}
                    testId='display-convention'
                />
            </div>
            <div className={styles.settingBlock}>
                <span>字級</span>
                <Segmented<FontScale>
                    label='字級'
                    value={theme.fontScale}
                    options={[{ value: 1, text: '小' }, { value: 1.15, text: '標準' }, { value: 1.3, text: '大' }]}
                    onChange={fontScale => setThemeSettings({ fontScale })}
                    testId='display-font'
                />
            </div>
            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>遮蔽金額</span>
                    <span className={styles.settingHint}>餘額、損益、交割款以 ••••• 顯示</span>
                </span>
                <Switch checked={privMoney} label='遮蔽金額' onChange={setPrivacyMoney} testId='display-privacy-money' />
            </div>
            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>遮蔽帳號</span>
                    <span className={styles.settingHint}>帳號只露末兩碼</span>
                </span>
                <Switch checked={priv} label='遮蔽帳號' onChange={setPrivacyMode} testId='display-privacy-account' />
            </div>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// 診斷

function DiagnosticsCard() {
    const [d] = useState(() => readSecureContextDiagnostics());
    const yes = (ok: boolean) => (ok ? '支援' : '不支援');
    return (
        <Card title='診斷' testId='account-diagnostics'>
            <dl className={styles.kv}>
                <Item term='Secure context' tone={d.isSecureContext ? 'good' : 'bad'}>{d.isSecureContext ? '是（HTTPS）' : '否'}</Item>
                <Item term='Web Locks' tone={d.webLocks ? 'good' : 'bad'}>{yes(d.webLocks)}</Item>
                <Item term='BroadcastChannel' tone={d.broadcastChannel ? 'good' : 'bad'}>{yes(d.broadcastChannel)}</Item>
                <Item term='來源'>{d.origin || '—'}</Item>
                <Item term='建置版本' testId='diag-build'>{d.buildVersion}</Item>
                <dt className={styles.term}>User Agent</dt>
                <dd className={styles.ua}>{d.userAgent || '—'}</dd>
            </dl>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// P1

function ComingSoonCard() {
    return (
        <Card title='更多帳務' testId='account-coming-soon'>
            <dl className={styles.kv}>
                <Item term='買賣額度、資券額度'><ComingSoon /></Item>
                <Item term='已實現損益'><ComingSoon /></Item>
                <Item term='玉山重新連線'><ComingSoon /></Item>
            </dl>
            <p className={styles.note}>這些功能目前請使用桌面版。</p>
        </Card>
    );
}

export function AccountPage() {
    return (
        <section className={layout.page} data-testid='page-account'>
            <h1 className={layout.pageTitle}>帳戶</h1>
            <AccountsCard />
            <FundsCard />
            <RiskCard />
            <ConnectionCard />
            <ServerCard />
            <DisplayCard />
            <DiagnosticsCard />
            <ComingSoonCard />
        </section>
    );
}
