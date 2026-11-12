// src/mobile/components/market/market-signals.tsx — 「市場 → 盤中異動」（#/market/signals；市場頁內再延遲載入的 chunk）
//
// 資料：
// - lib/market-pulse：本分段顯示且文件在前景時 retainMarketPulseStreams()（只掛上既有 SSE 的 scanner 事件監聽，不另開連線）；
//   以 subscribeMarketPulse／getMarketPulseSnapshot 讀取。snapshot.signals 是 lib 原地變動的同一個陣列（unshift、上限 250），
//   因此清單一律以 snapshot.version 為重算訊號、每次產生新陣列；畫面最多每 500ms 重算一次。
// - 訂閱：每個「規則 × 市場」一個鍵（components/market/signal-subscriptions.ts）。只在本分段掛載（市場分頁＋盤中異動）且文件在前景時持有；
//   篩選改變只送差異；離開或退到背景全部退訂；失敗不自動重試，只提供［重試］。
// - 名稱：先讀記憶體中的合約快取與名稱目錄（signal-model.ts 的 signalName）；顯示時呼叫 1 次 ensureEquityNamesFresh()
//   （lib 合併、60 分鐘內不重抓、失敗 30 秒後才可能再抓，且只在下次呼叫時）。部署環境沒有 /metadata 路由時目錄讀不到，
//   因此仍沒有名稱的「可見」列（整段共用一個 IntersectionObserver，quote-row 的 useVisibilityTracker）以
//   lib/contract-names 向永豐查一次合約：每個代碼本 session 最多 1 次、同時 ≤2、失敗不重試、不可見時取消未開始的查詢；
//   不讀外部網站。名稱到達前列只顯示代碼，之後顯示「名稱 代碼」。
// 請求（每次進入本分段或回到前景）：scanner subscribe 每鍵 1 次（預設 4 規則 × 2 市場＝8；全選 13 × 2＝26）；
//   離開或退到背景時對成功的鍵各 unsubscribe 1 次；公司名稱目錄 GET ≤3（與搜尋共用，60 分鐘內 0）；
//   合約查詢 ≤「出現在可見範圍、且沒有名稱的不同代碼數」（session 內每代碼 1 次）。
// 點列只呼叫 navigate({ name: 'trade', code })：沒有下單鍵、不呼叫 openTicket／openOrderAction（§10 S1）；沒有聲音或震動。

import { Activity } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getMarketPulseSnapshot, retainMarketPulseStreams, subscribeMarketPulse } from '../../../lib/market-pulse';
import { subscribeEtfNames } from '../../../lib/etf-runtime-catalog';
import { ensureEquityNamesFresh, subscribeEquityNames } from '../../../lib/stock-runtime-catalog';
import type { ScannerSignalEvent } from '../../../lib/types/market';
import { instrumentText, useVisibleRowName } from '../../lib/contract-names';
import { navigate } from '../../lib/hash-router';
import * as ms from '../../styles/market-signals.css';
import { Chip } from '../../ui/chip';
import { EmptyState } from '../../ui/empty-state';
import { GroupedSection } from '../../ui/grouped';
import { InlineNote } from '../../ui/inline-note';
import { FALLBACK_VISIBLE_ROWS, useVisibilityTracker, type VisibilityTracker } from '../quote-row';
import {
    EXCHANGE_LABELS,
    FAMILY_LABELS,
    fmtSignalTime,
    gapText,
    loadSignalFilters,
    RULE_LABELS,
    ruleTone,
    saveSignalFilters,
    SIGNAL_EXCHANGES,
    SIGNAL_FAMILIES,
    signalDetail,
    signalKeys,
    signalName,
    signalQuote,
    signalRowKey,
    toggleExchange,
    toggleFamily,
    visibleSignals,
    type SignalFilters,
} from './signal-model';
import { useSignalSubscriptions, type SignalCoverage } from './signal-subscriptions';

/** 畫面最多每 500ms 依 market-pulse 重算一次（訊號可能成批湧入） */
export const SIGNAL_REFRESH_MS = 500;

export const SIGNAL_EMPTY_TEXT = '盤中異動只在交易時段即時推送（約 08:30 開盤前試撮起至 13:30 收盤）；非交易時段不會有新訊號。'
    + '只列出在本分段開啟期間收到的訊號，離開或 App 在背景的時段不會補上。';
