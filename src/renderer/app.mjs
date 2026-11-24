import { html, render, useState, useMemo, useEffect, useRef, cx, ago, fullDate, displayName } from './util.mjs';
import {
  S, api, init, set, useStore, passes, toggleIn, cutoffs, ageBand, accountOf, openMessage, closeReader,
  markDone, undoDone, ack, bump, bumpTargetFor, isUnread, dismissTopic, toggleFlag, toggleQuiet, toggleSenderTopic, setSenderKind, setSetting, mutate, toast,
} from './store.mjs';
import { DAY, baseSubject, topicRows } from '../core/classify.mjs';
import { Compose, newDraft, startReply } from './compose.mjs';
import { Reader } from './reader.mjs';
import { Search } from './search.mjs';
import { Settings, Welcome, RuleEditor } from './settings.mjs';
import { Avatar, OrgChip, Swatch } from './avatar.mjs';
import { WebPane, closeWeb } from './webpane.mjs';

const PERIODS = [[1, '24h'], [3, '3d'], [7, '7d'], [30, '30d'], [90, '90d']];

// ------------------------------------------------------------------ sidebar

function TagTree() {
  const { model, tagSel } = S;
  const [filter, setFilter] = useState('');
  const [openNodes, setOpenNodes] = useState(new Set());
  const far = cutoffs().far;

  const orgs = useMemo(() => {
    const topicsByAddr = new Map();
    for (const t of model.topics.values()) {
      if (t.lastTs < far && !tagSel.has(`t:${t.key}`)) continue;
      if (!topicsByAddr.has(t.addr)) topicsByAddr.set(t.addr, []);
      topicsByAddr.get(t.addr).push(t);
    }
    const map = new Map();
    for (const s of model.senders.values()) {
      if (s.lastTs < far && !tagSel.has(`c:${s.addr}`) && !tagSel.has(`o:${s.root}`)) continue;
      let o = map.get(s.root);
      if (!o) map.set(s.root, (o = { root: s.root, org: s.org, n: 0, channels: [] }));
      const n = s.msgs.reduce((c, m) => c + (m.ts >= far ? 1 : 0), 0);
      o.n += n;
      o.channels.push({ ...s, n, topics: (topicsByAddr.get(s.addr) || []).sort((a, b) => b.lastTs - a.lastTs) });
    }
    return [...map.values()].sort((a, b) => b.n - a.n || a.org.localeCompare(b.org));
  }, [model, tagSel]);

  const f = filter.trim().toLowerCase();
  const match = (s) => s.toLowerCase().includes(f);
  const visible = f
    ? orgs.filter((o) => match(o.root) || o.channels.some((c) => match(c.addr) || match(c.name) || c.topics.some((t) => match(t.label))))
    : orgs;
  const toggleOpen = (id) => { const n = new Set(openNodes); if (n.has(id)) n.delete(id); else n.add(id); setOpenNodes(n); };
  const node = (id, level, label, count, hasKids, extra) => html`
    <div class=${cx('node', `l${level}`, tagSel.has(id) && 'on')} key=${id}>
      ${hasKids ? html`<button class="tw" onClick=${() => toggleOpen(id)} aria-label="Expand">${openNodes.has(id) || f ? '▾' : '▸'}</button>` : html`<span class="tw"></span>`}
      <input type="checkbox" checked=${tagSel.has(id)} onChange=${() => toggleIn('tagSel', id)} aria-label=${`Filter by ${label}`} />
      ${extra?.root && html`<${Swatch} root=${extra.root} />`}
      <span class="nm" title=${extra?.title || label} onClick=${() => toggleIn('tagSel', id)}>${label}</span>
      ${extra?.kind && html`<span class="kind">${extra.kind}</span>`}
      <span class="ct">${count}</span>
    </div>`;

  return html`
    <div class="side-h"><span>Org / channel / topic</span>${tagSel.size > 0 && html`<button onClick=${() => set({ tagSel: new Set() })}>Clear</button>`}</div>
    <input class="input tree-filter" value=${filter} onInput=${(e) => setFilter(e.target.value)} placeholder="Find…" aria-label="Find org, channel or topic" />
    <div class="tree-wrap">
      ${visible.slice(0, 250).map((o) => {
        const oid = `o:${o.root}`;
        const showKids = openNodes.has(oid) || !!f;
        return html`
          ${node(oid, 0, o.org, o.n, true, { title: o.root, root: o.root })}
          ${showKids && o.channels.map((c) => {
            const cid = `c:${c.addr}`;
            const kidsOpen = openNodes.has(cid) || (!!f && c.topics.some((t) => match(t.label)));
            return html`
              ${node(cid, 1, c.kind === 'channel' ? c.channel : c.name || c.channel, c.n, c.topics.length > 0, { title: c.addr, kind: c.kind === 'important' ? 'person' : c.kind === 'new' ? 'new' : null })}
              ${kidsOpen && c.topics.map((t) => node(`t:${t.key}`, 2, t.label, t.count))}`;
          })}`;
      })}
      ${visible.length === 0 && html`<div class="empty">Nothing matches</div>`}
    </div>`;
}

