// src/mobile/styles/tokens.ts — 手機版 design tokens（設計規格 docs/fork/mobile-design.md §4）
// 純常數（不含 vanilla-extract 呼叫），供 *.css.ts、motion 與元件共用。
// 顏色一律用 src/theme.css.ts 的 vars 與 theme-vars.css.ts 的 sj 映射；這裡只放尺寸、時間與不透明度數值。

// ---- 安全區與媒體查詢 ----

/** 安全區（viewport-fit=cover 時才有值；舊瀏覽器 env() 不支援時退回 0） */
export const SAFE_TOP = 'env(safe-area-inset-top, 0px)';
export const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';
export const SAFE_LEFT = 'env(safe-area-inset-left, 0px)';
export const SAFE_RIGHT = 'env(safe-area-inset-right, 0px)';

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
export const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';
export const MORE_CONTRAST = '(prefers-contrast: more)';
/** 低密度螢幕：0.5px 髮絲線改 1px */
export const LOW_DPR = '(-webkit-max-device-pixel-ratio: 1.5), (max-resolution: 1.5dppx)';

// ---- §4.3 間距（4pt 格線，rem 隨字級） ----

export const SPACE = {
    s1: '0.25rem',
    s1_5: '0.375rem',
    s2: '0.5rem',
    s3: '0.75rem',
    s4: '1rem',
    s5: '1.25rem',
    s6: '1.5rem',
    s8: '2rem',
} as const;

// ---- §4.3 尺寸 ----

/** 觸控目標最小尺寸（44pt；字級大時隨 rem 放大） */
export const TOUCH_MIN = 'max(44px, 2.75rem)';
/** 買進／賣出按鈕最小高度（px 固定：滑塊幾何 SLIDE_HANDLE_SPAN_PX 依賴） */
export const TRADE_BUTTON_MIN_HEIGHT = '56px';
/** 買進／賣出兩鍵最小間距（px，不隨字級） */
export const TRADE_BUTTON_GAP = '12px';
/** 輸入欄位字級下限（避免 iOS Safari 聚焦時自動放大） */
export const INPUT_FONT_SIZE = 'max(16px, 1rem)';

export const SIZE = {
    touchMin: TOUCH_MIN,
    /** 外觀 36px；點擊區以 ::before { inset: -4px 0 } 擴到 TOUCH_MIN，相鄰元素須留 ≥8px 垂直間距 */
    controlCompact: '2.25rem',
    controlRegular: TOUCH_MIN,
    /** 方向鍵、交易鍵列、CTA、選價列、全螢幕買賣鍵 */
    controlLarge: 'max(56px, 3.5rem)',
    slideTrack: TRADE_BUTTON_MIN_HEIGHT,
    slideHandle: '48px',
    slideInset: '3px',
    tradeButtonGap: TRADE_BUTTON_GAP,
    stripH: TOUCH_MIN,
    tabbarH: '49px',
    compactBarH: '40px',
    /** 交易鍵列＝56＋上下 8 */
    tradeBarH: '72px',
    /** 列內距：上下 .6875rem、左右 s4 */
    rowPadY: '0.6875rem',
    rowPadX: SPACE.s4,
} as const;

/** 殼層 CSS 自訂屬性名稱（設在 .shell；由 B2 殼層套用） */
export const SHELL_VAR = {
    stripH: '--sj-strip-h',
    tabbarH: '--sj-tabbar-h',
    accessoryH: '--sj-accessory-h',
    sheetTop: '--sj-sheet-top',
    kb: '--sj-kb',
} as const;

/** 殼層 CSS 自訂屬性預設值（§4.3） */
export const SHELL_VAR_DEFAULTS = {
    [SHELL_VAR.stripH]: `calc(${TOUCH_MIN} + ${SAFE_TOP})`,
    [SHELL_VAR.tabbarH]: `calc(${SIZE.tabbarH} + ${SAFE_BOTTOM})`,
    [SHELL_VAR.accessoryH]: '0px',
    [SHELL_VAR.sheetTop]: `calc(var(${SHELL_VAR.stripH}) + 8px)`,
    [SHELL_VAR.kb]: '0px',
} as const;

// ---- §4.4 圓角（px，不隨字級；同心：內層＝外層－內距） ----

export const RADIUS = {
    xs: '4px',
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    pill: '999px',
    /** 分段軌道 9px、內距 2px → 拇指 7px */
    segTrack: '9px',
    segThumb: '7px',
} as const;

// ---- §4.5 陰影（深色的上緣受光線由 theme-vars.css.ts 的 elevation 疊上 sj.edgeLight） ----

