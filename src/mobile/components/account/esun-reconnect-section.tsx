// src/mobile/components/account/esun-reconnect-section.tsx — 帳戶頁「玉山重新連線」區塊（規格 Phase 2、§6.7）
//
// 由 connection-card.tsx 掛在玉山 bridge 狀態區塊內；對外介面固定為無 props 的 EsunReconnectSection。
// - 只在有玉山帳戶時顯示（useAccounts 中有玉山帳戶），否則回 null。
// - 顯示目前狀態（已登入／未登入／登入失效／鎖定、模擬／正式環境）。
// - 按下「重新連線玉山」先開確認面板（role=alertdialog），提醒密碼錯 3 次會鎖帳；確定後才呼叫
//   lib/esun-reconnect 的 runEsunReconnect()（esunTradeService.reconnect()，絕不帶 force、不切換環境）。
// - 60 秒冷卻（模組層）；進行中、bridge 未連線、loginLocked 時停用並說明（強制重試請到桌面版處理）；
//   與桌面相同，只有登入失效（未登入或 session 過期）時才需要、也才允許重新連線。
// - 成功但讀不到 health：顯示「狀態確認中」並依 ESUN_HEALTH_RECHECK_DELAYS 重讀 health。

import { useEffect, useReducer, useRef, useState } from 'react';
import { useAccounts } from '../../../lib/account-store';
import { esunTradeService, isEsunAccount, type EsunBridgeHealth } from '../../../lib/esun';
import {
    ESUN_HEALTH_RECHECK_DELAYS,
    ESUN_RECONNECT_WARNING,
    esunReconnectBlock,
    esunReconnectCooldownSec,
    esunSessionLost,
    runEsunReconnect,
    useEsunReconnectState,
    type EsunReconnectBlock,
} from '../../lib/esun-reconnect';
import * as styles from '../../styles/account.css';
import * as css from '../../styles/device-settings.css';
import { Item, useNow, type Tone } from './account-ui';

function loginStatus(h: EsunBridgeHealth): { text: string; tone: Tone } {
    if (h.loginLocked) return { text: '登入已鎖定', tone: 'bad' };
    if (h.sessionExpired) return { text: '登入失效（券商 session 已過期）', tone: 'bad' };
    if (!h.loggedIn) return { text: h.loginError ? `未登入（${h.loginError}）` : '未登入', tone: 'warn' };
    return { text: '已登入', tone: 'good' };
}

function envStatus(h: EsunBridgeHealth): { text: string; tone: Tone } {
    if (h.environment === 'PRODUCTION') return { text: '正式環境', tone: 'bad' };
    if (h.environment === 'SIMULATION') return { text: '模擬環境', tone: 'accent' };
    return { text: '環境未確認', tone: 'warn' };
}

function blockText(block: EsunReconnectBlock, h: EsunBridgeHealth | null, cooldownSec: number): string {
    switch (block) {
        case 'running': return '重新連線中…';
        case 'switching': return '玉山環境切換中，完成後才能重新連線。';
        case 'no-bridge': return '玉山 bridge 未連線，無法重新連線。';
        case 'locked':
            return `登入熔斷鎖定中${h?.loginLockReason ? `（${h.loginLockReason}）` : ''}。手機不提供強制重試，請到桌面版確認設定後處理。`;
        case 'cooldown': return `請稍候 ${cooldownSec} 秒再試（避免觸發玉山登入次數限制）。`;
        case 'not-needed': return '目前登入正常，不需要重新連線。';
    }
}

