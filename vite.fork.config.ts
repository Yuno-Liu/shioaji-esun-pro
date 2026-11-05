// vite.fork.config.ts — fork 擁有：不修改上游 vite.config.ts，加入手機入口（mobile.html）
// 建置：pnpm exec vite build --config vite.fork.config.ts（Dockerfile 使用）
// 規格：docs/fork/mobile-trading-spec.md §4.3
import path from 'node:path';
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import upstream from './vite.config';

export default defineConfig(async (env: ConfigEnv) => {
    // 上游設定是函式型（依 mode／command 產生），用同一組 env 取得實際設定
    const base = (typeof upstream === 'function' ? await upstream(env) : upstream) as UserConfig;
    // mergeConfig 會深層合併：rolldownOptions.input 保留 main、approval，再加上 mobile
    return mergeConfig(base, {
        build: {
            rolldownOptions: {
                input: { mobile: path.resolve(__dirname, 'mobile.html') },
            },
        },
    });
});
