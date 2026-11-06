// src/mobile/components/company/company-tab.tsx — 交易頁「公司」分頁（桌面 company-panel.tsx 的手機版；延遲載入）
//
// ┌ 標頭：代碼 名稱 ［上市／上櫃］ 英文簡稱 　價格・漲跌（或「收盤 日期」）
// │       ［交易所產業別］ 研究分類 › … ［XXX 標的］（個股期權時）
// │       指標 2×2：市值、本益比（近四季 EPS）、月營收（年增）、毛利率／淨利率
// ├ 子分頁 Segmented（tabs）：概覽｜財務｜上下游｜來源（內容見 company-sections.tsx）
// └ 頁尾：第三方／官方資料標示・官方日期・shioaji-data 版本・離線快取・［重新檢查］
//
// - 讀取只走 hooks/use-company-data（shioaji-data：sha256 驗證、IndexedDB 快取）；本元件掛載（使用者切到「公司」）時才開始讀。
// - 不支援的商品（同桌面 companyTarget：指數、指數期權、沒有標的的商品）與不在收錄範圍（ETF 等）顯示「此商品沒有公司資料」。
// - 價格：股票用本頁已訂閱的同一檔報價（refcount 共用，不新增訂閱）與快照 store；個股期權的標的公司同桌面訂閱標的報價
//   （useQuote(標的)，只在公司分頁 active 時；沒有即時成交時以 shioaji-data 每日收盤顯示「收盤 日期」）。
//   上下游列同桌面顯示即時漲跌幅（company-sections.tsx RelationsTab → relation-quotes.ts）。
// - 子分頁標籤同桌面帶筆數：「上下游 N」（已研究時，所有關係列數）、「來源 N」（研究出處筆數，0 時不顯示）。
// - 交易安全：只導覽（關聯公司開交易頁）與開外部連結，不呼叫 openTicket／openOrderAction，也不呼叫任何送單、改單、刪單函式。
// - 重繪範圍：即時價只在 SummaryCard（標頭價格、市值、本益比）訂閱，每筆成交只重繪這張卡；子分頁與頁尾以 memo 隔開。
//   交易頁切走（active=false，分頁以 hidden 保持掛載）時改呼叫 useQuote(null)、不讀快照，隱藏期間不隨成交重繪；
//   標頭仍持有同一檔的報價 refcount，切回時直接讀 store 的最新值，不新增訂閱（標的報價則在隱藏時釋放）。

import { Building2, ChevronRight, WifiOff } from 'lucide-react';
import { Fragment, memo, useMemo, useState, useSyncExternalStore } from 'react';
import { staleParts, useCompanyData, useCompanyEntities, type CompanyDataView } from '../../../hooks/use-company-data';
import { useQuote } from '../../../hooks/use-stream';
import {
    companyData,
    MARKET_LABEL,
    quarterMetrics,
    recentRevenue,
    STALE_TEXT,
    trailingEps,
    type CompanyDataClient,
} from '../../../lib/company-data';
import type { Company, MarketDaily } from '../../../lib/company-data/types';
import { getMarketSnapshot, subscribeMarketSnapshots } from '../../../lib/market-snapshot-store';
import type { ContractInfo } from '../../../lib/types/contract';
import { fmtPct, fmtPrice, fmtSigned } from '../../../lib/utils/format';
import { headerQuote } from '../../lib/quote-display';
import * as s from '../../styles/company.css';
import { srOnly } from '../../styles/primitives.css';
import { EmptyState } from '../../ui/empty-state';
import { InlineNote } from '../../ui/inline-note';
import { Segmented } from '../../ui/segmented';
import { Skeleton } from '../../ui/skeleton';
import { companyTarget, fmtGrowth, fmtK, fmtRatio, fmtTwd } from './company-format';
import { evidenceCount, FinancialsTab, OfficialTag, Overview, relationCount, RelationsTab, SourcesTab, ThirdPartyTag, type Focus } from './company-sections';

export const NO_COMPANY_TEXT = '此商品沒有公司資料';
export const UNSUPPORTED_DETAIL = '公司資料僅支援上市櫃股票，以及個股期貨、個股選擇權的標的公司';
export const notCoveredText = (code: string) => `${code} 不在公司資料收錄範圍（收錄上市櫃公司；ETF、權證與興櫃不在內）`;

type SubTab = 'overview' | 'financials' | 'relations' | 'sources';
const SUB_TAB_LABEL: Record<SubTab, string> = { overview: '概覽', financials: '財務', relations: '上下游', sources: '來源' };

