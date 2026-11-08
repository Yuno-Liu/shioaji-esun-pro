// src/mobile/components/company/company-sections.tsx — 「公司」分頁的子分頁內容（概覽、財務、上下游、來源）
//
// 與桌面 company-panel.tsx 逐區塊對應（對照表見 company-tab.test.tsx 的 DESKTOP_BLOCKS）。手機化差異：
// - 表格改為可橫向捲動的小表；月營收表預設 6 個月，可展開全部（桌面每根長條的提示改由表格完整呈現）。
// - 產業鏈上／中／下游改為直式三列，階段為可換行的晶片；題材晶片兩行（名稱／階段・上下游）。
// - 桌面的滑鼠提示（第三方資料說明、快取說明、媒體報導說明）改為可見文字或視覺隱藏文字。
// - 關聯公司為上市櫃代碼時，整列點擊以 navigate 開該股交易頁；只導覽，不開下單面板、不送任何委託。
// - 上下游列：同桌面顯示對方公司的即時漲跌幅（relation-quotes.ts：use-live-snapshots，只在上下游子分頁顯示且
//   公司分頁 active 時讀取與訂閱，一次最多 RELATION_LIVE_LIMIT＝20 檔，桌面 40）；沒有即時資料的列顯示資料時點。
// - 外部連結（公司網站、研究出處、官方來源）只接受 http／https，新分頁開啟並帶 rel="noopener noreferrer"。

import { ExternalLink as ExternalIcon, Globe, Star, WifiOff } from 'lucide-react';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { staleParts, type CompanyDataView } from '../../../hooks/use-company-data';
import {
    entityIndex,
    entityName,
    MARKET_LABEL,
    quarterMetrics,
    recentRevenue,
    stageName,
    STALE_TEXT,
    tierLabel,
    type DataMeta,
} from '../../../lib/company-data';
import type { ChainTier, Company, Entity, Financials, RelationRow, Theme } from '../../../lib/company-data/types';
import type { Snapshot } from '../../../lib/types/market';
import { fmtPct } from '../../../lib/utils/format';
import { navigate } from '../../lib/hash-router';
import * as s from '../../styles/company.css';
import { srOnly } from '../../styles/primitives.css';
import { IconButton } from '../../ui/icon-button';
import { InlineNote } from '../../ui/inline-note';
import { externalHref, fmtGrowth, fmtK, fmtRatio, fmtTwd, mixOpacity, siteText, tradableCodeOf } from './company-format';
import { useRelationSnapshots } from './relation-quotes';

export const THIRD_PARTY_NOTE = 'AI 依公開文件整理並經多個模型交叉核對，可能過時或有誤';
const TIERS: ChainTier[] = ['upstream', 'midstream', 'downstream'];

/** 關聯公司：開該股交易頁（只導覽） */
function openTrade(code: string) {
    navigate({ name: 'trade', code });
}

// ---- 共用標示 ----

export function ThirdPartyTag({ asOf }: { asOf: string | null }) {
    return (
        <span className={s.tag.thirdParty} data-testid='company-third-party'>
            第三方資料{asOf ? ` · ${asOf}` : ''}
        </span>
    );
}

export function OfficialTag({ date, testId }: { date?: string | null; testId?: string }) {
    return <span className={s.tag.official} data-testid={testId}>官方資料{date ? ` · ${date}` : ''}</span>;
}

/** 這一段來自離線快取（驗證過，但未確認為最新） */
export function StaleTag({ meta }: { meta: DataMeta | null | undefined }) {
    if (!meta?.stale) return null;
    return (
        <span className={s.tag.stale} data-testid='company-stale-tag'>
            <WifiOff className={s.tagIcon} aria-hidden='true' focusable='false' />
            快取
            <span className={srOnly}>：無法連線資料來源，顯示先前下載並驗證過的快取（版本 {meta.releaseId}），未確認為最新</span>
        </span>
    );
}

