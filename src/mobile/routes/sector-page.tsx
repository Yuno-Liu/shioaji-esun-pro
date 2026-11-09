// src/mobile/routes/sector-page.tsx — 產業流向（「市場」分頁的第一個分段，#/market；由 routes/market-page.tsx 渲染，隨市場頁延遲載入）
//
// 只在顯示產業流向分段時掛載：下列訂閱與建底只在這段期間發生（切到「盤中異動」即卸載、釋放）。
//
// 資料（重用桌面既有的純資料邏輯，不修改它們）：
// - useIcSectorFlow(true)：本頁掛載期間 retain 上市（IX0001）／上櫃（IX0043）的群組指標串流（成交值、加權漲跌），
//   ref-count 由 lib 管理，卸載即釋放；同時餵 icFlowRecorder 記錄每分鐘資金流向。
// - getIcState：群組指標目前狀態（建底快照或串流，calculated_at 新者勝）→ 名稱、加權漲跌、成交值。
// - 建底查詢由 lib/index-components 依 ADR 0001 管理：每指數每 session 首次一次＋日切一次；
//   429 降級顯示、不重試；本頁不自行查詢、不輪詢、不加逐檔查詢。
//   一般錯誤（非 429）與訂閱失敗提供［重試］（components/sector/sector-retry.ts）：以租約再 retain 需要的投影並持有到
//   卸載（不 retain 後立刻 release）。只有建底失敗時 retain 一條訂閱正常的投影（只加 ref-count，不送 subscribe）觸發重新建底；
//   訂閱失敗時只 retain 失敗的投影（實際重送 1 次 subscribe），卸載時 capability 層 ref-count 保證只退訂 1 次。
//   非 429 建底錯誤後 60 秒內再進入本頁：不 retain（不自動重新建底、不訂閱），顯示錯誤與［重試］；
//   冷卻結束或按［重試］才開始 retain。
// - 資金流向自開啟本頁起累計（離開本頁的時段不計入）；已量到流向時，收盤後仍顯示今日量到的流向（並標示已收盤）；
//   沒有量測（盤後才開啟、週末、尚無即時資料）時流向顯示「—」並說明原因，漲跌與成交值仍以建底快照顯示。
// 請求（每次進入本頁）：群組指標訂閱 4 筆（2 指數 × 2 投影；離開時退訂 4 筆）；建底 ≤2 筆／session（已建底 0 筆）。
// 產業說明面板：每次開啟（且不在冷卻中）成分股排行訂閱 1 筆、關閉退訂 1 筆（components/sector/sector-members.tsx）；
//   成分股名稱只為可見列查合約（每代碼 session 1 次）。
// 手動重試：每按一次，建底失敗的指數建底 1 筆；訂閱失敗的投影各 subscribe 1 筆（離開時與原本的一起只退訂 1 筆）。
// 排序（使用者要求「市場-產業流向新增排序功能」；components/sector/sector-model.ts）：資金流向（預設，由淨流入到淨流出）｜
//   近5分｜漲跌幅｜成交值，再點目前的選項＝反向（選中的段顯示 ↓／↑）；沒有資料的列不論方向都在最後；偏好存在這台裝置。
//   只排序頁面上已有的資料：0 個請求。
// 版面：PageHeader、Segmented（市場、排序）、GroupedSection（摘要、產業列）、BottomSheet（產業說明）；
// 產業列只開說明面板，成分股列只關面板並開交易頁，不呼叫任何下單、改單、刪單函式（§10 S1）。

import { Factory } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    getIcBootstrapGroupWeights,
    getIcBootstrapStatus,
    getIcState,
    getIcSubError,
    getIcVersion,
    projectionKey,
    subscribeIcStore,
} from '../../lib/index-components';
import { GM_AMOUNT, GM_WPERF, icFlowRecorder, icSlot, useIcSectorFlow, type IcIndexCode, type IcKey } from '../../lib/sector-flow-ic';
import { SectorDetailSheet } from '../components/sector/sector-detail-sheet';
import { retainSectorRetry, sectorCooldownEnd, watchSectorBootstrapErrors } from '../components/sector/sector-retry';
import {
    buildSectorRows,
    flowShown,
    flowStatusOf,
    fmtCalculatedAt,
    fmtSectorMoney,
    fmtSectorPct,
    MARKET_INDEX,
    MARKET_LABEL,
    nextSectorSort,
    readSectorSort,
    SECTOR_MARKETS,
    SECTOR_SORT_OPTIONS,
    sectorSortDirText,
    sortSectorRowsBy,
    toneOf,
    topFlows,
    visibleFlow,
    type FlowStatus,
    type SectorMarket,
    type SectorRow,
    type SectorSortKey,
    type SectorSortPref,
    writeSectorSort,
} from '../components/sector/sector-model';
import * as s from '../styles/sector.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { Segmented } from '../ui/segmented';
import { Skeleton } from '../ui/skeleton';
import { scaleXOf } from '../ui/bars';

