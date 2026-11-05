// PWA manifest：PNG 尺寸讀取與 manifest 內容（不含 service worker、不快取 API）
import { describe, expect, it } from 'vitest';
import { buildMobileManifest, MOBILE_MANIFEST_FILE, readPngSize, serializeManifest } from './pwa-manifest';

/** 最小 PNG 檔頭：簽章＋IHDR 長度＋'IHDR'＋寬高 */
function pngHeader(width: number, height: number): Uint8Array {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, width);
    dv.setUint32(20, height);
    return b;
}

describe('readPngSize', () => {
    it('讀出 IHDR 的寬高（big-endian）', () => {
        expect(readPngSize(pngHeader(180, 180))).toEqual({ width: 180, height: 180 });
        expect(readPngSize(pngHeader(512, 256))).toEqual({ width: 512, height: 256 });
        expect(readPngSize(pngHeader(70000, 1))).toEqual({ width: 70000, height: 1 });
    });

    it('不是 PNG、檔頭不完整、缺 IHDR、寬高為 0 都丟錯', () => {
        expect(() => readPngSize(new Uint8Array(10))).toThrow();
        const notPng = pngHeader(180, 180);
        notPng[1] = 0;
        expect(() => readPngSize(notPng)).toThrow();
        const noIhdr = pngHeader(180, 180);
        noIhdr[12] = 0x41;
        expect(() => readPngSize(noIhdr)).toThrow();
        expect(() => readPngSize(pngHeader(0, 180))).toThrow();
    });
});

describe('buildMobileManifest', () => {
    it('名稱、起始頁、範圍、顯示模式、顏色與圖示', () => {
        const m = buildMobileManifest({ width: 180, height: 180 });
        expect(m).toEqual({
            name: 'Shioaji Pro 手機版',
            short_name: 'SJ Pro',
            lang: 'zh-Hant',
            start_url: '/mobile.html',
            scope: '/',
            display: 'standalone',
            background_color: '#000000',
            theme_color: '#000000',
            icons: [
                { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
                { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
            ],
        });
    });

    it('序列化為合法 JSON，不含 service worker 相關欄位', () => {
        const text = serializeManifest(buildMobileManifest({ width: 192, height: 192 }));
        const parsed = JSON.parse(text) as Record<string, unknown>;
        expect(parsed.icons).toContainEqual({ src: '/apple-touch-icon.png', sizes: '192x192', type: 'image/png' });
        expect(text).not.toMatch(/serviceworker|service_worker/i);
        expect(MOBILE_MANIFEST_FILE).toBe('mobile.webmanifest');
    });
});
