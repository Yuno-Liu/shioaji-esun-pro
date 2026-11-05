// src/mobile/components/order-ticket-sheet.tsx — 下單底部面板（規格 §6.3、§7.1、§7.2）
//
// 介面：無 props、掛在 App 根層；開啟狀態與帶入的方向／價格來自 mobile-store 的 `ticket`
// （openTicket()／closeTicket()；ticket.seq 遞增代表新的開啟 → 以 key 重新初始化所有欄位）。
// - 頂端必顯示 RouteBadge；帳戶在開啟時固定（captureSelectedAccount），面板開啟期間不允許切換帳戶。
// - 欄位狀態、即時驗證與送出在 hooks/use-mobile-ticket.ts；送出一律經 submitMobileOrder()（強制確認面板）。
// - 送出進行中：按鈕停用、面板不可關閉（避免結果未知時面板消失）。
// - MVP 單位只有整股與盤中零股；盤後零股、融資、融券、當沖先賣屬 P1，停用並標示。

import { useEffect, useState } from 'react';
import { ensureContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { lotLabel, ODD_LOT_MAX_SHARES, orderQtyUnit } from '../../lib/odd-lot';
import { FUTURES_OCTYPES, ORDER_TYPES, orderTypeDisabledReason, PRICE_TYPE_LABEL, priceTypeDisabledReason, priceTypesFor } from '../../lib/order-conditions';
import { maskMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import type { ContractInfo } from '../../lib/types/contract';
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
    type TicketLot,
} from '../hooks/use-mobile-ticket';
import { closeTicket, useMobileUi, type TicketRequest } from '../lib/mobile-store';
import * as styles from '../styles/order-ticket.css';
import * as layout from '../styles/layout.css';
import { mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet } from './bottom-sheet';
import { RouteBadge } from './route-badge';

const LOTS: readonly { lot: TicketLot | 'Odd'; label: string; p1?: boolean }[] = [
    { lot: 'Common', label: '整股' },
    { lot: 'IntradayOdd', label: '盤中零股' },
    { lot: 'Odd', label: '盤後零股', p1: true },
];

const fmtAmount = (v: number) => Math.round(v).toLocaleString('en-US');

export function OrderTicketSheet() {
    const { ticket } = useMobileUi();
    const code = ticket?.code ?? null;
    const contract = useContract(code);
    const [busy, setBusy] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);

    useEffect(() => {
        setLoadFailed(false);
        if (!code) return;
        let alive = true;
        ensureContract(code).catch(() => { if (alive) setLoadFailed(true); });
        return () => { alive = false; };
    }, [code]);

    useEffect(() => { if (!ticket) setBusy(false); }, [ticket]);

    const title = contract && ticket ? `${contract.code} ${contract.name}` : ticket ? `下單 ${ticket.code}` : '下單';
    return (
        <BottomSheet open={ticket !== null} onClose={closeTicket} dismissible={!busy} title={title} testId='order-ticket-sheet'>
            {ticket && contract && <TicketForm key={ticket.seq} ticket={ticket} contract={contract} onBusyChange={setBusy} />}
            {ticket && !contract && (
                <p className={layout.placeholder}>{loadFailed ? '商品資料載入失敗，請關閉後再試。' : '商品資料載入中…'}</p>
            )}
        </BottomSheet>
    );
}