export const SECTOR_FLOW_NOTE = '資金流向自開啟本頁起累計（離開本頁的時段不計入），以每分鐘成交值增量依加權漲跌方向估算。';
export const SECTOR_EMPTY_TEXT = '沒有產業資料';
export const SECTOR_QUOTA_TEXT = '今日資料額度已用盡，不自動重試；盤中收到即時串流後會自動補上。';
export const SECTOR_PAUSED_TEXT = '產業資料剛才載入失敗，60 秒內不自動重試，即時更新暫停；可按重試立即恢復。';
export const SECTOR_STATUS_TEXT: Record<Exclude<FlowStatus, 'live'>, string> = {
    ended: '已收盤・以下為今日開啟本頁期間量到的資金流向（離開本頁的時段不計入）。',
    closed: '非交易時段（盤後、週末或休市）：漲跌與成交值為最近一次快照；資金流向需要盤中即時資料，以「—」表示。',
    waiting: '尚未收到盤中即時資料：資金流向自開啟本頁起累計，收到更新後顯示，在此之前以「—」表示。',
};

const AMOUNT_KEY = projectionKey(GM_AMOUNT);
const WPERF_KEY = projectionKey(GM_WPERF);

/** 畫面最多每秒依 store 重算一次（串流每條投影 ≤1 秒一包，2 指數 × 2 投影） */
export const SECTOR_REFRESH_MS = 1_000;

/** 訂閱 index_components store（節流）：建底完成、狀態改變、串流更新時重算 */
function useIcStoreTick(ms: number): number {
    const [tick, setTick] = useState(getIcVersion);
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let last = 0;
        const fire = () => {
            timer = null;
            last = Date.now();
            setTick(getIcVersion());
        };
        const unsubscribe = subscribeIcStore(() => {
            if (timer) return;
            const wait = last + ms - Date.now();
            if (wait <= 0) fire();
            else timer = setTimeout(fire, wait);
        });
        fire();
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [ms]);
    return tick;
}

const MARKET_ITEMS = SECTOR_MARKETS.map(m => ({ value: m, label: MARKET_LABEL[m], testId: `sector-market-${m}` }));

/** 排序段：選中的段加 ↓／↑；無障礙名稱含可見文字、目前方向與再點一次的方向 */
function sortItems(pref: SectorSortPref) {
    return SECTOR_SORT_OPTIONS.map(o => {
        const active = o.value === pref.key;
        return {
            value: o.value,
            label: active ? `${o.label} ${pref.dir === 'desc' ? '↓' : '↑'}` : o.label,
            ariaLabel: active
                ? `${o.label} ${pref.dir === 'desc' ? '↓' : '↑'}，目前${sectorSortDirText(pref)}；再點一次改為${sectorSortDirText(nextSectorSort(pref, o.value))}`
                : `${o.label}，依${o.label}排序`,
            testId: `sector-sort-${o.value}`,
        };
    });
}

function FlowBar({ net, max }: { net: number; max: number }) {
    const ratio = max > 0 ? Math.abs(net) / max : 0;
    return (
        <span className={s.flowBar} aria-hidden='true' data-testid='sector-flow-bar'>
            <span className={s.half}>{net < 0 ? <span className={s.fillOut} style={{ transform: scaleXOf(ratio) }} /> : null}</span>
            <span className={s.half}>{net > 0 ? <span className={s.fillIn} style={{ transform: scaleXOf(ratio) }} /> : null}</span>
        </span>
    );
}

function rowLabel(row: SectorRow, status: FlowStatus): string {
    const flow = visibleFlow(row, status);
    const flowText = flow
        ? `近 5 分淨流入 ${fmtSectorMoney(flow.flow5, true)}，累計淨流入 ${fmtSectorMoney(flow.net, true)}`
        : '資金流向 —';
    return `${row.name}，加權漲跌 ${fmtSectorPct(row.pct)}，成交值 ${fmtSectorMoney(row.amount)}，${flowText}`;
}

