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

import { Component, lazy, type ComponentType, type ReactNode } from 'react';
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
}

export function retryableLazy<P extends object>(load: () => Promise<ComponentType<P>>, name = 'RetryableLazy'): RetryableLazy<P> {
    let failed = false;
    const make = () => lazy(() => load().then(
        component => ({ default: component }),
        (error: unknown) => {
            failed = true;
            throw error;
        },
    ));
    let current = make();
    const Retryable = ((props: P) => {
        const Current = current as unknown as ComponentType<P>;
        return <Current {...props} />;
    }) as RetryableLazy<P>;
    Retryable.displayName = name;
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
