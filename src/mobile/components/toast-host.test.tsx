// 通知：「結果未知」錯誤用琥珀色（規格 §7.2），確定未送出的錯誤仍是紅色；lib 以 vi.mock 隔離
// v2（設計規格 §6.4、§8、§10 S8）：淘汰保護 alert（warn 最後）、前景＝最新 warn＞最新 err＞最新一則、按住暫停 TTL、雙錨點、拖曳離場
// 單則錯誤邊界（渲染失敗只略過該則）、非前景實心材質（§0.2 第 13 項）
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotice } from '../../lib/trade';

const h = vi.hoisted(() => ({
    notice: null as ((n: AppNotice) => void) | null,
    reveal: (s: string): string => s,
}));

vi.mock('../../lib/trade', () => ({
    onNotice: (l: (n: AppNotice) => void) => {
        h.notice = l;
        return () => { h.notice = null; };
    },
}));
vi.mock('../../lib/stream', () => ({ onOrderEvent: () => () => undefined }));
vi.mock('../../lib/order-report', () => ({ describeOrderReport: () => ({ kind: 'info', title: '', lines: [] }) }));
vi.mock('../lib/reveal-compat', () => ({ useRevealTextCompat: () => (s: string) => h.reveal(s) }));

import { registerSheet, resetSheetStackForTest } from '../lib/sheet-stack';
import { setMotionClockForTest } from '../motion/spring';
import * as styles from '../styles/toast.css';
import {
    frontToastId,
    MAX_TOASTS,
    noticeToastKind,
    pickToastEvictions,
    ToastHost,
    toastRelease,
    TTL_MS,
} from './toast-host';

const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let view: ReactTestRenderer | undefined;
// 選擇器依設計規格 §14「刻意更新 1」改為 data-testid（外層已不是 <button>）
const toasts = () => view!.root.findAll(n => n.props['data-testid'] === 'toast-item' && typeof n.type === 'string');
const host = () => view!.root.find(n => n.props['data-testid'] === 'toast-host' && typeof n.type === 'string');
const titleOf = (n: ReactTestInstance) => text(n.findAll(c => c.type === 'span')[0]!);
const titles = () => toasts().map(titleOf);

const mount = async () => {
    await act(async () => { view = create(createElement(ToastHost)); });
};
const notify = async (kind: AppNotice['kind'], title: string, body?: string) => {
    await act(async () => { h.notice!({ kind, title, body } as AppNotice); });
};
const UNKNOWN = '結果未知：請到委託頁按『更新』核對，勿重送';

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    resetSheetStackForTest();
    setMotionClockForTest(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    h.reveal = s => s;
});

describe('noticeToastKind', () => {
    it('err 且標題含「結果未知」→ warn；其餘照原 kind', () => {
        expect(noticeToastKind({ kind: 'err', title: '結果未知：請到委託頁按『更新』核對，勿重送' })).toBe('warn');
        expect(noticeToastKind({ kind: 'err', title: '刪單失敗或結果未知' })).toBe('warn');
        expect(noticeToastKind({ kind: 'err', title: '刪單未送出' })).toBe('err');
        expect(noticeToastKind({ kind: 'ok', title: '委託已送出' })).toBe('ok');
        expect(noticeToastKind({ kind: 'info', title: '結果未知' })).toBe('info');
    });
});

