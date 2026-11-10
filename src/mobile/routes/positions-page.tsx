// src/mobile/routes/positions-page.tsx — 持倉（規格 §6.6）
//
// - 資料：useTradingState().positions（含帳戶；現價隨即時 tick 更新）；帳戶篩選「全部」或單一帳戶；
//   市場分段「全部／股票／期貨／選擇權」（期權依商品 security_type；商品資料未載入時不歸類）；
//   排序「券商順序／損益／報酬率／市值／代碼」；依帳戶分組並顯示小計（筆數、市值、損益）。
//   queries.positions 的對帳原因 banner；「⟳」＝refreshTradingState('positions')，6 秒冷卻。
// - 摘要卡（position-summary）：未實現損益合計（估）、股票總市值、期貨權益數與風險指標
//   （margin 屬於目前選取的期貨帳戶，只在範圍包含該帳戶時顯示）；金額遮蔽用 usePrivacyMoney＋maskMoney。
//   持倉尚未讀到（queries.positions.updatedAt 為 null 且沒有任何持倉列）時顯示「—」，不顯示 0。
//   今日額度列：帳戶篩選為單一證券帳戶時顯示該帳戶的額度，全部或期貨帳戶時沿用目前選取的證券帳戶。
// - 持倉列：均價、現價、損益（估）、報酬率；股票另有昨餘、成本（均價×股數）、市值；損益條（up／down 色＋文字）。
//   玉山股票列可展開庫存明細（position-esun-details）。
// - 平倉：先開說明面板寫明行為，使用者按「繼續」才呼叫 src/lib；lib 內部會再出現一次確認面板
//   （根層 order-confirm-sheet，手機已強制開啟 confirmManualOrders），確認只出現一次。
//   · 股票：stockExitFor() 回傳原因時不送出；否則 placeStockExitByShares()（整張市價 IOC、零股以漲跌停價盤中零股限價）。
//   · 期貨／選擇權：placeQuickOrder(…, null, 口數, { ocType: 'Cover', source: 'manual' })（市價 IOC）。
//   · beforeSend 內同步呼叫 assertResumeReady()；useTradingLive() 為 false 或 ResumeGate 不允許時停用。
//   · ResumeGate 為 stale-data：頁面 banner 與平倉說明面板都提供 ResumeGateNote（勾選「我了解委託／持倉資料可能過期」
//     ＝acknowledgeStaleData()、「重試同步」＝retryResume()）；勾選後才可平倉。
//   · 結果依 §7.2：已取消、未送出（顯示原因，可重試）、結果未知（不自動重送、不提供重送鍵）。股票不提供反手。
// - 加碼：openTicket({ code, action: 同方向, source: 'position', lot, cond, daytradeShort })；
//   現股多單＝Buy＋Cash；融資多單＝Buy＋MarginTrading；融券空單＝Sell＋ShortSelling（信用一律整張）；
//   現股空單（當沖先賣）＝Sell＋Cash＋daytradeShort，只在 contract.day_trade==='Yes' 時可用，否則停用並說明。
//   下單面板以「目前選取的帳戶」下單，持倉帳戶不同時先確認切換帳戶；面板內仍需預覽並滑動確認才會送出。
// - 看圖：navigate({ name: 'trade', code })。
// - 版面（設計規格 §7.7，流程與 testid 不變）：分組型頁面；PageHeader「持倉」＋⟳；Segmented 市場、PopUpButton 帳戶與排序；
//   對帳／連線說明用 InlineNote；依帳戶分組（footnote 組標頭＋GroupedSection）；每筆：代碼名稱、條件小膠囊、
//   「多／空 N 張」實心膠囊、損益 numMd；均價、現價、報酬率／昨餘、成本、市值 numSm；損益條 scaleX（中線為 0）；
//   動作列［庫存明細］…［平倉］（中性外框，避免與新單買賣鍵混淆）［加碼］［看圖 ›］。
//   平倉說明與切換帳戶面板改 GroupedSection／InlineNote＋footer 版型（行為不變：繼續後才呼叫 lib，lib 再開確認面板）。
// - 淨損益與損益兩平價（lib/position-pnl，純函式）：股票列以「淨損益（含手續費 X 折、證交稅）」為主、券商原始損益小字並列；
//   「損益兩平」列（文字標示現價高於／低於兩平價、手續費折數、當沖稅率、估算）點開 position-pnl-sheet 計算明細（只讀）。
//   今日買進股數：玉山庫存明細（分批成交日）→ 今日成交回報（委託查詢成功時）；都沒有則一般稅率並標「未判斷當沖」。
//   期權維持券商損益並標「未扣費稅」。摘要、分組小計、損益條、損益／報酬率排序都用同一個值；無法計算的列不猜，標「合計待確認」。
//   手續費折數與退佣方式依持倉帳戶的券商（lib/broker-cost-settings：永豐、玉山分開，手機版限定；融資年利率、借券費率共用）。
//   月退且有折扣時淨損益已扣預估退佣：詳細列券商損益後面加「退佣 ≈ N」（StockPnl.rebate＝開倉＋平倉退佣），
//   摘要卡加「已含預估退佣 ≈ N」（netTotals.rebate／rebateRows），計算明細面板另列交割收取額與退佣。只讀顯示。
// - 「詳細｜精簡」檢視（篩選列行尾 Segmented toggle；lib/positions-view 存 localStorage，預設詳細）：
//   精簡＝每個部位一列（名稱／代碼・條件・多空數量｜淨損益／報酬率・已過或未達兩平；第二列現價＋兩平價，期權為均價），
//   帳戶分組、摘要、篩選、排序照常、摘要卡較緊湊。
//   點列（aria-expanded）就地展開既有詳細卡片（不重複第一行），再點收合；平倉、加碼、看圖入口與流程不變，不新增送單入口。
//   未展開的列不掛詳細卡片子樹；切換時以切換鍵為錨點保留捲動位置；減少動態時不做展開動畫。
// - 重繪範圍（稽核 P2）：詳細列與精簡列以 memo 包起來，只比該列用到的值（持倉物件參考、淨損益數值、遮蔽、平倉停用…）；
//   交易狀態重估市價時只有跳價的那列重繪（本頁最大損益改變時全部重繪以更新損益條比例）。列的按鈕經 rowActions 轉給最新的處理函式。
// - 多選市價出清（使用者要求；§7.7、§10 S10）：標頭「選取」（aria-pressed）進入選取模式。兩種檢視的每列都有勾選鍵
//   （button role=checkbox、aria-checked、名稱「選取 代碼 名稱 條件 多空 數量」、≥ TOUCH_MIN）；每個帳戶組與頁面各有三態「全選」。
//   可列入＝closePlanFor 有平倉方式且不是選擇權（batchSelectReason）；不可列入的列勾選鍵停用並顯示原因。選取模式隱藏平倉、加碼
//   （詳細列整個動作列），點列切換選取（精簡列不展開）。底部配件槽（ShellSlot bottom）：已選 N 筆、全選、取消、「市價出清 N 筆」。
//   離開選取模式或改篩選清除選取；已選的持倉消失、數量改變或變成不可列入時移出選取並說明。
//   「市價出清 N 筆」只開預覽面板（components/batch-exit-sheet，延遲載入）；滑動一次後由 lib/batch-exit 的 runBatchExit 依序送出：
//   每筆仍經 executeClose（beforeSend: closeBeforeSend），lib 的確認請求由 lib/batch-exit-auth 比對預期內容後自動核准（不顯示確認面板）。
//   與單筆平倉共用 closingRef（任一進行中另一個不能開始）；下單面板或確認進行中（useAccountSwitchLocked）也不能開始。

