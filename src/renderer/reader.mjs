import { html, useState, useEffect, useMemo, useRef, cx, ago, fullDate, bytes, displayName, sanitizeEmailHtml, textToHtml } from './util.mjs';
import { S, api, closeReader, markDone, ack, bump, toggleFlag, setSenderKind, toggleQuiet, toast, accountOf, set } from './store.mjs';
import { startReply, newDraft } from './compose.mjs';
import { openLink } from './webpane.mjs';
import { baseSubject } from '../core/classify.mjs';
import { Avatar } from './avatar.mjs';

const bodyCache = new Map();
function loadBody(m) {
  if (!bodyCache.has(m.key)) {
    const p = api.getMessage(m.acct, m.id);
    p.catch(() => bodyCache.delete(m.key));
    bodyCache.set(m.key, p);
    if (bodyCache.size > 80) bodyCache.delete(bodyCache.keys().next().value);
  }
  return bodyCache.get(m.key);
}

const FRAME_CSS = 'html,body{margin:0;padding:0}body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 6px;padding-left:12px;border-left:2px solid #ddd;color:#555}';

// Plain-text mail follows the app's dark theme; HTML mail keeps the white page it was designed for.
const PLAIN_CSS = 'html{color-scheme:dark}body{color:#e9e7e1;background:#1e2024}a{color:#7fd1b6}blockquote{border-color:#3a3d43;color:#b9b6ad}';

function EmailBody({ full }) {
  const [images, setImages] = useState(S.user.settings.loadImages);
  const frame = useRef();
  const clean = useMemo(() => (full.html ? sanitizeEmailHtml(full.html) : { html: textToHtml(full.text || ''), remoteImages: false }), [full]);
  const srcdoc = useMemo(() => {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${images ? 'https: http:' : ''}; font-src data:`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${FRAME_CSS}${full.html ? '' : PLAIN_CSS}</style></head><body>${clean.html}</body></html>`;
  }, [clean, images]);

  const onLoad = () => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!doc?.body) return;
    const fit = () => { el.style.height = `${Math.max(40, doc.documentElement.scrollHeight)}px`; };
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      // Web links open in the pane beside the reader (Cmd/Ctrl-click: system browser); mailto starts a draft.
      if (openLink(a.href, e)) return;
      if (/^mailto:/i.test(a.href)) newDraft({ to: decodeURIComponent(a.href.slice(7).split('?')[0]) });
    });
  };

  return html`
    ${clean.remoteImages && !images && html`
      <div class="img-note">Remote images are hidden to block tracking.
        <button class="btn small" onClick=${() => setImages(true)}>Show images</button>
      </div>`}
    <div class=${full.html ? 'paper' : 'paper plain'}>
      <iframe ref=${frame} sandbox="allow-same-origin" srcdoc=${srcdoc} onLoad=${onLoad} title="Message body"></iframe>
    </div>`;
}

function MessageCard({ m, open, onToggle }) {
  const [full, setFull] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || full) return undefined;
    let live = true;
    setError(null);
    loadBody(m).then((f) => live && setFull(f), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [open, m.key]);
  const save = async (a) => {
    try {
      const saved = await api.saveAttachment(m.acct, m.id, a.index);
      if (saved) toast(`Saved ${a.filename}`);
      else if (S.demo) toast('Attachments are placeholders in demo mode');
    } catch (e) { toast(`Could not save: ${e.message}`); }
  };
  return html`
    <div class="msg">
      <div class="msg-h" onClick=${onToggle}>
        <${Avatar} addr=${m.from.addr} name=${m.from.name} />
        <span class="from">${m.kind === 'me' ? 'You' : displayName(m.from)}</span>
        <span class="meta">${open ? m.from.addr : m.snippet}</span>
        <span class="age" title=${fullDate(m.ts)}>${open ? fullDate(m.ts) : ago(m.ts)}</span>
      </div>
      ${open && html`
        ${full && html`<div class="msg-rcpt">to ${full.headers.to || '—'}${full.headers.cc ? html` · cc ${full.headers.cc}` : ''}</div>`}
        ${!full && !error && html`<div class="empty">Loading…</div>`}
        ${error && html`<div class="empty err-text">Could not load this message: ${error}</div>`}
        ${full && html`<${EmailBody} full=${full} />`}
        ${full?.attachments.length > 0 && html`
          <div class="atts">
            ${full.attachments.map((a) => html`
              <button class="att" onClick=${() => save(a)} title="Save attachment">${a.filename} <small>${bytes(a.size)}</small></button>`)}
          </div>`}
        <div class="atts">
          <button class="btn small" onClick=${() => startReply(m, 'reply')}>Reply</button>
          <button class="btn small" onClick=${() => startReply(m, 'replyAll')}>Reply all</button>
          <button class="btn small" onClick=${() => startReply(m, 'forward')}>Forward</button>
        </div>`}
    </div>`;
}

