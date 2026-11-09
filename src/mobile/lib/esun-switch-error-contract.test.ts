// 契約測試（round 3 item 7）：isAmbiguousSwitchError 依錯誤「文字」分辨結果不明與 bridge 明確拒絕。
// src/lib 不能改，所以這裡以假的 fetch 走真正的 HttpEsunDriver → EsunTradeService.switchEnvironment 路徑，
// 產生實際的逾時、連線失敗、非 JSON、閘道錯誤與 bridge 錯誤訊息；src/lib 的文字一改，這裡就會失敗。
import { afterEach, describe, expect, it, vi } from 'vitest';

// esun-env-switch 的其他相依只換成最小替身（不連任何服務）
vi.mock('../../hooks/use-query', () => ({ invalidateAllQueries: () => undefined }));
vi.mock('../../lib/trade', () => ({ notify: () => undefined }));
vi.mock('../../lib/trading-state', () => ({ getTradingState: () => ({ queries: {}, trades: [] }), refreshTradingStateForModeChange: async () => undefined }));
vi.mock('../../lib/order-confirm', () => ({ getPendingOrderConfirm: () => null, accountConfirmLabel: () => '' }));
vi.mock('../../lib/trade-mutations', () => ({ onTradeMutation: () => () => undefined }));

import { EsunTradeService, HttpEsunDriver } from '../../lib/esun';
import { isAmbiguousSwitchError } from './esun-env-switch';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 每個請求：/esun/health 一律失敗（service 失敗後會重讀 health），切換請求交給 onSwitch */
function serviceWith(onSwitch: Fetch): EsunTradeService {
    const fetchImpl: Fetch = (input, init) => (String(input).includes('/esun/health') ? Promise.reject(new TypeError('Failed to fetch')) : onSwitch(input, init));
    return new EsunTradeService(new HttpEsunDriver('', fetchImpl as never));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function switchError(onSwitch: Fetch, advanceMs = 0): Promise<string> {
    const service = serviceWith(onSwitch);
    const pending = service.switchEnvironment('PRODUCTION');
    if (advanceMs) await vi.advanceTimersByTimeAsync(advanceMs);
    const res = await pending;
    expect(res.ok).toBe(false);
    return res.error ?? '';
}

afterEach(() => { vi.useRealTimers(); });

describe('isAmbiguousSwitchError — contract with src/lib/esun error texts', () => {
    it('timeout (client abort after 30 s) → ambiguous', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const error = await switchError((_input, init) => new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }), 30_000);
        expect(error).toContain('回應逾時');
        expect(isAmbiguousSwitchError(error)).toBe(true);
    });

    it('connection failure → ambiguous', async () => {
        const error = await switchError(() => Promise.reject(new TypeError('Failed to fetch')));
        expect(error).toContain('無法連線');
        expect(isAmbiguousSwitchError(error)).toBe(true);
    });

    it('non-JSON gateway page (nginx 502 HTML) → ambiguous', async () => {
        const error = await switchError(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
        expect(error).toContain('回應格式錯誤');
        expect(isAmbiguousSwitchError(error)).toBe(true);
    });

    it('JSON 5xx without a bridge error text (gateway) → ambiguous', async () => {
        const error = await switchError(async () => json(504, { detail: 'upstream timeout' }));
        expect(error).toMatch(/HTTP 504/);
        expect(isAmbiguousSwitchError(error)).toBe(true);
    });

    it.each([
        [409, 'ESUN_MUTATIONS_IN_FLIGHT', '玉山委託處理中（1 筆），暫時不能切換環境；請等委託結果回來後再試'],
        [409, 'ESUN_RECENT_MUTATION', '剛有玉山委託送出或刪改，為了讓委託結果確認完成，請 8 秒後再切換環境'],
        [409, 'ESUN_SESSION_BUSY', '另一個登入或環境切換作業進行中'],
        [400, 'ESUN_PROFILE_UNAVAILABLE', '未提供 esun-config.production.ini 設定檔，無法切換至 PRODUCTION'],
        [502, 'ESUN_LOGIN_FAILED', '切換至 PRODUCTION 失敗（登入未成功，維持原環境）：密碼錯誤'],
        [503, 'ESUN_CONFIG_INCOMPLETE', '玉山設定不完整：缺少 [Api] Key'],
    ])('bridge answered %s %s → definite (not ambiguous), bridge text kept', async (status, code, text) => {
        const error = await switchError(async () => json(status, { ok: false, code, error: text, environment: 'SIMULATION' }));
        expect(error).toContain(text);
        expect(isAmbiguousSwitchError(error)).toBe(false);
    });
});
