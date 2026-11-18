import { html, useState, useRef, useMemo, cx, bytes, htmlToText, fileToBase64 } from './util.mjs';
import { S, api, set, toast, accountOf } from './store.mjs';
import { parseAddressList, formatAddressList, formatAddress } from '../core/address.mjs';
import { baseSubject } from '../core/classify.mjs';

const MAX_BYTES = 24 * 1024 * 1024;

export function newDraft(patch = {}) {
  const acct = [...S.acctSel][0] || S.accounts[0]?.email;
  set({ compose: { acct, to: '', cc: '', bcc: '', subject: '', text: '', attachments: [], title: 'New message', ...patch } });
}

const quote = (text) => text.split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n');

/** Open the composer as a reply / reply-all / forward of message m. */
export async function startReply(m, mode) {
  let full;
  try {
    full = await api.getMessage(m.acct, m.id);
  } catch (e) {
    toast(`Could not load the message: ${e.message}`);
    return;
  }
  const h = full.headers;
  const mine = new Set(S.accounts.map((a) => a.email));
  const from = parseAddressList(h.from);
  const replyTo = parseAddressList(h.replyTo);
  const to = parseAddressList(h.to);
  const cc = parseAddressList(h.cc);
  const body = full.text || htmlToText(full.html || '');
  const when = new Date(full.ts || m.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const subject = baseSubject(h.subject || m.subject);
  const notMe = (a) => !mine.has(a.addr);
  const uniq = (list) => list.filter((a, i) => list.findIndex((b) => b.addr === a.addr) === i);

  if (mode === 'forward') {
    newDraft({
      acct: m.acct,
      title: 'Forward',
      subject: `Fwd: ${subject}`,
      text: `\n\n---------- Forwarded message ---------\nFrom: ${h.from}\nDate: ${when}\nSubject: ${h.subject}\nTo: ${h.to}${h.cc ? `\nCc: ${h.cc}` : ''}\n\n${body}`,
      attachments: full.attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: a.size, fwd: { msgId: m.id, index: a.index } })),
    });
    return;
  }
  // Replying to my own message continues the conversation with its recipients.
  const primary = m.kind === 'me' ? to : (replyTo.length ? replyTo : from);
  const draft = {
    acct: m.acct,
    title: mode === 'replyAll' ? 'Reply all' : 'Reply',
    subject: `Re: ${subject}`,
    to: formatAddressList(uniq(primary)),
    threadId: m.threadId,
    inReplyTo: h.messageId,
    references: [h.references, h.messageId].filter(Boolean).join(' '),
    text: `\n\nOn ${when}, ${from[0] ? formatAddress(from[0]) : h.from} wrote:\n${quote(body)}`,
    caretStart: true,
  };
  if (mode === 'replyAll') {
    const primarySet = new Set(primary.map((a) => a.addr));
    const others = uniq([...(m.kind === 'me' ? [] : to), ...cc]).filter((a) => notMe(a) && !primarySet.has(a.addr));
    draft.cc = formatAddressList(others);
    draft.showCc = others.length > 0;
  }
  newDraft(draft);
}

function contacts() {
  const out = new Map();
  if (S.model) {
    for (const s of S.model.senders.values()) {
      if (s.kind === 'channel') continue;
      out.set(s.addr, { name: s.name, addr: s.addr, rank: (s.kind === 'important' ? 1e12 : 0) + s.lastTs });
    }
  }
  for (const m of S.messages.values()) {
    if (m.kind !== 'me') continue;
    for (const a of m.to) if (!out.has(a)) out.set(a, { name: '', addr: a, rank: 1e12 + m.ts });
  }
  return [...out.values()].sort((a, b) => b.rank - a.rank);
}

function AddressField({ label, value, onChange, autofocus, children }) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const all = useMemo(contacts, [S.model]);
  const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';')) + 1;
  const term = value.slice(cut).trim().toLowerCase();
  const matches = open && term.length >= 1
    ? all.filter((c) => c.addr.includes(term) || c.name.toLowerCase().includes(term)).slice(0, 7)
    : [];
  const choose = (c) => {
    onChange(`${value.slice(0, cut)}${cut ? ' ' : ''}${formatAddress(c)}, `);
    setOpen(false);
  };
  const onKey = (e) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((idx + 1) % matches.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((idx - 1 + matches.length) % matches.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[Math.min(idx, matches.length - 1)]); }
    else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  };
  return html`
    <div class="field">
      <label>${label}</label>
      <input value=${value} spellcheck=${false} aria-label=${label}
        ref=${(el) => { if (el && autofocus && !el.dataset.f) { el.dataset.f = 1; el.focus(); } }}
        onInput=${(e) => { onChange(e.target.value); setOpen(true); setIdx(0); }}
        onKeyDown=${onKey} onBlur=${() => setTimeout(() => setOpen(false), 150)} />
      ${children}
      ${matches.length > 0 && html`
        <div class="suggest">
          ${matches.map((c, i) => html`
            <div class=${cx(i === idx && 'on')} onMouseDown=${(e) => { e.preventDefault(); choose(c); }}>
              <b>${c.name || c.addr}</b>${c.name && html`<small>${c.addr}</small>`}
            </div>`)}
        </div>`}
    </div>`;
}