export const ELEVATION = {
    /** 拇指、步進鍵、晶片 */
    e1: '0 1px 2px rgba(0,0,0,.20), 0 0 0 .5px rgba(0,0,0,.10)',
    /** 通知、選價列 */
    e2: '0 6px 20px rgba(0,0,0,.28)',
    /** 面板 */
    e3: '0 -8px 30px rgba(0,0,0,.40)',
} as const;

/** 疊層順序：bars < compactBar < accessory < fullscreenChart < sheet（堆疊每層 +sheetStep）< confirm < toast */
export const Z = {
    bars: 10,
    compactBar: 11,
    accessory: 12,
    fullscreenChart: 50,
    sheet: 100,
    sheetStep: 10,
    confirm: 200,
    toast: 300,
} as const;

// ---- §4.2 主題映射的數值（不透明度；由 theme-vars.css.ts 寫入 createVar） ----

export interface ThemeAlpha {
    /** 實心填色疊黑（小字） */
    inkStrong: number;
    /** 實心填色疊黑（≥1.1875rem 粗體或純圖示） */
    inkLarge: number;
    /** 第一層暗化幕 */
    scrim: number;
    /** 疊在另一面板上的暗化幕 */
    scrimStack: number;
    /** bar 材質底色不透明度 */
    barAlpha: number;
    /** thick 材質底色不透明度 */
    thickAlpha: number;
}

export const THEME_ALPHA: { dark: ThemeAlpha; light: ThemeAlpha } = {
    dark: { inkStrong: 0.28, inkLarge: 0.12, scrim: 0.56, scrimStack: 0.24, barAlpha: 0.72, thickAlpha: 0.86 },
    light: { inkStrong: 0.08, inkLarge: 0, scrim: 0.36, scrimStack: 0.24, barAlpha: 0.8, thickAlpha: 0.9 },
};

/** 面板與按鍵上緣受光線 */
export const EDGE_LIGHT = { dark: 'rgba(255,255,255,0.08)', light: 'transparent' } as const;

// ---- §4.9 動態 ----

/** 彈簧：阻尼比 ζ 與反應時間 response（秒）；m=1、ω0=2π/response、k=ω0²、c=2ζω0 */
export interface SpringToken {
    zeta: number;
    response: number;
}

export const SPRING = {
    /** 一般狀態、未達門檻滑塊回彈 */
    default: { zeta: 1, response: 0.35 },
    /** 選價列升起、小元件 */
    snappy: { zeta: 1, response: 0.22 },
    /** 面板程式觸發的開關、堆疊後退 */
    sheet: { zeta: 1, response: 0.32 },
    /** 只在放手 |v| ≥ 500px/s 後 */
    sheetFling: { zeta: 0.82, response: 0.3 },
    /** 通知進出 */
    toast: { zeta: 0.9, response: 0.38 },
    /** 步進撞界限、不可關閉面板輕彈 */
    bump: { zeta: 0.55, response: 0.25 },
} as const satisfies Record<string, SpringToken>;

/** 手勢常數（只用於動畫與方向判斷；滑動確認的送出門檻不在此，永遠只看放手位置） */
export const GESTURE = {
    /** 方向鎖定門檻（px） */
    lockSlop: 10,
    /** 速度取最近 100ms 樣本 */
    velocityWindowMs: 100,
    /** 最後樣本早於放手 50ms 以上視為 0 */
    velocityStaleMs: 50,
    /** 甩動（px/s） */
    flingVelocity: 500,
    /** 直接關閉（px/s） */
    dismissVelocity: 1000,
    /** 面板投射減速率 */
    sheetDeceleration: 0.99,
    /** 通知投射減速率 */
    toastDeceleration: 0.998,
    /** 橡皮筋常數 */
    rubberband: 0.55,
    /** 拖曳後 click 攔截（ms） */
    clickSuppressMs: 350,
    /** 列長按（ms） */
    rowLongPressMs: 500,
    /** 圖表長按（ms） */
    chartLongPressMs: 450,
} as const;

/** 非手勢 CSS 轉場時間（ms） */
export const DUR = {
    press: 80,
    /** 按壓放開回彈 */
    release: 220,
    fade: 150,
    tone: 200,
    thumb: 240,
    /** 量條 scaleX（linear） */
    bar: 120,
    flash: 600,
    flashGap: 350,
} as const;

/** 緩動（cubic-bezier；不用 CSS 的 linear 緩動函式，iOS 15.4 不支援） */
export const EASE = {
    out: 'cubic-bezier(.2,.8,.2,1)',
    sheet: 'cubic-bezier(.32,.72,0,1)',
    linear: 'linear',
} as const;