export function Card({ title, meta, children, testId }: { title: ReactNode; meta?: ReactNode; children: ReactNode; testId?: string }) {
    return (
        <section className={s.card} data-testid={testId}>
            <div className={s.sectionHead}>
                <h3 className={s.sectionTitle}>{title}</h3>
                {meta ? <span className={s.sectionMeta}>{meta}</span> : null}
            </div>
            {children}
        </section>
    );
}

/** 外部連結：新分頁、noopener noreferrer；不是 http／https 時只顯示文字 */
export function ExternalAnchor({ href, children, testId }: { href: string | null | undefined; children: ReactNode; testId?: string }) {
    const safe = externalHref(href);
    if (!safe) return <span className={s.sourceTitle} data-testid={testId}>{children}</span>;
    return (
        <a className={s.link} href={safe} target='_blank' rel='noopener noreferrer' data-testid={testId}>
            {children}
            <ExternalIcon className={s.linkIcon} aria-hidden='true' focusable='false' />
            <span className={srOnly}>（另開新分頁）</span>
        </a>
    );
}

function OfficialOnlyNote({ children }: { children: ReactNode }) {
    return (
        <div className={s.card} data-testid='company-official-only'>
            <InlineNote tone='info' role='note'>
                <strong>只有官方資料</strong>
                <br />
                {children}
            </InlineNote>
        </div>
    );
}

// ---- 概覽 ----

export interface Focus {
    themeId: string;
    stageIds: string[] | null;
    title: string;
}

