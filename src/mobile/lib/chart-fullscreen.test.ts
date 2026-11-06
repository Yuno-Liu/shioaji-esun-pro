// 橫向全螢幕判斷（W2）：只有手機轉橫向才自動進入；裝置方向優先於視窗比例（Android 鍵盤不誤判）。
import { describe, expect, it } from 'vitest';
import { isLandscape, isPhoneSized, shouldAutoFullscreen } from './chart-fullscreen';

describe('chart-fullscreen', () => {
    it('screen.orientation 優先', () => {
        expect(isLandscape({ screen: { orientation: { type: 'landscape-primary' } }, innerWidth: 300, innerHeight: 800 })).toBe(true);
        // Android 叫出鍵盤：視窗變矮但裝置仍是直向
        expect(isLandscape({ screen: { orientation: { type: 'portrait-primary' } }, innerWidth: 400, innerHeight: 300, matchMedia: () => ({ matches: true }) })).toBe(false);
    });

    it('沒有 screen.orientation 時用 window.orientation（iOS 15），再退回 matchMedia、視窗比例', () => {
        expect(isLandscape({ orientation: 90 })).toBe(true);
        expect(isLandscape({ orientation: -90 })).toBe(true);
        expect(isLandscape({ orientation: 0, matchMedia: () => ({ matches: true }) })).toBe(false);
        expect(isLandscape({ matchMedia: () => ({ matches: true }) })).toBe(true);
        expect(isLandscape({ innerWidth: 800, innerHeight: 400 })).toBe(true);
    });

    it('只有手機尺寸（短邊 < 600）才自動全螢幕', () => {
        expect(isPhoneSized({ screen: { width: 390, height: 844 } })).toBe(true);
        expect(isPhoneSized({ screen: { width: 1180, height: 820 } })).toBe(false);
        expect(shouldAutoFullscreen({ screen: { width: 844, height: 390, orientation: { type: 'landscape-primary' } } })).toBe(true);
        expect(shouldAutoFullscreen({ screen: { width: 1180, height: 820, orientation: { type: 'landscape-primary' } } })).toBe(false);
        expect(shouldAutoFullscreen({ screen: { width: 390, height: 844, orientation: { type: 'portrait-primary' } } })).toBe(false);
        expect(shouldAutoFullscreen(undefined)).toBe(false);
    });

    it('裝置方向說橫向但視窗是直的：不自動全螢幕（方向資訊與版面不一致時不蓋掉直向畫面）', () => {
        const portraitViewport = { innerWidth: 390, innerHeight: 844 };
        expect(shouldAutoFullscreen({ screen: { width: 390, height: 844, orientation: { type: 'landscape-primary' } }, ...portraitViewport })).toBe(false);
        // 真正橫向：裝置方向與視窗比例一致 → 全螢幕
        expect(shouldAutoFullscreen({ screen: { width: 844, height: 390, orientation: { type: 'landscape-primary' } }, innerWidth: 844, innerHeight: 390 })).toBe(true);
        // Android 直向叫出鍵盤：視窗變扁但裝置方向仍是直向 → 不全螢幕
        expect(shouldAutoFullscreen({ screen: { width: 390, height: 844, orientation: { type: 'portrait-primary' } }, innerWidth: 390, innerHeight: 300 })).toBe(false);
    });
});
