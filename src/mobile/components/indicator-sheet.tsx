// src/mobile/components/indicator-sheet.tsx — 技術指標面板（規格 Phase 3「更多指標」）
//
// - 由圖表工具列的「指標」鍵開啟的底部面板。分「主圖」「副圖」列出全部內建指標（中文名＋簡稱），可加入／移除；
//   達上限（主圖 4、副圖 2）時停用「加入」並說明原因。
// - 點已啟用的指標 → 編輯參數：數字輸入（inputmode）、−／＋ 依步進、夾在定義的範圍內、恢復預設、顏色。
// - 設定由 lib/mobile-indicators.ts 保存（localStorage），圖表即時套用。

import { useEffect, useId, useState } from 'react';
import { DEF_BY_TYPE, type IndicatorDef, type ParamDef } from '../../lib/indicator-defs';
import {
    MOBILE_INDICATOR_DEFS,
    INDICATOR_PALETTE,
    categoryCount,
    categoryLimit,
    clampParam,
    indicatorLabel,
    indicatorName,
    limitReason,
    paletteColor,
    useMobileIndicators,
    usesPaletteColor,
    type IndicatorCategory,
    type MobileIndicator,
} from '../lib/mobile-indicators';
import * as styles from '../styles/chart.css';
import { BottomSheet } from './bottom-sheet';

const SECTIONS: { category: IndicatorCategory; title: string }[] = [
    { category: 'overlay', title: '主圖疊加' },
    { category: 'pane', title: '副圖' },
];

export interface IndicatorSheetProps {
    open: boolean;
    onClose: () => void;
    /** 目前是走勢模式（指標只套用在 K 線） */
    lineMode?: boolean;
}

/** 小數步進的參數用 decimal 鍵盤，整數用 numeric 鍵盤 */
function inputModeFor(p: ParamDef): 'decimal' | 'numeric' {
    const step = p.step ?? 1;
    return Number.isInteger(step) && Number.isInteger(p.min) ? 'numeric' : 'decimal';
}

function itemColor(item: MobileIndicator, def: IndicatorDef): string {
    return usesPaletteColor(def) ? paletteColor(item.color) : def.outputs[0]?.color ?? paletteColor(item.color);
}

export function IndicatorSheet({ open, onClose, lineMode = false }: IndicatorSheetProps) {
    const ind = useMobileIndicators();
    const [editing, setEditing] = useState<string | null>(null);
    const item = editing ? ind.settings.items.find(i => i.id === editing) : undefined;

    // 被移除（或恢復預設）後回到清單；關閉面板時也回到清單
    useEffect(() => { if (editing && !item) setEditing(null); }, [editing, item]);
    useEffect(() => { if (!open) setEditing(null); }, [open]);

    return (
        <BottomSheet open={open} onClose={onClose} title={item ? '指標參數' : '技術指標'} testId='indicator-sheet'>
            {item
                ? <IndicatorEditor item={item} onDone={() => setEditing(null)} />
                : <IndicatorList lineMode={lineMode} onEdit={setEditing} />}
        </BottomSheet>
    );
}

