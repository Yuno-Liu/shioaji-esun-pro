// src/mobile/components/sector/sector-members.tsx — 產業說明面板的「成分股」清單（隨產業流向分段延遲載入）
//
// 資料：與桌面「產業全景」下鑽相同的群組內排行投影（src/components/sector-heatmap.tsx groupRanking 'amount'）：
//   retainIndexComponents(指數, { kind: 'ranking', target: 'component', metric: 'amount', order: 'desc', limit: 10, group })。
//   每列 IcRankingEntry 已帶 price／price_chg／pct_chg／value（成交值）／weight_pct，不另訂個股行情。
//   published matrix 的群組內排行每組最多 10 檔，因此只列成交值前 10 檔；「漲跌幅」只把這 10 檔重新排序。
// 訂閱：面板開啟（有選取的產業）且產業頁正在 retain（不在 sector-retry.ts 的建底錯誤冷卻中）時 retain 1 條投影，
//   關閉面板、換產業、換市場、離開本頁時 release（capability 層 ref-count：subscribe 1 次、unsubscribe 1 次）。
//   建底已就緒時 lib 立即由建底快照投出初始列（0 個額外查詢）；冷卻中不 retain（retain 會讓 lib 重新建底），只顯示已快取的列。
// 名稱：IcRankingEntry 沒有名稱；只為可見列經 lib/contract-names 向永豐查一次合約（每代碼 session 1 次、同時 ≤2、失敗不重試）。
//   查到的合約也帶漲跌停價：成交價等於漲跌停時套用與報價列相同的實心底與「漲停／跌停」小標（lib/limit-hit.ts）；
//   試撮（投影 simtrade）時不標示。
// 點列：只關閉面板並 navigate 到交易頁；沒有下單、改單、刪單入口（§10 S1）。

import { useEffect, useRef, useState } from 'react';
import { useContract } from '../../../lib/contracts-cache';
import { getIcBootstrapStatus, getIcState, getIcSubError, projectionKey, retainIndexComponents } from '../../../lib/index-components';
import { IC_INDICES, type IcIndexCode } from '../../../lib/sector-flow-ic';
import type { IcProjection, IcRankingEntry } from '../../../lib/types/market';
import { fmtPct, fmtPrice } from '../../../lib/utils/format';
import { instrumentText, useContractName } from '../../lib/contract-names';
import { quoteLimit, type LimitState } from '../../lib/limit-hit';
import * as s from '../../styles/sector.css';
import { limitPrice } from '../../styles/watchlist.css';
import { GroupedSection } from '../../ui/grouped';
import { Segmented } from '../../ui/segmented';
import { FALLBACK_VISIBLE_ROWS, useRowVisible, useVisibilityTracker, type VisibilityTracker } from '../quote-row';
import { fmtSectorMoney, toneOf } from './sector-model';

/** 群組內排行每組最多 10 檔（published matrix，同桌面 GROUP_RANK_LIMIT） */
export const SECTOR_MEMBERS_LIMIT = 10;

export type MemberSort = 'amount' | 'pct';

const LIMIT_LABEL: Record<LimitState, string> = { up: '漲停', down: '跌停' };

const SORT_ITEMS: readonly { value: MemberSort; label: string; testId: string }[] = [
    { value: 'amount', label: '成交值', testId: 'sector-members-sort-amount' },
    { value: 'pct', label: '漲跌幅', testId: 'sector-members-sort-pct' },
];

export const SECTOR_MEMBERS_NOTE = '依成交值取前 10 檔（漲跌幅只重排這 10 檔）；價格隨產業資料更新，不另訂個股行情。點一下開啟交易頁。';

/** 群組內成交值排行投影（與桌面下鑽相同） */
export function membersProjection(group: string): IcProjection {
    return { kind: 'ranking', target: 'component', metric: 'amount', order: 'desc', limit: SECTOR_MEMBERS_LIMIT, group };
}

/** 排序（新陣列）：成交值由大到小（投影本身的順序）、漲跌幅由大到小；非有限值排最後 */
export function sortMembers(entries: readonly IcRankingEntry[], sort: MemberSort): IcRankingEntry[] {
    const key = (e: IcRankingEntry) => {
        const v = sort === 'pct' ? e.pct_chg : e.value;
        return Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
    };
    return [...entries].sort((a, b) => key(b) - key(a));
}

/** 面板開啟期間 retain 該產業的成分股投影；enabled＝false（冷卻中）或沒有產業時不 retain */
export function useSectorMembersRetain(index: IcIndexCode, group: string | null, enabled: boolean): void {
    useEffect(
        () => (enabled && group !== null ? retainIndexComponents(IC_INDICES[index], membersProjection(group)) : undefined),
        [index, group, enabled],
    );
}

