// Testers tab: the people you are talking to during a test programme, kept in one Notion database,
// with each person's conversations (Instagram, Discord, Slack, Teams, email) one click away.

import { html, useState, useEffect, cx, ago } from './util.mjs';
import { S, api, set, toast, openMessage, closeReader, notify, saveSoon } from './store.mjs';
import { newDraft } from './compose.mjs';
import { Browser } from './webpane.mjs';
import { PLATFORMS, linkFromInput, conversationOf, nameFromTitle } from '../core/notion.mjs';
import { addNote, archiveNote, clearArchive, linkForNote } from '../core/notes.mjs';

const CHAT_PARTITION = 'persist:stillmail-chat'; // sign-ins for the messaging sites; separate from links opened from email
const NOTION_COLORS = { default: '#878a8f', gray: '#9a9da3', brown: '#b98f6f', orange: '#e79a4f', yellow: '#e3c24f', green: '#6fc79a', blue: '#6aa8ee', purple: '#a98be6', pink: '#e68bc0', red: '#ec7a72' };

const T = (patch) => set({ testers: { ...S.testers, ...patch } });
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const putRow = (row) => T({ rows: S.testers.rows.some((r) => r.id === row.id) ? S.testers.rows.map((r) => (r.id === row.id ? row : r)) : [...S.testers.rows, row] });
const byName = (a, b) => (a.name || '￿').localeCompare(b.name || '￿', undefined, { sensitivity: 'base' });

// ------------------------------------------------------------------ data

let loadedAt = 0;

export async function loadTesters({ quiet = false } = {}) {
  if (S.testers.loading) return;
  T(quiet ? { loading: true } : { loading: true, error: null });
  try {
    const status = await api.notionStatus();
    T({ status });
    if (!status.connected) return T({ loading: false, rows: [], schema: null, sel: null });
    const { schema, rows } = await api.notionLoad();
    loadedAt = Date.now();
    T({ schema, rows, loading: false, error: null, sel: rows.some((r) => r.id === S.testers.sel) ? S.testers.sel : null });
  } catch (e) {
    T({ loading: false, error: clean(e), status: S.testers.status || { connected: false } });
  }
}

/** Remember select options created by typing a new name, so they are offered straight away. */
function learnOptions(values) {
  const schema = S.testers.schema;
  let changed = false;
  const fields = schema.fields.map((f) => {
    if (!(f.name in values) || (f.type !== 'multi_select' && f.type !== 'select')) return f;
    const fresh = [].concat(values[f.name] || []).filter((name) => name && !f.options.some((o) => o.name === name));
    if (!fresh.length) return f;
    changed = true;
    return { ...f, options: [...f.options, ...fresh.map((name) => ({ name, color: 'default' }))] };
  });
  if (changed) T({ schema: { ...schema, fields } });
}

let queue = Promise.resolve();
/** Change a person: shown at once, then written to Notion; put back if Notion refuses. */
function save(id, patch) {
  const before = S.testers.rows.find((r) => r.id === id);
  if (!before) return;
  const { values, ...rest } = patch;
  putRow({ ...before, ...rest, values: { ...before.values, ...(values || {}) } });
  if (values) learnOptions(values);
  queue = queue.then(() => api.notionUpdate(id, patch)).then(
    (fresh) => { if (S.testers.rows.some((r) => r.id === id)) putRow(fresh); },
    (e) => { putRow(before); toast(`Notion did not save that: ${clean(e)}`, { ms: 9000 }); },
  );
}

async function addPerson(name, links = []) {
  try {
    const row = await api.notionCreate(links.length ? { name, links } : { name });
    putRow(row);
    T({ sel: row.id, q: '', tags: new Set() });
  } catch (e) { toast(`Could not add to Notion: ${clean(e)}`, { ms: 9000 }); }
}

async function removePerson(row) {
  try {
    await api.notionTrash(row.id, true);
    T({ rows: S.testers.rows.filter((r) => r.id !== row.id), sel: null });
    toast(`${row.name || 'Person'} moved to the Notion trash`, {
      ms: 8000, action: 'Undo',
      onAction: async () => { set({ toast: null }); try { await api.notionTrash(row.id, false); putRow(row); } catch (e) { toast(`Could not restore: ${clean(e)}`); } },
    });
  } catch (e) { toast(`Could not remove: ${clean(e)}`, { ms: 9000 }); }
}

