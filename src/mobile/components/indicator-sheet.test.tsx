// 指標面板（W2）：分主圖／副圖列出全部指標（中文名＋簡稱），加入／移除，達上限停用並說明，
// 點已啟用者編輯參數（輸入夾住範圍、步進、恢復預設、顏色），走勢模式說明。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLineIndicatorSettings, LINE_INDICATORS_KEY, resetLineIndicatorSettingsForTest } from '../lib/line-indicators';
import { getIndicatorSettings, MOBILE_INDICATORS_KEY, resetIndicatorSettingsForTest, setIndicatorSettings } from '../lib/mobile-indicators';
import { getMobileUi, resetMobileUiForTest } from '../lib/mobile-store';
import { IndicatorSheet } from './indicator-sheet';

const storage = new Map<string, string>();
const fakeStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
};

let view: ReactTestRenderer | undefined;
const byId = (id: string) => view!.root.findAll(n => typeof n.type === 'string' && n.props['data-testid'] === id);
const one = (id: string) => byId(id)[0]!;
function textOf(node: ReactTestInstance | string): string {
    if (typeof node === 'string') return node;
    return node.children.map(ch => textOf(ch as ReactTestInstance | string)).join('');
}
const labels = () => getIndicatorSettings().items.map(i => `${i.type}:${JSON.stringify(i.params)}`);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storage.clear();
    vi.stubGlobal('localStorage', fakeStorage);
    resetIndicatorSettingsForTest();
    resetLineIndicatorSettingsForTest();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
    resetIndicatorSettingsForTest();
    resetLineIndicatorSettingsForTest();
});

async function render(lineMode = false, lineFlowSupported = true) {
    await act(async () => { view = create(createElement(IndicatorSheet, { open: true, onClose: () => undefined, lineMode, lineFlowSupported })); });
}

describe('IndicatorSheet', () => {
    it('分主圖、副圖列出全部 21 個指標（中文名＋簡稱），預設已加入 MA(5)、MA(20)', async () => {
        await render();
        const overlay = one('indicator-section-overlay');
        const pane = one('indicator-section-pane');
        expect(overlay.findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('indicator-add-'))).toHaveLength(9);
        expect(pane.findAll(n => typeof n.type === 'string' && String(n.props['data-testid'] ?? '').startsWith('indicator-add-'))).toHaveLength(12);
        expect(textOf(overlay)).toContain('移動平均');
        expect(textOf(overlay)).toContain('布林通道');
        expect(textOf(pane)).toContain('相對強弱');
        expect(textOf(pane)).toContain('RSI');
        expect(byId('indicator-active').map(n => textOf(n))).toEqual([expect.stringContaining('MA(5)'), expect.stringContaining('MA(20)')]);
        expect(textOf(overlay)).toContain('已加入 2／4');
    });

    it('加入、移除，並寫入 localStorage', async () => {
        await render();
        await act(async () => { one('indicator-add-rsi').props.onClick(); });
        expect(labels()).toContain('rsi:{"period":14}');
        expect(storage.get(MOBILE_INDICATORS_KEY)).toContain('"rsi"');
        await act(async () => { one('indicator-remove-sma-default-5').props.onClick(); });
        expect(labels()).toEqual(['sma:{"period":20}', 'rsi:{"period":14}']);
    });

    it('副圖達上限（2）時停用加入並說明原因；主圖不受影響', async () => {
        await render();
        await act(async () => { one('indicator-add-rsi').props.onClick(); });
        await act(async () => { one('indicator-add-kd').props.onClick(); });
        expect(one('indicator-add-macd').props.disabled).toBe(true);
        expect(one('indicator-add-macd').props['aria-describedby']).toBeTruthy();
        expect(textOf(one('indicator-limit-pane'))).toContain('副圖最多 2 個');
        expect(one('indicator-add-ema').props.disabled).toBe(false);
        expect(byId('indicator-limit-overlay')).toHaveLength(0);
    });

    it('編輯參數：輸入超出範圍夾住、步進、恢復預設；完成回到清單', async () => {
        await render();
        await act(async () => { one('indicator-edit-sma-default-5').props.onClick(); });
        expect(byId('indicator-editor')).toHaveLength(1);
        const input = () => one('param-input-period');
        expect(input().props.value).toBe('5');
        expect(input().props.inputMode).toBe('numeric');
        await act(async () => { input().props.onChange({ target: { value: '9999' } }); });
        await act(async () => { input().props.onBlur({ target: { value: '9999' } }); });
        expect(input().props.value).toBe('500');
        expect(getIndicatorSettings().items[0]!.params.period).toBe(500);
        expect(one('param-inc-period').props.disabled).toBe(true);
        await act(async () => { one('param-dec-period').props.onClick(); });
        expect(getIndicatorSettings().items[0]!.params.period).toBe(499);
        // 不是數字 → 回到目前值
        await act(async () => { input().props.onBlur({ target: { value: 'abc' } }); });
        expect(input().props.value).toBe('499');
        await act(async () => { one('indicator-reset-params').props.onClick(); });
        expect(getIndicatorSettings().items[0]!.params.period).toBe(20);
        expect(input().props.value).toBe('20');
        await act(async () => { one('indicator-editor-done').props.onClick(); });
        expect(byId('indicator-editor')).toHaveLength(0);
        expect(byId('indicator-list')).toHaveLength(1);
    });

    it('小數參數用 decimal 鍵盤並對齊步進；改顏色以文字標示已選', async () => {
        setIndicatorSettings({ version: 1, volume: true, items: [{ id: 'b1', type: 'boll', params: { period: 20, mult: 2 }, color: 0 }, { id: 'e1', type: 'ema', params: { period: 12 }, color: 0 }] });
        await render();
        await act(async () => { one('indicator-edit-b1').props.onClick(); });
        expect(one('param-input-mult').props.inputMode).toBe('decimal');
        await act(async () => { one('param-input-mult').props.onKeyDown({ key: 'Enter', target: { value: '2.2' } }); });
        expect(getIndicatorSettings().items[0]!.params.mult).toBe(2);
        await act(async () => { one('param-inc-mult').props.onClick(); });
        expect(getIndicatorSettings().items[0]!.params.mult).toBe(2.5);
        expect(byId('indicator-color-0')).toHaveLength(0); // 多輸出指標沿用定義配色
        await act(async () => { one('indicator-editor-done').props.onClick(); });
        await act(async () => { one('indicator-edit-e1').props.onClick(); });
        await act(async () => { one('indicator-color-3').props.onClick(); });
        expect(getIndicatorSettings().items[1]!.color).toBe(3);
        expect(one('indicator-color-3').props['aria-pressed']).toBe(true);
        expect(textOf(one('indicator-color-3'))).toBe('已選');
    });

    it('在編輯中按「移除」回到清單', async () => {
        await render();
        await act(async () => { one('indicator-edit-sma-default-20').props.onClick(); });
        await act(async () => { one('indicator-editor-remove').props.onClick(); });
        expect(byId('indicator-editor')).toHaveLength(0);
        expect(labels()).toEqual(['sma:{"period":5}']);
    });

    it('成交量開關與恢復預設', async () => {
        await render();
        await act(async () => { one('indicator-volume').props.onClick(); });
        expect(getIndicatorSettings().volume).toBe(false);
        expect(textOf(one('indicator-volume'))).toBe('已隱藏');
        await act(async () => { one('indicator-add-macd').props.onClick(); });
        await act(async () => { one('indicator-reset-all').props.onClick(); });
        expect(getIndicatorSettings().volume).toBe(true);
        expect(labels()).toEqual(['sma:{"period":5}', 'sma:{"period":20}']);
    });

    it('走勢模式顯示說明（其餘指標只套用在 K 線）', async () => {
        await render(true);
        // 走勢多了「走勢副圖」：說明改為其餘指標套用在 K 線
        expect(textOf(one('indicator-list'))).toContain('其餘指標套用在 K 線');
    });
});

