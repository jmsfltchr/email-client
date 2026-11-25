// Pure classification engine. Takes message metadata + user state and derives:
//   - important senders (anyone I've written to, mass senders excepted), notification channels, new senders
//   - topics per channel (recurring subject patterns)
//   - the People list (conversations with people) and out-of-the-ordinary "attention" messages
// No I/O; runs in the renderer and in node tests.

import { domainOf, rootDomain, orgName, channelName, looksAutomated } from './domains.mjs';

export const DAY = 86400000;

export const DEFAULT_KEYWORDS = [
  'overdue', 'past due', 'payment due', 'unpaid', 'outstanding',
  'expir', 'revoke', 'revoc', 'suspend', 'suspens', 'deactivat', 'terminat',
  'fail', 'declin', 'rejected', 'bounced', 'unable to',
  'cancell', 'canceled',
  'urgent', 'immediately', 'action required', 'action needed', 'final notice', 'final reminder', 'deadline',
  'unauthori', 'unusual', 'suspicious', 'security alert', 'breach', 'compromis', 'locked',
  'new sign-in', 'new login', 'password',
  'violation', 'dispute', 'chargeback', 'fraud', 'legal',
  'incident', 'outage', 'critical',
];

export const DEFAULT_SETTINGS = {
  nearDays: 7, // within this: current
  farDays: 30, // within this: fading; beyond: search only
  period: 7, // notifications panel window, days
  needsPeriod: 30, // People window, days
  attnPeriod: 30, // Attention window, days
  channelMin: 3, // received >= this many and never replied => notification channel
  keywords: DEFAULT_KEYWORDS,
  notify: true,
  loadImages: false,
  readerTheme: 'dark', // how message bodies are shown: 'dark' | 'light'
  senderImages: true, // contact photos and organisation icons
  syncMonths: 12,
};

export function defaultState() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    senderKind: {}, // addr -> 'important' | 'channel'
    senderTopic: {}, // addr -> true: everything from this address is one topic
    topicRules: [], // [{id, scope, pattern, name}]
    quietTopics: {}, // topic key -> true: never auto-flag
    flagged: {}, // message key -> ts (manually escalated)
    acked: {}, // message key -> true (attention dismissed)
    done: {}, // message key -> true (dismissed from People until the conversation moves on)
    read: {}, // message key -> true: opened here while Gmail still has it unread
    imageSenders: {}, // addr -> true: always load remote images from this sender
    topicDismissed: {}, // topic key -> ts of its newest message when dismissed; hidden until newer mail
    unsubscribed: {}, // sender addr -> ts an unsubscribe was requested
    bumped: {}, // message key or topic key -> ts of the last bump; stands in for the date when ordering and fading
    orgColor: {}, // root domain -> palette index
    chatNotes: [], // notifications from the Testers browser: waiting ones, then archived (see notes.mjs)
    chatNotesOpen: true, // the notifications pane is expanded
  };
}

export function normaliseState(s) {
  const d = defaultState();
  const out = { ...d, ...(s || {}) };
  out.settings = { ...d.settings, ...((s && s.settings) || {}) };
  return out;
}

// ---------------------------------------------------------------- subjects

const REPLY_PREFIX = /^(?:(?:re|fwd?|fw|aw|sv|tr|wg|antw)(?:\[\d+\])?\s*[:：]\s*)/i;

export function baseSubject(s) {
  let t = (s || '').trim();
  let prev;
  do { prev = t; t = t.replace(REPLY_PREFIX, ''); } while (t !== prev);
  return t;
}

