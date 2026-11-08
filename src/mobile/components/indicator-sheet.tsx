// src/mobile/components/indicator-sheet.tsx — 技術指標面板（規格 Phase 3「更多指標」）
//
// - 由圖表工具列的「指標」鍵開啟的底部面板。分「主圖」「副圖」列出全部內建指標（中文名＋簡稱），可加入／移除；
//   達上限（主圖 4、副圖 2）時停用「加入」並說明原因。
// - 點已啟用的指標 → 編輯參數：數字輸入（inputmode）、−／＋ 依步進、夾在定義的範圍內、恢復預設、顏色。
// - 設定由 lib/mobile-indicators.ts 保存（localStorage），圖表即時套用。
// - 快速範本（當沖、波段、長線）：一鍵取代目前設定，不跳確認；之後就地顯示「已套用」＋［復原］（一步，還原套用前的設定）。
//   設定再被改動（加入、移除、改參數…）後復原失效、說明消失；復原後焦點回到該範本的套用鍵。
// - 走勢模式另有「走勢副圖」：分時買賣力、大單／小單買賣力的開關與大單門檻（lib/line-indicators.ts，另一個儲存鍵）。
//   開啟才下載當日逐筆；只有股票＋ETF 提供，其他商品停用並說明。
// - 外觀沿用設計規格的元件語彙（elevatedBg 鍵、中性島輸入框、InlineNote 說明）；只改樣式，不改行為與 testid。

import { useEffect, useId, useRef, useState } from 'react';
import { DEF_BY_TYPE, type IndicatorDef, type ParamDef } from '../../lib/indicator-defs';
import {
    MOBILE_INDICATOR_DEFS,
    INDICATOR_PALETTE,
    INDICATOR_TEMPLATES,
    categoryCount,
    categoryLimit,
    clampParam,
    getIndicatorSettings,
    indicatorLabel,
    indicatorName,
    limitReason,
    paletteColor,
    templateSummary,
    useMobileIndicators,
    usesPaletteColor,
    type IndicatorCategory,
    type IndicatorTemplate,
    type MobileIndicator,
    type MobileIndicatorSettings,
} from '../lib/mobile-indicators';
import * as styles from '../styles/chart.css';
import {
    LINE_FLOW_THRESHOLDS,
    setLineIndicatorSettings,
    thresholdLabel,
    useLineIndicatorSettings,
} from '../lib/line-indicators';
import { InlineNote } from '../ui/inline-note';
import { Segmented } from '../ui/segmented';
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
    /** 走勢副圖（買賣力）是否支援目前商品（股票＋ETF） */
    lineFlowSupported?: boolean;
}

/** 小數步進的參數用 decimal 鍵盤，整數用 numeric 鍵盤 */
function inputModeFor(p: ParamDef): 'decimal' | 'numeric' {
    const step = p.step ?? 1;
    return Number.isInteger(step) && Number.isInteger(p.min) ? 'numeric' : 'decimal';
}

function itemColor(item: MobileIndicator, def: IndicatorDef): string {
    return usesPaletteColor(def) ? paletteColor(item.color) : def.outputs[0]?.color ?? paletteColor(item.color);
}

export function IndicatorSheet({ open, onClose, lineMode = false, lineFlowSupported = false }: IndicatorSheetProps) {
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
                : <IndicatorList lineMode={lineMode} lineFlowSupported={lineFlowSupported} onEdit={setEditing} />}
        </BottomSheet>
    );
}

const THRESHOLD_ITEMS = LINE_FLOW_THRESHOLDS.map(v => ({ value: v, label: thresholdLabel(v), ariaLabel: `大單門檻 ${thresholdLabel(v)}元`, testId: `line-flow-threshold-${v}` }));