describe('IndicatorSheet — 走勢副圖（買賣力）', () => {
    it('只在走勢模式出現；預設兩個都關閉，門檻選擇只在開啟大單／小單時出現', async () => {
        await render(false);
        expect(byId('indicator-section-line')).toHaveLength(0);
        await act(async () => view!.unmount());
        await render(true);
        expect(byId('indicator-section-line')).toHaveLength(1);
        expect(one('line-flow-flow').props['aria-pressed']).toBe(false);
        expect(one('line-flow-bigSmall').props['aria-pressed']).toBe(false);
        expect(byId('line-flow-threshold-500')).toHaveLength(0);
    });

    it('開關與門檻寫入新的儲存鍵，不動既有指標設定的格式', async () => {
        await render(true);
        const before = storage.get(MOBILE_INDICATORS_KEY);
        await act(async () => { one('line-flow-flow').props.onClick(); });
        await act(async () => { one('line-flow-bigSmall').props.onClick(); });
        expect(one('line-flow-flow').props['aria-pressed']).toBe(true);
        expect(textOf(one('line-flow-flow'))).toBe('顯示中');
        // 門檻：100、300、500（預設、已選）、1千萬、2千萬
        expect(one('line-flow-threshold-500').props['aria-pressed']).toBe(true);
        expect(textOf(one('line-flow-threshold-1000'))).toBe('1千萬');
        await act(async () => { one('line-flow-threshold-1000').props.onClick(); });
        expect(getLineIndicatorSettings()).toEqual({ version: 1, flow: true, bigSmall: true, threshold: 1000 });
        expect(JSON.parse(storage.get(LINE_INDICATORS_KEY)!)).toEqual({ version: 1, flow: true, bigSmall: true, threshold: 1000 });
        expect(storage.get(MOBILE_INDICATORS_KEY)).toBe(before);
    });

    it('不支援的商品（指數、期權、權證）：開關停用並說明，不顯示門檻', async () => {
        storage.set(LINE_INDICATORS_KEY, JSON.stringify({ version: 1, flow: true, bigSmall: true, threshold: 500 }));
        resetLineIndicatorSettingsForTest();
        await render(true, false);
        const flow = one('line-flow-flow');
        expect(flow.props.disabled).toBe(true);
        expect(flow.props['aria-pressed']).toBe(false);
        expect(flow.props['aria-describedby']).toBe(one('line-flow-unsupported').props.id);
        expect(textOf(one('line-flow-unsupported'))).toContain('只提供股票與 ETF');
        expect(byId('line-flow-threshold-500')).toHaveLength(0);
    });

    it('S1：開關與門檻不開下單面板', async () => {
        await render(true);
        await act(async () => { one('line-flow-flow').props.onClick(); });
        await act(async () => { one('line-flow-bigSmall').props.onClick(); });
        await act(async () => { one('line-flow-threshold-2000').props.onClick(); });
        expect(getMobileUi().ticket).toBeNull();
    });
});

