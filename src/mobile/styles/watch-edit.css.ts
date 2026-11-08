// src/mobile/styles/watch-edit.css.ts — 自選編輯模式延遲載入 chunk（components/watch-edit-controls.tsx）專用的樣式（設計規格 §7.2）
// - 只由延遲載入的編輯 chunk import（不進首屏）；共用的外觀沿用 watchlist.css.ts（listTool、grip）與 controls.css.ts（button）。
// - 多選：列首勾選圈（IconButton 44 尺寸、role=checkbox；勾選與否以圖示形狀區分，不只靠顏色）、底部配件槽的選取列。
// - 選取狀態以文字＋圖示表示；顏色只用 vars／sj。只動畫 opacity（共用 pressable）。
import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../../theme.css';
import { sj } from './theme-vars.css';
import { RADIUS, SAFE_LEFT, SAFE_RIGHT, SIZE, SPACE, TOUCH_MIN } from './tokens';
import { NUMERIC, TEXT } from './typography.css';

/** 列首勾選圈的外框（與列首「−」同位置） */
export const checkCell = style({
    alignSelf: 'center',
    marginLeft: `calc(${SPACE.s1} + ${SAFE_LEFT})`,
});

/** 勾選圈：未選 mutedForeground 空心圈、已選 accent 打勾圈 */
export const check = style({});
globalStyle(`${check} svg`, { color: vars.color.mutedForeground });
globalStyle(`${check}[aria-checked="true"] svg`, { color: vars.color.accent });

/** 工具列的切換鍵（多選）與全選：開啟／部分選取時 accent 文字（另有圖示與文字，不只靠顏色） */
export const toolOn = style({
    gap: SPACE.s1,
    selectors: {
        '&[aria-pressed="true"], &[aria-checked="true"], &[aria-checked="mixed"]': { color: vars.color.accent, borderColor: vars.color.accent },
    },
});

/** 編輯模式說明文字：在清單工具列（flex-wrap）內獨占一行 */
export const hint = style({
    flexBasis: '100%',
});

// ---- 多選：底部配件槽（ShellSlot bottom） ----

export const bar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACE.s2,
    padding: `${SPACE.s2} calc(${SPACE.s4} + ${SAFE_RIGHT}) ${SPACE.s2} calc(${SPACE.s4} + ${SAFE_LEFT})`,
    minWidth: 0,
});

export const barCount = style({
    flex: '1 1 auto',
    minWidth: 0,
    ...TEXT.callout,
    fontWeight: 600,
    ...NUMERIC,
    color: vars.color.foreground,
});

/** 「刪除 N 檔」：danger 外框（不做實心，避免與台灣配色的紅色買進鍵混淆） */
export const dangerOutline = style({
    flex: '0 0 auto',
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s3}`,
    margin: 0,
    borderRadius: RADIUS.lg,
    border: `1px solid ${vars.color.danger}`,
    background: vars.color.panel,
    color: vars.color.danger,
    ...TEXT.callout,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
    selectors: {
        '&:disabled': { opacity: 0.45, cursor: 'default' },
    },
});

// ---- 面板（刪除確認、排序群組） ----

export const sheetBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: SPACE.s3,
    paddingBottom: SPACE.s2,
    minWidth: 0,
});

export const note = style({
    margin: 0,
    ...TEXT.footnote,
    color: vars.color.mutedForeground,
});

/** 面板內的清單（要刪除的商品、群組）：卡片底、髮絲分隔 */
export const sheetList = style({
    listStyle: 'none',
    margin: 0,
    padding: 0,
    borderRadius: RADIUS.lg,
    background: sj.elevatedBg,
    overflow: 'hidden',
});

export const sheetItem = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: SPACE.s1,
    minHeight: TOUCH_MIN,
    padding: `0 ${SPACE.s1} 0 ${SPACE.s4}`,
    background: sj.elevatedBg,
    color: vars.color.foreground,
    ...TEXT.body,
    selectors: {
        '& + &': { borderTop: `0.5px solid ${vars.color.border}` },
    },
});

/** 刪除確認的清單：最多約 5 列高，超過時在卡片內捲動 */
export const sheetListScroll = style({
    maxHeight: `calc(${SIZE.controlLarge} * 5)`,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
});

export const itemName = style({
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const itemMeta = style({
    flex: '0 0 auto',
    ...TEXT.footnote,
    ...NUMERIC,
    color: vars.color.mutedForeground,
});

/** 面板底部兩鍵（取消｜確定）：窄螢幕＋大字時換行 */
export const actions = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: SPACE.s2,
});

globalStyle(`${actions} > button`, { flex: '1 1 8rem' });
