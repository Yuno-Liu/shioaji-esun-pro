// src/mobile/components/account/trading-cost-section.tsx — 帳戶頁「交易成本」設定區塊（規格 §6.7）
//
// 對外介面固定：無 props 的 TradingCostSection（由 routes/account-page.tsx 掛載）。
// - 手續費折數與退佣方式：永豐、玉山各一組（使用者決定分開；只在手機版，存 mobile/lib/broker-cost-settings 的
//   'sj-mobile-broker-cost-v1'；某券商未設定時沿用共用設定）。桌面版仍使用共用設定，兩者互不覆寫。
// - 融資年利率、借券費率：沿用共用設定 src/lib/trading-cost-settings.ts（useTradingCostSettings／setTradingCostSettings），與桌面共用。
// - 驗證沿用桌面 src/components/trading-cost-settings.tsx 匯出的純函式 parseTradingCostField，範圍與桌面相同：
//   手續費折數 0<n≤10（6 折填 6）、融資年利率 0～30%（空白＝未設定）、借券費率 0～1%。
// - 每次輸入即驗證：合法才寫入；不合法保留草稿並顯示錯誤，不寫入（與桌面一致）。
// - 「還原預設」同時還原共用設定並清掉兩家券商的覆寫。
// - 輸入欄 inputmode=decimal、字級 ≥16px（account.css numberInput 用 INPUT_FONT_SIZE）。
// - 設定存在本裝置瀏覽器的 localStorage，不會同步到其他裝置。

import { useId, useState } from 'react';
import { parseTradingCostField } from '../../../components/trading-cost-settings';
import {
    DEFAULT_TRADING_COST_SETTINGS,
    discountText,
    percentText,
    resetTradingCostSettings,
    setTradingCostSettings,
    useTradingCostSettings,
    type RebateMode,
    type TradingCostSettings,
} from '../../../lib/trading-cost-settings';
import {
    COST_BROKER_TEXT,
    COST_BROKERS,
    resetBrokerCostSettings,
    setBrokerFeeSettings,
    useBrokerCostSettings,
    type CostBroker,
} from '../../lib/broker-cost-settings';
import * as styles from '../../styles/account.css';
import * as css from '../../styles/device-settings.css';
import { Card, Segmented } from './account-ui';

type Field = 'discount-sinopac' | 'discount-esun' | 'margin' | 'short';
type Drafts = Record<Field, string>;

const REBATE_OPTIONS: readonly { value: RebateMode; text: string }[] = [
    { value: 'monthly', text: '月退' },
    { value: 'instant', text: '成交即折' },
];

const discountField = (b: CostBroker): Field => `discount-${b}`;

function draftsOf(shared: TradingCostSettings, costs: Record<CostBroker, TradingCostSettings>): Drafts {
    return {
        'discount-sinopac': discountText(costs.sinopac.feeDiscount),
        'discount-esun': discountText(costs.esun.feeDiscount),
        margin: shared.marginAnnualRate === null ? '' : percentText(shared.marginAnnualRate),
        short: percentText(shared.shortFeeRate),
    };
}

