// Testers tab: the people you are talking to during a test programme, kept in one Notion database,
// with each person's conversations (Instagram, Discord, Slack, Teams, email) one click away.

import { html, useState, useEffect, cx } from './util.mjs';
import { S, api, set, toast, openMessage, closeReader } from './store.mjs';
import { newDraft } from './compose.mjs';
import { Browser } from './webpane.mjs';
import { PLATFORMS, linkFromInput } from '../core/notion.mjs';

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

async function addPerson(name) {
  try {
    const row = await api.notionCreate({ name });
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
  return T({ chats: { ...chats, [link.platform]: reuse ? cur : { url: link.url, n: (cur?.n || 0) + 1 } }, active: link.platform });
}

function closeChat(platform) {
  const { [platform]: _, ...chats } = S.testers.chats;
  T({ chats, active: Object.keys(chats)[0] || null, wide: Object.keys(chats).length ? S.testers.wide : false });
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
          <div class=${cx('row', sel === r.id && 'sel')} key=${r.id} tabindex="0" onClick=${() => T({ sel: r.id })} onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) T({ sel: r.id }); }}>
            <span class="who">${r.name || 'Unnamed'}</span>
            <span class="t-rowtags">${tagField && (r.values[tagField.name] || []).map((t) => html`<${Tag} key=${t} name=${t} color=${colorOf(tagField, t)} />`)}</span>
            <span class="t-links" onClick=${(e) => e.stopPropagation()}>
              ${r.links.filter((l) => l.platform !== 'note').map((l, i) => html`
                <button class="plat-btn" key=${i} title=${`${PLATFORMS[l.platform].name}: ${linkText(l)}`} aria-label=${`Open ${PLATFORMS[l.platform].name} conversation with ${r.name}: ${linkText(l)}`}
                  onClick=${(e) => { T({ sel: r.id }); openConversation(l, e); }}><${Badge} platform=${l.platform} /></button>`)}
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

// ------------------------------------------------------------------ conversations

function Chats({ off }) {
  const { chats, active, wide } = S.testers;
  const open = Object.keys(chats);
  return html`
    <div class=${cx('chat-stack', off && 'off')}>
      <div class="chat-tabs">
        <button class="btn ghost small" onClick=${() => T({ wide: !wide })} title=${wide ? 'Show the list of people' : 'Give the conversation the whole window'}>${wide ? '⇥ People' : '⇤ Wider'}</button>
        ${open.map((p) => html`<button key=${p} class=${cx('chat-tab', p === active && 'on')} aria-pressed=${p === active} onClick=${() => T({ active: p })}><${Badge} platform=${p} />${PLATFORMS[p].name}</button>`)}
      </div>
      <div class="chat-panes">
        ${open.map((p) => html`<${Browser} key=${p} url=${chats[p].url} n=${chats[p].n} partition=${CHAT_PARTITION} off=${p !== active} label=${`${PLATFORMS[p].name} conversation`} onClose=${() => closeChat(p)} />`)}
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
  const chatting = !!t.active;
  const row = t.rows.find((r) => r.id === t.sel);
  const ready = t.status?.connected && t.schema && !t.connecting;
  return html`
    <main class=${cx('testers', !shown && 'off', chatting && 'chatting', chatting && t.wide && !S.open && 'wide')}>
      ${ready ? html`<${People} />${row && html`<${Detail} row=${row} />`}`
        : !t.status ? html`<div class="empty">${t.error || 'Loading…'}</div>`
        : t.status.connected && !t.connecting ? html`<div class="empty">${t.error ? html`${t.error} <button class="btn small" onClick=${() => loadTesters()}>Try again</button> <button class="btn small" onClick=${() => T({ connecting: true })}>Connection…</button>` : 'Loading from Notion…'}</div>`
        : html`<div class="main" style=${{ flex: 1 }}><${Connection} /></div>`}
      ${chatting && html`<${Chats} off=${!shown || !!S.open} />`}
    </main>`;
}