/** 子分頁（同桌面：上下游在已研究時帶關係列數、來源在有研究出處時帶筆數） */
export function companySubTabs(c: Company): { value: SubTab; label: string; testId: string }[] {
    const researched = c.has_research && c.as_of !== null;
    const counts: Partial<Record<SubTab, number | undefined>> = {
        relations: researched ? relationCount(c) : undefined,
        sources: evidenceCount(c) || undefined,
    };
    return (Object.keys(SUB_TAB_LABEL) as SubTab[]).map(value => {
        const n = counts[value];
        return { value, label: n !== undefined ? `${SUB_TAB_LABEL[value]} ${n}` : SUB_TAB_LABEL[value], testId: `company-tab-${value}` };
    });
}

export interface CompanyTabProps {
    /** 交易頁的合約（尚未載入時 undefined） */
    contract: ContractInfo | undefined;
    /** 分頁是否顯示中（交易頁切走時 false：停止跟著成交重繪）；預設 true */
    active?: boolean;
    /** 測試注入；預設為 App 共用的 shioaji-data 讀取器 */
    client?: CompanyDataClient;
}

export function CompanyTab({ contract, active = true, client = companyData }: CompanyTabProps) {
    const target = useMemo(() => (contract ? companyTarget(contract) : null), [contract]);
    const { state, status, refresh } = useCompanyData(target?.code ?? null, client);

    if (!contract) return <Skeleton label='載入商品資訊…' rows={4} testId='company-loading' />;
    if (!target) {
        return (
            <div className={s.state} data-testid='company-unsupported'>
                <EmptyState icon={Building2} title={NO_COMPANY_TEXT} description={UNSUPPORTED_DETAIL} />
            </div>
        );
    }
    if (!state || state.phase === 'loading') return <Skeleton label='載入公司資料…' rows={5} testId='company-loading' />;
    if (state.phase === 'error') {
        if (state.errorCode === 'not_found') {
            return (
                <div className={s.state} data-testid='company-not-found'>
                    <EmptyState icon={Building2} title={NO_COMPANY_TEXT} description={notCoveredText(target.code)} />
                </div>
            );
        }
        // 格式不相容（需更新 App）時重試也沒用，不提供重試鍵（同桌面）
        const canRetry = state.errorCode !== 'unsupported_schema';
        return (
            <div className={s.state}>
                <InlineNote
                    tone={state.errorCode === 'offline' ? 'warn' : 'danger'}
                    role='alert'
                    testId='company-error'
                    action={canRetry ? { label: '重試', onClick: refresh, testId: 'company-retry' } : undefined}
                >
                    {state.error}
                </InlineNote>
            </div>
        );
    }
    return (
        <CompanyView
            view={state}
            contract={contract}
            viaUnderlying={target.viaUnderlying}
            active={active}
            refreshing={state.refreshing}
            stale={staleParts(state).length > 0 || status.phase === 'stale'}
            onRefresh={refresh}
            client={client}
        />
    );
}

// ---- 價格（市值、本益比用） ----

interface LivePrice {
    price: number | null;
    change: number | null;
    pct: number | null;
    /** null＝即時（成交或快照）；否則為每日收盤的日期 */
    closeDate: string | null;
}

function useLivePrice(contract: ContractInfo, sameCode: boolean, active: boolean, code: string, market: MarketDaily | null): LivePrice {
    // 股票：本頁同一檔（refcount 共用）；個股期權：同桌面訂閱標的公司的報價（code）。
    // 分頁隱藏時傳 null（不跟著成交重繪；股票的標頭仍持有同一檔的 refcount，標的報價則釋放）
    const live = sameCode && active;
    const underlyingLive = !sameCode && active;
    const quote = useQuote(live ? contract.code : underlyingLive ? code : null, { narrow: true });
    const snapshot = useSyncExternalStore(subscribeMarketSnapshots, () => (live ? getMarketSnapshot(contract) : undefined));
    if (live || underlyingLive) {
        // 標的：沒有合約參考價（漲跌幅以串流自身的參考計算，同 headerQuote）、不讀衍生商品的快照
        const q = headerQuote({ reference: live ? contract.reference : undefined, tick: quote?.tick, index: quote?.index, snapshot });
        if ((q.source === 'tick' || q.source === 'snapshot') && q.price !== null) {
            return { price: q.price, change: q.change, pct: q.pct, closeDate: null };
        }
    }
    const daily = market?.quotes[code];
    return { price: daily?.close ?? null, change: null, pct: null, closeDate: daily?.date ?? null };
}

