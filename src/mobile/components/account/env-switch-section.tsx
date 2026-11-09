// src/mobile/components/account/env-switch-section.tsx — 帳戶 › 連線「交易環境」（規格 §2.5、§6.7；設計規格 §7.8、§10 S1）
//
// 由 connection-card.tsx 掛在「玉山重新連線」之後；對外介面固定為無 props 的 EnvSwitchSection。
// - 永豐：唯讀。環境來自伺服器（/api/v1/info 的 simulation，server-info-store）；改 .env 的 SJ_PRODUCTION 後重新啟動才會變。
// - 玉山：顯示目前環境與兩個設定檔選項（沒有設定檔的選項停用並說明）；點選後開確認面板：
//   · 切換至正式：必須滑動確認（SlideToConfirm），面板顯示真實下單警示；
//   · 切換至模擬：按鈕確認（不會動用真實資金，風險降低的方向；仍須「點選項 → 面板內按確定」兩步，不會單擊直接切換）。
//   面板開啟時重新讀一次 bridge health（停止的 bridge 不會被舊的 health 誤判為已連線）；切換中不可關閉。
// - 擋下條件與送出見 lib/esun-env-switch.ts（面板顯示原因；滑動／按下確定的當下再判斷一次）。不送任何委託（S1）。

import { Check, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { esunTradeService, useEsunEnvironment, type EsunEnvironment } from '../../../lib/esun';
import { subscribeOrderConfirm } from '../../../lib/order-confirm';
import { useServerInfo } from '../../../lib/server-info-store';
import { subscribeTradingState } from '../../../lib/trading-state';
import { onAccountJump, takeAccountJump } from '../../lib/account-jump';
import { subscribeBatchExit } from '../../lib/batch-exit-auth';
import {
    ESUN_ENV_LABEL,
    ESUN_PRODUCTION_WARNING,
    esunSwitchBlock,
    esunSwitchBlockText,
    runEsunEnvSwitch,
    subscribeEsunSwitchSources,
    useEsunEnvSwitching,
    type BridgeProbe,
    type EsunSwitchBlock,
} from '../../lib/esun-env-switch';
import { useEsunReconnectState } from '../../lib/esun-reconnect';
import { subscribeMobileUi } from '../../lib/mobile-store';
import * as styles from '../../styles/account.css';
import * as controls from '../../styles/controls.css';
import * as routeStyles from '../../styles/route-badge.css';
import * as sb from '../../styles/status-bar.css';
import { InlineNote } from '../../ui/inline-note';
// 根層面板（app.tsx 延遲載入）的模組放進帳戶頁 chunk：開始切換時已在記憶體，面板立即出現
import '../env-switch-overlay';
import { BottomSheet, SheetFooter } from '../bottom-sheet';
import { SlideToConfirm } from '../slide-to-confirm';
import { Item, type Tone } from './account-ui';

/** 跳轉錨點（狀態列帳戶切換面板的「玉山環境切換」連結） */
export const ENV_SECTION_ID = 'account-env-switch';

const TARGETS: readonly EsunEnvironment[] = ['SIMULATION', 'PRODUCTION'];
/** 與單一選項有關的原因（顯示在該選項列）；其餘是共同原因（顯示在選項下方） */
const OPTION_BLOCKS: readonly EsunSwitchBlock[] = ['current', 'unavailable'];

/** 擋下條件的所有來源改變時重繪 */
function useSwitchSources(): void {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        const stops = [
            esunTradeService.subscribe(rerender),
            subscribeMobileUi(rerender),
            subscribeOrderConfirm(rerender),
            subscribeBatchExit(rerender),
            subscribeEsunSwitchSources(rerender),
            subscribeTradingState(rerender), // 待對帳（esunReconcilePending）
        ];
        return () => stops.forEach(stop => stop());
    }, []);
    useEsunReconnectState();
}

/** 從狀態列跳來時捲到本區塊並聚焦（延到微任務：殼層 ScrollRestorer 同一次提交會還原捲動位置） */
function useFocusOnArrival(): void {
    useLayoutEffect(() => {
        let cancelled = false;
        const run = () => queueMicrotask(() => {
            if (cancelled || !takeAccountJump(ENV_SECTION_ID) || typeof document === 'undefined') return;
            const el = document.getElementById(ENV_SECTION_ID);
            if (!el) return;
            if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
            el.focus({ preventScroll: true });
        });
        run();
        const stop = onAccountJump(run);
        return () => {
            cancelled = true;
            stop();
        };
    }, []);
}

