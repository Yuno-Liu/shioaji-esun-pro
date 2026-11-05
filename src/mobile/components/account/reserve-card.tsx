// src/mobile/components/account/reserve-card.tsx — 帳戶頁「預收券款／圈存」（永豐證券帳戶；唯讀，比照桌面 ReserveSection）
//
// - 資料：fetchStockReserveSummary、fetchStockReserveDetail、fetchEarmarkingDetail（src/lib/shioaji），個別失敗不拖垮整區。
// - 只在展開區塊（尚未讀過時）或按「查詢」才讀取，冷卻 RESERVE_COOLDOWN_MS。
// - 模擬環境不支援：不發請求，只顯示說明。
// - 不提供任何預收／圈存申請動作（那屬於下單類操作）。玉山帳戶不顯示這張卡（圈存金額見玉山帳務概覽）。

import { useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { isEsunAccount } from '../../../lib/esun';
import { maskMoney, usePrivacyMoney } from '../../../lib/privacy';
import {
    fetchEarmarkingDetail,
    fetchStockReserveDetail,
    fetchStockReserveSummary,
    type EarmarkStocksDetail,
    type ReserveStocksDetail,
    type ReserveStocksSummary,
} from '../../../lib/shioaji';
import type { Account } from '../../../lib/types/portfolio';
import { accountKeyOf, formatClock, formatTwd } from '../../lib/account-format';
import { canLoadOnDemand, cooldownLeftSec, loadOnDemand, onDemandNow, useOnDemand } from '../../lib/account-on-demand';
import { useOrderRoute } from '../route-badge';
import * as styles from '../../styles/account.css';
import { CollapsibleCard, Item, RefreshButton, useNow } from './account-ui';

export const RESERVE_COOLDOWN_MS = 30_000;

export interface ReserveData {
    summary: ReserveStocksSummary['stocks'] | null;
    detail: ReserveStocksDetail['stocks'] | null;
    earmark: EarmarkStocksDetail['stocks'] | null;
}

/** 三個查詢各自 catch；全部失敗才 reject */
export async function fetchReserveData(account: Account): Promise<ReserveData> {
    const [summary, detail, earmark] = await Promise.allSettled([
        fetchStockReserveSummary(account),
        fetchStockReserveDetail(account),
        fetchEarmarkingDetail(account),
    ]);
    if (summary.status === 'rejected' && detail.status === 'rejected' && earmark.status === 'rejected') {
        throw summary.reason instanceof Error ? summary.reason : new Error('暫時無法查詢預收資訊');
    }
    return {
        summary: summary.status === 'fulfilled' ? summary.value?.stocks ?? [] : null,
        detail: detail.status === 'fulfilled' ? detail.value?.stocks ?? [] : null,
        earmark: earmark.status === 'fulfilled' ? earmark.value?.stocks ?? [] : null,
    };
}

function ReserveBody({ data }: { data: ReserveData }) {
    const privMoney = usePrivacyMoney();
    const shares = (n: number) => maskMoney(`${n.toLocaleString('en-US')} 股`, privMoney);
    const sum = data.summary ?? [];
    const det = data.detail ?? [];
    const ear = data.earmark ?? [];
    const failed = [data.summary === null && '可預收股票', data.detail === null && '預收明細', data.earmark === null && '圈存明細'].filter(Boolean);
    return (
        <div data-testid='reserve-body'>
            {failed.length > 0 && <p className={styles.warning} role='status'>{failed.join('、')}暫時無法查詢。</p>}
            {sum.length === 0 && det.length === 0 && ear.length === 0 ? (
                <p className={styles.note}>目前沒有可預收股票與預收紀錄。</p>
            ) : (
                <>
                    {sum.length > 0 && (
                        <>
                            <h3 className={styles.subTitle}>可預收股票（可預收／已預收）</h3>
                            <dl className={styles.kv}>
                                {sum.map((s, i) => (
                                    <Item key={`${s.contract.code}-${i}`} term={s.contract.code}>
                                        {shares(s.available_share)} / {shares(s.reserved_share)}
                                    </Item>
                                ))}
                            </dl>
                        </>
                    )}
                    {det.length > 0 && (
                        <>
                            <h3 className={styles.subTitle}>預收券款明細</h3>
                            <dl className={styles.kv}>
                                {det.map((s, i) => (
                                    <Item key={`${s.contract.code}-${i}`} term={`${s.contract.code} ${s.status ? '成功' : '失敗'}${s.info ? `・${s.info}` : ''}`} tone={s.status ? 'normal' : 'warn'}>
                                        {shares(s.share)}
                                    </Item>
                                ))}
                            </dl>
                        </>
                    )}
                    {ear.length > 0 && (
                        <>
                            <h3 className={styles.subTitle}>圈存（預收款項）明細</h3>
                            <dl className={styles.kv}>
                                {ear.map((s, i) => (
                                    <Item key={`${s.contract.code}-${i}`} term={`${s.contract.code} ${s.status ? '成功' : '失敗'}${s.info ? `・${s.info}` : ''}`} tone={s.status ? 'normal' : 'warn'}>
                                        {shares(s.share)}・{maskMoney(formatTwd(s.amount), privMoney)}
                                    </Item>
                                ))}
                            </dl>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

function ReserveInner({ stock }: { stock: Account }) {
    const route = useOrderRoute(stock);
    const [open, setOpen] = useState(false);
    useNow(open ? 1_000 : 60_000);
    const sim = route?.simulation === true;
    const key = `reserve:${accountKeyOf(stock)}`;
    const state = useOnDemand<ReserveData>(key);
    const clockNow = onDemandNow();
    const canLoad = !sim && canLoadOnDemand(state, RESERVE_COOLDOWN_MS, clockNow);
    const load = () => {
        if (sim) return;
        const account = stock;
        void loadOnDemand(key, () => fetchReserveData(account), RESERVE_COOLDOWN_MS);
    };
    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && state.data === null && canLoad) load();
    };
    return (
        <CollapsibleCard title='預收券款／圈存' open={open} onToggle={toggle} testId='account-reserve'>
            {sim ? (
                <p className={styles.note} data-testid='reserve-sim'>模擬環境不支援預收券款／圈存查詢。</p>
            ) : (
                <>
                    {state.loading && !state.data && <p className={styles.note}>預收資訊查詢中…</p>}
                    {state.data && <ReserveBody data={state.data} />}
                    {state.error && <p className={styles.warning} role='alert'>預收資訊查詢失敗：{state.error}</p>}
                    <p className={styles.note}>只提供查詢；預收或圈存申請請使用券商官方管道。</p>
                    <div className={styles.actions}>
                        <span className={styles.note}>查詢時間 {formatClock(state.updatedAt)}</span>
                        <RefreshButton
                            label='查詢'
                            loading={state.loading}
                            cooldownSec={state.loading ? 0 : cooldownLeftSec(state, RESERVE_COOLDOWN_MS, clockNow)}
                            disabled={!canLoad}
                            onClick={load}
                            testId='reserve-query'
                        />
                    </div>
                </>
            )}
        </CollapsibleCard>
    );
}

export function ReserveCard() {
    const { selectedStock } = useAccounts();
    if (!selectedStock || selectedStock.account_type !== 'S' || isEsunAccount(selectedStock)) return null;
    return <ReserveInner key={accountKeyOf(selectedStock)} stock={selectedStock} />;
}