describe('ToastHost', () => {
    it('結果未知用琥珀色樣式（alert），確定未送出仍為紅色', async () => {
        await act(async () => { view = create(createElement(ToastHost)); });
        await act(async () => { h.notice!({ kind: 'err', title: '結果未知：請到委託頁按『更新』核對，勿重送', body: 'timeout' }); });
        await act(async () => { h.notice!({ kind: 'err', title: '改價未送出', body: '風控鎖' }); });
        const [unknown, notSent] = toasts();
        expect(unknown!.props.className).toBe(styles.toast.warn);
        expect(unknown!.props.role).toBe('alert');
        expect(unknown!.findAll(n => n.type === 'span')[0]!.props.className).toBe(styles.titleWarn);
        expect(text(unknown!)).toContain('timeout');
        expect(notSent!.props.className).toBe(styles.toast.err);
        expect(styles.toast.warn).not.toBe(styles.toast.err);
    });

    it('外層為 div（不是 button），內部有「關閉通知」鈕；結構：圖示 → 標題 → 內文 → 關閉', async () => {
        await mount();
        await notify('ok', '委託已送出', '2330 買進 1 張');
        const [t] = toasts();
        expect(t!.type).toBe('div');
        expect(t!.props.role).toBe('status');
        const kids = t!.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
        // 第一個子節點是 lucide 圖示元件（渲染為 svg，不包 span），之後依序為標題、內文、關閉鈕
        expect(typeof kids[0]!.type).not.toBe('string');
        expect(kids[0]!.findAll(n => n.type === 'svg')).toHaveLength(1);
        expect(kids.slice(1).map(k => k.type)).toEqual(['span', 'span', 'button']);
        expect(titleOf(t!)).toBe('委託已送出');
        const close = t!.find(n => n.type === 'button');
        expect(close.props['aria-label']).toBe('關閉通知');
        await act(async () => { close.props.onClick({ stopPropagation: () => undefined }); });
        expect(toasts()).toHaveLength(0);
    });

    it('MAX_TOASTS、TTL_MS 不變', () => {
        expect(MAX_TOASTS).toBe(3);
        expect(TTL_MS).toEqual({ deal: 6000, ok: 5000, info: 5000, err: 9000, warn: 9000 });
    });

    it('TTL 到期自動移除（info 5 秒、結果未知 9 秒）', async () => {
        await mount();
        await notify('info', '資訊');
        await notify('err', UNKNOWN);
        await act(async () => { vi.advanceTimersByTime(5001); });
        expect(titles()).toEqual([UNKNOWN]);
        await act(async () => { vi.advanceTimersByTime(4000); });
        expect(toasts()).toHaveLength(0);
    });
});

describe('淘汰順序（S8：alert 受保護，結果未知最後淘汰）', () => {
    it('pickToastEvictions：先最舊的 deal／ok／info，全是 alert 才淘汰 err，warn 最後', () => {
        const t = (id: number, kind: 'deal' | 'ok' | 'err' | 'warn' | 'info') => ({ id, kind });
        expect(pickToastEvictions([t(1, 'warn'), t(2, 'info'), t(3, 'err'), t(4, 'ok')])).toEqual([2]);
        expect(pickToastEvictions([t(1, 'warn'), t(2, 'err'), t(3, 'err'), t(4, 'deal')])).toEqual([4]);
        expect(pickToastEvictions([t(1, 'warn'), t(2, 'err'), t(3, 'warn'), t(4, 'err')])).toEqual([2]);
        expect(pickToastEvictions([t(1, 'warn'), t(2, 'warn'), t(3, 'warn'), t(4, 'warn')])).toEqual([1]);
        expect(pickToastEvictions([t(1, 'info'), t(2, 'ok')])).toEqual([]);
    });

    it('第 4 則到達時淘汰最舊的非 alert，結果未知留在畫面上', async () => {
        await mount();
        await notify('err', UNKNOWN);
        await notify('info', '資訊一');
        await notify('err', '改價未送出');
        await notify('ok', '委託已送出');
        expect(titles()).toEqual([UNKNOWN, '改價未送出', '委託已送出']);
        await notify('ok', '刪單已送出');
        expect(titles()).toEqual([UNKNOWN, '改價未送出', '刪單已送出']);
        await notify('err', '刪單未送出');
        await notify('err', '減量未送出');
        // 全是 alert：先淘汰 err，結果未知仍在
        expect(titles()).toEqual([UNKNOWN, '刪單未送出', '減量未送出']);
        expect(toasts()).toHaveLength(MAX_TOASTS);
    });
});

