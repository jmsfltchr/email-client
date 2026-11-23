import { html, render, useState, useMemo, useEffect, useRef, cx, ago, fullDate, displayName } from './util.mjs';
import {
  S, api, init, set, useStore, passes, toggleIn, cutoffs, ageBand, accountOf, openMessage, closeReader,
  markDone, undoDone, ack, bump, isUnread, toggleFlag, toggleQuiet, toggleSenderTopic, setSenderKind, setSetting, mutate, toast,
} from './store.mjs';
import { DAY, orderTopics, reorder, baseSubject } from '../core/classify.mjs';
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

function PersonRow({ m }) {
  const band = ageBand(m.eff);
  const bumped = S.user.bumped[m.key];
  const { now } = cutoffs();
  return html`
    <div class=${cx('row', band, S.open?.key === m.key && 'sel')} onClick=${() => openMessage(m)} tabindex="0"
      onKeyDown=${(e) => { if (e.key === 'Enter') openMessage(m); }}>
      <${Avatar} addr=${m.from.addr} name=${m.from.name} acct=${m.acct} />
      <span class="who">${displayName(m.from)}</span>
      <span class="subj">${baseSubject(m.subject) || '(no subject)'} ${m.snippet && m.snippet !== m.subject && html`<span class="snip">— ${m.snippet}</span>`}</span>
      <span class="row-actions" onClick=${(e) => e.stopPropagation()}>
        <button class="btn small" onClick=${() => startReply(m, 'reply')}>Reply</button>
        <button class="btn small" title="Move to the top and keep it from fading (b)" onClick=${() => bump(m)}>Bump</button>
        <button class="btn small" title="Remove from this list without replying"
          onClick=${() => { markDone(m); toast('No reply needed', { action: 'Undo', onAction: () => { undoDone(m); set({ toast: null }); } }); }}>No reply needed</button>
      </span>
      ${isUnread(m) && html`<span class="unread" title="Unread"></span>`}
      ${bumped && html`<span class="bumped" title=${`Bumped ${fullDate(bumped)}`}>↑</span>`}
      <span class=${cx('age', (band !== 'fresh' || bumped) && now - m.ts > S.user.settings.nearDays * DAY && 'wait')} title=${fullDate(m.ts)}>${now - m.ts > S.user.settings.nearDays * DAY ? `waiting ${ago(m.ts, now)}` : ago(m.ts, now)}</span>
    </div>`;
}

function Path({ m }) {
  const s = S.model.senders.get(m.from.addr);
  const t = m.topic && S.model.topics.get(m.topic);
  if (!s) return html`<span class="path">${m.from.addr}</span>`;
  if (s.kind !== 'channel') return html`<span class="path"><b>${displayName(m.from)}</b><span class="sep">·</span>${s.addr}</span>`;
  return html`<span class="path" title=${s.addr}><${OrgChip} root=${s.root} org=${s.org} /><span class="sep">›</span>${s.channel}${t && html`<span class="sep">›</span>${t.label}`}</span>`;
}

function AttentionRow({ m }) {
  const flagged = !!S.user.flagged[m.key];
  return html`
    <div class=${cx('row', ageBand(m.eff) === 'fresh' || flagged ? 'fresh' : 'fading', S.open?.key === m.key && 'sel')} onClick=${() => openMessage(m)} tabindex="0"
      onKeyDown=${(e) => { if (e.key === 'Enter') openMessage(m); }}>
      <${Avatar} addr=${m.from.addr} name=${m.from.name} acct=${m.acct} />
      <div class="attn-main">
        <div class="l1">
          ${m.reasons.map((r) => html`<span class=${cx('reason', r.type === 'keyword' && 'kw')}>${r.text}</span>`)}
          <span class="subj">${m.subject || '(no subject)'}</span>
        </div>
        <div class="l2"><${Path} m=${m} /></div>
      </div>
      <span class="row-actions" onClick=${(e) => e.stopPropagation()}>
        ${m.kind === 'new' && html`<button class="btn small" title="Treat this sender as an important person" onClick=${() => setSenderKind(m.from.addr, 'important')}>Important</button>`}
        ${m.topic && !flagged && html`<button class="btn small" title="Stop flagging this topic" onClick=${() => { toggleQuiet(m.topic); toast('This topic will not be flagged again', { action: 'Undo', onAction: () => { toggleQuiet(m.topic); set({ toast: null }); } }); }}>Never flag topic</button>`}
        <button class="btn small" title="Move to the top and keep it from fading (b)" onClick=${() => bump(m)}>Bump</button>
        <button class="btn small" onClick=${() => ack(m)}>${flagged ? 'Unflag' : 'Dismiss'}</button>
      </span>
      ${isUnread(m) && html`<span class="unread" title="Unread"></span>`}
      ${S.user.bumped[m.key] && html`<span class="bumped" title=${`Bumped ${fullDate(S.user.bumped[m.key])}`}>↑</span>`}
      <span class="age" title=${fullDate(m.ts)}>${ago(m.ts, cutoffs().now)}</span>
    </div>`;
}

