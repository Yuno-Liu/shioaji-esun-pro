// src/mobile/components/account/risk-card.tsx — 帳戶頁「風控」（規格 §6.7、§10）
//
// 一鍵鎖單、單筆上限、當日虧損上限。「手動下單確認」在手機版一律鎖定開啟、不可關閉（R4）；
// 這裡**不寫入** confirmManualOrders：它在與桌面共用的 sj-pro-risk 裡，由 src/mobile/start.ts 的 pinManualOrderConfirm()
// 在手機啟動時設為開啟並維持（同一瀏覽器開啟的桌面網頁版也會因此開啟）。
// 鎖定同樣存在這個瀏覽器的 sj-pro-risk：同一瀏覽器的桌面網頁版也會套用，不跨裝置、沒有伺服器端總開關（§10.6）。

import { Lock, LockOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePrivacyMoney } from '../../../lib/privacy';
import { setRiskSettings, useRiskSettings } from '../../../lib/risk';
import { BottomSheet } from '../bottom-sheet';
import { SlideToConfirm } from '../slide-to-confirm';
import * as controls from '../../styles/controls.css';
import * as styles from '../../styles/account.css';
import { Card, Switch } from './account-ui';

function parseLimit(raw: string): number | null {
    const s = raw.trim().replace(/,/g, '');
    if (s === '') return 0;
    if (!/^\d{1,9}$/.test(s)) return null;
    return Number(s);
}

function LimitInput({ label, hint, value, onCommit, masked, testId }: {
    label: string;
    hint: string;
    value: number;
    onCommit: (v: number) => void;
    masked: boolean;
    testId: string;
}) {
    const [draft, setDraft] = useState(String(value || ''));
    const [invalid, setInvalid] = useState(false);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) setDraft(String(value || ''));
    }, [value]);
    const commit = () => {
        editing.current = false;
        const v = parseLimit(draft);
        if (v === null) {
            setInvalid(true);
            setDraft(String(value || ''));
            return;
        }
        setInvalid(false);
        if (v !== value) onCommit(v);
        setDraft(String(v || ''));
    };
    return (
        <div className={styles.settingRow}>
            <span className={styles.settingLabel}>
                <span>{label}</span>
                <span className={styles.settingHint}>{invalid ? '請輸入 0 或正整數（0＝不限制）' : hint}</span>
            </span>
            <input
                className={styles.numberInput}
                type={masked ? 'password' : 'text'}
                inputMode='numeric'
                pattern='[0-9]*'
                enterKeyHint='done'
                autoComplete='off'
                aria-label={label}
                aria-invalid={invalid}
                placeholder='不限制'
                value={masked ? (value ? '•••••' : '') : draft}
                disabled={masked}
                onFocus={() => { editing.current = true; }}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as { blur?: () => void }).blur?.(); }}
                data-testid={testId}
            />
        </div>
    );
}

function RiskUnlockSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    return (
        <BottomSheet open={open} onClose={onClose} title='解除鎖單' testId='account-risk-unlock-sheet'>
            <p className={styles.note}>解除後可以再下新單。此鎖定只對本裝置（這個瀏覽器）有效，不會影響桌面或其他裝置。</p>
            <div className={styles.actions}>
                <SlideToConfirm
                    label='滑動解除鎖單'
                    tone='danger'
                    testId='account-risk-unlock-slide'
                    onConfirm={() => {
                        setRiskSettings({ locked: false });
                        onClose();
                    }}
                />
            </div>
        </BottomSheet>
    );
}

export function RiskCard() {
    const risk = useRiskSettings();
    const privMoney = usePrivacyMoney();
    const [unlockOpen, setUnlockOpen] = useState(false);
    useEffect(() => { if (!risk.locked) setUnlockOpen(false); }, [risk.locked]);

    return (
        <Card title='風控' testId='account-risk'>
            {risk.locked ? (
                <div className={styles.lockState.locked} role='status' data-testid='risk-lock-state'>
                    <Lock size={18} aria-hidden='true' /> 已鎖單：所有新單都會被擋下
                </div>
            ) : (
                <div className={styles.lockState.open} data-testid='risk-lock-state'>
                    <LockOpen size={18} aria-hidden='true' /> 未鎖單
                </div>
            )}
            <div className={styles.actions}>
                {risk.locked ? (
                    <button type='button' className={controls.button.neutral} onClick={() => setUnlockOpen(true)} data-testid='risk-unlock'>解除鎖單…</button>
                ) : (
                    <button type='button' className={controls.button.danger} onClick={() => setRiskSettings({ locked: true })} data-testid='risk-lock'>立即鎖單</button>
                )}
            </div>
            <p className={styles.deviceOnly} data-testid='risk-device-only'>
                此鎖定只對本裝置有效（存在這個瀏覽器，同一瀏覽器開啟的桌面網頁版也會套用）；不會同步到其他裝置或其他瀏覽器，也沒有伺服器端總開關。
            </p>

            <div className={styles.settingRow}>
                <span className={styles.settingLabel}>
                    <span>啟用下單限制</span>
                    <span className={styles.settingHint}>單筆上限與當日虧損上限</span>
                </span>
                <Switch checked={risk.enabled} label='啟用下單限制' onChange={v => setRiskSettings({ enabled: v })} testId='risk-enabled' />
            </div>
            <LimitInput
                label='單筆上限（張／口）'
                hint='0＝不限制；零股以張的比例計'
                value={risk.maxQty}
                masked={false}
                onCommit={v => setRiskSettings({ maxQty: v })}
                testId='risk-max-qty'
            />
            <LimitInput
                label='當日虧損上限（元）'
                hint={privMoney ? '關閉遮蔽金額後可編輯' : '0＝不限制；達上限後封鎖新單'}
                value={risk.maxDailyLoss}
                masked={privMoney}
                onCommit={v => setRiskSettings({ maxDailyLoss: v })}
                testId='risk-max-loss'
            />
            <div className={styles.settingRow} data-testid='risk-manual-confirm'>
                <span className={styles.settingLabel}>
                    <span>手動下單確認 <span className={styles.lockedOnBadge}><Lock size={12} aria-hidden='true' /> 鎖定開啟</span></span>
                    <span className={styles.settingHint}>手機版每筆委託一律經確認面板滑動確認，無法關閉。</span>
                </span>
                <Switch checked label='手動下單確認（鎖定開啟，無法關閉）' disabled testId='risk-manual-confirm-switch' />
            </div>
            <RiskUnlockSheet open={unlockOpen && risk.locked} onClose={() => setUnlockOpen(false)} />
        </Card>
    );
}
