// src/lib/conditional/flatten.ts — 全平並取消 (#226). In this order, for a
// chosen scope (此商品／此帳戶／全部帳戶):
// 1. stop the conditional orders (nothing new can be sent by them);
// 2. cancel the working orders (authoritative order listing) and wait for
//    every cancel to be confirmed;
// 3. read the positions again (fills that happened meanwhile count) and close
//    exactly what is held: futures with 範圍市價 + 平倉 (Cover), stocks (現股)
//    with market lots and a limit-price odd remainder; 融資／融券 with
//    融資賣出／融券買進 whole lots only (else skipped, never sent as 現股).
// It never opens a position: every order closes a position that was just
// read, never more; a product whose cancel is not confirmed is not closed.

import { createAccountQuery } from '../account-query';
import { canTrade } from '../account-tradable';
import { getAccountState } from '../account-store';
import type { AccountRef } from '../bracket-core';
import { ensureContract } from '../contracts-cache';
import { cancelVerifiedOrder, fetchPositions, fetchTrades } from '../shioaji';
import { captureServerMode, type ServerModeGuard } from '../server-info-store';
import { placeQuickOrder } from '../trade';
import { stockExitFor, type CreditExitCond } from '../stock-exit-cond';
import type { AccountedPosition, Account } from '../types/portfolio';
import type { Trade } from '../types/order';
import { remainingWorkingOrderQuantity } from '../working-order-quantity';

export { closeHowText, quantityText } from './flatten-text';

export type FlattenScope =
    | { type: 'code'; codes: string[]; account: AccountRef | null }
    | { type: 'account'; account: AccountRef }
    | { type: 'all' };

export interface FlattenOrder {
    account: AccountRef;
    code: string;
    action: 'Buy' | 'Sell';
    /** contracts (futures) or shares (stocks) */
    quantity: number;
    market: 'stock' | 'futures';
    /** stocks: 信用了結（融資賣出／融券買進，整張）；absent = 現股 */
    cond?: CreditExitCond;
}

export interface FlattenPlan {
    orders: FlattenOrder[];
    skipped: { code: string; account: AccountRef; reason: string }[];
}

const sameAccount = (a: Pick<AccountRef, 'account_type' | 'broker_id' | 'account_id'> | null | undefined, b: AccountRef | null | undefined) =>
    !!a && !!b && a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id;

export function inScope(scope: FlattenScope, account: AccountRef | null | undefined, code: string | null | undefined): boolean {
    if (scope.type === 'all') return true;
    if (scope.type === 'account') return sameAccount(account, scope.account);
    return (!scope.account || sameAccount(account, scope.account)) && !!code && scope.codes.includes(code);
}

/** What closing the positions in scope takes. Pure: one order per held
 * position, the exact held quantity, the opposite side. */
export function planFlatten(positions: readonly AccountedPosition[], scope: FlattenScope): FlattenPlan {
    const plan: FlattenPlan = { orders: [], skipped: [] };
    const groups = new Map<string, { account: AccountRef; code: string; market: 'stock' | 'futures'; buy: number; sell: number; conds: Set<string>; bad: boolean }>();
    for (const p of positions) {
        const a = p.account;
        if (!a || (a.account_type !== 'S' && a.account_type !== 'F') || !a.broker_id || !a.account_id) continue;
        const account: AccountRef = { account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id };
        if (!inScope(scope, account, p.code)) continue;
        const key = `${a.account_type}:${a.broker_id}:${a.account_id}:${p.code}`;
        const g = groups.get(key) ?? { account, code: p.code, market: a.account_type === 'S' ? 'stock' as const : 'futures' as const,
            buy: 0, sell: 0, conds: new Set<string>(), bad: false };
        if (!Number.isSafeInteger(p.quantity) || p.quantity < 0 || (p.direction !== 'Buy' && p.direction !== 'Sell')) g.bad = true;
        else if (p.direction === 'Buy') g.buy += p.quantity;
        else g.sell += p.quantity;
        if (g.market === 'stock') g.conds.add(('cond' in p && p.cond) || 'Cash');
        groups.set(key, g);
    }
    for (const g of groups.values()) {
        if (g.bad) { plan.skipped.push({ code: g.code, account: g.account, reason: '持倉數量或方向不明，未平倉' }); continue; }
        if (g.conds.size > 1) { plan.skipped.push({ code: g.code, account: g.account, reason: '同商品同時有現股與信用部位（或多種信用條件），請在持倉分開處理' }); continue; }
        if (g.buy > 0 && g.sell > 0) { plan.skipped.push({ code: g.code, account: g.account, reason: '同商品同時有多空部位，請手動處理' }); continue; }
        const held = g.buy || g.sell;
        if (held <= 0) continue;
        // 信用部位以正確條件了結（融資賣出／融券買進，只送整張），不支援就略過；絕不改送現股
        const exit = g.market === 'stock' ? stockExitFor(g.buy > 0 ? 'Buy' : 'Sell', [...g.conds][0], held) : null;
        if (typeof exit === 'string') { plan.skipped.push({ code: g.code, account: g.account, reason: exit.replace('，未送出委託', '，未平倉') }); continue; }
        plan.orders.push({ account: g.account, code: g.code, action: g.buy > 0 ? 'Sell' : 'Buy', quantity: held, market: g.market,
            ...(exit?.orderCond ? { cond: exit.orderCond } : {}) });
    }
    return plan;
}