function envTone(env: EsunEnvironment): Tone {
    return env === 'PRODUCTION' ? 'bad' : 'accent';
}

export function EnvSwitchSection() {
    useSwitchSources();
    useFocusOnArrival();
    const esun = useEsunEnvironment();
    const info = useServerInfo();
    const switching = useEsunEnvSwitching();
    const [target, setTarget] = useState<EsunEnvironment | null>(null);
    const health = esunTradeService.getBridgeHealth();
    const sinopac = info?.simulation;
    const blocks = TARGETS.map(t => esunSwitchBlock(t));
    const shared = blocks.find(b => b !== null && !OPTION_BLOCKS.includes(b)) ?? null;
    const sharedTarget = TARGETS[blocks.indexOf(shared)] ?? 'SIMULATION';

    return (
        <div className={styles.settingBlock} id={ENV_SECTION_ID} tabIndex={-1} data-testid='env-switch-section'>
            <h3 className={styles.subTitle}>交易環境</h3>
            <dl className={styles.kv}>
                <Item term='永豐（唯讀）' tone={sinopac === false ? 'bad' : sinopac === true ? 'accent' : 'warn'} testId='env-sinopac'>
                    {sinopac === false ? '正式環境' : sinopac === true ? '模擬環境' : '未知'}
                </Item>
                <Item
                    term='玉山'
                    tone={switching ? 'muted' : health && esun.environmentKnown ? envTone(esun.environment) : 'warn'}
                    testId='env-esun'
                >
                    {switching ? `切換至${ESUN_ENV_LABEL[switching]}中…` : !health ? '未連線' : esun.environmentKnown ? ESUN_ENV_LABEL[esun.environment] : '環境未確認'}
                </Item>
            </dl>
            <p className={styles.note} data-testid='env-sinopac-note'>
                永豐模擬／正式由伺服器決定：改 .env 的 SJ_PRODUCTION 後執行 docker compose up -d 重新啟動；手機與桌面都只顯示、不能切換。
            </p>
            <div className={sb.groupCard} role='group' aria-label='玉山環境'>
                {TARGETS.map((t, i) => {
                    const block = blocks[i]!;
                    const profile = esun.configProfiles[t];
                    // 目前環境（擋下原因優先於 'current' 時仍要標示）
                    const active = block === 'current' || (!!health && esun.environmentKnown && esun.environment === t);
                    return (
                        <button
                            key={t}
                            type='button'
                            className={sb.accountRow}
                            aria-pressed={active}
                            disabled={block !== null}
                            aria-describedby={shared ? 'env-switch-block' : undefined}
                            data-testid={t === 'PRODUCTION' ? 'env-option-production' : 'env-option-simulation'}
                            onClick={() => {
                                if (esunSwitchBlock(t) !== null) return;
                                setTarget(t);
                            }}
                        >
                            <span className={sb.accountMain}>
                                <span className={sb.accountName}>玉山 {ESUN_ENV_LABEL[t]}</span>
                                {profile?.available ? (
                                    <span className={sb.accountSub}>{active ? '目前使用中 · ' : ''}{profile.fileName ?? profile.expectedFileName}</span>
                                ) : (
                                    <span className={sb.accountWarn} data-testid='env-option-missing'>
                                        <TriangleAlert className={sb.warnIcon} size={14} aria-hidden='true' focusable='false' />
                                        未提供 {profile?.expectedFileName ?? `esun-config.${t.toLowerCase()}.ini`}（不可選）
                                    </span>
                                )}
                            </span>
                            <span className={routeStyles.envPill[t === 'PRODUCTION' ? 'production' : 'simulation']}>{t === 'PRODUCTION' ? '正式' : '模擬'}</span>
                            {active && <Check className={sb.selectedIcon} size={18} strokeWidth={2.5} aria-hidden='true' focusable='false' />}
                        </button>
                    );
                })}
            </div>
            {shared && (
                <p className={styles.note} id='env-switch-block' role='status' data-testid='env-switch-block'>
                    {esunSwitchBlockText(shared, sharedTarget, health)}
                </p>
            )}
            <EnvSwitchSheet target={target} onClose={() => setTarget(null)} />
        </div>
    );
}

