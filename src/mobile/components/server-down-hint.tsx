// src/mobile/components/server-down-hint.tsx — 「伺服器未連線」就地說明（狀態列連線狀態面板、帳戶 › 連線）
//
// 是否顯示由呼叫端以 lib/server-down-hint.ts 的 trackServerLost() 判斷（黏著：down 出現、重連中維持、live 消失）。
// 狀態列在常駐的 StatusBar 追蹤（面板關閉時不 render 子元件，不能放在面板內追蹤）。
// 純文字，不含任何操作或下單入口（S1）。

import { SERVER_DOWN_DETAIL, SERVER_DOWN_TEXT } from '../lib/server-down-hint';
import { InlineNote } from '../ui/inline-note';

export function ServerDownHint({ testId }: { testId: string }) {
    return (
        <InlineNote tone='warn' role='status' testId={testId}>
            <strong>{SERVER_DOWN_TEXT}</strong>
            <br />
            {SERVER_DOWN_DETAIL}
        </InlineNote>
    );
}