/** Working orders in scope (orders not yet filled or cancelled). */
export function workingInScope(trades: readonly Trade[], scope: FlattenScope): Trade[] {
    return trades.filter(t => {
        if (remainingWorkingOrderQuantity(t) <= 0) return false;
        const a = t.order.account;
        const account = a && (a.account_type === 'S' || a.account_type === 'F')
            ? { account_type: a.account_type as 'S' | 'F', broker_id: a.broker_id ?? '', account_id: a.account_id } : null;
        const code = t.contract.target_code || t.contract.code;
        return inScope(scope, account, code) || inScope(scope, account, t.contract.code);
    });
}

export interface FlattenHooks {
    /** step 1: stop the conditional orders in scope; returns how many */
    stopConditional(): Promise<{ stopped: number; failed: string[] }>;
    /** wait until no conditional order in scope is still sending; false: still sending */
    waitInFlight?(): Promise<boolean>;
    /** tests: the wait before each read-back */
    sleep?(ms: number): Promise<void>;
    /** right before each cancel / close: this run still holds 全平並取消
     * (shared with the background engine); false stops it, nothing more is sent */
    stillOwned?(): Promise<boolean>;
}

export interface FlattenResult {
    stopped: number;
    cancelled: number;
    cancelFailed: string[];
    sent: { code: string; action: 'Buy' | 'Sell'; quantity: number; market: 'stock' | 'futures'; account: AccountRef }[];
    notSent: string[];
    skipped: string[];
    /** Read back after sending: what is still held of a product a close was
     * sent for (an IOC market order may fill only partly). */
    remaining: RemainingOrder[];
}

/** `unconfirmed`: the read-back failed — treat as still held until checked. */
export type RemainingOrder = FlattenOrder & { unconfirmed?: boolean };

export interface FlattenPreviewData {
    positions: AccountedPosition[];
    trades: Trade[];
    /** accounts whose query failed (their part falls back to nothing) */
    failed: string[];
}

/** The 全平並取消 preview's data, read fresh from the broker for every
 * account in scope (the window's positions may be stale: QA 10/12 showed
 * 2 lots held when the account held 1). Execution reads again anyway. */
export async function loadFlattenPreview(scope: FlattenScope): Promise<FlattenPreviewData> {
    const out: FlattenPreviewData = { positions: [], trades: [], failed: [] };
    const query = createAccountQuery();
    await Promise.all(accountsFor(scope).map(async account => {
        const type = account.account_type as 'S' | 'F';
        const label = type === 'F' ? '期貨' : '證券';
        try {
            const [rows, trades] = await Promise.all([
                query.read(type, account, current => fetchPositions(type, current)),
                query.read(type, account, current => fetchTrades(type, current, { refresh: true })),
            ]);
            out.positions.push(...rows.map(r => ({ ...r, account })));
            out.trades.push(...trades.map(t => ({ ...t, order: { ...t.order, account: t.order.account ?? account } })));
        } catch (e) {
            out.failed.push(`${label}帳戶查詢失敗：${e instanceof Error ? e.message : String(e)}`);
        }
    }));
    return out;
}

/** After sending: wait for the broker to settle the closes (an IOC market
 * order ends within moments), then read the positions again. */
export const READBACK_DELAYS_MS = [1500, 2500, 4000];

function accountsFor(scope: FlattenScope): Account[] {
    const all = getAccountState().accounts.filter(a => canTrade(a) && (a.account_type === 'S' || a.account_type === 'F'));
    if (scope.type === 'all') return all;
    if (scope.account) return all.filter(a => sameAccount(a as AccountRef, scope.account));
    return all;
}

/** Runs the three steps. Every request is authoritative (refresh); nothing
 * is retried automatically. */
