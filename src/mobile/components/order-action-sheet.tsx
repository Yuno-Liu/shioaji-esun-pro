// src/mobile/components/order-action-sheet.tsx — 委託操作面板：改價／減量／刪單（規格 §6.5、§7.3）
//
// 【目前為樁（T1）】只顯示「開發中」，沒有任何改單／刪單路徑。
// 介面：無 props、掛在 App 根層；目標委託來自 mobile-store 的 `orderAction`
// （openOrderAction(tradeId, kind)／closeOrderAction()）。委託頁與交易圖表的委託線都經由 openOrderAction 開啟。
// T6 實作時：每個動作都以 SlideToConfirm 確認；改價／減量受 ResumeGate（assertResumeReady）與 useTradingLive() 控制，
// 刪單與全部刪單在 resyncing 時仍允許；結果訊息一律用 mutationErrorNotice(err, verb)。

import { closeOrderAction, useMobileUi } from '../lib/mobile-store';
import * as layout from '../styles/layout.css';
import { BottomSheet } from './bottom-sheet';

export function OrderActionSheet() {
    const { orderAction } = useMobileUi();
    return (
        <BottomSheet open={orderAction !== null} onClose={closeOrderAction} title='委託操作' testId='order-action-sheet'>
            <p className={layout.placeholder}>改價／減量／刪單開發中，請暫時使用桌面版操作。</p>
        </BottomSheet>
    );
}