function validate(d) {
  const all = [d.to, d.cc, d.bcc].join(',');
  if (!parseAddressList(all).length) return 'Add at least one recipient.';
  const bad = all.split(/[,;]/).map((s) => s.trim()).find((p) => p && !p.includes('@') && !all.includes('"'));
  return bad ? `"${bad}" is not a valid address.` : null;
}

export function sendDraft(d) {
  const problem = validate(d);
  if (problem) { toast(problem); return; }
  if (!d.subject.trim() && !window.confirm('Send without a subject?')) return;
  set({ compose: null });
  let cancelled = false;
  toast('Sending…', { action: 'Undo', ms: 5000, onAction: () => { cancelled = true; set({ compose: d, toast: null }); } });
  setTimeout(async () => {
    if (cancelled) return;
    try {
      const { title, showCc, caretStart, ...payload } = d;
      await api.send(payload);
      toast('Sent');
    } catch (e) {
      set({ compose: d });
      toast(`Could not send: ${e.message}`, { ms: 9000 });
    }
  }, 5000);
}

export function Compose() {
  const d = S.compose;
  const fileRef = useRef();
  const [over, setOver] = useState(false);
  const [showCc, setShowCc] = useState(!!(d.showCc || d.cc || d.bcc));
  const patch = (p) => set({ compose: { ...S.compose, ...p } });
  const total = d.attachments.reduce((n, a) => n + (a.size || 0), 0);

  const addFiles = async (files) => {
    const added = [];
    for (const f of files) {
      added.push({ filename: f.name, mime: f.type || 'application/octet-stream', size: f.size, dataB64: await fileToBase64(f) });
    }
    patch({ attachments: [...S.compose.attachments, ...added] });
  };
  const discard = () => {
    const dirty = d.text.trim() || d.attachments.length || d.to.trim();
    if (!dirty || window.confirm('Discard this draft?')) set({ compose: null });
  };
  const onKey = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendDraft(S.compose); }
    else if (e.key === 'Escape') { e.stopPropagation(); discard(); }
  };

  return html`
    <div class=${cx('compose', over && 'dragover')} role="dialog" aria-label="Compose" onKeyDown=${onKey}
      onDragOver=${(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); addFiles([...e.dataTransfer.files]); }}>
      <div class="compose-h"><span>${d.title}</span><button class="btn ghost small" onClick=${discard} title="Discard (Esc)">✕</button></div>
      ${S.accounts.length > 1 && html`
        <div class="field">
          <label>From</label>
          <select value=${d.acct} onChange=${(e) => patch({ acct: e.target.value })} disabled=${!!d.threadId} aria-label="From">
            ${S.accounts.map((a) => html`<option value=${a.email}>${a.label} — ${a.email}</option>`)}
          </select>
        </div>`}
      <${AddressField} label="To" value=${d.to} onChange=${(v) => patch({ to: v })} autofocus=${!d.to}>
        ${!showCc && html`<button class="toggle" onClick=${() => setShowCc(true)}>Cc Bcc</button>`}
      <//>
      ${showCc && html`
        <${AddressField} label="Cc" value=${d.cc} onChange=${(v) => patch({ cc: v })} />
        <${AddressField} label="Bcc" value=${d.bcc} onChange=${(v) => patch({ bcc: v })} />`}
      <div class="field">
        <label>Subject</label>
        <input value=${d.subject} onInput=${(e) => patch({ subject: e.target.value })} aria-label="Subject" />
      </div>
      <textarea value=${d.text} aria-label="Message" placeholder="Write your message…"
        ref=${(el) => {
          if (!el || el.dataset.f) return;
          el.dataset.f = 1;
          if (d.to) { el.focus(); if (d.caretStart) el.setSelectionRange(0, 0); el.scrollTop = 0; }
        }}
        onInput=${(e) => patch({ text: e.target.value })}></textarea>
      ${d.attachments.length > 0 && html`
        <div class="atts">
          ${d.attachments.map((a, i) => html`
            <span class="att">${a.filename} <small>${bytes(a.size || 0)}</small>
              <button title="Remove" onClick=${() => patch({ attachments: d.attachments.filter((_, j) => j !== i) })}>✕</button>
            </span>`)}
        </div>`}
      <div class="compose-f">
        <button class="btn primary" onClick=${() => sendDraft(S.compose)} disabled=${total > MAX_BYTES} title="Send (Ctrl/⌘ + Enter)">Send</button>
        <button class="btn" onClick=${() => fileRef.current.click()}>Attach files</button>
        <input type="file" multiple hidden ref=${fileRef} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        ${total > 0 && html`<span class=${cx('size', total > MAX_BYTES && 'err-text')}>${bytes(total)}${total > MAX_BYTES ? ' — over Gmail’s 25 MB limit' : ''}</span>`}
        <span class="sp"></span>
        <span class="size">${accountOf(d.acct).label}</span>
        <button class="btn ghost" onClick=${discard}>Discard</button>
      </div>
    </div>`;
}
