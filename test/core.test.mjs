import test from 'node:test';
import assert from 'node:assert/strict';
import { rootDomain, orgName, channelName, looksAutomated } from '../src/core/domains.mjs';
import { parseAddressList, formatAddress } from '../src/core/address.mjs';
import { subjectTemplate, baseSubject, keywordRegex, buildModel, defaultState, reorder, orderTopics, DEFAULT_KEYWORDS, DAY } from '../src/core/classify.mjs';
import { generateDemo } from '../src/renderer/demo.mjs';

test('root domain, org and channel names', () => {
  assert.equal(rootDomain('mail.notifications.github.com'), 'github.com');
  assert.equal(rootDomain('email.amazon.co.uk'), 'amazon.co.uk');
  assert.equal(rootDomain('fernhill.atlassian.net'), 'atlassian.net');
  assert.equal(orgName('github.com'), 'Github');
  assert.equal(channelName('noreply@billing.stripe.com'), 'billing.noreply');
  assert.equal(channelName('notifications@github.com'), 'notifications');
  assert.equal(channelName('jane+tag@mail.example.org'), 'jane');
  assert.ok(looksAutomated('no-reply@x.com') && looksAutomated('notifications@x.com') && !looksAutomated('jane@x.com'));
});

test('address list parsing handles quotes and commas', () => {
  const l = parseAddressList('"Doe, Jane" <Jane@X.com>, bob@y.org; Zoë <z@é.example>, garbage');
  assert.deepEqual(l.map((a) => a.addr), ['jane@x.com', 'bob@y.org', 'z@é.example']);
  assert.equal(l[0].name, 'Doe, Jane');
  assert.equal(formatAddress(l[0]), '"Doe, Jane" <jane@x.com>');
});

test('subject templates collapse ids, dates and amounts', () => {
  assert.equal(baseSubject('RE: Fwd: re[2]: Hello'), 'Hello');
  assert.equal(subjectTemplate('Your order #123-4567 has shipped'), subjectTemplate('Your order #999-0001 has shipped'));
  assert.equal(subjectTemplate('Invitation: Planning @ Mon 14 Nov 2026 15:00'), 'Invitation: Planning @ #');
  assert.equal(subjectTemplate('Statement for March 2026'), subjectTemplate('Statement for January 2025'));
  assert.equal(subjectTemplate('Payout of £1,204.50 is on its way'), 'Payout of # is on its way');
  assert.notEqual(subjectTemplate('Your invoice is ready'), subjectTemplate('Your invoice is overdue'));
});

test('keyword regex matches word prefixes only', () => {
  const re = keywordRegex(DEFAULT_KEYWORDS);
  for (const s of ['Payment overdue', 'Your card expires soon', 'Access REVOKED', 'Action required: verify', 'build failed']) assert.ok(re.test(s), s);
  for (const s of ['Your weekly digest', 'Unlocked a new badge', 'Inspiration for spring']) assert.ok(!re.test(s), s);
});

const mk = (() => { let n = 0; return (o) => ({ acct: 'me@x.com', id: `m${++n}`, key: `me@x.com:m${n}`, threadId: o.threadId || `t${n}`, to: ['me@x.com'], snippet: '', sent: false, bulk: false, ...o, from: typeof o.from === 'string' ? { name: '', addr: o.from } : o.from }); })();
const NOW = Date.UTC(2026, 10, 18);
const opts = { now: NOW, myAddrs: new Set(['me@x.com']) };

test('senders: replied-to are important, repeat no-reply senders are channels', () => {
  const msgs = [
    mk({ from: 'me@x.com', sent: true, to: ['ann@a.com'], subject: 'hi', ts: NOW - 400 * DAY }),
    mk({ from: 'ann@a.com', subject: 'question', ts: NOW - DAY }),
    ...[1, 2, 3].map((i) => mk({ from: 'bot@svc.com', subject: 'Daily report', ts: NOW - i * DAY })),
    mk({ from: 'stranger@b.com', subject: 'hello', ts: NOW - DAY }),
    mk({ from: 'promo@shop.com', subject: 'Sale', bulk: true, ts: NOW - DAY }),
  ];
  const model = buildModel(msgs, defaultState(), opts);
  const kind = (a) => model.senders.get(a).kind;
  assert.equal(kind('ann@a.com'), 'important');
  assert.equal(kind('bot@svc.com'), 'channel');
  assert.equal(kind('stranger@b.com'), 'new');
  assert.equal(kind('promo@shop.com'), 'channel');
  assert.deepEqual(model.needsReply.map((m) => m.from.addr), ['ann@a.com']);
  assert.deepEqual(model.attention.map((m) => m.from.addr), ['stranger@b.com']);
  // override
  const st = defaultState(); st.senderKind['ann@a.com'] = 'channel';
  assert.equal(buildModel(msgs, st, opts).needsReply.length, 0);
});

