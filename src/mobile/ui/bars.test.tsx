// VolumeBar／RatioBar／ProgressBar：只用 transform scaleX（不用 width）、aria-hidden、方向原點
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as styles from './bars.css';
import { ProgressBar, RatioBar, scaleXOf, VolumeBar } from './bars';

let view: ReactTestRenderer | undefined;
const styled = () => view!.root.findAll((n: ReactTestInstance) => typeof n.type === 'string' && n.props.style !== undefined);

async function render(el: ReturnType<typeof createElement>) {
    await act(async () => {
        if (view) view.update(el);
        else view = create(el);
    });
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('scaleXOf', () => {
    it('clamps to 0–1 and rounds', () => {
        expect(scaleXOf(0.5)).toBe('scaleX(0.5)');
        expect(scaleXOf(2)).toBe('scaleX(1)');
        expect(scaleXOf(-1)).toBe('scaleX(0)');
        expect(scaleXOf(Number.NaN)).toBe('scaleX(0)');
        expect(scaleXOf(1 / 3)).toBe('scaleX(0.3333)');
    });
});

describe('VolumeBar', () => {
    it('scales by volume ÷ max with side-specific origin class', async () => {
        await render(createElement(VolumeBar, { value: 30, max: 120, side: 'buy' }));
        const [bar] = styled();
        expect(bar!.props.style).toEqual({ transform: 'scaleX(0.25)' });
        expect(bar!.props.className).toBe(styles.volume.buy);
        expect(bar!.props['aria-hidden']).toBe('true');
        await render(createElement(VolumeBar, { value: 5, max: 0, side: 'sell' }));
        expect(styled()[0]!.props.style).toEqual({ transform: 'scaleX(0)' });
        expect(styled()[0]!.props.className).toBe(styles.volume.sell);
    });
});

describe('RatioBar', () => {
    it('left grows from the left, right from the right', async () => {
        await render(createElement(RatioBar, { left: 62, right: 38, leftTone: 'up', rightTone: 'down', testId: 'depth-ratio-bar' }));
        const [l, r] = styled();
        expect(l!.props.style).toEqual({ transform: 'scaleX(0.62)' });
        expect(l!.props.className).toBe(styles.fillLeft.up);
        expect(r!.props.style).toEqual({ transform: 'scaleX(0.38)' });
        expect(r!.props.className).toBe(styles.fillRight.down);
    });
});

describe('ProgressBar', () => {
    it('matches the positions-page contract: aria-hidden track whose only styled node is scaleX', async () => {
        await render(createElement(ProgressBar, { percent: 50, tone: 'up', testId: 'position-pnl-bar' }));
        const bar = view!.root.find(n => n.props['data-testid'] === 'position-pnl-bar' && typeof n.type === 'string');
        expect(bar.props['aria-hidden']).toBe('true');
        const fill = bar.find(n => typeof n.type === 'string' && n.props.style !== undefined);
        expect(fill.props.style.transform).toBe('scaleX(0.5)');
        expect(fill.props.style.width).toBeUndefined();
    });

    it('origin right uses the right-origin fill', async () => {
        await render(createElement(ProgressBar, { percent: 20, origin: 'right', tone: 'down' }));
        expect(styled()[0]!.props.className).toBe(styles.fillRight.down);
    });
});