function SyncStatus() {
  const { accounts, progress, errors, demo } = S;
  if (demo) return html`<div class="sync">Demo data — no mail is read or sent.</div>`;
  return html`
    <div class="sync">
      ${accounts.map((a) => {
        const p = progress[a.email];
        if (errors[a.email]) return html`<div class="err" key=${a.email}>${a.label}: ${errors[a.email]}</div>`;
        if (p && p.phase !== 'idle' && p.total) {
          return html`<div key=${a.email}>${a.label}: syncing ${p.phase} ${p.done.toLocaleString()} / ${p.total.toLocaleString()}<div class="bar"><i style=${{ width: `${(100 * p.done) / p.total}%` }}></i></div></div>`;
        }
        return html`<div key=${a.email}>${a.label}: ${p?.at ? `synced ${ago(p.at)} ago`.replace('now ago', 'just now') : 'connecting…'}</div>`;
      })}
    </div>`;
}

function Sidebar() {
  const { view, accounts, acctSel, demo, model } = S;
  const nav = (id, label, key) => html`<button class=${cx(view === id && 'on')} onClick=${() => set({ view: id })}>${label}<kbd>${key}</kbd></button>`;
  return html`
    <aside class="side">
      <div class="brand">Stillmail ${demo && html`<small>demo</small>`}</div>
      <button class="btn primary compose-btn" onClick=${() => newDraft()} disabled=${!accounts.length} title="Compose (c)">Compose</button>
      <div class="nav">
        ${nav('home', 'Focus', 'g')}
        ${nav('search', 'Search', '/')}
        ${nav('settings', 'Settings', ',')}
      </div>
      ${accounts.length > 0 && html`
        <div class="side-h"><span>Accounts</span>${acctSel.size > 0 && html`<button onClick=${() => set({ acctSel: new Set() })}>All</button>`}</div>
        <div class="chips">
          ${accounts.map((a) => html`
            <button class=${cx('chip', acctSel.has(a.email) && 'on')} key=${a.email} title=${a.email} aria-pressed=${acctSel.has(a.email)} onClick=${() => toggleIn('acctSel', a.email)}>
              <i class="dot" style=${{ background: a.color }}></i>${a.label}
            </button>`)}
        </div>`}
      ${model && accounts.length > 0 ? html`<${TagTree} />` : html`<div style=${{ flex: 1 }}></div>`}
      ${accounts.length > 0 && html`<${SyncStatus} />`}
    </aside>`;
}

// ------------------------------------------------------------------ home rows
//
// People, Attention and Notifications are the same thing three times: a time-tabbed list of
// rows, newest first by "effective date" (received, or last bumped), each row offering its own
// actions, then Bump, then a way to dismiss it. They share Section and Row; only what a row
// says, and what dismissing means, differs.