// ------------------------------------------------------------------ opening conversations

function openEmail(address) {
  let best = null;
  for (const m of S.messages.values()) {
    if ((m.from.addr === address || m.to.includes(address)) && (!best || m.ts > best.ts)) best = m;
  }
  if (best) openMessage(best);
  else if (S.accounts.length) newDraft({ to: address });
  else api.openExternal(`mailto:${address}`);
}

/** Email opens in Stillmail itself; everything else in a signed-in browser pane, one per platform. */
export function openConversation(link, event) {
  if (link.platform === 'email') return openEmail(link.address);
  if (link.platform === 'note') return undefined;
  if (event?.metaKey || event?.ctrlKey || !S.canEmbed) return api.openExternal(link.url);
  if (S.open) closeReader();
  const { chats, active } = S.testers;
  const cur = chats[link.platform];
  const reuse = cur && cur.url === link.url && active !== link.platform; // already there: just bring it forward
  T({ chats: { ...chats, [link.platform]: reuse ? cur : { url: link.url, n: (cur?.n || 0) + 1, at: link.url, title: '' } }, active: link.platform, browser: true });
  return follow();
}

const INBOX = { instagram: 'https://www.instagram.com/direct/inbox/', discord: 'https://discord.com/channels/@me', slack: 'https://app.slack.com/client', teams: 'https://teams.microsoft.com/v2/' };

/** Open a platform's inbox (or return to its pane, wherever it was left). */
function openInbox(platform, event) {
  if (S.testers.chats[platform] && !event?.metaKey && !event?.ctrlKey) { if (S.open) closeReader(); return showChat(platform); }
  return openConversation({ platform, url: INBOX[platform] }, event);
}

function showChat(platform) { T({ active: platform, browser: true }); follow(); }

/** Show the browser with its tabs; nothing is loaded until a tab is chosen. */
function openBrowser() { if (S.open) closeReader(); T({ browser: true }); follow(); }

function closeChat(platform) {
  const { [platform]: _, ...chats } = S.testers.chats;
  T({ chats, active: null });
  follow();
}

// ------------------------------------------------------------------ following the browser

/** The person a conversation is linked to, if any. */
const ownerOf = (key) => S.testers.rows.find((r) => r.links.some((l) => l.url && conversationOf(l.url)?.key === key));

/** Make the details follow the pane in front: its conversation's person, or the offer to link it to someone. */
function follow() {
  const t = S.testers;
  const chat = t.chats[t.active];
  const conv = chat?.at ? conversationOf(chat.at) : null;
  if (!conv) { if (t.here) T({ here: null }); return; }
  const here = { ...conv, title: chat.title || '' };
  if (t.here?.key !== conv.key) T({ here, dismissed: null, sel: ownerOf(conv.key)?.id ?? t.sel });
  else if (t.here.title !== here.title || t.here.url !== here.url) T({ here });
}

/** A browser pane reports each page it lands on. */
export function onLocation(platform, { url, title }) {
  const chat = S.testers.chats[platform];
  if (!chat || (chat.at === url && chat.title === title)) return;
  T({ chats: { ...S.testers.chats, [platform]: { ...chat, at: url, title } } });
  if (platform === S.testers.active) follow();
}

const pick = (id) => T({ sel: id, dismissed: S.testers.here?.key ?? null });

// ------------------------------------------------------------------ notifications from the browser

const panes = {}; // platform -> its <webview>, while that page is loaded
const setNotes = (notes) => { S.user.chatNotes = notes; saveSoon(); notify(); };

/** A messaging page raised a notification: it joins the list of people to answer. */
export function onNote(platform, raw) {
  if (!raw || !raw.id || !PLATFORMS[platform]) return;
  const note = { id: String(raw.id), platform, title: String(raw.title || '').trim() || PLATFORMS[platform].name, body: String(raw.body || '').trim(), tag: String(raw.tag || ''), ts: Date.now() };
  setNotes(addNote(S.user.chatNotes, note));
  // Away from the Testers tab (or the app), say so the way new mail does.
  if (!S.user.settings.notify || typeof Notification === 'undefined' || (document.hasFocus() && S.view === 'testers')) return;
  try {
    const n = new Notification(`${PLATFORMS[platform].name} · ${note.title}`, { body: note.body, tag: note.id });
    n.onclick = () => { api.focusWindow?.(); openNote(note); };
  } catch { /* notifications unavailable */ }
}

