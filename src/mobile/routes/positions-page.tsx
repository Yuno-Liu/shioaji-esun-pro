// src/mobile/routes/positions-page.tsx — 持倉（規格 §6.6）
//
// - 資料：useTradingState().positions（含帳戶；現價隨即時 tick 更新）；帳戶篩選「全部」或單一帳戶；
//   市場分段「全部／股票／期貨／選擇權」（期權依商品 security_type；商品資料未載入時不歸類）；
//   排序「券商順序／損益／報酬率／市值／代碼」；依帳戶分組並顯示小計（筆數、市值、損益）。
//   queries.positions 的對帳原因 banner；「⟳」＝refreshTradingState('positions')，6 秒冷卻。
// - 摘要卡（position-summary）：未實現損益合計（估）、股票總市值、期貨權益數與風險指標
//   （margin 屬於目前選取的期貨帳戶，只在範圍包含該帳戶時顯示）；金額遮蔽用 usePrivacyMoney＋maskMoney。
//   持倉尚未讀到（queries.positions.updatedAt 為 null 且沒有任何持倉列）時顯示「—」，不顯示 0。
// - 持倉列：均價、現價、損益（估）、報酬率；股票另有昨餘、成本（均價×股數）、市值；損益條（up／down 色＋文字）。
//   玉山股票列可展開庫存明細（position-esun-details）。
// - 平倉：先開說明面板寫明行為，使用者按「繼續」才呼叫 src/lib；lib 內部會再出現一次確認面板
//   （根層 order-confirm-sheet，手機已強制開啟 confirmManualOrders），確認只出現一次。
//   · 股票：stockExitFor() 回傳原因時不送出；否則 placeStockExitByShares()（整張市價 IOC、零股以漲跌停價盤中零股限價）。
//   · 期貨／選擇權：placeQuickOrder(…, null, 口數, { ocType: 'Cover', source: 'manual' })（市價 IOC）。
//   · beforeSend 內同步呼叫 assertResumeReady()；useTradingLive() 為 false 或 ResumeGate 不允許時停用。
//   · ResumeGate 為 stale-data：頁面 banner 與平倉說明面板都提供 ResumeGateNote（勾選「我了解委託／持倉資料可能過期」
//     ＝acknowledgeStaleData()、「重試同步」＝retryResume()）；勾選後才可平倉。
//   · 結果依 §7.2：已取消、未送出（顯示原因，可重試）、結果未知（不自動重送、不提供重送鍵）。股票不提供反手。
// - 加碼：openTicket({ code, action: 同方向, source: 'position', lot, cond, daytradeShort })；
//   現股多單＝Buy＋Cash；融資多單＝Buy＋MarginTrading；融券空單＝Sell＋ShortSelling（信用一律整張）；
//   現股空單（當沖先賣）＝Sell＋Cash＋daytradeShort，只在 contract.day_trade==='Yes' 時可用，否則停用並說明。
//   下單面板以「目前選取的帳戶」下單，持倉帳戶不同時先確認切換帳戶；面板內仍需預覽並滑動確認才會送出。
// - 看圖：navigate({ name: 'trade', code })。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTradingLive } from '../../hooks/use-stream';
import { getAccountState, selectAccount, useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { ensureContract, getCachedContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { accountMatches } from '../../lib/flash-account';
import { SHARES_PER_LOT } from '../../lib/odd-lot';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { maskMoney, secretMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { useServerInfo, yesterdayQuantityNotice } from '../../lib/server-info-store';
import { creditExitLabel, stockExitFor, type CreditExitCond } from '../../lib/stock-exit-cond';
import { notify, placeQuickOrder, placeStockExitByShares } from '../../lib/trade';
import { RECONCILE_REASON_LABELS, refreshTradingState, useTradingState, type TradingQueryStatus } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action } from '../../lib/types/order';
import type { Account, AccountedPosition, Position, StockPosition } from '../../lib/types/portfolio';
import { fmtInt, fmtPct, fmtPrice, fmtSigned, fmtStockLots } from '../../lib/utils/format';
import { mobileAccountLabel, useAccountSwitchLocked } from '../components/account-switch-sheet';
import { BottomSheet } from '../components/bottom-sheet';
import { PositionEsunDetails } from '../components/position-esun-details';
import {
    accountKeyOf,
    filterByMarket,
    groupPositionsByAccount,
    MARKET_FILTERS,
    pnlBarWidth,
    positionCost,
    positionMarketValue,
    positionReturnPct,
    SORT_MODES,
    sortPositions,
    summarizePositions,
    type PositionMarketFilter,
    type PositionSortMode,
} from '../components/position-metrics';
import { PositionSummaryCard } from '../components/position-summary';
import { ResumeGateNote } from '../components/resume-gate-note';
import { RouteBadge } from '../components/route-badge';
import { classifyTicketOutcome, OUTCOME_UNKNOWN_TITLE } from '../hooks/use-mobile-ticket';
import { useResumeGate } from '../hooks/use-resume-gate';
import { navigate } from '../lib/hash-router';
import { openTicket, type TicketCond, type TicketLot } from '../lib/mobile-store';
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
    noAccount: '持倉帳戶歸屬不明，未送出委託',
    noAccountAddOn: '持倉帳戶歸屬不明，無法加碼',
    addOnBadDirection: '持倉方向不明，無法加碼',
    addOnDayTradeUnknown: '商品資料尚未載入，無法確認可否當沖先賣，暫時不能加碼',
    addOnNoDayTrade: '此股票目前不可當沖先賣；現股空單只能以當沖先賣加碼，加碼停用',
    addOnDayTradeNote: '以現股「當沖先賣」整張加碼，須於當日買回沖銷',
    addOnOtherCond: '借券或其他信用條件的持倉不支援加碼，請至券商處理',
    addOnCondMismatch: '持倉方向與信用條件不符，無法判斷加碼方式',
    filteredEmpty: '此篩選條件下沒有持倉',
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

/** 列的識別（不含數量：數量變動時說明面板跟著顯示最新值） */
export function positionKey(p: AccountedPosition): string {
    const cond = isStockPosition(p) ? p.cond ?? '' : '';
    return `${accountKeyOf(p.account)}|${p.code}|${p.direction}|${cond}|${p.id}`;
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

/** 加碼時交給 openTicket 的內容（一次性帶入；面板仍依規則驗證） */
export interface AddOnRequest {
    code: string;
    action: Action;
    source: 'position';
    lot?: TicketLot;
    cond?: TicketCond;
    daytradeShort?: boolean;
}

export interface AddOnPlan {
    request: AddOnRequest;
    /** 加碼時要讓使用者知道的限制（例如信用只能整張）；沒有為 null */
    note: string | null;
}

/** 信用部位加碼的限制說明；持倉含零股時另外說明零股不能以信用條件交易 */
export function creditAddOnNote(cond: 'MarginTrading' | 'ShortSelling', shares: number): string {
    const name = cond === 'ShortSelling' ? '融券' : '融資';
    const whole = Number.isSafeInteger(shares) && shares > 0 && shares % SHARES_PER_LOT === 0;
    return `${name}加碼只能整張（1,000 股）下單；零股不能以信用條件交易`
        + (whole ? '' : '。這筆持倉含零股，零股部分也不能以信用條件了結，請至券商處理');
}

/**
 * 加碼方式（與帳戶切換無關的部分）；不可加碼回原因字串。
 * - 期權：同方向（倉別由面板決定）。
 * - 現股多單＝Buy＋Cash；融資多單＝Buy＋MarginTrading；融券空單＝Sell＋ShortSelling（信用一律整張）。
 * - 現股空單＝當沖先賣（Sell＋Cash＋daytradeShort），只在 contract.day_trade==='Yes' 時可用；商品資料未載入時不猜。
 */
export function addOnPlanFor(p: AccountedPosition, contract: Pick<ContractInfo, 'day_trade'> | undefined): AddOnPlan | string {
    if (!p.account) return POSITIONS_TEXT.noAccountAddOn;
    if (p.direction !== 'Buy' && p.direction !== 'Sell') return POSITIONS_TEXT.addOnBadDirection;
    const base: AddOnRequest = { code: p.code, action: p.direction, source: 'position' };
    if (!isStockPosition(p)) return { request: base, note: null };
    const c = p.cond || 'Cash';
    if (c === 'Cash') {
        if (p.direction === 'Buy') return { request: { ...base, lot: 'Common', cond: 'Cash' }, note: null };
        if (!contract) return POSITIONS_TEXT.addOnDayTradeUnknown;
        if (contract.day_trade !== 'Yes') return POSITIONS_TEXT.addOnNoDayTrade;
        return { request: { ...base, lot: 'Common', cond: 'Cash', daytradeShort: true }, note: POSITIONS_TEXT.addOnDayTradeNote };
    }
    if (c !== 'MarginTrading' && c !== 'ShortSelling') return POSITIONS_TEXT.addOnOtherCond;
    if ((c === 'ShortSelling') !== (p.direction === 'Sell')) return POSITIONS_TEXT.addOnCondMismatch;
    return { request: { ...base, lot: 'Common', cond: c }, note: creditAddOnNote(c, p.quantity) };
}

/** 加碼不可用的原因（與帳戶切換無關的部分）；可用時回傳 null */
export function addOnBlockReason(p: AccountedPosition, contract?: Pick<ContractInfo, 'day_trade'>): string | null {
    const plan = addOnPlanFor(p, contract);
    return typeof plan === 'string' ? plan : null;
}

/** 帳戶標籤（券商＋市場＋遮蔽帳號）；帳戶不明時回「帳戶不明」 */
function groupLabel(a: Account | undefined, priv: boolean): string {
    if (!a) return '帳戶不明';
    return `${isEsunAccount(a) ? '玉山' : '永豐'}${a.account_type === 'F' ? '期貨' : '證券'} ${mobileAccountLabel(a, priv)}`;
}

function closeActionText(plan: ClosePlan): string {
    const side = plan.action === 'Buy' ? '買進' : '賣出';
    if (plan.kind === 'stock') return `${creditExitLabel(plan.orderCond)}${side}`;
    return `平倉${side}`;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''));

// ---- 元件 ----

/** 昨餘文字：期權回 null；永豐模擬帳務的昨餘單位待確認時（玉山不套用）回「待確認」 */
export function yesterdayText(p: AccountedPosition, notice: string | undefined, privMoney: boolean): string | null {
    if (!isStockPosition(p)) return null;
    if (notice && !isEsunAccount(p.account)) return '待確認';
    return Number.isFinite(p.yd_quantity) ? maskMoney(fmtStockLots(p.yd_quantity), privMoney) : '—';
}

interface RowProps {
    p: AccountedPosition;
    priv: boolean;
    privMoney: boolean;
    closeDisabled: boolean;
    /** 帳戶不可交易時的原因（與商品無關的部分） */
    accountReason: string | null;
    /** 本頁顯示範圍內的最大 |損益|，供損益條比例 */
    maxAbsPnl: number;
    ydNotice: string | undefined;
    expanded: boolean;
    onClose: () => void;
    onAddOn: (contract: ContractInfo | undefined) => void;
    onToggleDetail: () => void;
}

function Cell({ label, children, className, testId }: { label: string; children: ReactNode; className?: string; testId?: string }) {
    return (
        <div className={styles.rowCell}>
            <dt className={styles.cellLabel}>{label}</dt>
            <dd className={`${styles.cellValue}${className ? ` ${className}` : ''}`} data-testid={testId}>{children}</dd>
        </div>
    );
}

function PositionRow({ p, priv, privMoney, closeDisabled, accountReason, maxAbsPnl, ydNotice, expanded, onClose, onAddOn, onToggleDetail }: RowProps) {
    const contract = useContract(p.code);
    const long = p.direction === 'Buy';
    const stock = isStockPosition(p);
    const esun = stock && isEsunAccount(p.account);
    const plan = addOnPlanFor(p, contract);
    const addOnReason = typeof plan === 'string' ? plan : accountReason;
    const addOnNote = typeof plan === 'string' ? null : plan.note;
    const ret = positionReturnPct(p);
    const cost = positionCost(p);
    const value = positionMarketValue(p);
    const yd = yesterdayText(p, ydNotice, privMoney);
    const bar = privMoney ? 0 : pnlBarWidth(p.pnl, maxAbsPnl);
    const money = (v: number | null) => maskMoney(v === null ? '—' : fmtInt(Math.round(v)), privMoney);
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
            <dl className={styles.rowGrid}>
                <Cell label='均價'>{fmtPrice(p.price)}</Cell>
                <Cell label='現價'>{fmtPrice(p.last_price)}</Cell>
                <Cell label='損益（估）' className={styles.tone[pnlTone(p.pnl)]} testId='position-pnl'>{maskMoney(fmtSigned(p.pnl, 0), privMoney)}</Cell>
                {stock && <Cell label='昨餘' testId='position-yd'>{yd}</Cell>}
                {stock && <Cell label='成本' testId='position-cost'>{money(cost)}</Cell>}
                {stock && <Cell label='市值' testId='position-value'>{money(value)}</Cell>}
                <Cell label='報酬率（估）' className={styles.tone[ret === null ? 'flat' : pnlTone(ret)]} testId='position-return'>
                    {ret === null ? '—' : fmtPct(ret)}
                </Cell>
            </dl>
            {bar > 0 && (
                <div className={styles.pnlBar} aria-hidden='true' data-testid='position-pnl-bar'>
                    <span className={styles.pnlBarMid} />
                    <span className={styles.pnlBarFill[p.pnl > 0 ? 'up' : 'down']} style={{ width: `${bar}%` }} />
                </div>
            )}
            <div className={styles.rowActions}>
                {esun && (
                    <button
                        type='button'
                        className={styles.detailToggle}
                        aria-expanded={expanded}
                        onClick={onToggleDetail}
                        data-testid='position-detail-toggle'
                    >
                        {expanded ? '收合明細' : '庫存明細'}
                    </button>
                )}
                <button type='button' className={controls.button.neutral} disabled={closeDisabled} onClick={onClose} data-testid='position-close'>平倉</button>
                <button type='button' className={controls.button.neutral} disabled={addOnReason !== null} onClick={() => onAddOn(contract)} data-testid='position-add'>加碼</button>
                <button type='button' className={controls.button.ghost} onClick={() => navigate({ name: 'trade', code: p.code })} data-testid='position-chart'>看圖</button>
            </div>
            {addOnReason
                ? <p className={styles.rowNote} data-testid='position-add-note'>{addOnReason}</p>
                : addOnNote && <p className={styles.rowNote} data-testid='position-add-note'>{addOnNote}</p>}
            {esun && expanded && <PositionEsunDetails position={p} />}
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

    const ydNotice = yesterdayQuantityNotice(useServerInfo());

    const positions = trading.positions;
    const query = trading.queries.positions;

    // ---- 帳戶篩選 ----
    const accountOptions = useMemo(() => {
        const map = new Map<string, Account>();
        for (const p of positions) if (p.account) map.set(accountKeyOf(p.account), p.account);
        return [...map.entries()];
    }, [positions]);
    const [filterKey, setFilterKey] = useState('');
    const activeFilter = accountOptions.some(([k]) => k === filterKey) ? filterKey : '';
    const accountRows = useMemo(
        () => (activeFilter ? positions.filter(p => accountKeyOf(p.account) === activeFilter) : positions),
        [positions, activeFilter],
    );

    // 商品資料（名稱、漲跌停價、期貨／選擇權別）預先載入快取；失敗時該列平倉停用並說明。
    // 載入完成後遞增 contractsTick，讓市場分段以最新快取重新歸類。
    const codesKey = [...new Set(positions.map(p => p.code))].sort().join(',');
    const [, setContractsTick] = useState(0);
    useEffect(() => {
        if (!codesKey) return;
        let alive = true;
        void Promise.allSettled(codesKey.split(',').map(code => ensureContract(code)))
            .then(() => { if (alive) setContractsTick(t => t + 1); });
        return () => { alive = false; };
    }, [codesKey]);

    // ---- 市場分段、排序、分組 ----
    const [market, setMarket] = useState<PositionMarketFilter>('all');
    const [sort, setSort] = useState<PositionSortMode>('default');
    const { rows, unclassified } = filterByMarket(accountRows, market, getCachedContract);
    const sortedRows = sortPositions(rows, sort);
    const groups = groupPositionsByAccount(sortedRows);
    const summary = summarizePositions(rows);
    const maxAbsPnl = rows.reduce((mx, p) => (Number.isFinite(p.pnl) ? Math.max(mx, Math.abs(p.pnl)) : mx), 0);
    // 持倉還沒讀到時合計未知：顯示「—」而不是 0
    const totalKnown = query.updatedAt !== null || positions.length > 0;
    // 保證金屬於「目前選取的期貨帳戶」：範圍包含該帳戶（全部帳戶或就是它）且不是只看股票時才顯示
    const futuresKey = accountKeyOf(accounts.selectedFutures);
    const showMargin = !!trading.margin && market !== 'stock' && futuresKey !== '' && (activeFilter === '' || activeFilter === futuresKey);

    // ---- 玉山庫存明細展開 ----
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const toggleDetail = (key: string) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

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

    const accountReasonOf = (p: AccountedPosition): string | null => (tradableAccountOf(p) ? null : POSITIONS_TEXT.accountNotTradable);

    const onAddOn = (p: AccountedPosition, contract: ContractInfo | undefined) => {
        // 按下當下再驗一次（按鈕停用是第一道）
        const plan = addOnPlanFor(p, contract);
        if (typeof plan === 'string' || accountReasonOf(p)) return;
        if (accountMatches(selectedFor(p), p.account)) {
            openTicket(plan.request);
            return;
        }
        setSwitchError(null);
        setSwitchKey(positionKey(p));
    };
    const confirmSwitch = () => {
        const p = switchTarget;
        if (!p || switchLocked) return;
        const plan = addOnPlanFor(p, getCachedContract(p.code));
        if (typeof plan === 'string') { setSwitchError(plan); return; }
        const acc = tradableAccountOf(p);
        if (!acc) { setSwitchError(POSITIONS_TEXT.accountNotTradable); return; }
        selectAccount(acc);
        const now = getAccountState();
        const selected = acc.account_type === 'S' ? now.selectedStock : now.selectedFutures;
        if (!accountMatches(selected, acc)) { setSwitchError(POSITIONS_TEXT.switchFailed); return; }
        setSwitchKey(null);
        openTicket(plan.request);
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
                        <option key={k} value={k}>{groupLabel(a, priv)}</option>
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

            <div className={styles.filterRow}>
                <div className={styles.segment} role='group' aria-label='市場篩選' data-testid='position-market-filter'>
                    {MARKET_FILTERS.map(f => (
                        <button
                            key={f.key}
                            type='button'
                            className={styles.segmentButton[market === f.key ? 'on' : 'off']}
                            aria-pressed={market === f.key}
                            onClick={() => setMarket(f.key)}
                            data-testid={`position-market-${f.key}`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                <select
                    className={styles.sortSelect}
                    aria-label='排序'
                    value={sort}
                    onChange={(e) => setSort(e.target.value as PositionSortMode)}
                    data-testid='position-sort'
                >
                    {SORT_MODES.map(s => <option key={s.key} value={s.key}>排序：{s.label}</option>)}
                </select>
            </div>

            {reconcile && <p className={styles.banner.warn} role='status' data-testid='position-reconcile'>{reconcile}</p>}
            {gateProblem && gateProblem !== POSITIONS_TEXT.staleData && positions.length > 0 && (
                <p className={styles.banner.info} role='status' data-testid='position-gate-note'>{gateProblem}</p>
            )}
            {/* stale-data：原因＋勾選了解＋重試同步（勾選後仍顯示，讓使用者可隨時重試） */}
            <ResumeGateNote gate={gate} disabled={closing} testId='position-gate-stale' />

            <PositionSummaryCard
                summary={summary}
                known={totalKnown}
                margin={showMargin ? trading.margin ?? null : null}
                futuresLabel={accounts.selectedFutures ? mobileAccountLabel(accounts.selectedFutures, priv) : ''}
                privMoney={privMoney}
            />

            {unclassified > 0 && (
                <p className={styles.filterNote} role='status' data-testid='position-unclassified'>
                    {unclassified} 筆期權持倉的商品資料尚未載入，暫時無法歸類為期貨或選擇權（可在「全部」查看）
                </p>
            )}

            {loading ? (
                <p className={styles.empty}>{POSITIONS_TEXT.loading}</p>
            ) : positions.length === 0 ? (
                <p className={styles.empty}>{POSITIONS_TEXT.empty}</p>
            ) : rows.length === 0 ? (
                <p className={styles.empty}>{POSITIONS_TEXT.filteredEmpty}</p>
            ) : (
                groups.map(g => (
                    <section key={g.key || 'unknown'} className={styles.group} aria-label={groupLabel(g.account, priv)} data-testid='position-group'>
                        <div className={styles.groupHeader} data-testid='position-group-header'>
                            <span className={styles.groupTitle}>{groupLabel(g.account, priv)}</span>
                            <span className={styles.groupStat}>{g.count} 筆</span>
                            {g.value && (
                                <span className={styles.groupStat}>
                                    市值 {maskMoney(fmtInt(Math.round(g.value.value)), privMoney)}{g.value.incomplete ? '（部分缺價未計）' : ''}
                                </span>
                            )}
                            <span className={styles.tone[pnlTone(g.pnl)]}>損益 {maskMoney(fmtSigned(g.pnl, 0), privMoney)}</span>
                        </div>
                        <ul className={styles.list}>
                            {g.rows.map(p => {
                                const key = positionKey(p);
                                return (
                                    <PositionRow
                                        key={key}
                                        p={p}
                                        priv={priv}
                                        privMoney={privMoney}
                                        closeDisabled={closing || gateProblem !== null}
                                        accountReason={accountReasonOf(p)}
                                        maxAbsPnl={maxAbsPnl}
                                        ydNotice={ydNotice}
                                        expanded={expanded.has(key)}
                                        onClose={() => openClose(p)}
                                        onAddOn={(contract) => onAddOn(p, contract)}
                                        onToggleDetail={() => toggleDetail(key)}
                                    />
                                );
                            })}
                        </ul>
                    </section>
                ))
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