const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const RE_URL = /\bhttps?:\/\/\S+/gi;
const RE_EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
const RE_DAY_MON = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}\\b\\.?(?:,?\\s+\\d{4})?`, 'gi');
const RE_MON_DAY = new RegExp(`\\b${MON}\\b\\.?\\s+\\d{1,4}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`, 'gi');
const RE_LONG_NAMES = /\b(?:january|february|march|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
const RE_DIGIT_RUN = /[\p{L}\p{N}_$£€¥#@/.:,+%-]*\p{N}[\p{L}\p{N}_$£€¥#@/.:,+%-]*/gu;

/** Collapse the variable parts of a subject (ids, dates, amounts) into '#'. */
export function subjectTemplate(subject) {
  return baseSubject(subject)
    .replace(RE_URL, '#')
    .replace(RE_EMAIL, '#')
    .replace(RE_DAY_MON, '#')
    .replace(RE_MON_DAY, '#')
    .replace(RE_LONG_NAMES, '#')
    .replace(RE_DIGIT_RUN, '#')
    .replace(/\b(?:mon|tues?|wed|thur?s?|fri|sat|sun)\b\.?,?\s*(?=#)/gi, '')
    .replace(/#(?:\s*#)+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function templateLabel(tpl) {
  return tpl ? tpl.replace(/#/g, '⋯') : '(no subject)';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keywordRegex(keywords) {
  const parts = (keywords || []).map((k) => k.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((k) => escapeRe(k).replace(/\s+/g, '\\s+'));
  if (!parts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})[\\p{L}]*`, 'iu');
}

export function compileRules(rules) {
  const out = [];
  for (const r of rules || []) {
    try { out.push({ ...r, re: new RegExp(r.pattern, 'i') }); } catch { /* invalid regex: skip */ }
  }
  return out;
}

// ---------------------------------------------------------------- topics

export const ALL_MAIL = 'all mail';
const OTHER_MAIL = 'everything else';

const TAG = /^\[[^\]]{1,60}\]/;

/**
 * Assign every message of one channel to a topic.
 * Returns Map(topicKeySuffix -> {kind, label, msgs}).
 */
