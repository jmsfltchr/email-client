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
  photos: {}, // address -> contact photo URL
  photosDenied: [], // accounts signed in without the contacts permission
  user: normaliseState(null),
  model: null,
  view: 'home', // home | search | settings
  acctSel: new Set(), // empty = all accounts
  tagSel: new Set(), // 'o:root' | 'c:addr' | 't:topicKey'; empty = everything
  open: null, // {acct, threadId, key}
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

export function openMessage(m) { set({ open: { acct: m.acct, threadId: m.threadId, key: m.key } }); }
export function closeReader() { set({ open: null }); }

export function toast(text, { action, onAction, ms = 4000 } = {}) {
  const t = { text, action, onAction, id: Math.random() };
  set({ toast: t });
  setTimeout(() => { if (S.toast === t) set({ toast: null }); }, ms);
  return t;
}

export const markDone = (m) => mutate((u) => { u.done[m.key] = true; });
export const undoDone = (m) => mutate((u) => { delete u.done[m.key]; });
export const ack = (m) => mutate((u) => { u.acked[m.key] = true; delete u.flagged[m.key]; });
export const toggleFlag = (m) => mutate((u) => {
  if (u.flagged[m.key]) delete u.flagged[m.key];
  else { u.flagged[m.key] = Date.now(); delete u.acked[m.key]; }
});
export const setSenderKind = (addr, kind) => mutate((u) => {
  if (kind) u.senderKind[addr] = kind; else delete u.senderKind[addr];
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
  } else if (e.type === 'photos') {
    set({ photos: e.photos || {}, photosDenied: e.denied || [] });
  } else if (e.type === 'accounts') {
    S.accounts = e.accounts;
    rebuild();
  }
}

export async function init() {
  api = window.mailApi || null;
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
