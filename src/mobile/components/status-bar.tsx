// src/mobile/components/status-bar.tsx — 全域狀態列 v2（每頁頂端、位於捲動容器之外；規格 §5.2、設計規格 §6.5）
//
// ┌────────────────────────────────────────────────────┐
// │ (● LIVE) │ 永豐 [正式] · 9A95-***4567 ⌄ │ 🔓 風控 │
// └────────────────────────────────────────────────────┘
// - 不透明 panel（承載連線、環境、鎖單，不用半透明材質）；非 LIVE 或 ResumeGate 非 ready 時整條淡染狀態色；
//   正式環境下緣 2px danger。
// - 連線燈號：useStreamStatus() 與 ResumeGate。ResumeGate 非 ready 時優先顯示（同步中／資料過期／未恢復）。
//   點擊展開連線詳情；stale-data 時詳情面板提供 ResumeGateNote（勾選「我了解委託／持倉資料可能過期」＋「重試同步」）。
//   串流中斷過且尚未回到 LIVE 時，詳情面板顯示「伺服器未連線」提示（ServerDownHint；黏著判斷在常駐的 StatusBar 追蹤，
//   面板關閉時不 render 子元件）。狀態列本身不加任何文字。
// - 券商＋環境＋帳戶：依目前商品的市場槽位（股票 selectedStock／期權 selectedFutures；該槽位未選擇時
//   顯示「未選擇證券帳戶」／「未選擇期貨帳戶」，不借用另一個市場的帳戶）；商品未知時才先看證券、再看期貨；
//   環境實心小膠囊：「正式」danger、「模擬」accent、「環境未確認」amber。點擊開啟帳戶切換面板。
// - 風控鎖：鎖定時 danger 實心「已鎖單」（lucide 鎖頭）；未鎖定時點擊立即鎖定，解鎖需滑動確認。此鎖只對本裝置有效。
//   鎖單改變與連線狀態（維持 2 秒以上）以視覺隱藏的 aria-live 宣告。
// - 通知鈴（風控左側）：IconButton＋未讀數徽章（無障礙名稱「通知，N 則未讀」，徽章只是視覺）。來源是 src/lib/trade.ts 的
//   記憶體通知紀錄；未讀＝ts 晚於上次開啟（或關閉）通知中心的時間，這個時間只放記憶體（紀錄本身也只在記憶體，重新整理後
//   一起歸零），通知內容不寫入任何儲存。點擊開啟通知中心（components/notice-center-sheet.tsx，第一次開啟才掛載、延遲載入：
//   retryableLazy＋ModuleErrorBoundary＋SheetLoadError）。首屏只有鈴與未讀數的訂閱。

