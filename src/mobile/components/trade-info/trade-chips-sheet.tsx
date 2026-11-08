// src/mobile/components/trade-info/trade-chips-sheet.tsx — 「籌碼與當沖」說明面板（唯讀；延遲載入，見 load-trade-chips-sheet）
//
// 內容（只有股票顯示信用相關區塊）：
// - 融資融券：融資／融券成數、單位，可否融資／融券（停資、停券原因：成數或單位為 0；lib/credit-eligibility creditStatus）。
// - 券源與資券餘額：short_stock_sources 的可借券源、合約的融資餘額與融券餘額。
// - 處置：mobile/lib/regulatory-punish 的名單（由交易頁傳入）。
// - 當沖：合約 day_trade、現股當沖規則與證交稅（mobile/lib/day-trade-tax）；期權、指數各自的說明。
// - 資訊列各膠囊的定義。
// 交易安全 S1：面板內沒有任何下單入口（沒有按鈕會呼叫 openTicket／openOrderAction 或 lib 送單函式），只有關閉。
// 請求：融資融券與券源只在面板開啟且是股票時讀，每檔每交易日各最多 1 次（mobile/lib/trade-chips）；
// 失敗時顯示［重新查詢］，按下才重讀失敗的那一項（不自動重試）；按下後焦點移到「融資融券」標題（按鍵會消失）。
// 融資融券與券源顯示資料時間（每檔每天只讀一次，早上的數字整天沿用）；下單時券商端會重新查詢，以下單當下為準。

import { useRef, type RefObject } from 'react';
import { creditStatus, type CreditCond, type CreditEnquire } from '../../../lib/credit-eligibility';
import type { ContractInfo } from '../../../lib/types/contract';
import {
    DAY_TRADE_HALF_TAX_LAST_DAY,
    dayTradeHalfTaxActive,
    dayTradeSellTaxRate,
    isGeneralStock,
} from '../../lib/day-trade-tax';
import { fmtInt } from '../../lib/num-format';
import { LIMIT_TEXT, NEAR_LIMIT_PCT, showsCredit } from '../../lib/trade-info';
import { retryTradeChips, useTradeChips, type ChipEntry, type ShortSource } from '../../lib/trade-chips';
import * as controls from '../../styles/controls.css';
import { focusRing } from '../../styles/primitives.css';
import * as styles from '../../styles/trade-info.css';
import { BottomSheet } from '../bottom-sheet';

export interface TradeChipsSheetProps {
    open: boolean;
    onClose: () => void;
    contract: ContractInfo;
    /** 是否在處置名單（非股票、尚未取得為 null） */
    punished: boolean | null;
}

type Tone = 'warn' | 'danger' | undefined;

