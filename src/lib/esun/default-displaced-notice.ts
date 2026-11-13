// src/lib/esun/default-displaced-notice.ts — 玉山帳戶晚到、存檔預設被頂替時的提示（service 動態載入：
// 文字不進首屏，也避免 service ↔ trade 的循環匯入）

import { notify } from '../trade';

/** 只提示，不改選取：要用玉山下單由使用者自行切換 */
export function notifyEsunDefaultDisplaced(): void {
    notify({
        kind: 'info',
        title: '玉山帳戶已恢復連線',
        body: '啟動時玉山未連線，下單帳戶已改用其他帳戶，預設也跟著改了。要用玉山下單，請點上方的帳戶列切換。',
    });
}
