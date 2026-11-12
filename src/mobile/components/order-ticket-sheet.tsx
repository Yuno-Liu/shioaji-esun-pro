// src/mobile/components/order-ticket-sheet.tsx — 下單底部面板（規格 §6.3、§7.1、§7.2；設計規格 mobile-design.md §7.4）
//
// 介面：無 props、掛在 App 根層；開啟狀態與帶入的方向／價格／單位／信用條件來自 mobile-store 的 `ticket`
// （openTicket()／closeTicket()；ticket.seq 遞增代表新的開啟 → 以 key 重新初始化所有欄位）。
//
// 版面（BottomSheet detent=large；body 捲動、footer 固定）：
//   第一列：RouteBadge、帳戶（ticket-account）、鎖說明鍵（切換一行說明）、可當沖標籤
//   → 精簡報價（中性島）→ 方向鍵 DirectionToggle → [整股｜零股]＋條件摘要（同列，點開三組分段）
//   → 價格標籤列（即時價＋價別 PopUpButton）＋Stepper → 快捷價 6 欄 → 數量標籤列＋Stepper → 數量 4 欄
//   → 資訊（中性島）→ 提示（InlineNote）→ 內嵌五檔（中性島）；
//   footer（SheetFooter）：狀態行（回饋 → 第一個停用原因 → 摘要）＋CTA（文字恰為 previewText）。
// 期貨／選擇權沒有單位與信用，倉別與效期直接以分段顯示。
//
// 安全（設計規格 §10）：
// - 送出只有一條路：CTA → t.submit() → submitMobileOrder()（強制確認面板滑動）；快捷價、五檔點價只帶價格。
// - 送出中：所有控制停用、面板不可關閉（避免結果未知時面板消失）；結果未知不提供重送。
// - 方向四重呈現：面板著色（BottomSheet tone）、3px 方向色條、選中鍵實心＋Check、CTA 完整動作文字；
//   ticket-direction 為視覺隱藏的 aria-live 宣告。買賣顏色只用 vars.color.up／down。
// - 限價偏離提醒只提醒、不阻擋、不改價。