export function clusterChannel(msgs, rules, oneTopic = false) {
  const topics = new Map();
  const put = (suffix, kind, label, m) => {
    let t = topics.get(suffix);
    if (!t) topics.set(suffix, (t = { kind, label, msgs: [] }));
    t.msgs.push(m);
  };

  // 0. the user said this address is a single topic (newsletters whose subject is the headline)
  if (oneTopic) {
    for (const m of msgs) put('*', 'sender', ALL_MAIL, m);
    return topics;
  }

  // 1. user rules win
  const rest = [];
  for (const m of msgs) {
    const base = baseSubject(m.subject);
    const rule = rules.find((r) => r.re.test(base));
    if (rule) put(`r:${rule.id}`, 'rule', rule.name || rule.pattern, m);
    else rest.push(m);
  }

  // group by template
  const groups = new Map(); // lower tpl -> {tpl, msgs}
  for (const m of rest) {
    if (m._tplSrc !== m.subject) { m._tplSrc = m.subject; m._tpl = subjectTemplate(m.subject); }
    const k = m._tpl.toLowerCase();
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { tpl: m._tpl, key: k, msgs: [] }));
    g.msgs.push(m);
  }

  // 2. leading [tag] shared by >= 3 distinct subjects => one topic per tag
  const byTag = new Map();
  for (const g of groups.values()) {
    const tag = g.tpl.match(TAG)?.[0];
    if (!tag || tag.length === g.tpl.length) continue;
    const k = tag.toLowerCase();
    if (!byTag.has(k)) byTag.set(k, { tag, groups: [] });
    byTag.get(k).groups.push(g);
  }
  for (const [k, { tag, groups: gs }] of byTag) {
    if (gs.length < 3) continue;
    for (const g of gs) {
      for (const m of g.msgs) put(`t:${k}`, 'tag', `${tag} ⋯`, m);
      groups.delete(g.key);
    }
  }

  // 3. same subject except for one word that takes many values ("You spent # at Tesco / Pret / ...")
  for (let pass = 0; pass < 2; pass++) {
    const slots = new Map();
    for (const g of groups.values()) {
      const toks = g.key.split(' ');
      if (toks.length < 3) continue;
      for (let i = 0; i < toks.length; i++) {
        if (toks[i] === '#') continue;
        const k = `${toks.length}|${i}|${toks.slice(0, i).join(' ')}|${toks.slice(i + 1).join(' ')}`;
        if (!slots.has(k)) slots.set(k, { i, groups: [] });
        slots.get(k).groups.push(g);
      }
    }
    let merged = false;
    for (const { i, groups: gs } of slots.values()) {
      if (gs.length < 5 || gs.some((g) => !groups.has(g.key))) continue;
      const toks = gs[0].tpl.split(' ');
      toks[i] = '#';
      const tpl = toks.join(' ').replace(/#(?:\s*#)+/g, '#');
      const key = tpl.toLowerCase();
      const target = groups.get(key) || { tpl, key, msgs: [] };
      for (const g of gs) { groups.delete(g.key); target.msgs.push(...g.msgs); }
      groups.set(key, target);
      merged = true;
    }
    if (!merged) break;
  }

  // 4. subjects seen >= 3 times are topics in their own right
  let weak = [];
  for (const g of groups.values()) {
    if (g.msgs.length >= 3) for (const m of g.msgs) put(`e:${g.key}`, 'exact', templateLabel(g.tpl), m);
    else weak.push(g);
  }

  // 5. rarely-repeated subjects: cluster by shared leading / trailing words.
  //    Broadest grouping first; the label is the longest wording the members share.
  const common = (lists, fromEnd) => {
    const out = [];
    for (let i = 0; ; i++) {
      const tok = fromEnd ? lists[0][lists[0].length - 1 - i] : lists[0][i];
      if (tok === undefined || lists.some((l) => l.length <= i + 1 || (fromEnd ? l[l.length - 1 - i] : l[i]).toLowerCase() !== tok.toLowerCase())) break;
      if (fromEnd) out.unshift(tok); else out.push(tok);
    }
    return out.join(' ');
  };
  const weakTotal = weak.length;
  const cluster = (fromEnd) => {
    for (let len = 1; len <= 4 && weak.length >= 3; len++) {
      const buckets = new Map();
      for (const g of weak) {
        const toks = g.tpl.split(' ');
        if (toks.length <= len) continue;
        const part = (fromEnd ? toks.slice(-len) : toks.slice(0, len)).join(' ');
        if (!/[\p{L}]{2}/u.test(part)) continue;
        if (len === 1 && (fromEnd || !/[:\]|—–-]$/.test(part))) continue; // one word only if it is a "Label:"
        const k = part.toLowerCase();
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(g);
      }
      const taken = new Set();
      for (const [k, gs] of buckets) {
        if (gs.length < 3) continue;
        // A few headlines that happen to open with the same words are not a pattern:
        // unless it is a "Label:" it must account for a real share of the one-off subjects.
        if (!(len === 1 && !fromEnd) && gs.length < weakTotal * 0.25) continue;
        const shared = common(gs.map((g) => g.tpl.split(' ')), fromEnd);
        for (const g of gs) {
          taken.add(g);
          for (const m of g.msgs) put(`${fromEnd ? 's' : 'p'}:${k}`, fromEnd ? 'suffix' : 'prefix', fromEnd ? `⋯ ${shared}` : `${shared} ⋯`, m);
        }
      }
      if (taken.size) weak = weak.filter((g) => !taken.has(g));
    }
  };
  cluster(false);
  cluster(true);

  // 6. what's left: either a channel whose subjects always vary, or genuine one-offs
  const weakCount = weak.reduce((n, g) => n + g.msgs.length, 0);
  const varied = weak.length >= 5 && weakCount >= msgs.length * 0.4;
  const restLabel = topics.size ? OTHER_MAIL : ALL_MAIL; // the address itself is the topic
  for (const g of weak) {
    for (const m of g.msgs) {
      if (varied) put('*', 'sender', restLabel, m);
      else put(`e:${g.key}`, 'exact', templateLabel(g.tpl), m);
    }
  }
  return topics;
}

// ---------------------------------------------------------------- model

/**
 * A mass sender (list headers or a no-reply style address) that I have written to once at most,
 * or hardly ever compared with what it sends: a stray reply or unsubscribe email does not turn
 * a newsletter into a correspondent.
 */
export function isBroadcast(sender, timesWritten) {
  if (!sender.bulk && !looksAutomated(sender.addr)) return false;
  return timesWritten < Math.max(2, sender.count / 10);
}

export function isMine(m, myAddrs) {
  return !!m.sent || myAddrs.has(m.from.addr);
}

/**
 * Build the whole derived model. Annotates each message in place with:
 *   kind ('me'|'important'|'channel'|'new'), root, topic (key|null), reasons ([{type,text}]|null)
 */