export const SIGNAL_NO_FILTER_TEXT = '請至少選擇一種訊號與一個市場。';

// 文件是否在前景（同 trade-info/use-document-visible；這裡複製一份，避免為共用它多切一個首屏預載清單裡的 chunk）
function subscribeVisibility(listener: () => void): () => void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
}
const getVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** market-pulse 的版本號（節流）；inactive 時不監聽 */
function usePulseVersion(active: boolean, ms: number): number {
    const [version, setVersion] = useState(() => getMarketPulseSnapshot().version);
    useEffect(() => {
        if (!active) return undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let last = 0;
        const fire = () => {
            timer = null;
            last = Date.now();
            setVersion(getMarketPulseSnapshot().version);
        };
        const unsubscribe = subscribeMarketPulse(() => {
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
    }, [active, ms]);
    return version;
}

/** 名稱目錄更新時重繪（只監聽，不觸發任何讀取） */
function useNamesVersion(): number {
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const bump = () => setVersion(v => v + 1);
        const offEquity = subscribeEquityNames(bump);
        const offEtf = subscribeEtfNames(bump);
        return () => {
            offEquity();
            offEtf();
        };
    }, []);
    return version;
}

export function coverageText(c: SignalCoverage): string {
    if (c.total === 0) return '目前沒有訂閱任何訊號。';
    if (c.pending > 0) return `訂閱中… 已完成 ${c.ok}/${c.total}`;
    return `已訂閱 ${c.ok}/${c.total}`;
}

interface SignalRowProps {
    signal: ScannerSignalEvent;
    /** 不支援 IntersectionObserver 時是否當作可見（前 FALLBACK_VISIBLE_ROWS 列）；傳布林而非 index，新訊號插在最上面時其他列 props 不變 */
    fallbackVisible: boolean;
    /** 記憶體中的名稱（signalName）：由父層讀取後傳入，名稱目錄更新時只有名稱改變的列重繪 */
    knownName: string | null | undefined;
    tracker: VisibilityTracker | null;
}

// memo：清單每 500ms 重算一次，訊號物件不變的列不重繪
const SignalRow = memo(function SignalRow({ signal, fallbackVisible, knownName, tracker }: SignalRowProps) {
    const code = signal.quote.code;
    const ref = useRef<HTMLButtonElement | null>(null);
    // 記憶體中的名稱優先；沒有時只為可見列向永豐查一次合約（lib/contract-names）
    const name = useVisibleRowName(ref, tracker, fallbackVisible, code, knownName);
    const quote = signalQuote(signal);
    const label = RULE_LABELS[signal.scanner] ?? String(signal.scanner);
    const detail = signalDetail(signal.scanner, signal.extra);
    const time = fmtSignalTime(signal.quote.time);
    const exchange = EXCHANGE_LABELS[signal.exchange] ?? String(signal.exchange);
    // 規則本身就是「試撮」時標籤已說明，不重複徽章
    const simBadge = quote.simtrade && signal.scanner !== 'simtrade';
    const aria = [
        time,
        instrumentText(code, name),
        exchange,
        detail ? `${label} ${detail}` : label,
        quote.price ? `${quote.simtrade ? '試撮價' : '成交價'} ${quote.price}` : '',
        quote.change ? `漲跌 ${quote.change}` : '',
        '開啟交易頁',
    ].filter(Boolean).join('，');
    return (
        <button ref={ref} type='button' className={ms.row} aria-label={aria} data-testid='signal-row' data-code={code} onClick={() => navigate({ name: 'trade', code })}>
            <span className={ms.rowTop}>
                <span className={ms.rowTitle}>
                    <span className={ms.rowName} data-testid='signal-row-name'>{name ?? code}</span>
                    {name ? <span className={ms.rowCode}>{code}</span> : null}
                </span>
                <span className={ms.price}>
                    {simBadge ? <span className={ms.simBadge} data-testid='signal-row-sim'>試撮</span> : null}
                    <span data-testid='signal-row-price'>{quote.price ?? '—'}</span>
                </span>
            </span>
            <span className={ms.rowMeta}>
                <span className={ms.metaLeft}>
                    <span className={ms.time} data-testid='signal-row-time'>{time}</span>
                    <span>{exchange}</span>
                    <span className={ms.ruleLabel[ruleTone(signal.scanner)]} data-testid='signal-row-label'>{label}</span>
                    {detail ? <span data-testid='signal-row-detail'>{detail}</span> : null}
                </span>
                <span className={ms.change[quote.tone]} data-testid='signal-row-change'>{quote.change ?? '—'}</span>
            </span>
        </button>
    );
});

