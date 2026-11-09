// src/mobile/components/account/today-limits.tsx — 「今日剩餘交易額度」的共用規則與持倉頁摘要的一行
//
// - 資料：沿用 hooks/use-trading-limits（模組層快取 TTL 60 秒、手動最短 10 秒；與帳戶頁額度卡、下單面板共用一份），
//   這裡不另發查詢。只有證券帳戶有交易額度；期貨帳戶不查。
// - 永豐：主值＝現股可用（trading_available），已用（trading_used）與總額度（trading_limit）有資料時一併顯示。
// - 玉山（limitsAreCapsOnly）：券商只提供上限（lib 會把缺的可用補成上限，不可當剩餘或可用）。主值改為
//   「估算剩餘」＝上限 − 今日買進（已成交＋未成交），由 hooks/use-esun-limit-estimate 依本 App 的委託清單就地估算
//   （規則見 lib/esun-limit-estimate.ts；不另發查詢），下方一行「上限 L；今日買進 已成交 A＋未成交 B」並註明為估算。
//   帳戶頁額度卡、持倉頁摘要一行、下單面板用同一個估算與同一份文字（lib 的 ESUN_ESTIMATE_TEXT／esunBreakdownText）。
// - 模擬環境或非 08:30–15:00（limitsLookEmpty）顯示「—」並說明，不顯示 0 元。
// - 持倉頁摘要的一行：點擊以 openTodayLimits() 跳到帳戶頁並捲到額度卡（帳戶頁 LimitsCard 掛載時消化這個請求）。
//   帳戶：持倉頁篩選單一證券帳戶時顯示該帳戶（account prop）；全部或期貨篩選時沿用目前選取的證券帳戶。
//   標籤帶券商名稱：「永豐 今日剩餘額度」「玉山 今日剩餘額度」（玉山的值為「估算剩餘 X」）。
// - 金額一律 maskMoney（遮蔽金額設定）。

import { Component, type ReactNode } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { maskMoney } from '../../../lib/privacy';
import { isEsunAccount } from '../../../lib/esun/order-mapping';
import type { Account } from '../../../lib/types/portfolio';
import { useEsunLimitEstimate } from '../../hooks/use-esun-limit-estimate';
import { availableLimitFor, limitsLookEmpty, useTradingLimits, type TradingLimitsState } from '../../hooks/use-trading-limits';
import { formatTwd } from '../../lib/account-format';
import { ESUN_ESTIMATE_TEXT, esunBreakdownText, esunEstimateFlags, type EsunLimitEstimate } from '../../lib/esun-limit-estimate';
import { navigate } from '../../lib/hash-router';
import * as styles from '../../styles/account.css';

/** 帳戶頁額度卡的錨點 id */
export const TODAY_LIMITS_ID = 'account-today-limits';

export const TODAY_LIMITS_TEXT = {
    title: '今日剩餘交易額度',
    capsTitle: '今日交易額度上限',
    loading: '讀取中…',
    error: '暫時無法取得',
    empty: '非交易時段或模擬環境',
    futures: '期貨／選擇權帳戶沒有每日交易額度，下單以可用保證金為準（見「資金」的期貨區塊）。',
    /** 持倉頁摘要一行的標籤（前面加券商名稱） */
    lineTitle: '今日剩餘額度',
} as const;

type LineAccount = Pick<Account, 'broker_id' | 'account_id' | 'account_type'>;

/** 持倉頁摘要一行的標籤：「永豐 今日剩餘額度」「玉山 今日剩餘額度」 */
export function todayLimitsLineLabel(account: Pick<Account, 'broker_id'>): string {
    return `${isEsunAccount(account) ? '玉山' : '永豐'} ${TODAY_LIMITS_TEXT.lineTitle}`;
}

export type TodayLimitStatus = 'loading' | 'error' | 'empty' | 'ok';

