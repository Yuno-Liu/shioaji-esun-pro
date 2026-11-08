// src/mobile/components/watch-picker-sheet.tsx — 交易頁 ☆「加入自選」：一次加入／移出多個自選清單（設計規格 §7.3）
//
// - 延遲載入（components/load-watch-picker-sheet.ts；交易頁第一次按 ☆ 才 import，不閒置預載）。
// - 依這台裝置的群組順序（lib/watch-list-order.ts）列出伺服器上的每個自選清單（名稱、檔數，目前清單標「（目前）」）與勾選狀態：商品是否在該清單以
//   serverLists[].contracts 的代碼＋商品類別比對（listsWithContract）。沒有清單時顯示空狀態（這裡不建立清單）。
// - 使用者勾選任意清單後按「完成」才送出差異；「取消」或關閉面板捨棄。
// - 送出（applyWatchPicks；依序、逐一 await）：
//   - 目前清單：hook 的 addSymbol(code, type, contract)／removeSymbol(code)（帶已載入的合約，不重新解析）——
//     POST 或 DELETE 一次＋GET 清單一次（加入時 hook 另為新列讀一次快照）；
//   - 其他清單：lib/shioaji 的 addWatchlistContracts／removeWatchlistContracts(listId, [contract])——各一次 POST 或 DELETE；
//     hook 的 addSymbol／removeSymbol 只能改目前清單，其他清單走上游 AI Agent 工具同一條「外部變更」路徑；
//   - 有改到其他清單（或任何一項失敗）時最後 emitWatchlistChanged({ source: 'user' }) 一次：hook 的 reloadFromServer
//     丟掉本機覆蓋、GET 清單並重新載入目前清單（目前清單每檔一次合約資訊＋一次快照；有寫入未完成時延後到完成後）。
//   - 每個清單分別記錄成敗；最後一次 notify() 摘要（例如「已加入 2 個清單、移出 1 個清單」或失敗原因）。
// - 只改自選，不下單（S1）。

import { useEffect, useState } from 'react';
import { addWatchlistContracts, removeWatchlistContracts, type ServerWatchlist } from '../../lib/shioaji';
import { notify } from '../../lib/trade';
import type { ContractInfo } from '../../lib/types/contract';
import { emitWatchlistChanged } from '../../lib/watchlist-sync';
import { orderLists } from '../lib/watch-list-order';
import type { MobileWatchlist } from '../lib/watchlist-context';
import { button } from '../styles/controls.css';
import { pressableRow } from '../styles/primitives.css';
import * as styles from '../styles/watch-picker.css';
import { BottomSheet } from './bottom-sheet';

/** 商品是否在這個清單（代碼＋商品類別） */
export const inList = (list: Pick<ServerWatchlist, 'contracts'>, c: Pick<ContractInfo, 'code' | 'security_type'>): boolean =>
    list.contracts.some(x => x.code === c.code && x.security_type === c.security_type);

export interface PickChange {
    list: Pick<ServerWatchlist, 'id' | 'name'>;
    /** true：加入；false：移出 */
    add: boolean;
}

export interface PickResult {
    added: number;
    removed: number;
    failed: { name: string; add: boolean; reason: string }[];
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : '請稍後再試');

/**
 * 依序套用勾選差異：目前清單走 hook（POST／DELETE＋GET），其他清單各一次 POST／DELETE，
 * 有改到其他清單或有失敗時最後 emitWatchlistChanged({ source: 'user' }) 一次（hook 重新讀取）。
 */
export async function applyWatchPicks(wl: Pick<MobileWatchlist, 'activeListId' | 'addSymbol' | 'removeSymbol'>, contract: ContractInfo, changes: readonly PickChange[]): Promise<PickResult> {
    const result: PickResult = { added: 0, removed: 0, failed: [] };
    const active = changes.filter(c => c.list.id === wl.activeListId);
    const others = changes.filter(c => c.list.id !== wl.activeListId);
    for (const c of [...active, ...others]) {
        try {
            if (c.list.id === wl.activeListId) {
                if (c.add) await wl.addSymbol(contract.code, contract.security_type, contract);
                else await wl.removeSymbol(contract.code);
            } else if (c.add) {
                await addWatchlistContracts(c.list.id, [contract]);
            } else {
                await removeWatchlistContracts(c.list.id, [contract]);
            }
            if (c.add) result.added++;
            else result.removed++;
        } catch (e) {
            result.failed.push({ name: c.list.name, add: c.add, reason: errText(e) });
        }
    }
    if (others.length || result.failed.length) emitWatchlistChanged({ source: 'user' });
    return result;
}