/** `Org › channel › topic`, the organisation underlined in its colour. */
function OrgPath({ root, org, channel, label, addr, grow }) {
  return html`<span class="path" style=${grow ? { flex: 1 } : null} title=${addr}><${OrgChip} root=${root} org=${org} /><span class="sep">›</span>${channel}${label && html`<span class="sep">›</span>${label}`}</span>`;
}

function Path({ m }) {
  const s = S.model.senders.get(m.from.addr);
  const t = m.topic && S.model.topics.get(m.topic);
  if (!s) return html`<span class="path">${m.from.addr}</span>`;
  if (s.kind !== 'channel') return html`<span class="path"><b>${displayName(m.from)}</b><span class="sep">·</span>${s.addr}</span>`;
  return html`<${OrgPath} root=${s.root} org=${s.org} channel=${s.channel} label=${t?.label} addr=${s.addr} />`;
}

const Subject = ({ m, base, you }) => html`
  <span class="subj">${(base ? baseSubject(m.subject) : m.subject) || '(no subject)'} ${m.snippet && m.snippet !== m.subject && html`<span class="snip">— ${you ? 'You: ' : ''}${m.snippet}</span>`}</span>`;

/**
 * One list row, for a message or a topic.
 *   item     what Bump applies to: anything with a `key` (a message or a topic)
 *   eff, ts  effective date (drives fading) and real date (what the age shows)
 *   avatar   {addr, name, acct}
 *   actions  buttons specific to this kind of row; Bump and `dismiss` {label, title, onClick} follow them
 */
function Row({ item, eff, ts, avatar, children, actions, dismiss, onOpen, selected, unread, flagged, count, fresh, waiting }) {
  const bumpedAt = S.user.bumped[item.key];
  const { now } = cutoffs();
  const band = fresh ? 'fresh' : ageBand(eff);
  const overdue = waiting && now - ts > S.user.settings.nearDays * DAY;
  return html`
    <div class=${cx('row', band, selected && 'sel')} onClick=${onOpen} tabindex="0" onKeyDown=${(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); }}>
      <${Avatar} ...${avatar} />
      ${children}
      <span class="row-actions" onClick=${(e) => e.stopPropagation()}>
        ${actions}
        <button class="btn small" title="Move to the top and keep it from fading (b)" onClick=${() => bump(item)}>Bump</button>
        <button class="btn small" title=${dismiss.title} onClick=${dismiss.onClick}>${dismiss.label}</button>
      </span>
      ${unread && html`<span class="unread" title="Unread"></span>`}
      ${flagged && html`<i class="flagdot" title="Has mail flagged for attention"></i>`}
      ${bumpedAt && html`<span class="bumped" title=${`Bumped ${fullDate(bumpedAt)}`}>↑</span>`}
      ${count > 1 && html`<span class="count">×${count}</span>`}
      <span class=${cx('age', overdue && 'wait')} title=${fullDate(ts)}>${overdue ? `waiting ${ago(ts, now)}` : ago(ts, now)}</span>
    </div>`;
}

const undoable = (text, undo) => toast(text, { action: 'Undo', onAction: () => { undo(); set({ toast: null }); } });
const avatarOf = (m) => ({ addr: m.from.addr, name: m.from.name, acct: m.acct });

function PersonRow({ m }) {
  return html`
    <${Row} item=${m} eff=${m.eff} ts=${m.ts} avatar=${{ addr: m.peer.addr, name: m.peer.name, acct: m.acct }} onOpen=${() => openMessage(m)} selected=${S.open?.key === m.key} unread=${isUnread(m)} waiting=${m.awaiting}
      actions=${html`<button class="btn small" onClick=${() => startReply(m, 'reply')}>Reply</button>`}
      dismiss=${{ label: 'Dismiss', title: 'Remove from People until the conversation moves on', onClick: () => { markDone(m); undoable('Dismissed until there is something new', () => undoDone(m)); } }}>
      <span class=${cx('who', !m.awaiting && 'mine')}>${displayName(m.peer)}</span>
      <${Subject} m=${m} base you=${!m.awaiting} />
    <//>`;
}

