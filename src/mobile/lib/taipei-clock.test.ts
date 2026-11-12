// 台北時間 HH:mm:ss（lib/taipei-clock、account-format formatClock）：不依裝置時區（2026-11-13 稽核）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatClock } from './account-format';
import { taipeiClock } from './taipei-clock';

// 2026-11-13 01:02:03 UTC＝台北 09:02:03；紐約 2026-11-12 20:02:03
const MS = Date.UTC(2026, 10, 13, 1, 2, 3);
let tz: string | undefined;

beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
});
afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
});

describe('taipeiClock', () => {
    it('裝置在其他時區（America/New_York）也顯示台北時間', () => {
        // 前提：時區確實切換了（本機 getHours 是紐約時間）
        expect(new Date(MS).getHours()).toBe(20);
        expect(taipeiClock(MS)).toBe('09:02:03');
        expect(formatClock(MS)).toBe('09:02:03');
    });

    it('跨日：UTC 16:00 是台北隔天 00:00', () => {
        expect(taipeiClock(Date.UTC(2026, 10, 12, 16, 0, 0))).toBe('00:00:00');
    });

    it('0、缺值、非有限值顯示 —', () => {
        for (const v of [0, null, undefined, NaN, Infinity]) expect(taipeiClock(v)).toBe('—');
        expect(formatClock(null)).toBe('—');
    });
});
