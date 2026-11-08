// src/mobile/components/holdings-list.tsx — 自選頁「持倉」分段（使用者要求：依持倉自動列出，不可手動新增或刪除；設計規格 §7.2）
//
// - 延遲載入（lib/deferred-modules.ts loadHoldingsList，比照排行）：只在「持倉」分段掛載；首屏只有分段標籤與 lazy 入口。
// - 資料：與持倉頁同一份交易狀態 useTradingState().positions（含各帳戶，股票、ETF、權證、期貨、選擇權全部）。
//   持倉在 App 啟動時就由殼層的 useTradingState()（分頁列）啟動 lib/trading-state，連線後讀取一次，之後由成交回報與
//   持倉頁的「⟳」更新；本分段不另外觸發讀取、不輪詢，持倉增減時跟著重繪。
// - 合併（mergeHoldings）：依「商品類別（股票帳戶／期貨帳戶）＋代碼」合併成一列，順序為第一次出現的順序（持倉頁的券商順序）；
//   同一檔在多個帳戶或多種條件（現股＋融資等）都有時仍只一列，標記為第一筆的「條件 方向 數量」再加「等 N 筆」。
// - 列：與自選列相同（components/quote-row.tsx：成交價、漲跌、迷你走勢依設定、快速下單鍵；指數、組合商品照既有規則），
//   第二行代碼後加持倉標記（分成幾段，放不下時換行）；遮蔽金額時數量以 maskMoney 遮蔽（比照持倉頁）。
//   合約（名稱、市場標記）取自合約快取：lib/trading-state 啟動時已為每個持倉代碼 ensureContract，本元件不另外解析。
//   處置徽章只讀既有快取（usePunishedCodes(false)，不觸發讀取）。
// - 狀態：讀取中 Skeleton；沒有持倉 EmptyState「目前沒有持倉」；讀取失敗或待對帳 InlineNote（reconcileText）＋「前往持倉頁」（只 navigate）。
// - 互動：點列 → 交易頁；長按 → 操作面板只有「開啟交易頁」「買進…」「賣出…」（不能移動或移除）；
//   快速下單鍵與「買進…／賣出…」只呼叫 openTicket（只開下單面板，之後仍需預覽與滑動確認，設計規格 §10 S1）。
//   沒有任何編輯入口（新增、移除、排序、多選）。
// - 請求：除了可見列的行情訂閱（QuoteRow 既有機制，與自選相同）與迷你走勢（依設定，與自選相同）之外，不發任何請求。

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuote, type PriceQuoteState } from '../../hooks/use-stream';
import { useContract } from '../../lib/contracts-cache';
import { maskMoney, usePrivacyMoney } from '../../lib/privacy';
import { useTradingState } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { AccountedPosition } from '../../lib/types/portfolio';
import { navigate } from '../lib/hash-router';
import { openTicket } from '../lib/mobile-store';
import { isStockPosition, positionCondText, positionQtyText, reconcileText, sideText } from '../lib/position-text';
import { usePunishedCodes } from '../lib/regulatory-punish';
import { fill } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection, ListRow } from '../ui/grouped';
import { InlineNote } from '../ui/inline-note';
import { Skeleton } from '../ui/skeleton';
import { BottomSheet } from './bottom-sheet';
import { marketTag, QuoteRow, tradableContract, useSparkColumn, useVisibilityTracker, type VisibilityTracker, type WatchMetric } from './quote-row';

export interface Holding {
    /** 合併鍵：S（股票帳戶）／F（期貨帳戶）＋代碼 */
    key: string;
    code: string;
    /** 依第一次出現的順序；第一筆決定標記的條件、方向與數量 */
    positions: AccountedPosition[];
}

/** 依「商品類別＋代碼」合併持倉；順序為第一次出現的順序（持倉頁的券商順序） */
export function mergeHoldings(positions: readonly AccountedPosition[]): Holding[] {
    const map = new Map<string, Holding>();
    for (const p of positions) {
        const key = `${isStockPosition(p) ? 'S' : 'F'}:${p.code}`;
        const h = map.get(key);
        if (h) h.positions.push(p);
        else map.set(key, { key, code: p.code, positions: [p] });
    }
    return [...map.values()];
}

/** 持倉標記的幾段（放不下時在段與段之間換行）：「條件 方向」「數量」（遮蔽金額時遮蔽）「等 N 筆」 */
export function holdingTagParts(h: Holding, contract: Pick<ContractInfo, 'security_type'> | undefined, privMoney: boolean): string[] {
    const p = h.positions[0]!;
    const parts = [`${positionCondText(p, contract)} ${sideText(p.direction)}`, maskMoney(positionQtyText(p), privMoney)];
    if (h.positions.length > 1) parts.push(`等 ${h.positions.length} 筆`);
    return parts;
}

/** 合併只看會影響列的欄位（帳戶、代碼、方向、條件、數量）：現價隨 tick 更新時不重算、不重繪 */
const holdingsSig = (positions: readonly AccountedPosition[]) =>
    positions.map(p => `${p.account?.broker_id}|${p.account?.account_id}|${isStockPosition(p) ? `S|${p.cond ?? ''}` : 'F'}|${p.code}|${p.direction}|${p.quantity}`).join('\n');

/** 只在列可見時掛載：訂閱行情交給列（同自選的 WatchQuoteProbe） */
function HoldingQuoteProbe({ code, onQuote }: { code: string; onQuote: (q: PriceQuoteState | undefined) => void }) {
    const quote = useQuote(code, { narrow: true });
    useEffect(() => { onQuote(quote); }, [quote, onQuote]);
    return null;
}