import { CircleX, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { ODD_LOT_MAX_SHARES, ODD_LOT_WAITING, orderQtyUnit, SHARES_PER_LOT } from '../../lib/odd-lot';
import { FUTURES_OCTYPES, ORDER_TYPES, orderTypeDisabledReason, PRICE_TYPE_LABEL, priceTypeDisabledReason, priceTypesFor } from '../../lib/order-conditions';
import { maskMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { manualStockCreditHint } from '../../lib/stock-exit-cond';
import { useTradingState } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { FuturesOCType, FuturesPriceType, OrderType } from '../../lib/types/order';
import {
    COMMON_LOT_INPUT_MAX,
    ODD_QTY_PRESETS,
    PRICE_SOURCE_LABEL,
    QTY_PRESETS,
    isOnTick,
    parsePrice,
    positivePrice,
    TICKET_TEXT,
    useMobileTicket,
    type PriceSource,
    type TicketFields,
} from '../hooks/use-mobile-ticket';
import { closeTicket, useMobileUi, type TicketRequest } from '../lib/mobile-store';
import { formatNumber, formatToTick } from '../lib/num-format';
import * as layout from '../styles/layout.css';
import * as styles from '../styles/order-ticket.css';
import { fill, focusRing, pressable, srOnly } from '../styles/primitives.css';
import { DirectionToggle } from '../ui/direction-toggle';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { PopUpButton } from '../ui/pop-up-button';
import { QuickChips } from '../ui/quick-chips';
import { Segmented } from '../ui/segmented';
import { Stepper } from '../ui/stepper';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet, SheetFooter } from './bottom-sheet';
import { DepthLadder } from './depth-ladder';
import { RouteBadge } from './route-badge';
import { TicketStockConditions } from './ticket/ticket-conditions';
import { TicketInfo } from './ticket/ticket-info';
import { TicketQuoteRow } from './ticket/ticket-quote-row';

export type TicketTone = 'buy' | 'sell' | null;

/** contract.day_trade 的標籤（'Yes'＝買賣現沖、'OnlyBuy'＝僅先買後賣） */
export function dayTradeTag(dayTrade: ContractInfo['day_trade'] | undefined): string | null {
    if (dayTrade === 'Yes') return '可當沖（買賣現沖）';
    if (dayTrade === 'OnlyBuy') return '僅可先買後賣';
    return null;
}

/** 鎖說明（取代常駐兩行）：面板開啟期間帳戶固定 */
export const ACCOUNT_LOCK_NOTE = '面板開啟期間不能切換帳戶；要換帳戶請關閉面板後到「帳戶」頁。';

/** 限價偏離提醒門檻：|限價 − 成交| ÷ 成交 超過此比例才提醒（股票 3%、期權 1.5%；只提醒、不阻擋） */
export const PRICE_DEVIATION_WARN = Object.freeze({ stock: 0.03, derivative: 0.015 });

/**
 * 限價偏離提醒文字（「偏離成交價 +4.2%」）：只在限價、最新價來源為真實成交、偏離超過門檻時回傳；否則 null。
 * 試撮、快照、參考價、零股委買賣都不是真實成交，不比較。
 */
export function priceDeviationText(input: {
    priceType: FuturesPriceType;
    price: number;
    last: number | null;
    lastSource: PriceSource | null;
    isFutures: boolean;
}): string | null {
    const { priceType, price, last, lastSource, isFutures } = input;
    if (priceType !== 'LMT' || lastSource !== 'trade') return null;
    if (!(price > 0) || last === null || !(last > 0)) return null;
    const ratio = (price - last) / last;
    const limit = isFutures ? PRICE_DEVIATION_WARN.derivative : PRICE_DEVIATION_WARN.stock;
    if (!(Math.abs(ratio) > limit)) return null;
    const pct = (ratio * 100).toFixed(1);
    return `偏離成交價 ${ratio > 0 ? '+' : ''}${pct}%`;
}

// 手機快取版格式器（num-format）：與 toLocaleString 輸出逐字相同，不每次重建 Intl 格式器
const fmtNumber = (v: number) => formatNumber(v, 'en-US', { maximumFractionDigits: 4 });
const fmtAmount = (v: number) => formatNumber(Math.round(v), 'en-US');

/**
 * footer 摘要：「限價 1,085 × 1 張 ≈ 1,085,000 元」；期權「… ≈ 名目 … 元」；沒有估值時只到數量。
 * 金額經 maskMoney（遮蔽金額模式）。
 */
export function ticketSummaryText(
    fields: Pick<TicketFields, 'priceType' | 'priceText' | 'quantity' | 'orderLot'>,
    isFutures: boolean,
    estimate: { value: number | null },
    privMoney: boolean,
): string {
    const unit = orderQtyUnit(isFutures, isFutures ? undefined : fields.orderLot);
    const p = parsePrice(fields.priceText);
    const price = fields.priceType === 'LMT' ? `限價 ${p > 0 ? fmtNumber(p) : '—'}` : PRICE_TYPE_LABEL[fields.priceType];
    const qty = Number.isSafeInteger(fields.quantity) && fields.quantity > 0 ? fmtNumber(fields.quantity) : '—';
    const head = `${price} × ${qty} ${unit}`;
    if (estimate.value === null) return head;
    return `${head} ≈ ${isFutures ? '名目 ' : ''}${maskMoney(fmtAmount(estimate.value), privMoney)} 元`;
}

/** 按 CTA 前先讓聚焦中的輸入欄位失焦（收起鍵盤、觸發欄位的 onBlur 驗證）；按鈕本身不動 */
export function blurFocusedField(): void {
    try {
        const doc = typeof document === 'undefined' ? null : document;
        const el = doc?.activeElement as (Element & { blur?: () => void; tagName?: string }) | null | undefined;
        if (!el || typeof el.blur !== 'function') return;
        const tag = String(el.tagName ?? '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') el.blur();
    } catch {
        // 失焦失敗只少一個鍵盤收起，不影響送出流程
    }
}

export function OrderTicketSheet() {
    const { ticket } = useMobileUi();
    const code = ticket?.code ?? null;
    const contract = useContract(code);
    const [busy, setBusy] = useState(false);
    const [tone, setTone] = useState<TicketTone>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        setLoadFailed(false);
        if (!code) return;
        let alive = true;
        ensureContract(code).catch(() => { if (alive) setLoadFailed(true); });
        return () => { alive = false; };
    }, [code]);

    useEffect(() => {
        if (!ticket) {
            setBusy(false);
            setTone(null);
        }
    }, [ticket]);

    const title = contract && ticket ? `${contract.code} ${contract.name}` : ticket ? `下單 ${ticket.code}` : '下單';
    return (
        <BottomSheet
            open={ticket !== null}
            onClose={closeTicket}
            dismissible={!busy}
            title={title}
            testId='order-ticket-sheet'
            tone={ticket && contract ? tone : null}
            detent='large'
        >
            {ticket && contract && <TicketForm key={ticket.seq} ticket={ticket} contract={contract} onBusyChange={setBusy} onToneChange={setTone} />}
            {ticket && !contract && (
                <p className={layout.placeholder}>{loadFailed ? '商品資料載入失敗，請關閉後再試。' : '商品資料載入中…'}</p>
            )}
        </BottomSheet>
    );
}

