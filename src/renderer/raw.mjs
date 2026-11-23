// Raw view: every synced message, newest first, nothing grouped, hidden or filtered.

import { html, useState, useMemo, cx } from './util.mjs';
import { S, openMessage, accountOf } from './store.mjs';

const PAGE = 100;
const stamp = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function Raw() {
  const [page, setPage] = useState(0);
  const all = useMemo(() => [...S.messages.values()].sort((a, b) => b.ts - a.ts), [S.model]);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(page, pages - 1);
  const rows = all.slice(p * PAGE, p * PAGE + PAGE);
  const go = (n) => { setPage(Math.max(0, Math.min(pages - 1, n))); document.querySelector('.raw-list')?.scrollTo(0, 0); };
  const pager = html`
    <div class="pager" role="navigation" aria-label="Pages">
      <button class="btn small" disabled=${p === 0} onClick=${() => go(0)}>Newest</button>
      <button class="btn small" disabled=${p === 0} onClick=${() => go(p - 1)}>← Newer</button>
      <span>Page ${p + 1} of ${pages.toLocaleString()}</span>
      <button class="btn small" disabled=${p >= pages - 1} onClick=${() => go(p + 1)}>Older →</button>
      <button class="btn small" disabled=${p >= pages - 1} onClick=${() => go(pages - 1)}>Oldest</button>
    </div>`;
  return html`
    <div class="raw">
      <div class="raw-h">
        <h2>Raw</h2>
        <span class="hint">${all.length.toLocaleString()} messages, every account, sent and received, newest first. Sidebar filters do not apply here.</span>
        ${pager}
      </div>
      <div class="raw-list" role="table" aria-label="All messages">
        ${rows.map((m) => html`
          <div class=${cx('raw-row', S.open?.key === m.key && 'sel')} role="row" key=${m.key} onClick=${() => openMessage(m, { exact: true })}>
            <span class="t">${stamp(m.ts)}</span>
            <span class="a" title=${m.acct}><i class="dot" style=${{ background: accountOf(m.acct).color }}></i></span>
            <span class="d">${m.kind === 'me' ? '→' : '←'}</span>
            <span class="f" title=${m.kind === 'me' ? m.to.join(', ') : m.from.addr}>${m.kind === 'me' ? m.to[0] || '(no recipient)' : m.from.addr}</span>
            <span class="s">${m.subject || '(no subject)'}</span>
          </div>`)}
        ${all.length === 0 && html`<div class="empty">No messages synced yet.</div>`}
      </div>
    </div>`;
}