interface HoldingRowProps {
    holding: Holding;
    index: number;
    tracker: VisibilityTracker | null;
    metric: WatchMetric;
    spark: boolean;
    punished: boolean;
    privMoney: boolean;
    onOpen: (code: string) => void;
    onActions: (code: string) => void;
    onTicket: (code: string) => void;
}

const HoldingRow = memo(function HoldingRow({ holding, index, tracker, metric, spark, punished, privMoney, onOpen, onActions, onTicket }: HoldingRowProps) {
    const code = holding.code;
    const contract = useContract(code);
    // 合約未載入前不顯示快速下單鍵（同寬佔位）：避免把指數、組合商品當成可交易
    const tradable = contract ? tradableContract(contract) : false;
    const parts = holdingTagParts(holding, contract, privMoney);
    return (
        <QuoteRow
            testPrefix='holding'
            code={code}
            name={contract?.name ?? ''}
            tag={contract ? marketTag(contract) : null}
            tradable={tradable}
            index={index}
            tracker={tracker}
            metric={metric}
            spark={spark}
            sparkContract={tradable ? contract! : null}
            sparkReference={contract?.reference || undefined}
            punished={punished}
            quoteContract={contract ?? { reference: 0 }}
            probe={HoldingQuoteProbe}
            metaExtra={parts.map((t, i) => <span key={i} className={styles.rankExtra} data-testid='holding-tag'>{t}</span>)}
            ariaSuffix={`，持倉 ${parts.join(' ')}`}
            onOpen={onOpen}
            onLongPress={onActions}
            onTicket={onTicket}
        />
    );
});

/** 長按操作面板：只有開啟交易頁、買進…、賣出…（不能移動或移除；買賣只開下單面板） */
function HoldingActionsSheet({ code, onClose, onOpen }: { code: string | null; onClose: () => void; onOpen: (code: string) => void }) {
    const contract = useContract(code);
    const tradable = contract ? tradableContract(contract) : false;
    const ticket = (action: 'Buy' | 'Sell') => {
        if (!code) return;
        onClose();
        openTicket({ code, action, source: 'other' });
    };
    return (
        <BottomSheet open={code !== null} onClose={onClose} title={code ? `${code} ${contract?.name ?? ''}`.trim() : ''} testId='holding-actions'>
            {code && (
                <div className={styles.actionSheet}>
                    <GroupedSection>
                        <ListRow title='開啟交易頁' chevron onClick={() => { onOpen(code); onClose(); }} testId='holding-action-open' />
                        {tradable && (
                            <ListRow
                                title='買進…'
                                leading={<span className={`${styles.sideBadge} ${fill.up.strong}`}>買</span>}
                                onClick={() => ticket('Buy')}
                                testId='holding-action-buy'
                            />
                        )}
                        {tradable && (
                            <ListRow
                                title='賣出…'
                                leading={<span className={`${styles.sideBadge} ${fill.down.strong}`}>賣</span>}
                                onClick={() => ticket('Sell')}
                                testId='holding-action-sell'
                            />
                        )}
                    </GroupedSection>
                </div>
            )}
        </BottomSheet>
    );
}

const toPositions = () => navigate({ name: 'positions' });

export function HoldingsList({ metric, onOpen }: { metric: WatchMetric; onOpen: (code: string) => void }) {
    const { positions, queries } = useTradingState();
    const query = queries.positions;
    const privMoney = usePrivacyMoney();
    const tracker = useVisibilityTracker();
    const spark = useSparkColumn();
    // 處置徽章：只用既有快取（自選、排行讀過的名單），不另外讀取
    const punished = usePunishedCodes(false);
    const sig = holdingsSig(positions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const holdings = useMemo(() => mergeHoldings(positions), [sig]);
    const [actionCode, setActionCode] = useState<string | null>(null);
    const onActions = useCallback((code: string) => setActionCode(code), []);
    const onTicket = useCallback((code: string) => { openTicket({ code, source: 'other' }); }, []);

    const reconcile = reconcileText(query);
    const note = reconcile && (
        <div className={styles.stateBlock}>
            <InlineNote
                tone={query.updatedAt === null ? 'danger' : 'warn'}
                role={query.updatedAt === null ? 'alert' : 'status'}
                action={{ label: '前往持倉頁', onClick: toPositions, testId: 'holdings-to-positions' }}
                testId='holdings-reconcile'
            >
                {reconcile}
            </InlineNote>
        </div>
    );

    if (!holdings.length) {
        if (query.updatedAt === null && !query.error) return <Skeleton label='持倉讀取中…' rows={6} testId='holdings-loading' />;
        // 第一次讀取就失敗（從未讀到）：不能說「目前沒有持倉」
        if (query.updatedAt === null) return note;
        return (
            <>
                {note}
                <EmptyState title='目前沒有持倉' description='有持倉時會自動列在這裡；這個分段不能手動新增或移除。' testId='holdings-empty' />
            </>
        );
    }

    return (
        <>
            {note}
            <ul className={styles.list} aria-label='持倉商品' data-testid='holdings-list'>
                {holdings.map((h, index) => (
                    <HoldingRow
                        key={h.key}
                        holding={h}
                        index={index}
                        tracker={tracker}
                        metric={metric}
                        spark={spark}
                        punished={punished.has(h.code)}
                        privMoney={privMoney}
                        onOpen={onOpen}
                        onActions={onActions}
                        onTicket={onTicket}
                    />
                ))}
            </ul>
            <HoldingActionsSheet code={actionCode} onClose={() => setActionCode(null)} onOpen={onOpen} />
        </>
    );
}
