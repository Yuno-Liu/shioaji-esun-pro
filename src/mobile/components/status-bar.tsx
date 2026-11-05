// src/mobile/components/status-bar.tsx — 全域狀態列（每頁頂端，sticky；規格 §5.2）
//
// ┌──────────────────────────────────────────────┐
// │ ● LIVE │ 永豐 正式 · 9A95-***4567 ▾ │ 🔓 風控 │
// └──────────────────────────────────────────────┘
// - 連線燈號：useStreamStatus() 與 ResumeGate。ResumeGate 非 ready 時優先顯示（同步中／資料過期／未恢復）。
//   點擊展開連線詳情。
// - 券商＋環境＋帳戶：依目前商品的市場槽位（股票 selectedStock／期貨 selectedFutures）；
//   「正式」用 danger 色框、「模擬」用 accent、環境未知顯示「環境未確認」。點擊開啟帳戶切換面板。
// - 風控鎖：鎖定時顯示紅色「🔒 已鎖單」；未鎖定時點擊立即鎖定，解鎖需滑動確認。此鎖只對本裝置有效。

import { useState } from 'react';
import { useAccounts } from '../../lib/account-store';
import { useContract } from '../../lib/contracts-cache';
import { getEsunStreamStatus } from '../../lib/esun/stream';
import { routeEnvText } from '../../lib/order-route';
import { setRiskSettings, useRiskSettings } from '../../lib/risk';
import { getLastHeartbeat, streamConnectionEpoch, type StreamStatus } from '../../lib/stream';
import { isFuturesContract } from '../../lib/trade';
import { usePrivacyMode } from '../../lib/privacy';
import { useStreamStatus } from '../../hooks/use-stream';
import { useResumeGate } from '../hooks/use-resume-gate';
import type { ResumeGateState } from '../lib/resume-gate';
import { retryResume } from '../lib/resume-gate-runtime';
import { useMobileUi } from '../lib/mobile-store';
import * as controls from '../styles/controls.css';
import * as styles from '../styles/status-bar.css';
import { AccountSwitchSheet, mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet } from './bottom-sheet';
import { routeTone, useOrderRoute } from './route-badge';
import { SlideToConfirm } from './slide-to-confirm';

export type LightTone = 'live' | 'connecting' | 'down' | 'syncing';

export interface ConnectionLight {
    tone: LightTone;
    label: string;
}

/** 連線燈號（純函式）：ResumeGate 非 ready 優先，其次是串流狀態 */
export function connectionLight(stream: StreamStatus, resume: ResumeGateState): ConnectionLight {
    if (resume === 'resyncing') return { tone: 'syncing', label: '同步中' };
    if (resume === 'stale-data') return { tone: 'connecting', label: '資料過期' };
    if (resume === 'failed') return { tone: 'down', label: '未恢復' };
    if (stream === 'live') return { tone: 'live', label: 'LIVE' };
    if (stream === 'connecting') return { tone: 'connecting', label: '連線中' };
    return { tone: 'down', label: '中斷' };
}

const STREAM_TEXT: Record<StreamStatus, string> = { live: 'LIVE', connecting: '連線中', down: '中斷', stale: '逾時（無心跳）' };
const RESUME_TEXT: Record<ResumeGateState, string> = { ready: '已同步', resyncing: '同步中', 'stale-data': '資料可能過期', failed: '連線未恢復' };
const ESUN_STREAM_TEXT: Record<string, string> = { idle: '未啟動', connecting: '連線中', live: 'LIVE', down: '中斷' };

