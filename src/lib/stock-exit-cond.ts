// src/lib/stock-exit-cond.ts — 股票持倉了結的方向與信用條件（fork）。
// 持倉面板「平」／批次平倉與全平並取消共用：
// - 現股（含當沖先賣的空單）：反向現股，可含零股；
// - 融資多單：融資賣出（Sell＋MarginTrading）；
// - 融券空單：融券買進＝回補（Buy＋ShortSelling）；
// - 信用只送整張（零股不能信用交易），不拆零股腳；
// - 方向與條件不符、借券或不認得的條件：不送，回白話原因。
// 絕不把信用部位改成現股送出（現股買進不會回補融券、現股賣出不會了結融資）。

import { SHARES_PER_LOT } from './odd-lot';

export type CreditExitCond = 'MarginTrading' | 'ShortSelling';

export interface StockExit {
    exit: 'Buy' | 'Sell';
    /** 缺省＝現股 */
    orderCond?: CreditExitCond;
}

/** 持倉（方向、條件、股數）→ 了結方式；不支援回原因字串（呼叫端不得送出）。
 * 原因不含股數：通知可能在遮金額模式顯示。 */
export function stockExitFor(direction: string, cond: string | null | undefined, shares: number): StockExit | string {
    const exit = direction === 'Buy' ? 'Sell' : direction === 'Sell' ? 'Buy' : null;
    if (!exit) return '持倉方向不明，未送出委託';
    const c = cond || 'Cash';
    if (c === 'Cash') return { exit };
    if (c !== 'MarginTrading' && c !== 'ShortSelling') return '借券或其他信用條件的持倉不支援一鍵平倉，請至下單面板或券商處理，未送出委託';
    const name = c === 'ShortSelling' ? '融券' : '融資';
    if ((c === 'ShortSelling') !== (direction === 'Sell')) return `${name}持倉的方向與條件不符，無法判斷了結方式，未送出委託`;
    if (!Number.isSafeInteger(shares) || shares <= 0 || shares % SHARES_PER_LOT !== 0) {
        return `${name}持倉股數不是整張（1,000 股）的倍數；零股不能以信用條件了結，請至券商處理，未送出委託`;
    }
    return { exit, orderCond: c };
}

/** 確認／通知用的動作名稱：融券買進、融資賣出；現股回空字串。 */
export function creditExitLabel(orderCond: CreditExitCond | undefined): string {
    return orderCond === 'ShortSelling' ? '融券' : orderCond === 'MarginTrading' ? '融資' : '';
}

type HoldingRow = { code: string; direction: string; cond?: string | null; account?: { account_type: string; broker_id?: string; account_id: string } | null };

/** 現股觸價／條件單的提醒：同帳戶持有該碼融券空單時現股買進不會回補，持有融資多單時
 * 現股賣出不會了結融資。條件單只送現股（TriggerOrder 沒有信用條件），所以只提醒、不改單。 */
export function cashOrderCreditWarning(rows: readonly HoldingRow[], account: { account_type: string; broker_id?: string; account_id: string } | null | undefined,
    code: string | null | undefined, actions: readonly ('Buy' | 'Sell')[]): string | null {
    if (!account || account.account_type !== 'S' || !code) return null;
    const held = rows.filter(p => p.code === code && p.account && p.account.account_type === 'S'
        && p.account.broker_id === account.broker_id && p.account.account_id === account.account_id);
    const notes: string[] = [];
    if (actions.includes('Buy') && held.some(p => p.direction === 'Sell' && p.cond === 'ShortSelling')) {
        notes.push('此帳戶持有融券空單：現股買進不會回補融券（條件單只送現股，成交後會另外多一筆現股多單）；回補請用持倉「平」或下單面板的融券買進');
    }
    if (actions.includes('Sell') && held.some(p => p.direction === 'Buy' && p.cond === 'MarginTrading')) {
        notes.push('此帳戶持有融資多單：現股賣出不會了結融資（條件單只送現股）；了結請用持倉「平」或下單面板的融資賣出');
    }
    return notes.length ? notes.join('；') : null;
}

/** 手動下單（下單面板、K 線點價、閃電）的信用提醒文案：只提示、不改條件、不擋單。 */
export const CASH_BUY_NO_COVER_NOTE = '現股買進不會回補融券：此帳戶持有此股票的融券空單，成交後會另外多一筆現股多單；回補請改用「融券（回補）」';
export const CASH_SELL_NO_CLOSE_NOTE = '現股賣出不會了結融資：此帳戶持有此股票的融資多單；了結請改用「融資」賣出';
export const CASH_SELL_NO_CLOSE_TEXT = '現股賣出不會了結融資：此股票有融資多單，了結請把信用條件切到「融資」';
export const NO_SHORT_TO_COVER_NOTE = '查無此商品的融券空單，券商可能拒絕';

export interface ManualCreditHint {
    text: string;
    /** 一鍵改用的信用條件（使用者按了才改）；null＝只提示 */
    suggest: CreditExitCond | null;
}

/** 手動整股下單的信用提醒（只看同帳戶同代碼、股數大於 0 的列）：
 * - 現股買進且持有融券空單 → 不會回補融券（建議融券）；
 * - 現股賣出且持有融資多單 → 不會了結融資（建議融資）；
 * - 融券買進但查無融券空單 → 券商可能拒絕（只提示）。
 * rows 為 null＝持倉尚未載入：一律不提示（不說「查無」）。 */
export function manualStockCreditHint(
    rows: readonly (HoldingRow & { quantity?: number })[] | null | undefined,
    account: { account_type: string; broker_id?: string; account_id: string } | null | undefined,
    code: string | null | undefined, action: 'Buy' | 'Sell', orderCond: string | null | undefined,
): ManualCreditHint | null {
    if (!rows || !account || account.account_type !== 'S' || !code) return null;
    const held = rows.filter(p => p.code === code && p.account && p.account.account_type === 'S'
        && p.account.broker_id === account.broker_id && p.account.account_id === account.account_id
        && !(typeof p.quantity === 'number' && !(p.quantity > 0)));
    const hasShort = held.some(p => p.direction === 'Sell' && p.cond === 'ShortSelling');
    const cond = orderCond || 'Cash';
    if (cond === 'Cash') {
        if (action === 'Buy' && hasShort) return { text: CASH_BUY_NO_COVER_NOTE, suggest: 'ShortSelling' };
        if (action === 'Sell' && held.some(p => p.direction === 'Buy' && p.cond === 'MarginTrading')) {
            return { text: CASH_SELL_NO_CLOSE_NOTE, suggest: 'MarginTrading' };
        }
        return null;
    }
    if (cond === 'ShortSelling' && action === 'Buy' && !hasShort) return { text: NO_SHORT_TO_COVER_NOTE, suggest: null };
    return null;
}