/** 結果通知（一則） */
export function pickSummary(what: string, r: PickResult): { kind: 'ok' | 'err'; title: string; body: string } {
    const done = [r.added ? `已加入 ${r.added} 個清單` : '', r.removed ? `移出 ${r.removed} 個清單` : ''].filter(Boolean).join('、');
    if (!r.failed.length) return { kind: 'ok', title: '自選已更新', body: `${what}：${done}` };
    const fails = r.failed.map(f => `「${f.name}」${f.add ? '加入' : '移出'}失敗：${f.reason}`).join('；');
    return { kind: 'err', title: done ? '自選部分未更新' : '自選更新失敗', body: `${what}：${done ? `${done}；` : ''}${fails}` };
}

export interface WatchPickerSheetProps {
    open: boolean;
    contract: ContractInfo;
    wl: MobileWatchlist;
    onClose: () => void;
    /** 套用中（交易頁的 ☆ 以 aria-disabled 表示） */
    onBusy: (busy: boolean) => void;
}

export function WatchPickerSheet({ open, contract, wl, onClose, onBusy }: WatchPickerSheetProps) {
    // 依這台裝置的群組順序顯示（lib/watch-list-order.ts；自選頁編輯模式「排序群組」）
    const lists = orderLists(wl.serverLists);
    /** 使用者改過的勾選（清單 id → 勾選）；沒改過的清單顯示目前狀態。每次開啟清空 */
    const [picks, setPicks] = useState<ReadonlyMap<string, boolean>>(() => new Map());
    useEffect(() => { if (open) setPicks(new Map()); }, [open]);
    const checked = (l: ServerWatchlist) => picks.get(l.id) ?? inList(l, contract);
    const what = `${contract.code}${contract.name ? ` ${contract.name}` : ''}`;

    const done = async () => {
        const changes = lists.filter(l => checked(l) !== inList(l, contract)).map(l => ({ list: l, add: checked(l) }));
        onClose();
        if (!changes.length) return;
        onBusy(true);
        try {
            notify(pickSummary(what, await applyWatchPicks(wl, contract, changes)));
        } finally {
            onBusy(false);
        }
    };

    return (
        <BottomSheet
            open={open}
            onClose={onClose}
            title='加入自選'
            testId='watch-picker'
            footer={(
                <div className={styles.actions}>
                    <button type='button' className={button.neutral} onClick={onClose} data-testid='watch-picker-cancel'>取消</button>
                    <button type='button' className={button.primary} onClick={() => void done()} data-testid='watch-picker-done'>完成</button>
                </div>
            )}
        >
            <div className={styles.body}>
                <p className={styles.note}>
                    {lists.length ? `勾選要放入「${what}」的清單，按「完成」才會儲存。自選清單與桌面共用。` : '還沒有自選清單。請到「自選」頁新增清單。'}
                </p>
                {lists.length > 0 && (
                    <ul className={styles.list} aria-label='自選清單' data-testid='watch-picker-lists'>
                        {lists.map(l => (
                            <li key={l.id}>
                                {/* 原生勾選框（整列是 label，點擊區 ≥ TOUCH_MIN）：不另載圖示 chunk */}
                                <label className={`${styles.row} ${pressableRow}`} data-testid='watch-picker-list' data-list-id={l.id}>
                                    <input
                                        type='checkbox'
                                        className={styles.checkbox}
                                        checked={checked(l)}
                                        onChange={() => setPicks(p => new Map(p).set(l.id, !checked(l)))}
                                        data-testid='watch-picker-check'
                                    />
                                    <span className={styles.name}>{l.name}</span>
                                    {l.id === wl.activeListId && <span className={styles.meta}>（目前）</span>}
                                    <span className={styles.meta}>{`${l.contracts.length} 檔`}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </BottomSheet>
    );
}
