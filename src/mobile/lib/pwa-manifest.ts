// src/mobile/lib/pwa-manifest.ts — 手機版 PWA manifest（規格 §2.1、§13 Phase 3）
//
// 由 vite.fork.config.ts 的小型 plugin 在建置時產生 mobile.webmanifest（開發伺服器也提供同一份）。
// 純函式、不依賴瀏覽器或 Node API，方便單元測試。
// - 只有 manifest：不註冊 service worker、不快取任何 API（交易資料一律即時讀取）。
// - 圖示沿用 public/ 既有的 apple-touch-icon.png（尺寸由 PNG 檔頭讀出）與 favicon.svg（sizes any）。

export const MOBILE_MANIFEST_FILE = 'mobile.webmanifest';
export const MOBILE_MANIFEST_PATH = `/${MOBILE_MANIFEST_FILE}`;
export const MANIFEST_CONTENT_TYPE = 'application/manifest+json';

export interface PngSize {
    width: number;
    height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 讀 PNG 的 IHDR 取得寬高；不是 PNG 或檔頭不完整時丟錯（建置失敗，避免產生錯誤的 sizes） */
export function readPngSize(bytes: Uint8Array): PngSize {
    if (bytes.length < 24) throw new Error('PNG 檔頭不完整');
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('不是 PNG 檔');
    }
    // 第一個 chunk 必須是 IHDR（offset 12–15），寬高為 big-endian uint32（offset 16、20）
    if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') throw new Error('PNG 缺少 IHDR');
    const u32 = (o: number) => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
    const width = u32(16);
    const height = u32(20);
    if (!width || !height) throw new Error('PNG 寬高無效');
    return { width, height };
}

export interface ManifestIcon {
    src: string;
    sizes: string;
    type: string;
}

export interface WebManifest {
    name: string;
    short_name: string;
    lang: string;
    start_url: string;
    scope: string;
    display: 'standalone';
    background_color: string;
    theme_color: string;
    icons: ManifestIcon[];
}

/** 手機版 manifest 內容；appleTouchIcon 為 public/apple-touch-icon.png 的實際尺寸 */
export function buildMobileManifest(appleTouchIcon: PngSize): WebManifest {
    return {
        name: 'Shioaji Pro 手機版',
        short_name: 'SJ Pro',
        lang: 'zh-Hant',
        start_url: '/mobile.html',
        scope: '/',
        display: 'standalone',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
            { src: '/apple-touch-icon.png', sizes: `${appleTouchIcon.width}x${appleTouchIcon.height}`, type: 'image/png' },
            { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
    };
}

export function serializeManifest(manifest: WebManifest): string {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}
