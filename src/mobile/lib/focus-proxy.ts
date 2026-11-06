// src/mobile/lib/focus-proxy.ts — 代理輸入框：開面板時立刻叫出鍵盤（交易頁切換商品）
//
// iOS Safari 只在使用者手勢內「同步」呼叫 focus() 時才叫出鍵盤，而面板進場有 transform 動畫、真正的搜尋框
// 在動畫結束前不宜聚焦。作法：點擊當下 engage() 在 body 末端建立並聚焦一個看不見的暫時 input（position fixed、
// top 0、opacity 0、字級 16px 免得 iOS 放大；aria-hidden、tabIndex -1），鍵盤因此出現；面板就緒後
// release(真正的搜尋框) 把焦點移過去（input → input 鍵盤不收起）並移除暫時 input。
// 轉移前已打進暫時 input 的字由 release 回傳，呼叫端帶進搜尋框（快手不掉字）。
// 輸入法組字（注音、拼音；compositionstart 後、compositionend 前）時 release(target) 不立即轉移（會中斷組字、
// 把未確定的標記文字帶走）：回傳 null，延到 compositionend 之後再轉移，並以 onDeferred 註冊的回呼回報已確定的文字；
// 最晚 COMPOSITION_WAIT_MS 仍在組字就只轉移焦點、不帶文字（回呼收到 ''）。
// 面板在那之前關閉或元件卸載：release() 讓它失焦並移除（延後中再呼叫 release 一律取消：不轉移、不回報）。
// release 之後 engage 不再有作用；兩者都可重複呼叫。

type FocusTarget = { focus?: (options?: FocusOptions) => void } | null | undefined;

/** 組字中 release 最多等多久（ms；與切換面板的 FOCUS_FALLBACK_MS 同級） */
export const COMPOSITION_WAIT_MS = 800;

export interface FocusProxy {
    /** 建立並聚焦暫時 input（必須在使用者手勢的同步呼叫內） */
    engage(): void;
    /**
     * 有 target 且（尚未 engage 或暫時 input 仍持有焦點）時先把焦點移到 target；之後失焦並移除暫時 input。
     * 回傳轉移前打進暫時 input 的文字（沒有或已 release 過為 ''）。
     * 暫時 input 持有焦點且正在組字時：回傳 null，延到組字結束（最晚 COMPOSITION_WAIT_MS）才轉移（見 onDeferred）。
     * 延後中再呼叫 release（任何參數）＝取消（不轉移、不呼叫 onDeferred 的回呼），回傳 ''。
     */
    release(target?: FocusTarget): string | null;
    /**
     * release 回傳 null 後（同一個同步呼叫內）註冊：延後的轉移完成時以確定的文字呼叫 cb（逾時仍在組字為 ''）；
     * 取消時不呼叫。沒有延後中的轉移時無作用。
     */
    onDeferred?(cb: (typed: string) => void): void;
}

export const FOCUS_PROXY_ATTR = 'data-sj-focus-proxy';

type DocLike = Pick<Document, 'createElement' | 'body' | 'activeElement'>;

function focusEl(el: FocusTarget): void {
    try {
        el?.focus?.({ preventScroll: true });
    } catch {
        // 忽略
    }
}

interface Deferred {
    target: FocusTarget;
    onDone?: (typed: string) => void;
    limit: ReturnType<typeof setTimeout>;
    settle?: ReturnType<typeof setTimeout>;
}

/** 沒有可用的 document（測試、SSR）時回傳 null */
export function createFocusProxy(doc: DocLike | undefined = typeof document === 'undefined' ? undefined : document): FocusProxy | null {
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) return null;
    let input: HTMLInputElement | null = null;
    let engaged = false;
    let released = false;
    let composing = false;
    let deferred: Deferred | null = null;

    const readValue = (): string => {
        try {
            return typeof input?.value === 'string' ? input.value : '';
        } catch {
            return '';
        }
    };

    const clearDeferred = (): Deferred | null => {
        const d = deferred;
        deferred = null;
        if (d) {
            clearTimeout(d.limit);
            if (d.settle !== undefined) clearTimeout(d.settle);
        }
        return d;
    };

    /** 延後的轉移：組字已結束才帶文字（逾時仍在組字＝不帶標記文字） */
    const finish = () => {
        const d = clearDeferred();
        if (!d) return;
        const typed = composing ? '' : readValue();
        if (input && doc.activeElement === input) focusEl(d.target);
        remove();
        d.onDone?.(typed);
    };

    const onCompositionStart = () => {
        composing = true;
    };
    const onCompositionEnd = () => {
        composing = false;
        if (!deferred) return;
        // 等到下一個 task 再讀值：部分瀏覽器（WebKit）compositionend 先於最後一次 input 事件
        if (deferred.settle !== undefined) clearTimeout(deferred.settle);
        deferred.settle = setTimeout(() => {
            if (deferred) deferred.settle = undefined;
            if (!composing) finish();
        }, 0);
    };

    function remove() {
        const el = input;
        input = null;
        if (!el) return;
        try {
            el.removeEventListener?.('compositionstart', onCompositionStart);
            el.removeEventListener?.('compositionend', onCompositionEnd);
        } catch {
            // 忽略
        }
        try {
            el.blur?.();
        } catch {
            // 忽略
        }
        try {
            el.remove?.();
        } catch {
            // 忽略
        }
    }

    return {
        engage() {
            if (released || engaged) return;
            engaged = true;
            try {
                const el = doc.createElement('input');
                input = el; // 之後任何一步丟錯，remove() 都能移除監聽與節點
                el.type = 'text';
                el.setAttribute('aria-hidden', 'true');
                el.setAttribute(FOCUS_PROXY_ATTR, '');
                el.setAttribute('autocomplete', 'off');
                el.setAttribute('autocorrect', 'off');
                el.setAttribute('autocapitalize', 'off');
                el.setAttribute('inputmode', 'search');
                el.setAttribute('enterkeyhint', 'search');
                el.tabIndex = -1;
                const st = el.style;
                st.position = 'fixed';
                st.top = '0';
                st.left = '0';
                st.width = '1px';
                st.height = '1px';
                st.margin = '0';
                st.padding = '0';
                st.border = '0';
                st.opacity = '0';
                st.fontSize = '16px';
                st.pointerEvents = 'none';
                el.addEventListener?.('compositionstart', onCompositionStart);
                el.addEventListener?.('compositionend', onCompositionEnd);
                doc.body.appendChild(el);
                focusEl(el);
            } catch {
                remove();
            }
        },
        onDeferred(cb) {
            if (deferred) deferred.onDone = cb;
        },
        release(target) {
            // 延後中再呼叫（關閉、卸載、重開）：取消，不轉移、不回報
            if (deferred) {
                clearDeferred();
                remove();
                return '';
            }
            if (released) return '';
            released = true;
            // 已 engage 且暫時 input 仍持有焦點（使用者點了別處就不搶）；還沒 engage（同一個手勢內就已就緒）：直接聚焦 target
            const holding = !!input && doc.activeElement === input;
            if (target && engaged && holding && composing) {
                deferred = { target, limit: setTimeout(finish, COMPOSITION_WAIT_MS) };
                return null;
            }
            const typed = composing ? '' : readValue();
            if (target && (!engaged || holding)) focusEl(target);
            remove();
            return typed;
        },
    };
}
