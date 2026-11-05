// src/mobile/main.tsx — 手機入口（mobile.html）；規格 §4.5
//
// polyfills MUST stay the first import（同 src/main.tsx 的規則）— patches globals before any
// dependency module evaluates.
import '../lib/polyfills';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../index.css';
import { MobileApp } from './app';
import { installGestureGuard } from './lib/gesture-guard';
import { isMobileSecure, readSecureContextDiagnostics } from './lib/secure-context';
import { startMobile } from './start';

// secure context＝isSecureContext、navigator.locks.request、BroadcastChannel 三項皆成立；
// 否則只顯示 HTTPS 說明，不建立任何連線（規格 R1）
const diagnostics = readSecureContextDiagnostics();
const secure = isMobileSecure(diagnostics);

// 主題 → 強制下單確認 → （secure 才）bootstrap()；不啟動觸價／括號／條件單／背景執行等前端引擎。
// 注意：手機頁不得帶 ?popout=（會被視為鏡像視窗，交易狀態不會自行讀取）。
startMobile(secure);

// 禁止頁面雙指縮放（iOS 忽略 user-scalable=no）；圖表容器 data-allow-pinch="true" 內不擋。
// 不論是否 secure 都安裝；重複執行（HMR）只會有一組監聽器。
installGestureGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

// HMR 重新執行入口時沿用同一個 Root，避免重複 createRoot
const rootHost = rootElement as HTMLElement & { __shioajiMobileRoot?: Root };
const root = rootHost.__shioajiMobileRoot ?? createRoot(rootHost);
rootHost.__shioajiMobileRoot = root;
root.render(
    <StrictMode>
        <MobileApp secure={secure} diagnostics={diagnostics} />
    </StrictMode>,
);
