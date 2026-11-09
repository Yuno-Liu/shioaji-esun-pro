// src/mobile/lib/server-down-hint.ts — 「伺服器未連線」提示（移植上游 #384 WebServerHint，src/components/server-env-notice.tsx）
//
// 判斷沿用上游的黏著語意：串流 down 時出現；重新連線中（connecting／stale）維持顯示；回到 live 才消失。
// 從未 down 過的 connecting（例如首次開啟）不顯示。
// 狀態列「連線狀態」面板與帳戶 › 連線共用同一份模組狀態：中斷後才打開帳戶頁，重連中也看得到。
// 只讀 useStreamStatus() 的值，不發任何請求；不含下單入口（S1）。

import type { StreamStatus } from '../../lib/stream';

export const SERVER_DOWN_TEXT = '伺服器未連線。';
export const SERVER_DOWN_DETAIL = '若剛切換永豐模擬／正式（改 .env 的 SJ_PRODUCTION），請在伺服器執行 docker compose up -d 重新啟動 Shioaji server；其他情況請確認伺服器與網路。';

/** 純函式：上一個結果 lost 與目前狀態 → 是否顯示 */
export function nextServerLost(status: StreamStatus, lost: boolean): boolean {
    return status === 'down' || (status !== 'live' && lost);
}

let lost = false;

/** 以目前狀態更新共用的黏著結果並回傳（同一狀態重複呼叫結果不變，可在 render 中呼叫） */
export function trackServerLost(status: StreamStatus): boolean {
    lost = nextServerLost(status, lost);
    return lost;
}
