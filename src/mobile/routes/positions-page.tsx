// src/mobile/routes/positions-page.tsx — 持倉（規格 §6.6）
//
// - 資料：useTradingState().positions（含帳戶；現價隨即時 tick 更新）；帳戶篩選「全部」或單一帳戶；
//   queries.positions 的對帳原因 banner；「⟳」＝refreshTradingState('positions')，6 秒冷卻。
// - 合計：未實現損益合計，標示「（估）」（券商持倉＋即時價推估）；金額遮蔽用 usePrivacyMoney＋maskMoney。
//   持倉尚未讀到（queries.positions.updatedAt 為 null 且沒有任何持倉列）時顯示「—」，不顯示 0。
// - 平倉：先開說明面板寫明行為，使用者按「繼續」才呼叫 src/lib；lib 內部會再出現一次確認面板
//   （根層 order-confirm-sheet，手機已強制開啟 confirmManualOrders），確認只出現一次。
//   · 股票：stockExitFor() 回傳原因時不送出；否則 placeStockExitByShares()（整張市價 IOC、零股以漲跌停價盤中零股限價）。
//   · 期貨／選擇權：placeQuickOrder(…, null, 口數, { ocType: 'Cover', source: 'manual' })（市價 IOC）。
//   · beforeSend 內同步呼叫 assertResumeReady()；useTradingLive() 為 false 或 ResumeGate 不允許時停用。
//   · ResumeGate 為 stale-data：頁面 banner 與平倉說明面板都提供 ResumeGateNote（勾選「我了解委託／持倉資料可能過期」
//     ＝acknowledgeStaleData()、「重試同步」＝retryResume()）；勾選後才可平倉。
//   · 結果依 §7.2：已取消、未送出（顯示原因，可重試）、結果未知（不自動重送、不提供重送鍵）。股票不提供反手。
// - 加碼：開啟下單面板並帶入同方向；下單面板以「目前選取的帳戶」下單，持倉帳戶不同時先確認切換帳戶。
//   信用部位（融資／融券）在 MVP 下單面板沒有信用條件 → 停用並說明。
// - 看圖：navigate({ name: 'trade', code })。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTradingLive } from '../../hooks/use-stream';
import { getAccountState, selectAccount, useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { accountMatches } from '../../lib/flash-account';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { maskMoney, secretMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { creditExitLabel, stockExitFor, type CreditExitCond } from '../../lib/stock-exit-cond';
import { notify, placeQuickOrder, placeStockExitByShares } from '../../lib/trade';
import { RECONCILE_REASON_LABELS, refreshTradingState, useTradingState, type TradingQueryStatus } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action } from '../../lib/types/order';
import type { Account, AccountedPosition, Position, StockPosition } from '../../lib/types/portfolio';
import { fmtInt, fmtPrice, fmtSigned, fmtStockLots } from '../../lib/utils/format';
import { mobileAccountLabel, useAccountSwitchLocked } from '../components/account-switch-sheet';
import { BottomSheet } from '../components/bottom-sheet';
import { ResumeGateNote } from '../components/resume-gate-note';
import { RouteBadge } from '../components/route-badge';
import { classifyTicketOutcome, OUTCOME_UNKNOWN_TITLE } from '../hooks/use-mobile-ticket';
import { useResumeGate } from '../hooks/use-resume-gate';
import { navigate } from '../lib/hash-router';
import { openTicket } from '../lib/mobile-store';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { assertResumeReady, getResumeGate, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import * as controls from '../styles/controls.css';
import * as layout from '../styles/layout.css';
import * as styles from '../styles/positions.css';

/** 「⟳」更新持倉的冷卻時間 */
export const REFRESH_COOLDOWN_MS = 6_000;

export const POSITIONS_TEXT = {
    loading: '持倉載入中…',
    empty: '目前沒有持倉',
    notLive: '行情／交易連線未就緒，暫停平倉',
    resyncing: '回到前景後正在重新同步行情與委託，暫停平倉',
    staleData: '委託／持倉資料可能過期：請按「重試同步」，或勾選「我了解委託／持倉資料可能過期」後再平倉',
    resumeFailed: '連線未恢復，暫停平倉；請重新整理頁面',
    creditAddOn: '信用交易加碼將於後續版本提供',
    shortCashAddOn: '現股空單（當沖先賣）加碼將於後續版本提供',
    noAccount: '持倉帳戶歸屬不明，未送出委託',
    noAccountAddOn: '持倉帳戶歸屬不明，無法加碼',
    accountNotTradable: '持倉帳戶目前不可交易（未簽署）',
    marketMismatch: '持倉單位與帳戶市場不符，未送出委託',
    badQuantity: '持倉數量或方向不明，未送出委託',
    noContract: '商品資料（含漲跌停價）尚未載入，暫時無法平倉',
    contractMismatch: '商品與持倉帳戶市場不符，未送出委託',
    noLimits: '漲跌停價未知，暫時無法平倉',
    gone: '這筆持倉已不在清單中（可能已平倉或已更新）',
    switchLocked: '下單面板開啟或確認進行中，暫時不能切換帳戶。',
    switchFailed: '帳戶切換未成功，請到「帳戶」頁確認後再試',
    closeSent: '平倉委託已送出',
    cancelled: '已取消',
} as const;

// ---- 純函式（測試用匯出）----

export function isStockPosition(p: Position): p is StockPosition {
    return 'yd_quantity' in p;
}

function accountKey(a: Pick<Account, 'account_type' | 'broker_id' | 'account_id'> | null | undefined): string {
    return a ? `${a.account_type}:${a.broker_id}:${a.account_id}` : '';
}

/** 列的識別（不含數量：數量變動時說明面板跟著顯示最新值） */
export function positionKey(p: AccountedPosition): string {
    const cond = isStockPosition(p) ? p.cond ?? '' : '';
    return `${accountKey(p.account)}|${p.code}|${p.direction}|${cond}|${p.id}`;
}

const STOCK_COND_TEXT: Record<string, string> = { Cash: '現股', MarginTrading: '融資', ShortSelling: '融券' };

/** 條件欄：股票＝現股／融資／融券（其他條件原樣顯示）；期權依商品別 */
export function positionCondText(p: Position, contract?: Pick<ContractInfo, 'security_type'>): string {
    if (isStockPosition(p)) {
        const c = p.cond || 'Cash';
        return STOCK_COND_TEXT[c] ?? c;
    }
    return contract?.security_type === 'OPT' ? '選擇權' : contract?.security_type === 'FUT' ? '期貨' : '期權';
}

export function sideText(direction: string): string {
    return direction === 'Buy' ? '多' : direction === 'Sell' ? '空' : '—';
}

/** 數量：股票以股為單位（張＋股），期權為口 */
export function positionQtyText(p: Position): string {
    return isStockPosition(p) ? fmtStockLots(p.quantity) : `${fmtInt(p.quantity)} 口`;
}

export function pnlTone(v: number): 'up' | 'down' | 'flat' {
    return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

/** 對帳 banner 文字；不需要時回傳 null */
export function reconcileText(q: Pick<TradingQueryStatus, 'needsReconcile' | 'error' | 'reasons'> | undefined): string | null {
    if (!q || (!q.needsReconcile && !q.error)) return null;
    const labels = (q.reasons ?? []).map(r => RECONCILE_REASON_LABELS[r]).filter(Boolean);
    const head = labels.length
        ? `待對帳：${labels.slice(0, 2).join('、')}${labels.length > 2 ? ` 等 ${labels.length} 項` : ''}`
        : q.error ? '持倉查詢失敗' : '待對帳';
    return `${head}——持倉與損益可能不完整，請按「⟳」更新後核對`;
}

/** ResumeGate／連線不允許平倉的原因；允許時回傳 null */
export function closeGateProblem(live: boolean, gate: Pick<ResumeGateSnapshot, 'state' | 'staleAcknowledged'>): string | null {
    if (!live) return POSITIONS_TEXT.notLive;
    if (resumeAllowsNewOrders(gate.state, gate.staleAcknowledged)) return null;
    if (gate.state === 'resyncing') return POSITIONS_TEXT.resyncing;
    if (gate.state === 'stale-data') return POSITIONS_TEXT.staleData;
    return POSITIONS_TEXT.resumeFailed;
}

export type ClosePlan =
    | { kind: 'stock'; account: Account; contract: ContractInfo; action: Action; shares: number; orderCond?: CreditExitCond }
    | { kind: 'futures'; account: Account; contract: ContractInfo; action: Action; lots: number };

/**
 * 平倉方式（只作送出前的檢查與說明；真正的規則仍由 src/lib 在送出時再驗一次）。
 * 不支援回原因字串（不得送出）。持倉帳戶不得以目前選取帳戶補猜。
 */
export function closePlanFor(p: AccountedPosition, contract: ContractInfo | undefined): ClosePlan | string {
    const account = p.account;
    if (!account || !account.broker_id || !account.account_id || !['S', 'F'].includes(account.account_type)) return POSITIONS_TEXT.noAccount;
    if (!canTrade(account)) return POSITIONS_TEXT.accountNotTradable;
    const stock = isStockPosition(p);
    if ((stock ? 'S' : 'F') !== account.account_type) return POSITIONS_TEXT.marketMismatch;
    if (!Number.isSafeInteger(p.quantity) || p.quantity <= 0 || (p.direction !== 'Buy' && p.direction !== 'Sell')) return POSITIONS_TEXT.badQuantity;
    if (stock) {
        const exit = stockExitFor(p.direction, p.cond, p.quantity);
        if (typeof exit === 'string') return exit;
        if (!contract) return POSITIONS_TEXT.noContract;
        if (contract.security_type !== 'STK') return POSITIONS_TEXT.contractMismatch;
        if (!(contract.limit_up > 0) || !(contract.limit_down > 0)) return POSITIONS_TEXT.noLimits;
        return { kind: 'stock', account, contract, action: exit.exit, shares: p.quantity, ...(exit.orderCond ? { orderCond: exit.orderCond } : {}) };
    }
    if (!contract) return POSITIONS_TEXT.noContract;
    if (contract.security_type !== 'FUT' && contract.security_type !== 'OPT') return POSITIONS_TEXT.contractMismatch;
    return { kind: 'futures', account, contract, action: p.direction === 'Buy' ? 'Sell' : 'Buy', lots: p.quantity };
}

/** 送出前（lib 的 beforeSend）同步檢查 ResumeGate；不允許時丟出 mutationNotStarted 錯誤 */
export function closeBeforeSend(): void {
    assertResumeReady({ allowStale: getResumeGate().staleAcknowledged });
}

/** 依平倉方式呼叫 src/lib（lib 內部會開確認面板，確認只出現一次） */
export async function executeClose(plan: ClosePlan): Promise<void> {
    if (plan.kind === 'stock') {
        await placeStockExitByShares(plan.contract, plan.action, plan.shares, plan.account, { orderCond: plan.orderCond, beforeSend: closeBeforeSend });
        return;
    }
    await placeQuickOrder(plan.contract, plan.action, null, plan.lots, {
        account: plan.account,
        ocType: 'Cover',
        source: 'manual',
        beforeSend: closeBeforeSend,
    });
}

/** 加碼不可用的原因（與帳戶切換無關的部分）；可用時回傳 null */
export function addOnBlockReason(p: AccountedPosition): string | null {
    if (!p.account) return POSITIONS_TEXT.noAccountAddOn;
    if (isStockPosition(p)) {
        const c = p.cond || 'Cash';
        if (c !== 'Cash') return POSITIONS_TEXT.creditAddOn;
        // MVP 下單面板不提供當沖先賣：現股空單同向加碼會變成無庫存的現股賣出
        if (p.direction === 'Sell') return POSITIONS_TEXT.shortCashAddOn;
    }
    return null;
}

function closeActionText(plan: ClosePlan): string {
    const side = plan.action === 'Buy' ? '買進' : '賣出';
    if (plan.kind === 'stock') return `${creditExitLabel(plan.orderCond)}${side}`;
    return `平倉${side}`;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''));

// ---- 元件 ----

interface RowProps {
    p: AccountedPosition;
    priv: boolean;
    privMoney: boolean;
    closeDisabled: boolean;
    addOnReason: string | null;
    onClose: () => void;
    onAddOn: () => void;
}

function PositionRow({ p, priv, privMoney, closeDisabled, addOnReason, onClose, onAddOn }: RowProps) {
    const contract = useContract(p.code);
    const long = p.direction === 'Buy';
    return (
        <li className={styles.row} data-testid='position-row' data-code={p.code}>
            <div className={styles.rowHead}>
                <span className={styles.rowCode}>{p.code}</span>
                {contract?.name && <span className={styles.rowName}>{contract.name}</span>}
                <span className={styles.tag}>{positionCondText(p, contract)}</span>
                <span className={long ? styles.side.long : styles.side.short}>{sideText(p.direction)}</span>
                <span>{maskMoney(positionQtyText(p), privMoney)}</span>
            </div>
            <div className={styles.rowMeta}>
                <RouteBadge account={p.account} />
                {p.account && <span>{mobileAccountLabel(p.account, priv)}</span>}
            </div>
            <div className={styles.rowNums}>
                <span><span className={styles.numLabel}>均價</span>{fmtPrice(p.price)}</span>
                <span><span className={styles.numLabel}>現價</span>{fmtPrice(p.last_price)}</span>
                <span>
                    <span className={styles.numLabel}>損益（估）</span>
                    <span className={styles.tone[pnlTone(p.pnl)]} data-testid='position-pnl'>{maskMoney(fmtSigned(p.pnl, 0), privMoney)}</span>
                </span>
            </div>
            <div className={styles.rowActions}>
                <button type='button' className={controls.button.neutral} disabled={closeDisabled} onClick={onClose} data-testid='position-close'>平倉</button>
                <button type='button' className={controls.button.neutral} disabled={addOnReason !== null} onClick={onAddOn} data-testid='position-add'>加碼</button>
                <button type='button' className={controls.button.ghost} onClick={() => navigate({ name: 'trade', code: p.code })} data-testid='position-chart'>看圖</button>
            </div>
            {addOnReason && <p className={styles.rowNote} data-testid='position-add-note'>{addOnReason}</p>}
        </li>
    );
}

interface CloseSheetProps {
    position: AccountedPosition | undefined;
    gate: ResumeGateSnapshot;
    gateProblem: string | null;
    busy: boolean;
    feedback: { kind: 'cancelled' | 'notSent'; text: string } | null;
    privMoney: boolean;
    onCancel: () => void;
    onContinue: (plan: ClosePlan) => void;
}

function CloseSheet({ position, gate, gateProblem, busy, feedback, privMoney, onCancel, onContinue }: CloseSheetProps) {
    const contract = useContract(position?.code ?? null);
    const plan = position ? closePlanFor(position, contract) : POSITIONS_TEXT.gone;
    const problem = typeof plan === 'string' ? plan : gateProblem;
    const stock = position ? isStockPosition(position) : false;
    return (
        <BottomSheet open onClose={onCancel} dismissible={!busy} title='平倉說明' testId='position-close-sheet'>
            {position && (
                <p className={styles.sheetSummary}>
                    {position.code}{contract?.name ? ` ${contract.name}` : ''} {positionCondText(position, contract)} {sideText(position.direction)}{' '}
                    {maskMoney(positionQtyText(position), privMoney)}
                    {typeof plan !== 'string' && ` → 市價${closeActionText(plan)}`}
                </p>
            )}
            {position?.account && <p className={styles.sheetText}><RouteBadge account={position.account} size='lg' /></p>}
            {stock ? (
                <ul className={styles.sheetList}>
                    <li>整張以市價（IOC）送出，未成交部分自動取消。</li>
                    <li>零股以{position?.direction === 'Buy' ? '跌停價' : '漲停價'}的盤中零股限價送出（可立即成交的價格）。</li>
                    <li>信用部位（融資／融券）只能整張了結；零股不能以信用條件送出。</li>
                    <li>市價成交價可能與現價有落差。股票不提供反手。</li>
                </ul>
            ) : (
                <ul className={styles.sheetList}>
                    <li>以市價（IOC）、倉別「平倉」送出全部口數，未成交部分自動取消。</li>
                    <li>市價成交價可能與現價有落差。</li>
                </ul>
            )}
            <p className={styles.sheetText}>按「繼續」後會出現確認面板，滑動確認後才會送出；確認只出現一次。</p>
            {problem && <p className={styles.sheetProblem} role='alert' data-testid='position-close-problem'>{problem}</p>}
            <ResumeGateNote gate={gate} disabled={busy} showReason={false} testId='position-close-stale' />
            {feedback && (
                <p className={styles.sheetFeedback[feedback.kind]} role='status' data-testid='position-close-feedback'>{feedback.text}</p>
            )}
            <div className={styles.sheetActions}>
                <button type='button' className={controls.button.neutral} disabled={busy} onClick={onCancel}>取消</button>
                <button
                    type='button'
                    className={controls.button.primary}
                    disabled={busy || problem !== null || typeof plan === 'string'}
                    onClick={() => { if (typeof plan !== 'string' && !problem) onContinue(plan); }}
                    data-testid='position-close-continue'
                >
                    {busy ? '等待確認…' : '繼續'}
                </button>
            </div>
        </BottomSheet>
    );
}

interface SwitchSheetProps {
    position: AccountedPosition | undefined;
    current: Account | null;
    priv: boolean;
    locked: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
}

function AddOnSwitchSheet({ position, current, priv, locked, error, onCancel, onConfirm }: SwitchSheetProps) {
    const target = position?.account;
    return (
        <BottomSheet open onClose={onCancel} title='切換帳戶後加碼' testId='position-switch-sheet'>
            {target ? (
                <>
                    <p className={styles.sheetText}>
                        下單面板以「目前選取的帳戶」下單。這筆持倉屬於 {isEsunAccount(target) ? '玉山' : '永豐'} {mobileAccountLabel(target, priv)}，
                        目前選取的是 {current ? `${isEsunAccount(current) ? '玉山' : '永豐'} ${mobileAccountLabel(current, priv)}` : '（未選擇）'}。
                    </p>
                    <p className={styles.sheetText}><RouteBadge account={target} size='lg' /></p>
                    <p className={styles.sheetText}>要切換到持倉帳戶並開啟下單面板嗎？下單面板內仍需預覽並滑動確認才會送出。</p>
                </>
            ) : (
                <p className={styles.sheetProblem}>{POSITIONS_TEXT.gone}</p>
            )}
            {locked && <p className={styles.sheetProblem} role='status'>{POSITIONS_TEXT.switchLocked}</p>}
            {error && <p className={styles.sheetProblem} role='alert' data-testid='position-switch-error'>{error}</p>}
            <div className={styles.sheetActions}>
                <button type='button' className={controls.button.neutral} onClick={onCancel}>取消</button>
                <button type='button' className={controls.button.primary} disabled={locked || !target} onClick={onConfirm} data-testid='position-switch-confirm'>
                    切換並開啟
                </button>
            </div>
        </BottomSheet>
    );
}

export function PositionsPage() {
    const trading = useTradingState();
    const accounts = useAccounts();
    const live = useTradingLive();
    const gate = useResumeGate();
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const switchLocked = useAccountSwitchLocked();

    const positions = trading.positions;
    const query = trading.queries.positions;

    // ---- 帳戶篩選 ----
    const accountOptions = useMemo(() => {
        const map = new Map<string, Account>();
        for (const p of positions) if (p.account) map.set(accountKey(p.account), p.account);
        return [...map.entries()];
    }, [positions]);
    const [filterKey, setFilterKey] = useState('');
    const activeFilter = accountOptions.some(([k]) => k === filterKey) ? filterKey : '';
    const rows = useMemo(
        () => (activeFilter ? positions.filter(p => accountKey(p.account) === activeFilter) : positions),
        [positions, activeFilter],
    );
    const totalPnl = rows.reduce((sum, p) => sum + (p.pnl || 0), 0);
    // 持倉還沒讀到時合計未知：顯示「—」而不是 0
    const totalKnown = query.updatedAt !== null || positions.length > 0;

    // 商品資料（名稱、漲跌停價）預先載入快取；失敗時該列平倉停用並說明
    const codesKey = [...new Set(positions.map(p => p.code))].sort().join(',');
    useEffect(() => {
        if (!codesKey) return;
        for (const code of codesKey.split(',')) void ensureContract(code).catch(() => undefined);
    }, [codesKey]);

    // ---- 「⟳」6 秒冷卻 ----
    const [cooling, setCooling] = useState(false);
    const coolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (coolTimer.current) clearTimeout(coolTimer.current); }, []);
    const onRefresh = () => {
        if (cooling) return;
        setCooling(true);
        void refreshTradingState('positions').catch(() => undefined);
        coolTimer.current = setTimeout(() => { coolTimer.current = null; setCooling(false); }, REFRESH_COOLDOWN_MS);
    };

    // ---- 平倉 ----
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const [closeKey, setCloseKey] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const closingRef = useRef(false);
    const [closeFeedback, setCloseFeedback] = useState<CloseSheetProps['feedback']>(null);
    const gateProblem = closeGateProblem(live, gate);
    const closeTarget = closeKey ? positions.find(p => positionKey(p) === closeKey) : undefined;

    const openClose = (p: AccountedPosition) => {
        if (closingRef.current) return;
        setCloseFeedback(null);
        setCloseKey(positionKey(p));
    };
    const cancelClose = () => {
        if (closingRef.current) return;
        setCloseKey(null);
        setCloseFeedback(null);
    };
    const continueClose = async (plan: ClosePlan) => {
        if (closingRef.current) return;
        // 按下當下再驗一次閘門（按鈕停用是第一道，beforeSend 是送出前最後一道）
        const problem = closeGateProblem(live, getResumeGate());
        if (problem) { setCloseFeedback({ kind: 'notSent', text: `未送出：${problem}` }); return; }
        closingRef.current = true;
        setClosing(true);
        setCloseFeedback(null);
        const code = plan.contract.code;
        const qty = plan.kind === 'stock' ? fmtStockLots(plan.shares) : `${plan.lots} 口`;
        try {
            await executeClose(plan);
            notify({ kind: 'ok', title: POSITIONS_TEXT.closeSent, body: `${code} 市價${closeActionText(plan)} ${secretMoney(qty)}` });
            if (mounted.current) setCloseKey(null);
        } catch (err) {
            const outcome = classifyTicketOutcome(err);
            if (outcome === 'cancelled') {
                if (mounted.current) setCloseFeedback({ kind: 'cancelled', text: POSITIONS_TEXT.cancelled });
            } else if (outcome === 'not-sent') {
                if (mounted.current) setCloseFeedback({ kind: 'notSent', text: `未送出：${errorText(err)}` });
            } else {
                // 結果未知：不自動重送、不提供重送鍵；關閉面板並觸發對帳
                notify({ kind: 'err', title: OUTCOME_UNKNOWN_TITLE, body: `${code} 平倉：${errorText(err)}` });
                reconcileAfterUnknownOutcome();
                if (mounted.current) setCloseKey(null);
            }
        } finally {
            closingRef.current = false;
            if (mounted.current) setClosing(false);
        }
    };

    // ---- 加碼 ----
    const [switchKey, setSwitchKey] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);
    const switchTarget = switchKey ? positions.find(p => positionKey(p) === switchKey) : undefined;
    const selectedFor = (p: AccountedPosition): Account | null => (isStockPosition(p) ? accounts.selectedStock : accounts.selectedFutures) ?? null;
    const tradableAccountOf = (p: AccountedPosition): Account | undefined =>
        accounts.accounts.find(a => accountMatches(a, p.account) && canTrade(a));

    const addOnReasonOf = (p: AccountedPosition): string | null => addOnBlockReason(p) ?? (tradableAccountOf(p) ? null : POSITIONS_TEXT.accountNotTradable);

    const openAddOnTicket = (p: AccountedPosition) => openTicket({ code: p.code, action: p.direction, source: 'position' });
    const onAddOn = (p: AccountedPosition) => {
        if (addOnReasonOf(p)) return;
        if (accountMatches(selectedFor(p), p.account)) {
            openAddOnTicket(p);
            return;
        }
        setSwitchError(null);
        setSwitchKey(positionKey(p));
    };
    const confirmSwitch = () => {
        const p = switchTarget;
        if (!p || switchLocked) return;
        const acc = tradableAccountOf(p);
        if (!acc) { setSwitchError(POSITIONS_TEXT.accountNotTradable); return; }
        selectAccount(acc);
        const now = getAccountState();
        const selected = acc.account_type === 'S' ? now.selectedStock : now.selectedFutures;
        if (!accountMatches(selected, acc)) { setSwitchError(POSITIONS_TEXT.switchFailed); return; }
        setSwitchKey(null);
        openAddOnTicket(p);
    };

    const reconcile = reconcileText(query);
    const loading = query.updatedAt === null && !query.error;

    return (
        <section className={layout.page} data-testid='page-positions'>
            <div className={styles.header}>
                <h1 className={styles.headerTitle}>持倉</h1>
                <select
                    className={styles.accountSelect}
                    aria-label='帳戶篩選'
                    value={activeFilter}
                    onChange={(e) => setFilterKey(e.target.value)}
                    data-testid='position-account-filter'
                >
                    <option value=''>帳戶：全部</option>
                    {accountOptions.map(([k, a]) => (
                        <option key={k} value={k}>
                            {isEsunAccount(a) ? '玉山' : '永豐'}{a.account_type === 'F' ? '期貨' : '證券'} {mobileAccountLabel(a, priv)}
                        </option>
                    ))}
                </select>
                <button
                    type='button'
                    className={styles.refreshButton}
                    aria-label={cooling ? '更新持倉（冷卻中）' : '更新持倉'}
                    disabled={cooling}
                    onClick={onRefresh}
                    data-testid='position-refresh'
                >
                    ⟳
                </button>
            </div>

            {reconcile && <p className={styles.banner.warn} role='status' data-testid='position-reconcile'>{reconcile}</p>}
            {gateProblem && gateProblem !== POSITIONS_TEXT.staleData && rows.length > 0 && (
                <p className={styles.banner.info} role='status' data-testid='position-gate-note'>{gateProblem}</p>
            )}
            {/* stale-data：原因＋勾選了解＋重試同步（勾選後仍顯示，讓使用者可隨時重試） */}
            <ResumeGateNote gate={gate} disabled={closing} testId='position-gate-stale' />

            <div className={styles.summary}>
                <span>未實現損益合計</span>
                <span className={`${styles.summaryValue} ${styles.tone[totalKnown ? pnlTone(totalPnl) : 'flat']}`} data-testid='position-total'>
                    {totalKnown ? maskMoney(fmtSigned(totalPnl, 0), privMoney) : '—'}
                </span>
                <span className={styles.estimate}>（估）</span>
            </div>

            {loading ? (
                <p className={styles.empty}>{POSITIONS_TEXT.loading}</p>
            ) : rows.length === 0 ? (
                <p className={styles.empty}>{POSITIONS_TEXT.empty}</p>
            ) : (
                <ul className={styles.list}>
                    {rows.map(p => (
                        <PositionRow
                            key={positionKey(p)}
                            p={p}
                            priv={priv}
                            privMoney={privMoney}
                            closeDisabled={closing || gateProblem !== null}
                            addOnReason={addOnReasonOf(p)}
                            onClose={() => openClose(p)}
                            onAddOn={() => onAddOn(p)}
                        />
                    ))}
                </ul>
            )}

            {closeKey !== null && (
                <CloseSheet
                    position={closeTarget}
                    gate={gate}
                    gateProblem={gateProblem}
                    busy={closing}
                    feedback={closeFeedback}
                    privMoney={privMoney}
                    onCancel={cancelClose}
                    onContinue={(plan) => { void continueClose(plan); }}
                />
            )}
            {switchKey !== null && (
                <AddOnSwitchSheet
                    position={switchTarget}
                    current={switchTarget ? selectedFor(switchTarget) : null}
                    priv={priv}
                    locked={switchLocked}
                    error={switchError}
                    onCancel={() => { setSwitchKey(null); setSwitchError(null); }}
                    onConfirm={confirmSwitch}
                />
            )}
        </section>
    );
}
