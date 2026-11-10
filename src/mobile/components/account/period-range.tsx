// src/mobile/components/account/period-range.tsx — 帳戶頁查詢區間（今日／本週／本月／近 30 天／自訂）：已實現損益、成交明細共用
//
// - 區間規則在 src/mobile/lib/account-pnl.ts（pnlDateRange、customRangeProblem、customRangeBounds、pnlRangeDays）。
// - 自訂：原生 <input type="date"> 起日／迄日，最多 180 天（含起訖日）；不合法時以 role=status 說明原因、不自動修正日期，
//   呼叫端據 problem 停用「查詢」。起訖存在呼叫端傳入的模組層 slot（本次使用期間保留，不寫 storage），
//   第一次切到自訂帶近 30 天。各卡片有自己的 slot，互不影響。
// - testid 以呼叫端給的前綴組成：`${prefix}-period`、`-custom`、`-begin`、`-end`、`-range-problem`、`-range`。

import { useId, useState } from 'react';
import { customRangeBounds, customRangeProblem, PNL_PERIODS, pnlDateRange, pnlRangeDays, type PnlPeriod } from '../../lib/account-pnl';
import * as styles from '../../styles/account.css';
import { Segmented } from './account-ui';

export type DateRange = { begin: string; end: string };

/** 自訂起訖的模組層存放處；current 為 null＝尚未切到自訂 */
export interface CustomRangeSlot {
    current: DateRange | null;
}

export interface PeriodRange {
    period: PnlPeriod;
    changePeriod: (next: PnlPeriod) => void;
    isCustom: boolean;
    range: DateRange;
    /** 自訂區間不合法的原因；null＝可查詢 */
    problem: string | null;
    setCustom: (next: DateRange) => void;
}

export function usePeriodRange(slot: CustomRangeSlot, now: number): PeriodRange {
    const [period, setPeriod] = useState<PnlPeriod>('today');
    const [custom, setCustomState] = useState<DateRange | null>(slot.current);
    const setCustom = (next: DateRange) => {
        slot.current = next;
        setCustomState(next);
    };
    const changePeriod = (next: PnlPeriod) => {
        // 第一次切到自訂：帶近 30 天（今天 − 29 到今天）
        if (next === 'custom' && !slot.current) setCustom(pnlDateRange('30d', Date.now()));
        setPeriod(next);
    };
    const isCustom = period === 'custom';
    const range: DateRange = isCustom ? (custom ?? pnlDateRange('30d', now)) : pnlDateRange(period, now);
    const problem = isCustom ? customRangeProblem(range.begin, range.end, now) : null;
    return { period, changePeriod, isCustom, range, problem, setCustom };
}

/** 期間膠囊、自訂日期欄與區間說明（或不合法的原因） */
export function PeriodRangeFields({ picker, now, testIdPrefix }: { picker: PeriodRange; now: number; testIdPrefix: string }) {
    const problemId = useId();
    const { period, changePeriod, isCustom, range, problem, setCustom } = picker;
    const bounds = customRangeBounds(range.end, now);
    return (
        <>
            {/* 五個選項放不下等寬分段（360 寬、字級 1.3 時會壓到鄰段）：用換行膠囊 */}
            <Segmented<PnlPeriod> label='區間' value={period} options={PNL_PERIODS} onChange={changePeriod} testId={`${testIdPrefix}-period`} variant='wrap' />
            {isCustom && (
                <div className={styles.dateFields} data-testid={`${testIdPrefix}-custom`}>
                    <label className={styles.dateField}>
                        起日
                        <input
                            type='date'
                            className={styles.dateInput}
                            value={range.begin}
                            min={bounds.beginMin}
                            max={bounds.beginMax}
                            aria-invalid={!!problem}
                            aria-describedby={problem ? problemId : undefined}
                            onChange={e => setCustom({ begin: e.target.value, end: range.end })}
                            data-testid={`${testIdPrefix}-begin`}
                        />
                    </label>
                    <label className={styles.dateField}>
                        迄日
                        <input
                            type='date'
                            className={styles.dateInput}
                            value={range.end}
                            max={bounds.endMax}
                            aria-invalid={!!problem}
                            aria-describedby={problem ? problemId : undefined}
                            onChange={e => setCustom({ begin: range.begin, end: e.target.value })}
                            data-testid={`${testIdPrefix}-end`}
                        />
                    </label>
                </div>
            )}
            {problem ? (
                <p id={problemId} className={styles.warning} role='status' data-testid={`${testIdPrefix}-range-problem`}>{problem}</p>
            ) : (
                <p className={styles.note} data-testid={`${testIdPrefix}-range`}>
                    {range.begin === range.end ? range.end : `${range.begin} ～ ${range.end}`}
                    {isCustom ? `（台北日期，共 ${pnlRangeDays(range.begin, range.end)} 天）` : '（台北日期）'}
                </p>
            )}
        </>
    );
}