function SectorRowButton({ row, status, maxNet, onOpen }: { row: SectorRow; status: FlowStatus; maxNet: number; onOpen(key: IcKey): void }) {
    const flow = visibleFlow(row, status);
    return (
        <button type='button' className={s.row} aria-label={rowLabel(row, status)} data-testid='sector-row' data-key={row.key} onClick={() => onOpen(row.key)}>
            <span className={s.rowTop}>
                <span className={s.rowName} data-testid='sector-row-name'>{row.name}</span>
                <span className={s.pct[toneOf(row.pct)]} data-testid='sector-row-pct'>{fmtSectorPct(row.pct)}</span>
            </span>
            <span className={s.rowMeta}>
                <span className={s.metaItem}>成交<span className={s.num.flat} data-testid='sector-row-amount'>{fmtSectorMoney(row.amount)}</span></span>
                <span className={s.metaItem}>
                    5分
                    <span className={flow ? s.num[toneOf(flow.flow5)] : s.num.none} data-testid='sector-row-flow5'>{flow ? fmtSectorMoney(flow.flow5, true) : '—'}</span>
                </span>
                <span className={s.metaItem}>
                    累計
                    <span className={flow ? s.num[toneOf(flow.net)] : s.num.none} data-testid='sector-row-net'>{flow ? fmtSectorMoney(flow.net, true) : '—'}</span>
                </span>
            </span>
            {flow ? <FlowBar net={flow.net} max={maxNet} /> : null}
        </button>
    );
}

