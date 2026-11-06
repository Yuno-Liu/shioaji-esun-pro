// src/mobile/components/sector/sector-detail-sheet.tsx — 產業說明面板（產業流向分頁點列開啟）
//
// 只顯示既有資料即可取得的資訊（0 個額外請求）：
// - 群組指標：加權漲跌、成交值、成分檔數；占本市場產業成交值合計、漲幅名次（由同一份群組指標算出）。
// - 建底快照的參考權重（getIcBootstrapGroupWeights，建底已取得、不另查）。
// - 本頁記錄的資金流向：近 5 分淨流入／成交值、累計淨流入／量到的成交值、每分鐘累計淨流入走勢。
// 成分股明細需要群組內排行的額外訂閱（桌面「產業全景」的下鑽），手機版不做，面板上說明。
// 面板內沒有任何下單、改單、刪單入口（§10 S1）。

import { BottomSheet } from '../bottom-sheet';
import { GroupedSection, ValueRow } from '../../ui/grouped';
import * as s from '../../styles/sector.css';
import {
    fmtSectorMoney,
    fmtSectorPct,
    gainRank,
    MARKET_LABEL,
    toneOf,
    visibleFlow,
    type FlowStatus,
    type SectorMarket,
    type SectorRow,
} from './sector-model';

export const SECTOR_NO_MEMBERS_NOTE = '成分股明細需要另外的即時訂閱（桌面版「產業全景」提供），手機版暫不提供。';

const FLOW_ESTIMATE_NOTE = '每分鐘成交值增量依該分鐘加權漲跌方向計為流入或流出（估算）。';
const FLOW_FOOTER: Record<FlowStatus, string> = {
    live: FLOW_ESTIMATE_NOTE,
    ended: `已收盤，以下為今日開啟本頁期間量到的流向。${FLOW_ESTIMATE_NOTE}`,
    closed: '非交易時段沒有即時資料，資金流向以「—」表示。',
    waiting: '尚未收到盤中即時資料，資金流向以「—」表示。',
};

function Toned({ value, text }: { value: number | null | undefined; text: string }) {
    return <span className={s.valueTone[toneOf(value)]}>{text}</span>;
}

/** 每分鐘累計淨流入走勢（純視覺，數值在旁邊的列；aria-hidden） */
export function FlowSpark({ series }: { series: readonly number[] }) {
    if (series.length < 2) return null;
    let lo = 0;
    let hi = 0;
    for (const v of series) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const y = (v: number) => 40 - ((v - lo) / span) * 40;
    const points = series.map((v, i) => `${((i / (series.length - 1)) * 100).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const last = series[series.length - 1]!;
    return (
        <svg className={s.spark} viewBox='0 0 100 40' preserveAspectRatio='none' aria-hidden='true' focusable='false' data-testid='sector-detail-spark'>
            <line className={s.sparkZero} x1='0' x2='100' y1={y(0)} y2={y(0)} vectorEffect='non-scaling-stroke' />
            <polyline className={s.sparkLine[toneOf(last)]} points={points} vectorEffect='non-scaling-stroke' />
        </svg>
    );
}

export interface SectorDetailSheetProps {
    row: SectorRow | null;
    rows: readonly SectorRow[];
    market: SectorMarket;
    status: FlowStatus;
    /** 參考權重（佔指數 %）；建底尚未完成時 undefined */
    weight: number | undefined;
    dataTime: string | null;
    onClose(): void;
}

export function SectorDetailSheet({ row, rows, market, status, weight, dataTime, onClose }: SectorDetailSheetProps) {
    const flow = row ? visibleFlow(row, status) : null;
    const rank = row ? gainRank(rows, row.key) : null;
    const dash = '—';
    return (
        <BottomSheet open={row !== null} onClose={onClose} title={row?.name ?? ''} testId='sector-detail-sheet'>
            {row ? (
                <div className={s.sheetBody}>
                    <GroupedSection header={`${MARKET_LABEL[market]}・今日`}>
                        <ValueRow label='加權漲跌' value={<Toned value={row.pct} text={fmtSectorPct(row.pct)} />} testId='sector-detail-pct' />
                        <ValueRow label='成交值' value={fmtSectorMoney(row.amount)} testId='sector-detail-amount' />
                        <ValueRow
                            label={`占${MARKET_LABEL[market]}產業成交值`}
                            value={row.share === null ? dash : `${(row.share * 100).toFixed(1)}%`}
                            testId='sector-detail-share'
                        />
                        <ValueRow label='漲幅名次' value={rank ? `${rank.rank} / ${rank.of}` : dash} testId='sector-detail-rank' />
                        <ValueRow label='成分檔數' value={row.count > 0 ? `${row.count} 檔` : dash} testId='sector-detail-count' />
                        <ValueRow label='指數權重（參考）' value={weight === undefined ? dash : `${weight.toFixed(2)}%`} testId='sector-detail-weight' />
                    </GroupedSection>
                    <GroupedSection
                        header='資金流向（自開啟本頁起累計）'
                        footer={FLOW_FOOTER[status]}
                    >
                        <ValueRow label='近 5 分淨流入' value={flow ? <Toned value={flow.flow5} text={fmtSectorMoney(flow.flow5, true)} /> : dash} testId='sector-detail-flow5' />
                        <ValueRow label='近 5 分成交值' value={flow ? fmtSectorMoney(flow.turnover5) : dash} testId='sector-detail-turnover5' />
                        <ValueRow label='累計淨流入' value={flow ? <Toned value={flow.net} text={fmtSectorMoney(flow.net, true)} /> : dash} testId='sector-detail-net' />
                        <ValueRow label='累計量到的成交值' value={flow ? fmtSectorMoney(flow.turnover) : dash} testId='sector-detail-turnover' />
                        {flow ? <FlowSpark series={flow.series} /> : null}
                    </GroupedSection>
                    <p className={s.sheetNote}>
                        {dataTime ? `資料時間 ${dataTime}。` : ''}
                        {SECTOR_NO_MEMBERS_NOTE}
                    </p>
                </div>
            ) : null}
        </BottomSheet>
    );
}