describe('IndicatorSheet — 快速範本', () => {
    const tpl = (id: string) => one(`indicator-template-${id}`);

    it('三個範本各一列：名稱、內容說明、44px「套用」鍵（無障礙名稱寫出取代目前設定）', async () => {
        await render();
        const section = one('indicator-templates');
        expect(section.props['aria-label']).toBe('快速範本');
        expect(textOf(section)).toContain('當沖');
        expect(textOf(section)).toContain('VWAP、MA(5)、MA(20)、MACD(12,26,9)＋成交量');
        expect(textOf(section)).toContain('MA(5)、MA(20)、MA(60)、KD(9,3,3)＋成交量');
        expect(textOf(section)).toContain('MA(20)、MA(60)、MA(120)、RSI(14)＋成交量');
        expect(tpl('daytrade').props['aria-label']).toBe('套用「當沖」範本：VWAP、MA(5)、MA(20)、MACD(12,26,9)＋成交量（取代目前設定）');
        expect(textOf(tpl('swing'))).toBe('套用');
        expect(byId('indicator-template-applied')).toHaveLength(0);
    });

    it('套用：取代目前設定（不跳確認）、寫入 localStorage；成交量隱藏時也改回顯示', async () => {
        await render();
        await act(async () => { one('indicator-volume').props.onClick(); });
        await act(async () => { one('indicator-add-cci').props.onClick(); });
        await act(async () => { tpl('swing').props.onClick(); });
        expect(labels()).toEqual(['sma:{"period":5}', 'sma:{"period":20}', 'sma:{"period":60}', 'kd:{"period":9,"k":3,"d":3}']);
        expect(getIndicatorSettings().volume).toBe(true);
        const saved = JSON.parse(storage.get(MOBILE_INDICATORS_KEY)!);
        expect(saved.items.map((i: { type: string }) => i.type)).toEqual(['sma', 'sma', 'sma', 'kd']);
        expect(textOf(one('indicator-section-overlay'))).toContain('已加入 3／4');
        expect(textOf(one('indicator-section-pane'))).toContain('已加入 1／2');
        const note = one('indicator-template-applied');
        expect(note.props.role).toBe('status');
        expect(textOf(note)).toContain('已套用「波段」範本');
    });

    it('復原（一步）：還原套用前的設定並寫入儲存；焦點回到範本鍵；說明消失', async () => {
        const focus = vi.fn();
        // react-test-renderer 沒有 DOM：以替身確認焦點移回範本鍵
        await act(async () => {
            view = create(createElement(IndicatorSheet, { open: true, onClose: () => undefined }), {
                createNodeMock: el => ((el.props as Record<string, unknown>)['data-testid'] === 'indicator-template-daytrade' ? { focus } : {}),
            });
        });
        await act(async () => { one('indicator-add-rsi').props.onClick(); });
        const before = labels();
        expect(before).toEqual(['sma:{"period":5}', 'sma:{"period":20}', 'rsi:{"period":14}']);
        await act(async () => { tpl('daytrade').props.onClick(); });
        expect(labels()[0]).toBe('vwap:{}');
        await act(async () => { one('indicator-template-undo').props.onClick(); });
        expect(labels()).toEqual(before);
        expect(JSON.parse(storage.get(MOBILE_INDICATORS_KEY)!).items.map((i: { type: string }) => i.type)).toEqual(['sma', 'sma', 'rsi']);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(byId('indicator-template-applied')).toHaveLength(0);
    });

    it('套用後再改設定：復原失效（說明消失），不會蓋掉後來的修改', async () => {
        await render();
        await act(async () => { tpl('long').props.onClick(); });
        expect(byId('indicator-template-undo')).toHaveLength(1);
        await act(async () => { one('indicator-add-ema').props.onClick(); });
        expect(byId('indicator-template-applied')).toHaveLength(0);
        expect(labels()).toContain('ema:{"period":12}');
    });

    it('S1：範本與復原只改圖表設定，不開下單或委託面板', async () => {
        resetMobileUiForTest();
        await render();
        for (const id of ['daytrade', 'swing', 'long']) await act(async () => { tpl(id).props.onClick(); });
        await act(async () => { one('indicator-template-undo').props.onClick(); });
        expect(getMobileUi().ticket).toBeNull();
        expect(getMobileUi().orderAction).toBeNull();
    });
});