/** Archive a note and go to what it is about. */
export async function openNote(note) {
  setNotes(archiveNote(S.user.chatNotes, note.id));
  if (S.view !== 'testers') set({ view: 'testers' });
  if (!S.canEmbed) return;
  if (S.open) closeReader();
  const loaded = !!S.testers.chats[note.platform];
  if (loaded) {
    showChat(note.platform);
    // Click the notification inside its page: the site opens the conversation, and the details follow.
    let clicked = false;
    try { clicked = await panes[note.platform]?.executeJavaScript(`(window[Symbol.for('stillmail.notifications')]?.click(${JSON.stringify(note.id)})) || false`, true); } catch { /* page not ready */ }
    if (clicked) return;
  }
  // The page has been reloaded or closed since: find the conversation by the person's name, else show the inbox.
  const hit = linkForNote(note, S.testers.rows);
  if (hit) { pick(hit.row.id); openConversation(hit.link); } else if (!loaded && INBOX[note.platform]) openInbox(note.platform);
}

function Notes() {
  const all = S.user.chatNotes || [];
  const waiting = all.filter((n) => !n.done);
  const archived = all.filter((n) => n.done);
  const toggle = () => { S.user.chatNotesOpen = S.user.chatNotesOpen === false; saveSoon(); notify(); };
  if (S.user.chatNotesOpen === false) {
    return html`
      <aside class="t-notes rail" aria-label="Notifications">
        <button onClick=${toggle} title="Show notifications" aria-label=${`Show notifications (${waiting.length} waiting)`}>
          <span>‹</span>${waiting.length > 0 && html`<b class="n">${waiting.length}</b>`}<span class="v">Notifications</span>
        </button>
      </aside>`;
  }
  const item = (n) => html`
    <div class=${cx('note', n.done && 'done')} key=${n.id} role="button" tabindex="0" title=${n.done ? 'Open again' : 'Open the conversation and archive this'}
      onClick=${() => openNote(n)} onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openNote(n); }}>
      <${Badge} platform=${n.platform} />
      <div class="txt"><b>${n.title}</b>${n.body && html`<span>${n.body}</span>`}</div>
      <span class="age">${ago(n.ts)}</span>
      ${!n.done && html`<button class="btn ghost small" aria-label="Archive without opening" title="Archive without opening" onClick=${(e) => { e.stopPropagation(); setNotes(archiveNote(S.user.chatNotes, n.id)); }}>✓</button>`}
    </div>`;
  return html`
    <aside class="t-notes" aria-label="Notifications">
      <div class="t-notes-h"><span>To answer${waiting.length > 0 && html` <b class="n">${waiting.length}</b>`}</span>
        <button class="btn ghost small" onClick=${toggle} title="Collapse" aria-label="Collapse notifications">›</button></div>
      <div class="t-notes-body">
        ${waiting.map(item)}
        ${waiting.length === 0 && html`<div class="empty">Nobody is waiting. Messages that arrive in a browser tab you have opened are listed here.</div>`}
      </div>
      ${archived.length > 0 && html`
        <details class="note-tray">
          <summary>Archived <span class="ct">${archived.length}</span></summary>
          <div class="t-notes-body">${archived.map(item)}</div>
          <button class="more" onClick=${() => setNotes(clearArchive(S.user.chatNotes))}>Clear archive</button>
        </details>`}
    </aside>`;
}

// ------------------------------------------------------------------ small pieces

const linkText = (l) => {
  if (l.platform === 'email') return l.label ? `${l.address} (${l.label})` : l.address;
  if (l.label) return l.label;
  try { const u = new URL(l.url); return l.platform === 'web' ? u.host : PLATFORMS[l.platform].name; } catch { return l.url; }
};

function Badge({ platform }) {
  const p = PLATFORMS[platform] || PLATFORMS.web;
  return html`<span class="plat" style=${{ '--c': p.color }} title=${p.name}>${p.short}</span>`;
}

function Tag({ name, color, onRemove, on, onClick }) {
  return html`
    <span class=${cx('tag', on && 'on', onClick && 'click')} style=${{ '--c': NOTION_COLORS[color] || NOTION_COLORS.default }} onClick=${onClick}>
      ${name}${onRemove && html`<button aria-label=${`Remove ${name}`} onClick=${onRemove}>✕</button>`}
    </span>`;
}

