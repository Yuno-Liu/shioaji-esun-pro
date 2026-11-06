// src/mobile/components/watch-list-sheet.tsx — 自選清單名稱面板：新增清單、重新命名目前清單（設計規格 §7.2）
//
// - 名稱先去頭尾空白；空白、與其他清單同名都不送出（重新命名時不和自己比）。
// - 送出由父層處理：新增＝useMobileWatchlist().createList（失敗丟錯）；重新命名＝renameCurrentList
//   （回傳 false＝被拒或失敗，面板保持開啟、顯示原因；注意改名會換清單 id）。成功才關閉面板。
// - 只做清單管理，不會下單。

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { button } from '../styles/controls.css';
import * as styles from '../styles/watchlist.css';
import { InlineNote } from '../ui/inline-note';
import { BottomSheet } from './bottom-sheet';

/** 清單名稱長度上限（字元） */
export const LIST_NAME_MAX = 20;

export type ListNameCheck = { ok: true; name: string } | { ok: false; error: string };

/** 檢查清單名稱：去頭尾空白後不可空白、不可與其他清單同名（current＝重新命名時目前的名稱，不算重複） */
export function checkListName(raw: string, names: readonly string[], current?: string): ListNameCheck {
    const name = raw.trim();
    if (!name) return { ok: false, error: '請輸入清單名稱' };
    if (name !== current && names.includes(name)) return { ok: false, error: `已有名為「${name}」的清單` };
    return { ok: true, name };
}

export interface WatchListSheetProps {
    /** null：關閉 */
    mode: 'create' | 'rename' | null;
    /** 目前清單名稱（重新命名的初始值） */
    currentName: string;
    /** 所有清單名稱（重複檢查） */
    names: readonly string[];
    /** 清單結構更新中：停用送出 */
    busy: boolean;
    onCreate: (name: string) => Promise<void>;
    onRename: (name: string) => Promise<boolean>;
    onClose: () => void;
}

export function WatchListSheet({ mode, currentName, names, busy, onCreate, onRename, onClose }: WatchListSheetProps) {
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const [shownMode, setShownMode] = useState<'create' | 'rename'>('create');

    // 每次開啟重設內容（關閉動畫期間保留上一次的標題）
    useEffect(() => {
        if (!mode) return;
        setShownMode(mode);
        setValue(mode === 'rename' ? currentName : '');
        setError(null);
        setSaving(false);
        // currentName 只在開啟當下取用
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const rename = shownMode === 'rename';
    const submit = async (e?: FormEvent) => {
        e?.preventDefault();
        if (saving || busy || !mode) return;
        const check = checkListName(value, names, rename ? currentName : undefined);
        if (!check.ok) {
            setError(check.error);
            return;
        }
        if (rename && check.name === currentName) {
            onClose();
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const ok = rename ? await onRename(check.name) : (await onCreate(check.name), true);
            if (!mounted.current) return;
            if (ok) {
                onClose();
            } else {
                setError('重新命名失敗，請稍後再試');
            }
        } catch (err) {
            if (mounted.current) setError(`${rename ? '重新命名' : '新增清單'}失敗：${err instanceof Error && err.message ? err.message : '請稍後再試'}`);
        } finally {
            if (mounted.current) setSaving(false);
        }
    };

    const label = rename ? '清單名稱' : '新清單名稱';
    return (
        <BottomSheet open={mode !== null} onClose={onClose} title={rename ? '重新命名清單' : '新增自選清單'} testId='watch-list-sheet'>
            <form className={styles.listForm} onSubmit={e => void submit(e)} noValidate>
                <input
                    className={styles.searchInput}
                    type='text'
                    enterKeyHint='done'
                    autoComplete='off'
                    autoCorrect='off'
                    spellCheck={false}
                    placeholder='例如：半導體、觀察中'
                    aria-label={label}
                    aria-invalid={error ? true : undefined}
                    value={value}
                    maxLength={LIST_NAME_MAX}
                    onChange={e => {
                        setValue(e.target.value);
                        if (error) setError(null);
                    }}
                    data-testid='watch-list-name-input'
                />
                {error && <InlineNote tone='danger' role='alert' testId='watch-list-name-error'>{error}</InlineNote>}
                <p className={styles.listFormNote}>自選清單與桌面共用。</p>
                <button
                    type='submit'
                    className={button.primary}
                    disabled={saving || busy}
                    data-testid='watch-list-name-submit'
                >
                    {saving ? (rename ? '儲存中…' : '建立中…') : rename ? '儲存' : '建立'}
                </button>
            </form>
        </BottomSheet>
    );
}
