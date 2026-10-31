// src/components/conditional-credit-warning.tsx — 條件單（只送現股）遇到同帳戶同代碼的
// 融券空單／融資多單時的提醒（fork）：「現股買進不會回補融券」。
// 持倉以動態載入讀取：表單本身不把交易狀態（下單、風控）拉進模組相依；
// 在 App 內 trading-state 早已載入，立即可用。讀不到就不提醒（只是提醒，不擋單）。
import { useEffect, useState } from 'react';
import { cashOrderCreditWarning } from '../lib/stock-exit-cond';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import * as styles from './conditional-panel.css';

export function CashCreditWarning({ account, code, actions }: { account: Account | null; code: string | null | undefined; actions: readonly ('Buy' | 'Sell')[] }) {
    const [rows, setRows] = useState<readonly AccountedPosition[]>([]);
    useEffect(() => {
        let alive = true;
        let off = () => {};
        void import('../lib/trading-state').then(ts => {
            if (!alive) return;
            const read = () => setRows(ts.getTradingState().positions ?? []);
            read();
            off = ts.subscribeTradingState(read);
        }).catch(() => { /* 讀不到持倉：不提醒 */ });
        return () => { alive = false; off(); };
    }, []);
    const text = cashOrderCreditWarning(rows, account, code, actions);
    return text ? <div className={styles.message.warn} role='note'>{text}</div> : null;
}