/** 確認面板：正式＝滑動確認＋真實下單警示；模擬＝按鈕確認。切換中不可關閉 */
function EnvSwitchSheet({ target, onClose }: { target: EsunEnvironment | null; onClose: () => void }) {
    const open = target !== null;
    const last = useRef<EsunEnvironment>('SIMULATION');
    if (target) last.current = target;
    const t = target ?? last.current;
    const switching = useEsunEnvSwitching();
    const [probe, setProbe] = useState<BridgeProbe>('checking');
    const [error, setError] = useState<string | null>(null);
    const [resetKey, setResetKey] = useState(0);
    const busy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    // 開啟時重新讀一次 health：bridge 停止時舊的 health 仍在，不能據以判斷「已連線」。
    // 關閉時就把探測結果與錯誤歸零：下次開啟的第一次渲染不會沿用上次的 'ok'（舊 health）
    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setProbe('checking');
        setError(null);
        void esunTradeService.refreshHealth().catch(() => null).then(h => {
            if (!cancelled) setProbe(h ? 'ok' : 'down');
        });
        return () => {
            cancelled = true;
            setProbe('checking');
            setError(null);
        };
    }, [open, t]);

    const block = esunSwitchBlock(t, probe);
    const running = switching !== null;
    const reason = block && block !== 'running' ? esunSwitchBlockText(block, t) : null;
    const prod = t === 'PRODUCTION';
    const file = esunTradeService.getConfigProfiles()[t]?.fileName;

    const confirm = async () => {
        if (busy.current) return;
        busy.current = true;
        setError(null);
        try {
            // runEsunEnvSwitch 在送出前再判斷一次全部擋下條件（含這次開啟面板時的 bridge 探測結果）
            const res = await runEsunEnvSwitch(t, probe);
            if (!mounted.current) return;
            if (res?.outcome === 'switched') {
                onClose();
                return;
            }
            setError(res ? res.error || `無法切換至${ESUN_ENV_LABEL[t]}` : esunSwitchBlockText(esunSwitchBlock(t, probe) ?? 'running', t));
            setResetKey(k => k + 1);
        } finally {
            busy.current = false;
        }
    };

    return (
        <BottomSheet
            open={open}
            onClose={() => { if (!running) onClose(); }}
            dismissible={!running}
            title={`切換玉山至${ESUN_ENV_LABEL[t]}`}
            testId='env-switch-sheet'
        >
            {prod && (
                <InlineNote tone='danger' role='note' testId='env-switch-warning'>
                    {ESUN_PRODUCTION_WARNING}。
                </InlineNote>
            )}
            <p className={sb.note} data-testid='env-switch-detail'>
                玉山 bridge 會改用 {file ?? `esun-config.${t.toLowerCase()}.ini`} 重新登入（約數秒）；之後玉山帳戶、持倉、委託與下單都改為{ESUN_ENV_LABEL[t]}
                {prod ? '' : '，不會動用真實資金'}。永豐不受影響。這個動作不會送出任何委託。
            </p>
            {running && <InlineNote tone='info' role='status' testId='env-switch-running'>玉山環境切換中，請稍候…</InlineNote>}
            {error && <InlineNote tone='danger' role='alert' testId='env-switch-error'>{error}</InlineNote>}
            <SheetFooter>
                <div className={sb.sheetActions}>
                    {prod ? (
                        <SlideToConfirm
                            label='滑動切換至正式環境'
                            tone='danger'
                            testId='env-switch-slide'
                            disabled={block !== null}
                            disabledReason={reason}
                            resetKey={resetKey}
                            onConfirm={() => { void confirm(); }}
                        />
                    ) : (
                        <>
                            <button
                                type='button'
                                className={controls.button.primary}
                                disabled={block !== null}
                                aria-describedby={reason ? 'env-switch-reason' : undefined}
                                onClick={() => { void confirm(); }}
                                data-testid='env-switch-confirm'
                            >
                                {running ? '切換中…' : '確定切換至模擬環境'}
                            </button>
                            {reason && <p className={sb.note} id='env-switch-reason' data-testid='env-switch-reason'>{reason}</p>}
                        </>
                    )}
                    <button type='button' className={controls.button.neutral} disabled={running} onClick={onClose} data-testid='env-switch-cancel'>
                        取消
                    </button>
                </div>
            </SheetFooter>
        </BottomSheet>
    );
}