describe('前景與疊放', () => {
    it('frontToastId：最新的 warn（結果未知），其次最新的 err，都沒有則最新一則（§10 S8、§0.2 第 4 項）', () => {
        expect(frontToastId([{ id: 1, kind: 'warn' }, { id: 2, kind: 'info' }, { id: 3, kind: 'deal' }])).toBe(1);
        // 較晚到的 err 不可把結果未知擠到後面
        expect(frontToastId([{ id: 1, kind: 'warn' }, { id: 2, kind: 'err' }, { id: 3, kind: 'ok' }])).toBe(1);
        expect(frontToastId([{ id: 1, kind: 'warn' }, { id: 2, kind: 'warn' }, { id: 3, kind: 'err' }])).toBe(2);
        expect(frontToastId([{ id: 1, kind: 'err' }, { id: 2, kind: 'err' }, { id: 3, kind: 'ok' }])).toBe(2);
        expect(frontToastId([{ id: 1, kind: 'ok' }, { id: 2, kind: 'info' }])).toBe(2);
        expect(frontToastId([])).toBeNull();
    });

    it('結果未知之後到的一般通知不會壓過它：warn 為前景（data-front／data-depth）', async () => {
        await mount();
        await notify('err', UNKNOWN);
        await notify('ok', '委託已送出');
        await notify('info', '資訊');
        const [warn, ok, info] = toasts();
        expect(warn!.props['data-front']).toBe('true');
        expect(warn!.props['data-depth']).toBe('0');
        expect(info!.props['data-front']).toBe('false');
        expect(info!.props['data-depth']).toBe('1');
        expect(ok!.props['data-depth']).toBe('2');
        // className 只放 styles.toast[kind]
        expect(warn!.props.className).toBe(styles.toast.warn);
        expect(info!.props.className).toBe(styles.toast.info);
    });

    it('結果未知之後到的 err 不會壓過它：warn 仍為前景，err 在其後', async () => {
        await mount();
        await notify('err', UNKNOWN);
        await notify('err', '改價未送出');
        const [warn, err] = toasts();
        expect(warn!.props['data-front']).toBe('true');
        expect(warn!.props['data-depth']).toBe('0');
        expect(err!.props['data-front']).toBe('false');
        expect(err!.props['data-depth']).toBe('1');
    });

    it('頂部精簡模式只顯示前景一則：有結果未知時前景必為 warn（即使之後又到 err）', async () => {
        await mount();
        await act(async () => {
            registerSheet({ layer: 'sheet', getPanel: () => null, isDismissible: () => true, requestClose: () => undefined });
        });
        await notify('ok', '委託已送出');
        await notify('err', UNKNOWN);
        await notify('err', '刪單未送出');
        expect(host().props['data-anchor']).toBe('top');
        const front = toasts().filter(t => t.props['data-front'] === 'true');
        expect(front).toHaveLength(1);
        expect(front[0]!.props.className).toBe(styles.toast.warn);
        expect(text(view!.root.find(n => n.props['data-testid'] === 'toast-more'))).toBe('+2');
    });

    it('多則時點一下展開、5 秒無互動收合；單則點一下關閉', async () => {
        await mount();
        await notify('err', 'A'); // 9 秒，展開收合期間不會到期
        await notify('err', 'B');
        await act(async () => { toasts()[1]!.props.onClick(); });
        expect(host().props['data-expanded']).toBe('true');
        expect(toasts()).toHaveLength(2);
        await act(async () => { vi.advanceTimersByTime(4900); });
        expect(host().props['data-expanded']).toBe('true');
        await act(async () => { vi.advanceTimersByTime(200); });
        expect(host().props['data-expanded']).toBe('false');
        await act(async () => { toasts()[0]!.props.onClick(); });
        await act(async () => { toasts()[0]!.props.onClick(); }); // 展開中點一則 → 關閉該則
        expect(titles()).toEqual(['B']);
        expect(host().props['data-expanded']).toBe('false'); // 只剩一則收合
        await act(async () => { toasts()[0]!.props.onClick(); });
        expect(toasts()).toHaveLength(0);
    });
});

