// src/mobile/components/watch-index-panel.tsx — 自選頁底部指數列的展開面板（加權｜櫃買兩欄）
//
// - 延遲載入（lib/deferred-modules.ts loadWatchIndexPanel）：只在指數列展開時掛載（watch-index-strip.tsx），
//   本檔與 watch-index-panel.css.ts 不進首屏；載入中、載入失敗時指數列顯示收合的兩格。
// - 每欄依序：標籤、指數（大字）、▲／▼＋漲跌點數＋漲跌幅、成交金額（億）、盤中預估成交金額（有值、且在 09:00–13:30 時段內才顯示）、
//   當日走勢面積圖。
//   數值與漲跌（即時優先、快照後備）與收合的兩格共用 watch-index-strip 的 useIndexView。
// - 成交金額：即時 index.amount_sum 優先；沒有或空字串時用快照 total_amount；兩者都沒有顯示「—」。單位元 → 億（四捨五入、千分位）。
// - 走勢：WatchSparkCell（watch-sparkline.tsx；1 分 K＋即時尾段）。reference＝昨收（即時 reference，或快照 close − change_price），
//   tick＝即時 index（close／date／time；沒有即時時不寫尾段）。K 線請求由 lib/watch-sparkline-data.ts 的快取與上限處理
//   （每檔每個時段最多 2 次、同時最多 2 個），本檔不另外輪詢。面板卸載（收合、離開自選頁）即釋放。
// - 外觀：bar 材質上的文字一律 foreground；方向以有色 ▲▼ 圖形（DirArrow）表示；走勢線顏色由 WatchSparkline 依昨收決定。
// - 每欄是一個按鈕：只 navigate 到該指數的交易頁（不新增下單入口）；aria-label 含數值、漲跌與成交金額。

import { useSyncExternalStore } from 'react';
import type { ContractBase } from '../../lib/types/contract';
import { fmtSigned } from '../../lib/utils/format';
import { navigate } from '../lib/hash-router';
import { fmtInt } from '../lib/num-format';
import { sparkSessionClosed, subscribeSparkClock } from '../lib/watch-sparkline-data';
import * as styles from '../styles/watch-index-panel.css';
import { focusRing, pressable } from '../styles/primitives.css';
import { DirArrow, useIndexView, WATCH_INDICES } from './watch-index-strip';
import { WatchSparkCell } from './watch-sparkline';

/** 元 → 億（四捨五入到整數、千分位）；空字串、非數字、負數視為沒有資料（undefined） */
export function fmtYi(v: string | number | null | undefined): string | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return fmtInt(Math.round(n / 1e8));
}

function IndexColumn({ contract, label }: { contract: ContractBase; label: string }) {
    const code = contract.code;
    const { index, snap, live, has, ref, chg, dir, value, pctText, dirWord } = useIndexView(contract);
    const amount = fmtYi(index?.amount_sum) ?? fmtYi(snap?.total_amount);
    // 預估成交金額只在盤中有意義：開盤前、收盤後（含寬限）不顯示（最後一筆即時報價可能還帶著預估值）。
    // 時鐘每分鐘重算一次，跨過收盤時自動隱藏
    const closed = useSyncExternalStore(subscribeSparkClock, () => sparkSessionClosed('IND'), () => true);
    const estimate = closed ? undefined : fmtYi(index?.estimate_amount_sum);
    const chgText = chg !== undefined ? fmtSigned(chg, 2) : '';
    const amountText = amount !== undefined ? `${amount} 億` : '—';
    const aria = [
        `${label}指數 ${has ? value : '— 沒有即時資料'}`,
        chgText && `${dirWord} ${chgText} 點 ${pctText}`,
        `成交金額 ${amountText}`,
        estimate && `預估 ${estimate} 億`,
        '開啟交易頁',
    ].filter(Boolean).join('，');
    return (
        <button
            type='button'
            className={`${styles.column} ${pressable} ${focusRing}`}
            aria-label={aria}
            onClick={() => navigate({ name: 'trade', code })}
            data-testid={`watch-index-panel-${code}`}
            data-source={live ? 'live' : has ? 'snapshot' : 'none'}
            data-dir={dir}
        >
            <span className={styles.info}>
                <span className={styles.label} aria-hidden='true'>{label}</span>
                <span className={styles.value} aria-hidden='true' data-testid='watch-index-panel-value'>{value}</span>
                {chgText && (
                    <span className={styles.change} aria-hidden='true' data-testid='watch-index-panel-change'>
                        {dir !== 'flat' && <DirArrow dir={dir} />}
                        <span className={styles.nowrap}>{chgText}</span>
                        <span className={styles.nowrap}>{pctText}</span>
                    </span>
                )}
                <span className={styles.amount} aria-hidden='true' data-testid='watch-index-amount'>
                    <span className={styles.nowrap}>成交金額</span>
                    <span className={styles.nowrap}>{amountText}</span>
                </span>
                {estimate && (
                    <span className={styles.estimate} aria-hidden='true' data-testid='watch-index-estimate'>
                        預估 {estimate} 億
                    </span>
                )}
            </span>
            <WatchSparkCell
                contract={contract}
                reference={Number.isFinite(ref) && ref > 0 ? ref : undefined}
                tick={live ? index : undefined}
                className={styles.chart}
            />
        </button>
    );
}

export function WatchIndexPanel() {
    return (
        <div className={styles.panel} data-testid='watch-index-panel'>
            {WATCH_INDICES.map(i => <IndexColumn key={i.contract.code} contract={i.contract} label={i.label} />)}
        </div>
    );
}
