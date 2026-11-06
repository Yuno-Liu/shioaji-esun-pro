// src/mobile/components/trade-switch-sheet.tsx — 交易頁「切換商品」面板（設計規格 §7.2 搜尋面板、§7.3 交易頁）
//
// - 由交易頁標頭的標題鍵（trade-switch）開啟；只做查詢與導覽，不會下單、不開下單或委託面板（§10 S1）。
// - 面板 large；搜尋欄 sticky 在 body 頂端（與自選搜尋面板同樣式）；下方一行說明。
// - 查詢：hooks/use-product-search（searchProducts 的代碼前綴、名稱子字串、跳字模糊、別名、期貨關鍵字；debounce＋
//   新輸入取消舊查詢，晚到的舊結果不覆蓋新結果）。關閉後退場中暫停：取消 debounce 與進行中的查詢，退場中的畫面不變。
// - 空白查詢：「最近查看」（lib/recent-codes，本機紀錄）與「自選」（常駐自選清單已載入的合約；不另發請求，
//   沒有資料或不在 WatchlistProvider 內時不顯示）。
// - 整列點擊＝切換到該商品（onSelect）；目前商品標「目前」，點了只關閉。搜尋結果列尾保留「加入自選／已在自選」晶片。
// - 開啟即可打字：父層在點擊當下 engage 代理輸入框（lib/focus-proxy），這裡在面板進場完成（減少動態時立即；
//   最晚 FOCUS_FALLBACK_MS）把焦點移到搜尋框並移除代理輸入框；代理輸入框正在組字時延到組字結束（見 lib/focus-proxy）。