function AttentionRow({ m }) {
  const flagged = !!S.user.flagged[m.key];
  return html`
    <${Row} item=${m} eff=${m.eff} ts=${m.ts} avatar=${avatarOf(m)} onOpen=${() => openMessage(m)} selected=${S.open?.key === m.key} unread=${isUnread(m)} fresh=${flagged}
      actions=${html`
        ${m.kind === 'new' && html`<button class="btn small" title="This sender is a person: show their mail in People" onClick=${() => setSenderKind(m.from.addr, 'important')}>Person</button>`}
        ${m.topic && !flagged && html`<button class="btn small" title="Stop flagging this topic" onClick=${() => { toggleQuiet(m.topic); undoable('This topic will not be flagged again', () => toggleQuiet(m.topic)); }}>Never flag topic</button>`}`}
      dismiss=${{ label: flagged ? 'Unflag' : 'Dismiss', title: 'Remove from Attention', onClick: () => ack(m) }}>
      <div class="attn-main">
        <div class="l1">
          ${m.reasons.map((r) => html`<span class=${cx('reason', r.type === 'keyword' && 'kw')}>${r.text}</span>`)}
          <span class="subj">${m.subject || '(no subject)'}</span>
        </div>
        <div class="l2"><${Path} m=${m} /></div>
      </div>
    <//>`;
}

/** A notification topic: a row like the others, which unfolds to the topic's recent mail. */
function TopicRow({ row: { topic: t, msgs, flagged, eff } }) {
  const open = S.expanded.has(t.key);
  const latest = msgs[0];
  const single = !!S.user.senderTopic[t.addr];
  return html`
    <div class="topic" data-topic=${t.key}>
      <${Row} item=${t} eff=${eff} ts=${latest.ts} avatar=${{ addr: t.addr, acct: latest.acct }} onOpen=${() => toggleIn('expanded', t.key)} flagged=${flagged} count=${msgs.length}
        dismiss=${{ label: 'Dismiss', title: 'Hide this topic until a new email arrives on it', onClick: () => dismissTopic(t) }}>
        <${OrgPath} root=${t.root} org=${t.org} channel=${t.channel} label=${t.label} addr=${t.addr} grow />
      <//>
      ${open && html`
        <div class="topic-body">
          <div class="topic-tools">
            <button class="btn small" title=${`Group everything from ${t.addr} as one topic, whatever the subject`}
              onClick=${() => { toggleSenderTopic(t.addr); if (!single) set({ expanded: new Set([...S.expanded].filter((k) => !k.startsWith(`${t.addr}|`)).concat(`${t.addr}|*`)) }); }}>
              ${single ? 'Split this sender by subject' : 'One topic for this sender'}</button>
            ${!single && html`<button class="btn small" onClick=${() => set({ ruleEditor: { topic: t } })}>Define topic by pattern…</button>`}
            <button class="btn small" onClick=${() => toggleQuiet(t.key)}>${S.user.quietTopics[t.key] ? 'Flag this topic again' : 'Never flag this topic'}</button>
            <button class="btn small" onClick=${() => setSenderKind(t.addr, 'important')} title=${`Treat ${t.addr} as a person: show their mail in People`}>Sender is a person</button>
          </div>
          ${msgs.slice(0, 40).map((m) => html`
            <div class=${cx('row', ageBand(m.ts), S.open?.key === m.key && 'sel')} key=${m.key} onClick=${() => openMessage(m)}>
              <${Subject} m=${m} />
              <span class="row-actions" onClick=${(e) => e.stopPropagation()}>
                <button class="btn small" onClick=${() => toggleFlag(m)}>${S.user.flagged[m.key] ? 'Unflag' : 'Flag'}</button>
              </span>
              <span class="age" title=${fullDate(m.ts)}>${ago(m.ts, cutoffs().now)}</span>
            </div>`)}
          ${msgs.length > 40 && html`<div class="empty">${msgs.length - 40} more in this period — use Search to see them all.</div>`}
        </div>`}
    </div>`;
}