function SummaryColumn({ title, rows, testId }: { title: string; rows: readonly SectorRow[]; testId: string }) {
    return (
        <div className={s.summaryCol} data-testid={testId}>
            <h3 className={s.summaryTitle}>{title}</h3>
            {rows.length === 0 ? (
                <p className={s.summaryEmpty}>—</p>
            ) : (
                <ol className={s.summaryList}>
                    {rows.map(r => (
                        <li key={r.key} className={s.summaryItem}>
                            <span className={s.summaryName}>{r.name}</span>
                            <span className={s.num[toneOf(r.flow!.net)]}>{fmtSectorMoney(r.flow!.net, true)}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

/** header：取代預設的頁首（市場頁傳入「市場」標題＋分段）；未給時維持原本的「產業流向」頁首 */
export function SectorPage({ header }: { header?: ReactNode } = {}) {
    // 掛載期間 retain 群組指標串流並記錄流向；卸載釋放（lib 的 ref-count）。
    // 非 429 建底錯誤後 60 秒內再進入：先不 retain（retain 會讓 lib 重新建底），冷卻結束或按［重試］才開始。
    const [holding, setHolding] = useState(() => {
        watchSectorBootstrapErrors();
        return sectorCooldownEnd() === null;
    });
    useEffect(() => {
        if (holding) return;
        const end = sectorCooldownEnd();
        if (end === null) {
            setHolding(true);
            return;
        }
        const id = setTimeout(() => setHolding(true), end - Date.now());
        return () => clearTimeout(id);
    }, [holding]);
    const revision = useIcSectorFlow(holding);
    // 手動重試的租約：持有到卸載才釋放（與上面的 retain 一起退訂；capability 層 ref-count 只送 1 次 unsubscribe）
    const leases = useRef<(() => void)[]>([]);
    useEffect(() => () => {
        for (const release of leases.current) release();
        leases.current = [];
    }, []);
    const tick = useIcStoreTick(SECTOR_REFRESH_MS);
    const [market, setMarket] = useState<SectorMarket>('twse');
    const [sort, setSort] = useState<SectorSortPref>(readSectorSort);
    const chooseSort = (key: SectorSortKey) => {
        const next = nextSectorSort(sort, key);
        setSort(next);
        writeSectorSort(next);
    };
    const [selected, setSelected] = useState<IcKey | null>(null);
    const index = MARKET_INDEX[market];

    const view = useMemo(() => {
        const amount = getIcState(index, AMOUNT_KEY);
        const wperf = getIcState(index, WPERF_KEY);
        const latest = amount && wperf ? (amount.calculatedAt >= wperf.calculatedAt ? amount : wperf) : amount ?? wperf;
        const now = icSlot(amount?.calculatedAt);
        const rows = buildSectorRows(index, amount?.groups, wperf?.groups, key => icFlowRecorder.groupFlow([key], now), now);
        const status = flowStatusOf(rows, latest?.marketPhase);
        let maxNet = 0;
        if (flowShown(status)) for (const r of rows) if (r.flow) maxNet = Math.max(maxNet, Math.abs(r.flow.net));
        return {
            rows,
            status,
            maxNet,
            dataTime: fmtCalculatedAt(latest?.calculatedAt),
            bootstrap: getIcBootstrapStatus(index),
            subError: getIcSubError(index, AMOUNT_KEY) ?? getIcSubError(index, WPERF_KEY),
            weights: getIcBootstrapGroupWeights(index),
        };
        // recorder 與 store 原地變動：revision（流向）與 tick（store 版本）是變更訊號
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [index, revision, tick]);

    const sorted = useMemo(() => sortSectorRowsBy(view.rows, sort, view.status), [view, sort]);
    const tops = useMemo(() => topFlows(view.rows, view.status), [view]);
    const selectedRow = selected ? view.rows.find(r => r.key === selected) ?? null : null;

    const changeMarket = (m: SectorMarket) => {
        if (m === market) return;
        setSelected(null);
        setMarket(m);
    };
    // 手動重試（建底失敗或訂閱失敗）：尚未 retain（冷卻中）→ 開始 retain；已 retain → 依 sector-retry.ts 取得租約
    const retry = (code: IcIndexCode) => {
        if (!holding) {
            setHolding(true);
            return;
        }
        leases.current.push(...retainSectorRetry(code));
    };

    const hasRows = view.rows.length > 0;
    const { status: bootstrapStatus, error: bootstrapError } = view.bootstrap;
    const loading = !hasRows && (bootstrapStatus === 'idle' || bootstrapStatus === 'pending');

    let content;
    if (loading) {
        content = <div className={s.inset}><Skeleton label='產業資料載入中…' rows={6} testId='sector-loading' /></div>;
    } else if (!hasRows && bootstrapStatus === 'quota') {
        content = <EmptyState icon={Factory} title='今日資料額度已用盡' description={SECTOR_QUOTA_TEXT} testId='sector-quota' />;
    } else if (!hasRows && bootstrapStatus === 'error') {
        content = (
            <EmptyState
                icon={Factory}
                title='產業資料載入失敗'
                description={bootstrapError}
                action={{ label: '重試', onClick: () => retry(index), testId: 'sector-retry' }}
                testId='sector-error'
            />
        );
    } else if (!hasRows) {
        content = <EmptyState icon={Factory} title={SECTOR_EMPTY_TEXT} testId='sector-empty' />;
    } else {
        content = (
            <>
                <GroupedSection header='資金流向摘要（自開啟本頁起）' testId='sector-summary'>
                    <div className={s.summary}>
                        <SummaryColumn title='流入前 3' rows={tops.inflow} testId='sector-top-inflow' />
                        <SummaryColumn title='流出前 3' rows={tops.outflow} testId='sector-top-outflow' />
                    </div>
                </GroupedSection>
                <div className={s.inset}>
                    <Segmented<SectorSortKey> items={sortItems(sort)} value={sort.key} onChange={chooseSort} semantics='toggle' ariaLabel='排序（再點一次反向）' variant='scroll' testId='sector-sort' />
                </div>
                <GroupedSection header={`${MARKET_LABEL[market]} ${view.rows.length} 個產業`} testId='sector-list'>
                    {sorted.map(row => (
                        <SectorRowButton key={row.key} row={row} status={view.status} maxNet={view.maxNet} onOpen={setSelected} />
                    ))}
                </GroupedSection>
            </>
        );
    }

    return (
        <div className={s.page} data-testid='sector-page'>
            {header ?? <PageHeader title='產業流向' />}
            <div className={s.inset}>
                <Segmented items={MARKET_ITEMS} value={market} onChange={changeMarket} semantics='toggle' ariaLabel='市場' testId='sector-market' />
                <p className={s.pageNote} data-testid='sector-flow-note'>
                    {SECTOR_FLOW_NOTE}
                    {view.dataTime ? ` 資料時間 ${view.dataTime}。` : ''}
                </p>
                {hasRows && bootstrapStatus === 'quota' ? <InlineNote tone='warn' role='status' testId='sector-quota-note'>{SECTOR_QUOTA_TEXT}</InlineNote> : null}
                {!holding ? (
                    <InlineNote tone='warn' role='status' testId='sector-paused' action={{ label: '重試', onClick: () => retry(index), testId: 'sector-paused-retry' }}>
                        {SECTOR_PAUSED_TEXT}
                    </InlineNote>
                ) : null}
                {holding && view.subError ? (
                    <InlineNote tone='warn' role='status' testId='sector-sub-error' action={{ label: '重試', onClick: () => retry(index), testId: 'sector-sub-retry' }}>
                        即時訂閱失敗：{view.subError}
                    </InlineNote>
                ) : null}
                {hasRows && view.status !== 'live' ? (
                    <InlineNote tone='info' role='status' testId='sector-flow-status'>{SECTOR_STATUS_TEXT[view.status]}</InlineNote>
                ) : null}
            </div>
            {content}
            <SectorDetailSheet
                row={selectedRow}
                rows={view.rows}
                market={market}
                status={view.status}
                weight={selectedRow ? view.weights?.get(selectedRow.category) : undefined}
                dataTime={view.dataTime}
                live={holding}
                onClose={() => setSelected(null)}
            />
        </div>
    );
}
