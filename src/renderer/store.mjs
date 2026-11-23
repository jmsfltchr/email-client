// Single app store: message metadata, persisted user state, derived model, and UI state.

import { useState, useEffect, displayName } from './util.mjs';
import { buildModel, normaliseState, DAY } from '../core/classify.mjs';
import { domainOf, rootDomain } from '../core/domains.mjs';
import { createDemoApi } from './demo.mjs';
import { assignColors, isFreeMail } from '../core/colors.mjs';

export const S = {
  ready: false,
  demo: false,
  accounts: [],
  hasOAuthClient: false,
  messages: new Map(),
  unread: {}, // account -> Set of message ids Gmail marks unread
  photos: {}, // address -> contact photo URL
  photosDenied: [], // accounts signed in without the contacts permission
  user: normaliseState(null),
  model: null,
  view: 'home', // home | search | settings
  acctSel: new Set(), // empty = all accounts
  tagSel: new Set(), // 'o:root' | 'c:addr' | 't:topicKey'; empty = everything
  open: null, // {acct, threadId, key}
  finding: false, // find-in-conversation bar open
  web: null, // {url, n} when the browser pane is open beside the reader
  canEmbed: false, // true inside Electron, where <webview> exists
  compose: null,
  ruleEditor: null, // {topic} when the topic pattern dialog is open
  expanded: new Set(), // expanded topic keys
  progress: {},
  errors: {},
  toast: null,
};

export let api = null;
const listeners = new Set();
let scheduled = false;

export function notify() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; listeners.forEach((l) => l()); });
}

export function set(patch) { Object.assign(S, patch); notify(); }

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    l(); // catch anything that changed between first render and this subscription
    return () => listeners.delete(l);
  }, []);
  return S;
}

// ------------------------------------------------------------ model

export function rebuild() {
  const myAddrs = new Set(S.accounts.map((a) => a.email));
  S.model = buildModel([...S.messages.values()], S.user, { now: Date.now(), myAddrs });
  // Give newly seen organisations a colour, busiest first, and remember it.
  const volume = new Map();
  for (const s of S.model.senders.values()) if (!isFreeMail(s.root)) volume.set(s.root, (volume.get(s.root) || 0) + s.count);
  const fresh = assignColors(S.user.orgColor, [...volume].sort((a, b) => b[1] - a[1]).map(([root]) => root));
  if (Object.keys(fresh).length) { Object.assign(S.user.orgColor, fresh); saveSoon(); }
  notify();
}

let rebuildTimer = null;
function rebuildSoon() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, 400);
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveState(S.user), 300);
}
/** Mutate persisted user state, re-derive, and save. */
export function mutate(fn) {
  fn(S.user);
  rebuild();
  saveSoon();
}

export function setSetting(key, value) { mutate((u) => { u.settings[key] = value; }); }

// ------------------------------------------------------------ filters

export function passes(m) {
  if (S.acctSel.size && !S.acctSel.has(m.acct)) return false;
  const t = S.tagSel;
  if (!t.size) return true;
  if (m.kind === 'me') return m.to.some((a) => t.has(`c:${a}`) || t.has(`o:${rootDomain(domainOf(a))}`));
  return t.has(`o:${m.root}`) || t.has(`c:${m.from.addr}`) || (m.topic != null && t.has(`t:${m.topic}`));
}

export function toggleIn(setName, id) {
  const next = new Set(S[setName]);
  if (next.has(id)) next.delete(id); else next.add(id);
  set({ [setName]: next });
}

export const cutoffs = () => {
  const now = S.model?.now || Date.now();
  return { now, near: now - S.user.settings.nearDays * DAY, far: now - S.user.settings.farDays * DAY };
};

/** 'fresh' | 'fading' | 'old' relative to the two cutoffs. */
export function ageBand(ts) {
  const c = cutoffs();
  return ts >= c.near ? 'fresh' : ts >= c.far ? 'fading' : 'old';
}

export const accountOf = (email) => S.accounts.find((a) => a.email === email) || { email, label: email, color: '#888' };

// ------------------------------------------------------------ actions

/** Unread in Gmail and not yet opened here. */
export const isUnread = (m) => !!S.unread[m.acct]?.has(m.id) && !S.user.read[m.key];

/** Open a conversation. Unless `exact`, it lands on the latest unread message rather than the one clicked. */
export function openMessage(m, { exact = false } = {}) {
  const fresh = (S.model?.threads.get(`${m.acct}:${m.threadId}`) || [m]).filter(isUnread);
  const latest = fresh.length && !exact ? fresh.reduce((a, b) => (b.ts > a.ts ? b : a)) : m;
  set({ open: { acct: m.acct, threadId: m.threadId, key: m.key, unread: exact ? [] : fresh.map((x) => x.key), scrollTo: latest.key, n: (S.open?.n || 0) + 1 } });
  // Opening a conversation reads it (locally: Stillmail does not change anything in Gmail).
  if (!fresh.length) return;
  for (const x of fresh) S.user.read[x.key] = true;
  saveSoon();
}

function setUnread(acct, ids) {
  const now = new Set(ids);
  S.unread = { ...S.unread, [acct]: now };
  // Forget local read marks for mail Gmail no longer has as unread.
  let pruned = false;
  for (const key of Object.keys(S.user.read)) {
    if (key.startsWith(`${acct}:`) && !now.has(key.slice(acct.length + 1))) { delete S.user.read[key]; pruned = true; }
  }
  if (pruned) saveSoon();
  notify();
}
export function closeReader() { set({ open: null, web: null, finding: false }); }