/** 走勢副圖：分時買賣力、大單／小單買賣力（只開關圖表顯示，不涉及下單） */
function LineFlowSection({ supported }: { supported: boolean }) {
    const ls = useLineIndicatorSettings();
    const noteId = useId();
    const toggle = (key: 'flow' | 'bigSmall', label: string, desc: string) => (
        <div className={styles.defRow}>
            <span className={styles.defText}>
                <span className={styles.defName}>{label}</span>
                <span className={styles.defDesc}>{desc}</span>
            </span>
            <button
                type='button'
                className={styles.smallButton}
                aria-pressed={supported && ls[key]}
                aria-label={label}
                aria-describedby={supported ? undefined : noteId}
                disabled={!supported}
                onClick={() => setLineIndicatorSettings({ [key]: !ls[key] })}
                data-testid={`line-flow-${key}`}
            >
                {supported && ls[key] ? '顯示中' : '已隱藏'}
            </button>
        </div>
    );
    return (
        <section className={styles.section} aria-label='走勢副圖' data-testid='indicator-section-line'>
            <h3 className={styles.sectionHead}><span>走勢副圖</span></h3>
            {supported
                ? <p className={styles.emptyActive}>開啟時下載當日全部逐筆（大型股可能數 MB），之後以即時成交累加。單位：張。</p>
                : <p id={noteId} className={styles.limitNote} role='note' data-testid='line-flow-unsupported'>只提供股票與 ETF；指數、期貨、選擇權、權證沒有。</p>}
            {toggle('flow', '分時買賣力', '每分鐘外盤（主動買）／內盤（主動賣）量與累積淨買力')}
            {toggle('bigSmall', '大單／小單買賣力', '依單筆成交金額分大單、小單的累積淨買；為估算，非實際投資人身分')}
            {supported && ls.bigSmall && (
                <div className={styles.paramRow}>
                    <span className={styles.paramLabel}>大單門檻（單筆成交金額 ≥）</span>
                    <Segmented
                        items={THRESHOLD_ITEMS}
                        value={ls.threshold}
                        onChange={v => setLineIndicatorSettings({ threshold: v })}
                        semantics='toggle'
                        ariaLabel='大單門檻'
                        size='compact'
                        variant='scroll'
                        testId='line-flow-threshold'
                    />
                </div>
            )}
        </section>
    );
}

/** 套用範本後的復原資訊：applied 仍是目前設定（同一物件）時才能復原 */
interface TemplateUndo {
    template: IndicatorTemplate;
    prev: MobileIndicatorSettings;
    applied: MobileIndicatorSettings;
}

function TemplateSection() {
    const ind = useMobileIndicators();
    const [undo, setUndo] = useState<TemplateUndo | null>(null);
    const buttons = useRef(new Map<string, HTMLButtonElement>());
    const canUndo = undo !== null && undo.applied === ind.settings;
    const apply = (t: IndicatorTemplate) => {
        const prev = ind.applyTemplate(t);
        // applyTemplate 已同步寫入 store：此時的 getter 就是套用後的設定
        setUndo({ template: t, prev, applied: getIndicatorSettings() });
    };
    const revert = () => {
        if (!undo) return;
        ind.replace(undo.prev);
        setUndo(null);
        buttons.current.get(undo.template.id)?.focus();
    };
    return (
        <section className={styles.section} aria-label='快速範本' data-testid='indicator-templates'>
            <h3 className={styles.sectionHead}>
                <span>快速範本</span>
                <span className={styles.sectionCount}>取代目前設定</span>
            </h3>
            {canUndo && (
                <div className={styles.sheetNote}>
                    <InlineNote
                        tone='info'
                        role='status'
                        testId='indicator-template-applied'
                        action={{ label: '復原', onClick: revert, testId: 'indicator-template-undo' }}
                    >
                        已套用「{undo.template.label}」範本，原本的設定已取代。
                    </InlineNote>
                </div>
            )}
            {INDICATOR_TEMPLATES.map(t => {
                const summary = `${templateSummary(t)}＋成交量`;
                return (
                    <div key={t.id} className={styles.defRow}>
                        <span className={styles.defText}>
                            <span className={styles.defName}>{t.label}</span>
                            <span className={styles.defDesc}>{summary}</span>
                        </span>
                        <button
                            ref={el => { if (el) buttons.current.set(t.id, el); else buttons.current.delete(t.id); }}
                            type='button'
                            className={styles.smallButton}
                            aria-label={`套用「${t.label}」範本：${summary}（取代目前設定）`}
                            onClick={() => apply(t)}
                            data-testid={`indicator-template-${t.id}`}
                        >
                            套用
                        </button>
                    </div>
                );
            })}
        </section>
    );
}

function IndicatorList({ lineMode, lineFlowSupported, onEdit }: { lineMode: boolean; lineFlowSupported: boolean; onEdit: (id: string) => void }) {
    const ind = useMobileIndicators();
    const s = ind.settings;
    const baseId = useId();
    return (
        <div data-testid='indicator-list'>
            {lineMode && (
                <div className={styles.sheetNote}>
                    <InlineNote tone='info'>走勢圖顯示均價線、當日最高最低、成交量與下方的走勢副圖；其餘指標套用在 K 線（1 分以上）。</InlineNote>
                </div>
            )}
            {lineMode && <LineFlowSection supported={lineFlowSupported} />}
            <TemplateSection />
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