import { Check, ChevronRight, RotateCw, Wallet } from 'lucide-react';
import { memo, Suspense, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { useTradingLive } from '../../hooks/use-stream';
import { getAccountState, selectAccount, useAccounts } from '../../lib/account-store';
import { canTrade } from '../../lib/account-tradable';
import { ensureContract, getCachedContract, useContract } from '../../lib/contracts-cache';
import { isEsunAccount } from '../../lib/esun';
import { findEsunInventoryDetail, getEsunInventoryDetailsSnapshot, subscribeEsunInventoryDetails } from '../../lib/esun/account-details';
import { accountMatches } from '../../lib/flash-account';
import { SHARES_PER_LOT } from '../../lib/odd-lot';
import { getPendingOrderConfirm } from '../../lib/order-confirm';
import { getRiskSettings } from '../../lib/risk';
import { reconcileAfterUnknownOutcome } from '../../lib/order-outcome';
import { maskMoney, secretMoney, usePrivacyMode, usePrivacyMoney } from '../../lib/privacy';
import { useServerInfo, yesterdayQuantityNotice } from '../../lib/server-info-store';
import { contractMarket, isWarrantContract } from '../../lib/contract-market';
import { esunStockLegProblem } from '../../lib/order-route';
import { creditExitLabel, stockExitFor, type CreditExitCond } from '../../lib/stock-exit-cond';
import { notify, placeQuickOrder, placeStockExitByShares } from '../../lib/trade';
import { discountText, type TradingCostSettings } from '../../lib/trading-cost-settings';
import { RECONCILE_REASON_LABELS, refreshTradingState, useTradingState, type TradingQueryStatus } from '../../lib/trading-state';
import type { ContractInfo } from '../../lib/types/contract';
import type { Action } from '../../lib/types/order';
import type { Account, AccountedPosition, Position, StockPosition } from '../../lib/types/portfolio';
import { fmtPct, fmtPrice, fmtSigned } from '../../lib/utils/format';
import { brokerOfAccount, useBrokerCostSettings, type CostBroker } from '../lib/broker-cost-settings';
import { fmtInt, fmtStockLots, formatToTick } from '../lib/num-format';
import { isStockPosition, positionCondText, positionQtyText, reconcileText, sideText } from '../lib/position-text';
import { mobileAccountLabel, useAccountSwitchLocked } from '../components/account-switch-sheet';
import type { BatchPhase, BatchViewGroup } from '../components/batch-exit-sheet';
import { BottomSheet, SheetFooter } from '../components/bottom-sheet';
import { PositionEsunDetails } from '../components/position-esun-details';
import { breakEvenRelationText, PNL_TEXT, pnlTags, PositionPnlSheet } from '../components/position-pnl-sheet';
import {
    accountKeyOf,
    filterByMarket,
    groupPositionsByAccount,
    MARKET_FILTERS,
    pnlBarWidth,
    positionCost,
    positionMarketValue,
    positionReturnPct,
    SORT_MODES,
    sortPositions,
    summarizePositions,
    type PositionMarketFilter,
    type PositionSortMode,
} from '../components/position-metrics';
import { PositionSummaryCard } from '../components/position-summary';
import { ResumeGateNote } from '../components/resume-gate-note';
import { RouteBadge } from '../components/route-badge';
import { ModuleErrorBoundary, retryableLazy, SheetLoadError } from '../components/route-error-boundary';
import { classifyTicketOutcome, OUTCOME_UNKNOWN_TITLE } from '../hooks/use-mobile-ticket';
import { useResumeGate } from '../hooks/use-resume-gate';
import { batchSummaryText, runBatchExit, type BatchExitItem, type BatchItemState } from '../lib/batch-exit';
import { abortBatchExit, BATCH_STOPPED, isBatchExitActive, subscribeBatchExit } from '../lib/batch-exit-auth';
import { navigate } from '../lib/hash-router';
import { breakEvenRelation, computeStockPnl, stockPnlInputOf, todayStockFills, type StockPnl, type TodayFills } from '../lib/position-pnl';
import { getMobileUi, openTicket, type TicketCond, type TicketLot } from '../lib/mobile-store';
import { readPositionsView, writePositionsView, type PositionsView } from '../lib/positions-view';
import { resumeAllowsNewOrders } from '../lib/resume-gate';
import { assertResumeReady, getResumeGate, type ResumeGateSnapshot } from '../lib/resume-gate-runtime';
import { assertNoEnvSwitch, beginOrderDispatch } from '../lib/trading-activity';
import * as controls from '../styles/controls.css';
import { srOnly } from '../styles/primitives.css';
import * as styles from '../styles/positions.css';
import { scaleXOf } from '../ui/bars';
import { EmptyState } from '../ui/empty-state';
import { GroupedSection } from '../ui/grouped';
import { IconButton } from '../ui/icon-button';
import { InlineNote } from '../ui/inline-note';
import { PageHeader } from '../ui/page-header';
import { PopUpButton } from '../ui/pop-up-button';
import { Segmented } from '../ui/segmented';
import { ShellSlot } from '../ui/shell-slots';
import { Skeleton } from '../ui/skeleton';

/** 「⟳」更新持倉的冷卻時間 */
export const REFRESH_COOLDOWN_MS = 6_000;

export const POSITIONS_TEXT = {
    loading: '持倉載入中…',
    empty: '目前沒有持倉',
    readFailed: '持倉尚未讀取成功，請按「⟳」',
    notLive: '行情／交易連線未就緒，暫停平倉',
    resyncing: '回到前景後正在重新同步行情與委託，暫停平倉',
    staleData: '委託／持倉資料可能過期：請按「重試同步」，或勾選「我了解委託／持倉資料可能過期」後再平倉',
    resumeFailed: '連線未恢復，暫停平倉；請重新整理頁面',
    noAccount: '持倉帳戶歸屬不明，未送出委託',
    noAccountAddOn: '持倉帳戶歸屬不明，無法加碼',
    addOnBadDirection: '持倉方向不明，無法加碼',
    addOnDayTradeUnknown: '商品資料尚未載入，無法確認可否當沖先賣，暫時不能加碼',
    addOnNoDayTrade: '此股票目前不可當沖先賣；現股空單只能以當沖先賣加碼，加碼停用',
    addOnDayTradeNote: '以現股「當沖先賣」整張加碼，須於當日買回沖銷',
    addOnOtherCond: '借券或其他信用條件的持倉不支援加碼，請至券商處理',
    addOnCondMismatch: '持倉方向與信用條件不符，無法判斷加碼方式',
    filteredEmpty: '此篩選條件下沒有持倉',
    accountNotTradable: '持倉帳戶目前不可交易（未簽署）',
    marketMismatch: '持倉單位與帳戶市場不符，未送出委託',
    badQuantity: '持倉數量或方向不明，未送出委託',
    noContract: '商品資料（含漲跌停價）尚未載入，暫時無法平倉',
    contractMismatch: '商品與持倉帳戶市場不符，未送出委託',
    warrantOddLot: '權證沒有零股，未滿一張的部分無法平倉，未送出委託',
    noLimits: '漲跌停價未知，暫時無法平倉',
    gone: '這筆持倉已不在清單中（可能已平倉或已更新）',
    switchLocked: '下單面板開啟或確認進行中，暫時不能切換帳戶。',
    switchFailed: '帳戶切換未成功，請到「帳戶」頁確認後再試',
    closeSent: '平倉委託已送出',
    cancelled: '已取消',
    pnlNoContract: '商品資料尚未載入，淨損益待確認',
    pnlUnsupported: '此信用條件不估算費稅，淨損益待確認',
    pnlNoPrice: '缺現價，淨損益待確認',
    batchOption: '選擇權不列入批次市價出清，請逐筆平倉',
    batchBusy: '其他平倉、下單面板或確認進行中，暫時不能出清',
    batchEnvUnknown: '有帳戶的環境未確認（模擬／正式），未送出',
    batchRunning: '多選市價出清進行中，請等完成後再平倉',
    batchHidden: '畫面已切到背景，已停止',
    batchResumed: '畫面重新同步過，已停止（請重新確認後再出清）',
    batchNoConfirm: '下單確認設定未開啟，已停止',
    batchFailed: '出清中斷（程式錯誤），未處理的持倉未送出；請到委託頁按「更新」核對',
} as const;

// ---- 純函式（測試用匯出）----

// 條件、方向、數量與對帳文字搬到 lib/position-text.ts（與自選頁「持倉」分段共用）；這裡轉出同名函式
export { isStockPosition, positionCondText, positionQtyText, reconcileText, sideText } from '../lib/position-text';

/** 列的識別（不含數量：數量變動時說明面板跟著顯示最新值） */
export function positionKey(p: AccountedPosition): string {
    const cond = isStockPosition(p) ? p.cond ?? '' : '';
    return `${accountKeyOf(p.account)}|${p.code}|${p.direction}|${cond}|${p.id}`;
}

export function pnlTone(v: number): 'up' | 'down' | 'flat' {
    return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

/** ResumeGate／連線不允許平倉的原因；允許時回傳 null */
export function closeGateProblem(live: boolean, gate: Pick<ResumeGateSnapshot, 'state' | 'staleAcknowledged'>): string | null {
    if (!live) return POSITIONS_TEXT.notLive;
    if (resumeAllowsNewOrders(gate.state, gate.staleAcknowledged)) return null;
    if (gate.state === 'resyncing') return POSITIONS_TEXT.resyncing;
    if (gate.state === 'stale-data') return POSITIONS_TEXT.staleData;
    return POSITIONS_TEXT.resumeFailed;
}

/**
 * 多選市價出清每筆送出前的閘門（滑動一次核准整批，所以比單筆更嚴格）：
 * - 手動下單確認設定仍開啟（否則 lib 不發確認、批次授權比對不到，直接停止；start.ts 會把它釘回開啟，這是縱深防護）；
 * - 畫面在前景（在背景時不繼續送出，使用者看不到進度）；
 * - 仍是滑動當下的那一次前景（resumeSeq 沒變：回前景重新同步過就停止，不沿用背景前的那一次滑動）；
 * - 其餘同單筆平倉（連線、ResumeGate 允許新單）。
 */
export function batchGateProblem(live: boolean, startSeq: number): string | null {
    if (getRiskSettings().confirmManualOrders !== true) return POSITIONS_TEXT.batchNoConfirm;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return POSITIONS_TEXT.batchHidden;
    const gate = getResumeGate();
    if (gate.resumeSeq !== startSeq) return POSITIONS_TEXT.batchResumed;
    return closeGateProblem(live, gate);
}

export type ClosePlan =
    | { kind: 'stock'; account: Account; contract: ContractInfo; action: Action; shares: number; orderCond?: CreditExitCond }
    | { kind: 'futures'; account: Account; contract: ContractInfo; action: Action; lots: number };

/**
 * 平倉方式（只作送出前的檢查與說明；真正的規則仍由 src/lib 在送出時再驗一次）。
 * 不支援回原因字串（不得送出）。持倉帳戶不得以目前選取帳戶補猜。
 */
export function closePlanFor(p: AccountedPosition, contract: ContractInfo | undefined): ClosePlan | string {
    const account = p.account;
    if (!account || !account.broker_id || !account.account_id || !['S', 'F'].includes(account.account_type)) return POSITIONS_TEXT.noAccount;
    if (!canTrade(account)) return POSITIONS_TEXT.accountNotTradable;
    const stock = isStockPosition(p);
    if ((stock ? 'S' : 'F') !== account.account_type) return POSITIONS_TEXT.marketMismatch;
    if (!Number.isSafeInteger(p.quantity) || p.quantity <= 0 || (p.direction !== 'Buy' && p.direction !== 'Sell')) return POSITIONS_TEXT.badQuantity;
    if (stock) {
        const exit = stockExitFor(p.direction, p.cond, p.quantity);
        if (typeof exit === 'string') return exit;
        if (!contract) return POSITIONS_TEXT.noContract;
        // 權證與股票同一條下單路徑（lib contractMarket：STK、WRT 都是證券市場）；權證沒有零股，lib 送出前也會再擋
        if (contractMarket(contract.security_type) !== 'S') return POSITIONS_TEXT.contractMismatch;
        const odd = p.quantity % 1000;
        // 權證以 lib isWarrantContract 判斷（SDK 1.7 以前可能標成 STK，看代號；同 lib placeStockExitByShares）
        if (isWarrantContract(contract) && odd !== 0) return POSITIONS_TEXT.warrantOddLot;
        // 整張以市價 IOC 送出、不用漲跌停價；只有零股腳以漲跌停價限價（同 lib placeStockExitByShares）。
        // 權證的合約資料沒有漲跌停價（lib resolveContract 回 0），整張平倉仍可送出。
        if (odd !== 0 && (!(contract.limit_up > 0) || !(contract.limit_down > 0))) return POSITIONS_TEXT.noLimits;
        // 玉山帳戶：照 lib 實際送出的兩腳先用玉山規則檢查（例如權證、超過 499 張），在說明面板就說明原因，不等確認後才被拒
        const esunProblem = esunExitLegsProblem(account, contract, exit, p.quantity);
        if (esunProblem) return esunProblem;
        return { kind: 'stock', account, contract, action: exit.exit, shares: p.quantity, ...(exit.orderCond ? { orderCond: exit.orderCond } : {}) };
    }
    if (!contract) return POSITIONS_TEXT.noContract;
    if (contract.security_type !== 'FUT' && contract.security_type !== 'OPT') return POSITIONS_TEXT.contractMismatch;
    return { kind: 'futures', account, contract, action: p.direction === 'Buy' ? 'Sell' : 'Buy', lots: p.quantity };
}

/**
 * 平倉兩腳（同 lib placeStockExitByShares：整張市價 IOC＋信用條件、零股以漲跌停價限價 ROD 現股）逐腳以玉山規則檢查。
 * 永豐帳戶回 null（交給 lib 與券商）。
 */
export function esunExitLegsProblem(
    account: Account,
    contract: ContractInfo,
    exit: { exit: Action; orderCond?: CreditExitCond },
    shares: number,
): string | null {
    type Leg = Parameters<typeof esunStockLegProblem>[2];
    const lots = Math.floor(shares / 1000);
    const odd = shares % 1000;
    const legs: Leg[] = [];
    if (lots > 0) legs.push({ action: exit.exit, price: 0, quantity: lots, price_type: 'MKT', order_type: 'IOC', order_lot: 'Common', order_cond: exit.orderCond ?? 'Cash' });
    if (odd > 0) legs.push({ action: exit.exit, price: exit.exit === 'Sell' ? contract.limit_down : contract.limit_up, quantity: odd, price_type: 'LMT', order_type: 'ROD', order_lot: 'IntradayOdd', order_cond: 'Cash' });
    for (const leg of legs) {
        const problem = esunStockLegProblem(account, contract, leg);
        if (problem) return problem;
    }
    return null;
}

/**
 * 送出前（lib 的 beforeSend）同步檢查：玉山環境切換中不送玉山帳戶（帳戶不明時視同玉山）、ResumeGate；
 * 不允許時丟出 mutationNotStarted 錯誤
 */
export function closeBeforeSend(account?: Pick<Account, 'broker_id'> | null): void {
    assertNoEnvSwitch(account);
    assertResumeReady({ allowStale: getResumeGate().staleAcknowledged });
}

/** 依平倉方式呼叫 src/lib（lib 內部會開確認面板，確認只出現一次） */
export async function executeClose(plan: ClosePlan): Promise<void> {
    // 玉山環境切換中不送玉山帳戶（永豐照常）；平倉流程（含 lib 確認面板）期間計入「委託送出中」，環境切換因此擋下
    assertNoEnvSwitch(plan.account);
    const release = beginOrderDispatch();
    const beforeSend = () => closeBeforeSend(plan.account);
    try {
        if (plan.kind === 'stock') {
            await placeStockExitByShares(plan.contract, plan.action, plan.shares, plan.account, { orderCond: plan.orderCond, beforeSend });
            return;
        }
        await placeQuickOrder(plan.contract, plan.action, null, plan.lots, {
            account: plan.account,
            ocType: 'Cover',
            source: 'manual',
            beforeSend,
        });
    } finally {
        release();
    }
}

// ---- 多選市價出清（§7.7、§10 S10）----

/**
 * 不能列入多選市價出清的原因；可以時回 null。範圍＝股票（現股、融資、融券、現股當沖）＋期貨；選擇權不列入。
 * 其餘條件與單筆平倉相同（closePlanFor）；商品資料未載入時無法區分期貨與選擇權，也不能列入。
 */
export function batchSelectReason(p: AccountedPosition, contract: ContractInfo | undefined): string | null {
    if (!isStockPosition(p) && contract?.security_type === 'OPT') return POSITIONS_TEXT.batchOption;
    const plan = closePlanFor(p, contract);
    return typeof plan === 'string' ? plan : null;
}

/**
 * 實際送出的各腳（與 lib 相同）：股票整張以市價 IOC（信用部位帶信用條件）、零股以跌停（賣）／漲停（買）價盤中零股限價；
 * 期貨以市價 IOC、倉別平倉。數量一律明碼（遮蔽金額時也一樣）：預覽是送出前唯一看得到數量的畫面，
 * 與單筆確認面板相同規則（確認面板的數量不遮蔽）。
 */
export function batchLegs(plan: ClosePlan): string[] {
    const n = (v: number) => fmtInt(v);
    if (plan.kind === 'futures') return [`${n(plan.lots)} 口 市價 IOC（平倉）`];
    const lots = Math.floor(plan.shares / SHARES_PER_LOT);
    const odd = plan.shares % SHARES_PER_LOT;
    const legs: string[] = [];
    if (lots > 0) legs.push(`整張 ${n(lots)} 張 市價 IOC${plan.orderCond ? `（${creditExitLabel(plan.orderCond)}）` : ''}`);
    if (odd > 0) {
        const sell = plan.action === 'Sell';
        const price = sell ? plan.contract.limit_down : plan.contract.limit_up;
        legs.push(`零股 ${n(odd)} 股以${sell ? '跌停' : '漲停'}價 ${formatToTick(plan.contract, price)} 盤中零股限價`);
    }
    return legs;
}

/** 加碼時交給 openTicket 的內容（一次性帶入；面板仍依規則驗證） */
export interface AddOnRequest {
    code: string;
    action: Action;
    source: 'position';
    lot?: TicketLot;
    cond?: TicketCond;
    daytradeShort?: boolean;
}

export interface AddOnPlan {
    request: AddOnRequest;
    /** 加碼時要讓使用者知道的限制（例如信用只能整張）；沒有為 null */
    note: string | null;
}

/** 信用部位加碼的限制說明；持倉含零股時另外說明零股不能以信用條件交易 */
export function creditAddOnNote(cond: 'MarginTrading' | 'ShortSelling', shares: number): string {
    const name = cond === 'ShortSelling' ? '融券' : '融資';
    const whole = Number.isSafeInteger(shares) && shares > 0 && shares % SHARES_PER_LOT === 0;
    return `${name}加碼只能整張（1,000 股）下單；零股不能以信用條件交易`
        + (whole ? '' : '。這筆持倉含零股，零股部分也不能以信用條件了結，請至券商處理');
}

/**
 * 加碼方式（與帳戶切換無關的部分）；不可加碼回原因字串。
 * - 期權：同方向（倉別由面板決定）。
 * - 現股多單＝Buy＋Cash；融資多單＝Buy＋MarginTrading；融券空單＝Sell＋ShortSelling（信用一律整張）。
 * - 現股空單＝當沖先賣（Sell＋Cash＋daytradeShort），只在 contract.day_trade==='Yes' 時可用；商品資料未載入時不猜。
 */
export function addOnPlanFor(p: AccountedPosition, contract: Pick<ContractInfo, 'day_trade'> | undefined): AddOnPlan | string {
    if (!p.account) return POSITIONS_TEXT.noAccountAddOn;
    if (p.direction !== 'Buy' && p.direction !== 'Sell') return POSITIONS_TEXT.addOnBadDirection;
    const base: AddOnRequest = { code: p.code, action: p.direction, source: 'position' };
    if (!isStockPosition(p)) return { request: base, note: null };
    const c = p.cond || 'Cash';
    if (c === 'Cash') {
        if (p.direction === 'Buy') return { request: { ...base, lot: 'Common', cond: 'Cash' }, note: null };
        if (!contract) return POSITIONS_TEXT.addOnDayTradeUnknown;
        if (contract.day_trade !== 'Yes') return POSITIONS_TEXT.addOnNoDayTrade;
        return { request: { ...base, lot: 'Common', cond: 'Cash', daytradeShort: true }, note: POSITIONS_TEXT.addOnDayTradeNote };
    }
    if (c !== 'MarginTrading' && c !== 'ShortSelling') return POSITIONS_TEXT.addOnOtherCond;
    if ((c === 'ShortSelling') !== (p.direction === 'Sell')) return POSITIONS_TEXT.addOnCondMismatch;
    return { request: { ...base, lot: 'Common', cond: c }, note: creditAddOnNote(c, p.quantity) };
}

/** 加碼不可用的原因（與帳戶切換無關的部分）；可用時回傳 null */
export function addOnBlockReason(p: AccountedPosition, contract?: Pick<ContractInfo, 'day_trade'>): string | null {
    const plan = addOnPlanFor(p, contract);
    return typeof plan === 'string' ? plan : null;
}

// ---- 淨損益（含手續費折數、證交稅）----

export interface RowPnl {
    /** 主要顯示的損益：股票＝淨損益、期權＝券商損益；無法計算為 null（不猜） */
    value: number | null;
    /** 股票的計算結果（兩平價與明細）；期權或無法計算為 null */
    stock: StockPnl | null;
    /** 計算時用的商品資料（兩平價依跳動價位格式化） */
    contract: ContractInfo | null;
    /** 期權：券商損益、未扣費稅 */
    deriv: boolean;
    /** 股票淨損益無法計算的原因 */
    reason: string | null;
}

export interface RowPnlContext {
    /** 各券商的交易成本設定（依持倉帳戶選用；useBrokerCostSettings） */
    costs: Record<CostBroker, TradingCostSettings>;
    now: number;
    /** 今日成交（委託查詢尚未成功時為 null） */
    fills: ReadonlyMap<string, TodayFills> | null;
}

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 玉山股票持倉對應的庫存明細（快照；對不上回 null） */
function esunDetailOf(p: AccountedPosition) {
    if (!isStockPosition(p) || !isEsunAccount(p.account)) return null;
    return findEsunInventoryDetail(getEsunInventoryDetailsSnapshot(p.account)?.details, p);
}

/** 一筆持倉的淨損益；股票需要商品資料（稅別、跳動價位） */
export function rowPnlOf(p: AccountedPosition, contract: ContractInfo | undefined, ctx: RowPnlContext): RowPnl {
    if (!isStockPosition(p)) return { value: finiteNum(p.pnl) ? p.pnl : null, stock: null, contract: contract ?? null, deriv: true, reason: null };
    if (!contract) return { value: null, stock: null, contract: null, deriv: false, reason: POSITIONS_TEXT.pnlNoContract };
    const input = stockPnlInputOf(p, contract, {
        settings: ctx.costs[brokerOfAccount(p.account)],
        now: ctx.now,
        fills: ctx.fills,
        esun: esunDetailOf(p),
    });
    const stock = input ? computeStockPnl(input) : null;
    if (!stock) return { value: null, stock: null, contract, deriv: false, reason: POSITIONS_TEXT.pnlUnsupported };
    return { value: stock.net, stock, contract, deriv: false, reason: stock.net === null ? POSITIONS_TEXT.pnlNoPrice : null };
}

export interface NetTotals {
    /** 可計算列的合計 */
    sum: number;
    /** 可計算的列數 */
    counted: number;
    /** 無法計算（合計待確認）的列數 */
    pending: number;
    /** 合計含期權的券商損益（未扣費稅） */
    deriv: boolean;
    /** 已含在 sum 內的預估退佣合計（股票列 stock.rebate > 0 的加總） */
    rebate: number;
    /** 有預估退佣的列數 */
    rebateRows: number;
}

export function netTotals(rows: readonly AccountedPosition[], pnlOf: (p: AccountedPosition) => RowPnl): NetTotals {
    let sum = 0;
    let counted = 0;
    let pending = 0;
    let deriv = false;
    let rebate = 0;
    let rebateRows = 0;
    for (const p of rows) {
        const r = pnlOf(p);
        if (r.value === null) { pending += 1; continue; }
        sum += r.value;
        counted += 1;
        if (r.deriv) deriv = true;
        const rb = r.stock?.rebate;
        if (typeof rb === 'number' && rb > 0) { rebate += rb; rebateRows += 1; }
    }
    return { sum, counted, pending, deriv, rebate, rebateRows };
}

/** 列的報酬率（%）：股票＝淨損益 ÷（均價 × 股數）；期權沿用 positionReturnPct */
export function rowReturnPct(p: AccountedPosition, r: RowPnl): number | null {
    if (!isStockPosition(p)) return positionReturnPct(p);
    const cost = positionCost(p);
    return r.value === null || cost === null || cost <= 0 ? null : (r.value / cost) * 100;
}

/** 依值排序（大到小、null 排最後、穩定） */
function sortByValue<T>(rows: readonly T[], valueOf: (p: T) => number | null): T[] {
    return rows
        .map((p, i) => ({ p, i, v: valueOf(p) }))
        .sort((a, b) => (a.v === null ? (b.v === null ? a.i - b.i : 1) : b.v === null ? -1 : b.v - a.v || a.i - b.i))
        .map(x => x.p);
}

/** 帳戶標籤（券商＋市場＋遮蔽帳號）；帳戶不明時回「帳戶不明」 */
function groupLabel(a: Account | undefined, priv: boolean): string {
    if (!a) return '帳戶不明';
    return `${isEsunAccount(a) ? '玉山' : '永豐'}${a.account_type === 'F' ? '期貨' : '證券'} ${mobileAccountLabel(a, priv)}`;
}

function closeActionText(plan: ClosePlan): string {
    const side = plan.action === 'Buy' ? '買進' : '賣出';
    if (plan.kind === 'stock') return `${creditExitLabel(plan.orderCond)}${side}`;
    return `平倉${side}`;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err ?? ''));

// ---- 元件 ----

/** 昨餘文字：期權回 null；永豐模擬帳務的昨餘單位待確認時（玉山不套用）回「待確認」 */
export function yesterdayText(p: AccountedPosition, notice: string | undefined, privMoney: boolean): string | null {
    if (!isStockPosition(p)) return null;
    if (notice && !isEsunAccount(p.account)) return '待確認';
    return Number.isFinite(p.yd_quantity) ? maskMoney(fmtStockLots(p.yd_quantity), privMoney) : '—';
}

interface RowProps {
    p: AccountedPosition;
    priv: boolean;
    privMoney: boolean;
    closeDisabled: boolean;
    /** 帳戶不可交易時的原因（與商品無關的部分） */
    accountReason: string | null;
    /** 本頁顯示範圍內的最大 |損益|，供損益條比例 */
    maxAbsPnl: number;
    ydNotice: string | undefined;
    expanded: boolean;
    /** 淨損益（rowPnlOf） */
    rp: RowPnl;
    onClose: () => void;
    onAddOn: (contract: ContractInfo | undefined) => void;
    onToggleDetail: () => void;
    onOpenPnl: () => void;
    /** 精簡列展開時：嵌在精簡列的 li 內（div＋id，供 aria-controls），不重複第一行（代碼、條件、多空數量、損益已在精簡列） */
    embeddedId?: string;
    /** 選取模式（多選市價出清）；一般模式為 null／undefined。嵌入的詳細卡片不使用 */
    select?: RowSelect | null;
    onToggleSelect?: () => void;
}

/** 選取模式的列狀態：checked＝已選；reason＝不能列入批次的原因（勾選鍵停用並顯示文字） */
export interface RowSelect {
    checked: boolean;
    reason: string | null;
}

export function rowSelectEqual(a: RowSelect | null | undefined, b: RowSelect | null | undefined): boolean {
    if (!a || !b) return !a === !b;
    return a.checked === b.checked && a.reason === b.reason;
}

/** 勾選鍵的無障礙名稱，例如「選取 2330 台積電 現股 多 3張」（數量依遮蔽金額處理） */
export function selectLabel(p: AccountedPosition, contract: ContractInfo | undefined, privMoney: boolean): string {
    return `選取 ${p.code}${contract?.name ? ` ${contract.name}` : ''} ${positionCondText(p, contract)} ${sideText(p.direction)} ${maskMoney(positionQtyText(p), privMoney)}`;
}

/** 勾選鍵：button role=checkbox（aria-checked 可為 mixed），觸控區 TOUCH_MIN；有 children 時同時顯示文字 */
function SelectCheck({ checked, disabled, label, onToggle, className, testId, children }: {
    checked: boolean | 'mixed';
    disabled?: boolean;
    label: string;
    onToggle: () => void;
    className?: string;
    testId: string;
    children?: ReactNode;
}) {
    return (
        <button
            type='button'
            role='checkbox'
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            className={className ?? styles.selectCheck}
            onClick={onToggle}
            data-testid={testId}
        >
            <span className={checked ? `${styles.selectBox} ${styles.selectBoxOn}` : styles.selectBox} aria-hidden='true'>
                {/* 部分勾選以 CSS 橫線表示（不另載 lucide Minus：它與委託頁共用會多一個 chunk，首屏預載清單變長） */}
                {checked === 'mixed' ? <span className={styles.selectDash} /> : checked && <Check className={styles.selectIcon} focusable='false' />}
            </span>
            {children}
        </button>
    );
}

/** 點列（非按鈕處）切換選取（觸控方便；鍵盤與報讀以勾選鍵操作） */
function rowTapToggle(onToggle: (() => void) | undefined) {
    return (e: MouseEvent) => {
        const target = e.target as { closest?: (selector: string) => unknown } | null;
        if (!target?.closest?.('button, a')) onToggle?.();
    };
}

function Cell({ label, children, className, testId }: { label: string; children: ReactNode; className?: string; testId?: string }) {
    return (
        <div className={styles.rowCell}>
            <dt className={styles.cellLabel}>{label}</dt>
            <dd className={`${styles.cellValue}${className ? ` ${className}` : ''}`} data-testid={testId}>{children}</dd>
        </div>
    );
}

/** 螢幕報讀用的損益名稱 */
function pnlSrLabel(rp: RowPnl): string {
    if (rp.deriv) return '損益（券商，未扣費稅）';
    const d = rp.stock?.feeDiscount;
    return d !== undefined && d < 1 ? `淨損益（含手續費 ${discountText(d)} 折、證交稅）` : '淨損益（含手續費、證交稅）';
}

function PositionRow({ p, priv, privMoney, closeDisabled, accountReason, maxAbsPnl, ydNotice, expanded, rp, onClose, onAddOn, onToggleDetail, onOpenPnl, embeddedId, select, onToggleSelect }: RowProps) {
    const contract = useContract(p.code);
    const long = p.direction === 'Buy';
    const stock = isStockPosition(p);
    const esun = stock && isEsunAccount(p.account);
    const plan = addOnPlanFor(p, contract);
    const addOnReason = typeof plan === 'string' ? plan : accountReason;
    const addOnNote = typeof plan === 'string' ? null : plan.note;
    const ret = rowReturnPct(p, rp);
    const cost = positionCost(p);
    const value = positionMarketValue(p);
    const yd = yesterdayText(p, ydNotice, privMoney);
    const shown = rp.value;
    const bar = privMoney || shown === null ? 0 : pnlBarWidth(shown, maxAbsPnl);
    const sp = rp.stock;
    const breakEven = sp && sp.breakEven !== null && rp.contract ? formatToTick(rp.contract, sp.breakEven) : '—';
    const relation = sp ? breakEvenRelationText(sp, p.last_price) : null;
    const money = (v: number | null) => maskMoney(v === null ? '—' : fmtInt(Math.round(v)), privMoney);
    const embedded = embeddedId !== undefined;
    // 選取模式：第一行最前加勾選鍵，隱藏動作列（平倉、加碼、看圖、庫存明細）與加碼說明，點列切換選取
    const sel = embedded ? null : select ?? null;
    const body = (
        <>
            {!embedded && <div className={styles.rowHead}>
                {sel && (
                    <SelectCheck
                        checked={sel.checked}
                        disabled={sel.reason !== null}
                        label={selectLabel(p, contract, privMoney)}
                        onToggle={() => onToggleSelect?.()}
                        className={`${styles.selectCheck} ${styles.rowSelectCheck}`}
                        testId='position-select'
                    />
                )}
                <span className={styles.rowCode}>{p.code}</span>
                {contract?.name && <span className={styles.rowName}>{contract.name}</span>}
                <span className={styles.tag}>{positionCondText(p, contract)}</span>
                <span className={long ? styles.side.long : styles.side.short}>
                    <span>{sideText(p.direction)}</span>
                    <span>{maskMoney(positionQtyText(p), privMoney)}</span>
                </span>
                <span className={`${styles.rowPnl} ${styles.tone[shown === null ? 'flat' : pnlTone(shown)]}`}>
                    <span className={srOnly}>{pnlSrLabel(rp)}</span>
                    <span data-testid='position-pnl'>{shown === null ? '—' : maskMoney(fmtSigned(shown, 0), privMoney)}</span>
                </span>
            </div>}
            {sel?.reason && <p className={styles.selectReason} data-testid='position-select-reason'>{sel.reason}</p>}
            <div className={styles.rowMeta}>
                <RouteBadge account={p.account} row />
                {p.account && <span>{mobileAccountLabel(p.account, priv)}</span>}
                {stock
                    ? <span className={styles.brokerPnl} data-testid='position-broker-pnl'>{PNL_TEXT.brokerLabel} {maskMoney(fmtSigned(p.pnl, 0), privMoney)}</span>
                    : <span className={styles.brokerPnl} data-testid='position-pnl-note'>{PNL_TEXT.derivNote}</span>}
                {sp && sp.rebate !== null && sp.rebate > 0 && (
                    <span className={styles.brokerPnl} data-testid='position-rebate'>{PNL_TEXT.rebateLabel} ≈ {maskMoney(fmtInt(sp.rebate), privMoney)}</span>
                )}
            </div>
            <dl className={styles.rowGrid}>
                <Cell label='均價'>{fmtPrice(p.price)}</Cell>
                <Cell label='現價'>{fmtPrice(p.last_price)}</Cell>
                <Cell label='報酬率（估）' className={styles.tone[ret === null ? 'flat' : pnlTone(ret)]} testId='position-return'>
                    {ret === null ? '—' : fmtPct(ret)}
                </Cell>
                {stock && <Cell label='昨餘' testId='position-yd'>{yd}</Cell>}
                {stock && <Cell label='成本' testId='position-cost'>{money(cost)}</Cell>}
                {stock && <Cell label='市值' testId='position-value'>{money(value)}</Cell>}
            </dl>
            {sp && (
                <button type='button' className={styles.pnlInfo} onClick={onOpenPnl} aria-haspopup='dialog' data-testid='position-pnl-info'>
                    <span className={styles.pnlInfoBody}>
                        <span className={styles.pnlInfoMain}>
                            <span className={styles.pnlInfoLabel}>{PNL_TEXT.breakEven}</span>
                            <span className={styles.pnlInfoValue} data-testid='position-breakeven'>{breakEven}</span>
                            {relation && <span className={styles.pnlInfoRel} data-testid='position-breakeven-relation'>{relation}</span>}
                        </span>
                        <span className={styles.pnlTagList} data-testid='position-pnl-tags'>
                            {pnlTags(sp).map(t => <span key={t} className={styles.tag}>{t}</span>)}
                        </span>
                    </span>
                    <ChevronRight className={styles.actionIcon} aria-hidden='true' focusable='false' />
                </button>
            )}
            {stock && rp.reason && <p className={styles.pnlNote} data-testid='position-pnl-reason'>{rp.reason}</p>}
            {bar > 0 && (
                <div className={styles.pnlBar} aria-hidden='true' data-testid='position-pnl-bar'>
                    <span className={styles.pnlBarMid} />
                    {/* 寬度百分比（0–50，以中線為 0）→ scaleX(寬度 ÷ 100)；只動畫 transform */}
                    <span className={styles.pnlBarFill[(shown ?? 0) > 0 ? 'up' : 'down']} style={{ transform: scaleXOf(bar / 100) }} />
                </div>
            )}
            {!sel && <div className={styles.rowActions}>
                {esun && (
                    <button
                        type='button'
                        className={styles.action.detail}
                        aria-expanded={expanded}
                        onClick={onToggleDetail}
                        data-testid='position-detail-toggle'
                    >
                        <ChevronRight className={styles.detailChevron} aria-hidden='true' focusable='false' />
                        {expanded ? '收合明細' : '庫存明細'}
                    </button>
                )}
                <button type='button' className={styles.action.close} disabled={closeDisabled} onClick={onClose} data-testid='position-close'>平倉</button>
                <button type='button' className={styles.action.addOn} disabled={addOnReason !== null} onClick={() => onAddOn(contract)} data-testid='position-add'>加碼</button>
                <button type='button' className={styles.action.chart} onClick={() => navigate({ name: 'trade', code: p.code })} data-testid='position-chart'>
                    看圖
                    <ChevronRight className={styles.actionIcon} aria-hidden='true' focusable='false' />
                </button>
            </div>}
            {!sel && (addOnReason
                ? <p className={styles.rowNote} data-testid='position-add-note'>{addOnReason}</p>
                : addOnNote && <p className={styles.rowNote} data-testid='position-add-note'>{addOnNote}</p>)}
            {esun && expanded && <PositionEsunDetails position={p} />}
        </>
    );
    return embedded
        ? <div id={embeddedId} className={styles.compactDetail} data-testid='position-row' data-code={p.code}>{body}</div>
        : (
            <li
                className={styles.row}
                data-testid='position-row'
                data-code={p.code}
                data-selected={sel ? String(sel.checked) : undefined}
                onClick={sel && sel.reason === null ? rowTapToggle(onToggleSelect) : undefined}
            >
                {body}
            </li>
        );
}

// ---- 列的重繪範圍（稽核 P2）----
// 交易狀態每次發布都重繪本頁；持倉列以 memo 包起來，只在「該列實際用到的值」改變時重繪。
// - p 以參考比較：交易狀態重估市價時只替換有成交的那個代碼的持倉物件，其餘列沿用同一個物件。
// - rp（淨損益）每次重算都是新物件：比較數值、原因、商品參考，stock 明細（小型純資料）做結構比較。
// - 回呼不比較：頁面傳入的回呼只捕捉 p、由 p 算出的 key 與穩定的 rowActions／setter（見 PositionsPage），
//   p 相同時舊回呼與新回呼行為相同；rowActions 每次呼叫都轉給最新一次提交的處理函式（帳戶、閘門等狀態不會過期）。

/** 小型純資料（數字、字串、陣列、物件）的結構相等 */
export function plainEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!plainEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
}