export function toast(text, { action, onAction, ms = 4000 } = {}) {
  const t = { text, action, onAction, id: Math.random() };
  set({ toast: t });
  setTimeout(() => { if (S.toast === t) set({ toast: null }); }, ms);
  return t;
}

export const markDone = (m) => mutate((u) => { u.done[m.key] = true; delete u.bumped[m.key]; });
export const undoDone = (m) => mutate((u) => { delete u.done[m.key]; });
export const ack = (m) => mutate((u) => { u.acked[m.key] = true; delete u.flagged[m.key]; delete u.bumped[m.key]; });
/** Move a message back to the top of its list, as if it had just arrived. */
export function bump(m) {
  const before = S.user.bumped[m.key];
  mutate((u) => { u.bumped[m.key] = Date.now(); });
  toast('Bumped to the top', {
    action: 'Undo',
    onAction: () => { mutate((u) => { if (before) u.bumped[m.key] = before; else delete u.bumped[m.key]; }); set({ toast: null }); },
  });
}
export const toggleFlag = (m) => mutate((u) => {
  if (u.flagged[m.key]) delete u.flagged[m.key];
  else { u.flagged[m.key] = Date.now(); delete u.acked[m.key]; }
});
export const setSenderKind = (addr, kind) => mutate((u) => {
  if (kind) u.senderKind[addr] = kind; else delete u.senderKind[addr];
});
export const toggleSenderTopic = (addr) => mutate((u) => {
  if (u.senderTopic[addr]) delete u.senderTopic[addr]; else u.senderTopic[addr] = true;
});
export const toggleQuiet = (topicKey) => mutate((u) => {
  if (u.quietTopics[topicKey]) delete u.quietTopics[topicKey]; else u.quietTopics[topicKey] = true;
});

// ------------------------------------------------------------ desktop notifications

function notifyDesktop(added) {
  if (!S.user.settings.notify || typeof Notification === 'undefined') return;
  const recent = Date.now() - 2 * 3600000;
  for (const m of added) {
    if (m.kind === 'me' || m.ts < recent) continue;
    let title = null;
    if (m.kind === 'important') title = displayName(m.from);
    else if (m.reasons && !S.user.acked[m.key]) title = `${m.reasons[0].text} · ${S.model.senders.get(m.from.addr)?.org || m.from.addr}`;
    if (!title) continue;
    try {
      const n = new Notification(title, { body: m.subject, tag: m.key, silent: false });
      n.onclick = () => { api.focusWindow?.(); set({ view: 'home' }); openMessage(m); };
    } catch { /* notifications unavailable */ }
  }
}

// ------------------------------------------------------------ boot

function onEvent(e) {
  if (e.type === 'messages') {
    for (const key of e.removed || []) S.messages.delete(key);
    for (const m of e.added || []) S.messages.set(m.key, m);
    const small = (e.added?.length || 0) + (e.removed?.length || 0) <= 20;
    if (e.live || small) rebuild(); else rebuildSoon(); // backfill batches are coalesced
    if (e.live) notifyDesktop((e.added || []).map((m) => S.messages.get(m.key)));
  } else if (e.type === 'progress') {
    S.progress = { ...S.progress, [e.acct]: e };
    if (e.phase === 'idle') { const { [e.acct]: _, ...rest } = S.errors; S.errors = rest; }
    notify();
  } else if (e.type === 'error') {
    set({ errors: { ...S.errors, [e.acct]: e.message } });
  } else if (e.type === 'unread') {
    setUnread(e.acct, e.ids || []);
  } else if (e.type === 'photos') {
    set({ photos: e.photos || {}, photosDenied: e.denied || [] });
  } else if (e.type === 'accounts') {
    S.accounts = e.accounts;
    rebuild();
  }
}

export async function init() {
  api = window.mailApi || null;
  S.canEmbed = !!window.mailApi;
  let boot = api ? await api.bootstrap() : null;
  let demoFlag = false;
  try { demoFlag = localStorage.getItem('stillmail.demo') === '1'; } catch { /* storage unavailable */ }
  const demo = !api || boot.demo || (boot.accounts.length === 0 && demoFlag);
  if (demo) {
    api = createDemoApi();
    boot = await api.bootstrap();
  }
  S.demo = demo;
  S.accounts = boot.accounts;
  S.hasOAuthClient = boot.hasOAuthClient;
  S.user = normaliseState(boot.state);
  S.messages = new Map(boot.messages.map((m) => [m.key, m]));
  S.photos = boot.photos || {};
  S.photosDenied = boot.photosDenied || [];
  S.unread = Object.fromEntries(Object.entries(boot.unread || {}).map(([acct, ids]) => [acct, new Set(ids)]));
  api.onEvent(onEvent);
  S.ready = true;
  rebuild();
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  // Ages drift: refresh the derived model periodically so cutoffs stay honest.
  setInterval(rebuild, 5 * 60000);
}

export function setDemo(on) {
  try { if (on) localStorage.setItem('stillmail.demo', '1'); else localStorage.removeItem('stillmail.demo'); } catch { /* ignore */ }
  location.reload();
}