// ------------------------------------------------------------------ home

/** The time tabs at the top of each home section; `k` is the setting holding the chosen number of days. */
function PeriodTabs({ k, label }) {
  const value = S.user.settings[k];
  return html`
    <span class="seg" role="group" aria-label=${`${label} period`}>
      ${PERIODS.map(([d, text]) => html`<button class=${cx(value === d && 'on')} aria-pressed=${value === d} onClick=${() => setSetting(k, d)}>${text}</button>`)}
    </span>`;
}
const periodLabel = (days) => PERIODS.find(([d]) => d === days)?.[1] || `${days}d`;

/** A home section: heading, hint, optional tools, its own time tabs, and a card of rows. */
function Section({ label, hint, periodKey, tools, attn, children }) {
  return html`
    <section class="section" aria-label=${label}>
      <div class="section-h"><h2>${label}</h2><span class="hint">${hint}</span>
        ${tools}
        <${PeriodTabs} k=${periodKey} label=${label} />
      </div>
      <div class=${cx('card', attn && 'attn')}>${children}</div>
    </section>`;
}

function ActiveFilters() {
  const { tagSel, acctSel, model } = S;
  if (!tagSel.size && !acctSel.size) return null;
  const label = (id) => {
    const v = id.slice(2);
    if (id[0] === 'o') return v;
    if (id[0] === 'c') return v;
    const t = model.topics.get(v);
    return t ? `${t.org} › ${t.channel} › ${t.label}` : v;
  };
  return html`
    <div class="filters-on">
      Showing only
      ${[...acctSel].map((e) => html`<span class="pill" key=${e}>${accountOf(e).label}<button aria-label="Remove filter" onClick=${() => toggleIn('acctSel', e)}>✕</button></span>`)}
      ${[...tagSel].map((id) => html`<span class="pill" key=${id}>${label(id)}<button aria-label="Remove filter" onClick=${() => toggleIn('tagSel', id)}>✕</button></span>`)}
      <button class="btn ghost small" onClick=${() => set({ tagSel: new Set(), acctSel: new Set() })}>Clear all</button>
    </div>`;
}

function Home() {
  const { model, user } = S;
  const [showOld, setShowOld] = useState(false);
  const [attnAll, setAttnAll] = useState(false);
  const { now } = cutoffs();
  const st = user.settings;
  const since = (days) => now - days * DAY;

  const needs = model.people.filter(passes);
  const needsCurrent = needs.filter((m) => m.eff >= since(st.needsPeriod));
  const needsOld = needs.filter((m) => m.eff < since(st.needsPeriod));
  const attention = model.attention.filter(passes);
  const topics = useMemo(
    () => topicRows(model.topics.values(), user, { cut: since(st.period), passes }),
    [model, st.period, S.acctSel, S.tagSel, user.topicDismissed, user.bumped],
  );

  const attnShown = attnAll ? attention : attention.slice(0, 8);
  return html`
    <div class="main-inner">
      <${ActiveFilters} />
      <${Section} label="People" hint="Conversations with people, whoever wrote last" periodKey="needsPeriod">
        ${needsCurrent.map((m) => html`<${PersonRow} key=${m.key} m=${m} />`)}
        ${needsCurrent.length === 0 && html`<div class="empty">${needsOld.length ? 'No conversations with people in this period.' : 'No conversations with people yet.'}</div>`}
        ${showOld && needsOld.map((m) => html`<${PersonRow} key=${m.key} m=${m} />`)}
        ${needsOld.length > 0 && html`<button class="more" onClick=${() => setShowOld(!showOld)}>${showOld ? 'Hide' : 'Show'} older than ${periodLabel(st.needsPeriod)}</button>`}
      <//>

      <${Section} label="Attention" hint="Out of the ordinary: new or rare topics, alarm words, unfamiliar senders, and anything you flag" periodKey="attnPeriod" attn
        tools=${attention.length > 1 && html`<button class="btn ghost small" onClick=${() => { const list = attention.filter((m) => !user.flagged[m.key]); mutate((u) => { for (const m of list) u.acked[m.key] = true; }); }}>Dismiss all</button>`}>
        ${attnShown.map((m) => html`<${AttentionRow} key=${m.key} m=${m} />`)}
        ${attention.length === 0 && html`<div class="empty">Nothing unusual in this period.</div>`}
        ${attention.length > 8 && html`<button class="more" onClick=${() => setAttnAll(!attnAll)}>${attnAll ? 'Show fewer' : 'Show all'}</button>`}
      <//>

      <${Section} label="Notifications" hint="By topic, most recent first. Nothing here needs action." periodKey="period">
        ${topics.map((row) => html`<${TopicRow} key=${row.topic.key} row=${row} />`)}
        ${topics.length === 0 && html`<div class="empty">No notifications in this period.</div>`}
      <//>
    </div>`;
}