export function rowPnlEqual(a: RowPnl, b: RowPnl): boolean {
    return a === b || (a.value === b.value && a.deriv === b.deriv && a.reason === b.reason && a.contract === b.contract && plainEqual(a.stock, b.stock));
}

/** 詳細列的 memo 比較：只比該列實際用到的欄位（回呼除外，見上方說明） */
export function rowPropsEqual(a: RowProps, b: RowProps): boolean {
    return a.p === b.p
        && a.priv === b.priv
        && a.privMoney === b.privMoney
        && a.closeDisabled === b.closeDisabled
        && a.accountReason === b.accountReason
        && a.maxAbsPnl === b.maxAbsPnl
        && a.ydNotice === b.ydNotice
        && a.expanded === b.expanded
        && a.embeddedId === b.embeddedId
        && rowSelectEqual(a.select, b.select)
        && rowPnlEqual(a.rp, b.rp);
}

const MemoPositionRow = memo(PositionRow, rowPropsEqual);

export const COMPACT_TEXT = {
    derivNote: '券商・未扣費稅',
    pending: '淨損益待確認',
    aboveBreakEven: '已過兩平',
    belowBreakEven: '未達兩平',
    atBreakEven: '等於兩平',
    /** 精簡列報酬率的報讀標籤（視覺上只有數字） */
    returnSrLabel: '報酬率（估）',
    breakEvenLabel: '兩平價',
    avgLabel: '均價',
} as const;