const signed = (v: number) => `${v > 0 ? '+' : ''}${fmtPrice(v)}`;

function MemberRow({ entry, index, tracker, sim, onPick }: {
    entry: IcRankingEntry;
    index: number;
    tracker: VisibilityTracker | null;
    sim: boolean;
    onPick(code: string): void;
}) {
    const code = entry.code;
    const ref = useRef<HTMLButtonElement | null>(null);
    const visible = useRowVisible(ref, tracker, index < FALLBACK_VISIBLE_ROWS);
    const name = useContractName(code, null, 'STK', visible);
    const contract = useContract(code);
    const limit = quoteLimit(contract, entry.price, sim);
    const tone = toneOf(entry.price_chg);
    const priceText = entry.price > 0 ? fmtPrice(entry.price) : '—';
    const changeText = Number.isFinite(entry.price_chg) ? `${signed(entry.price_chg)} ${fmtPct(entry.pct_chg)}` : '—';
    const amountText = fmtSectorMoney(entry.value);
    const weightText = Number.isFinite(entry.weight_pct) ? `${entry.weight_pct.toFixed(2)}%` : '—';
    const aria = `${instrumentText(code, name)}，${limit ? `${LIMIT_LABEL[limit]} ` : ''}${priceText}，漲跌 ${changeText}，成交值 ${amountText}，權重 ${weightText}，開啟交易頁`;
    return (
        <button ref={ref} type='button' className={s.row} aria-label={aria} data-testid='sector-member' data-code={code} onClick={() => onPick(code)}>
            <span className={s.rowTop}>
                <span className={s.memberTitle}>
                    <span className={s.rowName} data-testid='sector-member-name'>{name ?? code}</span>
                    {name ? <span className={s.memberCode}>{code}</span> : null}
                </span>
                <span className={`${s.memberPrice} ${limit ? limitPrice[limit] : s.valueTone[tone]}`} data-testid='sector-member-price' data-limit={limit ?? undefined}>
                    {priceText}
                </span>
            </span>
            <span className={s.rowMeta}>
                <span className={s.metaItem}>成交<span className={s.num.flat}>{amountText}</span></span>
                <span className={s.metaItem}>權重<span className={s.num.flat}>{weightText}</span></span>
                <span className={`${s.metaItem} ${s.num[tone]}`} data-testid='sector-member-change'>{changeText}</span>
            </span>
        </button>
    );
}

export interface SectorMembersProps {
    index: IcIndexCode;
    group: string;
    /** 產業頁正在 retain（不在建底錯誤冷卻中）；false 時不 retain、只顯示已快取的列 */
    enabled: boolean;
    /** 點列：呼叫端關閉面板並開交易頁 */
    onPick(code: string): void;
}

/** 成分股清單；資料由父層每秒重繪時直接讀 index_components store（不另掛監聽） */
export function SectorMembers({ index, group, enabled, onPick }: SectorMembersProps) {
    useSectorMembersRetain(index, group, enabled);
    const [sort, setSort] = useState<MemberSort>('amount');
    const tracker = useVisibilityTracker();
    const key = projectionKey(membersProjection(group));
    const state = getIcState(index, key);
    const entries = sortMembers(state?.entries ?? [], sort);
    const subError = getIcSubError(index, key);
    const bootstrap = getIcBootstrapStatus(index).status;

    let body;
    if (entries.length > 0) {
        body = entries.map((entry, i) => (
            <MemberRow key={entry.code} entry={entry} index={i} tracker={tracker} sim={state?.simtrade === true} onPick={onPick} />
        ));
    } else {
        const text = subError
            ? `成分股訂閱失敗：${subError}`
            : enabled && (bootstrap === 'idle' || bootstrap === 'pending')
                ? '成分股載入中…'
                : '暫無成分股資料。';
        body = <p className={s.memberEmpty} role='status' data-testid='sector-members-empty'>{text}</p>;
    }
    return (
        <>
            <Segmented<MemberSort> items={SORT_ITEMS} value={sort} onChange={setSort} semantics='toggle' ariaLabel='成分股排序' size='compact' testId='sector-members-sort' />
            <GroupedSection header={`成分股（成交值前 ${SECTOR_MEMBERS_LIMIT} 檔）`} footer={SECTOR_MEMBERS_NOTE} testId='sector-members'>
                {body}
            </GroupedSection>
        </>
    );
}