// ------------------------------------------------------------------ shell

function onGlobalKey(e) {
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  if (e.key === 'Escape') {
    if (S.ruleEditor) set({ ruleEditor: null });
    else if (typing) e.target.blur();
    else if (S.finding) set({ finding: false });
    else if (S.web) closeWeb();
    else if (S.open) closeReader();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && !S.compose && !S.ruleEditor) {
    e.preventDefault();
    if (S.open && S.view !== 'settings') { set({ finding: true }); document.querySelector('.find input')?.select(); }
    else set({ view: 'search' });
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || S.compose || S.ruleEditor) return;
  const thread = S.open && S.model?.threads.get(`${S.open.acct}:${S.open.threadId}`);
  const target = thread && ([...thread].reverse().find((m) => m.kind !== 'me') || thread[thread.length - 1]);
  const keys = {
    c: () => S.accounts.length && newDraft(),
    '/': () => set({ view: 'search' }),
    g: () => set({ view: 'home' }),
    ',': () => set({ view: 'settings' }),
    r: () => target && startReply(target, 'reply'),
    a: () => target && startReply(target, 'replyAll'),
    f: () => target && startReply(target, 'forward'),
    b: () => {
      const item = bumpTargetFor(target);
      if (item) bump(item);
    },
    e: () => {
      if (!target) return;
      const waiting = S.model.people.find((m) => m.acct === S.open.acct && m.threadId === S.open.threadId);
      if (waiting) markDone(waiting); else if (target.reasons) ack(target);
      closeReader();
    },
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
}

function App() {
  const s = useStore();
  useEffect(() => {
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, []);
  if (!s.ready) return html`<div class="empty">Loading…</div>`;
  const noAccounts = s.accounts.length === 0;
  const reading = !!s.open && !noAccounts && s.view !== 'settings';
  return html`
    <div class=${cx('app', reading && 'reading', reading && s.web && 'browsing')}>
      <${Sidebar} />
      ${noAccounts && s.view !== 'settings'
        ? html`<main class="main"><${Welcome} /></main>`
        : s.view === 'search' ? html`<main style=${{ minWidth: 0, minHeight: 0 }}><${Search} /></main>`
        : s.view === 'settings' ? html`<main class="main"><${Settings} /></main>`
        : html`<main class="main"><${Home} /></main>`}
      ${reading && html`<${Reader} />`}
      ${reading && s.web && html`<${WebPane} />`}
      ${s.compose && html`<${Compose} key=${s.compose.title + (s.compose.inReplyTo || '')} />`}
      ${s.ruleEditor && html`<${RuleEditor} />`}
      ${s.toast && html`
        <div class="toast" role="status">${s.toast.text}
          ${s.toast.action && html`<button onClick=${s.toast.onAction}>${s.toast.action}</button>`}
        </div>`}
    </div>`;
}

init().then(() => render(html`<${App} />`, document.getElementById('root')), (e) => {
  document.getElementById('root').textContent = `Stillmail failed to start: ${e.message}`;
});