interface TicketFormProps {
    ticket: TicketRequest;
    contract: ContractInfo;
    onBusyChange: (busy: boolean) => void;
    onToneChange: (tone: TicketTone) => void;
}

function TicketForm({ ticket, contract, onBusyChange, onToneChange }: TicketFormProps) {
    const t = useMobileTicket(ticket, contract);
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const trading = useTradingState();
    const [priceBlurred, setPriceBlurred] = useState(false);
    const [lockNoteOpen, setLockNoteOpen] = useState(false);
    const [flashKey, setFlashKey] = useState(0);
    const { fields, isFutures, odd, busy } = t;
    const tone: TicketTone = fields.action === 'Buy' ? 'buy' : fields.action === 'Sell' ? 'sell' : null;

    useEffect(() => {
        onBusyChange(busy);
    }, [busy, onBusyChange]);
    useEffect(() => () => onBusyChange(false), [onBusyChange]);
    useEffect(() => {
        onToneChange(tone);
    }, [tone, onToneChange]);

    const unit = orderQtyUnit(isFutures, isFutures ? undefined : fields.orderLot);
    const market = fields.priceType !== 'LMT';
    const priceNum = parsePrice(fields.priceText);
    const tickWarn = !market && priceBlurred && priceNum > 0 && !isOnTick(contract, priceNum);
    const reference = positivePrice(contract.reference);
    const limitUp = positivePrice(contract.limit_up);
    const limitDown = positivePrice(contract.limit_down);
    const last = t.quote.last;
    const lastDir = last === null || reference === null ? 'flat' : last > reference ? 'up' : last < reference ? 'down' : 'flat';
    const lastSign = lastDir === 'up' ? '▲' : lastDir === 'down' ? '▼' : '';
    // 盤中零股：「成交」只用零股行情（#204）；沒有零股成交時用零股委買賣（標示「零股價」），都沒有就停用並顯示等待零股行情
    const oddWaiting = t.intradayOdd && last === null;
    const lastSource = t.quote.lastSource;
    const liveLabel = lastSource === 'oddQuote'
        ? PRICE_SOURCE_LABEL.oddQuote
        : `${t.intradayOdd ? '零股' : ''}${lastSource === 'snapshot' ? PRICE_SOURCE_LABEL.snapshot : PRICE_SOURCE_LABEL.trade}`;
    const quick: { label: string; price: number | null; note?: string }[] = [
        { label: '買一', price: t.quote.bid1 },
        { label: '賣一', price: t.quote.ask1 },
        { label: lastSource === 'oddQuote' ? '零股價' : '成交', price: last, note: oddWaiting ? ODD_LOT_WAITING : undefined },
        { label: '漲停', price: limitUp },
        { label: '跌停', price: limitDown },
        { label: '平盤', price: reference },
    ];
    const presets = odd ? ODD_QTY_PRESETS : QTY_PRESETS;
    const qtyMax = isFutures ? Number.MAX_SAFE_INTEGER : odd ? ODD_LOT_MAX_SHARES : COMMON_LOT_INPUT_MAX;
    const account = t.account;
    const tag = isFutures ? null : dayTradeTag(contract.day_trade);
    const deviation = priceDeviationText({ priceType: fields.priceType, price: priceNum, last, lastSource, isFutures });

    // 信用提醒（比照桌面 creditHintFor）：只提示，使用者按了才改條件；持倉尚未載入時只顯示有建議的提醒
    const rawHint = !isFutures && fields.orderLot === 'Common' && fields.action
        ? manualStockCreditHint(trading.positions, account, contract.code, fields.action, fields.orderCond)
        : null;
    const creditHint = rawHint && (rawHint.suggest !== null || trading.queries.positions.updatedAt !== null) ? rawHint : null;

    /** 帶入價格（快捷價、五檔）：沿用 t.pickPrice（改限價並視為已確認），外框閃一下 */
    const pick = (price: number | null) => {
        if (busy || price === null || !(price > 0)) return;
        t.pickPrice(price);
        setFlashKey(k => k + 1);
    };

    const accountText = account
        ? `${isEsunAccount(account) ? '玉山' : '永豐'} ${mobileAccountLabel(account, priv)}（${isFutures ? '期貨／選擇權' : '證券'}）`
        : isFutures ? '沒有可用的期貨帳戶' : '沒有可用的證券帳戶';
    const qtyNote = isFutures ? null : odd ? `以股計（1～${ODD_LOT_MAX_SHARES} 股）` : `1 張＝${formatNumber(SHARES_PER_LOT, 'en-US')} 股`;

    return (
        <div className={styles.form} data-testid='order-ticket-form'>
            {/* 方向宣告（視覺隱藏）：方向已由面板著色、方向鍵與 CTA 呈現 */}
            <p className={srOnly} data-testid='ticket-direction' aria-live='polite'>
                {fields.action ? t.actionText : '請選擇買進或賣出'}
            </p>

            <div className={styles.metaRow}>
                <RouteBadge account={account} />
                {account && <span className={styles.account} data-testid='ticket-account'>{accountText}</span>}
                {account && (
                    <IconButton
                        icon={Lock}
                        iconSize={18}
                        ariaLabel='帳戶已固定，說明'
                        pressed={lockNoteOpen}
                        className={styles.lockButton}
                        testId='ticket-account-lock'
                        onClick={() => setLockNoteOpen(v => !v)}
                    />
                )}
                {tag && <span className={styles.tag} data-testid='ticket-daytrade-tag'>{tag}</span>}
            </div>
            {!account && <InlineNote tone='warn' testId='ticket-account'>{accountText}</InlineNote>}
            {account && lockNoteOpen && <InlineNote tone='info' testId='ticket-account-note'>{ACCOUNT_LOCK_NOTE}</InlineNote>}
            {isFutures && account && isEsunAccount(account) && <InlineNote tone='warn'>{TICKET_TEXT.esunFutures}</InlineNote>}

            <TicketQuoteRow contract={contract} snapshot={t.snapshot} />

            <DirectionToggle value={fields.action} disabled={busy} onChange={v => t.setAction(v)} />

            {!isFutures && <TicketStockConditions t={t} contract={contract} />}

            {isFutures && (
                <>
                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>倉別</span>
                        <Segmented<FuturesOCType>
                            semantics='toggle'
                            size='compact'
                            ariaLabel='倉別'
                            items={FUTURES_OCTYPES.map(({ value, label }) => ({ value, label }))}
                            value={fields.octype}
                            disabled={busy}
                            onChange={v => t.setOctype(v)}
                        />
                    </div>
                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>效期</span>
                        <Segmented<OrderType>
                            semantics='toggle'
                            size='compact'
                            ariaLabel='效期'
                            items={ORDER_TYPES.map(ot => ({ value: ot, label: ot, disabled: !!orderTypeDisabledReason(ot, false) }))}
                            value={fields.orderType}
                            disabled={busy}
                            onChange={ot => t.setOrderType(ot)}
                        />
                    </div>
                </>
            )}

            <div className={styles.fieldBlock}>
                <div className={styles.labelRow}>
                    <span className={styles.labelGroup}>
                        <span className={styles.fieldLabel}>價格</span>
                        <span className={styles.livePrice} data-testid='ticket-live-price'>
                            {liveLabel}{' '}
                            {last === null
                                ? (oddWaiting ? `— ${ODD_LOT_WAITING}` : '—')
                                : <><span className={styles.liveArrow[lastDir]}>{lastSign}</span>{formatToTick(contract, last)}</>}
                        </span>
                    </span>
                    <PopUpButton<FuturesPriceType>
                        className={styles.priceType}
                        ariaLabel='價別'
                        testId='ticket-price-type'
                        disabled={busy}
                        value={fields.priceType}
                        displayLabel={PRICE_TYPE_LABEL[fields.priceType]}
                        options={priceTypesFor(isFutures).map(pt => {
                            const reason = priceTypeDisabledReason(pt, odd);
                            return { value: pt, label: `${PRICE_TYPE_LABEL[pt]}${reason ? '（零股不可）' : ''}`, disabled: !!reason };
                        })}
                        onChange={v => t.setPriceType(v)}
                    />
                </div>
                <Stepper
                    value={market ? PRICE_TYPE_LABEL[fields.priceType] : fields.priceText}
                    onChange={v => { setPriceBlurred(false); t.setPriceText(v); }}
                    onStep={d => t.stepPriceBy(d)}
                    onBlur={() => setPriceBlurred(true)}
                    inputMode='decimal'
                    ariaLabel='價格'
                    decLabel='價格減一檔'
                    incLabel='價格加一檔'
                    testId='ticket-price'
                    disabled={busy || market}
                    stepDisabled={market}
                    invalid={tickWarn}
                    atMax={!market && limitUp !== null && priceNum >= limitUp}
                    atMin={!market && limitDown !== null && priceNum > 0 && priceNum <= limitDown}
                    maxText='已到漲停'
                    minText='已到跌停'
                    flashKey={flashKey}
                />
            </div>
            {!market && (t.priceSource === 'snapshot' || t.priceSource === 'reference') && (
                <InlineNote tone='info' testId='ticket-price-source'>
                    {t.priceSource === 'reference'
                        ? `帶入價為${PRICE_SOURCE_LABEL.reference}（尚無成交與快照），請確認價格`
                        : `帶入價為${PRICE_SOURCE_LABEL.snapshot}（尚無即時成交）`}
                </InlineNote>
            )}
            {tickWarn && (
                // role 放在外層（只有一個 alert 節點）；InlineNote 只負責外觀
                <div role='alert'>
                    <InlineNote tone='warn'>{TICKET_TEXT.priceTick}</InlineNote>
                </div>
            )}
            {t.priceStale && (
                <InlineNote
                    tone='warn'
                    testId='ticket-price-stale'
                    action={{ label: '使用此價格', onClick: t.confirmPrice, disabled: busy || !t.canConfirmPrice }}
                >
                    價格可能過期{t.canConfirmPrice ? '' : '（同步完成後請再確認）'}
                </InlineNote>
            )}
            {deviation && <p className={styles.deviation} data-testid='ticket-deviation'>{deviation}</p>}
            <QuickChips
                variant='price'
                ariaLabel='快捷價（送限價）'
                disabled={busy}
                items={quick.map(q => ({
                    key: q.label,
                    label: q.label,
                    dataPrice: q.price === null ? null : formatToTick(contract, q.price),
                    ariaLabel: q.price === null ? `${q.label}（${q.note ?? '無資料'}）` : `${q.label} ${formatToTick(contract, q.price)}`,
                    disabled: q.price === null,
                }))}
                onPick={key => pick(quick.find(q => q.label === key)?.price ?? null)}
            />

            <div className={styles.fieldBlock}>
                <div className={styles.labelRow}>
                    <span className={styles.fieldLabel}>數量</span>
                    {qtyNote && <span className={styles.footnote} data-testid='ticket-qty-note'>{qtyNote}</span>}
                </div>
                <Stepper
                    value={fields.quantity > 0 ? String(fields.quantity) : ''}
                    onChange={v => {
                        const raw = v.replace(/[^\d]/g, '');
                        t.setQuantity(raw === '' ? 0 : Number(raw));
                    }}
                    onStep={d => t.stepQuantity(d)}
                    inputMode='numeric'
                    ariaLabel={`數量（${unit}）`}
                    decLabel='數量減一'
                    incLabel='數量加一'
                    testId='ticket-qty'
                    disabled={busy}
                    atMin={fields.quantity <= 1}
                    atMax={fields.quantity >= qtyMax}
                    minText='已達最小數量'
                    maxText='已達單筆上限'
                    unit={unit}
                />
            </div>
            <QuickChips
                variant='qty'
                ariaLabel='數量快捷'
                disabled={busy}
                items={presets.map(n => ({ key: String(n), label: String(n) }))}
                onPick={key => t.setQuantity(Number(key))}
            />

            <TicketInfo contract={contract} account={account} fields={fields} isFutures={isFutures} estimate={t.estimate} />

            {creditHint && (
                <InlineNote
                    tone='warn'
                    role='note'
                    testId='ticket-credit-hint'
                    action={creditHint.suggest
                        ? {
                            label: creditHint.suggest === 'ShortSelling' ? '改用融券（回補）' : '改用融資（賣出）',
                            disabled: busy,
                            // 使用者按了才改條件（絕不自動改）
                            onClick: () => t.setOrderCond(creditHint.suggest!),
                        }
                        : undefined}
                >
                    {creditHint.text}
                </InlineNote>
            )}

            {t.gate.state === 'stale-data' && (
                <InlineNote tone='warn' action={{ label: '重試', onClick: t.retryResume, disabled: busy }}>
                    <label className={styles.checkboxLabel}>
                        <input
                            type='checkbox'
                            className={styles.checkbox}
                            data-testid='ticket-stale-ack'
                            checked={t.gate.staleAcknowledged}
                            disabled={busy || t.gate.staleAcknowledged}
                            onChange={() => t.acknowledgeStale()}
                        />
                        我了解委託／持倉資料可能過期
                    </label>
                </InlineNote>
            )}

            <section className={styles.ladderSection} aria-label='五檔'>
                <span className={styles.fieldLabel} aria-hidden='true'>五檔</span>
                {fields.orderLot === 'Odd' ? (
                    <p className={styles.footnote} data-testid='ticket-no-depth'>盤後零股沒有即時五檔</p>
                ) : (
                    <div className={styles.ladderIsland}>
                        <DepthLadder
                            code={contract.code}
                            contract={contract}
                            trades={trading.trades}
                            variant='ticket'
                            oddLot={fields.orderLot === 'IntradayOdd'}
                            // 點價位：帶入價格並視為使用者已確認（改成限價）；不決定買賣、不送單
                            onPick={price => pick(price)}
                        />
                    </div>
                )}
            </section>

            <SheetFooter>
                <div className={styles.footerStack} data-testid='ticket-footer'>
                    {t.feedback && (
                        <p className={styles.feedback[t.feedback.kind]} role={t.feedback.kind === 'not-sent' ? 'alert' : 'status'} data-testid='ticket-feedback'>
                            {t.feedback.kind === 'not-sent' ? <CircleX className={styles.feedbackIcon} aria-hidden='true' focusable='false' /> : null}
                            {t.feedback.text}
                        </p>
                    )}
                    {t.problem && <p className={styles.problem} role='status' data-testid='ticket-problem'>⚠ {t.problem}</p>}
                    {!t.feedback && !t.problem && (
                        <p className={styles.summary} data-testid='ticket-summary'>{ticketSummaryText(fields, isFutures, t.estimate, privMoney)}</p>
                    )}
                    <button
                        type='button'
                        className={[
                            tone ? styles.cta.tone : styles.cta.none,
                            tone ? fill[tone === 'buy' ? 'up' : 'down'].large : '',
                            pressable,
                            focusRing,
                        ].filter(Boolean).join(' ')}
                        data-testid='ticket-preview'
                        disabled={busy || t.problem !== null}
                        onClick={() => {
                            // 先收起鍵盤並觸發欄位驗證，再走既有的送出流程（確認面板滑動才會送單）
                            blurFocusedField();
                            void t.submit(creditHint?.text ?? null);
                        }}
                    >
                        {busy ? <><span className={styles.spinner} aria-hidden='true' />送出中…</> : t.previewText}
                    </button>
                </div>
            </SheetFooter>
        </div>
    );
}