const colorOf = (field, name) => field.options.find((o) => o.name === name)?.color;

// ------------------------------------------------------------------ connection

function Connection() {
  const { status } = S.testers;
  const [token, setToken] = useState('');
  const [database, setDatabase] = useState(status?.url || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = !!status?.connected;
  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); T({ connecting: false }); await loadTesters(); } catch (e) { setError(clean(e)); }
    setBusy(false);
  };
  return html`
    <div class="welcome t-connect">
      <h1>${connected ? 'Notion connection' : 'Testers'}</h1>
      ${!connected && html`<p>Keep track of everyone you are talking to during a test programme, whichever app the conversation is in. The list lives in one Notion database, read and written directly on Notion's servers from this computer.</p>`}
      <ol>
        <li>In Notion's <a href="https://www.notion.so/developers" onClick=${(e) => { e.preventDefault(); api.openExternal(e.currentTarget.href); }}>developer settings</a>, create an <b>API key</b> for Stillmail and copy it.</li>
        <li>Make sure the key can reach your database. If Notion asks which pages the key may use, choose the database; otherwise open the database as a full page and add the key under <b>••• → Connections</b>.</li>
        <li>Copy the database's link (<b>••• → Copy link</b>) and paste both below.</li>
      </ol>
      <div class="card">
        <div class="form-row"><label>Notion API key${connected && html`<small>Leave empty to keep the current one</small>`}</label>
          <input class="input mono" type="password" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder=${connected ? '••••••••' : 'ntn_…'} aria-label="Notion API key" /></div>
        <div class="form-row"><label>Database link</label>
          <input class="input mono" value=${database} onInput=${(e) => setDatabase(e.target.value)} placeholder="https://www.notion.so/…" aria-label="Database link" /></div>
      </div>
      <p>Each row is one person. Stillmail uses the database's own columns for tags and notes, and adds a <b>Conversation links</b> text column (and a <b>Tags</b> column if there is no multi-select yet).</p>
      ${error && html`<p class="err-text">${error}</p>`}
      <div class="form-row" style=${{ padding: '6px 0', border: 0 }}>
        <button class="btn primary" disabled=${busy || !database.trim() || (!connected && !token.trim())} onClick=${() => run(() => api.notionConnect({ token, database }))}>${busy ? 'Connecting…' : connected ? 'Save' : 'Connect'}</button>
        ${connected && html`<button class="btn" onClick=${() => T({ connecting: false })}>Cancel</button>`}
        ${connected && html`<button class="btn danger" disabled=${busy} title="Forget the API key and the database. Nothing is deleted in Notion." onClick=${() => run(() => api.notionDisconnect())}>Disconnect</button>`}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ list

