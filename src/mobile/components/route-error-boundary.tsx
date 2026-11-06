// src/mobile/components/route-error-boundary.tsx — 延遲載入模組的錯誤邊界與可重試的 lazy（審查 F2／M-PLAT-1）
//
// 為什麼需要：分頁與下單／委託操作面板是 React.lazy 延遲載入；chunk 抓取失敗（網路中斷、重新部署後舊 chunk 404）時
// import() reject，React.lazy 會把錯誤丟進渲染。沒有錯誤邊界時 React 19 會卸載整個 root（狀態列、分頁列、確認面板、
// toast、ResumeGate 提示一起消失），mobile.html 再蓋上誤導性的「啟動失敗」。
// - ModuleErrorBoundary：只把出錯的區塊換成「載入失敗，請檢查網路後重試」＋［重試］；常駐元件放在邊界之外，不受影響。
// - retryableLazy：React.lazy 會永久快取失敗的 promise，同一個 lazy 之後每次渲染都丟同樣的錯；
//   reset() 在失敗後換一個新的 lazy，重試時才會真的再呼叫一次 import()。
//   不在失敗當下自動換新：React 在錯誤後會同步重試渲染一次，自動換新會變成連續重抓的迴圈；只在使用者按［重試］時換。
// - 部分瀏覽器會把失敗的 module fetch 留在 module map，同一網址再 import 仍會失敗：重試失敗後多顯示［重新整理頁面］。
//   這個按鈕只在使用者按下時整頁重新載入，不送出任何委託。
// - preload()（稽核 P3）：閒置預載呼叫它，模組 resolve 後把元件存起來；之後「新掛載」的實例若已 resolve 就直接渲染該元件、
//   不經 React.lazy，不會 suspend，也就沒有 fallback 與 React 約 300ms 的 Suspense 揭示節流。
//   每個實例在掛載時決定走哪條路（useState 記住），之後不換元件型別：已用 lazy 掛上的實例不會因預載晚到而被重掛。
//   預載失敗只吞掉、不標記 failed：不影響之後的 lazy（仍會自己 import）與［重試］語意；下次 preload() 會再試。

import { Component, lazy, useState, type ComponentType, type ReactNode } from 'react';
import * as controls from '../styles/controls.css';
import * as layout from '../styles/layout.css';
import { BottomSheet } from './bottom-sheet';

export const MODULE_LOAD_ERROR_TEXT = '載入失敗，請檢查網路後重試';

/** 可重設的延遲載入元件：失敗後 reset() 會換一個新的 React.lazy，下次渲染重新 import */
export interface RetryableLazy<P extends object> {
    (props: P): ReactNode;
    displayName?: string;
    /** 上一次載入失敗時換新的 lazy 並回傳 true；未失敗（載入中或已成功）時不動、回傳 false */
    reset: () => boolean;
    /**
     * 預先載入：resolve 後記住元件，之後新掛載的實例直接渲染、不 suspend。
     * 回傳的 promise 一律 resolve（失敗只吞掉，不影響 lazy 與 reset／重試）；已載入或載入中不重複呼叫 load()。
     */
    preload: () => Promise<void>;
}

export function retryableLazy<P extends object>(load: () => Promise<ComponentType<P>>, name = 'RetryableLazy'): RetryableLazy<P> {
    let failed = false;
    /** 已 resolve 的元件（預載或 lazy 任一條路成功後設定；之後不清除） */
    let resolved: ComponentType<P> | null = null;
    let preloading: Promise<void> | null = null;
    const make = () => lazy(() => load().then(
        component => {
            resolved ??= component;
            return { default: component };
        },
        (error: unknown) => {
            failed = true;
            throw error;
        },
    ));
    let current = make();
    const Retryable = ((props: P) => {
        // 掛載當下已 resolve → 固定渲染該元件；否則每次渲染讀目前的 lazy（reset 後換新的）
        const [ready] = useState(() => resolved);
        const Current = (ready ?? current) as unknown as ComponentType<P>;
        return <Current {...props} />;
    }) as RetryableLazy<P>;
    Retryable.displayName = name;
    Retryable.preload = () => {
        if (resolved) return Promise.resolve();
        preloading ??= load().then(
            component => { resolved ??= component; },
            () => { preloading = null; },
        );
        return preloading;
    };
    Retryable.reset = () => {
        if (!failed) return false;
        failed = false;
        current = make();
        return true;
    };
    return Retryable;
}

export interface ModuleErrorFallbackProps {
    /** 重設失敗的模組並重新渲染該區塊 */
    retry: () => void;
    /** 已按過幾次重試（> 0 且仍失敗時多顯示「重新整理頁面」） */
    retries: number;
}

interface BoundaryProps {
    children?: ReactNode;
    fallback: (props: ModuleErrorFallbackProps) => ReactNode;
    /** 按［重試］時先呼叫（重設失敗的 retryableLazy） */
    onRetry?: () => void;
    /** 值改變時清除錯誤狀態（例如切換分頁：新分頁不該顯示舊分頁的錯誤） */
    resetKey?: string;
}

interface BoundaryState {
    error: unknown;
    hasError: boolean;
    retries: number;
    resetKey: string | undefined;
}

export class ModuleErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { error: null, hasError: false, retries: 0, resetKey: this.props.resetKey };

    static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
        return { error, hasError: true };
    }

    static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
        if (props.resetKey === state.resetKey) return null;
        return { resetKey: props.resetKey, error: null, hasError: false, retries: 0 };
    }

    private retry = () => {
        this.props.onRetry?.();
        this.setState(s => ({ error: null, hasError: false, retries: s.retries + 1 }));
    };

    render(): ReactNode {
        if (this.state.hasError) return this.props.fallback({ retry: this.retry, retries: this.state.retries });
        return this.props.children;
    }
}

function reloadPage(): void {
    if (typeof location !== 'undefined') location.reload();
}

/** 區塊內的載入失敗提示（分頁內容區） */
export function ModuleLoadError({ retry, retries, testId }: ModuleErrorFallbackProps & { testId?: string }) {
    return (
        <div className={layout.moduleError} role='alert' data-testid={testId}>
            <p className={layout.moduleErrorText}>{MODULE_LOAD_ERROR_TEXT}</p>
            <div className={layout.moduleErrorActions}>
                <button type='button' className={controls.button.primary} onClick={retry} data-testid={testId && `${testId}-retry`}>重試</button>
                {retries > 0 && (
                    <button type='button' className={controls.button.neutral} onClick={reloadPage} data-testid={testId && `${testId}-reload`}>
                        重新整理頁面
                    </button>
                )}
            </div>
        </div>
    );
}

/** 面板（下單、委託操作）載入失敗：以底部面板顯示，只在該面板被要求開啟時出現，可關閉 */
export function SheetLoadError({ open, onClose, testId, ...rest }: ModuleErrorFallbackProps & { open: boolean; onClose: () => void; testId?: string }) {
    return (
        <BottomSheet open={open} onClose={onClose} title='載入失敗' testId={testId}>
            <ModuleLoadError {...rest} testId={testId && `${testId}-body`} />
        </BottomSheet>
    );
}
