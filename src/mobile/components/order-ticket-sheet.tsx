// src/mobile/components/order-ticket-sheet.tsx — 下單底部面板（規格 §6.3、§7.1、§7.2）
//
// 介面：無 props、掛在 App 根層；開啟狀態與帶入的方向／價格／單位／信用條件來自 mobile-store 的 `ticket`
// （openTicket()／closeTicket()；ticket.seq 遞增代表新的開啟 → 以 key 重新初始化所有欄位）。
//
// 版面（由上而下，參考券商 App）：大字方向 → [買進｜賣出] → 精簡報價列 → 標籤（可當沖、送單路由）與帳戶
// → [整股｜零股] → 條件摘要「現股 / 盤中 / ROD」（點開三組分段）→ 價別＋價格步進 → 數量步進
// → 剩餘交易額度／預估價金／交易成本（估）→ 預覽鍵（方向色＋完整文字）→ 內嵌五檔（點價位帶入價格）。
// 期貨／選擇權沒有單位與信用，倉別與效期直接以同樣的分段顯示。
//
// - 選定方向後整個面板以方向色淡色著色（BottomSheet tone；買進 vars.color.up、賣出 vars.color.down），未選方向中性。
// - 頂端必顯示 RouteBadge；帳戶在開啟時固定（captureSelectedAccount），面板開啟期間不允許切換帳戶。
// - 欄位狀態、即時驗證與送出在 hooks/use-mobile-ticket.ts；送出一律經 submitMobileOrder()（強制確認面板）。
// - 送出進行中：按鈕停用、面板不可關閉（避免結果未知時面板消失）。

