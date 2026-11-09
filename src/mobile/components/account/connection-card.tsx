// src/mobile/components/account/connection-card.tsx — 帳戶頁「連線」：永豐串流、玉山 bridge 狀態與重新連線、交易環境（規格 §6.7）
//
// 玉山重新連線（EsunReconnectSection）掛在玉山 bridge 狀態區塊內；交易環境（EnvSwitchSection：永豐唯讀、玉山模擬／正式切換）緊接其後。

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useStreamStatus } from '../../../hooks/use-stream';
import { esunTradeService, type EsunBridgeHealth } from '../../../lib/esun';
import { getEsunStreamStatus } from '../../../lib/esun/stream';
import { getLastHeartbeat, streamConnectionEpoch, type StreamStatus } from '../../../lib/stream';
import { formatClock } from '../../lib/account-format';
import * as styles from '../../styles/account.css';
import { Card, Item, useNow, type Tone } from './account-ui';
import { EnvSwitchSection } from './env-switch-section';
import { EsunReconnectSection } from './esun-reconnect-section';

/** 伺服器資訊與玉山 health 的手動重新檢查冷卻 */
export const RECHECK_COOLDOWN_MS = 10_000;
/** 連線資訊（最後心跳、世代、玉山串流）是同步 getter：以這個間隔重新讀取 */
export const CONNECTION_REFRESH_MS = 2_000;

const STREAM_TEXT: Record<StreamStatus, string> = { live: 'LIVE', connecting: '連線中', down: '中斷', stale: '逾時（無心跳）' };
const STREAM_TONE: Record<StreamStatus, Tone> = { live: 'good', connecting: 'warn', down: 'bad', stale: 'bad' };
const ESUN_STREAM_TEXT: Record<string, string> = { idle: '未啟動', connecting: '連線中', live: 'LIVE', down: '中斷' };

function esunEnvText(h: EsunBridgeHealth): { text: string; tone: Tone } {
    if (h.environment === 'PRODUCTION') return { text: '正式', tone: 'bad' };
    if (h.environment === 'SIMULATION') return { text: '模擬', tone: 'accent' };
    return { text: '環境未確認', tone: 'warn' };
}

function useEsunHealth(): { health: EsunBridgeHealth | null; recheck: () => void; checking: boolean; canRecheck: boolean } {
    const [, force] = useReducer((n: number) => n + 1, 0);
    const [checking, setChecking] = useState(false);
    const [lastCheck, setLastCheck] = useState(0);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => esunTradeService.subscribe(force), []);
    const recheck = useCallback(() => {
        setChecking(true);
        setLastCheck(Date.now());
        void esunTradeService.refreshHealth().catch(() => null).finally(() => {
            if (!mounted.current) return;
            setChecking(false);
            force();
        });
    }, []);
    // 開啟頁面時讀一次（用 esunTradeService 既有的 health 取得方式，不自行 fetch）
    useEffect(() => { recheck(); }, [recheck]);
    const now = useNow(RECHECK_COOLDOWN_MS);
    return { health: esunTradeService.getBridgeHealth(), recheck, checking, canRecheck: !checking && now - lastCheck >= RECHECK_COOLDOWN_MS };
}

export function ConnectionCard() {
    const stream = useStreamStatus();
    const now = useNow(CONNECTION_REFRESH_MS);
    const esun = useEsunHealth();
    const heartbeat = getLastHeartbeat();
    const ago = heartbeat ? Math.max(0, Math.round((now - heartbeat) / 1000)) : null;
    const h = esun.health;
    const esunStream = getEsunStreamStatus();

    return (
        <Card title='連線' testId='account-connection'>
            <h3 className={styles.subTitle}>永豐</h3>
            <dl className={styles.kv}>
                <Item term='行情串流' tone={STREAM_TONE[stream]} testId='conn-stream'>{STREAM_TEXT[stream]}</Item>
                <Item term='最後心跳'>{formatClock(heartbeat)}{ago !== null ? `（${ago} 秒前）` : ''}</Item>
                <Item term='連線世代'>{streamConnectionEpoch()}</Item>
            </dl>
            <h3 className={styles.subTitle}>玉山 bridge</h3>
            <div data-testid='conn-esun-block'>
                {!h ? (
                    <p className={styles.note} data-testid='conn-esun-none'>{esun.checking ? '檢查中…' : '未連線或未設定玉山。'}</p>
                ) : (
                    <dl className={styles.kv} data-testid='conn-esun'>
                        <Item term='設定' tone={h.configured ? 'normal' : 'warn'}>{h.configured ? '已設定' : '未設定'}</Item>
                        <Item term='登入' tone={h.loginLocked ? 'bad' : h.loggedIn ? 'good' : 'warn'}>
                            {h.loginLocked ? `登入已鎖定${h.loginLockReason ? `（${h.loginLockReason}）` : ''}` : h.loggedIn ? '已登入' : h.loginError ? `未登入（${h.loginError}）` : '未登入'}
                        </Item>
                        <Item term='環境' tone={esunEnvText(h).tone}>{esunEnvText(h).text}</Item>
                        <Item term='券商 session' tone={h.sessionExpired ? 'bad' : 'normal'}>{h.sessionExpired ? '已失效（委託會被拒絕）' : '有效'}</Item>
                        <Item term='券商 WebSocket' tone={h.wsConnected ? 'good' : 'warn'}>{h.wsConnected === undefined ? '—' : h.wsConnected ? '已連線' : '未連線'}</Item>
                    </dl>
                )}
                <dl className={styles.kv}>
                    <Item term='回報串流'>{ESUN_STREAM_TEXT[esunStream] ?? esunStream}</Item>
                </dl>
                <div className={styles.actions}>
                    <button type='button' className={styles.smallButton} disabled={!esun.canRecheck} onClick={esun.recheck}>重新檢查玉山</button>
                </div>
                <EsunReconnectSection />
            </div>
            <EnvSwitchSection />
        </Card>
    );
}