/**
 * 精簡列第二列的參考價：股票＝兩平價（rowPnlOf 的 StockPnl.breakEven，依跳動價位格式化，同詳細卡片；算不出為「—」）；
 * 期權沒有兩平模型（不猜費用）→ 均價，標籤明確寫「均價」。價格不遮蔽（同詳細卡片的均價、兩平價）。
 */
export function compactRefPrice(p: Pick<Position, 'price'>, rp: RowPnl): { label: string; value: string } {
    if (rp.deriv) return { label: COMPACT_TEXT.avgLabel, value: fmtPrice(p.price) };
    const be = rp.stock?.breakEven;
    return { label: COMPACT_TEXT.breakEvenLabel, value: be !== null && be !== undefined && rp.contract ? formatToTick(rp.contract, be) : '—' };
}

/**
 * 精簡列右側第二行的狀態文字（不只靠顏色）：股票＝現價與兩平價的關係（已過兩平／未達兩平／等於兩平）；
 * 期權＝券商損益未扣費稅；淨損益算不出＝待確認；缺兩平價或現價時回 null。
 */
export function compactStatusText(p: Pick<Position, 'last_price'>, rp: RowPnl): string | null {
    if (rp.deriv) return COMPACT_TEXT.derivNote;
    if (rp.value === null || !rp.stock) return COMPACT_TEXT.pending;
    const rel = breakEvenRelation(rp.stock, p.last_price);
    return rel === 'profit' ? COMPACT_TEXT.aboveBreakEven : rel === 'loss' ? COMPACT_TEXT.belowBreakEven : rel === 'even' ? COMPACT_TEXT.atBreakEven : null;
}