function formatTime(ms: number): string {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ConnectionDetails({ open, onClose, stream, resume, message }: { open: boolean; onClose: () => void; stream: StreamStatus; resume: ResumeGateState; message: string | null }) {
    return (
        <BottomSheet open={open} onClose={onClose} title='連線狀態' testId='connection-sheet'>
            <dl className={styles.detailList}>
                <dt className={styles.detailTerm}>永豐串流</dt>
                <dd className={styles.detailValue}>{STREAM_TEXT[stream]}</dd>
                <dt className={styles.detailTerm}>最後心跳</dt>
                <dd className={styles.detailValue}>{formatTime(getLastHeartbeat())}</dd>
                <dt className={styles.detailTerm}>連線世代</dt>
                <dd className={styles.detailValue}>{streamConnectionEpoch()}</dd>
                <dt className={styles.detailTerm}>玉山回報串流</dt>
                <dd className={styles.detailValue}>{ESUN_STREAM_TEXT[getEsunStreamStatus()] ?? getEsunStreamStatus()}</dd>
                <dt className={styles.detailTerm}>回前景同步</dt>
                <dd className={styles.detailValue}>{RESUME_TEXT[resume]}</dd>
            </dl>
            {message && <p className={styles.note}>{message}</p>}
            <div className={styles.sheetActions}>
                {resume === 'stale-data' && (
                    <button type='button' className={controls.button.primary} onClick={() => retryResume()}>重試同步</button>
                )}
                {resume === 'failed' && (
                    <button type='button' className={controls.button.primary} onClick={() => location.reload()}>重新整理頁面</button>
                )}
            </div>
        </BottomSheet>
    );
}

function RiskUnlockSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <BottomSheet open={open} onClose={onClose} title='解除鎖單' testId='risk-unlock-sheet'>
            <p className={styles.note}>解除後可以再下新單。此鎖定只對本裝置（這個瀏覽器）有效，不會影響桌面或其他裝置。</p>
            <div className={styles.sheetActions}>
                <SlideToConfirm
                    label='滑動解除鎖單'
                    tone='danger'
                    testId='risk-unlock-slide'
                    onConfirm={() => {
                        setRiskSettings({ locked: false });
                        onClose();
                    }}
                />
            </div>
        </BottomSheet>
    );
}

export function StatusBar() {
    const stream = useStreamStatus();
    const resume = useResumeGate();
    const risk = useRiskSettings();
    const accounts = useAccounts();
    const ui = useMobileUi();
    const priv = usePrivacyMode();
    const contract = useContract(ui.currentCode);
    const [sheet, setSheet] = useState<'connection' | 'account' | 'unlock' | null>(null);

    // 依目前商品的市場槽位顯示；商品未知時先看證券槽位
    const futures = contract ? isFuturesContract(contract) : false;
    const account = futures ? accounts.selectedFutures : (accounts.selectedStock ?? accounts.selectedFutures);
    const route = useOrderRoute(account);
    const tone = routeTone(route);
    const light = connectionLight(stream, resume.state);
    const close = () => setSheet(null);

    return (
        <>
            <header className={styles.bar} data-testid='mobile-status-bar'>
                <button
                    type='button'
                    className={styles.connection}
                    onClick={() => setSheet('connection')}
                    aria-label={`連線狀態：${light.label}`}
                    data-testid='status-connection'
                    data-tone={light.tone}
                >
                    <span className={styles.dot[light.tone]} aria-hidden='true' />
                    <span className={styles.lightText[light.tone]}>{light.label}</span>
                </button>
                <button
                    type='button'
                    className={styles.route}
                    onClick={() => setSheet('account')}
                    aria-label='切換帳戶'
                    data-testid='status-route'
                >
                    {account && route
                        ? (
                            <span className={`${controls.routeBadge[tone]} ${styles.routeText}`}>
                                {route.broker} {routeEnvText(route.simulation)}
                                {' · '}
                                {mobileAccountLabel(account, priv)} ▾
                            </span>
                        )
                        : <span className={styles.routeText}>{accounts.loaded ? '未選擇帳戶 ▾' : '帳戶載入中…'}</span>}
                </button>
                <button
                    type='button'
                    className={styles.risk}
                    onClick={() => (risk.locked ? setSheet('unlock') : setRiskSettings({ locked: true }))}
                    aria-label={risk.locked ? '已鎖單，點擊解除' : '風控：點擊立即鎖單'}
                    data-testid='status-risk'
                >
                    {risk.locked
                        ? <span className={styles.riskLocked}>🔒 已鎖單</span>
                        : <span className={styles.riskOpen}>🔓 風控</span>}
                </button>
            </header>
            <ConnectionDetails open={sheet === 'connection'} onClose={close} stream={stream} resume={resume.state} message={resume.message} />
            <AccountSwitchSheet open={sheet === 'account'} onClose={close} />
            <RiskUnlockSheet open={sheet === 'unlock'} onClose={close} />
        </>
    );
}
