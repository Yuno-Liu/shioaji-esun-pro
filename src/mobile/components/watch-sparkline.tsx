// src/mobile/components/watch-sparkline.tsx — 自選列的迷你走勢（canvas；參考桌面 src/components/sparkline.tsx，不 import 它）
//
// - 當日 1 分 K 收盤價折線＋淡色面積；昨收（參考價）畫虛線基準並決定顏色：最後一點高於參考價 up 色、低於 down 色、
//   相等（平盤）mutedForeground（vars.color.up／down，跟著台灣／國際配色）；沒有參考價時以第一點比較。
// - 即時價只更新尾端點（points＋last）；重繪以 rAF 合併，依 devicePixelRatio 設定畫布像素；主題變更時重畫。
// - 沒有動畫（減少動態下行為相同）。沒有 canvas／2D context 的環境（測試）不畫。
// - 預設尺寸是自選列的 56×32（styles.spark）；傳 className 時改用該尺寸，並以 ResizeObserver 在版面尺寸改變時重畫（指數列展開面板）。
// - 資料與請求上限在 lib/watch-sparkline-data.ts；本元件只負責畫。
// - 延遲載入（首屏體積）：自選頁經 lib/deferred-modules.ts 的 loadWatchSparkline() 載入 WatchSparkCell，
//   本檔與 lib/watch-sparkline-data.ts（含時段計算）都不進首屏 chunk。自選頁只為「可見列」掛載 WatchSparkCell，
//   不可見列沒有 canvas、沒有點陣、不排 rAF；卸載時把畫布尺寸歸 0，立即釋放點陣（iOS 對 canvas 總記憶體有上限）。

import { useEffect, useRef, useState } from 'react';
import { themeKey, useThemeSettings } from '../../lib/theme-store';
import type { ContractBase } from '../../lib/types/contract';
import { vars } from '../../theme.css';
import { useSparkline, useSparkTick } from '../lib/watch-sparkline-data';
import * as styles from '../styles/watchlist.css';

/** vanilla-extract 的 var(--x) 解析成實際顏色 */
function cssColor(el: Element, ref: string): string {
    if (!ref.startsWith('var(')) return ref;
    const name = ref.slice(4, -1).split(',')[0]!.trim();
    try {
        return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
    } catch {
        return '#888';
    }
}

/** 純函式：決定走勢方向（供測試）；相等為平盤 flat，不畫成上漲色 */
export function sparkTone(data: readonly number[], reference: number | undefined): 'up' | 'down' | 'flat' {
    const last = data[data.length - 1]!;
    const base = reference !== undefined && reference > 0 ? reference : data[0]!;
    return last > base ? 'up' : last < base ? 'down' : 'flat';
}

const TONE_COLOR = { up: vars.color.up, down: vars.color.down, flat: vars.color.mutedForeground } as const;

export function drawSparkline(cv: HTMLCanvasElement, data: readonly number[], reference: number | undefined): void {
    const cssW = cv.clientWidth || 56;
    const cssH = cv.clientHeight || 32;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
    const ctx = typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (data.length < 2) return;

    const ref = reference !== undefined && reference > 0 ? reference : undefined;
    let min = Math.min(...data);
    let max = Math.max(...data);
    if (ref !== undefined) {
        min = Math.min(min, ref);
        max = Math.max(max, ref);
    }
    if (max === min) {
        max += 1;
        min -= 1;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const x = (i: number) => (i / (data.length - 1)) * cssW;
    const y = (v: number) => cssH - ((v - min) / (max - min)) * (cssH - 2) - 1;

    if (ref !== undefined) {
        ctx.strokeStyle = cssColor(cv, vars.color.mutedForeground);
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y(ref)) + 0.5);
        ctx.lineTo(cssW, Math.round(y(ref)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    const color = cssColor(cv, TONE_COLOR[sparkTone(data, ref)]);
    ctx.beginPath();
    data.forEach((v, i) => {
        if (i === 0) ctx.moveTo(x(0), y(v));
        else ctx.lineTo(x(i), y(v));
    });
    // 淡色面積：沿折線到底部封閉（單色＋低不透明度，不用漸層以免透明端偏黑）
    ctx.save();
    ctx.lineTo(cssW, cssH);
    ctx.lineTo(0, cssH);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.14;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    data.forEach((v, i) => {
        if (i === 0) ctx.moveTo(x(0), y(v));
        else ctx.lineTo(x(i), y(v));
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();
}

export function WatchSparkline({ points, last, reference, className }: { points: readonly number[] | null; last?: number; reference?: number; className?: string }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const theme = themeKey(useThemeSettings());
    // 自訂尺寸（className，例如指數列面板填滿欄寬）：版面寬高改變（旋轉、字級）時重畫；自選列的固定 px 畫布不觀察
    const [resized, setResized] = useState(0);
    const fluid = className !== undefined;
    useEffect(() => {
        const cv = ref.current;
        if (!fluid || !cv || typeof ResizeObserver !== 'function') return;
        const ro = new ResizeObserver(() => setResized(n => n + 1));
        ro.observe(cv);
        return () => ro.disconnect();
    }, [fluid]);
    useEffect(() => {
        const cv = ref.current;
        if (!cv || typeof requestAnimationFrame !== 'function') return;
        const raf = requestAnimationFrame(() => {
            const base = points ?? [];
            const data = base.length > 0 && last !== undefined && Number.isFinite(last) ? [...base, last] : base;
            drawSparkline(cv, data, reference);
        });
        return () => cancelAnimationFrame(raf);
    }, [points, last, reference, theme, resized]);
    // 卸載時釋放點陣（DPR 3 的 56×32 畫布約 64 KB；只靠 GC 時 iOS 可能遲遲不回收）
    useEffect(() => {
        const cv = ref.current;
        return () => {
            if (!cv) return;
            cv.width = 0;
            cv.height = 0;
        };
    }, []);
    return <canvas ref={ref} className={className ?? styles.spark} aria-hidden='true' data-testid='watch-spark' data-points={points ? points.length : 0} />;
}

export interface WatchSparkCellProps {
    contract: ContractBase;
    /** 昨收（參考價）；0 或缺少時不畫基準線 */
    reference?: number;
    /** 列已節流的即時成交（以分鐘為桶寫入尾段；試撮不算） */
    tick: Parameters<typeof useSparkTick>[1];
    /** 畫布尺寸（預設自選列的 styles.spark 56×32；底部指數列展開面板填滿欄寬） */
    className?: string;
}

/**
 * 自選列走勢欄（延遲載入的入口）：只在列可見時掛載，掛載期間 retain（請求上限見 lib/watch-sparkline-data.ts），
 * 卸載即釋放（尚未開始的請求移出佇列）。
 */
export function WatchSparkCell({ contract, reference, tick, className }: WatchSparkCellProps) {
    const points = useSparkline(contract, true);
    useSparkTick(contract, tick);
    return <WatchSparkline points={points} reference={reference} className={className} />;
}
