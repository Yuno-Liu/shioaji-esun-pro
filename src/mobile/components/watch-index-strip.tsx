// src/mobile/components/watch-index-strip.tsx — 自選頁底部指數列（加權｜櫃買）
//
// - 自選頁以 ShellSlot slot='bottom' 放進底部 chrome 的配件槽（分頁列之上，與交易頁交易鍵列同一機制）；
//   高度由殼層量測寫入 --sj-accessory-h，main 底部內距自動讓出，不擋最後一列。
// - 即時：不經 useQuote。useQuote(code) 會先 ensureContract(code)：session 內第一次要走 resolveContract，
//   每檔 2 個 GET（合約基本資料＋info），兩檔共 4 個，只為了拿到訂閱用的 ContractBase。
//   這裡改用既有、帶型別的訂閱入口：lib/quote-ownership 的 retainContractQuotes(ContractBase)
//   （與 hooks/use-live-snapshots、lib/sector-flow-ic 相同做法；IND 只訂 Quote），讀 lib/stream 的 getQuote／subscribeQuoteStore。
//   合約代碼與交易所同桌面 market-pulse-panel／sector-flow-ic（IX0001 TSE 加權、IX0043 OTC 櫃買）。
//   → 合約解析 0 個 GET；Quote 訂閱 2 筆（每檔 1 筆，與其他畫面同一指數共用 quote-ownership 的參考計數）。
//   只在自選頁掛載時訂閱；離開頁面卸載後由 quote-ownership 的寬限期（RELEASE_GRACE_MS）退訂。
// - 後備（比照桌面 market-bar）：伺服器不一定會補發已推過的指數報價，收盤後、週末或開盤前才開的 App
//   沒有即時 index。指數列掛載時以一次 fetchSnapshots([IX0001, IX0043]) 取得 close 與 change_price（1 個 POST），
//   模組層快取、最多每 INDEX_SNAPSHOT_TTL_MS 一次（成功或失敗都算），失敗靜默。有即時 index 時以即時為準。
//   兩者都沒有時顯示「—」，aria-label 說明「沒有即時資料」。
// - 外觀（設計規格 §4.6、§4.8 規則 6／8）：bar 材質上的文字（標籤、數值、漲跌幅）一律 foreground；
//   方向以有色的 ▲／▼ SVG 圖形表示（aria-hidden，圖形門檻 3:1），漲跌幅文字仍帶正負號。
//   字級「大」值與漲跌幅上下排列；其他字級放不下時自動換行，不截斷（styles/watchlist.css.ts indexValue）。
// - 點一格只 navigate 到該指數的交易頁（指數不能下單，交易頁不顯示交易鍵）。
// - 收合／展開（右端切換鈕，觸控區 TOUCH_MIN、aria-expanded／aria-controls）：狀態存 localStorage INDEX_PANEL_KEY（'1' 展開，
//   其他收合；預設收合＝兩格）。展開時掛載延遲載入的 watch-index-panel（lib/deferred-modules.ts loadWatchIndexPanel：
//   兩欄的指數、漲跌點數與漲跌幅、成交金額、當日走勢）；載入中與載入失敗都顯示收合的兩格（不跳空白、不顯示錯誤）。
//   收合時不掛載面板、不讀 K 線；啟動時已記成展開就直接掛載（開始載入 chunk）。
//   數值與漲跌的計算（即時優先、快照後備）由 useIndexView 與面板共用。