import { useContext, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { ProductSuggestion } from '../../lib/product-search';
import { securityTypeText, suggestionSubText, useProductSearch } from '../hooks/use-product-search';
import type { FocusProxy } from '../lib/focus-proxy';
import { loadRecentCodes } from '../lib/recent-codes';
import { useOptionalMobileWatchlist } from '../lib/watchlist-context';
import { prefersReducedMotion } from '../motion/prefs';
import { focusRing, pressable, pressableRow } from '../styles/primitives.css';
import * as sw from '../styles/trade-switch.css';
import * as styles from '../styles/watchlist.css';
import { chip } from '../ui/chip.css';
import { InlineNote } from '../ui/inline-note';
import { SheetPresenceContext } from '../ui/sheet-context';
import { BottomSheet } from './bottom-sheet';

/** 面板一直沒有就緒（例如動畫被系統暫停）時，最晚多久把焦點移到搜尋框（ms） */
export const FOCUS_FALLBACK_MS = 800;

export interface TradeSwitchSheetProps {
    open: boolean;
    onClose: () => void;
    /** 目前交易頁的商品代碼 */
    currentCode: string;
    /** 切換到另一檔商品（父層負責關閉面板與導覽） */
    onSelect: (code: string) => void;
    /** 父層在點擊當下 engage 的代理輸入框；面板就緒後由這裡 release 到搜尋框 */
    focusProxy?: MutableRefObject<FocusProxy | null>;
    /** 面板退場結束（BottomSheet onExited） */
    onExited?: () => void;
}

interface PickRowProps {
    code: string;
    name: string;
    sub: string;
    current: boolean;
    onPick: (code: string) => void;
    children?: ReactNode;
}

/** 一列：整列（主鍵）＝切換；列尾可放晶片 */
function PickRow({ code, name, sub, current, onPick, children }: PickRowProps) {
    const label = `${code}${name ? ` ${name}` : ''}`;
    return (
        <div className={styles.resultRow}>
            <button
                type='button'
                className={`${styles.resultMain} ${pressableRow}`}
                onClick={() => onPick(code)}
                aria-label={current ? `${label}（目前商品）` : `切換到 ${label}`}
                aria-current={current ? 'true' : undefined}
                data-testid='trade-switch-pick'
                data-code={code}
            >
                <span className={styles.rowTitleLine}>
                    <span className={styles.rowCode}>{code}</span>
                    {name && <span className={styles.resultName}>{name}</span>}
                </span>
                {sub && <span className={styles.rowSub}>{sub}</span>}
            </button>
            {current && <span className={sw.currentTag} aria-hidden='true'>目前</span>}
            {children}
        </div>
    );
}

/**
 * 面板就緒（或減少動態）時把焦點從代理輸入框移到搜尋框，並把轉移前打進代理輸入框的字帶進查詢；
 * 必須在 BottomSheet 內（讀進場狀態）。shownAt 在每次開啟（含退場中又開啟）更新，讓 effect 重新檢查。
 * 代理輸入框正在組字（release 回傳 null）：轉移延到組字結束，期間 proxyRef 保留，父層關閉或卸載時以 release() 取消；
 * 延後中 effect 重跑不再呼叫 release（再呼叫＝取消）。退場中不轉移。
 */
function useFocusTransfer(
    open: boolean,
    inputRef: MutableRefObject<HTMLInputElement | null>,
    proxyRef: MutableRefObject<FocusProxy | null> | undefined,
    onTyped: (text: string) => void,
) {
    const presence = useContext(SheetPresenceContext);
    const ready = presence.settled || prefersReducedMotion();
    const exiting = presence.phase === 'exiting';
    const onTypedRef = useRef(onTyped);
    onTypedRef.current = onTyped;
    const deferredRef = useRef<FocusProxy | null>(null);
    useEffect(() => {
        if (!open || exiting || !proxyRef?.current || proxyRef.current === deferredRef.current) return undefined;
        const transfer = () => {
            const proxy = proxyRef.current;
            if (!proxy || proxy === deferredRef.current) return;
            const typed = proxy.release(inputRef.current);
            if (typed === null) {
                deferredRef.current = proxy;
                proxy.onDeferred?.(late => {
                    if (deferredRef.current === proxy) deferredRef.current = null;
                    if (proxyRef.current === proxy) proxyRef.current = null;
                    if (late) onTypedRef.current(late);
                });
                return;
            }
            if (proxyRef.current === proxy) proxyRef.current = null;
            if (typed) onTypedRef.current(typed);
        };
        if (ready) {
            transfer();
            return undefined;
        }
        const timer = setTimeout(transfer, FOCUS_FALLBACK_MS);
        return () => clearTimeout(timer);
    }, [open, exiting, ready, presence.shownAt, inputRef, proxyRef]);
}

function SwitchBody({ open, currentCode, onSelect, onClose, focusProxy }: TradeSwitchSheetProps) {
    const wl = useOptionalMobileWatchlist();
    const [query, setQuery] = useState('');
    // 本元件是 BottomSheet 的凍結 children：退場中 open 仍為 true，改以 presence 暫停查詢（取消 debounce 與進行中的請求，畫面不變）
    const presence = useContext(SheetPresenceContext);
    const { results, status } = useProductSearch(query, open, { paused: presence.phase === 'exiting' });
    const [adding, setAdding] = useState<string | null>(null);
    const [messages, setMessages] = useState<Record<string, string>>({});
    const inputRef = useRef<HTMLInputElement | null>(null);
    const ids = useId();
    const hintId = `${ids}-hint`;
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    useFocusTransfer(open, inputRef, focusProxy, text => setQuery(q => q || text.slice(0, 40)));

    // 開啟時讀一次最近查看（交易頁載入合約後才寫入）
    const recent = useMemo(() => (open ? loadRecentCodes() : []), [open]);
    const watchItems = wl?.items ?? [];
    const watchedCodes = useMemo(() => new Set(watchItems.map(i => i.contract.code)), [watchItems]);
    const canAdd = !!wl && !wl.loading && !wl.structureBusy && !wl.loadError;

    const pick = (code: string) => {
        if (code === currentCode) onClose();
        else onSelect(code);
    };

    const add = async (s: ProductSuggestion) => {
        if (!wl || adding) return;
        setAdding(s.code);
        setMessages(m => ({ ...m, [s.code]: '' }));
        try {
            await wl.addSymbol(s.code, s.security_type, s.contract);
        } catch (e) {
            if (mounted.current) setMessages(m => ({ ...m, [s.code]: e instanceof Error && e.message ? e.message : '加入自選失敗，請稍後再試' }));
        } finally {
            if (mounted.current) setAdding(null);
        }
    };

    const chipClass = `${chip} ${pressable} ${focusRing} ${styles.resultChip}`;
    const blank = !query.trim();

    return (
        <>
            <div className={styles.searchBar}>
                <input
                    ref={inputRef}
                    className={styles.searchInput}
                    type='search'
                    inputMode='search'
                    enterKeyHint='search'
                    autoComplete='off'
                    autoCorrect='off'
                    autoCapitalize='off'
                    spellCheck={false}
                    placeholder='代碼或名稱，例如 2330、台積電、台指期'
                    aria-label='搜尋商品'
                    aria-describedby={hintId}
                    value={query}
                    maxLength={40}
                    onChange={e => setQuery(e.target.value)}
                    data-testid='trade-switch-input'
                />
            </div>
            <p id={hintId} className={sw.hint} data-testid='trade-switch-hint'>
                可輸入代碼或名稱（支援部分字詞與模糊比對；加「期」可查期貨）
            </p>

            {blank && recent.length > 0 && (
                <section aria-labelledby={`${ids}-recent`}>
                    <h3 id={`${ids}-recent`} className={sw.sectionTitle}>最近查看</h3>
                    <ul className={styles.resultList} data-testid='trade-switch-recent'>
                        {recent.map(r => (
                            <li key={r.code} className={styles.resultItem}>
                                <PickRow code={r.code} name={r.name} sub={securityTypeText(r.securityType)} current={r.code === currentCode} onPick={pick} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {blank && watchItems.length > 0 && (
                <section aria-labelledby={`${ids}-watch`}>
                    <h3 id={`${ids}-watch`} className={sw.sectionTitle}>自選</h3>
                    <ul className={styles.resultList} data-testid='trade-switch-watchlist'>
                        {watchItems.map(({ contract: c }) => (
                            <li key={c.code} className={styles.resultItem}>
                                <PickRow code={c.code} name={c.name} sub={securityTypeText(c.security_type)} current={c.code === currentCode} onPick={pick} />
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {status === 'loading' && <p className={styles.searchStatus} role='status'>搜尋中…</p>}
            {status === 'error' && <p className={styles.searchStatus} role='status'>搜尋失敗，請稍後再試。</p>}
            {status === 'done' && results.length === 0 && <p className={styles.searchStatus} role='status'>找不到符合的商品。</p>}
            {!blank && results.length > 0 && (
                <ul className={styles.resultList} data-testid='trade-switch-results'>
                    {results.map(s => {
                        const watched = watchedCodes.has(s.code);
                        const message = messages[s.code];
                        return (
                            <li key={`${s.security_type}:${s.exchange}:${s.code}`} className={styles.resultItem} data-testid='trade-switch-result'>
                                <PickRow code={s.code} name={s.name} sub={suggestionSubText(s)} current={s.code === currentCode} onPick={pick}>
                                    {wl && (
                                        <button
                                            type='button'
                                            className={chipClass}
                                            disabled={watched || !canAdd || adding !== null}
                                            aria-label={watched ? `${s.code} 已在自選` : adding === s.code ? `${s.code} 加入中` : `${s.code} 加入自選`}
                                            onClick={() => void add(s)}
                                            data-testid='trade-switch-add'
                                        >
                                            {watched ? '已在自選' : adding === s.code ? '加入中…' : '加入自選'}
                                        </button>
                                    )}
                                </PickRow>
                                {message && (
                                    <div className={styles.resultMessage}>
                                        <InlineNote tone='warn' role='alert'>{message}</InlineNote>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {wl && !canAdd && !blank && results.length > 0 && <p className={styles.searchStatus}>自選清單載入或更新中，稍後才能加入。</p>}
        </>
    );
}

export function TradeSwitchSheet(props: TradeSwitchSheetProps) {
    const { open, onClose, onExited } = props;
    return (
        <BottomSheet open={open} onClose={onClose} title='切換商品' testId='trade-switch-sheet' detent='large' onExited={onExited}>
            {/* 退場結束即卸載內容：下次開啟是乾淨的搜尋 */}
            <SwitchBody {...props} />
        </BottomSheet>
    );
}