describe('按住暫停 TTL（S8）', () => {
    it('按住任一則時全部 TTL 暫停，放開以剩餘時間續算', async () => {
        await mount();
        await notify('info', '資訊'); // 5s
        await notify('err', UNKNOWN); // 9s
        await act(async () => { vi.advanceTimersByTime(3000); });
        await act(async () => { toasts()[1]!.props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0, timeStamp: 1 }); });
        await act(async () => { vi.advanceTimersByTime(20_000); });
        expect(toasts()).toHaveLength(2);
        await act(async () => { toasts()[1]!.props.onPointerUp({ pointerId: 1, clientX: 0, clientY: 0, timeStamp: 2 }); });
        await act(async () => { vi.advanceTimersByTime(1900); });
        expect(toasts()).toHaveLength(2);
        await act(async () => { vi.advanceTimersByTime(200); }); // 資訊剩 2s 到期
        expect(titles()).toEqual([UNKNOWN]);
        await act(async () => { vi.advanceTimersByTime(3800); });
        expect(titles()).toEqual([UNKNOWN]);
        await act(async () => { vi.advanceTimersByTime(300); }); // 結果未知剩 6s 到期
        expect(toasts()).toHaveLength(0);
    });

    it('按住期間到達的新通知也暫停，pointercancel 會恢復計時', async () => {
        await mount();
        await notify('ok', 'A');
        await act(async () => { toasts()[0]!.props.onPointerDown({ pointerId: 1, clientY: 0 }); });
        await notify('ok', 'B');
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(toasts()).toHaveLength(2);
        await act(async () => { toasts()[0]!.props.onPointerCancel({ pointerId: 1 }); });
        await act(async () => { vi.advanceTimersByTime(5001); });
        expect(toasts()).toHaveLength(0);
    });
});

describe('錨點模式', () => {
    it('沒有面板為底部模式；有面板為頂部精簡模式並以 +N 計數；面板關閉回底部', async () => {
        await mount();
        await notify('err', UNKNOWN);
        await notify('ok', '委託已送出');
        await notify('info', '資訊');
        expect(host().props['data-anchor']).toBe('bottom');
        expect(view!.root.findAll(n => n.props['data-testid'] === 'toast-more')).toHaveLength(0);
        let reg: { unregister(): void } | undefined;
        await act(async () => {
            reg = registerSheet({ layer: 'sheet', getPanel: () => null, isDismissible: () => true, requestClose: () => undefined });
        });
        expect(host().props['data-anchor']).toBe('top');
        const more = view!.root.find(n => n.props['data-testid'] === 'toast-more');
        expect(text(more)).toBe('+2');
        // 前景仍是結果未知；其餘仍在 DOM（留給輔助技術）
        expect(toasts().find(t => t.props['data-front'] === 'true')!.props.className).toBe(styles.toast.warn);
        expect(toasts()).toHaveLength(3);
        // 點膠囊展開內文 5 秒
        await act(async () => { toasts()[0]!.props.onClick(); });
        expect(host().props['data-expanded']).toBe('true');
        expect(toasts()).toHaveLength(3);
        await act(async () => { vi.advanceTimersByTime(5001); });
        expect(host().props['data-expanded']).toBe('false');
        await act(async () => { reg!.unregister(); });
        expect(host().props['data-anchor']).toBe('bottom');
    });
});

