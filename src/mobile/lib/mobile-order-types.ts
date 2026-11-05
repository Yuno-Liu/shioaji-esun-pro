// src/mobile/lib/mobile-order-types.ts — 手機新單輸入（規格 §7.1）
// 股票與期權兩種輸入以 isFutures 區分（discriminated union），TypeScript 才能在各分支取用正確欄位。

import type { ContractInfo } from '../../lib/types/contract';
import type {
    Action,
    FuturesOCType,
    FuturesOrderReq,
    FuturesPriceType,
    OrderType,
    StockOrderLot,
    StockOrderReq,
} from '../../lib/types/order';
import type { Account } from '../../lib/types/portfolio';

interface MobileOrderCommon {
    /** useContract() 取得（含漲跌停、day_trade、multiplier） */
    contract: ContractInfo;
    /** 下單面板上顯示的帳戶（必須等於目前市場槽位：股票 selectedStock、期權 selectedFutures） */
    displayedAccount: Account;
    action: Action;
    /** 整股為張、零股為股、期權為口 */
    quantity: number;
    /** 市價送 0 */
    price: number;
    orderType: OrderType;
}

/** 股票：stockOrder.order_cond 為現股時不送（undefined）；daytrade_short 只在「賣出＋現股」時送 true */
export type MobileStockOrderInput = MobileOrderCommon & {
    isFutures: false;
    priceType: 'LMT' | 'MKT';
    orderLot: StockOrderLot;
    stockOrder: StockOrderReq;
};

/** 期貨／選擇權單式（玉山帳戶不可用，見規格 R8） */
export type MobileFuturesOrderInput = MobileOrderCommon & {
    isFutures: true;
    priceType: FuturesPriceType;
    octype: FuturesOCType;
    futuresOrder: FuturesOrderReq;
    orderLot?: undefined;
};

export type MobileOrderInput = MobileStockOrderInput | MobileFuturesOrderInput;