import { ChevronDown } from 'lucide-react';
import { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { retainContractQuotes } from '../../lib/quote-ownership';
import { fetchSnapshots } from '../../lib/shioaji';
import { ensureStream, getQuote, subscribeQuoteStore } from '../../lib/stream';
import type { ContractBase } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { fmtPct, fmtPrice } from '../../lib/utils/format';
import { loadWatchIndexPanel } from '../lib/deferred-modules';
import { navigate } from '../lib/hash-router';
import { focusRing, pressable } from '../styles/primitives.css';
import * as styles from '../styles/watchlist.css';
import { ModuleErrorBoundary, retryableLazy } from './route-error-boundary';

/** 指數快照後備的最短讀取間隔（ms） */
export const INDEX_SNAPSHOT_TTL_MS = 10 * 60_000;

/** 底部指數列的兩檔（訂閱用 ContractBase；不經合約解析） */
export const WATCH_INDICES: readonly { label: string; contract: ContractBase }[] = [
    { label: '加權', contract: { security_type: 'IND', region: 'TW', exchange: 'TSE', code: 'IX0001', target_code: null } },
    { label: '櫃買', contract: { security_type: 'IND', region: 'TW', exchange: 'OTC', code: 'IX0043', target_code: null } },
];

const INDEX_CONTRACTS: ContractBase[] = WATCH_INDICES.map(i => i.contract);

let snapshots: ReadonlyMap<string, Snapshot> = new Map();
let lastLoadAt = Number.NEGATIVE_INFINITY;
let loading = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** 讀取指數快照（TTL 內、或已有請求進行中時不再請求） */
export function loadIndexSnapshots(): void {
    if (loading || Date.now() - lastLoadAt < INDEX_SNAPSHOT_TTL_MS) return;
    loading = true;
    lastLoadAt = Date.now();
    Promise.resolve()
        .then(() => fetchSnapshots(INDEX_CONTRACTS))
        .then(list => {
            const next = new Map(snapshots);
            for (const s of Array.isArray(list) ? list : []) {
                if (s && INDEX_CONTRACTS.some(c => c.code === s.code) && Number(s.close) > 0) next.set(s.code, s);
            }
            snapshots = next;
            listeners.forEach(l => l());
        }, () => undefined)
        .finally(() => { loading = false; });
}

/** 測試用：清空快照快取與節流 */
export function resetIndexSnapshotsForTest(): void {
    snapshots = new Map();
    lastLoadAt = Number.NEGATIVE_INFINITY;
    loading = false;
    listeners.clear();
}

/** 指數即時報價：直接以 ContractBase 訂閱 Quote（不經 ensureContract，沒有合約解析請求） */
function useIndexQuote(contract: ContractBase) {
    const code = contract.code;
    useEffect(() => {
        ensureStream();
        return retainContractQuotes(contract);
    }, [contract]);
    const sub = useCallback((listener: () => void) => subscribeQuoteStore(code, listener), [code]);
    return useSyncExternalStore(sub, () => getQuote(code)?.index, () => undefined);
}

/**
 * 一檔指數的顯示資料（列與展開面板共用）：即時 index 有成交價時以即時為準，否則用快照（close、close − change_price）。
 * dir：沒有漲跌或平盤為 flat；value／pctText 已格式化（沒有資料時 '—'／''）。
 */
export function useIndexView(contract: ContractBase) {
    const code = contract.code;
    const index = useIndexQuote(contract);
    const snap = useSyncExternalStore(subscribe, () => snapshots.get(code), () => undefined);
    const liveClose = index ? Number(index.close) : NaN;
    const live = Number.isFinite(liveClose) && liveClose > 0;
    const close = live ? liveClose : snap ? Number(snap.close) : NaN;
    const ref = live ? Number(index!.reference) : snap ? Number(snap.close) - Number(snap.change_price) : NaN;
    const has = Number.isFinite(close) && close > 0;
    const chg = has && Number.isFinite(ref) && ref > 0 ? close - ref : undefined;
    const pct = chg !== undefined ? (chg / ref) * 100 : undefined;
    const dir: 'up' | 'down' | 'flat' = chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    return {
        index, snap, live, has, ref, chg, dir,
        value: has ? fmtPrice(close, 2) : '—',
        pctText: pct !== undefined ? fmtPct(pct) : '',
        /** aria-label 的方向字（漲／跌／平盤） */
        dirWord: dir === 'up' ? '漲' : dir === 'down' ? '跌' : '平盤',
    };
}

/** 方向圖形（非文字）：有色實心三角形 */
export function DirArrow({ dir }: { dir: 'up' | 'down' }) {
    return (
        <svg
            className={`${styles.indexArrow} ${styles.tone[dir]}`}
            viewBox='0 0 8 8'
            aria-hidden='true'
            focusable='false'
            data-testid='watch-index-arrow'
            data-dir={dir}
        >
            <path d={dir === 'up' ? 'M4 0.5 7.75 7.5H0.25Z' : 'M0.25 0.5H7.75L4 7.5Z'} fill='currentColor' />
        </svg>
    );
}

function IndexCell({ contract, label }: { contract: ContractBase; label: string }) {
    const code = contract.code;
    const { live, has, dir, value, pctText, dirWord } = useIndexView(contract);
    const valueText = has ? value : '— 沒有即時資料';
    return (
        <button
            type='button'
            className={`${styles.indexCell} ${pressable} ${focusRing}`}
            aria-label={`${label}指數 ${valueText}${pctText ? `，${dirWord} ${pctText}` : ''}，開啟交易頁`}
            onClick={() => navigate({ name: 'trade', code })}
            data-testid={`watch-index-${code}`}
            data-source={live ? 'live' : has ? 'snapshot' : 'none'}
            data-dir={dir}
        >
            <span className={styles.indexLabel}>{label}</span>
            <span className={styles.indexValue} aria-hidden='true'>
                <span className={styles.indexNum} data-testid='watch-index-value'>{value}</span>
                {pctText && (
                    <span className={styles.indexPct} data-testid='watch-index-pct'>
                        {dir !== 'flat' && <DirArrow dir={dir} />}
                        {pctText}
                    </span>
                )}
            </span>
        </button>
    );
}

/** 展開狀態的 localStorage 鍵：'1' 展開，其他（含沒有）收合 */
export const INDEX_PANEL_KEY = 'sj-mobile-index-panel-v1';

const BODY_ID = 'watch-index-body';

const WatchIndexPanel = retryableLazy(() => loadWatchIndexPanel().then(m => m.WatchIndexPanel), 'WatchIndexPanel');

export function WatchIndexStrip() {
    useEffect(() => { loadIndexSnapshots(); }, []);
    const [open, setOpen] = useState(() => {
        try { return localStorage.getItem(INDEX_PANEL_KEY) === '1'; } catch { return false; }
    });
    const toggle = () => {
        // 上次載入失敗時，這次展開重新 import（retryableLazy.reset 只在失敗後換新）
        if (!open) WatchIndexPanel.reset();
        setOpen(!open);
        try { localStorage.setItem(INDEX_PANEL_KEY, open ? '0' : '1'); } catch { /* 無法儲存時只影響本次 */ }
    };
    const row = (
        <div className={styles.indexStrip}>
            {WATCH_INDICES.map(i => <IndexCell key={i.contract.code} contract={i.contract} label={i.label} />)}
        </div>
    );
    return (
        <div className={styles.indexBar} data-testid='watch-index-strip' data-open={open}>
            <div id={BODY_ID} className={styles.indexBody}>
                {open ? (
                    <ModuleErrorBoundary fallback={() => row}>
                        <Suspense fallback={row}>
                            <WatchIndexPanel />
                        </Suspense>
                    </ModuleErrorBoundary>
                ) : row}
            </div>
            <button
                type='button'
                className={`${styles.indexToggle} ${pressable} ${focusRing}`}
                aria-expanded={open}
                aria-controls={BODY_ID}
                aria-label={open ? '收合大盤走勢' : '展開大盤走勢'}
                onClick={toggle}
                data-testid='watch-index-toggle'
            >
                <ChevronDown size={18} aria-hidden='true' className={open ? undefined : styles.indexChevronUp} />
            </button>
        </div>
    );
}