// ------------------------------------------------------------------ topics

function TopicList({ rows }) {
  const [dragKey, setDragKey] = useState(null);
  const [over, setOver] = useState(null); // {key, after}
  const keys = rows.map((r) => r.topic.key);
  const ranked = new Set(S.user.topicOrder);
  const move = (key, target, after) => {
    if (!target || key === target) return;
    mutate((u) => { u.topicOrder = reorder(u.topicOrder, keys, key, target, after); });
  };
  const end = () => { setDragKey(null); setOver(null); };

  return rows.map(({ topic: t, msgs, flagged }, i) => {
    const open = S.expanded.has(t.key);
    const latest = msgs[0];
    return html`
      <div key=${t.key} data-topic=${t.key}
        class=${cx('topic', dragKey === t.key && 'dragging', over?.key === t.key && dragKey !== t.key && (over.after ? 'drop-after' : 'drop-before'))}
        onDragOver=${(e) => {
          if (!dragKey) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          if (over?.key !== t.key || over.after !== after) setOver({ key: t.key, after });
        }}
        onDrop=${(e) => { e.preventDefault(); if (dragKey && over) move(dragKey, over.key, over.after); end(); }}>
        <div class=${cx('row', ageBand(latest.ts))} onClick=${() => toggleIn('expanded', t.key)}>
          <span class="handle" draggable="true" tabindex="0" role="button" aria-label=${`Reorder ${t.org} ${t.channel} ${t.label}. Use Alt+Up or Alt+Down.`}
            title="Drag to set priority (Alt+↑/↓)"
            onClick=${(e) => e.stopPropagation()}
            onDragStart=${(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', t.key);
              const row = e.currentTarget.closest('.topic');
              if (row) e.dataTransfer.setDragImage(row, 12, 14);
              setDragKey(t.key);
            }}
            onDragEnd=${end}
            onKeyDown=${(e) => {
              if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
              e.preventDefault();
              const up = e.key === 'ArrowUp';
              move(t.key, keys[i + (up ? -1 : 1)], !up);
            }}>⠿</span>
          <${Avatar} addr=${t.addr} acct=${latest.acct} />
          <span class="path" style=${{ flex: 1 }} title=${t.addr}><${OrgChip} root=${t.root} org=${t.org} /><span class="sep">›</span>${t.channel}<span class="sep">›</span>${t.label}</span>
          ${flagged && html`<i class="flagdot" title="Has mail flagged for attention"></i>`}
          ${ranked.has(t.key) && html`<span class="pinned" title="In your priority order">●</span>`}
          <span class="count">${msgs.length > 1 ? `×${msgs.length}` : ''}</span>
          <span class="age" title=${fullDate(latest.ts)}>${ago(latest.ts, cutoffs().now)}</span>
        </div>
        ${open && html`
          <div class="topic-body">
            <div class="topic-tools" onClick=${(e) => e.stopPropagation()}>
              <button class="btn small" title=${`Group everything from ${t.addr} as one topic, whatever the subject`}
                onClick=${() => { const key = `${t.addr}|*`; const on = !S.user.senderTopic[t.addr]; toggleSenderTopic(t.addr); if (on) set({ expanded: new Set([...S.expanded].filter((k) => !k.startsWith(`${t.addr}|`)).concat(key)) }); }}>
                ${S.user.senderTopic[t.addr] ? 'Split this sender by subject' : 'One topic for this sender'}</button>
              ${!S.user.senderTopic[t.addr] && html`<button class="btn small" onClick=${() => set({ ruleEditor: { topic: t } })}>Define topic by pattern…</button>`}
              <button class="btn small" onClick=${() => toggleQuiet(t.key)}>${S.user.quietTopics[t.key] ? 'Flag this topic again' : 'Never flag this topic'}</button>
              <button class="btn small" onClick=${() => setSenderKind(t.addr, 'important')} title=${`Treat ${t.addr} as a person you need to answer`}>Sender is important</button>
              ${ranked.has(t.key) && html`<button class="btn small" onClick=${() => mutate((u) => { u.topicOrder = u.topicOrder.filter((k) => k !== t.key); })}>Remove from priority order</button>`}
            </div>
            ${msgs.slice(0, 40).map((m) => html`
              <div class=${cx('row', ageBand(m.ts), S.open?.key === m.key && 'sel')} key=${m.key} onClick=${() => openMessage(m)}>
                <span class="subj">${m.subject || '(no subject)'} ${m.snippet && m.snippet !== m.subject && html`<span class="snip">— ${m.snippet}</span>`}</span>
                <span class="row-actions" onClick=${(e) => e.stopPropagation()}>
                  <button class="btn small" onClick=${() => toggleFlag(m)}>${S.user.flagged[m.key] ? 'Unflag' : 'Flag'}</button>
                </span>
                <span class="age" title=${fullDate(m.ts)}>${ago(m.ts, cutoffs().now)}</span>
              </div>`)}
            ${msgs.length > 40 && html`<div class="empty">${msgs.length - 40} more in this period — use Search to see them all.</div>`}
          </div>`}
      </div>`;
  });
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
  const c = cutoffs();
  const period = user.settings.period;

  const needs = model.needsReply.filter(passes);
  const needsCut = c.now - user.settings.needsPeriod * DAY;
  const needsCurrent = needs.filter((m) => m.eff >= needsCut);
  const needsOld = needs.filter((m) => m.eff < needsCut);
  const attention = model.attention.filter(passes);

  const rows = useMemo(() => {
    const cut = c.now - period * DAY;
    const out = [];
    for (const t of model.topics.values()) {
      if (t.lastTs < cut) continue;
      const msgs = [];
      let flagged = false;
      for (let i = t.msgs.length - 1; i >= 0 && t.msgs[i].ts >= cut; i--) {
        const m = t.msgs[i];
        if (!passes(m)) continue;
        msgs.push(m);
        if (user.flagged[m.key] || (m.reasons && !user.acked[m.key])) flagged = true;
      }
      if (msgs.length) out.push({ topic: { ...t, lastTs: msgs[0].ts }, msgs, flagged });
    }
    const order = orderTopics(out.map((r) => r.topic), user.topicOrder);
    const byKey = new Map(out.map((r) => [r.topic.key, r]));
    return order.map((t) => byKey.get(t.key));
  }, [model, period, S.acctSel, S.tagSel]);

  const attnShown = attnAll ? attention : attention.slice(0, 8);
  return html`
    <div class="main-inner">
      <${ActiveFilters} />
      <section class="section" aria-label="Needs reply">
        <div class="section-h"><h2>Needs reply</h2><span class="hint">People you write to, waiting to hear from you</span>
          <${PeriodTabs} k="needsPeriod" label="Needs reply" />
        </div>
        <div class="card">
          ${needsCurrent.map((m) => html`<${PersonRow} key=${m.key} m=${m} />`)}
          ${needsCurrent.length === 0 && html`<div class="empty">${needsOld.length ? 'Nobody new is waiting on you in this period.' : 'Nobody is waiting on you.'}</div>`}
          ${showOld && needsOld.map((m) => html`<${PersonRow} key=${m.key} m=${m} />`)}
          ${needsOld.length > 0 && html`<button class="more" onClick=${() => setShowOld(!showOld)}>${showOld ? 'Hide' : 'Show'} older than ${periodLabel(user.settings.needsPeriod)}</button>`}
        </div>
      </section>

      <section class="section" aria-label="Attention">
        <div class="section-h"><h2>Attention</h2><span class="hint">Out of the ordinary: new or rare topics, alarm words, unfamiliar senders, and anything you flag</span>
          ${attention.length > 1 && html`<button class="btn ghost small" onClick=${() => { const list = attention.filter((m) => !user.flagged[m.key]); mutate((u) => { for (const m of list) u.acked[m.key] = true; }); }}>Dismiss all</button>`}
          <${PeriodTabs} k="attnPeriod" label="Attention" />
        </div>
        <div class="card attn">
          ${attnShown.map((m) => html`<${AttentionRow} key=${m.key} m=${m} />`)}
          ${attention.length === 0 && html`<div class="empty">Nothing unusual in this period.</div>`}
          ${attention.length > 8 && html`<button class="more" onClick=${() => setAttnAll(!attnAll)}>${attnAll ? 'Show fewer' : 'Show all'}</button>`}
        </div>
      </section>

      <section class="section" aria-label="Notifications">
        <div class="section-h"><h2>Notifications</h2><span class="hint">By topic, in your priority order. Nothing here needs action.</span>
          <${PeriodTabs} k="period" label="Notifications" />
        </div>
        <div class="card">
          <${TopicList} rows=${rows} />
          ${rows.length === 0 && html`<div class="empty">No notifications in this period.</div>`}
        </div>
      </section>
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
      if (!target) return;
      const waiting = S.model.needsReply.find((m) => m.acct === S.open.acct && m.threadId === S.open.threadId);
      const item = waiting || (S.model.attention.includes(target) ? target : null);
      if (item) bump(item);
    },
    e: () => {
      if (!target) return;
      const waiting = S.model.needsReply.find((m) => m.acct === S.open.acct && m.threadId === S.open.threadId);
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