const dirOf = (v: number | null): 'up' | 'down' | 'flat' => (v === null || v === 0 || !Number.isFinite(v) ? 'flat' : v > 0 ? 'up' : 'down');

// ---- 主畫面 ----

function CompanyView({ view, contract, viaUnderlying, active, refreshing, stale, onRefresh, client }: {
    view: CompanyDataView;
    contract: ContractInfo;
    viaUnderlying: boolean;
    active: boolean;
    refreshing: boolean;
    stale: boolean;
    onRefresh: () => void;
    client: CompanyDataClient;
}) {
    const c = view.company;
    const researched = c.has_research && c.as_of !== null;
    const [tab, setTab] = useState<SubTab>('overview');
    const [focus, setFocus] = useState<Focus | null>(null);
    // 實體索引（名稱）：只有上下游分頁或展開題材／產業鏈名單時才讀（同桌面）
    const entities = useCompanyEntities(tab === 'relations' || focus !== null, client);
    const subTabs = useMemo(() => companySubTabs(c), [c]);
    const tabLabel = SUB_TAB_LABEL[tab];

    return (
        <div className={s.root} data-testid='company-tab'>
            <SummaryCard view={view} contract={contract} viaUnderlying={viaUnderlying} active={active} />
            <div className={s.subTabs}>
                <Segmented<SubTab> items={subTabs} value={tab} onChange={setTab} semantics='tabs' ariaLabel='公司資料分頁' size='compact' testId='company-subtabs' />
            </div>
            <div className={s.panel} role='tabpanel' aria-label={tabLabel} data-testid={`company-panel-${tab}`}>
                {tab === 'overview' && <Overview view={view} researched={researched} focus={focus} onFocus={setFocus} entities={entities} />}
                {tab === 'financials' && <FinancialsTab view={view} />}
                {tab === 'relations' && <RelationsTab company={c} researched={researched} entities={entities} live={active} />}
                {tab === 'sources' && <SourcesTab view={view} researched={researched} />}
            </div>
            <Footer view={view} researched={researched} stale={stale} refreshing={refreshing} onRefresh={onRefresh} />
        </div>
    );
}

/** 標頭與指標：本分頁唯一跟著成交重繪的部分 */
const SummaryCard = memo(function SummaryCard({ view, contract, viaUnderlying, active }: {
    view: CompanyDataView;
    contract: ContractInfo;
    viaUnderlying: boolean;
    active: boolean;
}) {
    const live = useLivePrice(contract, !viaUnderlying, active, view.company.code, view.market);
    return (
        <section className={s.card} data-testid='company-summary-card'>
            <Head company={view.company} live={live} underlyingOf={viaUnderlying ? contract.code : null} />
            <Kpis view={view} live={live} />
        </section>
    );
});

function Head({ company: c, live, underlyingOf }: { company: Company; live: LivePrice; underlyingOf: string | null }) {
    const ind = c.industry ?? {};
    const research = [ind.l1_name, ind.l2_name, ind.l3_name].filter(Boolean) as string[];
    const dir = dirOf(live.change);
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
    return (
        <div data-testid='company-head'>
            <div className={s.headRow}>
                <span className={s.headCode}>{c.code}</span>
                <span className={s.headName}>{c.name}</span>
                <span className={s.tag.neutral} data-testid='company-market'>{MARKET_LABEL[c.market] ?? c.market}</span>
                {c.english_short && <span className={s.headEnglish} data-testid='company-english'>{c.english_short}</span>}
                <span className={s.headPrice} data-testid='company-price'>
                    <span className={`${s.headPriceValue} ${s.dirText[dir]}`}>{fmtPrice(live.price ?? undefined)}</span>
                    {live.closeDate === null ? (
                        <span className={`${s.headPriceChange} ${s.dirText[dir]}`}>
                            {arrow}{fmtSigned(live.change ?? undefined)} {fmtPct(live.pct ?? undefined)}
                        </span>
                    ) : (
                        live.price !== null && <span className={s.muted}>收盤 {live.closeDate}</span>
                    )}
                </span>
            </div>
            <div className={s.crumbs} data-testid='company-crumbs'>
                {ind.l0_name && (
                    <span className={s.tag.official} data-testid='company-industry-official'>
                        <span className={srOnly}>交易所產業別：</span>
                        {ind.l0_name}
                    </span>
                )}
                {research.length > 0 && (
                    <span className={s.crumbs} data-testid='company-industry-research'>
                        <span className={srOnly}>研究分類：</span>
                        {research.map((label, i) => (
                            <Fragment key={label}>
                                {i > 0 && <ChevronRight className={s.crumbSep} aria-hidden='true' focusable='false' />}
                                <span className={i === research.length - 1 ? s.crumbStrong : undefined}>{label}</span>
                            </Fragment>
                        ))}
                    </span>
                )}
                {underlyingOf && (
                    <span className={s.tag.accent} data-testid='company-underlying'>{underlyingOf} 標的</span>
                )}
            </div>
        </div>
    );
}