export function TradingCostSection() {
    const settings = useTradingCostSettings();
    const costs = useBrokerCostSettings();
    const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(settings, costs));
    const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
    const idBase = useId();

    const onInput = (field: Field, text: string) => {
        setDrafts(d => ({ ...d, [field]: text }));
        let error: string | undefined;
        if (field === 'margin' || field === 'short') {
            const parsed = parseTradingCostField(field, text);
            error = 'error' in parsed ? parsed.error : setTradingCostSettings(parsed.patch) ? undefined : '設定值不合法，未儲存';
        } else {
            const broker: CostBroker = field === 'discount-esun' ? 'esun' : 'sinopac';
            const parsed = parseTradingCostField('discount', text);
            error = 'error' in parsed
                ? parsed.error
                : parsed.patch.feeDiscount !== undefined && setBrokerFeeSettings(broker, { feeDiscount: parsed.patch.feeDiscount }) ? undefined : '設定值不合法，未儲存';
        }
        setErrors(e => ({ ...e, [field]: error }));
    };

    const field = (key: Field, label: string, unit: string, placeholder: string, hint: string) => {
        const inputId = `${idBase}-${key}`;
        const hintId = `${inputId}-hint`;
        const errorId = `${inputId}-error`;
        const error = errors[key];
        return (
            <div className={styles.settingBlock}>
                <div className={css.fieldRow}>
                    <label className={css.fieldLabel} htmlFor={inputId}>{label}</label>
                    <input
                        id={inputId}
                        className={styles.numberInput}
                        type='text'
                        inputMode='decimal'
                        autoComplete='off'
                        enterKeyHint='done'
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                        value={drafts[key]}
                        placeholder={placeholder}
                        onChange={(e) => onInput(key, e.target.value)}
                        data-testid={`trading-cost-${key}`}
                    />
                    <span className={css.unit}>{unit}</span>
                </div>
                <span className={styles.settingHint} id={hintId}>{hint}</span>
                {error && <p className={css.fieldError} id={errorId} role='alert' data-testid={`trading-cost-${key}-error`}>{error}</p>}
            </div>
        );
    };

    return (
        <Card title='交易成本' testId='account-trading-cost'>
            {COST_BROKERS.map(b => (
                <div key={b} role='group' aria-label={`${COST_BROKER_TEXT[b]}手續費`} data-testid={`trading-cost-broker-${b}`}>
                    <h4 className={styles.subTitle}>{COST_BROKER_TEXT[b]}</h4>
                    {field(discountField(b), `${COST_BROKER_TEXT[b]}手續費折數`, '折', '10', '6 折填 6、2.8 折填 2.8、無折扣填 10。')}
                    <div className={styles.settingBlock}>
                        <span className={css.fieldLabel} aria-hidden='true'>{COST_BROKER_TEXT[b]}退佣方式</span>
                        <Segmented
                            label={`${COST_BROKER_TEXT[b]}退佣方式`}
                            value={costs[b].rebateMode}
                            options={REBATE_OPTIONS}
                            onChange={(v) => setBrokerFeeSettings(b, { rebateMode: v })}
                            testId={`trading-cost-rebate-${b}`}
                        />
                    </div>
                </div>
            ))}
            <p className={styles.settingHint}>
                月退：交割時以牌告手續費收取，事後退回；成交即折：交割時直接以折扣後手續費收取。
                玉山實際交割資料顯示收取牌告手續費，若有折扣多半是事後退佣，建議選月退。
            </p>
            <p className={styles.note} data-testid='trading-cost-broker-note'>折數與退佣方式依券商分開，只套用在手機版；桌面版仍使用共用設定。</p>
            <h4 className={styles.subTitle}>兩家共用</h4>
            {field('margin', '融資年利率', '%', '未設定', '空白＝未設定，未設定時不估算融資利息。')}
            {field('short', '借券費率', '%', percentText(DEFAULT_TRADING_COST_SETTINGS.shortFeeRate), '融券賣出時收取，預設法定 0.08%。')}
            <div className={styles.actions}>
                <button
                    type='button'
                    className={styles.smallButton}
                    onClick={() => {
                        resetTradingCostSettings();
                        resetBrokerCostSettings();
                        const d = { ...DEFAULT_TRADING_COST_SETTINGS };
                        setDrafts(draftsOf(d, { sinopac: d, esun: d }));
                        setErrors({});
                    }}
                    data-testid='trading-cost-reset'
                >
                    還原預設
                </button>
            </div>
            <p className={styles.note}>以上設定套用到下單面板的成本估算與持倉、已實現損益明細（含預估退佣），數字皆為估算。</p>
            <p className={styles.deviceOnly} data-testid='trading-cost-device-only'>此設定只存在本裝置（本瀏覽器），不會同步到其他裝置。</p>
        </Card>
    );
}
