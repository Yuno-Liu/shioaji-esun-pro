// src/mobile/routes/market-page.tsx — 底部分頁「市場」（延遲載入）
//
// 分段（Segmented tabs）：
// - 產業流向（#/market；舊書籤 #/sector 由殼層正規化到這裡）：routes/sector-page.tsx，行為與請求不變，只在這個分段顯示時掛載。
// - 盤中異動（#/market/signals）：components/market/market-signals.tsx，另一個延遲載入的 chunk
//   （retryableLazy＋ModuleErrorBoundary；載入失敗只在分段內容區顯示［重試］）。
// 切換分段只呼叫 navigate(replace)，不新增歷史紀錄；上次的分段記在 sessionStorage（底部「市場」分頁帶回該分段）。
// 盤中異動的 chunk 不在殼層的閒置預載清單（首屏 0 位元組）：市場頁掛載後閒置時預載一次（省流量／慢速網路時不預載）。
// 本頁沒有任何下單入口（§10 S1）。

import { Suspense, useEffect } from 'react';
import { ModuleErrorBoundary, ModuleLoadError, retryableLazy } from '../components/route-error-boundary';
import { MARKET_SEGMENT_KEY, navigate, type MarketSegment } from '../lib/hash-router';
import { constrainedNetwork, currentConnection, schedulePrefetchSequence } from '../lib/idle-prefetch';
import * as s from '../styles/sector.css';
import { PageHeader } from '../ui/page-header';
import { Segmented } from '../ui/segmented';
import { Skeleton } from '../ui/skeleton';
import { SectorPage } from './sector-page';

const MarketSignals = retryableLazy(() => import('../components/market/market-signals').then(m => m.MarketSignals), 'MarketSignals');
const resetSignals = () => { MarketSignals.reset(); };

/** 盤中異動的 chunk（失敗只吞掉：真正切到該分段時 lazy 會自己 import，仍失敗由 ModuleErrorBoundary 顯示［重試］） */
export const preloadMarketSignals = (): Promise<void> => MarketSignals.preload().catch(() => undefined);

const SEGMENTS = [
    { value: 'flow', label: '產業流向', testId: 'market-seg-flow' },
    { value: 'signals', label: '盤中異動', testId: 'market-seg-signals' },
] as const;

function rememberSegment(segment: MarketSegment): void {
    try {
        sessionStorage.setItem(MARKET_SEGMENT_KEY, segment);
    } catch {
        // 無痕模式或停用儲存：下次回到預設分段
    }
}

function MarketHeader({ segment }: { segment: MarketSegment }) {
    return (
        <>
            <PageHeader title='市場' />
            <div className={s.inset}>
                <Segmented<MarketSegment>
                    items={SEGMENTS}
                    value={segment}
                    onChange={v => {
                        if (v !== segment) navigate({ name: 'market', segment: v }, { replace: true });
                    }}
                    semantics='tabs'
                    ariaLabel='市場資訊'
                    testId='market-segment'
                />
            </div>
        </>
    );
}

export function MarketPage({ segment }: { segment: MarketSegment }) {
    useEffect(() => rememberSegment(segment), [segment]);
    useEffect(() => (constrainedNetwork(currentConnection()) ? undefined : schedulePrefetchSequence([preloadMarketSignals])), []);
    const header = <MarketHeader segment={segment} />;
    if (segment === 'flow') return <SectorPage header={header} />;
    return (
        <div className={s.page} data-testid='market-page'>
            {header}
            <ModuleErrorBoundary onRetry={resetSignals} fallback={props => <ModuleLoadError {...props} testId='market-signals-load-error' />}>
                <Suspense fallback={<div className={s.inset}><Skeleton label='盤中異動載入中…' rows={6} testId='market-signals-loading' /></div>}>
                    <MarketSignals />
                </Suspense>
            </ModuleErrorBoundary>
        </div>
    );
}
