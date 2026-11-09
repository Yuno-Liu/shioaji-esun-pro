// 「伺服器未連線」提示的黏著判斷（移植上游 #384 WebServerHint）：down 出現、重連中維持、live 消失；從未 down 過的 connecting 不顯示。
import { describe, expect, it } from 'vitest';
import type { StreamStatus } from '../../lib/stream';
import { nextServerLost, SERVER_DOWN_DETAIL, SERVER_DOWN_TEXT, trackServerLost } from './server-down-hint';

const run = (seq: StreamStatus[]): boolean[] => {
    let lost = false;
    return seq.map(s => (lost = nextServerLost(s, lost)));
};

describe('nextServerLost', () => {
    it('down → connecting 維持 → live 消失', () => {
        expect(run(['live', 'down', 'connecting', 'connecting', 'live'])).toEqual([false, true, true, true, false]);
    });

    it('從未 down 過的 connecting／stale 不顯示', () => {
        expect(run(['connecting', 'connecting', 'live'])).toEqual([false, false, false]);
        expect(run(['live', 'stale', 'connecting', 'live'])).toEqual([false, false, false, false]);
    });

    it('down 之後經 stale／connecting 都維持，live 後再 connecting 不顯示', () => {
        expect(run(['down', 'stale', 'connecting', 'live', 'connecting'])).toEqual([true, true, true, false, false]);
    });
});

describe('trackServerLost（共用模組狀態）', () => {
    it('依序呼叫結果與純函式一致；同一狀態重複呼叫結果不變', () => {
        expect(trackServerLost('live')).toBe(false);
        expect(trackServerLost('connecting')).toBe(false);
        expect(trackServerLost('down')).toBe(true);
        expect(trackServerLost('connecting')).toBe(true);
        expect(trackServerLost('connecting')).toBe(true);
        expect(trackServerLost('live')).toBe(false);
        expect(trackServerLost('live')).toBe(false);
    });
});

describe('文字', () => {
    it('Docker 部署：提到 SJ_PRODUCTION 與 docker compose up -d', () => {
        expect(SERVER_DOWN_TEXT).toBe('伺服器未連線。');
        expect(SERVER_DOWN_DETAIL).toContain('SJ_PRODUCTION');
        expect(SERVER_DOWN_DETAIL).toContain('docker compose up -d');
        expect(SERVER_DOWN_DETAIL).toContain('Shioaji server');
    });
});
