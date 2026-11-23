import { html, useState, useEffect, useMemo, useRef, cx, ago, fullDate, bytes, displayName, sanitizeEmailHtml, textToHtml } from './util.mjs';
import { S, api, closeReader, markDone, ack, bump, toggleFlag, setSenderKind, toggleQuiet, toast, accountOf, set, setSetting, mutate } from './store.mjs';
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

const FRAME_CSS = 'html,body{margin:0;padding:0}body{font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#222;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}blockquote{margin:0 0 0 6px;padding-left:12px;border-left:2px solid #ddd;color:#555}'
  + '.sm-quote[hidden]{display:none!important}.sm-quote-toggle{display:inline-block;margin:10px 0 4px;padding:0 10px;border-radius:9px;background:#e6e6e6;color:#555;font:700 13px/17px system-ui,sans-serif;letter-spacing:1px;cursor:pointer;user-select:none}.sm-quote-toggle:hover{background:#d6d6d6}'
  + '::highlight(find){background:#ffe58a;color:#111}::highlight(find-current){background:#ff9632;color:#111}';

// Dark reading. Plain text is simply drawn light-on-dark. HTML mail is designed for a white page, so
// it is colour-inverted as a whole (hue kept), with pictures flipped back to their real colours.
const PLAIN_DARK_CSS = 'html{color-scheme:dark}body{color:#e9e7e1;background:#1e2024}a{color:#7fd1b6}blockquote{border-color:#3a3d43;color:#b9b6ad}.sm-quote-toggle{background:#33363c;color:#b9b6ad}.sm-quote-toggle:hover{background:#40444b}';
const HTML_DARK_CSS = 'html{background:#e1dfdb;filter:invert(1) hue-rotate(180deg)}body{background:transparent}img,video,picture>source{filter:invert(1) hue-rotate(180deg)}'
  + '::highlight(find){background:#4d4200;color:#fff}::highlight(find-current){background:#8a3d00;color:#fff}';

// While remote images are held back, leave no broken-picture icons behind.
const BLOCKED_CSS = 'img[src^="http"]{display:none!important}';

let userMovedAt = 0; // last time the user scrolled or clicked in the reader, including inside a message
const userMoved = () => { userMovedAt = Date.now(); };

const frameReady = new Set(); // listeners told whenever a message body (re)renders

