// src/components/trading-cost-settings.tsx — 設定 → 交易成本（fork 元件）
//
// 上游 settings-dialog 只掛一行渲染。輸入以使用者習慣的單位填寫（折數 6、年利率 %、費率 %），
// 驗證通過才寫入 lib/trading-cost-settings；不合法時保留輸入框內容並提示，不寫入。

import { useState } from 'react';
import {
    DEFAULT_TRADING_COST_SETTINGS,
    discountText,
    percentText,
    resetTradingCostSettings,
    setTradingCostSettings,
    useTradingCostSettings,
    type RebateMode,
    type TradingCostSettings,
} from '../lib/trading-cost-settings';
import * as hud from './hud-header.css';
import * as css from './trading-cost-settings.css';

type Field = 'discount' | 'margin' | 'short';
type Drafts = Record<Field, string>;

const REBATE_OPTIONS: { key: RebateMode; label: string; title: string }[] = [
    { key: 'monthly', label: '月退', title: '交割時以牌告手續費收取，事後退回' },
    { key: 'instant', label: '成交即折', title: '交割時直接以折扣後手續費收取' },
];

function draftsOf(s: TradingCostSettings): Drafts {
    return {
        discount: discountText(s.feeDiscount),
        margin: s.marginAnnualRate === null ? '' : percentText(s.marginAnnualRate),
        short: percentText(s.shortFeeRate),
    };
}

const clean = (n: number) => Number(n.toFixed(8));

/** 輸入框文字 → 要寫入的設定；不合法回錯誤訊息 */
export function parseTradingCostField(field: Field, text: string): { patch: Partial<TradingCostSettings> } | { error: string } {
    const t = text.trim();
    const n = Number(t);
    const numeric = t !== '' && Number.isFinite(n);
    if (field === 'discount') {
        if (!numeric || n <= 0 || n > 10) return { error: '手續費折數需大於 0 且不超過 10（無折扣填 10）' };
        return { patch: { feeDiscount: clean(n / 10) } };
    }
    if (field === 'margin') {
        if (t === '') return { patch: { marginAnnualRate: null } };
        if (!numeric || n < 0 || n > 30) return { error: '融資年利率需介於 0～30%，或留空表示未設定' };
        return { patch: { marginAnnualRate: clean(n / 100) } };
    }
    if (!numeric || n < 0 || n > 1) return { error: '借券費率需介於 0～1%' };
    return { patch: { shortFeeRate: clean(n / 100) } };
}

export function TradingCostSection() {
    const settings = useTradingCostSettings();
    const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(settings));
    const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

    const onInput = (field: Field, text: string) => {
        setDrafts(d => ({ ...d, [field]: text }));
        const parsed = parseTradingCostField(field, text);
        const error = 'error' in parsed ? parsed.error : setTradingCostSettings(parsed.patch) ? undefined : '設定值不合法，未儲存';
        setErrors(e => ({ ...e, [field]: error }));
    };

    const input = (field: Field, label: string, unit: string, placeholder: string, title: string) => (
        <>
            <div className={hud.saveRow}>
                <span className={css.fieldLabel} title={title}>{label}</span>
                <input
                    className={hud.saveInput}
                    inputMode='decimal'
                    aria-label={label}
                    aria-invalid={errors[field] ? true : undefined}
                    value={drafts[field]}
                    placeholder={placeholder}
                    onChange={(e) => onInput(field, e.target.value)}
                />
                <span className={css.unit}>{unit}</span>
            </div>
            {errors[field] && <span className={css.errorText} role='alert'>{errors[field]}</span>}
        </>
    );

    return (
        <>
            <span className={hud.settingLabel}>交易成本 Trading Costs</span>
            {input('discount', '手續費折數', '折', '10', '6 折填 6、2.8 折填 2.8、無折扣填 10')}
            <span className={hud.emptyHint}>6 折填 6、2.8 折填 2.8、無折扣填 10。</span>
            <div className={hud.saveRow}>
                <span className={css.fieldLabel} id='trading-cost-rebate-label'>退佣方式</span>
                <div className={hud.settingGroup} role='group' aria-labelledby='trading-cost-rebate-label'>
                    {REBATE_OPTIONS.map(o => (
                        <button
                            key={o.key}
                            type='button'
                            className={hud.opt[settings.rebateMode === o.key ? 'on' : 'off']}
                            aria-pressed={settings.rebateMode === o.key}
                            title={o.title}
                            onClick={() => setTradingCostSettings({ rebateMode: o.key })}
                        >
                            {o.label}
                        </button>
                    ))}
                </div>
            </div>
            <span className={hud.emptyHint}>
                月退：交割時以牌告手續費收取，事後退回；成交即折：交割時直接以折扣後手續費收取。
                玉山實際交割資料顯示收取牌告手續費，若有折扣多半是事後退佣，建議選月退。
            </span>
            {input('margin', '融資年利率', '%', '未設定', '空白＝未設定，未設定時不估算利息')}
            <span className={hud.emptyHint}>空白＝未設定，未設定時不估算融資利息。</span>
            {input('short', '借券費率', '%', percentText(DEFAULT_TRADING_COST_SETTINGS.shortFeeRate), '融券賣出時收取，預設法定 0.08%')}
            <span className={hud.emptyHint}>融券賣出時收取，預設法定 0.08%。</span>
            <button
                type='button'
                className={hud.menuItem}
                onClick={() => {
                    resetTradingCostSettings();
                    setDrafts(draftsOf(DEFAULT_TRADING_COST_SETTINGS));
                    setErrors({});
                }}
            >
                ↺ 還原預設
            </button>
            <span className={hud.emptyHint}>
                以上設定套用到下單面板成本列與玉山持倉、已實現損益明細，數字皆為估算。鋪單面板另有獨立的手續費設定。
            </span>
        </>
    );
}