interface CompactRowProps {
    p: AccountedPosition;
    privMoney: boolean;
    rp: RowPnl;
    open: boolean;
    onToggle: () => void;
    /** 展開時嵌入的詳細卡片 props（未展開的列不掛詳細卡片子樹） */
    detail: Omit<RowProps, 'embeddedId'>;
    /** 選取模式：列前加勾選鍵，點列切換選取（不展開） */
    select?: RowSelect | null;
    onToggleSelect?: () => void;
}

/** 精簡列的 memo 比較：收合時只比精簡列用到的欄位；展開時再比嵌入的詳細卡片 */
export function compactRowPropsEqual(a: CompactRowProps, b: CompactRowProps): boolean {
    if (a.p !== b.p || a.privMoney !== b.privMoney || a.open !== b.open || !rowSelectEqual(a.select, b.select) || !rowPnlEqual(a.rp, b.rp)) return false;
    return !a.open || rowPropsEqual(a.detail, b.detail);
}

/** 精簡列：左＝名稱／代碼・條件・多空數量；右＝淨損益／報酬率・兩平狀態；第二列＝現價＋兩平價（期權均價）；點一下就地展開既有詳細卡片 */
function PositionCompactRow({ p, privMoney, rp, open, onToggle, detail, select, onToggleSelect }: CompactRowProps) {
    const contract = useContract(p.code);
    const detailId = useId();
    const shown = rp.value;
    const ret = rowReturnPct(p, rp);
    const status = compactStatusText(p, rp);
    const name = contract?.name;
    const ref = compactRefPrice(p, rp);
    const toggleSelect = () => onToggleSelect?.();
    const row = (
            <button
                type='button'
                className={styles.compactRow}
                aria-expanded={select ? undefined : open}
                aria-controls={open && !select ? detailId : undefined}
                aria-pressed={select ? select.checked : undefined}
                disabled={select ? select.reason !== null : undefined}
                onClick={select ? toggleSelect : onToggle}
                data-testid='position-compact-toggle'
            >
                <span className={styles.compactLeft}>
                    <span className={styles.compactName}>{name || p.code}</span>
                    <span className={styles.compactMeta}>
                        {name && <span className={styles.compactCode}>{p.code}</span>}
                        <span className={`${styles.tag} ${styles.compactTag}`}>{positionCondText(p, contract)}</span>
                        <span className={styles.compactSide[p.direction === 'Buy' ? 'long' : 'short']} data-testid='position-compact-qty'>
                            {sideText(p.direction)} {maskMoney(positionQtyText(p), privMoney)}
                        </span>
                    </span>
                </span>
                <span className={styles.compactRight}>
                    <span className={`${styles.compactPnl} ${styles.tone[shown === null ? 'flat' : pnlTone(shown)]}`}>
                        <span className={srOnly}>{pnlSrLabel(rp)}</span>
                        <span data-testid='position-compact-pnl'>{shown === null ? '—' : maskMoney(fmtSigned(shown, 0), privMoney)}</span>
                    </span>
                    <span className={styles.compactSub}>
                        {/* 報讀標籤：視覺上只有數字，按鈕的無障礙名稱補上欄位名稱（同詳細卡片的「報酬率（估）」） */}
                        {ret !== null && <span className={styles.tone[pnlTone(ret)]}><span className={srOnly}>{COMPACT_TEXT.returnSrLabel}</span><span data-testid='position-compact-return'>{fmtPct(ret)}</span></span>}
                        {status && <span data-testid='position-compact-status'>{status}</span>}
                    </span>
                </span>
                <ChevronRight className={styles.compactChevron} aria-hidden='true' focusable='false' />
                {/* 第二列：現價＋兩平價（股票）或均價（期權沒有兩平模型，不估費用；明確標「均價」） */}
                <span className={styles.compactPrices}>
                    <span data-testid='position-compact-price'>現價 {fmtPrice(p.last_price)}</span>
                    <span data-testid='position-compact-ref'>{ref.label} {ref.value}</span>
                </span>
            </button>
    );
    return (
        <li className={styles.compactItem} data-testid='position-compact-row' data-code={p.code} data-selected={select ? String(select.checked) : undefined}>
            {select ? (
                <>
                    <div className={styles.compactSelectable}>
                        <SelectCheck
                            checked={select.checked}
                            disabled={select.reason !== null}
                            label={selectLabel(p, contract, privMoney)}
                            onToggle={toggleSelect}
                            testId='position-select'
                        />
                        {row}
                    </div>
                    {select.reason && <p className={`${styles.selectReason} ${styles.compactSelectReason}`} data-testid='position-select-reason'>{select.reason}</p>}
                </>
            ) : row}
            {open && !select && <MemoPositionRow {...detail} embeddedId={detailId} />}
        </li>
    );
}

const MemoPositionCompactRow = memo(PositionCompactRow, compactRowPropsEqual);

/** 最近的可捲動祖先（殼層 main）；找不到時用文件捲動 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
    for (let n = el.parentElement; n; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return n;
    }
    return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

interface CloseSheetProps {
    position: AccountedPosition | undefined;
    gate: ResumeGateSnapshot;
    gateProblem: string | null;
    busy: boolean;
    feedback: { kind: 'cancelled' | 'notSent'; text: string } | null;
    privMoney: boolean;
    onCancel: () => void;
    onContinue: (plan: ClosePlan) => void;
}

function CloseSheet({ position, gate, gateProblem, busy, feedback, privMoney, onCancel, onContinue }: CloseSheetProps) {
    const contract = useContract(position?.code ?? null);
    const plan = position ? closePlanFor(position, contract) : POSITIONS_TEXT.gone;
    const problem = typeof plan === 'string' ? plan : gateProblem;
    const stock = position ? isStockPosition(position) : false;
    return (
        <BottomSheet open onClose={onCancel} dismissible={!busy} title='平倉說明' testId='position-close-sheet'>
            <div className={styles.sheetBody}>
                {position && (
                    <GroupedSection>
                        <p className={styles.sheetSummary}>
                            {position.code}{contract?.name ? ` ${contract.name}` : ''} {positionCondText(position, contract)} {sideText(position.direction)}{' '}
                            {maskMoney(positionQtyText(position), privMoney)}
                            {typeof plan !== 'string' && ` → 市價${closeActionText(plan)}`}
                        </p>
                        {position.account && <p className={styles.sheetRoute}><RouteBadge account={position.account} size='lg' row /></p>}
                    </GroupedSection>
                )}
                <GroupedSection>
                    {stock ? (
                        <ul className={styles.sheetList}>
                            <li>整張以市價（IOC）送出，未成交部分自動取消。</li>
                            <li>零股以{position?.direction === 'Buy' ? '跌停價' : '漲停價'}的盤中零股限價送出（可立即成交的價格）。</li>
                            <li>信用部位（融資／融券）只能整張了結；零股不能以信用條件送出。</li>
                            <li>市價成交價可能與現價有落差。股票不提供反手。</li>
                        </ul>
                    ) : (
                        <ul className={styles.sheetList}>
                            <li>以市價（IOC）、倉別「平倉」送出全部口數，未成交部分自動取消。</li>
                            <li>市價成交價可能與現價有落差。</li>
                        </ul>
                    )}
                </GroupedSection>
                <p className={styles.sheetText}>按「繼續」後會出現確認面板，滑動確認後才會送出；確認只出現一次。</p>
                {problem && <InlineNote tone='warn' role='alert' testId='position-close-problem'>{problem}</InlineNote>}
                <ResumeGateNote gate={gate} disabled={busy} showReason={false} testId='position-close-stale' />
                <SheetFooter>
                    <div className={styles.sheetBody}>
                        {feedback && (
                            <InlineNote tone={feedback.kind === 'notSent' ? 'danger' : 'info'} role='status' testId='position-close-feedback'>{feedback.text}</InlineNote>
                        )}
                        <div className={styles.sheetActions}>
                            <button type='button' className={controls.button.neutral} disabled={busy} onClick={onCancel}>取消</button>
                            <button
                                type='button'
                                className={controls.button.primary}
                                disabled={busy || problem !== null || typeof plan === 'string'}
                                onClick={() => { if (typeof plan !== 'string' && !problem) onContinue(plan); }}
                                data-testid='position-close-continue'
                            >
                                {busy ? '等待確認…' : '繼續'}
                            </button>
                        </div>
                    </div>
                </SheetFooter>
            </div>
        </BottomSheet>
    );
}

interface SwitchSheetProps {
    position: AccountedPosition | undefined;
    current: Account | null;
    priv: boolean;
    locked: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
}

function AddOnSwitchSheet({ position, current, priv, locked, error, onCancel, onConfirm }: SwitchSheetProps) {
    const target = position?.account;
    return (
        <BottomSheet open onClose={onCancel} title='切換帳戶後加碼' testId='position-switch-sheet'>
            <div className={styles.sheetBody}>
                {target ? (
                    <>
                        <p className={styles.sheetText}>
                            下單面板以「目前選取的帳戶」下單。這筆持倉屬於 {isEsunAccount(target) ? '玉山' : '永豐'} {mobileAccountLabel(target, priv)}，
                            目前選取的是 {current ? `${isEsunAccount(current) ? '玉山' : '永豐'} ${mobileAccountLabel(current, priv)}` : '（未選擇）'}。
                        </p>
                        <p className={styles.sheetText}><RouteBadge account={target} size='lg' /></p>
                        <p className={styles.sheetText}>要切換到持倉帳戶並開啟下單面板嗎？下單面板內仍需預覽並滑動確認才會送出。</p>
                    </>
                ) : (
                    <InlineNote tone='warn'>{POSITIONS_TEXT.gone}</InlineNote>
                )}
                {locked && <InlineNote tone='info' role='status'>{POSITIONS_TEXT.switchLocked}</InlineNote>}
                {error && <InlineNote tone='danger' role='alert' testId='position-switch-error'>{error}</InlineNote>}
                <SheetFooter>
                    <div className={styles.sheetActions}>
                        <button type='button' className={controls.button.neutral} onClick={onCancel}>取消</button>
                        <button type='button' className={controls.button.primary} disabled={locked || !target} onClick={onConfirm} data-testid='position-switch-confirm'>
                            切換並開啟
                        </button>
                    </div>
                </SheetFooter>
            </div>
        </BottomSheet>
    );
}

// 多選市價出清的預覽與進度面板：進入選取模式時預載，按「市價出清 N 筆」才掛載；載入失敗以 SheetLoadError 提示（可重試）
const BatchExitSheet = retryableLazy(() => import('../components/batch-exit-sheet').then(m => m.BatchExitSheet), 'BatchExitSheet');
const resetBatchExitSheet = () => { BatchExitSheet.reset(); };

interface BatchState {
    phase: BatchPhase;
    /** 執行中與完成後：滑動當下的清單快照（預覽時用目前的選取即時組出） */
    groups: BatchViewGroup[];
    states: Record<string, BatchItemState> | null;
    stop: boolean;
    /** 滑動後未開始的原因（閘門、環境未確認、其他流程進行中） */
    feedback: string | null;
}

