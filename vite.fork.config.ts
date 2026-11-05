// vite.fork.config.ts — fork 擁有：不修改上游 vite.config.ts，加入手機入口（mobile.html）
// 建置：pnpm exec vite build --config vite.fork.config.ts（Dockerfile 使用）
// 規格：docs/fork/mobile-trading-spec.md §4.3
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, mergeConfig, type ConfigEnv, type Plugin, type UserConfig } from 'vite';
import upstream from './vite.config';
import {
    buildMobileManifest,
    MANIFEST_CONTENT_TYPE,
    MOBILE_MANIFEST_FILE,
    MOBILE_MANIFEST_PATH,
    readPngSize,
    serializeManifest,
} from './src/mobile/lib/pwa-manifest';

/**
 * 手機版 PWA manifest（規格 §13 Phase 3）：建置時輸出 dist/mobile.webmanifest，開發伺服器提供同一份。
 * 只有 manifest：不加 service worker、不快取任何 API。內容由 src/mobile/lib/pwa-manifest.ts 的純函式產生。
 */
function mobileManifestPlugin(): Plugin {
    const iconPath = path.resolve(__dirname, 'public/apple-touch-icon.png');
    const source = () => serializeManifest(buildMobileManifest(readPngSize(fs.readFileSync(iconPath))));
    return {
        name: 'shioaji-mobile-manifest',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url?.split('?')[0] !== MOBILE_MANIFEST_PATH) return next();
                res.setHeader('Content-Type', MANIFEST_CONTENT_TYPE);
                res.setHeader('Cache-Control', 'no-cache');
                res.end(source());
            });
        },
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: MOBILE_MANIFEST_FILE, source: source() });
        },
    };
}

export default defineConfig(async (env: ConfigEnv) => {
    // 上游設定是函式型（依 mode／command 產生），用同一組 env 取得實際設定
    const base = (typeof upstream === 'function' ? await upstream(env) : upstream) as UserConfig;
    // mergeConfig 會深層合併：rolldownOptions.input 保留 main、approval，再加上 mobile；plugins 陣列串接
    return mergeConfig(base, {
        plugins: [mobileManifestPlugin()],
        build: {
            rolldownOptions: {
                input: { mobile: path.resolve(__dirname, 'mobile.html') },
            },
        },
    });
});
