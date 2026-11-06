// src/mobile/styles/typography.css.ts — 字級與數字樣式（設計規格 §4.7）
// rem 隨字級（root 16px＝字級「小」）；字族沿用 layout.css.ts 的 body 系統字（不另設 fontFamily）。
// 字重只用 400／500／600／700。中文不加負字距；負字距只套在 num 樣式。
// 價量一律同字族 tabular＋lining；手機不再以 theme 的等寬字族顯示價量（等寬只留書號、完整帳號與診斷值）。
import { style, styleVariants } from '@vanilla-extract/css';

interface TypeSpec {
    fontSize: string;
    fontWeight: 400 | 500 | 600 | 700;
    lineHeight: number;
    letterSpacing: string;
}

const spec = (fontSize: string, fontWeight: TypeSpec['fontWeight'], lineHeight: number, letterSpacing = '0'): TypeSpec => ({
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing,
});

/** 文字字級表（純值，供需要組合的 *.css.ts 展開使用） */
export const TEXT = {
    /** 頁首標題（h1 文字不變） */
    pageTitle: spec('1.25rem', 700, 1.25),
    /** 面板標題 */
    sheetTitle: spec('1.0625rem', 700, 1.3),
    /** 列主文字、代碼、名稱 */
    headline: spec('0.9375rem', 600, 1.3),
    /** 說明段落 */
    body: spec('0.9375rem', 400, 1.5),
    /** 分段、晶片、按鈕 */
    callout: spec('0.875rem', 500, 1.35),
    /** 列第二行 */
    subhead: spec('0.8125rem', 400, 1.4, '0.01em'),
    /** 欄位標籤、註腳 */
    footnote: spec('0.75rem', 400, 1.35, '0.01em'),
    /** 徽章、分頁標籤（最小字級） */
    caption: spec('0.6875rem', 600, 1.25, '0.02em'),
    /** 方向鍵、交易鍵、CTA、選價列（≥1.1875rem 粗體 → 可用 inkLarge） */
    actionLabel: spec('1.1875rem', 700, 1.25, '0.02em'),
    /** 確認面板動作字 */
    confirmAction: spec('1.75rem', 700, 1.2, '0.02em'),
    /** 確認面板環境橫幅 */
    envBanner: spec('1.25rem', 700, 1.3, '0.08em'),
} as const satisfies Record<string, TypeSpec>;

/** 數字字級表 */
export const NUM = {
    /** 交易頁主價、持倉損益合計 */
    numHero: spec('1.75rem', 700, 1.1, '-0.02em'),
    /** 價格與數量輸入（≥16px） */
    numLg: spec('1.25rem', 700, 1.2, '-0.01em'),
    /** 列價格、五檔價 */
    numMd: spec('0.9375rem', 600, 1.2),
    /** 量、統計格、成本 */
    numSm: spec('0.8125rem', 500, 1.2),
} as const satisfies Record<string, TypeSpec>;

/** 數字特性：等寬、齊線（同字族，不換 mono） */
export const NUMERIC = {
    fontVariantNumeric: 'tabular-nums lining-nums',
    fontFeatureSettings: '"tnum" 1, "lnum" 1',
} as const;

/** 只加數字特性（不改字級），給既有樣式組合用 */
export const tabular = style(NUMERIC);

/** 文字樣式 class */
export const text = styleVariants(TEXT, s => ({ ...s }));

/** 數字樣式 class（含 tabular） */
export const num = styleVariants(NUM, s => [tabular, { ...s }]);