export function EsunReconnectSection() {
    const { accounts } = useAccounts();
    const hasEsun = (accounts ?? []).some(a => isEsunAccount(a));
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => esunTradeService.subscribe(rerender), []);
    const reconnect = useEsunReconnectState();
    const now = useNow(1_000);
    const [confirming, setConfirming] = useState(false);
    const [checkingHealth, setCheckingHealth] = useState(false);
    const confirmRef = useRef<HTMLDivElement>(null);
    const mounted = useRef(true);
    const recheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (recheckTimer.current) clearTimeout(recheckTimer.current);
        };
    }, []);

    // 開啟確認面板時把焦點移到面板本身（不聚焦「確定」，避免誤觸 Enter）
    useEffect(() => {
        if (confirming) confirmRef.current?.focus?.();
    }, [confirming]);

    const health = esunTradeService.getBridgeHealth();
    const block = esunReconnectBlock(health, now, reconnect);
    const cooldownSec = esunReconnectCooldownSec(now, reconnect);

    // 確認面板開著時條件改變（鎖定、冷卻、恢復正常、bridge 斷線）：收起面板
    useEffect(() => {
        if (confirming && block !== null) setConfirming(false);
    }, [confirming, block]);

    if (!hasEsun) return null;

    const scheduleRecheck = (attempt: number) => {
        if (!mounted.current) return;
        if (attempt >= ESUN_HEALTH_RECHECK_DELAYS.length) {
            setCheckingHealth(false);
            return;
        }
        recheckTimer.current = setTimeout(() => {
            void esunTradeService.refreshHealth().catch(() => null).then(h => {
                if (!mounted.current) return;
                if (h) {
                    setCheckingHealth(false);
                    rerender();
                } else {
                    scheduleRecheck(attempt + 1);
                }
            });
        }, ESUN_HEALTH_RECHECK_DELAYS[attempt]);
    };

    const onConfirm = async () => {
        setConfirming(false);
        const res = await runEsunReconnect();
        if (!mounted.current || !res) return;
        if (res.ok && !res.health) {
            setCheckingHealth(true);
            scheduleRecheck(0);
        } else {
            setCheckingHealth(false);
        }
        rerender();
    };

    const login = health && !checkingHealth ? loginStatus(health) : null;
    const env = health ? envStatus(health) : null;
    const lost = !checkingHealth && esunSessionLost(health);

    return (
        <div className={styles.settingBlock} data-testid='esun-reconnect-section'>
            <h3 className={styles.subTitle}>玉山重新連線</h3>
            {health ? (
                <dl className={styles.kv}>
                    <Item term='登入狀態' tone={login?.tone ?? 'muted'} testId='esun-reconnect-login'>{login?.text ?? '狀態確認中…'}</Item>
                    {env && <Item term='環境' tone={env.tone} testId='esun-reconnect-env'>{env.text}</Item>}
                </dl>
            ) : (
                <p className={styles.note}>玉山 bridge 未連線。</p>
            )}
            {lost && <p className={css.alertText} role='alert'>登入失效期間玉山委託一律不會送出，帳務查詢也可能失敗。</p>}
            {checkingHealth && <p className={styles.note} role='status' data-testid='esun-health-confirming'>玉山已重新登入，狀態確認中…</p>}
            {confirming ? (
                <div
                    ref={confirmRef}
                    className={css.confirmBox}
                    role='alertdialog'
                    aria-labelledby='esun-reconnect-confirm-title'
                    aria-describedby='esun-reconnect-confirm-warn'
                    tabIndex={-1}
                    data-testid='esun-reconnect-confirm-box'
                >
                    <p className={css.confirmTitle} id='esun-reconnect-confirm-title'>確定要重新連線玉山證券？</p>
                    <p className={css.confirmText}>會以 bridge 目前的設定重新登入，不切換模擬／正式環境。送出後 60 秒內不能再按。</p>
                    <p className={css.confirmWarn} id='esun-reconnect-confirm-warn'>{ESUN_RECONNECT_WARNING}。</p>
                    <div className={css.confirmActions}>
                        <button type='button' className={css.cancelButton} onClick={() => setConfirming(false)} data-testid='esun-reconnect-cancel'>
                            取消
                        </button>
                        <button
                            type='button'
                            className={css.confirmButton}
                            disabled={block !== null}
                            onClick={() => { void onConfirm(); }}
                            data-testid='esun-reconnect-confirm'
                        >
                            確定重新連線
                        </button>
                    </div>
                </div>
            ) : (
                <div className={styles.actions}>
                    <button
                        type='button'
                        className={styles.smallButton}
                        disabled={block !== null}
                        aria-busy={reconnect.running}
                        aria-describedby={block && block !== 'running' ? 'esun-reconnect-block' : undefined}
                        onClick={() => setConfirming(true)}
                        data-testid='esun-reconnect'
                    >
                        {reconnect.running ? '重新連線中…' : cooldownSec > 0 ? `重新連線玉山（${cooldownSec} 秒）` : '重新連線玉山'}
                    </button>
                </div>
            )}
            {block && block !== 'running' && (
                <p className={block === 'locked' ? css.alertText : styles.note} id='esun-reconnect-block' data-testid='esun-reconnect-block'>
                    {blockText(block, health, cooldownSec)}
                </p>
            )}
        </div>
    );
}
