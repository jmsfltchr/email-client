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
  for (const want of ['Github › notifications › [fernhill/api] ⋯', 'Harbourbank › alerts › You spent ⋯ at ⋯', 'Stripe › billing › Payout of ⋯ is on its way', 'Circleci › builds › Success: ⋯ (main)', 'Google › calendar-notification › Accepted: ⋯', 'Themargin › newsletter › all mail']) {
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

import { PALETTE, assignColors, hashColor, isFreeMail, initials } from '../src/core/colors.mjs';

test('identity colours: stable, and distinct for the first organisations', () => {
  assert.equal(hashColor('jo@gmail.com'), hashColor('jo@gmail.com'));
  const ids = Array.from({ length: PALETTE.length }, (_, i) => `org${i}.com`);
  const first = assignColors({}, ids);
  assert.equal(new Set(Object.values(first)).size, PALETTE.length, 'no colour reused until the palette is exhausted');
  // existing assignments are kept; a newcomer takes a least-used slot
  const some = { 'a.com': 0, 'b.com': 0, 'c.com': 1 };
  const next = assignColors(some, ['a.com', 'new.com']);
  assert.deepEqual(Object.keys(next), ['new.com']);
  assert.ok(![0, 1].includes(next['new.com']));
  assert.deepEqual(assignColors(some, ['new.com']), next, 'deterministic');
  assert.ok(isFreeMail('gmail.com') && !isFreeMail('github.com'));
  assert.equal(initials('Priya Raman', 'p@x.com'), 'PR');
  assert.equal(initials('"Doe, Jane (Acme)"', 'j@x.com'), 'DA');
  assert.equal(initials('', 'zed@x.com'), 'Z');
});

import { clusterChannel, isBroadcast } from '../src/core/classify.mjs';

test('newsletters: one topic per sender, automatically and on request', () => {
  const from = { name: 'The Margin', addr: 'hello@margin.example' };
  const titles = ['How to read a changelog', 'How to run a retro', 'How to say no', 'The quiet cost of dashboards', 'Notes on slow software',
    'Why we stopped estimating', 'A field guide to on-call', 'What the map leaves out', 'Shipping is a habit', 'In praise of boring tools',
    'Small teams, long games', 'The meeting that should be a doc', 'Seven kinds of ambiguity', 'On keeping a work journal'];
  const msgs = titles.map((subject, i) => mk({ from, subject, bulk: true, ts: NOW - (i + 1) * 7 * DAY }));
  const model = buildModel(msgs, defaultState(), opts);
  // three headlines starting "How to" are not a topic of their own
  assert.deepEqual([...model.topics.values()].map((t) => [t.key, t.label, t.count]), [['hello@margin.example|*', 'all mail', 14]]);
  assert.equal(model.attention.length, 0, 'a new headline is not out of the ordinary');

  // a sender with recurring subjects splits by subject, until told otherwise
  const bank = [...Array.from({ length: 6 }, (_, i) => mk({ from: 'alerts@bank.com', subject: 'Statement ready', ts: NOW - i * 30 * DAY })),
    ...Array.from({ length: 4 }, (_, i) => mk({ from: 'alerts@bank.com', subject: `Payment of £${i}0 received`, ts: NOW - i * 9 * DAY }))];
  assert.equal(buildModel(bank, defaultState(), opts).topics.size, 2);
  const st = defaultState(); st.senderTopic['alerts@bank.com'] = true;
  const one = buildModel(bank, st, opts);
  assert.deepEqual([...one.topics.values()].map((t) => [t.key, t.kind, t.count]), [['alerts@bank.com|*', 'sender', 10]]);
  assert.equal(clusterChannel(bank, [], true).size, 1);
});

test('a stray or automatic reply does not make a mass sender important', () => {
  const news = { name: 'Weekly', addr: 'weekly@news.com' };
  const received = Array.from({ length: 12 }, (_, i) => mk({ from: news, subject: `Issue about thing ${'abcdefghijkl'[i]}`, bulk: true, ts: NOW - i * 7 * DAY }));
  const kindOf = (extra, addr = news.addr) => buildModel([...received, ...extra], defaultState(), opts).senders.get(addr).kind;
  const sent = (o) => mk({ from: 'me@x.com', sent: true, subject: 'Re: x', ts: NOW - 100 * DAY, ...o });
  assert.equal(kindOf([sent({ to: [news.addr] })]), 'channel', 'one reply to a newsletter');
  assert.equal(kindOf([sent({ to: [news.addr] }), sent({ to: [news.addr] })]), 'important', 'a real back-and-forth');
  // vacation responder: marked automatic, or carrying Precedence: bulk
  const person = Array.from({ length: 4 }, (_, i) => mk({ from: 'ann@a.com', subject: 'hi', ts: NOW - i * DAY }));
  const k = (s) => buildModel([...person, s], defaultState(), opts).senders.get('ann@a.com').kind;
  assert.equal(k(sent({ to: ['ann@a.com'], auto: true })), 'channel');
  assert.equal(k(sent({ to: ['ann@a.com'], bulk: true })), 'channel');
  assert.equal(k(sent({ to: ['ann@a.com'] })), 'important', 'one real reply to a person is enough');
  assert.ok(isBroadcast({ addr: 'noreply@svc.com', bulk: false, count: 3 }, 1) && !isBroadcast({ addr: 'ann@a.com', bulk: false, count: 300 }, 1));
});

test('bump: the bump date replaces the received date for ordering and fading', () => {
  const sent = mk({ from: 'me@x.com', sent: true, to: ['ann@a.com', 'bob@b.com', 'cy@c.com'], subject: 'x', ts: NOW - 400 * DAY });
  const ann = mk({ from: 'ann@a.com', subject: 'old question', ts: NOW - 45 * DAY });
  const bob = mk({ from: 'bob@b.com', subject: 'recent', ts: NOW - 2 * DAY });
  const cy = mk({ from: 'cy@c.com', subject: 'newest', ts: NOW - DAY });
  const alerts = Array.from({ length: 8 }, (_, i) => mk({ from: 'alerts@svc.com', subject: 'Daily report', ts: NOW - (i + 1) * DAY }));
  const oldAlarm = mk({ from: 'alerts@svc.com', subject: 'Certificate expired', ts: NOW - 40 * DAY });
  const newAlarm = mk({ from: 'alerts@svc.com', subject: 'Disk quota overdue', ts: NOW - 3 * DAY });
  const msgs = [sent, ann, bob, cy, ...alerts, oldAlarm, newAlarm];

  let model = buildModel(msgs, defaultState(), opts);
  assert.deepEqual(model.needsReply.map((m) => m.subject), ['newest', 'recent', 'old question']);
  assert.deepEqual(model.attention.map((m) => m.subject), ['Disk quota overdue'], 'the 40-day-old alarm has slipped off');

  const st = defaultState();
  st.bumped[ann.key] = NOW - 3600000;
  st.bumped[oldAlarm.key] = NOW - 7200000;
  model = buildModel(msgs, st, opts);
  assert.deepEqual(model.needsReply.map((m) => m.subject), ['old question', 'newest', 'recent']);
  assert.equal(ann.eff, NOW - 3600000);
  assert.equal(ann.ts, NOW - 45 * DAY, 'the real date is untouched');
  assert.deepEqual(model.attention.map((m) => m.subject), ['Certificate expired', 'Disk quota overdue'], 'bumping keeps it on the list');

  // a bump ages like any date: 31 days later it has slipped off again
  const later = buildModel(msgs, st, { ...opts, now: NOW + 31 * DAY });
  assert.ok(!later.attention.includes(oldAlarm));
});

test('attention period: the chosen window decides what is listed, flagged mail always is', () => {
  const from = 'alerts@svc.com';
  const routine = Array.from({ length: 8 }, (_, i) => mk({ from, subject: 'Daily report', ts: NOW - (i + 1) * DAY }));
  const alarms = [2, 20, 60, 120].map((d) => mk({ from, subject: `Thing ${d} overdue now`, ts: NOW - d * DAY - 1000 }));
  const msgs = [...routine, ...alarms];
  const listed = (days, mut) => {
    const st = defaultState(); st.settings.attnPeriod = days; mut?.(st);
    return buildModel(msgs, st, opts).attention.map((m) => m.subject.split(' ')[1]);
  };
  assert.deepEqual(listed(1), []);
  assert.deepEqual(listed(3), ['2']);
  assert.deepEqual(listed(30), ['2', '20']);
  assert.deepEqual(listed(90), ['2', '20', '60']);
  assert.deepEqual(listed(1, (st) => { st.flagged[alarms[3].key] = NOW; }), ['120'], 'flagged by hand, any age');
  assert.deepEqual(listed(3, (st) => { st.bumped[alarms[2].key] = NOW - DAY; }), ['60', '2'], 'bump date counts');
});

import { analyseIcon } from '../src/core/colors.mjs';

test('brand colour: dominant hue that is not white, black or grey', () => {
  const px = (n, r, g, b, a = 255) => Array.from({ length: n }, () => [r, g, b, a]).flat();
  // orange mark on a white tile, with some black text and anti-aliased greys
  const orange = analyseIcon(Uint8ClampedArray.from([...px(600, 255, 255, 255), ...px(250, 243, 128, 32), ...px(80, 0, 0, 0), ...px(60, 140, 140, 140), ...px(34, 250, 180, 110)]));
  const [r, g, b] = orange.color.match(/\d+/g).map(Number);
  assert.ok(r > 220 && g > 100 && g < 170 && b < 90, orange.color);
  assert.equal(orange.invert, false);
  // two colours: the larger area wins
  const two = analyseIcon(Uint8ClampedArray.from([...px(300, 20, 110, 230), ...px(100, 230, 40, 40)]));
  const [r2, , b2] = two.color.match(/\d+/g).map(Number);
  assert.ok(b2 > r2, two.color);
  // a dark brand colour is lifted so a thin underline shows on a dark surface, keeping its hue
  const navy = analyseIcon(Uint8ClampedArray.from(px(400, 10, 30, 110)));
  const [nr, ng, nb] = navy.color.match(/\d+/g).map(Number);
  assert.ok(nb > 150 && nb > nr && nb > ng, navy.color);
  // black shape on transparent: no colour, and it must be inverted to be visible
  assert.deepEqual(analyseIcon(Uint8ClampedArray.from([...px(500, 20, 22, 26), ...px(524, 0, 0, 0, 0)])), { color: null, invert: true });
  // black tile with a white glyph, fully opaque: no colour, shown as it is
  assert.deepEqual(analyseIcon(Uint8ClampedArray.from([...px(800, 10, 10, 10), ...px(224, 255, 255, 255)])), { color: null, invert: false });
  // white glyph on transparent: already visible
  assert.deepEqual(analyseIcon(Uint8ClampedArray.from([...px(400, 250, 250, 250), ...px(624, 0, 0, 0, 0)])), { color: null, invert: false });
  assert.deepEqual(analyseIcon(new Uint8ClampedArray(64)), { color: null, invert: false });
});

import { splitQuotedText } from '../src/core/quotes.mjs';

test('quoted history in plain-text replies is separated from the new text', () => {
  const gmail = 'Sounds good.\n\nMarcus\n\nOn Fri, 13 Nov 2026 at 09:12, Alex <a@x.com> wrote:\n> Tuesday works.\n>\n> On Thu, Marcus wrote:\n>> Are you free?';
  assert.deepEqual(splitQuotedText(gmail), { head: 'Sounds good.\n\nMarcus', quoted: gmail.slice(gmail.indexOf('On Fri')) });
  assert.equal(splitQuotedText('Yes.\n\nOn Fri, 13 Nov 2026 at 09:12, Alexander Longname\n<a@x.com> wrote:\n> q').head, 'Yes.');
  assert.equal(splitQuotedText('Agreed.\n\n-----Original Message-----\nFrom: A\nSent: Monday\n\nold').head, 'Agreed.');
  const outlook = splitQuotedText('Agreed.\n\n________________________________\nFrom: Ann <a@x.com>\nSent: 12 November 2026 10:00\nTo: Me\nSubject: Re: x\n\nold text');
  assert.equal(outlook.head, 'Agreed.');
  assert.match(outlook.quoted, /^_{10,}\nFrom: Ann/);
  assert.equal(splitQuotedText('Thanks!\n\n> earlier line\n> another').head, 'Thanks!');
  // not folded: nothing quoted, inline replies, forwards, or a message that is only a quote
  assert.equal(splitQuotedText('Just a normal message.\nFrom: here to there, see you.'), null);
  assert.equal(splitQuotedText('> you asked this\nMy answer is yes.\n> and this\nAlso yes.'), null);
  assert.equal(splitQuotedText('FYI\n\n---------- Forwarded message ---------\nFrom: A <a@x.com>\nDate: Mon\nSubject: x\n\nbody'), null);
  assert.equal(splitQuotedText('On Mon, A wrote:\n> everything is quoted'), null);
});

import { findUnsubscribe, parseListUnsubscribe, describeUnsubscribe } from '../src/core/unsubscribe.mjs';

test('unsubscribe: one-click request, then email, then the sender\'s page', () => {
  const both = '<mailto:leave@list.example?subject=Unsub%20me&body=id42>, <https://list.example/u/42>';
  assert.deepEqual(parseListUnsubscribe(both), { urls: ['https://list.example/u/42'], mailto: { to: 'leave@list.example', subject: 'Unsub me', body: 'id42' } });
  assert.deepEqual(findUnsubscribe({ listUnsubscribe: both, listUnsubscribePost: 'List-Unsubscribe=One-Click' }), { kind: 'oneclick', url: 'https://list.example/u/42' });
  assert.equal(findUnsubscribe({ listUnsubscribe: both }).kind, 'mailto', 'no one-click promise: use the email');
  assert.equal(findUnsubscribe({ listUnsubscribe: '<http://list.example/u>', listUnsubscribePost: 'List-Unsubscribe=One-Click' }).kind, 'link', 'one-click needs https');
  assert.deepEqual(findUnsubscribe({ listUnsubscribe: '<https://list.example/prefs>' }), { kind: 'link', url: 'https://list.example/prefs' });
  // from the body
  const links = [{ href: 'https://shop.example/sale', text: 'Shop now' }, { href: 'https://shop.example/prefs?u=1', text: 'Manage your email preferences' }, { href: 'https://shop.example/x/9f3', text: 'Unsubscribe' }];
  assert.deepEqual(findUnsubscribe({ links }), { kind: 'link', url: 'https://shop.example/x/9f3' });
  assert.deepEqual(findUnsubscribe({ links: links.slice(0, 2) }), { kind: 'link', url: 'https://shop.example/prefs?u=1' });
  assert.deepEqual(findUnsubscribe({ links: [{ href: 'https://e.example/track?opt_out=1&id=7', text: 'click here' }] }), { kind: 'link', url: 'https://e.example/track?opt_out=1&id=7' });
  assert.equal(findUnsubscribe({ links: [{ href: 'mailto:stop@x.example', text: 'unsubscribe' }] }).to, 'stop@x.example');
  assert.equal(findUnsubscribe({ links: [{ href: 'https://shop.example/sale', text: 'Shop now' }, { href: 'javascript:alert(1)', text: 'Unsubscribe' }] }), null);
  assert.equal(findUnsubscribe({ listUnsubscribe: '', links: [] }), null);
  assert.match(describeUnsubscribe({ kind: 'mailto', to: 'a@b.example' }), /email from your account to a@b\.example/);
});