export async function executeFlatten(scope: FlattenScope, hooks: FlattenHooks): Promise<FlattenResult> {
    const result: FlattenResult = { stopped: 0, cancelled: 0, cancelFailed: [], sent: [], notSent: [], skipped: [], remaining: [] };
    // bound to the server / mode it started on: any switch stops it before the next request
    const sameServer = captureServerMode();
    const switched = () => {
        result.notSent.push('伺服器或模擬／正式模式已切換，已停止（未再刪單或平倉）');
        return result;
    };
    const stop = await hooks.stopConditional();
    result.stopped = stop.stopped;
    if (stop.failed.length) {
        // one still armed could fire after the close: stop here
        result.notSent.push(...stop.failed, '條件單沒有全部停止，未刪單也未平倉；請處理後再試');
        return result;
    }
    if (hooks.waitInFlight && !(await hooks.waitInFlight())) {
        result.notSent.push('有條件單剛觸發、委託仍在送出中，未刪單也未平倉；請稍後再試');
        return result;
    }
    if (hooks.waitInFlight) {
        // an order that just went out may have armed new protection: stop again
        const again = await hooks.stopConditional();
        result.stopped += again.stopped;
        if (again.failed.length) {
            result.notSent.push(...again.failed, '條件單沒有全部停止，未刪單也未平倉；請處理後再試');
            return result;
        }
    }
    if (!sameServer()) return switched();
    const accounts = accountsFor(scope);
    const query = createAccountQuery();
    // 2. cancel working orders, per account, and wait for each answer
    const blocked = new Set<string>(); // account:code with an unconfirmed cancel
    for (const account of accounts) {
        const type = account.account_type as 'S' | 'F';
        let trades: Trade[];
        try {
            trades = await query.read(type, account, current => fetchTrades(type, current, { refresh: true }));
        } catch (e) {
            result.cancelFailed.push(`${account.account_type === 'F' ? '期貨' : '證券'}帳戶委託查詢失敗：${e instanceof Error ? e.message : String(e)}`);
            blocked.add(`${account.account_type}:${account.account_id}:*`);
            continue;
        }
        const working = workingInScope(trades.map(t => ({ ...t, order: { ...t.order, account: t.order.account ?? account } })), scope);
        if (!working.length) continue;
        if (!sameServer()) return switched();
        if (hooks.stillOwned && !(await hooks.stillOwned())) return lost(result);
        // each cancel targets the row just read (verified, not resolved by id from older state)
        const answers = await Promise.allSettled(working.map(t => cancelVerifiedOrder(t, account, {
            beforeSend: () => { if (!sameServer()) throw new Error('伺服器或模擬／正式模式已切換，未刪單'); },
        })));
        answers.forEach((r, i) => {
            const t = working[i]!;
            const code = t.contract.target_code || t.contract.code;
            if (r.status === 'fulfilled' && r.value.status.status === 'Cancelled') result.cancelled += 1;
            else {
                blocked.add(`${account.account_type}:${account.account_id}:${code}`);
                result.cancelFailed.push(`${code} 刪單未確認${r.status === 'rejected' ? `（${r.reason instanceof Error ? r.reason.message : String(r.reason)}）` : ''}`);
            }
        });
    }
    // 3. read positions again and close exactly what is held
    if (!sameServer()) return switched();
    const sentFor: { account: Account; order: FlattenOrder }[] = [];
    for (const account of accounts) {
        const type = account.account_type as 'S' | 'F';
        if (blocked.has(`${type}:${account.account_id}:*`)) continue;
        let rows: AccountedPosition[];
        try {
            const raw = await query.read(type, account, current => fetchPositions(type, current));
            rows = raw.map(r => ({ ...r, account }));
        } catch (e) {
            result.notSent.push(`${type === 'F' ? '期貨' : '證券'}帳戶持倉查詢失敗，未平倉：${e instanceof Error ? e.message : String(e)}`);
            continue;
        }
        const plan = planFlatten(rows, scope);
        result.skipped.push(...plan.skipped.map(s => `${s.code}：${s.reason}`));
        for (const o of plan.orders) {
            if (blocked.has(`${type}:${account.account_id}:${o.code}`)) {
                result.notSent.push(`${o.code}：刪單未確認，未平倉；請核對委託後再試`);
                continue;
            }
            if (hooks.stillOwned && !(await hooks.stillOwned())) return lost(result);
            try {
                await sendClose(o, account, sameServer);
                result.sent.push({ code: o.code, action: o.action, quantity: o.quantity, market: o.market, account: o.account });
                sentFor.push({ account, order: o });
            } catch (e) {
                const notStarted = (e as { mutationNotStarted?: boolean })?.mutationNotStarted;
                const partial = (e as { partialSent?: number })?.partialSent;
                if (partial) result.sent.push({ code: o.code, action: o.action, quantity: partial, market: o.market, account: o.account });
                // anything that may have gone out is read back too
                if (!notStarted) sentFor.push({ account, order: o });
                result.notSent.push(`${o.code}：${notStarted ? '未送出' : '結果不明，請核對委託，勿直接重送'}（${e instanceof Error ? e.message : String(e)}）`);
            }
        }
    }
    // 4. read back: what of each product sent for is still held
    if (sentFor.length) result.remaining = await readBack(sentFor, query, hooks.sleep ?? sleep);
    return result;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The hold was lost (another 全平並取消 may run now): stop sending. */
function lost(result: FlattenResult): FlattenResult {
    result.notSent.push('全平並取消的執行權已失效（可能由背景執行接手），已停止，未再刪單或平倉；請核對委託與持倉');
    return result;
}

async function readBack(sentFor: { account: Account; order: FlattenOrder }[], query: ReturnType<typeof createAccountQuery>,
    wait: (ms: number) => Promise<void>): Promise<RemainingOrder[]> {
    const byAccount = new Map<Account, FlattenOrder[]>();
    for (const s of sentFor) byAccount.set(s.account, [...(byAccount.get(s.account) ?? []), s.order]);
    let left: RemainingOrder[] = [];
    for (const delay of READBACK_DELAYS_MS) {
        await wait(delay);
        left = [];
        for (const [account, orders] of byAccount) {
            const type = account.account_type as 'S' | 'F';
            try {
                const raw = await query.read(type, account, current => fetchPositions(type, current));
                const codes = orders.map(o => o.code);
                const plan = planFlatten(raw.map(r => ({ ...r, account })), { type: 'code', codes, account: account as AccountRef });
                left.push(...plan.orders);
                // a holding the plan cannot read (direction / quantity unclear,
                // both sides): never reported as closed
                for (const s of plan.skipped) {
                    const sent = orders.find(o => o.code === s.code);
                    if (sent && !plan.orders.some(o => o.code === s.code)) left.push({ ...sent, unconfirmed: true });
                }
            } catch {
                // unknown: everything sent for this account stays to be checked
                left.push(...orders.map(o => ({ ...o, unconfirmed: true })));
            }
        }
        if (!left.length) break;
    }
    return left;
}

async function sendClose(o: FlattenOrder, account: Account, serverMode: ServerModeGuard) {
    // 商品資料讀取在任何送單之前：失敗即確定未送出（不列入 readBack）
    let contract: Awaited<ReturnType<typeof ensureContract>> & { limit_up?: number; limit_down?: number };
    try {
        contract = await ensureContract(o.code);
    } catch (e) {
        throw Object.assign(new Error(`商品資料讀取失敗，未送出委託：${e instanceof Error ? e.message : String(e)}`), { mutationNotStarted: true });
    }
    if (o.market === 'futures') {
        // 範圍市價 + 平倉: the broker refuses closing more than is open
        await placeQuickOrder(contract, o.action, null, o.quantity, {
            source: 'auto', bypassRisk: true, account, ocType: 'Cover', serverMode,
            ...(contract.security_type === 'FUT' || contract.security_type === 'OPT' ? { futuresPriceType: 'MKP' as const } : {}),
        });
        return;
    }
    // stocks (現股): whole lots at market, the odd remainder as an
    // IntradayOdd limit at the price limit (零股沒有市價)
    const lots = Math.floor(o.quantity / 1000);
    const odd = o.quantity % 1000;
    // 信用了結只送整張（零股不能信用交易）：不拆零股腳、不改送現股
    if (o.cond && (odd > 0 || lots <= 0)) throw Object.assign(new Error('信用部位只能整張了結，未送出'), { mutationNotStarted: true });
    if (lots > 0) await placeQuickOrder(contract, o.action, null, lots, { source: 'auto', bypassRisk: true, account, serverMode, ...(o.cond ? { orderCond: o.cond } : {}) });
    if (odd > 0) {
        // the whole lots already went out: say so (they are read back)
        const partial = lots > 0 ? { partialSent: lots * 1000 } : {};
        const limit = o.action === 'Sell' ? contract.limit_down : contract.limit_up;
        if (!limit || !(limit > 0)) throw Object.assign(new Error(`零股 ${odd} 股需要漲跌停價，未送出`), { mutationNotStarted: lots === 0, ...partial });
        try {
            await placeQuickOrder(contract, o.action, limit, odd, { source: 'auto', bypassRisk: true, account, orderLot: 'IntradayOdd', serverMode });
        } catch (e) {
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), partial);
        }
    }
}