export function buildModel(messages, state, { now = Date.now(), myAddrs = new Set() } = {}) {
  const st = state.settings;
  const attnCut = now - st.attnPeriod * DAY; // what the Attention section lists
  const farCut = now - Math.max(st.farDays, st.attnPeriod, 90) * DAY; // how far back mail is examined at all

  // --- who have I written to?
  // Auto-replies (vacation responder and the like) are not me writing to anyone.
  const wroteTo = new Map(); // addr -> how many times
  for (const m of messages) {
    if (!isMine(m, myAddrs) || m.auto || m.bulk) continue;
    for (const a of m.to) if (!myAddrs.has(a)) wroteTo.set(a, (wroteTo.get(a) || 0) + 1);
  }

  // --- senders
  const senders = new Map();
  for (const m of messages) {
    if (isMine(m, myAddrs)) { m.kind = 'me'; m.topic = null; m.reasons = null; m.eff = state.bumped[m.key] || m.ts; continue; }
    const a = m.from.addr;
    let s = senders.get(a);
    if (!s) {
      const domain = domainOf(a);
      const root = rootDomain(domain);
      senders.set(a, (s = { addr: a, name: '', domain, root, org: orgName(root), channel: channelName(a), count: 0, firstTs: m.ts, lastTs: 0, bulk: false, msgs: [] }));
    }
    s.count++;
    s.msgs.push(m);
    if (m.bulk) s.bulk = true;
    if (m.ts >= s.lastTs) { s.lastTs = m.ts; if (m.from.name) s.name = m.from.name; }
    if (m.ts < s.firstTs) s.firstTs = m.ts;
  }
  for (const s of senders.values()) {
    const override = state.senderKind[s.addr];
    if (override) s.kind = override;
    else if (wroteTo.has(s.addr) && !isBroadcast(s, wroteTo.get(s.addr))) s.kind = 'important';
    else if (s.count >= st.channelMin || s.bulk || looksAutomated(s.addr)) s.kind = 'channel';
    else s.kind = 'new';
    s.auto = !override;
  }

  // --- topics per channel
  const rules = compileRules(state.topicRules);
  const kwRe = keywordRegex(st.keywords);
  const topics = new Map();
  for (const s of senders.values()) {
    // eff: the date used for ordering and fading in People and Attention (last bump, else received).
    for (const m of s.msgs) { m.kind = s.kind; m.root = s.root; m.topic = null; m.reasons = null; m.eff = state.bumped[m.key] || m.ts; }
    if (s.kind !== 'channel') continue;
    const scoped = rules.filter((r) => r.scope === '*' || r.scope === s.addr || r.scope === s.root);
    for (const [suffix, t] of clusterChannel(s.msgs, scoped, !!state.senderTopic[s.addr])) {
      const key = `${s.addr}|${suffix}`;
      t.msgs.sort((a, b) => a.ts - b.ts);
      const topic = {
        key, addr: s.addr, root: s.root, org: s.org, channel: s.channel, label: t.label, kind: t.kind,
        count: t.msgs.length, firstTs: t.msgs[0].ts, lastTs: t.msgs[t.msgs.length - 1].ts, msgs: t.msgs,
      };
      topics.set(key, topic);
      for (const m of t.msgs) m.topic = key;
    }
  }

  // --- out-of-the-ordinary detection (only for mail still inside the far cutoff)
  const attention = [];
  // Channels that routinely send one-off subjects (marketing, newsletters): novelty there is ordinary.
  const oneOffs = new Map();
  for (const t of topics.values()) if (t.count <= 2 && t.kind !== 'rule') oneOffs.set(t.addr, (oneOffs.get(t.addr) || 0) + 1);
  const addReason = (m, type, text) => { (m.reasons ||= []).push({ type, text }); };
  for (const s of senders.values()) {
    if (s.kind === 'important') continue;
    for (const m of s.msgs) {
      if (m.eff < farCut) continue;
      if (s.kind === 'new') { addReason(m, 'new-sender', 'Unfamiliar sender'); continue; }
      if (state.quietTopics[m.topic]) continue;
      const hit = kwRe && (kwRe.exec(m.subject) || kwRe.exec(m.snippet || ''));
      if (hit) addReason(m, 'keyword', hit[0].toLowerCase());
      const t = topics.get(m.topic);
      if (!t || t.kind === 'sender' || t.kind === 'rule' || s.count < 5) continue;
      if (t.count <= 2) {
        if (oneOffs.get(s.addr) >= 4) continue;
        addReason(m, 'new-topic', t.firstTs === m.ts ? 'New topic' : 'Rare topic');
      } else {
        const i = t.msgs.indexOf(m);
        const gap = i > 0 ? m.ts - t.msgs[i - 1].ts : 0;
        if (gap >= 90 * DAY) addReason(m, 'rare-topic', `Rare · last seen ${Math.round(gap / (30 * DAY))} months earlier`);
      }
    }
  }
  for (const m of messages) {
    if (m.kind === 'me') continue;
    const flagged = !!state.flagged[m.key];
    if (flagged) { m.reasons = [{ type: 'flagged', text: 'Flagged by you' }, ...(m.reasons || [])]; attention.push(m); }
    else if (m.reasons && !state.acked[m.key] && m.eff >= attnCut) attention.push(m);
  }
  attention.sort((a, b) => b.eff - a.eff);

  // --- threads
  const threads = new Map();
  for (const m of messages) {
    const k = `${m.acct}:${m.threadId}`;
    let t = threads.get(k);
    if (!t) threads.set(k, (t = []));
    t.push(m);
  }
  // --- People: every conversation with a person, represented by its latest message from them or
  // from me. `awaiting` marks the ones where they spoke last.
  const toPerson = (m) => {
    if (m.auto || m.bulk) return false; // machine-generated on my behalf
    const others = m.to.filter((a) => !myAddrs.has(a));
    return !others.length /* a note to myself */ || others.some((a) => senders.get(a)?.kind !== 'channel');
  };
  const people = [];
  for (const t of threads.values()) {
    if (t.length > 1) t.sort((a, b) => a.ts - b.ts);
    let cand = null;
    for (let i = t.length - 1; i >= 0 && !cand; i--) {
      if (t[i].kind === 'important' || (t[i].kind === 'me' && toPerson(t[i]))) cand = t[i];
    }
    if (!cand || state.done[cand.key]) continue;
    cand.awaiting = cand.kind === 'important';
    if (cand.awaiting) cand.peer = cand.from;
    else {
      const them = t.findLast((m) => m.kind === 'important');
      const addr = cand.to.find((a) => !myAddrs.has(a));
      cand.peer = them?.from || (addr ? { name: senders.get(addr)?.name || '', addr } : { name: 'Note to self', addr: cand.from.addr });
    }
    people.push(cand);
  }
  people.sort((a, b) => b.eff - a.eff);

  return { senders, topics, threads, people, attention, now };
}