function EmailBody({ full, m }) {
  // Remote images load for people you correspond with and senders you have allowed; otherwise on request.
  const trusted = S.user.settings.loadImages || m.kind === 'me' || m.kind === 'important' || !!S.user.imageSenders[m.from.addr];
  const [shown, setShown] = useState(false);
  const images = trusted || shown;
  const setImages = setShown;
  const frame = useRef();
  const dark = S.user.settings.readerTheme !== 'light';
  // A forward's quoted part is the message itself; a reply's is history to fold away.
  const forward = /^\s*(fwd?|wg|tr|i)\s*:/i.test(m.subject || '');
  const clean = useMemo(() => (full.html ? sanitizeEmailHtml(full.html, { forward }) : { html: textToHtml(full.text || ''), remoteImages: false }), [full]);
  const srcdoc = useMemo(() => {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data: ${images ? 'https: http:' : ''}; font-src data:`;
    const theme = (!dark ? '' : full.html ? HTML_DARK_CSS : PLAIN_DARK_CSS) + (images ? '' : BLOCKED_CSS);
    // Theme rules come last so that they win over the email's own styles.
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${clean.html}<style>${theme}</style></body></html>`;
  }, [clean, images, dark]);

  const onLoad = () => {
    const el = frame.current;
    const doc = el?.contentDocument;
    if (!doc?.body) return;
    const fit = () => { el.style.height = `${Math.max(40, doc.documentElement.scrollHeight)}px`; };
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.addEventListener('click', (e) => {
      const toggle = e.target.closest?.('.sm-quote-toggle');
      if (toggle) {
        const quote = toggle.nextElementSibling;
        if (quote?.classList.contains('sm-quote')) quote.toggleAttribute('hidden');
        return;
      }
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      // Web links open in the pane beside the reader (Cmd/Ctrl-click: system browser); mailto starts a draft.
      if (openLink(a.href, e)) return;
      if (/^mailto:/i.test(a.href)) newDraft({ to: decodeURIComponent(a.href.slice(7).split('?')[0]) });
    });
    doc.addEventListener('wheel', userMoved, { passive: true });
    doc.addEventListener('pointerdown', userMoved);
    // Keys pressed while the message itself has focus still reach the app (Cmd+F, Esc, shortcuts).
    doc.addEventListener('keydown', (e) => {
      const copy = new KeyboardEvent('keydown', { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
      if (!document.body.dispatchEvent(copy)) e.preventDefault();
    });
    frameReady.forEach((fn) => fn());
  };

  return html`
    ${clean.remoteImages && !images && html`
      <div class="img-note">Remote images are hidden to block tracking.
        <button class="btn small" onClick=${() => setImages(true)}>Show images</button>
        <button class="btn small" onClick=${() => mutate((u) => { u.imageSenders[m.from.addr] = true; })}>Always from ${m.from.addr}</button>
      </div>`}
    <div class=${cx('paper', dark && 'dark')}>
      <iframe ref=${frame} sandbox="allow-same-origin" srcdoc=${srcdoc} onLoad=${onLoad} title="Message body"></iframe>
    </div>`;
}

// ------------------------------------------------------------ find in message

/** Highlight every occurrence of `query` in the open message bodies. Returns the matches in reading order. */
function findInFrames(query) {
  const matches = [];
  const q = query.toLowerCase();
  for (const el of document.querySelectorAll('.reader-body iframe')) {
    const doc = el.contentDocument, win = el.contentWindow;
    if (!doc?.body || !win?.CSS?.highlights) continue;
    win.CSS.highlights.delete('find');
    win.CSS.highlights.delete('find-current');
    if (!q) continue;
    const ranges = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('style,script,.sm-quote-toggle') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = doc.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        ranges.push(r);
        matches.push({ el, win, range: r });
      }
    }
    if (ranges.length) win.CSS.highlights.set('find', new win.Highlight(...ranges));
  }
  return matches;
}

function showMatch(matches, index) {
  for (const w of new Set(matches.map((m) => m.win))) w.CSS.highlights.delete('find-current');
  const m = matches[index];
  if (!m) return;
  m.win.CSS.highlights.set('find-current', new m.win.Highlight(m.range));
  m.range.startContainer.parentElement?.closest('.sm-quote[hidden]')?.removeAttribute('hidden'); // unfold earlier messages if the match is in them
  requestAnimationFrame(() => {
    const box = document.querySelector('.reader-body');
    const y = m.el.getBoundingClientRect().top + m.range.getBoundingClientRect().top;
    const view = box.getBoundingClientRect();
    if (y < view.top + 40 || y > view.bottom - 60) box.scrollBy({ top: y - (view.top + view.height / 3) });
  });
}