import { useEffect, useState } from 'react';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { ODD_LOT_WAITING, orderQtyUnit } from '../../lib/odd-lot';
import { FUTURES_OCTYPES, ORDER_TYPES, orderTypeDisabledReason, PRICE_TYPE_LABEL, priceTypeDisabledReason, priceTypesFor } from '../../lib/order-conditions';
import { usePrivacyMode } from '../../lib/privacy';
import { manualStockCreditHint } from '../../lib/stock-exit-cond';
import { useTradingState } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { FuturesPriceType } from '../../lib/types/order';
import { formatToTick } from '../../lib/utils/ticksize';
import {
    ODD_QTY_PRESETS,
    PRICE_SOURCE_LABEL,
    QTY_PRESETS,
    isOnTick,
    parsePrice,
    positivePrice,
    TICKET_TEXT,
    useMobileTicket,
} from '../hooks/use-mobile-ticket';
import { closeTicket, useMobileUi, type TicketRequest } from '../lib/mobile-store';
import * as styles from '../styles/order-ticket.css';
import * as layout from '../styles/layout.css';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet } from './bottom-sheet';
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
    const trading = useTradingState();
    const [priceBlurred, setPriceBlurred] = useState(false);
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
        { label: '漲停', price: positivePrice(contract.limit_up) },
        { label: '跌停', price: positivePrice(contract.limit_down) },
        { label: '平盤', price: reference },
    ];
    const presets = odd ? ODD_QTY_PRESETS : QTY_PRESETS;
    const account = t.account;
    const tag = isFutures ? null : dayTradeTag(contract.day_trade);

    // 信用提醒（比照桌面 creditHintFor）：只提示，使用者按了才改條件；持倉尚未載入時只顯示有建議的提醒
    const rawHint = !isFutures && fields.orderLot === 'Common' && fields.action
        ? manualStockCreditHint(trading.positions, account, contract.code, fields.action, fields.orderCond)
        : null;
    const creditHint = rawHint && (rawHint.suggest !== null || trading.queries.positions.updatedAt !== null) ? rawHint : null;

    return (
        <div className={styles.form} data-testid='order-ticket-form'>
            <p className={styles.directionBanner[tone ?? 'none']} data-testid='ticket-direction' aria-live='polite'>
                {fields.action ? t.actionText : '請選擇買進或賣出'}
            </p>
            <div className={styles.actionRow} role='group' aria-label='買賣方向'>
                <button
                    type='button'
                    className={fields.action === 'Buy' ? styles.action.buyOn : styles.action.buyOff}
                    aria-pressed={fields.action === 'Buy'}
                    disabled={busy}
                    onClick={() => t.setAction('Buy')}
                >
                    買進
                </button>
                <button
                    type='button'
                    className={fields.action === 'Sell' ? styles.action.sellOn : styles.action.sellOff}
                    aria-pressed={fields.action === 'Sell'}
                    disabled={busy}
                    onClick={() => t.setAction('Sell')}
                >
                    賣出
                </button>
            </div>

            <TicketQuoteRow contract={contract} snapshot={t.snapshot} />

            <div className={styles.tagRow}>
                {tag && <span className={styles.tag} data-testid='ticket-daytrade-tag'>{tag}</span>}
                <RouteBadge account={account} />
            </div>
            <div className={styles.accountRow} data-testid='ticket-account'>
                <span>
                    帳戶　{account
                        ? `${isEsunAccount(account) ? '玉山' : '永豐'} ${mobileAccountLabel(account, priv)}（${isFutures ? '期貨／選擇權' : '證券'}）`
                        : isFutures ? '沒有可用的期貨帳戶' : '沒有可用的證券帳戶'}
                </span>
                {isFutures && account && isEsunAccount(account) && <span className={styles.problem}>{TICKET_TEXT.esunFutures}</span>}
                <span className={styles.muted}>面板開啟期間不能切換帳戶；要換帳戶請關閉面板後到「帳戶」頁。</span>
            </div>

            {!isFutures && <TicketStockConditions t={t} contract={contract} />}

            {isFutures && (
                <>
                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>倉別</span>
                        <div className={styles.segmented} role='group' aria-label='倉別'>
                            {FUTURES_OCTYPES.map(({ value, label }) => (
                                <button
                                    key={value}
                                    type='button'
                                    className={fields.octype === value ? styles.seg.on : styles.seg.off}
                                    aria-pressed={fields.octype === value}
                                    disabled={busy}
                                    onClick={() => t.setOctype(value)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className={styles.fieldBlock}>
                        <span className={styles.fieldLabel}>效期</span>
                        <div className={styles.segmented} role='group' aria-label='效期'>
                            {ORDER_TYPES.map(ot => {
                                const reason = orderTypeDisabledReason(ot, false);
                                return (
                                    <button
                                        key={ot}
                                        type='button'
                                        className={fields.orderType === ot ? styles.seg.on : styles.seg.off}
                                        aria-pressed={fields.orderType === ot}
                                        disabled={busy || !!reason}
                                        title={reason ?? undefined}
                                        onClick={() => t.setOrderType(ot)}
                                    >
                                        {ot}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            <div className={styles.fieldBlock}>
                <span className={styles.fieldLabel}>價格</span>
                <div className={styles.priceRow}>
                    <select
                        className={styles.select}
                        aria-label='價別'
                        data-testid='ticket-price-type'
                        disabled={busy}
                        value={fields.priceType}
                        onChange={e => t.setPriceType(e.target.value as FuturesPriceType)}
                    >
                        {priceTypesFor(isFutures).map(pt => {
                            const reason = priceTypeDisabledReason(pt, odd);
                            return (
                                <option key={pt} value={pt} disabled={!!reason}>
                                    {PRICE_TYPE_LABEL[pt]}{reason ? '（零股不可）' : ''}
                                </option>
                            );
                        })}
                    </select>
                    <div className={styles.stepper}>
                        <button type='button' className={styles.stepButton} aria-label='價格減一檔' disabled={busy || market} onClick={() => t.stepPriceBy(-1)}>－</button>
                        <input
                            className={styles.input}
                            aria-label='價格'
                            data-testid='ticket-price'
                            inputMode='decimal'
                            autoComplete='off'
                            disabled={busy || market}
                            aria-invalid={tickWarn || undefined}
                            value={market ? PRICE_TYPE_LABEL[fields.priceType] : fields.priceText}
                            onChange={e => { setPriceBlurred(false); t.setPriceText(e.target.value); }}
                            onBlur={() => setPriceBlurred(true)}
                        />
                        <button type='button' className={styles.stepButton} aria-label='價格加一檔' disabled={busy || market} onClick={() => t.stepPriceBy(1)}>＋</button>
                    </div>
                </div>
                <span className={styles.livePrice[lastDir]} data-testid='ticket-live-price'>
                    {liveLabel}{' '}
                    {last === null ? (oddWaiting ? `— ${ODD_LOT_WAITING}` : '—') : `${lastSign}${formatToTick(contract, last)}`}
                </span>
            </div>
            {!market && (t.priceSource === 'snapshot' || t.priceSource === 'reference') && (
                <span className={styles.muted} data-testid='ticket-price-source'>
                    {t.priceSource === 'reference'
                        ? `帶入價為${PRICE_SOURCE_LABEL.reference}（尚無成交與快照），請確認價格`
                        : `帶入價為${PRICE_SOURCE_LABEL.snapshot}（尚無即時成交）`}
                </span>
            )}
            {tickWarn && <p className={styles.problem} role='alert'>{TICKET_TEXT.priceTick}</p>}
            {t.priceStale && (
                <div className={styles.staleRow} data-testid='ticket-price-stale'>
                    <span>⚠ 價格可能過期{t.canConfirmPrice ? '' : '（同步完成後請再確認）'}</span>
                    <button type='button' className={styles.plainButton} disabled={busy || !t.canConfirmPrice} onClick={t.confirmPrice}>使用此價格</button>
                </div>
            )}
            <div className={styles.quickRow} role='group' aria-label='快捷價（送限價）'>
                {quick.map(q => (
                    <button
                        key={q.label}
                        type='button'
                        className={styles.quickButton}
                        disabled={busy || q.price === null}
                        aria-label={q.price === null ? `${q.label}（${q.note ?? '無資料'}）` : `${q.label} ${formatToTick(contract, q.price)}`}
                        onClick={() => t.pickPrice(q.price)}
                    >
                        {q.label}
                    </button>
                ))}
            </div>

            <div className={styles.fieldBlock}>
                <span className={styles.fieldLabel}>數量</span>
                <div className={styles.qtyRow}>
                    <div className={styles.stepper}>
                        <button type='button' className={styles.stepButton} aria-label='數量減一' disabled={busy} onClick={() => t.stepQuantity(-1)}>－</button>
                        <input
                            className={styles.input}
                            aria-label={`數量（${unit}）`}
                            data-testid='ticket-qty'
                            inputMode='numeric'
                            autoComplete='off'
                            disabled={busy}
                            value={fields.quantity > 0 ? String(fields.quantity) : ''}
                            onChange={e => {
                                const raw = e.target.value.replace(/[^\d]/g, '');
                                t.setQuantity(raw === '' ? 0 : Number(raw));
                            }}
                        />
                        <button type='button' className={styles.stepButton} aria-label='數量加一' disabled={busy} onClick={() => t.stepQuantity(1)}>＋</button>
                    </div>
                    <span className={styles.unit}>{unit}</span>
                </div>
            </div>
            <div className={styles.quickRow} role='group' aria-label='數量快捷'>
                {presets.map(n => (
                    <button key={n} type='button' className={styles.quickButton} disabled={busy} onClick={() => t.setQuantity(n)}>
                        {n}
                    </button>
                ))}
            </div>

            <TicketInfo contract={contract} account={account} fields={fields} isFutures={isFutures} estimate={t.estimate} />

            {creditHint && (
                <div className={styles.hintRow} role='note' data-testid='ticket-credit-hint'>
                    <span>{creditHint.text}</span>
                    {creditHint.suggest && (
                        <button
                            type='button'
                            className={styles.plainButton}
                            disabled={busy}
                            // 使用者按了才改條件（絕不自動改）
                            onClick={() => t.setOrderCond(creditHint.suggest!)}
                        >
                            {creditHint.suggest === 'ShortSelling' ? '改用融券（回補）' : '改用融資（賣出）'}
                        </button>
                    )}
                </div>
            )}

            {t.gate.state === 'stale-data' && (
                <div className={styles.checkboxRow}>
                    <label className={styles.checkboxRow}>
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
                    <button type='button' className={styles.plainButton} disabled={busy} onClick={t.retryResume}>重試</button>
                </div>
            )}

            {t.problem && <p className={styles.problem} role='status' data-testid='ticket-problem'>⚠ {t.problem}</p>}
            {t.feedback && (
                <p className={styles.feedback[t.feedback.kind]} role={t.feedback.kind === 'not-sent' ? 'alert' : 'status'} data-testid='ticket-feedback'>
                    {t.feedback.text}
                </p>
            )}

            <button
                type='button'
                className={styles.previewButton[tone ?? 'none']}
                data-testid='ticket-preview'
                disabled={busy || t.problem !== null}
                onClick={() => { void t.submit(creditHint?.text ?? null); }}
            >
                {busy ? '送出中…' : t.previewText}
            </button>

            {fields.orderLot === 'Odd' ? (
                <span className={styles.muted} data-testid='ticket-no-depth'>盤後零股沒有即時五檔</span>
            ) : (
                <div className={styles.ladderWrap}>
                    <DepthLadder
                        code={contract.code}
                        contract={contract}
                        trades={trading.trades}
                        variant='ticket'
                        oddLot={fields.orderLot === 'IntradayOdd'}
                        // 點價位：帶入價格並視為使用者已確認（改成限價）；不決定買賣、不送單
                        onPick={price => t.pickPrice(price)}
                    />
                </div>
            )}
        </div>
    );
}