/** 滑動當下可送出的一筆（尚未加上環境） */
interface BatchCandidate {
    key: string;
    position: AccountedPosition;
    plan: ClosePlan;
    accountKey: string;
}

export function PositionsPage() {
    const trading = useTradingState();
    const accounts = useAccounts();
    const live = useTradingLive();
    const gate = useResumeGate();
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const switchLocked = useAccountSwitchLocked();
    const costs = useBrokerCostSettings();
    // 玉山庫存明細（實際手續費、分批成交日）更新時重算淨損益
    const [, bumpEsun] = useReducer((x: number) => x + 1, 0);
    useEffect(() => subscribeEsunInventoryDetails(bumpEsun), []);

    const ydNotice = yesterdayQuantityNotice(useServerInfo());

    const positions = trading.positions;
    const query = trading.queries.positions;

    // ---- 帳戶篩選 ----
    const accountOptions = useMemo(() => {
        const map = new Map<string, Account>();
        for (const p of positions) if (p.account) map.set(accountKeyOf(p.account), p.account);
        return [...map.entries()];
    }, [positions]);
    const [filterKey, setFilterKey] = useState('');
    const activeFilter = accountOptions.some(([k]) => k === filterKey) ? filterKey : '';
    const accountRows = useMemo(
        () => (activeFilter ? positions.filter(p => accountKeyOf(p.account) === activeFilter) : positions),
        [positions, activeFilter],
    );

    // 商品資料（名稱、漲跌停價、期貨／選擇權別）預先載入快取；失敗時該列平倉停用並說明。
    // 載入完成後遞增 contractsTick，讓市場分段以最新快取重新歸類。
    const codesKey = [...new Set(positions.map(p => p.code))].sort().join(',');
    const [contractsTick, setContractsTick] = useState(0);
    useEffect(() => {
        if (!codesKey) return;
        let alive = true;
        void Promise.allSettled(codesKey.split(',').map(code => ensureContract(code)))
            .then(() => { if (alive) setContractsTick(t => t + 1); });
        return () => { alive = false; };
    }, [codesKey]);

    // ---- 市場分段、排序、分組 ----
    const [market, setMarket] = useState<PositionMarketFilter>('all');
    const [sort, setSort] = useState<PositionSortMode>('default');
    const { rows, unclassified } = filterByMarket(accountRows, market, getCachedContract);

    // ---- 淨損益 ----
    // 今日成交只在委託查詢成功後採用（否則無法確定今天沒有買進 → 未判斷當沖）
    const ordersQuery = trading.queries.orders as TradingQueryStatus | undefined;
    const ordersKnown = !!ordersQuery && ordersQuery.updatedAt !== null && !ordersQuery.error;
    const trades = trading.trades;
    const fills = useMemo(() => (ordersKnown ? todayStockFills(trades ?? [], Date.now()) : null), [ordersKnown, trades]);
    const pnlCtx: RowPnlContext = { costs, now: Date.now(), fills };
    const pnlCache = new Map<string, RowPnl>();
    const pnlOf = (p: AccountedPosition): RowPnl => {
        const key = positionKey(p);
        let r = pnlCache.get(key);
        if (!r) { r = rowPnlOf(p, getCachedContract(p.code), pnlCtx); pnlCache.set(key, r); }
        return r;
    };
    // 損益與報酬率排序用淨損益（無法計算時以券商數字排序，只影響順序）
    const sortedRows = sort === 'pnl'
        ? sortByValue(rows, p => pnlOf(p).value ?? (finiteNum(p.pnl) ? p.pnl : null))
        : sort === 'return'
            ? sortByValue(rows, p => rowReturnPct(p, pnlOf(p)) ?? positionReturnPct(p))
            : sortPositions(rows, sort);
    const groups = groupPositionsByAccount(sortedRows);
    const summary = summarizePositions(rows);
    const totals = netTotals(rows, pnlOf);
    const netSummary = {
        ...summary,
        pnl: totals.sum,
        pnlPct: summary.pnlPct !== null && totals.pending === 0 && summary.stockCost ? (totals.sum / summary.stockCost) * 100 : null,
    };
    const maxAbsPnl = rows.reduce((mx, p) => { const v = pnlOf(p).value; return v === null ? mx : Math.max(mx, Math.abs(v)); }, 0);
    // 持倉還沒讀到時合計未知：顯示「—」而不是 0
    const totalKnown = query.updatedAt !== null || positions.length > 0;
    // 保證金屬於「目前選取的期貨帳戶」：範圍包含該帳戶（全部帳戶或就是它）且不是只看股票時才顯示
    const futuresKey = accountKeyOf(accounts.selectedFutures);
    const showMargin = !!trading.margin && market !== 'stock' && futuresKey !== '' && (activeFilter === '' || activeFilter === futuresKey);
    // 今日額度列：篩選單一證券帳戶時顯示該帳戶；全部或期貨帳戶時沿用目前選取的證券帳戶（只看期貨列時摘要卡不顯示）
    const filterAccount = activeFilter ? accountOptions.find(([k]) => k === activeFilter)?.[1] ?? null : null;
    const limitsAccount = filterAccount?.account_type === 'S' ? filterAccount : null;

    // ---- 損益計算明細面板 ----
    const [pnlKey, setPnlKey] = useState<string | null>(null);
    const pnlTarget = pnlKey ? positions.find(p => positionKey(p) === pnlKey) : undefined;
    const pnlTargetRow = pnlTarget ? pnlOf(pnlTarget) : null;

    // ---- 玉山庫存明細展開 ----
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const toggleDetail = (key: string) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    // ---- 「詳細｜精簡」檢視（預設詳細；localStorage 讀寫失敗時只在本次有效）----
    const [view, setView] = useState<PositionsView>(readPositionsView);
    const viewRef = useRef<HTMLDivElement | null>(null);
    const viewAnchor = useRef<number | null>(null);
    const changeView = (next: PositionsView) => {
        if (next === view) return;
        // 以切換鍵為錨點：記下它在視窗中的位置，提交後補回內容高度改變造成的位移（保留捲動位置）
        viewAnchor.current = viewRef.current ? viewRef.current.getBoundingClientRect().top : null;
        setView(next);
        writePositionsView(next);
    };
    useLayoutEffect(() => {
        const before = viewAnchor.current;
        viewAnchor.current = null;
        const el = viewRef.current;
        if (before === null || !el) return;
        const scroller = scrollParentOf(el);
        const delta = el.getBoundingClientRect().top - before;
        if (scroller && delta !== 0) scroller.scrollTop += delta;
    }, [view]);
    // 精簡列展開（可同時展開多列：展開或收合一列時其他列不位移）
    const [compactOpen, setCompactOpen] = useState<ReadonlySet<string>>(() => new Set());
    const toggleCompact = (key: string) => setCompactOpen(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });

    // ---- 「⟳」6 秒冷卻 ----
    const [cooling, setCooling] = useState(false);
    const coolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (coolTimer.current) clearTimeout(coolTimer.current); }, []);
    const onRefresh = () => {
        if (cooling) return;
        setCooling(true);
        void refreshTradingState('positions').catch(() => undefined);
        coolTimer.current = setTimeout(() => { coolTimer.current = null; setCooling(false); }, REFRESH_COOLDOWN_MS);
    };

    // ---- 平倉 ----
    const mounted = useRef(true);
    // 多選市價出清：卸載時停止剩餘並取消尚未核准的那一筆（abortBatchExit；送出中的那一筆無法取消）
    const batchStopRef = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            batchStopRef.current = true;
            abortBatchExit(BATCH_STOPPED);
        };
    }, []);
    const [closeKey, setCloseKey] = useState<string | null>(null);
    const [closing, setClosing] = useState(false);
    const closingRef = useRef(false);
    // 批次是模組層狀態：離開持倉頁前開始的批次在送出中的那一筆完成前仍在進行；這段期間本頁也不開始單筆平倉或另一個批次
    const batchActive = useSyncExternalStore(subscribeBatchExit, isBatchExitActive);
    const [closeFeedback, setCloseFeedback] = useState<CloseSheetProps['feedback']>(null);
    const gateProblem = closeGateProblem(live, gate);
    const closeTarget = closeKey ? positions.find(p => positionKey(p) === closeKey) : undefined;

    const openClose = (p: AccountedPosition) => {
        if (closingRef.current || isBatchExitActive()) return;
        setCloseFeedback(null);
        setCloseKey(positionKey(p));
    };
    const cancelClose = () => {
        if (closingRef.current) return;
        setCloseKey(null);
        setCloseFeedback(null);
    };
    const continueClose = async (plan: ClosePlan) => {
        if (closingRef.current) return;
        // 按下當下再驗一次閘門（按鈕停用是第一道，beforeSend 是送出前最後一道）；批次進行中不開始（確認會被批次授權拒絕）
        const problem = isBatchExitActive() ? POSITIONS_TEXT.batchRunning : closeGateProblem(live, getResumeGate());
        if (problem) { setCloseFeedback({ kind: 'notSent', text: `未送出：${problem}` }); return; }
        closingRef.current = true;
        setClosing(true);
        setCloseFeedback(null);
        const code = plan.contract.code;
        const qty = plan.kind === 'stock' ? fmtStockLots(plan.shares) : `${plan.lots} 口`;
        try {
            await executeClose(plan);
            notify({ kind: 'ok', title: POSITIONS_TEXT.closeSent, body: `${code} 市價${closeActionText(plan)} ${secretMoney(qty)}` });
            if (mounted.current) setCloseKey(null);
        } catch (err) {
            const outcome = classifyTicketOutcome(err);
            if (outcome === 'cancelled') {
                if (mounted.current) setCloseFeedback({ kind: 'cancelled', text: POSITIONS_TEXT.cancelled });
            } else if (outcome === 'not-sent') {
                if (mounted.current) setCloseFeedback({ kind: 'notSent', text: `未送出：${errorText(err)}` });
            } else {
                // 結果未知：不自動重送、不提供重送鍵；關閉面板並觸發對帳
                notify({ kind: 'err', title: OUTCOME_UNKNOWN_TITLE, body: `${code} 平倉：${errorText(err)}` });
                reconcileAfterUnknownOutcome();
                if (mounted.current) setCloseKey(null);
            }
        } finally {
            closingRef.current = false;
            if (mounted.current) setClosing(false);
        }
    };

    // ---- 加碼 ----
    const [switchKey, setSwitchKey] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);
    const switchTarget = switchKey ? positions.find(p => positionKey(p) === switchKey) : undefined;
    const selectedFor = (p: AccountedPosition): Account | null => (isStockPosition(p) ? accounts.selectedStock : accounts.selectedFutures) ?? null;
    const tradableAccountOf = (p: AccountedPosition): Account | undefined =>
        accounts.accounts.find(a => accountMatches(a, p.account) && canTrade(a));

    const accountReasonOf = (p: AccountedPosition): string | null => (tradableAccountOf(p) ? null : POSITIONS_TEXT.accountNotTradable);

    const onAddOn = (p: AccountedPosition, contract: ContractInfo | undefined) => {
        // 按下當下再驗一次（按鈕停用是第一道）
        const plan = addOnPlanFor(p, contract);
        if (typeof plan === 'string' || accountReasonOf(p)) return;
        if (accountMatches(selectedFor(p), p.account)) {
            openTicket(plan.request);
            return;
        }
        setSwitchError(null);
        setSwitchKey(positionKey(p));
    };
    const confirmSwitch = () => {
        const p = switchTarget;
        if (!p || switchLocked) return;
        const plan = addOnPlanFor(p, getCachedContract(p.code));
        if (typeof plan === 'string') { setSwitchError(plan); return; }
        const acc = tradableAccountOf(p);
        if (!acc) { setSwitchError(POSITIONS_TEXT.accountNotTradable); return; }
        selectAccount(acc);
        const now = getAccountState();
        const selected = acc.account_type === 'S' ? now.selectedStock : now.selectedFutures;
        if (!accountMatches(selected, acc)) { setSwitchError(POSITIONS_TEXT.switchFailed); return; }
        setSwitchKey(null);
        openTicket(plan.request);
    };

    // ---- 多選市價出清（§7.7、§10 S10）：選取 → 預覽面板滑動一次 → 依序送出 ----
    const [selecting, setSelecting] = useState(false);
    /** 已選：positionKey → 選取時的數量（數量改變就移出選取） */
    const [selected, setSelected] = useState<ReadonlyMap<string, number>>(() => new Map());
    const [selectNote, setSelectNote] = useState<string | null>(null);
    const [batch, setBatch] = useState<BatchState | null>(null);
    const batchRunning = batch?.phase === 'running';
    const selectReasonCache = new Map<string, string | null>();
    const selectReasonOf = (p: AccountedPosition): string | null => {
        const key = positionKey(p);
        if (!selectReasonCache.has(key)) selectReasonCache.set(key, batchSelectReason(p, getCachedContract(p.code)));
        return selectReasonCache.get(key) ?? null;
    };
    const exitSelecting = () => {
        setSelecting(false);
        setSelected(new Map());
        setSelectNote(null);
    };
    const toggleSelecting = () => {
        if (batchRunning) return;
        if (selecting) { exitSelecting(); return; }
        void BatchExitSheet.preload();
        setSelecting(true);
    };
    const setManySelected = (ps: readonly AccountedPosition[], on: boolean) => setSelected(prev => {
        const next = new Map(prev);
        for (const p of ps) {
            if (on) next.set(positionKey(p), p.quantity);
            else next.delete(positionKey(p));
        }
        return next;
    });
    const toggleSelect = (p: AccountedPosition) => {
        if (batchRunning || selectReasonOf(p) !== null) return;
        setManySelected([p], !selected.has(positionKey(p)));
    };
    /** 全選三態：可選的列全部已選＝true、部分＝mixed、都沒選＝false */
    const selectState = (ps: readonly AccountedPosition[]): boolean | 'mixed' => {
        const n = ps.filter(p => selected.has(positionKey(p))).length;
        return n === 0 ? false : n === ps.length ? true : 'mixed';
    };
    // 篩選改變：清除選取（不讓被篩掉的持倉以看不見的選取留在批次裡）
    const changeMarket = (v: PositionMarketFilter) => { setMarket(v); setSelected(new Map()); };
    const changeFilter = (v: string) => { setFilterKey(v); setSelected(new Map()); };
    // 已選的持倉消失、數量改變或變成不可列入：移出選取並說明（執行中與完成後不動）
    useEffect(() => {
        if (!selected.size || batch?.phase === 'running' || batch?.phase === 'done') return;
        const byKey = new Map(positions.map(p => [positionKey(p), p]));
        const next = new Map<string, number>();
        for (const [k, q] of selected) {
            const p = byKey.get(k);
            if (p && p.quantity === q && batchSelectReason(p, getCachedContract(p.code)) === null) next.set(k, q);
        }
        if (next.size === selected.size) return;
        setSelected(next);
        setSelectNote(`${selected.size - next.size} 筆已選的持倉已變動或不在清單，已移出選取`);
    }, [positions, selected, batch?.phase, contractsTick]);

    // 預覽清單（依畫面順序、依帳戶分組）與滑動當下要送出的內容
    const batchGroups: BatchViewGroup[] = [];
    const batchCandidates: BatchCandidate[] = [];
    if (selecting && selected.size > 0) {
        for (const g of groupPositionsByAccount(sortedRows.filter(p => selected.has(positionKey(p))))) {
            if (!g.account) continue;
            const items: BatchViewGroup['items'] = [];
            for (const p of g.rows) {
                const c = getCachedContract(p.code);
                const plan = closePlanFor(p, c);
                if (typeof plan === 'string' || batchSelectReason(p, c) !== null) continue;
                const key = positionKey(p);
                batchCandidates.push({ key, position: p, plan, accountKey: g.key });
                items.push({
                    key,
                    code: p.code,
                    ...(c?.name ? { name: c.name } : {}),
                    // 數量明碼（遮蔽金額時也一樣）：同 batchLegs 與單筆確認面板
                    summary: `${positionCondText(p, c)} ${sideText(p.direction)} ${positionQtyText(p)}`,
                    actionText: closeActionText(plan),
                    legs: batchLegs(plan),
                });
            }
            if (items.length) batchGroups.push({ key: g.key, account: g.account, label: groupLabel(g.account, priv), items });
        }
    }
    // 不能開始的原因（預覽面板停用滑塊並顯示）：單筆平倉進行中、另一個批次仍在處理（例如離開本頁前開始的）、下單面板或確認進行中、閘門
    const batchBlock = closing || batchActive || switchLocked ? POSITIONS_TEXT.batchBusy : gateProblem;
    const latestLive = useRef({ positions, live });
    useLayoutEffect(() => {
        latestLive.current = { positions, live };
    });

    const startBatch = async (envs: ReadonlyMap<string, boolean | undefined>) => {
        // 與單筆平倉共用 closingRef：其他平倉、下單面板、委託操作面板或確認進行中都不開始（滑動當下再讀一次最新狀態）
        if (closingRef.current || batchRunning) return;
        const ui = getMobileUi();
        const busy = switchLocked || isBatchExitActive() || ui.ticket !== null || ui.orderAction !== null || getPendingOrderConfirm() !== null;
        const problem = busy ? POSITIONS_TEXT.batchBusy : closeGateProblem(live, getResumeGate());
        const items: BatchExitItem[] = [];
        let envProblem = false;
        for (const c of batchCandidates) {
            const simulation = envs.get(c.accountKey);
            if (typeof simulation !== 'boolean') envProblem = true;
            else items.push({ key: c.key, position: c.position, plan: c.plan, simulation });
        }
        const why = problem ?? (envProblem ? POSITIONS_TEXT.batchEnvUnknown : null);
        if (why || items.length === 0) {
            setBatch(b => b && { ...b, feedback: why ? `未送出：${why}` : null });
            return;
        }
        closingRef.current = true;
        batchStopRef.current = false;
        setClosing(true);
        // 滑動當下的前景（resumeSeq）：之後回到背景再回前景（重新同步）就停止剩餘，不沿用背景前的那一次滑動
        const startSeq = getResumeGate().resumeSeq;
        const states: Record<string, BatchItemState> = {};
        for (const it of items) states[it.key] = { status: 'waiting' };
        setBatch({ phase: 'running', groups: batchGroups, states, stop: false, feedback: null });
        try {
            await runBatchExit(items, {
                current: (item) => {
                    const p = latestLive.current.positions.find(x => positionKey(x) === item.key);
                    return p ? { position: p, plan: closePlanFor(p, getCachedContract(p.code)) } : null;
                },
                gateProblem: () => batchGateProblem(latestLive.current.live, startSeq),
                execute: executeClose,
                stopRequested: () => batchStopRef.current,
                onState: (i, st) => {
                    const key = items[i]!.key;
                    if (mounted.current) setBatch(b => b && { ...b, states: { ...b.states, [key]: st } });
                },
            });
        } catch (err) {
            // 執行器本身出錯（不應發生）：還沒處理的列標未送出；送出中的列結果未知並觸發對帳
            notify({ kind: 'err', title: POSITIONS_TEXT.batchFailed, body: errorText(err) });
            reconcileAfterUnknownOutcome();
            if (mounted.current) {
                setBatch(b => b && {
                    ...b,
                    states: Object.fromEntries(Object.entries(b.states ?? {}).map(([k, st]) => [k,
                        st.status === 'waiting' ? { status: 'not-sent', reason: POSITIONS_TEXT.batchFailed }
                            : st.status === 'sending' ? { status: 'unknown', reason: errorText(err) } : st])),
                });
            }
        } finally {
            closingRef.current = false;
            if (mounted.current) {
                setClosing(false);
                setBatch(b => b && { ...b, phase: 'done' });
                exitSelecting();
            }
        }
    };
    const stopBatch = () => {
        batchStopRef.current = true;
        // 尚未核准的那一筆（例如仍在等待伺服器模式）也立即取消；已送出中的那一筆不受影響
        abortBatchExit(BATCH_STOPPED);
        setBatch(b => b && { ...b, stop: true });
    };
    const closeBatch = () => {
        if (!batchRunning) setBatch(null);
    };

    // ---- 列的動作（memo 列用）：穩定的轉接函式，每次呼叫都轉給最新一次提交的處理函式 ----
    const latestRowHandlers = useRef({ openClose, onAddOn, toggleDetail, toggleCompact, toggleSelect });
    useLayoutEffect(() => {
        latestRowHandlers.current = { openClose, onAddOn, toggleDetail, toggleCompact, toggleSelect };
    });
    const rowActions = useMemo(() => ({
        close: (p: AccountedPosition) => latestRowHandlers.current.openClose(p),
        addOn: (p: AccountedPosition, contract: ContractInfo | undefined) => latestRowHandlers.current.onAddOn(p, contract),
        toggleDetail: (key: string) => latestRowHandlers.current.toggleDetail(key),
        toggleCompact: (key: string) => latestRowHandlers.current.toggleCompact(key),
        select: (p: AccountedPosition) => latestRowHandlers.current.toggleSelect(p),
    }), []);
    const selectableRows = selecting ? sortedRows.filter(p => selectReasonOf(p) === null) : [];
    const pageSelect = selectState(selectableRows);

    const reconcile = reconcileText(query);
    const loading = query.updatedAt === null && !query.error;
    // 第一次讀取就失敗（從未讀到）：不能說「目前沒有持倉」（比照委託頁 readFailed、桌面 holdingsPhase 'failed'）
    const readFailed = query.updatedAt === null && !!query.error;

    return (
        <section className={styles.page} data-testid='page-positions'>
            <PageHeader
                title='持倉'
                actions={(
                    <>
                        <button
                            type='button'
                            className={styles.headerToggle}
                            aria-pressed={selecting}
                            disabled={batchRunning || (!selecting && positions.length === 0)}
                            onClick={toggleSelecting}
                            data-testid='position-select-mode'
                        >
                            選取
                        </button>
                        <IconButton
                            icon={RotateCw}
                            ariaLabel={cooling ? '更新持倉（冷卻中）' : '更新持倉'}
                            disabled={cooling}
                            onClick={onRefresh}
                            testId='position-refresh'
                        />
                    </>
                )}
            />

            <div className={styles.inset}>
                <Segmented<PositionMarketFilter>
                    semantics='toggle'
                    ariaLabel='市場篩選'
                    testId='position-market-filter'
                    items={MARKET_FILTERS.map(f => ({ value: f.key, label: f.label, testId: `position-market-${f.key}` }))}
                    value={market}
                    onChange={changeMarket}
                />
            </div>

            <div className={styles.filterRow}>
                <PopUpButton
                    className={styles.picker}
                    ariaLabel='帳戶篩選'
                    testId='position-account-filter'
                    value={activeFilter}
                    options={[{ value: '', label: '帳戶：全部' }, ...accountOptions.map(([k, a]) => ({ value: k, label: groupLabel(a, priv) }))]}
                    onChange={changeFilter}
                />
                <PopUpButton<PositionSortMode>
                    className={styles.picker}
                    ariaLabel='排序'
                    testId='position-sort'
                    value={sort}
                    options={SORT_MODES.map(s => ({ value: s.key, label: `排序：${s.label}` }))}
                    onChange={setSort}
                />
                <div className={styles.viewToggle} ref={viewRef}>
                    <Segmented<PositionsView>
                        semantics='toggle'
                        size='compact'
                        ariaLabel='持倉顯示方式'
                        testId='position-view'
                        items={[
                            { value: 'detail', label: '詳細', testId: 'position-view-detail' },
                            { value: 'compact', label: '精簡', testId: 'position-view-compact' },
                        ]}
                        value={view}
                        onChange={changeView}
                    />
                </div>
            </div>

            {reconcile && (
                <div className={styles.inset}>
                    <InlineNote tone='warn' role='status' testId='position-reconcile'>{reconcile}</InlineNote>
                </div>
            )}
            {gateProblem && gateProblem !== POSITIONS_TEXT.staleData && positions.length > 0 && (
                <div className={styles.inset}>
                    <InlineNote tone='info' role='status' testId='position-gate-note'>{gateProblem}</InlineNote>
                </div>
            )}
            {/* stale-data：原因＋勾選了解＋重試同步（勾選後仍顯示，讓使用者可隨時重試） */}
            <div className={styles.inset}>
                <ResumeGateNote gate={gate} disabled={closing} testId='position-gate-stale' />
            </div>

            <PositionSummaryCard
                summary={netSummary}
                known={totalKnown}
                pending={totals.pending}
                allPending={totals.counted === 0 && totals.pending > 0}
                derivGross={totals.deriv}
                rebate={totals.rebateRows > 0 ? totals.rebate : 0}
                margin={showMargin ? trading.margin ?? null : null}
                futuresLabel={accounts.selectedFutures ? mobileAccountLabel(accounts.selectedFutures, priv) : ''}
                privMoney={privMoney}
                limitsAccount={limitsAccount}
                compact={view === 'compact'}
            />

            {unclassified > 0 && (
                <p className={styles.filterNote} role='status' data-testid='position-unclassified'>
                    {unclassified} 筆期權持倉的商品資料尚未載入，暫時無法歸類為期貨或選擇權（可在「全部」查看）
                </p>
            )}

            {loading ? (
                <div className={styles.emptyWrap}><Skeleton label={POSITIONS_TEXT.loading} rows={3} /></div>
            ) : positions.length === 0 ? (
                <div className={styles.emptyWrap}>
                    <EmptyState icon={Wallet} title={readFailed ? POSITIONS_TEXT.readFailed : POSITIONS_TEXT.empty} testId='position-empty' />
                </div>
            ) : rows.length === 0 ? (
                <div className={styles.emptyWrap}><EmptyState title={POSITIONS_TEXT.filteredEmpty} /></div>
            ) : (
                groups.map(g => {
                    const gt = netTotals(g.rows, pnlOf);
                    const groupSelectable = selecting ? g.rows.filter(p => selectReasonOf(p) === null) : [];
                    const groupState = selectState(groupSelectable);
                    return (
                    <GroupedSection
                        key={g.key || 'unknown'}
                        testId='position-group'
                        header={(
                            <span className={styles.groupHeader} data-testid='position-group-header'>
                                {selecting && (
                                    <SelectCheck
                                        checked={groupSelectable.length ? groupState : false}
                                        disabled={groupSelectable.length === 0 || batchRunning}
                                        label={`全選 ${groupLabel(g.account, priv)}`}
                                        onToggle={() => setManySelected(groupSelectable, groupState !== true)}
                                        className={styles.groupSelect}
                                        testId='position-group-select'
                                    >
                                        全選
                                    </SelectCheck>
                                )}
                                <span className={styles.groupTitle}>{groupLabel(g.account, priv)}</span>
                                <span className={styles.groupStat}>{g.count} 筆</span>
                                {g.value && (
                                    <span className={styles.groupStat}>
                                        市值 {maskMoney(fmtInt(Math.round(g.value.value)), privMoney)}{g.value.incomplete ? '（部分缺價未計）' : ''}
                                    </span>
                                )}
                                {/* 頁面底色上：損益小計用 foreground＋正負號（§4.8 規則 9，不放漲跌色小字） */}
                                <span className={styles.groupPnl} data-testid='position-group-pnl'>
                                    損益 {gt.counted === 0 && gt.pending > 0 ? '—' : maskMoney(fmtSigned(gt.sum, 0), privMoney)}
                                    {gt.pending > 0 ? '（待確認）' : ''}
                                </span>
                            </span>
                        )}
                    >
                        <ul className={styles.list} aria-label={groupLabel(g.account, priv)}>
                            {g.rows.map(p => {
                                const key = positionKey(p);
                                // 回呼只捕捉 p、key 與穩定的 rowActions／setPnlKey（memo 比較不看回呼，見 rowPropsEqual）
                                const detail: Omit<RowProps, 'embeddedId'> = {
                                    p,
                                    priv,
                                    privMoney,
                                    closeDisabled: closing || batchActive || gateProblem !== null,
                                    accountReason: accountReasonOf(p),
                                    maxAbsPnl,
                                    ydNotice,
                                    expanded: expanded.has(key),
                                    rp: pnlOf(p),
                                    onClose: () => rowActions.close(p),
                                    onAddOn: (contract) => rowActions.addOn(p, contract),
                                    onToggleDetail: () => rowActions.toggleDetail(key),
                                    onOpenPnl: () => setPnlKey(key),
                                };
                                // 選取模式：每列勾選鍵（不可列入時停用並顯示原因）
                                const select: RowSelect | null = selecting ? { checked: selected.has(key), reason: selectReasonOf(p) } : null;
                                const onToggleSelect = () => rowActions.select(p);
                                if (view !== 'compact') return <MemoPositionRow key={key} {...detail} select={select} onToggleSelect={onToggleSelect} />;
                                return (
                                    <MemoPositionCompactRow
                                        key={key}
                                        p={p}
                                        privMoney={privMoney}
                                        rp={detail.rp}
                                        open={!selecting && compactOpen.has(key)}
                                        onToggle={() => rowActions.toggleCompact(key)}
                                        detail={detail}
                                        select={select}
                                        onToggleSelect={onToggleSelect}
                                    />
                                );
                            })}
                        </ul>
                    </GroupedSection>
                    );
                })
            )}

            {pnlTarget && pnlTargetRow?.stock && pnlTargetRow.contract && (
                <PositionPnlSheet
                    summary={`${pnlTarget.code}${pnlTargetRow.contract.name ? ` ${pnlTargetRow.contract.name}` : ''} ${positionCondText(pnlTarget, pnlTargetRow.contract)} ${sideText(pnlTarget.direction)} ${maskMoney(positionQtyText(pnlTarget), privMoney)}`}
                    pnl={pnlTargetRow.stock}
                    contract={pnlTargetRow.contract}
                    brokerPnl={pnlTarget.pnl}
                    privMoney={privMoney}
                    onClose={() => setPnlKey(null)}
                />
            )}

            {closeKey !== null && (
                <CloseSheet
                    position={closeTarget}
                    gate={gate}
                    gateProblem={gateProblem}
                    busy={closing}
                    feedback={closeFeedback}
                    privMoney={privMoney}
                    onCancel={cancelClose}
                    onContinue={(plan) => { void continueClose(plan); }}
                />
            )}
            {/* 選取模式：底部配件槽（ShellSlot bottom，不在捲動容器內；殼層讓出高度，最後一列可捲到工具列上方） */}
            {selecting && (
                <ShellSlot slot='bottom'>
                    <div className={styles.selectBar} data-testid='position-select-bar'>
                        {selectNote && <p className={styles.selectReason} role='status' data-testid='position-select-note'>{selectNote}</p>}
                        <div className={styles.selectBarRow}>
                            <span className={styles.selectBarCount} data-testid='position-selected-count'>已選 {fmtInt(selected.size)} 筆</span>
                            <SelectCheck
                                checked={selectableRows.length ? pageSelect : false}
                                disabled={selectableRows.length === 0 || batchRunning}
                                label='全選'
                                onToggle={() => setManySelected(selectableRows, pageSelect !== true)}
                                className={styles.groupSelect}
                                testId='position-select-all'
                            >
                                全選
                            </SelectCheck>
                            <button type='button' className={styles.textButton} disabled={batchRunning} onClick={exitSelecting} data-testid='position-select-cancel'>取消</button>
                        </div>
                        <button
                            type='button'
                            className={styles.clearOutButton}
                            disabled={selected.size === 0 || batchRunning}
                            onClick={() => setBatch({ phase: 'preview', groups: [], states: null, stop: false, feedback: null })}
                            data-testid='position-clear-out'
                        >
                            市價出清 {fmtInt(selected.size)} 筆
                        </button>
                    </div>
                </ShellSlot>
            )}
            {batch && (
                <ModuleErrorBoundary
                    onRetry={resetBatchExitSheet}
                    fallback={props => <SheetLoadError {...props} open onClose={closeBatch} testId='batch-exit-load-error' />}
                >
                    <Suspense fallback={null}>
                        <BatchExitSheet
                            phase={batch.phase}
                            groups={batch.phase === 'preview' ? batchGroups : batch.groups}
                            states={batch.states}
                            blockReason={batchBlock}
                            note={batch.feedback ?? selectNote}
                            stopRequested={batch.stop}
                            summary={batch.phase === 'done' ? batchSummaryText(Object.values(batch.states ?? {})) : null}
                            onConfirm={(envs) => { void startBatch(envs); }}
                            onStop={stopBatch}
                            onClose={closeBatch}
                        />
                    </Suspense>
                </ModuleErrorBoundary>
            )}
            {switchKey !== null && (
                <AddOnSwitchSheet
                    position={switchTarget}
                    current={switchTarget ? selectedFor(switchTarget) : null}
                    priv={priv}
                    locked={switchLocked}
                    error={switchError}
                    onCancel={() => { setSwitchKey(null); setSwitchError(null); }}
                    onConfirm={confirmSwitch}
                />
            )}
        </section>
    );
}
