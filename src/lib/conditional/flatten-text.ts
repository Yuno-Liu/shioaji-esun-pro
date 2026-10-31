// src/lib/conditional/flatten-text.ts — 全平並取消 quantity wording (#226), pure.

/** 「8 張＋6 股」 / 「2 口」: whole lots and the odd remainder of a stock. */
export function quantityText(market: 'stock' | 'futures', quantity: number): string {
    if (market === 'futures') return `${quantity} 口`;
    const lots = Math.floor(quantity / 1000);
    const odd = quantity % 1000;
    return [lots > 0 ? `${lots} 張` : '', odd > 0 ? `${odd} 股` : ''].filter(Boolean).join('＋') || '0 股';
}

/** How a close goes out: futures 範圍市價; stocks 整股市價、零股限價;
 * 信用了結（整張）加上「融資賣出／融券買進」. */
export function closeHowText(market: 'stock' | 'futures', quantity: number, cond?: 'MarginTrading' | 'ShortSelling'): string {
    if (market === 'futures') return '範圍市價';
    if (cond) return `${cond === 'ShortSelling' ? '融券買進' : '融資賣出'}・整股市價`;
    const lots = Math.floor(quantity / 1000);
    const odd = quantity % 1000;
    return lots > 0 && odd > 0 ? '整股市價、零股限價' : odd > 0 ? '零股限價' : '整股市價';
}

type ScopeAccount = { account_type: 'S' | 'F'; broker_id: string; account_id: string };

/** 再平倉: one scope per account (full key), each with only its remaining products. */
export function remainingScopes(remaining: readonly { account: ScopeAccount; code: string }[]): { type: 'code'; codes: string[]; account: ScopeAccount }[] {
    const byAccount = new Map<string, { account: ScopeAccount; codes: Set<string> }>();
    for (const o of remaining) {
        const key = `${o.account.account_type}:${o.account.broker_id}:${o.account.account_id}`;
        const g = byAccount.get(key) ?? { account: o.account, codes: new Set<string>() };
        g.codes.add(o.code);
        byAccount.set(key, g);
    }
    return [...byAccount.values()].map(g => ({ type: 'code' as const, codes: [...g.codes], account: g.account }));
}