function TicketForm({ ticket, contract, onBusyChange }: { ticket: TicketRequest; contract: ContractInfo; onBusyChange: (busy: boolean) => void }) {
    const t = useMobileTicket(ticket, contract);
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const [priceBlurred, setPriceBlurred] = useState(false);
    const { fields, isFutures, odd, busy } = t;

    useEffect(() => {
        onBusyChange(busy);
    }, [busy, onBusyChange]);
    useEffect(() => () => onBusyChange(false), [onBusyChange]);

    const unit = orderQtyUnit(isFutures, isFutures ? undefined : fields.orderLot);
    const market = fields.priceType !== 'LMT';
    const priceNum = parsePrice(fields.priceText);
    const tickWarn = !market && priceBlurred && priceNum > 0 && !isOnTick(contract, priceNum);
    const reference = positivePrice(contract.reference);
    const last = t.quote.last;
    const lastDir = last === null || reference === null ? 'flat' : last > reference ? 'up' : last < reference ? 'down' : 'flat';
    const lastSign = lastDir === 'up' ? '▲' : lastDir === 'down' ? '▼' : '';
    const quick: { label: string; price: number | null }[] = [
        { label: '買一', price: t.quote.bid1 },
        { label: '賣一', price: t.quote.ask1 },
        { label: '成交', price: last },
        { label: '漲停', price: positivePrice(contract.limit_up) },
        { label: '跌停', price: positivePrice(contract.limit_down) },
        { label: '平盤', price: reference },
    ];
    const presets = odd ? ODD_QTY_PRESETS : QTY_PRESETS;
    const account = t.account;

    return (
        <div className={styles.form} data-testid='order-ticket-form'>
            <div className={styles.headerRow}>
                <span className={styles.contractName}>{contract.code} {contract.name}</span>
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

            {!isFutures && (
                <div className={styles.row}>
                    <span className={styles.label}>單位</span>
                    <div className={styles.segGroup} role='group' aria-label='單位'>
                        {LOTS.map(({ lot, label, p1 }) => (
                            <button
                                key={lot}
                                type='button'
                                className={fields.orderLot === lot ? styles.seg.on : styles.seg.off}
                                aria-pressed={fields.orderLot === lot}
                                disabled={busy || p1}
                                title={p1 ? '手機版尚未提供（P1）' : undefined}
                                onClick={() => { if (lot !== 'Odd') t.setOrderLot(lot); }}
                            >
                                {p1 ? `${label}（P1）` : label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {!isFutures && !odd && (
                <div className={styles.row}>
                    <span className={styles.label}>條件</span>
                    <div className={styles.segGroup} role='group' aria-label='信用條件'>
                        <button type='button' className={styles.seg.on} aria-pressed disabled={busy}>現股</button>
                        <button type='button' className={styles.seg.off} aria-pressed={false} disabled title='手機版尚未提供（P1）'>融資（P1）</button>
                        <button type='button' className={styles.seg.off} aria-pressed={false} disabled title='手機版尚未提供（P1）'>融券（P1）</button>
                        <button type='button' className={styles.seg.off} aria-pressed={false} disabled title='手機版尚未提供（P1）'>當沖先賣（P1）</button>
                    </div>
                </div>
            )}

            {odd && (
                <span className={styles.muted} data-testid='ticket-odd-note'>
                    {lotLabel(fields.orderLot)}：以股計（1～{ODD_LOT_MAX_SHARES} 股）· 限價 ROD · 僅現股，不可融資券或當沖
                </span>
            )}

            {isFutures && (
                <div className={styles.row}>
                    <span className={styles.label}>倉別</span>
                    <div className={styles.segGroup} role='group' aria-label='倉別'>
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
            )}

            <div className={styles.row}>
                <span className={styles.label}>價別</span>
                <div className={styles.segGroup} role='group' aria-label='價別'>
                    {priceTypesFor(isFutures).map(pt => {
                        const reason = priceTypeDisabledReason(pt, odd);
                        return (
                            <button
                                key={pt}
                                type='button'
                                className={fields.priceType === pt ? styles.seg.on : styles.seg.off}
                                aria-pressed={fields.priceType === pt}
                                disabled={busy || !!reason}
                                title={reason ?? undefined}
                                onClick={() => t.setPriceType(pt)}
                            >
                                {PRICE_TYPE_LABEL[pt]}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>效期</span>
                <div className={styles.segGroup} role='group' aria-label='效期'>
                    {ORDER_TYPES.map(ot => {
                        const reason = orderTypeDisabledReason(ot, odd);
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

            <div className={styles.row}>
                <span className={styles.label}>價格</span>
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
                <span className={styles.livePrice[lastDir]} data-testid='ticket-live-price'>
                    {t.quote.lastSource === 'snapshot' ? PRICE_SOURCE_LABEL.snapshot : PRICE_SOURCE_LABEL.trade}{' '}
                    {last === null ? '—' : `${lastSign}${formatToTick(contract, last)}`}
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
                    <button type='button' className={styles.seg.off} disabled={busy || !t.canConfirmPrice} onClick={t.confirmPrice}>使用此價格</button>
                </div>
            )}
            <div className={styles.quickRow} role='group' aria-label='快捷價（送限價）'>
                {quick.map(q => (
                    <button
                        key={q.label}
                        type='button'
                        className={styles.quickButton}
                        disabled={busy || q.price === null}
                        aria-label={q.price === null ? `${q.label}（無資料）` : `${q.label} ${formatToTick(contract, q.price)}`}
                        onClick={() => t.pickPrice(q.price)}
                    >
                        {q.label}
                    </button>
                ))}
            </div>

            <div className={styles.row}>
                <span className={styles.label}>數量</span>
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
            <div className={styles.quickRow} role='group' aria-label='數量快捷'>
                {presets.map(n => (
                    <button key={n} type='button' className={styles.quickButton} disabled={busy} onClick={() => t.setQuantity(n)}>
                        {n}
                    </button>
                ))}
            </div>

            <hr className={styles.divider} />
            <div className={styles.estimate} data-testid='ticket-estimate'>
                {isFutures ? '名目價值' : '預估金額'}{' '}
                {t.estimate.value === null ? '—' : maskMoney(fmtAmount(t.estimate.value), privMoney)}
                <span className={styles.muted}>
                    {isFutures ? '（價格 × 契約乘數 × 口數，不含保證金）' : '（不含手續費、稅）'}
                    {t.estimate.byLastPrice ? '・市價以成交價估' : ''}
                </span>
            </div>

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
                    <button type='button' className={styles.seg.off} disabled={busy} onClick={t.retryResume}>重試</button>
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
                className={styles.previewButton}
                data-testid='ticket-preview'
                disabled={busy || t.problem !== null}
                onClick={() => { void t.submit(); }}
            >
                {busy ? '送出中…' : '預覽並確認委託'}
            </button>
        </div>
    );
}