function IndicatorList({ lineMode, onEdit }: { lineMode: boolean; onEdit: (id: string) => void }) {
    const ind = useMobileIndicators();
    const s = ind.settings;
    const baseId = useId();
    return (
        <div data-testid='indicator-list'>
            {lineMode && (
                <p className={styles.sheetNote}>走勢圖只顯示均價線、當日最高最低與成交量；以下指標套用在 K 線（1 分以上）。</p>
            )}
            <div className={styles.toggleRow}>
                <span>成交量（K 線）</span>
                <button
                    type='button'
                    className={styles.smallButton}
                    aria-pressed={s.volume}
                    onClick={() => ind.setVolume(!s.volume)}
                    data-testid='indicator-volume'
                >
                    {s.volume ? '顯示中' : '已隱藏'}
                </button>
            </div>
            {SECTIONS.map(({ category, title }) => {
                const active = s.items.filter(i => DEF_BY_TYPE.get(i.type)?.category === category);
                const reason = limitReason(s, category);
                const reasonId = `${baseId}-${category}-limit`;
                return (
                    <section key={category} className={styles.section} aria-label={title} data-testid={`indicator-section-${category}`}>
                        <h3 className={styles.sectionHead}>
                            <span>{title}</span>
                            <span className={styles.sectionCount}>已加入 {categoryCount(s, category)}／{categoryLimit(category)}</span>
                        </h3>
                        {active.length === 0
                            ? <p className={styles.emptyActive}>尚未加入</p>
                            : active.map(it => {
                                const def = DEF_BY_TYPE.get(it.type)!;
                                const label = indicatorLabel(it);
                                return (
                                    <div key={it.id} className={styles.defRow} data-testid='indicator-active'>
                                        <button
                                            type='button'
                                            className={styles.activeChip}
                                            onClick={() => onEdit(it.id)}
                                            aria-label={`編輯 ${label} 參數`}
                                            data-testid={`indicator-edit-${it.id}`}
                                        >
                                            <span className={styles.swatchDot} style={{ background: itemColor(it, def) }} aria-hidden='true' />
                                            {label}
                                        </button>
                                        <span className={styles.defText}><span className={styles.defDesc}>{indicatorName(def)}</span></span>
                                        <button
                                            type='button'
                                            className={styles.dangerButton}
                                            onClick={() => ind.remove(it.id)}
                                            aria-label={`移除 ${label}`}
                                            data-testid={`indicator-remove-${it.id}`}
                                        >
                                            移除
                                        </button>
                                    </div>
                                );
                            })}
                        {reason && <p id={reasonId} className={styles.limitNote} role='note' data-testid={`indicator-limit-${category}`}>{reason}</p>}
                        {MOBILE_INDICATOR_DEFS.filter(d => d.category === category).map(def => (
                            <div key={def.type} className={styles.defRow}>
                                <span className={styles.defText}>
                                    <span className={styles.defName}>
                                        {indicatorName(def)}
                                        <span className={styles.defShort}>{def.short}</span>
                                    </span>
                                    <span className={styles.defDesc}>{def.desc}</span>
                                </span>
                                <button
                                    type='button'
                                    className={styles.smallButton}
                                    disabled={!!reason}
                                    aria-describedby={reason ? reasonId : undefined}
                                    aria-label={`加入 ${indicatorName(def)} ${def.short}`}
                                    onClick={() => ind.add(def.type)}
                                    data-testid={`indicator-add-${def.type}`}
                                >
                                    加入
                                </button>
                            </div>
                        ))}
                    </section>
                );
            })}
            <div className={styles.footer}>
                <button type='button' className={styles.smallButton} onClick={() => ind.resetAll()} data-testid='indicator-reset-all'>
                    恢復預設（MA5、MA20、成交量）
                </button>
            </div>
        </div>
    );
}