export function Reader() {
  const { open, model, user } = S;
  const thread = model.threads.get(`${open.acct}:${open.threadId}`);
  const [expanded, setExpanded] = useState(() => new Set([open.key]));
  useEffect(() => { setExpanded(new Set([open.key])); }, [open.key]);
  if (!thread) return html`<aside class="reader"><div class="empty">This conversation is no longer available. <button class="btn small" onClick=${closeReader}>Close</button></div></aside>`;

  const focus = thread.find((m) => m.key === open.key) || thread[thread.length - 1];
  const last = thread[thread.length - 1];
  // Actions apply to the message you opened, or the latest one that is not yours.
  const target = focus.kind !== 'me' ? focus : ([...thread].reverse().find((m) => m.kind !== 'me') || last);
  const sender = focus.kind !== 'me' ? model.senders.get(focus.from.addr) : null;
  const waiting = model.needsReply.find((m) => m.acct === open.acct && m.threadId === open.threadId);
  const inAttention = target.reasons && !user.acked[target.key];
  const flagged = !!user.flagged[target.key];
  const acct = accountOf(open.acct);
  const toggle = (key) => { const n = new Set(expanded); if (n.has(key)) n.delete(key); else n.add(key); setExpanded(n); };

  return html`
    <aside class="reader" aria-label="Conversation">
      <div class="reader-h">
        <div class="reader-top">
          <h1>${baseSubject(last.subject) || '(no subject)'}</h1>
          <button class="btn ghost small" onClick=${closeReader} title="Close (Esc)">✕</button>
        </div>
        <div class="reader-actions">
          <button class="btn primary" onClick=${() => startReply(target, 'reply')} title="Reply (r)">Reply</button>
          <button class="btn" onClick=${() => startReply(target, 'replyAll')} title="Reply all (a)">Reply all</button>
          <button class="btn" onClick=${() => startReply(target, 'forward')} title="Forward (f)">Forward</button>
          <span class="sp"></span>
          ${(waiting || inAttention || flagged) && html`<button class="btn" onClick=${() => bump(waiting || target)} title="Move to the top of its list and keep it from fading (b)">Bump</button>`}
          ${waiting && html`<button class="btn" onClick=${() => { markDone(waiting); toast('Marked as no reply needed'); }} title="No reply needed (e)">No reply needed</button>`}
          ${inAttention && !flagged && html`<button class="btn" onClick=${() => ack(target)} title="Dismiss (e)">Dismiss</button>`}
          ${target.kind !== 'me' && html`<button class="btn" onClick=${() => toggleFlag(target)}>${flagged ? 'Unflag' : 'Flag for attention'}</button>`}
        </div>
        <div class="sender-strip">
          <span class="chip"><i class="dot" style=${{ background: acct.color }}></i>${acct.label}</span>
          ${sender && html`
            <span>${sender.addr}</span>
            <span class="seg" title="How mail from this address is treated">
              ${[['important', 'Important'], ['channel', 'Notifications']].map(([k, label]) => html`
                <button class=${cx(sender.kind === k && 'on')} onClick=${() => setSenderKind(sender.addr, sender.kind === k && !sender.auto ? null : k)}>${label}</button>`)}
            </span>
            ${sender.kind === 'new' && html`<span>Unfamiliar sender — choose how to treat them</span>`}
            ${!sender.auto && html`<button class="btn ghost small" onClick=${() => setSenderKind(sender.addr, null)}>Reset to automatic</button>`}`}
          ${target.topic && html`
            <button class="btn ghost small" onClick=${() => toggleQuiet(target.topic)}>${user.quietTopics[target.topic] ? 'Flag this topic again' : 'Never flag this topic'}</button>
            <button class="btn ghost small" onClick=${() => set({ ruleEditor: { topic: model.topics.get(target.topic) } })}>Define topic…</button>`}
        </div>
      </div>
      <div class="reader-body">
        ${thread.map((m) => html`<${MessageCard} key=${m.key} m=${m} open=${expanded.has(m.key)} onToggle=${() => toggle(m.key)} />`)}
      </div>
    </aside>`;
}
