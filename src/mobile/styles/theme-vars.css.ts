// src/mobile/styles/theme-vars.css.ts — 手機語意變數與深淺映射（設計規格 §4.2、§4.5）
// 只讀取 src/theme.css.ts 的 vars／themeClasses，不修改 theme。主題 class 掛在 <html>；
// 自訂配色以 base class（dark／light）加 inline 覆寫 vars.color.*，因此映射自動跟隨自訂配色。
import { createVar, globalStyle } from '@vanilla-extract/css';
import { themeClasses, vars } from '../../theme.css';
import { EDGE_LIGHT, ELEVATION, THEME_ALPHA, type ThemeAlpha } from './tokens';

export const sj = {
    /** 清單型頁面表面（自選、交易、委託） */
    contentBg: createVar(),
    /** GroupedSection 卡片 */
    groupedBg: createVar(),
    /** 面板內中性島（報價、資訊、五檔、輸入框、未選方向鍵、滑塊軌道） */
    islandBg: createVar(),
    /** 晶片、步進鍵 */
    elevatedBg: createVar(),
    /** 分段軌道 */
    segTrack: createVar(),
    /** 分段選中拇指 */
    segThumb: createVar(),
    /** 實心填色疊黑（小字）alpha */
    inkStrong: createVar(),
    /** 實心填色疊黑（≥1.1875rem 粗體或純圖示）alpha */
    inkLarge: createVar(),
    /** 第一層暗化幕 alpha */
    scrim: createVar(),
    /** 疊在另一面板上的暗化幕 alpha */
    scrimStack: createVar(),
    /** bar 材質底色不透明度 */
    barAlpha: createVar(),
    /** thick 材質底色不透明度 */
    thickAlpha: createVar(),
    /** 面板與按鍵上緣受光線 */
    edgeLight: createVar(),
};

const alphaVars = (a: ThemeAlpha) => ({
    [sj.inkStrong]: String(a.inkStrong),
    [sj.inkLarge]: String(a.inkLarge),
    [sj.scrim]: String(a.scrim),
    [sj.scrimStack]: String(a.scrimStack),
    [sj.barAlpha]: String(a.barAlpha),
    [sj.thickAlpha]: String(a.thickAlpha),
});

const dark = {
    [sj.contentBg]: vars.color.background,
    [sj.groupedBg]: vars.color.muted,
    [sj.islandBg]: vars.color.inset,
    [sj.elevatedBg]: vars.color.panelRaised,
    [sj.segTrack]: vars.color.muted,
    [sj.segThumb]: vars.color.borderBright,
    ...alphaVars(THEME_ALPHA.dark),
    [sj.edgeLight]: EDGE_LIGHT.dark,
};

const light = {
    [sj.contentBg]: vars.color.panel,
    [sj.groupedBg]: vars.color.panel,
    [sj.islandBg]: vars.color.panel,
    [sj.elevatedBg]: vars.color.panel,
    [sj.segTrack]: vars.color.muted,
    [sj.segThumb]: vars.color.panel,
    ...alphaVars(THEME_ALPHA.light),
    [sj.edgeLight]: EDGE_LIGHT.light,
};

// 尚未套主題 class 時的預設（深色）；html.<主題> 的權重高於 :root
globalStyle(':root', { vars: dark });
globalStyle(`html.${themeClasses['dark-tw']}, html.${themeClasses['dark-intl']}`, { vars: dark });
globalStyle(`html.${themeClasses['light-tw']}, html.${themeClasses['light-intl']}`, { vars: light });

/** 陰影（§4.5）：e1、e3 疊上緣受光線（淺色 edgeLight 為 transparent，等同只在深色加）；不對 box-shadow 做動畫 */
export const elevation = {
    e1: `${ELEVATION.e1}, inset 0 .5px 0 ${sj.edgeLight}`,
    e2: ELEVATION.e2,
    e3: `${ELEVATION.e3}, inset 0 .5px 0 ${sj.edgeLight}`,
} as const;

/** 暗化幕底色（§4.5）：第一層與疊在另一面板之上 */
export const scrimColor = {
    base: `rgba(0,0,0,${sj.scrim})`,
    stack: `rgba(0,0,0,${sj.scrimStack})`,
} as const;
