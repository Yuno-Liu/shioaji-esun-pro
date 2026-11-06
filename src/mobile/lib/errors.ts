// src/mobile/lib/errors.ts — 手機版共用錯誤：確定沒有送出（mutationNotStarted）
//
// 規格 R6：錯誤一律分兩類呈現——
// - 確定未成立：err.mutationNotStarted === true → UI 顯示「未送出：{原因}」，可修改後重試
// - 結果未知：其餘所有錯誤 → 「結果未知：請到委託頁按『更新』核對，勿重送」，不提供重送按鈕
// 這裡只負責建立第一類錯誤；判斷沿用 src/lib 的 mutationNotStarted 旗標，不另立新旗標。

export type NotStartedError = Error & { mutationNotStarted: true };

/** 建立「確定沒有送出」的錯誤（UI 依 mutationNotStarted 顯示「未送出」） */
export function notStarted(message: string): NotStartedError {
    return Object.assign(new Error(message), { mutationNotStarted: true as const });
}

/** 錯誤是否為「確定沒有送出」；其餘一律視為結果未知 */
export function isNotStarted(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { mutationNotStarted?: unknown }).mutationNotStarted === true;
}
