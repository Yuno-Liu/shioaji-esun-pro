// src/mobile/lib/reveal-compat.ts — 不用 lookbehind 的 revealText（設計規格 §12 相容 iOS 15.4）
//
// src/lib/privacy.ts 的 revealText 在「隱私模式開啟且有已知帳號」時以含 (?<![0-9A-Za-z]) 的字串 new RegExp；
// Safari 16.4 以前不支援 lookbehind，會在渲染時丟 SyntaxError。src/lib 不改，這裡改成：
// 1. 呼叫 revealText 時不傳 accountIds（只處理 secretMoney／secretAccount 標記，不會走 lookbehind 分支）；
// 2. 已知帳號以「只含 lookahead 的正規式＋手動檢查前一字元」逐一比對，語意與原式逐字一致：
//    原式在某位置 lookbehind 失敗時從下一個位置重試，這裡同樣從 index + 1 續找；
//    比對與前一字元檢查都以原字串為準（String.prototype.replace 亦然）。
// 帳號規則同原函式：去重、長度 ≥ 4、依長度由長到短、escape、以 maskAccountId(id, true) 遮成末兩碼。

import { useCallback, useMemo } from 'react';
import { useAccounts } from '../../lib/account-store';
import { maskAccountId, revealText, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';

export interface RevealOptions {
    priv: boolean;
    privMoney: boolean;
    accountIds?: readonly string[];
}

const ALNUM = /[0-9A-Za-z]/;

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 已知帳號的比對式（只有 lookahead）；沒有可遮的帳號時為 null */
function accountMatcher(accountIds: readonly string[]): RegExp | null {
    const ids = [...new Set(accountIds.filter(id => id.length >= 4))].sort((a, b) => b.length - a.length);
    if (!ids.length) return null;
    return new RegExp(`(?:${ids.map(escapeRe).join('|')})(?![0-9A-Za-z])`, 'g');
}

/** 把文字中出現的已知帳號遮成末兩碼；前一字元為英數時不算（等同原式的 (?<![0-9A-Za-z])） */
function maskKnownAccounts(text: string, re: RegExp): string {
    let out = '';
    let copied = 0;
    let from = 0;
    while (from <= text.length) {
        re.lastIndex = from;
        const m = re.exec(text);
        if (!m) break;
        const at = m.index;
        if (at > 0 && ALNUM.test(text[at - 1]!)) {
            from = at + 1;
            continue;
        }
        out += text.slice(copied, at) + maskAccountId(m[0], true);
        copied = at + m[0].length;
        // 帳號長度 ≥ 4，不會是空字串比對
        from = copied;
    }
    return copied === 0 ? text : out + text.slice(copied);
}

/** 與 revealText 輸出逐字一致，但任何情況都不建構含 lookbehind 的正規式 */
export function revealTextCompat(text: string, opts: RevealOptions): string {
    const out = revealText(text, { priv: opts.priv, privMoney: opts.privMoney });
    if (!opts.priv || !opts.accountIds?.length) return out;
    const re = accountMatcher(opts.accountIds);
    return re ? maskKnownAccounts(out, re) : out;
}

/** 取代 src/lib/privacy-text.ts 的 useRevealText（同樣依目前隱私／遮金額開關與帳號清單） */
export function useRevealTextCompat(): (text: string) => string {
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const { accounts } = useAccounts();
    const accountIds = useMemo(() => accounts.map(a => a.account_id), [accounts]);
    const re = useMemo(() => (priv && accountIds.length ? accountMatcher(accountIds) : null), [priv, accountIds]);
    return useCallback(
        (text: string) => {
            const out = revealText(text, { priv, privMoney });
            return re ? maskKnownAccounts(out, re) : out;
        },
        [priv, privMoney, re],
    );
}