function FindBar({ onClose }) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const input = useRef();
  const run = (query, keep) => {
    const found = findInFrames(query);
    const i = keep ? Math.min(keep.i, Math.max(0, found.length - 1)) : 0;
    setMatches(found);
    setIndex(i);
    showMatch(found, i);
  };
  const latest = useRef({ q, i: index });
  latest.current = { q, i: index };
  useEffect(() => {
    input.current.focus();
    const again = () => run(latest.current.q, latest.current); // a body finished loading or was re-themed
    frameReady.add(again);
    return () => { frameReady.delete(again); findInFrames(''); };
  }, []);
  const step = (d) => {
    if (!matches.length) return;
    const i = (index + d + matches.length) % matches.length;
    setIndex(i);
    showMatch(matches, i);
  };
  return html`
    <div class="find" role="search">
      <input class="input" ref=${input} value=${q} placeholder="Find in this conversation" aria-label="Find in this conversation"
        onInput=${(e) => { setQ(e.target.value); run(e.target.value); }}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      <span class="find-n" aria-live="polite">${q ? (matches.length ? `${index + 1} of ${matches.length}` : 'No matches') : ''}</span>
      <button class="btn ghost small" disabled=${!matches.length} onClick=${() => step(-1)} title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>
      <button class="btn ghost small" disabled=${!matches.length} onClick=${() => step(1)} title="Next (Enter)" aria-label="Next match">↓</button>
      <button class="btn ghost small" onClick=${onClose} title="Close (Esc)" aria-label="Close find">✕</button>
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
    <div class="msg" data-key=${m.key}>
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
        ${full && html`<${EmailBody} full=${full} m=${m} />`}
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
  // Open on what is new: the message you clicked plus anything unread, scrolled to the latest of them.
  const initial = () => new Set([open.key, ...(open.unread || [])]);
  const [expanded, setExpanded] = useState(initial);
  const [showEarlier, setShowEarlier] = useState(false);
  const body = useRef();
  const pin = useRef(null); // {key, until}: keep this message at the top while bodies above it load
  const settle = () => {
    const p = pin.current;
    if (!p || Date.now() > p.until || userMovedAt > p.since || !body.current) return;
    const card = [...body.current.querySelectorAll('.msg')].find((el) => el.dataset.key === p.key);
    if (card) body.current.scrollTop += card.getBoundingClientRect().top - body.current.getBoundingClientRect().top - 12;
  };
  useEffect(() => {
    setExpanded(initial());
    setShowEarlier(false);
    pin.current = { key: open.scrollTo || open.key, since: Date.now(), until: Date.now() + 4000 };
    frameReady.add(settle);
    const t = setTimeout(settle, 0);
    return () => { frameReady.delete(settle); clearTimeout(t); };
  }, [open.key, open.n]);
  // Cmd/Ctrl+F: search the whole conversation, so every message is opened first.
  useEffect(() => {
    if (S.finding && thread) setExpanded(new Set(thread.map((m) => m.key)));
  }, [S.finding, open.threadId]);
  const dark = user.settings.readerTheme !== 'light';
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
  // Earlier messages you have already seen are tucked into one line rather than a stack to scroll past.
  const firstOpen = thread.findIndex((m) => expanded.has(m.key));
  const tucked = !showEarlier && firstOpen >= 3 ? firstOpen : 0;
  const toggle = (key) => { const n = new Set(expanded); if (n.has(key)) n.delete(key); else n.add(key); setExpanded(n); };

  return html`
    <aside class="reader" aria-label="Conversation">
      <div class="reader-h">
        <div class="reader-top">
          <h1>${baseSubject(last.subject) || '(no subject)'}</h1>
          <span class="seg" role="group" aria-label="Reading theme" title="How message bodies are shown">
            <button class=${cx(!dark && 'on')} aria-pressed=${!dark} onClick=${() => setSetting('readerTheme', 'light')}>Light</button>
            <button class=${cx(dark && 'on')} aria-pressed=${dark} onClick=${() => setSetting('readerTheme', 'dark')}>Dark</button>
          </span>
          <button class="btn ghost small" onClick=${() => set({ finding: !S.finding })} title="Find in this conversation (⌘F / Ctrl+F)" aria-label="Find in this conversation">Find</button>
          <button class="btn ghost small" onClick=${closeReader} title="Close (Esc)">✕</button>
        </div>
        ${S.finding && html`<${FindBar} key=${open.threadId} onClose=${() => set({ finding: false })} />`}
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
      <div class="reader-body" ref=${body} onWheel=${userMoved} onPointerDown=${userMoved} onKeyDown=${userMoved}>
        ${tucked > 0 && html`<button class="earlier" onClick=${() => { pin.current = null; setShowEarlier(true); }}>${tucked} earlier messages</button>`}
        ${thread.slice(tucked).map((m) => html`<${MessageCard} key=${m.key} m=${m} open=${expanded.has(m.key)} onToggle=${() => toggle(m.key)} />`)}
      </div>
    </aside>`;
}