export const Overview = memo(function Overview({
    view,
    researched,
    focus,
    onFocus,
    entities,
}: {
    view: CompanyDataView;
    researched: boolean;
    focus: Focus | null;
    onFocus: (focus: Focus | null) => void;
    entities: Entity[] | null;
}) {
    const c = view.company;
    const themes = view.themes;
    const chainTheme = c.chain ? themes?.find(t => t.id === c.chain) : undefined;
    const ownStages = new Set([c.chain_stage?.stage, ...(c.chain_stage?.also ?? []).map(a => a.stage)].filter(Boolean));
    const summary = c.summary_long ?? c.summary_short;

    return (
        <>
            {!researched && (
                <OfficialOnlyNote>
                    這家公司尚未納入研究，沒有業務摘要、產業鏈、題材與上下游資料。基本資料、收盤市值、月營收與季報為交易所與公開資訊觀測站的官方資料。
                </OfficialOnlyNote>
            )}
            {researched && summary && (
                <Card title='業務' testId='company-summary' meta={<><StaleTag meta={view.meta} /><ThirdPartyTag asOf={c.as_of} /></>}>
                    <p className={s.prose}>{summary}</p>
                    <p className={s.footnote} data-testid='company-third-party-note'>{THIRD_PARTY_NOTE}</p>
                </Card>
            )}
            {researched && c.chain_stage && (
                <Card
                    title='產業鏈位置'
                    testId='company-chain'
                    meta={<><StaleTag meta={view.themesMeta} /><span className={s.muted}>{chainTheme?.name ?? c.chain}</span></>}
                >
                    <div className={s.chain}>
                        {TIERS.map(tier => {
                            const stages = chainTheme
                                ? chainTheme.stages.filter(st => st.tier === tier)
                                : c.chain_stage && c.chain_stage.tier === tier
                                    ? [{ id: c.chain_stage.stage, name: c.chain_stage.stage_name, tier }]
                                    : [];
                            return (
                                <div key={tier} className={s.tierRow} data-testid={`company-chain-${tier}`}>
                                    <span className={s.tierLabel}>{tierLabel(tier)}</span>
                                    <div className={s.stageWrap}>
                                        {stages.map(st => {
                                            const tone = st.id === c.chain_stage?.stage ? 'own' : ownStages.has(st.id) ? 'also' : 'other';
                                            const pressed = focus?.themeId === chainTheme?.id && focus?.stageIds?.[0] === st.id;
                                            return (
                                                <button
                                                    key={st.id}
                                                    type='button'
                                                    className={s.stage[tone]}
                                                    aria-pressed={chainTheme ? pressed : undefined}
                                                    disabled={!chainTheme}
                                                    data-testid={`company-stage-${tone}`}
                                                    data-stage={st.id}
                                                    onClick={() =>
                                                        chainTheme
                                                        && onFocus(pressed ? null : { themeId: chainTheme.id, stageIds: [st.id], title: `${chainTheme.name} · ${st.name}` })}
                                                >
                                                    {st.name}
                                                    {tone !== 'other' && <span className={srOnly}>{tone === 'own' ? '（主要階段）' : '（兼營階段）'}</span>}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <p className={s.footnote}>實心框：主要階段；虛線框：兼營階段{chainTheme ? '。點階段看這一段的公司' : ''}</p>
                    {c.chain_stage.reason && <p className={s.footnote} data-testid='company-chain-reason'>{c.chain_stage.reason}</p>}
                    {focus && chainTheme && focus.themeId === chainTheme.id && (
                        <MemberList theme={chainTheme} focus={focus} view={view} entities={entities} onClose={() => onFocus(null)} />
                    )}
                </Card>
            )}
            {researched && c.segments?.length > 0 && <RevenueMix company={c} />}
            {researched && c.themes?.length > 0 && (
                <Card title='題材' testId='company-themes' meta={<StaleTag meta={view.themesMeta} />}>
                    <div className={s.themeChips}>
                        {c.themes.map(ref => {
                            const theme = themes?.find(t => t.id === ref.theme);
                            const pressed = focus?.themeId === ref.theme;
                            const main = ref.theme === c.main_theme;
                            return (
                                <button
                                    key={`${ref.theme}:${ref.stage}`}
                                    type='button'
                                    className={s.themeChip}
                                    aria-pressed={theme ? pressed : undefined}
                                    disabled={!theme}
                                    data-testid={main ? 'company-theme-main' : 'company-theme'}
                                    onClick={() => theme && onFocus(pressed ? null : { themeId: theme.id, stageIds: null, title: theme.name })}
                                >
                                    <span className={s.themeName}>
                                        {main && <Star className={s.starIcon} aria-hidden='true' focusable='false' />}
                                        {theme?.name ?? ref.theme}
                                        {main && <span className={srOnly}>（主題材）</span>}
                                    </span>
                                    <span className={s.themeStage}>
                                        {theme ? stageName(theme, ref.stage) : ref.stage} · {tierLabel(ref.tier)}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    {c.main_theme && <p className={s.footnote}>★ 為主題材</p>}
                    {focus && focus.themeId !== chainTheme?.id && (() => {
                        const theme = themes?.find(t => t.id === focus.themeId);
                        return theme ? <MemberList theme={theme} focus={focus} view={view} entities={entities} onClose={() => onFocus(null)} /> : null;
                    })()}
                </Card>
            )}
            <CompanyFacts company={c} officialDate={view.meta.officialFetchedAt} />
        </>
    );
});

function RevenueMix({ company: c }: { company: Company }) {
    const segments = c.segments.filter(seg => seg.revenue_share_pct !== null);
    const period = segments[0]?.period;
    return (
        <Card title='營收組成' testId='company-mix' meta={period ? <span className={s.muted}>{period}</span> : undefined}>
            {segments.length > 0 && (
                <div className={s.mixBar} role='img' aria-label='營收組成比例' data-testid='company-mix-bar'>
                    {segments.map((seg, i) => (
                        <span key={seg.id} className={s.mixSegment} style={{ width: `${seg.revenue_share_pct}%`, opacity: mixOpacity(i) }} />
                    ))}
                </div>
            )}
            <ul className={s.mixList}>
                {c.segments.map((seg, i) => (
                    <li key={seg.id} className={s.mixItem} data-testid='company-mix-item'>
                        <span className={s.swatch} style={{ opacity: mixOpacity(i) }} aria-hidden='true' />
                        <span className={s.mixName}>{seg.name}</span>
                        <span className={s.mixPct}>{seg.revenue_share_pct !== null ? `${seg.revenue_share_pct}%` : '—'}</span>
                    </li>
                ))}
            </ul>
        </Card>
    );
}

const MEMBER_PREVIEW = 8;

function MemberList({ theme, focus, view, entities, onClose }: {
    theme: Theme;
    focus: Focus;
    view: CompanyDataView;
    entities: Entity[] | null;
    onClose: () => void;
}) {
    const [all, setAll] = useState(false);
    const index = useMemo(() => (entities ? entityIndex(entities) : null), [entities]);
    // 代碼與市值每位成員只算一次（排序比較函式內不跑正規式）；只在名單、篩選或收盤資料改變時重排
    const market = view.market;
    const members = useMemo(() => {
        const stageIds = focus.stageIds ? new Set(focus.stageIds) : null;
        return theme.members
            .filter(m => !stageIds || stageIds.has(m.stage))
            .map(m => {
                const code = tradableCodeOf(m.id);
                return { m, code, cap: (code && market?.quotes[code]?.market_cap_twd) || 0 };
            })
            .sort((a, b) => b.cap - a.cap);
    }, [theme, focus, market]);
    const shown = all ? members : members.slice(0, MEMBER_PREVIEW);
    return (
        <div className={s.list} data-testid='company-members'>
            <div className={s.listHead}>
                <span className={s.listHeadTitle}>{focus.title}</span>
                <span className={s.count}>{members.length}</span>
                <IconButton ariaLabel='收合名單' onClick={onClose} testId='company-members-close' />
            </div>
            {shown.map(({ m, code, cap }) => {
                const self = code === view.code;
                const body = (
                    <>
                        <span className={s.rowName}>
                            <span>{entityName(index, m.id)}</span>
                            {code && <span className={s.rowCode}>{code}</span>}
                            {code && !self && <span className={srOnly}>（開交易頁）</span>}
                        </span>
                        <span className={s.rowEnd}>{fmtTwd(cap || null)}</span>
                        <span className={s.rowDetail}>
                            {focus.stageIds ? m.detail : `${stageName(theme, m.stage)} · ${m.detail ?? ''}`}
                        </span>
                    </>
                );
                return code && !self ? (
                    <button
                        key={`${m.id}:${m.stage}`}
                        type='button'
                        className={s.rowLink}
                        data-testid='company-member-row'
                        data-code={code}
                        onClick={() => openTrade(code)}
                    >
                        {body}
                    </button>
                ) : (
                    <div key={`${m.id}:${m.stage}`} className={s.row} data-testid='company-member-row'>{body}</div>
                );
            })}
            {members.length > MEMBER_PREVIEW && (
                <button type='button' className={s.more} onClick={() => setAll(v => !v)} data-testid='company-members-more'>
                    {all ? '收合' : `顯示全部 ${members.length} 家`}
                </button>
            )}
        </div>
    );
}

function CompanyFacts({ company: c, officialDate }: { company: Company; officialDate: string | null }) {
    const site = c.website ? externalHref(c.website) : null;
    return (
        <Card title='基本資料' testId='company-facts' meta={<OfficialTag date={officialDate} testId='company-facts-official' />}>
            <dl className={s.facts}>
                {c.full_name && (
                    <>
                        <dt>公司名稱</dt>
                        <dd data-testid='company-fact-fullname'>{c.full_name}</dd>
                    </>
                )}
                {c.english_short && (
                    <>
                        <dt>英文簡稱</dt>
                        <dd data-testid='company-fact-english'>{c.english_short}</dd>
                    </>
                )}
                <dt>市場</dt>
                <dd data-testid='company-fact-market'>{MARKET_LABEL[c.market] ?? c.market}</dd>
                {c.industry?.l0_name && (
                    <>
                        <dt>產業別</dt>
                        <dd data-testid='company-fact-industry'>{c.industry.l0_name}（交易所）</dd>
                    </>
                )}
                {c.listed && (
                    <>
                        <dt>{c.market === 'tpex' ? '上櫃日期' : '上市日期'}</dt>
                        <dd className={s.mono} data-testid='company-fact-listed'>{c.listed}</dd>
                    </>
                )}
                {c.incorporated && (
                    <>
                        <dt>成立日期</dt>
                        <dd className={s.mono} data-testid='company-fact-incorporated'>{c.incorporated}</dd>
                    </>
                )}
                {c.tax_id && (
                    <>
                        <dt>統一編號</dt>
                        <dd className={s.mono} data-testid='company-fact-taxid'>{c.tax_id}</dd>
                    </>
                )}
                {c.website && (
                    <>
                        <dt>網站</dt>
                        <dd data-testid='company-fact-website'>
                            {site ? <ExternalAnchor href={site}>{siteText(c.website)}</ExternalAnchor> : siteText(c.website)}
                        </dd>
                    </>
                )}
            </dl>
        </Card>
    );
}

// ---- 財務 ----

const MONTH_PREVIEW = 6;
const CHART_MONTHS = 36;

/**
 * 月營收長條（近 36 個月）＋年增率折線。SVG 以 viewBox 拉伸到容器寬（preserveAspectRatio none），
 * 文字（最大值、月份）放在 SVG 外的 HTML，不會被縮放；折線與零軸以 non-scaling-stroke 維持線寬。
 */
export function RevenueChart({ fin }: { fin: Financials }) {
    const months = recentRevenue(fin, CHART_MONTHS);
    const n = Math.max(1, months.length);
    const W = n * 10;
    const H = 100;
    const values = months.map(m => m.revenue_thousand_twd ?? 0);
    const max = Math.max(1, ...values);
    const finiteYoy = months.map(m => m.yoy_pct).filter((v): v is number => v !== null && Number.isFinite(v));
    const yMin = Math.min(0, ...finiteYoy);
    const yMax = Math.max(0, ...finiteYoy, 1);
    const yOf = (v: number) => H - ((v - yMin) / (yMax - yMin)) * H;
    const points = months
        .map((m, i) => (m.yoy_pct === null || !Number.isFinite(m.yoy_pct) ? null : `${i * 10 + 5},${yOf(m.yoy_pct).toFixed(2)}`))
        .filter(Boolean)
        .join(' ');
    const mid = Math.floor((months.length - 1) / 2);
    return (
        <div className={s.chartBox} data-testid='company-revenue-chart'>
            {/* 最大值刻度只是視覺輔助（數值都在下方表格）；讀屏以 SVG 的 aria-label 為準 */}
            <span className={s.chartAxis} aria-hidden='true' data-testid='company-revenue-max'><span>{fmtK(max)}</span></span>
            <svg
                className={s.chartSvg}
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio='none'
                role='img'
                aria-label={`月營收與年增率（近 ${months.length} 個月）`}
            >
                {months.map((m, i) => {
                    const h = ((m.revenue_thousand_twd ?? 0) / max) * H;
                    return (
                        <rect
                            key={m.period}
                            className={s.chartBar}
                            x={i * 10 + 1.7}
                            y={H - h}
                            width={6.6}
                            height={h}
                            opacity={i === months.length - 1 ? 0.9 : 0.42}
                        />
                    );
                })}
                {yMin < 0 && <line className={s.chartZero} x1='0' x2={W} y1={yOf(0)} y2={yOf(0)} vectorEffect='non-scaling-stroke' />}
                {points && <polyline className={s.chartLine} points={points} vectorEffect='non-scaling-stroke' data-testid='company-revenue-yoy' />}
            </svg>
            <span className={s.chartAxis} aria-hidden='true'>
                <span>{months[0]?.period}</span>
                {months.length > 2 && <span>{months[mid]?.period}</span>}
                {months.length > 1 && <span>{months[months.length - 1]?.period}</span>}
            </span>
        </div>
    );
}

export const FinancialsTab = memo(function FinancialsTab({ view }: { view: CompanyDataView }) {
    const [allMonths, setAllMonths] = useState(false);
    const fin = view.financials;
    if (!fin) {
        return (
            <div className={s.card} data-testid='company-financials-empty'>
                <p className={s.footnote}>{view.financialsError ?? '這家公司沒有財報資料'}</p>
            </div>
        );
    }
    const monthsAll = recentRevenue(fin, CHART_MONTHS).slice().reverse();
    const months = allMonths ? monthsAll : monthsAll.slice(0, MONTH_PREVIEW);
    const quarters = quarterMetrics(fin, 8);
    const general = quarters.some(q => q.grossMarginPct !== null);
    return (
        <>
            <Card
                title='月營收'
                testId='company-revenue'
                meta={<><StaleTag meta={view.financialsMeta} /><OfficialTag date={view.financialsMeta?.asOf} testId='company-revenue-official' /></>}
            >
                {fin.monthly_revenue.length > 0 ? (
                    <>
                        <RevenueChart fin={fin} />
                        <div className={s.legend} data-testid='company-revenue-legend'>
                            <span className={s.legendKey}>
                                <span className={s.legendBar} aria-hidden='true' />
                                營收（近 {Math.min(CHART_MONTHS, fin.monthly_revenue.length)} 個月）
                            </span>
                            <span className={s.legendKey}>
                                <span className={s.legendLine} aria-hidden='true' />
                                年增率
                            </span>
                        </div>
                        <div className={s.tableScroll}>
                            <table className={s.table} data-testid='company-revenue-table'>
                                <thead>
                                    <tr>
                                        <th scope='col'>月份</th>
                                        <th scope='col'>營收</th>
                                        <th scope='col'>月增</th>
                                        <th scope='col'>年增</th>
                                        <th scope='col'>累計年增</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {months.map(m => (
                                        <tr key={m.period}>
                                            <td>{m.period}</td>
                                            <td>{fmtK(m.revenue_thousand_twd)}</td>
                                            <td>{fmtGrowth(m.mom_pct)}</td>
                                            <td>{fmtGrowth(m.yoy_pct)}</td>
                                            <td>{fmtGrowth(m.ytd_yoy_pct)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {monthsAll.length > MONTH_PREVIEW && (
                            <button type='button' className={s.more} onClick={() => setAllMonths(v => !v)} data-testid='company-revenue-more'>
                                {allMonths ? '收合' : `顯示全部 ${monthsAll.length} 個月`}
                            </button>
                        )}
                    </>
                ) : (
                    <span className={s.muted}>沒有月營收資料</span>
                )}
            </Card>
            <Card title='季度財報' testId='company-quarters' meta={<span className={s.muted}>單季，合併報表</span>}>
                {quarters.length > 0 ? (
                    <div className={s.tableScroll}>
                        <table className={s.table} data-testid='company-quarter-table'>
                            <thead>
                                <tr>
                                    <th scope='col'>季別</th>
                                    <th scope='col'>營收</th>
                                    {general && <th scope='col'>毛利率</th>}
                                    {general && <th scope='col'>營益率</th>}
                                    <th scope='col'>淨利率</th>
                                    <th scope='col'>EPS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {quarters.map(q => (
                                    <tr key={q.period}>
                                        <td>{q.period}</td>
                                        <td>{fmtK(q.revenue)}</td>
                                        {general && <td>{fmtRatio(q.grossMarginPct)}</td>}
                                        {general && <td>{fmtRatio(q.operatingMarginPct)}</td>}
                                        <td>{fmtRatio(q.netMarginPct)}</td>
                                        <td>{q.eps !== null ? q.eps.toFixed(2) : '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <span className={s.muted}>沒有季報資料</span>
                )}
                <p className={s.footnote} data-testid='company-financials-source'>
                    金額為新台幣；淨利為歸屬母公司業主；來源：公開資訊觀測站彙總報表、證交所與櫃買中心開放資料
                </p>
            </Card>
        </>
    );
});

// ---- 上下游 ----

export const RELATION_GROUPS: { key: keyof Company['relations']; label: string }[] = [
    { key: 'suppliers', label: '供應商' },
    { key: 'customers', label: '客戶' },
    { key: 'partners', label: '合作夥伴' },
    { key: 'competitors', label: '競爭對手' },
    { key: 'subsidiaries', label: '子公司' },
    { key: 'parents', label: '母公司' },
    { key: 'transactions', label: '重大交易' },
];
const GROUP_PREVIEW = 6;

/** 子分頁標籤「上下游 N」的 N（同桌面：所有關係列數；未研究時不顯示） */
export function relationCount(c: Company): number {
    return Object.values(c.relations ?? {}).reduce((n, rows) => n + (rows?.length ?? 0), 0);
}

/** 子分頁標籤「來源 N」的 N（同桌面：研究出處筆數；0 時不顯示） */
export function evidenceCount(c: Company): number {
    return Object.keys(c.evidence ?? {}).length;
}

export const RelationsTab = memo(function RelationsTab({ company: c, researched, entities, live }: {
    company: Company;
    researched: boolean;
    entities: Entity[] | null;
    /** 公司分頁顯示中：讀取並訂閱看得到的上市櫃列的即時漲跌幅 */
    live: boolean;
}) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const groups = useMemo(
        () => RELATION_GROUPS.map(g => ({ ...g, rows: c.relations?.[g.key] ?? [] })).filter(g => g.rows.length > 0),
        [c],
    );
    const index = entities ? entityIndex(entities) : null;
    // 看得到的列（同桌面：每組預覽或展開後全部）
    const visibleRows = useMemo(
        () => groups.flatMap(g => (expanded[g.key] ? g.rows : g.rows.slice(0, GROUP_PREVIEW))),
        [groups, expanded],
    );
    const snapshots = useRelationSnapshots(visibleRows, index, live && researched);

    if (!researched) {
        return <OfficialOnlyNote>這家公司尚未納入研究，沒有客戶、供應商與合作關係資料。</OfficialOnlyNote>;
    }
    if (groups.length === 0) {
        return (
            <div className={s.card} data-testid='company-relations-empty'>
                <p className={s.footnote}>研究資料沒有列出具名的上下游或關係企業</p>
            </div>
        );
    }
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    return (
        <Card title='上下游與關係' testId='company-relations' meta={<><span className={s.count}>{total}</span><ThirdPartyTag asOf={c.as_of} /></>}>
            <p className={s.footnote}>{THIRD_PARTY_NOTE}。標「媒體」者來源為具名媒體報導；上市櫃公司可點開交易頁。</p>
            {groups.map(g => {
                const open = expanded[g.key] ?? false;
                const rows = open ? g.rows : g.rows.slice(0, GROUP_PREVIEW);
                return (
                    <div key={g.key} className={s.list} data-testid={`company-relations-${g.key}`}>
                        <div className={s.listHead}>
                            <span className={s.listHeadTitle}>{g.label}</span>
                            <span className={s.count}>{g.rows.length}</span>
                        </div>
                        {rows.map(row => (
                            <RelationLine key={`${g.key}:${row.edge}:${row.id}`} row={row} index={index} snapshot={snapshots.get(tradableCodeOf(row.id) ?? '')} />
                        ))}
                        {g.rows.length > GROUP_PREVIEW && (
                            <button
                                type='button'
                                className={s.more}
                                onClick={() => setExpanded(e => ({ ...e, [g.key]: !open }))}
                                data-testid={`company-relations-${g.key}-more`}
                            >
                                {open ? '收合' : `顯示全部 ${g.rows.length} 筆`}
                            </button>
                        )}
                    </div>
                );
            })}
        </Card>
    );
});

const pctDir = (v: number): 'up' | 'down' | 'flat' => (!Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

function RelationLine({ row, index, snapshot }: { row: RelationRow; index: Map<string, Entity> | null; snapshot?: Snapshot }) {
    const code = tradableCodeOf(row.id);
    const detail = [row.amount, row.detail].filter(Boolean).join(' · ');
    // 名稱以研究資料列上的名稱為準（同桌面）；實體索引只在缺名稱時補
    const name = row.name || entityName(index, row.id);
    const body = (
        <>
            <span className={s.rowName}>
                {!code && (
                    <>
                        <Globe className={s.foreignIcon} aria-hidden='true' focusable='false' />
                        <span className={srOnly}>非台股：</span>
                    </>
                )}
                <span>{name}</span>
                {code && <span className={s.rowCode}>{code}</span>}
                {code && <span className={srOnly}>（開交易頁）</span>}
            </span>
            <span className={s.rowEnd}>
                {row.evidence_level === 'media' && (
                    <span className={s.tag.neutral} data-testid='company-relation-media'>
                        媒體<span className={srOnly}>（來源為具名媒體報導）</span>
                    </span>
                )}
                {snapshot && Number.isFinite(snapshot.change_rate) ? (
                    <span className={s.dirText[pctDir(snapshot.change_rate)]} data-testid='company-relation-pct'>
                        <span className={srOnly}>漲跌幅 </span>
                        {fmtPct(snapshot.change_rate)}
                    </span>
                ) : (row.as_of ?? '')}
            </span>
            <span className={s.rowDetail}>{detail || '—'}</span>
        </>
    );
    if (!code) return <div className={s.row} data-testid='company-relation-row'>{body}</div>;
    return (
        <button
            type='button'
            className={s.rowLink}
            data-testid='company-relation-row'
            data-code={code}
            onClick={() => openTrade(code)}
        >
            {body}
        </button>
    );
}

// ---- 來源 ----

const EVIDENCE_PREVIEW = 12;

export const SourcesTab = memo(function SourcesTab({ view, researched }: { view: CompanyDataView; researched: boolean }) {
    const [all, setAll] = useState(false);
    const c = view.company;
    const evidence = Object.entries(c.evidence ?? {}).sort(([, a], [, b]) =>
        String(b.published_date ?? '').localeCompare(String(a.published_date ?? '')),
    );
    const shown = all ? evidence : evidence.slice(0, EVIDENCE_PREVIEW);
    const stale = staleParts(view);
    const disclaimers = [view.meta.disclaimer, view.sources?.disclaimer]
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .filter((t, i, list) => list.indexOf(t) === i);
    return (
        <>
            <Card title='資料時點' testId='company-asof'>
                <dl className={s.facts}>
                    <dt>研究資料</dt>
                    <dd data-testid='company-asof-research'>{researched ? `${c.as_of}（第三方，AI 整理並交叉核對）` : '尚未研究，只有官方資料'}</dd>
                    <dt>官方資料</dt>
                    <dd data-testid='company-asof-official'>{view.meta.officialFetchedAt ?? '—'}</dd>
                    {view.financialsMeta?.asOf && (
                        <>
                            <dt>月營收至</dt>
                            <dd data-testid='company-asof-revenue'>{view.financialsMeta.asOf}</dd>
                        </>
                    )}
                    <dt>資料版本</dt>
                    <dd className={s.mono} data-testid='company-asof-release'>{view.meta.releaseId}</dd>
                    {stale.length > 0 && (
                        <>
                            <dt>離線快取</dt>
                            <dd data-testid='company-asof-stale'>{stale.join('、')}（{STALE_TEXT.split('・')[1]}）</dd>
                        </>
                    )}
                </dl>
            </Card>
            {evidence.length > 0 && (
                <Card title='研究出處' testId='company-evidence' meta={<span className={s.muted}>{evidence.length} 筆</span>}>
                    <ul className={s.sourceList}>
                        {shown.map(([id, e]) => (
                            <li key={id} className={s.sourceItem} data-testid='company-evidence-item'>
                                <ExternalAnchor href={e.url}>{e.title ?? e.url ?? id}</ExternalAnchor>
                                <span className={s.footnote}>{[e.publisher, e.published_date, e.locator].filter(Boolean).join(' · ')}</span>
                            </li>
                        ))}
                    </ul>
                    {evidence.length > EVIDENCE_PREVIEW && (
                        <button type='button' className={s.more} onClick={() => setAll(v => !v)} data-testid='company-evidence-more'>
                            {all ? '收合' : `顯示全部 ${evidence.length} 筆`}
                        </button>
                    )}
                </Card>
            )}
            {view.sources && view.sources.sources.length > 0 && (
                <Card title='官方資料來源' testId='company-official-sources' meta={<StaleTag meta={view.sourcesMeta} />}>
                    <ul className={s.sourceList}>
                        {view.sources.sources.map(src => (
                            <li key={src.id} className={s.sourceItem} data-testid='company-official-source'>
                                <ExternalAnchor href={src.url}>{src.attribution}</ExternalAnchor>
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            {disclaimers.length > 0 && (
                <div className={s.card} data-testid='company-disclaimer'>
                    {disclaimers.map(t => <p key={t} className={s.footnote}>{t}</p>)}
                </div>
            )}
        </>
    );
});
