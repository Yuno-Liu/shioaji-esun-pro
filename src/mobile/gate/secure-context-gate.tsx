// src/mobile/gate/secure-context-gate.tsx — 非 secure context 的「需要 HTTPS」說明頁（規格 R1、§3.1）
//
// 只顯示說明與診斷，不建立任何連線、不顯示交易畫面。
// 刻意不 import src/lib 的交易／串流模組：這一頁在任何情況下都不會發出 /api/、/esun/ 請求。

import { useMemo } from 'react';
import { isMobileSecure, readSecureContextDiagnostics, type SecureContextDiagnostics } from '../lib/secure-context';
import * as styles from '../styles/gate.css';
import { SELECTABLE } from '../styles/layout.css';

// 網址與診斷值要能長按選取、複製回報（全域 user-select: none 的例外，styles/layout.css.ts）
const valueClass = `${styles.value} ${SELECTABLE}`;
const codeClass = `${styles.code} ${SELECTABLE}`;

function Flag({ ok, yes = '可用', no = '不可用' }: { ok: boolean; yes?: string; no?: string }) {
    return <span className={ok ? styles.flag.ok : styles.flag.bad}>{ok ? yes : no}</span>;
}

/** 診斷清單（說明頁與帳戶頁共用） */
export function SecureContextDiagnosticsList({ diagnostics }: { diagnostics: SecureContextDiagnostics }) {
    const d = diagnostics;
    return (
        <dl className={styles.diag} data-testid='secure-context-diagnostics'>
            <dt className={styles.term}>isSecureContext</dt>
            <dd className={styles.value}><Flag ok={d.isSecureContext} yes='true' no='false' /></dd>
            <dt className={styles.term}>navigator.locks</dt>
            <dd className={styles.value}><Flag ok={d.webLocks} /></dd>
            <dt className={styles.term}>BroadcastChannel</dt>
            <dd className={styles.value}><Flag ok={d.broadcastChannel} /></dd>
            <dt className={styles.term}>來源</dt>
            <dd className={valueClass}>{d.origin || '—'}</dd>
            <dt className={styles.term}>User Agent</dt>
            <dd className={valueClass}>{d.userAgent || '—'}</dd>
            <dt className={styles.term}>建置版本</dt>
            <dd className={valueClass}>{d.buildVersion}</dd>
        </dl>
    );
}

export function SecureContextGate({ diagnostics }: { diagnostics?: SecureContextDiagnostics }) {
    const d = useMemo(() => diagnostics ?? readSecureContextDiagnostics(), [diagnostics]);
    const httpsButOld = d.isSecureContext && !isMobileSecure(d);
    return (
        <main className={styles.page} data-testid='secure-context-gate'>
            <h1 className={styles.title}>需要 HTTPS</h1>
            <section className={styles.section}>
                <p className={styles.text}>
                    手機交易頁只能經 <strong>HTTPS</strong> 開啟。目前的連線不是安全環境（secure context），
                    瀏覽器不提供 Web Locks，行情與委託回報串流無法連線，<strong>無法下單</strong>。
                    為了避免誤以為可以交易，這一頁不會建立任何連線，也不顯示交易畫面。
                </p>
                {httpsButOld && (
                    <p className={styles.text}>
                        目前已是安全環境，但瀏覽器缺少 Web Locks 或 BroadcastChannel。請將 iOS／iPadOS 更新到 15.4 以上，
                        或改用最新版 Safari／Chrome。
                    </p>
                )}
            </section>
            <section className={styles.section}>
                <h2 className={styles.heading}>怎麼改用 HTTPS</h2>
                <ul className={styles.list}>
                    <li>建議：主機與手機加入同一個 Tailscale tailnet，以 <span className={codeClass}>https://&lt;機器&gt;.&lt;tailnet&gt;.ts.net/mobile.html</span> 開啟。</li>
                    <li>或在主機上以 Caddy（<span className={codeClass}>tls internal</span>）提供 HTTPS，手機安裝並信任 Caddy 根憑證。</li>
                    <li>區網 HTTP（例如 <span className={codeClass}>http://192.168.x.x:8080</span>）只能開啟頁面，無法下單。</li>
                    <li>設定步驟請參考專案文件 <span className={codeClass}>docs/fork/mobile.md</span>。</li>
                </ul>
            </section>
            <section className={styles.section}>
                <h2 className={styles.heading}>診斷資訊</h2>
                <SecureContextDiagnosticsList diagnostics={d} />
            </section>
        </main>
    );
}