function People() {
  const { rows, schema, sel, q, tags, status, loading, error } = S.testers;
  const [name, setName] = useState('');
  const tagField = schema.fields.find((f) => f.type === 'multi_select');
  const used = new Set(tagField ? rows.flatMap((r) => r.values[tagField.name] || []) : []);
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (tagField && [...tags].some((t) => !(r.values[tagField.name] || []).includes(t))) return false;
    if (!needle) return true;
    return [r.name, ...Object.values(r.values).flat(), ...r.links.map((l) => `${l.label || ''} ${l.address || ''} ${PLATFORMS[l.platform]?.name || ''}`)].join(' ').toLowerCase().includes(needle);
  }).sort(byName);
  const toggleTag = (t) => { const next = new Set(tags); if (next.has(t)) next.delete(t); else next.add(t); T({ tags: next }); };
  const add = () => { const n = name.trim(); if (!n) return; setName(''); addPerson(n); };
  return html`
    <div class="t-people">
      <div class="t-head">
        <h2>Testers</h2>
        <span class="hint">${rows.length} ${rows.length === 1 ? 'person' : 'people'} in <a href=${status.url} onClick=${(e) => { e.preventDefault(); if (status.url) api.openExternal(status.url); }}>${status.title}</a></span>
        <button class="btn small" disabled=${loading} onClick=${() => loadTesters()} title="Fetch the latest from Notion">${loading ? 'Loading…' : 'Refresh'}</button>
        ${!S.demo && html`<button class="btn small" onClick=${() => T({ connecting: true })}>Connection…</button>`}
        ${!S.testers.browser && S.canEmbed && html`<button class="btn small primary t-browse" onClick=${openBrowser} title="Open Instagram, Discord, Slack or Teams beside the list and work from there">Open browser</button>`}
      </div>
      ${error && html`<div class="banner t-error"><span>${error}</span><button onClick=${() => loadTesters()}>Try again</button></div>`}
      <div class="t-tools">
        <input class="input" value=${q} onInput=${(e) => T({ q: e.target.value })} placeholder="Find a person, tag or note…" aria-label="Find a person" />
        <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} placeholder="Add a person…" aria-label="Add a person" />
        <button class="btn" disabled=${!name.trim()} onClick=${add}>Add</button>
      </div>
      ${used.size > 0 && html`
        <div class="t-tags" role="group" aria-label="Filter by tag">
          ${tagField.options.filter((o) => used.has(o.name)).map((o) => html`<${Tag} key=${o.name} name=${o.name} color=${o.color} on=${tags.has(o.name)} onClick=${() => toggleTag(o.name)} />`)}
          ${tags.size > 0 && html`<button class="btn ghost small" onClick=${() => T({ tags: new Set() })}>Clear</button>`}
        </div>`}
      <div class="card t-list">
        ${shown.map((r) => html`
          <div class=${cx('row', sel === r.id && 'sel')} key=${r.id} tabindex="0" onClick=${() => pick(r.id)} onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) pick(r.id); }}>
            <span class="who">${r.name || 'Unnamed'}</span>
            <span class="t-rowtags">${tagField && (r.values[tagField.name] || []).map((t) => html`<${Tag} key=${t} name=${t} color=${colorOf(tagField, t)} />`)}</span>
            <span class="t-links" onClick=${(e) => e.stopPropagation()}>
              ${r.links.filter((l) => l.platform !== 'note').map((l, i) => html`
                <button class="plat-btn" key=${i} title=${`${PLATFORMS[l.platform].name}: ${linkText(l)}`} aria-label=${`Open ${PLATFORMS[l.platform].name} conversation with ${r.name}: ${linkText(l)}`}
                  onClick=${(e) => { pick(r.id); openConversation(l, e); }}><${Badge} platform=${l.platform} /></button>`)}
            </span>
          </div>`)}
        ${shown.length === 0 && html`<div class="empty">${loading && !rows.length ? 'Loading from Notion…' : rows.length ? 'Nobody matches.' : 'Nobody here yet. Add the first person above, or add rows in Notion and press Refresh.'}</div>`}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ detail

function LinkEditor({ link, onSave, onCancel }) {
  const [input, setInput] = useState(link ? (link.platform === 'email' ? link.address : link.url) : '');
  const [label, setLabel] = useState(link?.label || '');
  const parsed = linkFromInput(input, label);
  const submit = () => { if (parsed) { onSave(parsed); if (!link) { setInput(''); setLabel(''); } } };
  const onKey = (e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } };
  return html`
    <div class="t-linkform">
      ${parsed ? html`<${Badge} platform=${parsed.platform} />` : html`<span class="plat none">+</span>`}
      <input class="input" value=${input} onInput=${(e) => setInput(e.target.value)} onKeyDown=${onKey} placeholder="Paste a conversation link or an email address" aria-label="Conversation link or email address" />
      <input class="input lbl" value=${label} onInput=${(e) => setLabel(e.target.value)} onKeyDown=${onKey} placeholder="Label (optional)" aria-label="Label" />
      <button class="btn small" disabled=${!parsed} onClick=${submit}>${link ? 'Save' : 'Add'}</button>
      ${onCancel && html`<button class="btn ghost small" onClick=${onCancel}>Cancel</button>`}
      ${input.trim() && !parsed && html`<div class="err-text">Enter a web address (https://…) or an email address.</div>`}
    </div>`;
}

function Links({ row }) {
  const [editing, setEditing] = useState(-1);
  const setLinks = (links) => save(row.id, { links });
  return html`
    <div class="t-section">
      <div class="side-h"><span>Conversations</span></div>
      ${row.links.map((l, i) => (l.platform === 'note' ? html`<div class="t-link note" key=${i}><span class="txt">${l.text}</span><button class="btn ghost small" aria-label="Remove note" onClick=${() => setLinks(row.links.filter((_, j) => j !== i))}>✕</button></div>`
        : editing === i ? html`<${LinkEditor} key=${`e${i}`} link=${l} onCancel=${() => setEditing(-1)} onSave=${(next) => { setEditing(-1); setLinks(row.links.map((x, j) => (j === i ? next : x))); }} />`
        : html`
          <div class="t-link" key=${i}>
            <button class="open" onClick=${(e) => openConversation(l, e)} title=${l.platform === 'email' ? `Show the latest email with ${l.address}` : `${l.url}\nOpens beside the list. ⌘-click (Ctrl-click) for your default browser.`}>
              <${Badge} platform=${l.platform} /><b>${PLATFORMS[l.platform].name}</b><span class="txt">${linkText(l) === PLATFORMS[l.platform].name ? '' : linkText(l)}</span>
            </button>
            ${l.platform === 'email' && S.accounts.length > 0 && html`<button class="btn ghost small" onClick=${() => newDraft({ to: l.address })}>Write</button>`}
            <button class="btn ghost small" aria-label="Edit link" title="Edit" onClick=${() => setEditing(i)}>✎</button>
            <button class="btn ghost small" aria-label="Remove link" title="Remove" onClick=${() => setLinks(row.links.filter((_, j) => j !== i))}>✕</button>
          </div>`))}
      ${row.links.length === 0 && html`<div class="empty">No conversations linked yet.</div>`}
      ${S.testers.here && !ownerOf(S.testers.here.key) && html`
        <button class="btn small t-linkhere" onClick=${() => setLinks([...row.links, { platform: S.testers.here.platform, url: S.testers.here.url, label: '' }])}>
          <${Badge} platform=${S.testers.here.platform} /> Link the open ${PLATFORMS[S.testers.here.platform].name} conversation</button>`}
      <${LinkEditor} key=${`new-${row.id}`} onSave=${(l) => setLinks([...row.links, l])} />
      <details class="t-help"><summary>Where do I find a conversation's link?</summary>
        <p><b>Slack</b>: right-click the conversation → Copy → Copy link. <b>Teams</b>: ••• next to the chat → Copy link. <b>Discord</b> and <b>Instagram</b>: open the conversation at discord.com or instagram.com/direct in a browser and copy the address. The first time you open each one here you sign in once; it stays signed in.</p>
      </details>
    </div>`;
}

function Field({ row, field }) {
  const value = row.values[field.name];
  const put = (v) => save(row.id, { values: { [field.name]: v } });
  const id = `f-${field.name.replace(/\W+/g, '-')}`;
  const commit = (e) => { const v = e.target.value.trim(); if (v !== (value ?? '')) put(v); };
  const onEnter = (e) => { if (e.key === 'Enter') e.target.blur(); };
  let control;
  if (field.type === 'multi_select') {
    const list = value || [];
    const addTag = (el) => { const v = el.value.replace(/,/g, ' ').trim(); if (!v) return; el.value = ''; if (!list.includes(v)) put([...list, v]); };
    control = html`
      <div class="t-multi">
        ${list.map((t) => html`<${Tag} key=${t} name=${t} color=${colorOf(field, t)} onRemove=${() => put(list.filter((x) => x !== t))} />`)}
        <input class="input" list=${`${id}-opts`} placeholder="Add…" aria-label=${`Add to ${field.name}`}
          onKeyDown=${(e) => { if (e.key === 'Enter') addTag(e.target); }}
          onInput=${(e) => { if (field.options.some((o) => o.name === e.target.value) && !field.options.some((o) => o.name !== e.target.value && o.name.startsWith(e.target.value))) addTag(e.target); }} />
        <datalist id=${`${id}-opts`}>${field.options.filter((o) => !list.includes(o.name)).map((o) => html`<option value=${o.name} />`)}</datalist>
      </div>`;
  } else if (field.type === 'select') {
    control = html`
      <input class="input" id=${id} list=${`${id}-opts`} value=${value} placeholder="None" onChange=${(e) => { e.target.value = e.target.value.replace(/,/g, ' '); commit(e); }} onKeyDown=${onEnter} />
      <datalist id=${`${id}-opts`}>${field.options.map((o) => html`<option value=${o.name} />`)}</datalist>`;
  } else if (field.type === 'status') {
    control = html`<select class="input" id=${id} value=${value} onChange=${(e) => put(e.target.value)}>${!value && html`<option value=""></option>`}${field.options.map((o) => html`<option value=${o.name}>${o.name}</option>`)}</select>`;
  } else if (field.type === 'checkbox') {
    control = html`<input type="checkbox" id=${id} checked=${!!value} onChange=${(e) => put(e.target.checked)} />`;
  } else if (field.type === 'rich_text') {
    control = html`<textarea class="input" id=${id} rows="4" value=${value} onBlur=${commit}></textarea>`;
  } else if (field.type === 'number') {
    control = html`<input class="input" id=${id} type="number" step="any" value=${value ?? ''} onChange=${(e) => { const v = e.target.value === '' ? null : Number(e.target.value); if (v !== value) put(v); }} onKeyDown=${onEnter} />`;
  } else {
    const type = { date: 'date', url: 'url', email: 'email', phone_number: 'tel' }[field.type];
    control = html`<input class="input" id=${id} type=${type} value=${(value || '').slice(0, field.type === 'date' ? 10 : undefined)} onChange=${commit} onKeyDown=${onEnter} />`;
  }
  return html`<div class=${cx('t-field', field.type)}><label for=${id}>${field.name}</label>${control}</div>`;
}

function Detail({ row }) {
  const { schema } = S.testers;
  return html`
    <div class="t-detail" key=${row.id}>
      <div class="t-detail-h">
        <input class="input t-name" value=${row.name} placeholder="Name" aria-label="Name"
          onChange=${(e) => { const v = e.target.value.trim(); if (v !== row.name) save(row.id, { name: v }); }} onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
        <button class="btn ghost small" onClick=${() => T({ sel: null })} aria-label="Close details" title="Close">✕</button>
      </div>
      <div class="t-detail-body">
        <${Links} row=${row} />
        <div class="t-section">
          ${schema.fields.map((f) => html`<${Field} key=${`${row.id}:${f.name}`} row=${row} field=${f} />`)}
        </div>
        <div class="t-foot">
          ${row.url && html`<button class="btn small" onClick=${() => api.openExternal(row.url)}>Open in Notion</button>`}
          <button class="btn small danger" onClick=${() => removePerson(row)}>Remove</button>
        </div>
      </div>
    </div>`;
}

/** The pane is on a conversation nobody is linked to: add its person, or attach it to someone already listed. */
function Unlinked({ here }) {
  const [typed, setTyped] = useState(null); // null: keep following the guess from the page title
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const name = typed ?? nameFromTitle(here.title);
  const platform = PLATFORMS[here.platform].name;
  const link = { platform: here.platform, url: here.url, label: '' };
  const needle = q.trim().toLowerCase();
  const found = needle ? S.testers.rows.filter((r) => r.name.toLowerCase().includes(needle)).sort(byName).slice(0, 8) : [];
  const create = async () => { if (!name.trim() || busy) return; setBusy(true); await addPerson(name.trim(), [link]); setBusy(false); };
  const attach = (row) => { save(row.id, { links: [...row.links, link] }); T({ sel: row.id }); };
  return html`
    <div class="t-detail t-unlinked">
      <div class="t-detail-h">
        <${Badge} platform=${here.platform} /><b class="ttl">New ${platform} conversation</b>
        <button class="btn ghost small" onClick=${() => T({ dismissed: here.key })} aria-label="Not now" title="Not now">✕</button>
      </div>
      <div class="t-detail-body">
        <p class="note">This conversation is not linked to anyone on your list yet.</p>
        <div class="t-section">
          <div class="side-h"><span>Add as a new tester</span></div>
          <div class="t-linkform">
            <input class="input" value=${name} onInput=${(e) => setTyped(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') create(); }} placeholder="Their name" aria-label="New tester's name" />
            <button class="btn primary small" disabled=${!name.trim() || busy} onClick=${create}>${busy ? 'Adding…' : 'Add tester'}</button>
          </div>
        </div>
        <div class="t-section">
          <div class="side-h"><span>Or link to someone already listed</span></div>
          <input class="input" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Search by name…" aria-label="Search existing testers" />
          <div class="t-found">
            ${found.map((r) => html`
              <button key=${r.id} onClick=${() => attach(r)} title=${`Link this conversation to ${r.name}`}>
                <span class="who">${r.name || 'Unnamed'}</span>
                ${r.links.filter((l) => l.platform !== 'note').map((l, i) => html`<${Badge} key=${i} platform=${l.platform} />`)}
              </button>`)}
            ${needle && found.length === 0 && html`<div class="empty">Nobody on the list matches.</div>`}
          </div>
        </div>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ conversations

function Chats({ off }) {
  const { chats, active, wide } = S.testers;
  const open = Object.keys(chats);
  // The four services always have a tab; one that has not been opened loads only when clicked.
  const tabs = [...Object.keys(INBOX), ...open.filter((p) => !INBOX[p])];
  const tab = (p) => html`
    <button key=${p} class=${cx('chat-tab', p === active && 'on', !chats[p] && 'idle')} aria-pressed=${p === active} title=${chats[p] ? PLATFORMS[p].name : `Open ${PLATFORMS[p].name}`}
      onClick=${(e) => (chats[p] ? showChat(p) : openInbox(p, e))}><${Badge} platform=${p} />${PLATFORMS[p].name}</button>`;
  return html`
    <div class=${cx('chat-stack', off && 'off')}>
      <div class="chat-tabs">
        <button class="btn ghost small" onClick=${() => T({ wide: !wide })} title=${wide ? 'Show the list of people' : 'Give the browser the whole window'}>${wide ? '⇥ People' : '⇤ Wider'}</button>
        ${tabs.map(tab)}
        <span class="sp"></span>
        <button class="btn ghost small" onClick=${() => T({ browser: false, wide: false })} title="Hide the browser. Pages that are open stay signed in and loaded." aria-label="Hide browser">Hide</button>
      </div>
      <div class="chat-panes">
        ${!active && html`
          <div class="chat-empty">
            <p>Choose where to go. Nothing loads until you pick one; after that it stays open in its tab.</p>
            <div class="picks">${Object.keys(INBOX).map((p) => html`<button class="btn" key=${p} onClick=${(e) => openInbox(p, e)}><${Badge} platform=${p} />${PLATFORMS[p].name}</button>`)}</div>
            <p>Open a conversation there and its person shows beside it, or you are offered to add them.</p>
          </div>`}
        ${open.map((p) => html`<${Browser} key=${p} url=${chats[p].url} n=${chats[p].n} partition=${CHAT_PARTITION} off=${p !== active} onLocation=${(loc) => onLocation(p, loc)} onMessage=${(channel, args) => { if (channel === 'stillmail-notification') onNote(p, args[0]); }} onView=${(wv) => { if (wv) panes[p] = wv; else delete panes[p]; }} label=${`${PLATFORMS[p].name} conversation`} onClose=${() => closeChat(p)} />`)}
      </div>
    </div>`;
}

// ------------------------------------------------------------------ view

/** Mounted from the first visit onwards, so open conversations survive a trip to another tab. */
export function Testers({ shown }) {
  const t = S.testers;
  useEffect(() => { T({ visited: true }); loadTesters(); }, []);
  useEffect(() => {
    // Pick up edits made in Notion when coming back to the window.
    const onFocus = () => { if (S.view === 'testers' && S.testers.status?.connected && Date.now() - loadedAt > 60000) loadTesters({ quiet: true }); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const chatting = t.browser;
  const row = t.rows.find((r) => r.id === t.sel);
  const unlinked = chatting && t.active && t.here && t.dismissed !== t.here.key && !ownerOf(t.here.key) ? t.here : null;
  const ready = t.status?.connected && t.schema && !t.connecting;
  return html`
    <main class=${cx('testers', !shown && 'off', chatting && 'chatting', chatting && t.wide && !S.open && 'wide')}>
      ${ready ? html`<${People} />${unlinked ? html`<${Unlinked} key=${unlinked.key} here=${unlinked} />` : row && html`<${Detail} row=${row} />`}`
        : !t.status ? html`<div class="empty">${t.error || 'Loading…'}</div>`
        : t.status.connected && !t.connecting ? html`<div class="empty">${t.error ? html`${t.error} <button class="btn small" onClick=${() => loadTesters()}>Try again</button> <button class="btn small" onClick=${() => T({ connecting: true })}>Connection…</button>` : 'Loading from Notion…'}</div>`
        : html`<div class="main" style=${{ flex: 1 }}><${Connection} /></div>`}
      ${(chatting || Object.keys(t.chats).length > 0) && html`<${Chats} off=${!shown || !!S.open || !chatting} />`}
      ${ready && html`<${Notes} />`}
    </main>`;
}
