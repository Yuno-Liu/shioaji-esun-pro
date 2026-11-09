// src/mobile/components/env-switch-overlay.tsx — 玉山環境切換中的根層面板（首屏；app.tsx 的 MobileShell 掛載）
//
// 帳戶頁的確認面板是頁面狀態，換頁（系統返回手勢、改 hash）就會卸載；切換（最長 30 秒）與之後的結果確認期間，
// 由這個掛在殼層、不隨路由卸載的面板蓋住畫面：layer='confirm'、不可關閉，背景由殼層設為 inert。
// 顯示條件：mobile-store 的切換狀態（含結果確認中；lib/trading-activity.ts），或 esunTradeService 回報切換中。

import { useRef } from 'react';
import { useEsunEnvironment } from '../../lib/esun';
import { useMobileUi, type EnvSwitchState } from '../lib/mobile-store';
import * as styles from '../styles/status-bar.css';
import { BottomSheet } from './bottom-sheet';

const LABEL = { SIMULATION: '模擬環境', PRODUCTION: '正式環境' } as const;

export function EnvSwitchOverlay() {
    const { envSwitch } = useMobileUi();
    const serviceSwitching = useEsunEnvironment().switching;
    const open = envSwitch !== null || serviceSwitching;
    const last = useRef<EnvSwitchState | null>(null);
    if (envSwitch) last.current = envSwitch;
    const shown = envSwitch ?? (open ? null : last.current);
    const checking = shown?.phase === 'checking';
    return (
        <BottomSheet
            open={open}
            onClose={() => undefined}
            dismissible={false}
            layer='confirm'
            title={checking ? '環境切換結果確認中' : '玉山環境切換中'}
            testId='env-switch-overlay'
        >
            <p className={styles.note} role='status'>
                {checking
                    ? 'bridge 沒有及時回應，正在讀取玉山 bridge 狀態確認是否已切換。'
                    : `玉山 bridge 正在重新登入${shown ? `（${LABEL[shown.target]}）` : ''}。`}
                期間不能下單、改單、刪單或平倉。
            </p>
        </BottomSheet>
    );
}
