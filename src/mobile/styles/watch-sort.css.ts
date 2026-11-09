// src/mobile/styles/watch-sort.css.ts — 自選清單排序鍵與「排序依據」列（components/watch-sort.tsx，延遲載入；設計規格 §7.2）
// - 排序鍵在表頭（名稱｜排序｜指標切換｜編輯）：文字鍵，點擊區 TOUCH_MIN（不靠 ::before 擴張，避免與指標切換鍵的擴張區重疊）。
// - 「排序依據 HH:MM:SS ⟳」：表頭內換到第二行（表頭 flex-wrap，這列 order 1、佔滿整行），⟳ 為 44px IconButton。
// - 顏色只用 vars；文字 footnote；不新增動畫。
import { style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { RADIUS, SAFE_RIGHT, SPACE, TOUCH_MIN } from './tokens';
import { NUMERIC, TEXT } from './typography.css';

export const sortButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.s1,
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    margin: 0,
    padding: `0 ${SPACE.s2}`,
    border: 'none',
    borderRadius: RADIUS.md,
    background: 'transparent',
    ...TEXT.footnote,
    fontWeight: 600,
    color: vars.color.accent,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
});

export const sortIcon = style({
    width: '0.875rem',
    height: '0.875rem',
    flex: '0 0 auto',
});

/**
 * 固定清單的表頭（名稱｜排序｜指標切換，沒有編輯鍵）：右內距加大，指標切換鍵 ::before 往右擴的 8px 點擊區留在表頭內
 * （自選表頭最右是編輯鍵，不需要）。&& 提高權重，蓋過 listHeader 的 padding。
 */
export const fixedHeader = style({
    selectors: {
        '&&': { paddingRight: `calc(${SPACE.s3} + ${SAFE_RIGHT})` },
    },
});

/** 表頭第二行：排序依據時間＋⟳ */
export const basisLine = style({
    order: 1,
    flex: '1 0 100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.s2,
    minWidth: 0,
    minHeight: TOUCH_MIN,
});

export const basisText = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const basisError = style({
    color: vars.color.danger,
});

/** 選項面板 */
export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
});

export const optionCheck = style({
    width: '1.125rem',
    height: '1.125rem',
    color: vars.color.accent,
});