/**
 * The Notifications list: topics with mail in the window, most recent first.
 * Like messages in the other sections, a topic's effective date is its newest email or its last
 * bump, whichever is later, so a bumped topic rises to the top and outlives the window.
 * A dismissed topic stays away until newer mail arrives, and then shows only that mail.
 *   user: persisted state (bumped, topicDismissed, flagged, acked); cut: window start (ms);
 *   passes: optional message filter. Returns [{topic, msgs (newest first), flagged, eff}].
 */
export function topicRows(topics, user, { cut, passes = () => true }) {
  const rows = [];
  for (const t of topics) {
    const dismissedAt = user.topicDismissed[t.key] || 0;
    if (t.lastTs <= dismissedAt) continue;
    const bumpedAt = user.bumped[t.key] || 0;
    if (Math.max(t.lastTs, bumpedAt) < cut) continue;
    const from = Math.max(cut, dismissedAt + 1);
    const msgs = [];
    let latest = null; // newest message that passes the filters, even if outside the window
    for (let i = t.msgs.length - 1; i >= 0; i--) {
      const m = t.msgs[i];
      if (m.ts <= dismissedAt || (m.ts < from && latest)) break;
      if (!passes(m)) continue;
      latest ||= m;
      if (m.ts >= from) msgs.push(m);
    }
    if (!latest) continue;
    const eff = Math.max(latest.ts, bumpedAt);
    if (eff < cut) continue;
    if (!msgs.length) msgs.push(latest); // kept only by its bump: still show what it is about
    const flagged = msgs.some((m) => user.flagged[m.key] || (m.reasons && !user.acked[m.key]));
    rows.push({ topic: t, msgs, flagged, eff });
  }
  return rows.sort((a, b) => b.eff - a.eff);
}