function Item({ label, value, tone, testId }: { label: string; value: string; tone?: Tone; testId?: string }) {
    return (
        <div className={styles.item}>
            <dt className={styles.label}>{label}</dt>
            <dd className={`${styles.value}${tone ? ` ${styles.valueTone[tone]}` : ''}`} data-testid={testId}>{value}</dd>
        </div>
    );
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 讀取狀態的共用文字（成功時回傳 null，由呼叫端顯示值） */
function entryText(e: ChipEntry<unknown>): string | null {
    if (e.status === 'idle' || e.status === 'loading') return '查詢中…';
    if (e.status === 'failed') return '查詢失敗';
    return e.value === undefined ? '無資料' : null;
}

/** 可否融資／融券與原因（成數或單位為 0 → 停資／停券；其他無法確認時由券商端判斷） */
export function creditAbilityText(row: CreditEnquire | undefined, cond: CreditCond): { text: string; tone: Tone } {
    const status = creditStatus(row, cond);
    const margin = cond === 'MarginTrading';
    if (status === 'ok') return { text: margin ? '可融資' : '可融券', tone: undefined };
    if (status === 'unknown') return { text: '無法確認（由券商端判斷）', tone: 'warn' };
    const ratio = num(margin ? row?.margin_loan_ratio : row?.short_margin_ratio);
    const reasons = [
        ratio === 0 ? `${margin ? '融資' : '融券'}成數為 0` : null,
        num(margin ? row?.margin_unit : row?.short_unit) === 0 ? `${margin ? '融資' : '融券'}單位為 0` : null,
    ].filter(Boolean).join('、');
    return { text: `${margin ? '停資' : '停券'}（${reasons}）`, tone: 'warn' };
}

/** 'YYYY-MM-DD HH:MM:SS' → 'MM/DD HH:MM'；無法辨識時原樣，沒有時 null */
export function dataTimeText(v: unknown): string | null {
    if (typeof v !== 'string' || !v.trim()) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(v.trim());
    return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : v.trim();
}

const ratioText = (v: unknown) => (num(v) === null ? '—' : `${num(v)}%`);
const unitText = (v: unknown) => (num(v) === null ? '—' : fmtInt(num(v)!));
const ratePct = (rate: number) => `${Number((rate * 100).toFixed(3))}%`;

function CreditSection({ credit, headingRef }: { credit: ChipEntry<CreditEnquire>; headingRef: RefObject<HTMLHeadingElement | null> }) {
    const pending = entryText(credit);
    const row = credit.status === 'ok' ? credit.value : undefined;
    const margin = creditAbilityText(row, 'MarginTrading');
    const short = creditAbilityText(row, 'ShortSelling');
    const time = dataTimeText((row as { update_time?: unknown } | undefined)?.update_time);
    return (
        <>
            <h3 className={styles.sectionTitle} ref={headingRef} tabIndex={-1} data-testid='trade-chips-credit-title'>融資融券</h3>
            {pending !== null
                ? <p className={styles.status} role='status' data-testid='trade-chips-credit-status'>融資融券：{pending}</p>
                : (
                    <dl className={styles.grid} data-testid='trade-chips-credit'>
                        <Item label='可否融資' value={margin.text} tone={margin.tone} testId='trade-chips-margin' />
                        <Item label='可否融券' value={short.text} tone={short.tone} testId='trade-chips-short' />
                        <Item label='融資成數' value={ratioText(row?.margin_loan_ratio)} testId='trade-chips-margin-ratio' />
                        <Item label='融券成數' value={ratioText(row?.short_margin_ratio)} testId='trade-chips-short-ratio' />
                        <Item label='融資單位' value={unitText(row?.margin_unit)} />
                        <Item label='融券單位' value={unitText(row?.short_unit)} />
                    </dl>
                )}
            {pending === null && (
                <p className={styles.note} data-testid='trade-chips-credit-time'>
                    {time ? `資料時間 ${time}；` : ''}下單時券商會重新查詢，以下單當下為準。
                </p>
            )}
        </>
    );
}

function SourceSection({ short, contract }: { short: ChipEntry<ShortSource>; contract: ContractInfo }) {
    const pending = entryText(short);
    const src = short.status === 'ok' ? short.value : undefined;
    return (
        <>
            <h3 className={styles.sectionTitle}>券源與資券餘額</h3>
            <dl className={styles.grid}>
                <Item
                    label='可借券源'
                    value={pending ?? (num(src?.short_stock_source) === null ? '—' : fmtInt(src!.short_stock_source))}
                    testId='trade-chips-source'
                />
                <Item label='融資餘額' value={unitText(contract.margin_trading_balance)} testId='trade-chips-margin-balance' />
                <Item label='融券餘額' value={unitText(contract.short_selling_balance)} testId='trade-chips-short-balance' />
            </dl>
            <p className={styles.note} data-testid='trade-chips-source-note'>
                券源為券商可借券數量（借券賣出用）{src && dataTimeText(src.datetime) ? `，資料時間 ${dataTimeText(src.datetime)}` : ''}；資券餘額取自合約資料。
            </p>
        </>
    );
}

function punishText(punished: boolean | null): { text: string; tone: Tone } {
    if (punished === true) return { text: '處置股：列在主管機關處置名單，撮合方式與預收款券可能受限，下單前請確認公告', tone: 'danger' };
    if (punished === false) return { text: '未列在處置名單（名單約每 30 分鐘更新）', tone: undefined };
    return { text: '處置名單尚未取得', tone: undefined };
}

const DAY_TRADE_STATUS: Record<string, { text: string; tone: Tone }> = {
    Yes: { text: '可現股當沖：可先買後賣，也可先賣後買', tone: undefined },
    OnlyBuy: { text: '僅可先買後賣：不能現股當沖先賣', tone: 'warn' },
    No: { text: '不可現股當沖', tone: 'warn' },
};

function StockDayTrade({ contract }: { contract: ContractInfo }) {
    const status = DAY_TRADE_STATUS[contract.day_trade] ?? { text: '未提供當沖資格', tone: 'warn' as const };
    const now = Date.now();
    const rate = dayTradeSellTaxRate(contract, now);
    const tax = isGeneralStock(contract) && dayTradeHalfTaxActive(now)
        ? `現股當沖賣出證交稅 ${ratePct(rate)}（一般股票減半，適用至 ${DAY_TRADE_HALF_TAX_LAST_DAY}）`
        : `此商品現股當沖賣出證交稅 ${ratePct(rate)}（ETF、權證等本來稅率較低，不再減半）`;
    return (
        <>
            <dl className={styles.grid}>
                <Item label='當沖資格' value={status.text} tone={status.tone} testId='trade-chips-daytrade' />
            </dl>
            <ul className={styles.rules} data-testid='trade-chips-rules'>
                <li>現股當沖：同一帳戶當日買進與賣出同一檔股票，相同數量的部分以價差交割；須先簽署當沖相關契約並經券商開通。</li>
                <li>先賣後買（現股當沖先賣）須在當日買回相同數量；未買回時須以借券或標借交割，可能產生額外費用與違約風險。</li>
                <li>{tax}。</li>
                <li>資券當沖（融資買進＋融券賣出）不是現股當沖：需可融資、可融券，證交稅不減半。</li>
            </ul>
        </>
    );
}

export function TradeChipsSheet({ open, onClose, contract, punished }: TradeChipsSheetProps) {
    const st = contract.security_type;
    const stock = showsCredit(st);
    const chips = useTradeChips(contract, open && stock);
    const punish = punishText(punished);
    const creditHeadingRef = useRef<HTMLHeadingElement | null>(null);
    return (
        <BottomSheet open={open} onClose={onClose} title='籌碼與當沖' testId='trade-chips-sheet' detent='large'>
            <div className={styles.sheetBody}>
                <p className={styles.note}>{`${contract.code} ${contract.name}`}・只供查看，下單請用頁面底部的買進、賣出。</p>
                {stock && (
                    <>
                        <CreditSection credit={chips.credit} headingRef={creditHeadingRef} />
                        <SourceSection short={chips.short} contract={contract} />
                        {(chips.credit.status === 'failed' || chips.short.status === 'failed') && (
                            <button
                                type='button'
                                className={`${controls.button.neutral} ${focusRing}`}
                                onClick={() => {
                                    retryTradeChips(contract);
                                    // 按鍵會隨重新查詢消失：焦點移到「融資融券」標題，不掉到面板外
                                    creditHeadingRef.current?.focus();
                                }}
                                data-testid='trade-chips-retry'
                            >
                                重新查詢融資融券與券源
                            </button>
                        )}
                        <h3 className={styles.sectionTitle}>處置</h3>
                        <dl className={styles.grid}>
                            <Item label='處置狀態' value={punish.text} tone={punish.tone} testId='trade-chips-punish' />
                        </dl>
                    </>
                )}
                <h3 className={styles.sectionTitle}>當沖規則</h3>
                {stock && <StockDayTrade contract={contract} />}
                {(st === 'FUT' || st === 'OPT') && (
                    <ul className={styles.rules} data-testid='trade-chips-rules'>
                        <li>期貨、選擇權可當日沖銷，沒有現股當沖的資格限制。</li>
                        <li>當沖保證金、夜盤與日盤是否算同一交易日等規定，以期貨商為準。</li>
                    </ul>
                )}
                {st === 'WRT' && (
                    <ul className={styles.rules} data-testid='trade-chips-rules'>
                        <li>權證可否當沖與信用交易，以券商與交易所規定為準。</li>
                    </ul>
                )}
                {st === 'IND' && <p className={styles.note} data-testid='trade-chips-rules'>指數只供參考，不能交易，沒有漲跌停與當沖規則。</p>}
                <h3 className={styles.sectionTitle}>資訊列怎麼看</h3>
                <ul className={styles.rules}>
                    <li>{`${LIMIT_TEXT.lockedUp}／${LIMIT_TEXT.lockedDown}：價位在停板，且另一側委託已空（例如漲停時委賣已空）。${LIMIT_TEXT.openUp}：在漲停成交但委賣仍有掛單。`}</li>
                    <li>{`${LIMIT_TEXT.nearUp}／${LIMIT_TEXT.nearDown}：距停板 ${NEAR_LIMIT_PCT}% 以內（以參考價計）。`}</li>
                    <li>振幅＝（今日最高 − 最低）÷ 參考價。小條：有漲跌停的股票與期貨以參考價為中心（中間刻線），其他商品整條是今日最低到最高；粗刻線是現價。</li>
                    {stock && <li>量比＝今日累計成交量 ÷ 前一交易日全日成交量；1.00 代表已達前一交易日全日量。</li>}
                </ul>
            </div>
        </BottomSheet>
    );
}