export interface TodayLimitView {
    status: TodayLimitStatus;
    capsOnly: boolean;
    /** 主值（元）：永豐＝現股可用；玉山＝估算剩餘（沒有估算時退回現股額度上限）；status 不是 ok 時為 null */
    primary: number | null;
    /** 已用（元）：只有永豐且有資料時 */
    used: number | null;
    /** 總額度（元）：只有永豐且上限 > 0 時（玉山的上限在估算明細中） */
    total: number | null;
    /** 玉山估算剩餘（status ok 且是玉山時） */
    estimate: EsunLimitEstimate | null;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 由額度狀態算出畫面要顯示的內容（純函式）；玉山帶入 useEsunLimitEstimate 的估算 */
export function todayLimitView(
    state: Pick<TradingLimitsState, 'data' | 'error' | 'loading'>,
    capsOnly: boolean,
    estimate: EsunLimitEstimate | null = null,
): TodayLimitView {
    const none = { capsOnly, primary: null, used: null, total: null, estimate: null };
    const data = state.data;
    if (!data) return { ...none, status: state.error && !state.loading ? 'error' : 'loading' };
    if (limitsLookEmpty(data)) return { ...none, status: 'empty' };
    if (capsOnly) {
        return estimate
            ? { ...none, status: 'ok', primary: estimate.remaining, estimate }
            : { ...none, status: 'ok', primary: finite(data.trading_limit) };
    }
    const total = finite(data.trading_limit);
    return {
        status: 'ok',
        capsOnly,
        primary: availableLimitFor(data, 'Cash'),
        used: finite(data.trading_used),
        total: total !== null && total > 0 ? total : null,
        estimate: null,
    };
}

let pendingFocus = false;

/** 跳到帳戶頁的「今日剩餘交易額度」卡（只導覽，不發任何請求） */
export function openTodayLimits(): void {
    pendingFocus = true;
    navigate({ name: 'account' });
}

/** 帳戶頁額度卡掛載時呼叫：有待處理的跳轉請求回 true（並清除） */
export function consumeTodayLimitsFocus(): boolean {
    const pending = pendingFocus;
    pendingFocus = false;
    return pending;
}

/** 測試用 */
export function resetTodayLimitsFocusForTest(): void {
    pendingFocus = false;
}

/** 額度列出錯（例如查詢在送出前就同步丟出）時只隱藏這一行，不拖垮持倉頁 */
class LineBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? null : this.props.children;
    }
}

export interface TodayLimitsLineProps {
    privMoney: boolean;
    /**
     * 要顯示額度的證券帳戶（持倉頁篩選單一證券帳戶時）；未提供（全部或期貨篩選）時用目前選取的證券帳戶。
     * 傳入非證券帳戶時視同未提供。
     */
    account?: LineAccount | null;
}

/** 持倉頁摘要的一行：證券帳戶的今日剩餘交易額度（玉山為上限）；沒有證券帳戶不顯示 */
export function TodayLimitsLine({ privMoney, account }: TodayLimitsLineProps) {
    return (
        <LineBoundary>
            <LimitsLine privMoney={privMoney} account={account} />
        </LineBoundary>
    );
}

function LimitsLine({ privMoney, account }: TodayLimitsLineProps) {
    const { selectedStock } = useAccounts();
    const stock = account && account.account_type === 'S' ? account : selectedStock;
    const limits = useTradingLimits(stock);
    const estimate = useEsunLimitEstimate(stock, limits.data);
    if (!stock) return null;
    const money = (v: number) => maskMoney(formatTwd(v), privMoney);
    const view = todayLimitView(limits, isEsunAccount(stock), estimate);
    const label = todayLimitsLineLabel(stock);
    const amount = view.status === 'ok'
        ? (view.primary === null ? '—' : money(view.primary))
        : view.status === 'empty' ? '—' : view.status === 'error' ? TODAY_LIMITS_TEXT.error : TODAY_LIMITS_TEXT.loading;
    const value = view.estimate ? `${ESUN_ESTIMATE_TEXT.label} ${amount}` : amount;
    const note = view.status === 'empty' ? TODAY_LIMITS_TEXT.empty : null;
    const sub = view.estimate
        ? [esunBreakdownText(view.estimate, money), ...esunEstimateFlags(view.estimate), ESUN_ESTIMATE_TEXT.short].join('；')
        : null;
    return (
        <button
            type='button'
            className={styles.limitsLine}
            data-testid='position-limits-line'
            data-status={view.status}
            aria-label={`${label} ${value}${note ? `（${note}）` : ''}${sub ? `（${sub}）` : ''}，前往帳戶頁查看交易額度`}
            onClick={openTodayLimits}
        >
            <span className={styles.limitsLineLabel}>{label}</span>
            <span className={styles.limitsLineValue} data-testid='position-limits-value'>
                {value}
                {note && <span className={styles.limitsLineNote}>（{note}）</span>}
            </span>
            {sub && <span className={styles.limitsLineSub} data-testid='position-limits-sub'>{sub}</span>}
        </button>
    );
}