describe('拖曳離場', () => {
    it('toastRelease：底部往下 projected > 40 或 v ≥ 500 離場；頂部鏡像', () => {
        expect(toastRelease({ offset: 30, velocity: 0, anchor: 'bottom' })).toBe('stay');
        expect(toastRelease({ offset: 41, velocity: 0, anchor: 'bottom' })).toBe('dismiss');
        expect(toastRelease({ offset: 10, velocity: 500, anchor: 'bottom' })).toBe('dismiss');
        expect(toastRelease({ offset: 10, velocity: 50, anchor: 'bottom' })).toBe('stay'); // 10 + 24.95
        expect(toastRelease({ offset: 10, velocity: 70, anchor: 'bottom' })).toBe('dismiss'); // 10 + 34.93
        expect(toastRelease({ offset: 45, velocity: -200, anchor: 'bottom' })).toBe('stay'); // 往回甩
        expect(toastRelease({ offset: -60, velocity: 0, anchor: 'bottom' })).toBe('stay');
        expect(toastRelease({ offset: -41, velocity: 0, anchor: 'top' })).toBe('dismiss');
        expect(toastRelease({ offset: -5, velocity: -500, anchor: 'top' })).toBe('dismiss');
        expect(toastRelease({ offset: 60, velocity: 0, anchor: 'top' })).toBe('stay');
        expect(toastRelease({ offset: Number.NaN, velocity: Number.NaN, anchor: 'bottom' })).toBe('stay');
    });

    const dragTo = async (t: () => ReactTestInstance, y: number, tEnd = 400) => {
        await act(async () => { t().props.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0, timeStamp: 100 }); });
        await act(async () => { t().props.onPointerMove({ pointerId: 1, clientX: 0, clientY: y / 2, timeStamp: 200 }); });
        await act(async () => { t().props.onPointerMove({ pointerId: 1, clientX: 0, clientY: y, timeStamp: 300 }); });
        await act(async () => { t().props.onPointerUp({ pointerId: 1, clientX: 0, clientY: y, timeStamp: tEnd }); });
    };

    it('底部模式往下拖過 40px 放手 → 離場；短拖回位且之後的 click 被攔下', async () => {
        await mount();
        await notify('ok', 'A');
        const first = () => toasts()[0]!;
        await dragTo(first, 20); // 放手時最後樣本已過 100ms → 速度 0
        expect(toasts()).toHaveLength(1);
        await act(async () => { first().props.onClick(); }); // 拖曳後 350ms 內
        expect(toasts()).toHaveLength(1);
        await act(async () => { vi.advanceTimersByTime(400); });
        await dragTo(first, 60);
        expect(toasts()).toHaveLength(0);
    });

    it('往反方向拖只有橡皮筋，不離場', async () => {
        await mount();
        await notify('ok', 'A');
        await dragTo(() => toasts()[0]!, -200);
        expect(toasts()).toHaveLength(1);
    });

    it('頂部模式往上拖離場、往下不離場', async () => {
        await mount();
        await act(async () => {
            registerSheet({ layer: 'sheet', getPanel: () => null, isDismissible: () => true, requestClose: () => undefined });
        });
        await notify('ok', 'A');
        await dragTo(() => toasts()[0]!, 80);
        expect(toasts()).toHaveLength(1);
        await act(async () => { vi.advanceTimersByTime(400); });
        await dragTo(() => toasts()[0]!, -60);
        expect(toasts()).toHaveLength(0);
    });
});