test('needs reply clears when I answer, and re-opens on a new message', () => {
  const t = 'thread1';
  const base = [
    mk({ from: 'me@x.com', sent: true, to: ['ann@a.com'], subject: 'x', ts: NOW - 50 * DAY }),
    mk({ from: 'ann@a.com', subject: 'q', threadId: t, ts: NOW - 3 * DAY }),
  ];
  assert.equal(buildModel(base, defaultState(), opts).needsReply.length, 1);
  const replied = [...base, mk({ from: 'me@x.com', sent: true, to: ['ann@a.com'], subject: 'Re: q', threadId: t, ts: NOW - 2 * DAY })];
  assert.equal(buildModel(replied, defaultState(), opts).needsReply.length, 0);
  const again = [...replied, mk({ from: 'ann@a.com', subject: 'Re: q', threadId: t, ts: NOW - DAY })];
  const st = defaultState(); st.done[base[1].key] = true;
  assert.equal(buildModel(again, st, opts).needsReply.length, 1);
});

test('rare / new topics and keywords are escalated; routine ones are not', () => {
  const from = 'billing@svc.com';
  const msgs = [
    ...Array.from({ length: 12 }, (_, i) => mk({ from, subject: `Your invoice #${1000 + i} is available`, ts: NOW - (i * 30 + 2) * DAY })),
    mk({ from, subject: 'Your account has been restricted', ts: NOW - DAY }),
    mk({ from, subject: 'Card declined for invoice #2000', snippet: '', ts: NOW - 2 * DAY }),
    mk({ from, subject: 'Something from long ago', ts: NOW - 200 * DAY }),
  ];
  const model = buildModel(msgs, defaultState(), opts);
  const reasons = Object.fromEntries(model.attention.map((m) => [m.subject, m.reasons.map((r) => r.type)]));
  assert.deepEqual(reasons, {
    'Your account has been restricted': ['new-topic'],
    'Card declined for invoice #2000': ['keyword', 'new-topic'],
  });
  // quiet topic + ack + flag
  const st = defaultState();
  st.quietTopics[msgs[12].topic] = true;
  st.acked[msgs[13].key] = true;
  st.flagged[msgs[0].key] = NOW;
  assert.deepEqual(buildModel(msgs, st, opts).attention.map((m) => m.key), [msgs[0].key]);
});

test('a topic that returns after a long gap is flagged as rare', () => {
  const from = 'support@registrar.com';
  const msgs = [
    ...[380, 372, 365].map((d) => mk({ from, subject: `Your domain expires in ${d - 358} days`, ts: NOW - d * DAY })),
    ...[300, 200, 100].map((d) => mk({ from, subject: 'Order confirmation', ts: NOW - d * DAY })),
    mk({ from, subject: 'Your domain x.dev renews soon', ts: NOW - 2 * DAY }),
    mk({ from, subject: 'Your domain expires in 14 days', ts: NOW - DAY }),
  ];
  const model = buildModel(msgs, defaultState(), opts);
  const hit = model.attention.find((m) => m.subject === 'Your domain expires in 14 days');
  assert.deepEqual(hit.reasons.map((r) => r.type), ['keyword', 'rare-topic']);
});

test('topic clustering on the demo mailbox', () => {
  const d = generateDemo(NOW);
  const model = buildModel(d.messages, defaultState(), { now: NOW, myAddrs: new Set(d.accounts.map((a) => a.email)) });
  const labels = [...model.topics.values()].map((t) => `${t.org} › ${t.channel} › ${t.label}`);
  for (const want of ['Github › notifications › [fernhill/api] ⋯', 'Harbourbank › alerts › You spent ⋯ at ⋯', 'Stripe › billing › Payout of ⋯ is on its way', 'Circleci › builds › Success: ⋯ (main)', 'Google › calendar-notification › Accepted: ⋯', 'Themargin › newsletter › (varied subjects)']) {
    assert.ok(labels.includes(want), `${want}\n${labels.join('\n')}`);
  }
  assert.deepEqual(model.needsReply.map((m) => m.from.name), ['Priya Raman', 'Helen Rowan', 'Marcus Oyelaran', 'Dana Whitfield', 'Tom Becker']);
  assert.equal(model.attention.length, 8);
  // user regex rule regroups
  const st = defaultState();
  st.topicRules.push({ id: 'r1', scope: 'builds@circleci.com', pattern: '^(Success|Failed): ', name: 'Builds' });
  const m2 = buildModel(d.messages, st, { now: NOW, myAddrs: new Set(d.accounts.map((a) => a.email)) });
  assert.equal(m2.topics.get('builds@circleci.com|r:r1').count, 60);
});

test('reorder pins the dragged topic and everything above it', () => {
  const vis = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(reorder([], vis, 'd', 'b', false), ['a', 'd']);
  assert.deepEqual(reorder(['a', 'd'], ['a', 'd', 'b', 'c', 'e'], 'e', 'a', false), ['e', 'a', 'd']);
  assert.deepEqual(reorder(['a', 'd'], ['a', 'd', 'b', 'c', 'e'], 'a', 'd', true), ['d', 'a']);
  // hidden pinned topic "h" keeps its place after "a"
  assert.deepEqual(reorder(['a', 'h', 'd'], ['a', 'd', 'b'], 'b', 'a', false), ['b', 'a', 'h', 'd']);
  const ordered = orderTopics([{ key: 'x', lastTs: 5 }, { key: 'y', lastTs: 9 }, { key: 'z', lastTs: 1 }], ['z']);
  assert.deepEqual(ordered.map((t) => t.key), ['z', 'y', 'x']);
});