function Kpis({ view, live }: { view: CompanyDataView; live: LivePrice }) {
    const fin = view.financials;
    const daily = view.market?.quotes[view.code];
    const shares = daily?.shares ?? null;
    const cap = live.price !== null && shares ? live.price * shares : daily?.market_cap_twd ?? null;
    const eps = fin ? trailingEps(fin) : null;
    const pe = live.price !== null && eps !== null && eps > 0 ? live.price / eps : null;
    const latestQ = fin ? quarterMetrics(fin, 1)[0] : undefined;
    const lastMonth = fin ? recentRevenue(fin, 1)[0] : undefined;
    const gross = latestQ?.grossMarginPct !== null && latestQ?.grossMarginPct !== undefined;
    const items = [
        {
            id: 'cap',
            label: '市值',
            value: fmtTwd(cap),
            sub: `${live.closeDate === null ? '即時價 × 股數' : `收盤 ${live.closeDate ?? '—'}`}${view.marketMeta?.stale ? ' · 快取' : ''}`,
        },
        { id: 'pe', label: '本益比', value: pe !== null ? pe.toFixed(1) : '—', sub: eps !== null ? `近四季 EPS ${eps.toFixed(2)}` : '近四季 EPS —' },
        {
            id: 'revenue',
            label: '月營收',
            value: lastMonth ? fmtK(lastMonth.revenue_thousand_twd) : '—',
            sub: lastMonth ? `${lastMonth.period} 年增 ${fmtGrowth(lastMonth.yoy_pct)}` : '—',
        },
        {
            id: 'margin',
            label: gross ? '毛利率' : '淨利率',
            value: fmtRatio(latestQ?.grossMarginPct ?? latestQ?.netMarginPct),
            sub: latestQ ? latestQ.period : '—',
        },
    ];
    return (
        <dl className={s.kpis} data-testid='company-kpis'>
            {items.map(it => (
                <div key={it.id} className={s.kpi} data-testid={`company-kpi-${it.id}`}>
                    <dt className={s.kpiLabel}>{it.label}</dt>
                    <dd className={s.kpiValue} style={{ margin: 0 }}>{it.value}</dd>
                    <dd className={s.kpiSub} style={{ margin: 0 }}>{it.sub}</dd>
                </div>
            ))}
        </dl>
    );
}

const Footer = memo(function Footer({ view, researched, stale, refreshing, onRefresh }: {
    view: CompanyDataView;
    researched: boolean;
    stale: boolean;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const parts = staleParts(view);
    return (
        <div className={s.foot} data-testid='company-footer'>
            <span className={s.footText}>
                {researched ? <ThirdPartyTag asOf={view.company.as_of} /> : <OfficialTag />}
                <span>官方 {view.meta.officialFetchedAt ?? '—'}</span>
                <span className={s.mono} data-testid='company-release'>shioaji-data {view.meta.releaseId}</span>
                {stale && (
                    <span className={s.tag.stale} data-testid='company-stale'>
                        <WifiOff className={s.tagIcon} aria-hidden='true' focusable='false' />
                        {STALE_TEXT}
                        <span className={srOnly}>
                            ：無法連線資料來源，顯示先前下載並驗證過的本機快取，未確認為最新版本{parts.length ? `：${parts.join('、')}` : ''}
                        </span>
                    </span>
                )}
            </span>
            <button
                type='button'
                className={s.textButton}
                disabled={refreshing}
                aria-label='重新檢查公司資料'
                onClick={onRefresh}
                data-testid='company-refresh'
            >
                {refreshing ? '檢查中…' : '重新檢查'}
            </button>
        </div>
    );
});