describe('動畫（節點 mock＋假時鐘）', () => {
    const setup = async (reduced: boolean) => {
        let now = 0;
        const frames = new Map<number, (t: number) => void>();
        let seq = 0;
        setMotionClockForTest({
            now: () => now,
            frame: cb => { seq += 1; frames.set(seq, cb); return seq; },
            cancel: id => { frames.delete(id); },
        });
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduced-motion'), addEventListener: () => undefined, removeEventListener: () => undefined }));
        const nodes: { style: Record<string, string> }[] = [];
        await act(async () => {
            view = create(createElement(ToastHost), {
                createNodeMock: el => {
                    const n = { style: {} as Record<string, string>, isConnected: true, getBoundingClientRect: () => ({ height: 60, top: 680, bottom: 740 }) };
                    if ((el.props as Record<string, unknown>)['data-testid'] === 'toast-item') nodes.push(n);
                    return n;
                },
            });
        });
        const step = async (ms: number) => {
            await act(async () => {
                for (let t = 0; t < ms; t += 16) {
                    now += 16;
                    const cbs = Array.from(frames.values());
                    frames.clear();
                    cbs.forEach(cb => cb(now));
                }
            });
        };
        return { nodes, step };
    };

    it('一般：從下方升起（只寫 transform）、退場滑出後才移除', async () => {
        const { nodes, step } = await setup(false);
        await notify('ok', 'A');
        const card = nodes[nodes.length - 1]!;
        expect(card.style.transform).toMatch(/^translateY\(\d+(\.\d+)?px\)$/);
        expect(card.style.opacity).toBeUndefined();
        await step(1500);
        expect(card.style.transform).toBe('none');
        await act(async () => { toasts()[0]!.find(n => n.type === 'button').props.onClick({ stopPropagation: () => undefined }); });
        expect(toasts()[0]!.props['data-leaving']).toBe('true');
        expect(toasts()[0]!.props['aria-hidden']).toBe(true);
        await step(2000);
        expect(toasts()).toHaveLength(0);
    });

    it('減少動態：只淡入淡出，不寫位移', async () => {
        const { nodes, step } = await setup(true);
        await notify('ok', 'A');
        const card = nodes[nodes.length - 1]!;
        expect(card.style.opacity).toBe('0');
        expect(card.style.transform).toBeUndefined();
        await step(200);
        expect(card.style.opacity).toBe('');
        await act(async () => { toasts()[0]!.find(n => n.type === 'button').props.onClick({ stopPropagation: () => undefined }); });
        expect(toasts()).toHaveLength(1);
        await step(200);
        expect(toasts()).toHaveLength(0);
        expect(card.style.transform).toBeUndefined();
    });
});

describe('單則錯誤邊界', () => {
    it('單則渲染失敗只略過（並移除）該則，其餘通知與容器照常，之後的通知仍可顯示', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        h.reveal = s => {
            if (s === '壞掉') throw new SyntaxError('Invalid regular expression: invalid group specifier name');
            return s;
        };
        await mount();
        await notify('err', UNKNOWN);
        await notify('info', '壞掉');
        await notify('ok', '委託已送出');
        expect(host().props['data-testid']).toBe('toast-host');
        expect(titles()).toEqual([UNKNOWN, '委託已送出']);
        expect(toasts()[0]!.props['data-front']).toBe('true');
        await notify('ok', '刪單已送出');
        expect(titles()).toEqual([UNKNOWN, '委託已送出', '刪單已送出']);
        // 失敗的那則已從清單移除：不再占上限、不留 TTL
        await act(async () => { vi.advanceTimersByTime(9001); });
        expect(toasts()).toHaveLength(0);
        err.mockRestore();
    });
});

describe('材質：同畫面模糊層 ≤ 3（§0.2 第 13 項、§4.6）', () => {
    it('只有前景保留 thick 模糊；非前景（data-front="false"）停用 backdrop-filter、底色實心', () => {
        expect(styles.STACKED_SOLID).toEqual({
            '&[data-front="false"]': { WebkitBackdropFilter: 'none', backdropFilter: 'none' },
            '&[data-front="false"]::before': { opacity: 1 },
        });
        // 每個 kind 都套用（STACKED_SOLID 展開在共用的 toastBase selectors 內）
        const src = readFileSync(new URL('../styles/toast.css.ts', import.meta.url), 'utf8');
        const base = src.slice(src.indexOf('const toastBase = style('), src.indexOf('export const toast = styleVariants('));
        expect(base).toContain('...STACKED_SOLID,');
        for (const kind of ['deal', 'ok', 'err', 'warn', 'info'] as const) {
            expect(src).toContain(`${kind}: [thick, toastBase,`);
        }
    });

    it('卡片標記 data-front：同時只有一則為 true（只有一個模糊層）', async () => {
        await mount();
        await notify('ok', 'A');
        await notify('err', UNKNOWN);
        await notify('info', 'B');
        expect(toasts().map(t => t.props['data-front'])).toEqual(['false', 'true', 'false']);
    });
});
