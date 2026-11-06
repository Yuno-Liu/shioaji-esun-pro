// reveal-compat（設計規格 §12 相容 iOS 15.4）：
// - revealTextCompat 與 src/lib/privacy.ts 的 revealText（本機 Node 支援 lookbehind）逐字一致（固定案例＋亂數對照）；
// - 模擬不支援 lookbehind 的引擎（new RegExp 遇 (?<! 丟 SyntaxError）：原 useRevealText 會在渲染時丟錯（修正前的行為），
//   useRevealTextCompat 照常遮蔽。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ accounts: [] as { account_id: string }[] }));
vi.mock('../../lib/account-store', () => ({ useAccounts: () => ({ accounts: h.accounts }) }));

import { revealText, secretAccount, secretMoney, setPrivacyMode, setPrivacyMoney } from '../../lib/privacy';
import { useRevealText } from '../../lib/privacy-text';
import { revealTextCompat, useRevealTextCompat } from './reveal-compat';

const MONEY = '⁡';
const ACCOUNT = '⁢';
const END = '⁣';

describe('revealTextCompat 與 revealText 逐字一致', () => {
    const IDS = ['9816502', '1234', '0012345678', 'A1B2', 'x.y*', '1234-', '-5678', '123', '9816502'];
    const CASES = [
        '帳號 9816502 下單失敗',
        '9816502',
        'X9816502 不遮（前面是英數）',
        '98165023 不遮（後面是英數）',
        '1234-5678 與 1234--5678',
        '0012345678／12345678／001234',
        'A1B2 a1b2 ZA1B2 A1B2Z (A1B2)',
        'x.y* 與 xzy* 與 x.y*z',
        '多個：1234,1234 1234_1234 1234.1234',
        `${ACCOUNT}9816502${END} 標記帳號 9816502；金額 ${MONEY}1,234${END}`,
        '',
        '沒有帳號的一般文字',
        '中文緊貼9816502中文',
    ];
    const OPTS = [
        { priv: true, privMoney: true },
        { priv: true, privMoney: false },
        { priv: false, privMoney: true },
        { priv: false, privMoney: false },
    ];

    it('固定案例', () => {
        for (const text of CASES) {
            for (const o of OPTS) {
                for (const accountIds of [IDS, [], undefined, ['123'], ['1234-', '-5678']]) {
                    const opts = { ...o, accountIds };
                    expect(revealTextCompat(text, opts), JSON.stringify({ text, opts })).toBe(revealText(text, opts));
                }
            }
        }
        // 確認真的有遮（不是兩邊都沒做事）
        expect(revealTextCompat('帳號 9816502；1234-5678', { priv: true, privMoney: false, accountIds: IDS })).toBe('帳號 •••••02；••34-5678');
    });

    it('亂數對照（小字母表，含標記字元、英數與符號）', () => {
        const alphabet = ['1', '2', '3', '4', 'A', 'b', '-', '.', ' ', '中', MONEY, ACCOUNT, END];
        let seed = 20261106;
        const rand = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const word = (min: number, max: number) => {
            let s = '';
            const len = min + rand(max - min + 1);
            for (let i = 0; i < len; i++) s += alphabet[rand(10)]; // 帳號不含標記字元
            return s;
        };
        for (let n = 0; n < 3000; n++) {
            const ids = Array.from({ length: 1 + rand(4) }, () => word(2, 6));
            let text = '';
            const len = rand(30);
            for (let i = 0; i < len; i++) text += rand(4) === 0 ? ids[rand(ids.length)] : alphabet[rand(alphabet.length)];
            const opts = { priv: rand(4) !== 0, privMoney: rand(2) === 0, accountIds: ids };
            expect(revealTextCompat(text, opts), JSON.stringify({ text, opts })).toBe(revealText(text, opts));
        }
    });
});

describe('不支援 lookbehind 的引擎（Safari < 16.4）', () => {
    let view: ReactTestRenderer | undefined;
    const NativeRegExp = RegExp;

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        // 模擬舊引擎：字串建構含 lookbehind 的正規式時丟 SyntaxError（字面量正規式在模組載入時已建好，不受影響）
        const Fake = new Proxy(NativeRegExp, {
            construct(target, args: [string | RegExp, string?]) {
                const src = typeof args[0] === 'string' ? args[0] : args[0].source;
                if (src.includes('(?<!') || src.includes('(?<=')) throw new SyntaxError('Invalid regular expression: invalid group specifier name');
                return Reflect.construct(target, args);
            },
        });
        vi.stubGlobal('RegExp', Fake);
        h.accounts = [{ account_id: '9816502' }, { account_id: '0012345' }];
        setPrivacyMode(true);
        setPrivacyMoney(false);
    });
    afterEach(async () => {
        await act(async () => view?.unmount());
        view = undefined;
        vi.unstubAllGlobals();
        setPrivacyMode(false);
        setPrivacyMoney(false);
        h.accounts = [];
    });

    const Probe = ({ hook, text }: { hook: () => (s: string) => string; text: string }) => createElement('span', null, hook()(text));
    const render = async (hook: () => (s: string) => string, text: string) => {
        await act(async () => { view = create(createElement(Probe, { hook, text })); });
        return view!.root.findByType('span').children.join('');
    };

    it('原 useRevealText 在隱私模式＋已知帳號時渲染即丟 SyntaxError（修正前的問題）', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(render(useRevealText, '帳號 9816502')).rejects.toThrow(SyntaxError);
        err.mockRestore();
    });

    it('useRevealTextCompat 照常遮蔽已知帳號、標記片段與金額', async () => {
        const text = `帳號 9816502 / X0012345 / ${secretAccount('0012345')} / ${secretMoney('1,000')}`;
        setPrivacyMoney(true);
        expect(await render(useRevealTextCompat, text)).toBe('帳號 •••••02 / X0012345 / •••••45 / •••••');
    });

    it('隱私模式關閉時不遮帳號', async () => {
        setPrivacyMode(false);
        expect(await render(useRevealTextCompat, '帳號 9816502')).toBe('帳號 9816502');
    });
});