import { ChevronDown, createLucideIcon, Lock, LockOpen } from 'lucide-react';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAccounts } from '../../lib/account-store';
import { useContract } from '../../lib/contracts-cache';
import { getEsunStreamStatus } from '../../lib/esun/stream';
import { routeEnvText } from '../../lib/order-route';
import { setRiskSettings, useRiskSettings } from '../../lib/risk';
import { getLastHeartbeat, streamConnectionEpoch, type StreamStatus } from '../../lib/stream';
import { getNoticeLog, isFuturesContract, subscribeNoticeLog } from '../../lib/trade';
import { usePrivacyMode } from '../../lib/privacy';
import { useStreamStatus } from '../../hooks/use-stream';
import { useResumeGate } from '../hooks/use-resume-gate';
import type { ResumeGateState } from '../lib/resume-gate';
import type { ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { loadNoticeCenterSheet } from '../lib/deferred-modules';
import { trackServerLost } from '../lib/server-down-hint';
import { useMobileUi } from '../lib/mobile-store';
import * as controls from '../styles/controls.css';
import { fill, srOnly } from '../styles/primitives.css';
import * as routeStyles from '../styles/route-badge.css';
import * as styles from '../styles/status-bar.css';
import { IconButton } from '../ui/icon-button';
import { AccountSwitchSheet, mobileAccountLabel } from './account-switch-sheet';
import { BottomSheet } from './bottom-sheet';
import { ResumeGateNote } from './resume-gate-note';
import { ModuleErrorBoundary, retryableLazy, SheetLoadError } from './route-error-boundary';
import { routeTone, useOrderRoute } from './route-badge';
import { ServerDownHint } from './server-down-hint';
import { SlideToConfirm } from './slide-to-confirm';

/**
 * 鈴圖示：lucide 早期版本 bell 的路徑（合併成一段），以 lucide-react 的 createLucideIcon 建立（與其他圖示同一套渲染）。
 * 不用 lucide-react 目前的 Bell：路徑較長，首屏多約 200 bytes gzip，而首屏預算只剩數百 bytes（設計規格 §13）。
 */
const BellIcon = createLucideIcon('bell', [['path', { d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9m4.3 13a1.94 1.94 0 0 0 3.4 0', key: 'b' }]]);

const NoticeCenterSheet = retryableLazy(() => loadNoticeCenterSheet().then(m => m.NoticeCenterSheet));
const resetNoticeSheet = () => { NoticeCenterSheet.reset(); };

/** 通知鈴的無障礙名稱：「通知，3 則未讀」；沒有未讀時「通知」 */
export function noticeBellLabel(unread: number): string {
    return unread > 0 ? `通知，${unread} 則未讀` : '通知';
}

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

/**
 * 狀態列顯示哪個帳戶（純函式）：商品市場已知時只看對應槽位（股票 selectedStock、期權 selectedFutures），
 * 該槽位未選擇就回傳 null 與對應的「未選擇證券／期貨帳戶」，不借用另一個市場的帳戶（避免誤以為會送往該帳戶）；
 * 商品未知時才先看證券、再看期貨。
 */
export function statusBarAccount<A>(
    market: 'stock' | 'futures' | null,
    slots: { selectedStock: A | null | undefined; selectedFutures: A | null | undefined },
): { account: A | null; emptyText: string } {
    if (market === 'stock') return { account: slots.selectedStock ?? null, emptyText: '未選擇證券帳戶' };
    if (market === 'futures') return { account: slots.selectedFutures ?? null, emptyText: '未選擇期貨帳戶' };
    return { account: slots.selectedStock ?? slots.selectedFutures ?? null, emptyText: '未選擇帳戶' };
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

function ConnectionDetails({ open, onClose, stream, gate, serverLost }: { open: boolean; onClose: () => void; stream: StreamStatus; gate: ResumeGateSnapshot; serverLost: boolean }) {
    const resume = gate.state;
    const message = gate.message;
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
                {serverLost && <ServerDownHint testId='connection-server-down' />}
                <ResumeGateNote gate={gate} showReason={false} testId='connection-stale' />
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

/** 連線狀態維持這麼久才宣告（避免閃斷時連續播報） */
export const CONNECTION_ANNOUNCE_DELAY_MS = 2_000;
/**
 * 鎖單變化稍後才宣告：從「解除鎖單」面板解除時，面板關閉與殼層移除 inert／aria-hidden 在下一次提交才發生，
 * 立即更新的 live region 仍在 aria-hidden 之下，報讀器不會念。
 */
export const LOCK_ANNOUNCE_DELAY_MS = 300;

export const LOCK_ANNOUNCE_TEXT = { locked: '已鎖單（只對本裝置有效）', unlocked: '已解除鎖單' } as const;

/**
 * 視覺隱藏的 aria-live 文字：鎖單狀態「改變」時宣告；連線狀態改變且維持 CONNECTION_ANNOUNCE_DELAY_MS 以上才宣告。
 * 首次渲染不宣告；即時價格不放 aria-live（設計規格 §11）。
 */
function useStatusAnnouncements(locked: boolean, connectionLabel: string): { lockText: string; connectionText: string } {
    const [lockText, setLockText] = useState('');
    const [connectionText, setConnectionText] = useState('');
    const lastLocked = useRef(locked);
    const announcedLabel = useRef(connectionLabel);

    useEffect(() => {
        if (lastLocked.current === locked) return undefined;
        lastLocked.current = locked;
        const timer = setTimeout(() => setLockText(locked ? LOCK_ANNOUNCE_TEXT.locked : LOCK_ANNOUNCE_TEXT.unlocked), LOCK_ANNOUNCE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [locked]);

    useEffect(() => {
        if (announcedLabel.current === connectionLabel) return undefined;
        const timer = setTimeout(() => {
            announcedLabel.current = connectionLabel;
            setConnectionText(`連線狀態：${connectionLabel}`);
        }, CONNECTION_ANNOUNCE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [connectionLabel]);

    return { lockText, connectionText };
}

export function StatusBar() {
    const stream = useStreamStatus();
    const resume = useResumeGate();
    const risk = useRiskSettings();
    const accounts = useAccounts();
    const ui = useMobileUi();
    const priv = usePrivacyMode();
    const contract = useContract(ui.currentCode);
    const [sheet, setSheet] = useState<'connection' | 'account' | 'unlock' | 'notice' | null>(null);
    // 未讀通知：ts 晚於上次開啟／關閉通知中心（seenAt > 0 也表示開啟過：之後保持掛載，開關動畫正常）
    const notices = useSyncExternalStore(subscribeNoticeLog, getNoticeLog);
    const [seenAt, setSeenAt] = useState(0);
    const unread = notices.filter(n => n.ts > seenAt).length;

    const { account, emptyText } = statusBarAccount(contract ? (isFuturesContract(contract) ? 'futures' : 'stock') : null, accounts);
    const route = useOrderRoute(account);
    const tone = routeTone(route);
    const light = connectionLight(stream, resume.state);
    const serverLost = trackServerLost(stream);
    const announce = useStatusAnnouncements(risk.locked, light.label);
    const close = () => {
        if (sheet === 'notice') setSeenAt(Date.now());
        setSheet(null);
    };
    const openNotices = () => {
        setSeenAt(Date.now());
        setSheet('notice');
    };
    // 正式環境：狀態列下緣 2px danger（目前路由 simulation === false；沒有帳戶或環境未知不標示）
    const env = account && route ? tone : undefined;

    return (
        <>
            <header className={styles.bar} data-testid='mobile-status-bar' data-tone={light.tone} data-env={env}>
                <button
                    type='button'
                    className={styles.connection}
                    onClick={() => setSheet('connection')}
                    aria-label={`連線狀態：${light.label}`}
                    data-testid='status-connection'
                    data-tone={light.tone}
                >
                    <span className={styles.connectionPill[light.tone]}>
                        <span className={light.tone === 'syncing' ? styles.syncRing : styles.dot[light.tone]} aria-hidden='true' />
                        <span>{light.label}</span>
                    </span>
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
                            <span className={styles.routePill}>
                                <span>{route.broker}</span>
                                {' '}
                                <span className={routeStyles.envPill[tone]}>{routeEnvText(route.simulation)}</span>
                                <span className={styles.routeText}>
                                    {' · '}
                                    {mobileAccountLabel(account, priv)}
                                </span>
                                <ChevronDown className={styles.chevron} size={14} aria-hidden='true' focusable='false' />
                            </span>
                        )
                        : accounts.loaded
                            ? (
                                <span className={styles.routeEmpty} data-testid='status-route-empty'>
                                    <span className={styles.routeText}>{emptyText}</span>
                                    <ChevronDown className={styles.chevron} size={14} aria-hidden='true' focusable='false' />
                                </span>
                            )
                            : <span className={styles.routeLoading} data-testid='status-route-empty'>帳戶載入中…</span>}
                </button>
                <IconButton ariaLabel={noticeBellLabel(unread)} icon={BellIcon} onClick={openNotices} testId='status-notices'>
                    {unread > 0 && <span className={styles.badge} aria-hidden='true'>{unread > 99 ? '99+' : unread}</span>}
                </IconButton>
                <button
                    type='button'
                    className={styles.risk}
                    onClick={() => (risk.locked ? setSheet('unlock') : setRiskSettings({ locked: true }))}
                    aria-label={risk.locked ? '已鎖單，點擊解除' : '風控：點擊立即鎖單'}
                    data-testid='status-risk'
                    data-locked={risk.locked ? 'true' : 'false'}
                >
                    {risk.locked
                        ? (
                            <span className={`${styles.riskLocked} ${fill.danger.strong}`}>
                                <Lock size={14} strokeWidth={2.25} aria-hidden='true' focusable='false' />
                                已鎖單
                            </span>
                        )
                        : (
                            <span className={styles.riskOpen}>
                                <LockOpen size={16} aria-hidden='true' focusable='false' />
                                風控
                            </span>
                        )}
                </button>
                <span className={srOnly} aria-live='polite' data-testid='status-lock-live'>{announce.lockText}</span>
                <span className={srOnly} aria-live='polite' data-testid='status-connection-live'>{announce.connectionText}</span>
            </header>
            <ConnectionDetails open={sheet === 'connection'} onClose={close} stream={stream} gate={resume} serverLost={serverLost} />
            <AccountSwitchSheet open={sheet === 'account'} onClose={close} />
            <RiskUnlockSheet open={sheet === 'unlock'} onClose={close} />
            {seenAt > 0 && (
                <ModuleErrorBoundary
                    onRetry={resetNoticeSheet}
                    fallback={props => <SheetLoadError {...props} open={sheet === 'notice'} onClose={close} testId='notice-load-error' />}
                >
                    <Suspense fallback={null}>
                        <NoticeCenterSheet open={sheet === 'notice'} onClose={close} />
                    </Suspense>
                </ModuleErrorBoundary>
            )}
        </>
    );
}