export function MarketSignals() {
    // 本元件只在「市場」分頁的「盤中異動」分段掛載；再加上文件在前景才持有串流監聽與訂閱
    const active = useSyncExternalStore(subscribeVisibility, getVisible, getVisible);
    useEffect(() => (active ? retainMarketPulseStreams() : undefined), [active]);
    useEffect(() => {
        if (active) ensureEquityNamesFresh();
    }, [active]);

    const [filters, setFilters] = useState<SignalFilters>(loadSignalFilters);
    const update = (next: SignalFilters) => {
        setFilters(next);
        saveSignalFilters(next);
    };
    const keys = useMemo(() => signalKeys(filters), [filters]);
    const { coverage, retry } = useSignalSubscriptions(keys, active);

    const version = usePulseVersion(active, SIGNAL_REFRESH_MS);
    const namesVersion = useNamesVersion();
    // lib 的 signals 陣列原地變動：以 version 為重算訊號（namesVersion 讓名稱到達時重繪列）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const rows = useMemo(() => visibleSignals(getMarketPulseSnapshot().signals, filters), [version, filters, namesVersion]);
    const gap = getMarketPulseSnapshot().gap;
    const tracker = useVisibilityTracker();

    let list;
    if (keys.length === 0) {
        list = <EmptyState icon={Activity} title='尚未選擇訊號' description={SIGNAL_NO_FILTER_TEXT} testId='signal-no-filter' />;
    } else if (rows.length === 0) {
        list = <EmptyState icon={Activity} title='尚無盤中異動' description={SIGNAL_EMPTY_TEXT} testId='signal-empty' />;
    } else {
        list = (
            <GroupedSection header={`最新 ${rows.length} 筆（新的在上）・點一下開啟交易頁`} testId='signal-list'>
                {rows.map((signal, i) => (
                    <SignalRow
                        key={signalRowKey(signal)}
                        signal={signal}
                        fallbackVisible={i < FALLBACK_VISIBLE_ROWS}
                        knownName={signalName(signal.quote.code, signal.exchange)}
                        tracker={tracker}
                    />
                ))}
            </GroupedSection>
        );
    }

    return (
        <>
            <div className={ms.inset} data-testid='market-signals'>
                <div className={ms.filterGroup} role='group' aria-label='訊號種類' data-testid='signal-families'>
                    <span className={ms.filterLabel} aria-hidden='true'>訊號</span>
                    {SIGNAL_FAMILIES.map(family => (
                        <Chip
                            key={family}
                            label={FAMILY_LABELS[family]}
                            selected={filters.families.includes(family)}
                            onClick={() => update(toggleFamily(filters, family))}
                            testId={`signal-family-${family}`}
                        />
                    ))}
                </div>
                <div className={ms.filterGroup} role='group' aria-label='市場' data-testid='signal-exchanges'>
                    <span className={ms.filterLabel} aria-hidden='true'>市場</span>
                    {SIGNAL_EXCHANGES.map(exchange => (
                        <Chip
                            key={exchange}
                            label={EXCHANGE_LABELS[exchange]}
                            selected={filters.exchanges.includes(exchange)}
                            onClick={() => update(toggleExchange(filters, exchange))}
                            testId={`signal-exchange-${exchange}`}
                        />
                    ))}
                </div>
                <p className={ms.statusLine} role='status' data-testid='signal-coverage'>{coverageText(coverage)}</p>
                {coverage.failed > 0 ? (
                    <InlineNote tone='warn' role='status' testId='signal-sub-error' action={{ label: '重試', onClick: retry, testId: 'signal-retry' }}>
                        {`${coverage.failed} 個訊號訂閱失敗（已訂閱 ${coverage.ok}/${coverage.total}），這部分的異動收不到；不會自動重試。`}
                    </InlineNote>
                ) : null}
                {gap ? <InlineNote tone='info' role='status' testId='signal-gap'>{gapText(gap)}</InlineNote> : null}
            </div>
            {list}
        </>
    );
}