function IndicatorEditor({ item, onDone }: { item: MobileIndicator; onDone: () => void }) {
    const ind = useMobileIndicators();
    const def = DEF_BY_TYPE.get(item.type)!;
    const baseId = useId();
    const paramsKey = JSON.stringify(item.params);
    const [drafts, setDrafts] = useState<Record<string, string>>(() => toDrafts(def, item));
    // 參數由外部改變（恢復預設、步進）時同步輸入框
    useEffect(() => { setDrafts(toDrafts(def, item)); }, [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const commit = (p: ParamDef, raw: string): number => {
        const n = raw.trim() === '' ? NaN : Number(raw.trim());
        const value = Number.isFinite(n) ? clampParam(p, n) : item.params[p.key] ?? p.def;
        setDrafts(d => ({ ...d, [p.key]: String(value) }));
        if (value !== item.params[p.key]) ind.updateParams(item.id, { [p.key]: value });
        return value;
    };
    const stepBy = (p: ParamDef, dir: 1 | -1) => {
        const cur = item.params[p.key] ?? p.def;
        const value = clampParam(p, cur + dir * (p.step ?? 1));
        setDrafts(d => ({ ...d, [p.key]: String(value) }));
        if (value !== cur) ind.updateParams(item.id, { [p.key]: value });
    };
    const done = () => {
        for (const p of def.params) commit(p, drafts[p.key] ?? '');
        onDone();
    };

    return (
        <div data-testid='indicator-editor'>
            <p className={styles.editHead}>{indicatorName(def)}　{indicatorLabel(item)}</p>
            {def.params.length === 0 && <p className={styles.emptyActive}>這個指標沒有可調整的參數。</p>}
            {def.params.map(p => {
                const id = `${baseId}-${p.key}`;
                const cur = item.params[p.key] ?? p.def;
                return (
                    <div key={p.key} className={styles.paramRow}>
                        <label htmlFor={id} className={styles.paramLabel}>{p.label}</label>
                        <div className={styles.paramControls}>
                            <button
                                type='button'
                                className={styles.stepButton}
                                disabled={cur <= p.min}
                                onClick={() => stepBy(p, -1)}
                                aria-label={`${p.label} 減少`}
                                data-testid={`param-dec-${p.key}`}
                            >
                                −
                            </button>
                            <input
                                id={id}
                                className={styles.paramInput}
                                type='text'
                                inputMode={inputModeFor(p)}
                                enterKeyHint='done'
                                autoComplete='off'
                                value={drafts[p.key] ?? ''}
                                onChange={e => { const v = e.target.value; setDrafts(d => ({ ...d, [p.key]: v })); }}
                                onBlur={e => commit(p, e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') commit(p, (e.target as HTMLInputElement).value); }}
                                aria-describedby={`${id}-hint`}
                                data-testid={`param-input-${p.key}`}
                            />
                            <button
                                type='button'
                                className={styles.stepButton}
                                disabled={cur >= p.max}
                                onClick={() => stepBy(p, 1)}
                                aria-label={`${p.label} 增加`}
                                data-testid={`param-inc-${p.key}`}
                            >
                                ＋
                            </button>
                        </div>
                        <span id={`${id}-hint`} className={styles.paramHint}>
                            範圍 {p.min}–{p.max}{p.step ? `，每次 ${p.step}` : '（整數）'}；預設 {p.def}
                        </span>
                    </div>
                );
            })}
            {usesPaletteColor(def) && (
                <div role='group' aria-label='線條顏色' className={styles.swatchRow}>
                    {INDICATOR_PALETTE.map((c, i) => (
                        <button
                            key={c}
                            type='button'
                            className={styles.swatchButton}
                            style={{ background: c }}
                            aria-pressed={item.color === i}
                            aria-label={`顏色 ${i + 1}${item.color === i ? '（已選）' : ''}`}
                            onClick={() => ind.setColor(item.id, i)}
                            data-testid={`indicator-color-${i}`}
                        >
                            {item.color === i ? '已選' : ''}
                        </button>
                    ))}
                </div>
            )}
            <div className={styles.footer}>
                <button type='button' className={styles.dangerButton} onClick={() => ind.remove(item.id)} data-testid='indicator-editor-remove'>移除</button>
                {def.params.length > 0 && (
                    <button type='button' className={styles.smallButton} onClick={() => ind.resetParams(item.id)} data-testid='indicator-reset-params'>恢復預設</button>
                )}
                <button type='button' className={styles.smallButton} onClick={done} data-testid='indicator-editor-done'>完成</button>
            </div>
        </div>
    );
}

function toDrafts(def: IndicatorDef, item: MobileIndicator): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of def.params) out[p.key] = String(item.params[p.key] ?? p.def);
    return out;
}
