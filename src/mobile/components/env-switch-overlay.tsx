// src/mobile/components/env-switch-overlay.tsx — 玉山環境切換中的根層提示（app.tsx 的 MobileShell 延遲載入、第一次切換後保持掛載）
//
// 帳戶頁的確認面板是頁面狀態，換頁（系統返回手勢、改 hash）就會卸載；這裡掛在殼層、不隨路由卸載：
// - switching（等待 bridge 回應，前端最長 30 秒）：不可關閉的面板（layer confirm，背景 inert）蓋住畫面。
//   選擇蓋住整個畫面：這段期間 bridge 正在重新登入、玉山帳戶與路由隨時會換，畫面上的玉山資料不可信；時間有上限，
//   也是使用者剛按下切換、本來就在等待的時候。永豐不是被這個面板「擋單」：送單閘門只擋玉山（lib/trading-activity.ts）。
// - checking（回應逾時或遺失後以 health 確認結果，最長約 60 秒）：改為不攔操作的橫幅（role=status），
//   永豐照常可用；玉山的送單仍由閘門擋下，直到結果確定。
// 顯示條件：mobile-store 的切換狀態，或 esunTradeService 回報切換中。

import { useRef } from 'react';
import { useEsunEnvironment } from '../../lib/esun';
import { useMobileUi, type EnvSwitchState } from '../lib/mobile-store';
import * as css from '../styles/env-switch-overlay.css';
import * as styles from '../styles/status-bar.css';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet } from './bottom-sheet';

const LABEL = { SIMULATION: '模擬環境', PRODUCTION: '正式環境' } as const;

export function EnvSwitchOverlay() {
    const { envSwitch } = useMobileUi();
    const serviceSwitching = useEsunEnvironment().switching;
    const checking = envSwitch?.phase === 'checking';
    const open = !checking && (envSwitch !== null || serviceSwitching);
    const last = useRef<EnvSwitchState | null>(null);
    if (envSwitch) last.current = envSwitch;
    const shown = envSwitch ?? last.current;
    return (
        <>
            <BottomSheet
                open={open}
                onClose={() => undefined}
                dismissible={false}
                layer='confirm'
                title='玉山環境切換中'
                testId='env-switch-overlay'
            >
                <p className={styles.note} role='status'>
                    玉山 bridge 正在重新登入{shown ? `（${LABEL[shown.target]}）` : ''}，期間玉山的下單、改單、刪單、平倉暫停；
                    永豐不受影響，完成後即可繼續操作。
                </p>
            </BottomSheet>
            {checking && (
                <div className={css.banner} data-testid='env-switch-banner'>
                    <InlineNote tone='info' role='status'>
                        玉山環境切換結果確認中：bridge 沒有及時回應，正在讀取狀態確認是否已切換。期間玉山委託暫停，永豐照常。
                    </InlineNote>
                </div>
            )}
        </>
    );
}
