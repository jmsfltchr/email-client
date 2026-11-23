import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRaw, toMeta, toFull, encodeHeaderText } from '../src/core/mime.mjs';
import { AccountSync } from '../src/main/sync.mjs';
import { Gmail, GmailError, RateLimiter, quotaCost } from '../src/main/gmail.mjs';

const b64u = (s) => Buffer.from(s).toString('base64url');

test('buildRaw: plain reply with threading headers', () => {
  const raw = buildRaw({ from: { name: 'Alex', addr: 'a@x.com' }, to: 'Bob <b@y.com>', cc: 'c@z.com', bcc: 'd@z.com', subject: 'Re: Hi', text: 'Hello\nthere', inReplyTo: '<1@y>', references: '<0@y> <1@y>' });
  const [head, body] = raw.split('\r\n\r\n');
  assert.match(head, /^From: Alex <a@x\.com>\r\nTo: Bob <b@y\.com>\r\nCc: c@z\.com\r\nBcc: d@z\.com\r\nSubject: Re: Hi\r\n/);
  assert.match(head, /In-Reply-To: <1@y>/);
  assert.match(head, /References: <0@y>\r\n <1@y>/);
  assert.match(head, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.equal(Buffer.from(body, 'base64').toString(), 'Hello\r\nthere');
  assert.throws(() => buildRaw({ from: { addr: 'a@x.com' }, to: '', subject: 's', text: '' }), /No recipients/);
});

test('buildRaw: unicode headers and attachments', () => {
  const raw = buildRaw({ from: { name: 'Zoë', addr: 'z@x.com' }, to: [{ name: '', addr: 'b@y.com' }], subject: 'Grüße — 日本語のテスト、長い件名でも正しく折り返されること', text: 'x', attachments: [{ filename: 'résumé.pdf', mime: 'application/pdf', data: Buffer.alloc(200, 7) }] });
  assert.ok(/^[\x00-\x7f]*$/.test(raw), 'message is 7-bit clean');
  assert.match(raw, /From: =\?UTF-8\?B\?[\w+/=]+\?= <z@x\.com>/);
  const boundary = raw.match(/boundary="([^"]+)"/)[1];
  const parts = raw.split(`--${boundary}`);
  assert.equal(parts.length, 4);
  assert.match(parts[2], /filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/);
  assert.deepEqual(Buffer.from(parts[2].split('\r\n\r\n')[1].replace(/\s/g, ''), 'base64'), Buffer.alloc(200, 7));
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 78, `line too long: ${line.length}`);
  // encoded-words decode back losslessly
  const subj = 'Grüße — 日本語のテスト、長い件名でも正しく折り返されること';
  const decoded = encodeHeaderText(subj).split(/\r\n /).map((w) => Buffer.from(w.slice(10, -2), 'base64').toString()).join('');
  assert.equal(decoded, subj);
});

const gmsg = (id, { from = 'Bot <bot@svc.com>', subject = 'Hi', labels = ['INBOX'], extra = [] } = {}) => ({
  id, threadId: `t${id}`, internalDate: '1700000000000', labelIds: labels, snippet: 'a &amp; b &#39;c&#39;',
  payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: 'Me <me@x.com>, "Roe, R" <r@y.com>' }, { name: 'Cc', value: 'c@z.com' }, { name: 'Subject', value: subject }, ...extra] },
});

test('toMeta maps Gmail metadata and skips drafts/spam', () => {
  const m = toMeta('me@x.com', gmsg('1', { labels: ['SENT'], extra: [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] }));
  assert.deepEqual({ key: m.key, from: m.from, to: m.to, sent: m.sent, bulk: m.bulk, snippet: m.snippet, ts: m.ts },
    { key: 'me@x.com:1', from: { name: 'Bot', addr: 'bot@svc.com' }, to: ['me@x.com', 'r@y.com', 'c@z.com'], sent: true, bulk: true, snippet: "a & b 'c'", ts: 1700000000000 });
  assert.equal(toMeta('me@x.com', gmsg('2', { labels: ['DRAFT'] })), null);
  assert.equal(toMeta('me@x.com', gmsg('3', { labels: ['SPAM'] })), null);
});

test('toFull extracts bodies, attachments and inline images', () => {
  const full = toFull({
    id: '1', threadId: 't', internalDate: '5',
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Message-ID', value: '<m@x>' }, { name: 'Reply-To', value: 'r@x.com' }], parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64u('plain ü') } },
        { mimeType: 'multipart/related', parts: [
          { mimeType: 'text/html', body: { data: b64u('<p>html <img src="cid:logo1"></p>') } },
          { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<logo1>' }], body: { attachmentId: 'A1', size: 10 } },
        ] },
      ] },
      { mimeType: 'application/pdf', filename: 'doc.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="doc.pdf"' }], body: { attachmentId: 'A2', size: 99 } },
    ] },
  });
  assert.equal(full.text, 'plain ü');
  assert.match(full.html, /cid:logo1/);
  assert.deepEqual(full.attachments.map((a) => [a.filename, a.attId, a.size]), [['doc.pdf', 'A2', 99]]);
  assert.deepEqual(full.inline.map((a) => [a.cid, a.attId]), [['logo1', 'A1']]);
  assert.equal(full.headers.messageId, '<m@x>');
  assert.equal(full.headers.replyTo, 'r@x.com');
});

function fakeGmail(mailbox) {
  const calls = [];
  return {
    calls,
    profile: async () => ({ historyId: String(mailbox.historyId) }),
    async *listIds(q) { calls.push(q); for (const id of mailbox.list(q)) yield id; },
    getMeta: async (id) => { if (!mailbox.msgs[id]) throw new GmailError(404, 'gone'); return mailbox.msgs[id]; },
    history: async (start) => mailbox.history(start),
  };
}

test('sync: backfill, incremental add/remove, and expired history recovery', async () => {
  const mailbox = {
    historyId: 100,
    msgs: { a: gmsg('a'), b: gmsg('b', { labels: ['SENT'] }), c: gmsg('c') },
    unread: ['a', 'c'],
    list: (q) => (q.startsWith('is:unread') ? mailbox.unread : q.startsWith('in:sent') ? ['b'] : ['a', 'b', 'c', 'gone']),
    history: () => ({ added: new Set(), removed: new Set(), historyId: '100' }),
  };
  const events = [];
  let saves = 0;
  const gmail = fakeGmail(mailbox);
  const sync = new AccountSync({ email: 'me@x.com', gmail, saved: null, save: () => saves++, emit: (e) => events.push(e), syncMonths: () => 12 });
  await sync.tick();
  assert.equal(sync.backfillDone, true);
  assert.deepEqual([...sync.messages.keys()].sort(), ['a', 'b', 'c']);
  assert.match(gmail.calls[0], /^is:unread newer_than:90d/);
  assert.match(gmail.calls[1], /^newer_than:30d/);
  assert.match(gmail.calls[3], /^after:\d{4}\/\d+\/\d+ -in:drafts -in:chats$/);
  assert.ok(saves > 0);
  assert.deepEqual(events.filter((e) => e.type === 'unread').map((e) => e.ids), [['a', 'c']], 'reported once, not again when unchanged');
  assert.deepEqual([...sync.unread], ['a', 'c']);
  assert.equal(events.filter((e) => e.type === 'error').length, 0);

  // incremental: one new, one deleted
  mailbox.msgs.d = gmsg('d');
  mailbox.history = () => ({ added: new Set(['d']), removed: new Set(['a']), historyId: '120' });
  events.length = 0;
  await sync.tick();
  assert.deepEqual([...sync.messages.keys()].sort(), ['b', 'c', 'd']);
  assert.equal(sync.historyId, '120');
  assert.deepEqual(events.find((e) => e.removed?.length).removed, ['me@x.com:a']);
  mailbox.unread = ['c', 'd']; // 'a' was read elsewhere, 'd' is new
  assert.ok(events.find((e) => e.live && e.added[0]?.id === 'd'));
  assert.equal(events.filter((e) => e.type === 'unread').length, 0, 'nothing reported while the unread set is unchanged');
  events.length = 0;
  await sync.tick();
  assert.deepEqual(events.find((e) => e.type === 'unread').ids, ['c', 'd']);
  assert.deepEqual(sync.snapshot().unread, ['c', 'd']);

  // resume from snapshot
  const resumed = new AccountSync({ email: 'me@x.com', gmail, saved: JSON.parse(JSON.stringify(sync.snapshot())), save() {}, emit() {}, syncMonths: () => 12 });
  assert.equal(resumed.backfillDone, true);
  assert.equal(resumed.messages.size, 3);

  // history too old -> re-anchor and rescan
  mailbox.history = () => { throw new GmailError(404, 'too old'); };
  mailbox.historyId = 500;
  mailbox.msgs.e = gmsg('e');
  mailbox.list = () => ['e', 'd'];
  await sync.tick();
  assert.equal(sync.historyId, '500');
  assert.ok(sync.messages.has('e'));

  // auth failure is reported, not thrown
  mailbox.history = () => { const e = new Error('expired'); e.code = 'invalid_grant'; throw e; };
  events.length = 0;
  await sync.tick();
  assert.equal(events.find((e) => e.type === 'error').auth, true);
});

test('Gmail client: retries rate limits, pages lists, picks send transport by size', async () => {
  const seen = [];
  let fail = 2;
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (fail-- > 0) return new Response(JSON.stringify({ error: { message: 'slow down', errors: [{ reason: 'rateLimitExceeded' }] } }), { status: 429 });
    const u = new URL(url);
    if (u.pathname.endsWith('/messages') && !u.searchParams.get('pageToken')) return Response.json({ messages: [{ id: '1' }, { id: '2' }], nextPageToken: 'p2' });
    if (u.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: '3' }] });
    return Response.json({ id: 'sent1', threadId: 'T' });
  };
  const g = new Gmail(async () => 'tok', fetchImpl, { limiter: null });
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realTimeout(fn, 0); // skip backoff waits
  try {
    const ids = [];
    for await (const id of g.listIds('in:sent')) ids.push(id);
    assert.deepEqual(ids, ['1', '2', '3']);
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');

    seen.length = 0;
    await g.send('From: a\r\n\r\nhi', 'T');
    assert.match(seen[0].url, /\/gmail\/v1\/users\/me\/messages\/send$/);
    assert.deepEqual(JSON.parse(seen[0].init.body), { raw: Buffer.from('From: a\r\n\r\nhi').toString('base64url'), threadId: 'T' });

    seen.length = 0;
    await g.send(`From: a\r\n\r\n${'x'.repeat(4 * 1024 * 1024)}`, 'T');
    assert.match(seen[0].url, /\/upload\/gmail\/v1\/users\/me\/messages\/send\?uploadType=multipart$/);
    assert.match(seen[0].init.headers['Content-Type'], /^multipart\/related; boundary=/);
    assert.ok(seen[0].init.body.includes('{"threadId":"T"}'));
  } finally { globalThis.setTimeout = realTimeout; }
});

import { fetchContactPhotos, fetchOrgIcon } from '../src/main/contacts.mjs';

test('contact photos: merges saved and other contacts, skips placeholders, reports missing permission', async () => {
  const calls = [];
  const gmail = {
    async request(url, { query }) {
      calls.push([url, query]);
      if (url.endsWith('/connections')) {
        return query.pageToken
          ? { connections: [{ emailAddresses: [{ value: 'B@y.com' }], photos: [{ url: 'https://p/b' }] }] }
          : { nextPageToken: 'n', connections: [{ emailAddresses: [{ value: 'a@x.com' }, { value: 'a2@x.com' }], photos: [{ url: 'https://p/default', default: true }, { url: 'https://p/a' }] }] };
      }
      if (query.sources) throw new GmailError(400, 'bad sources');
      return { otherContacts: [{ emailAddresses: [{ value: 'c@z.com' }], photos: [{ url: 'https://p/c' }] }, { emailAddresses: [{ value: 'd@z.com' }], photos: [{ url: 'https://p/d', default: true }] }, { emailAddresses: [{ value: 'a@x.com' }], photos: [{ url: 'https://p/other' }] }] };
    },
  };
  const r = await fetchContactPhotos(gmail);
  assert.deepEqual(r.photos, { 'a@x.com': 'https://p/a', 'a2@x.com': 'https://p/a', 'b@y.com': 'https://p/b', 'c@z.com': 'https://p/c' });
  assert.equal(r.denied, false);
  assert.equal(calls.length, 4);
  const denied = await fetchContactPhotos({ async request() { throw new GmailError(403, 'insufficient scope'); } });
  assert.deepEqual([denied.photos, denied.denied], [{}, true]);
});

test('org icons: data URL on success, null for unknown or reserved domains', async () => {
  const png = Buffer.from([137, 80, 78, 71]);
  const ok = async (url) => { assert.match(String(url), /favicons\?domain=github\.com&sz=64$/); return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  assert.equal(await fetchOrgIcon('github.com', ok), `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(await fetchOrgIcon('nope.dev', async () => new Response(png, { status: 404, headers: { 'content-type': 'image/png' } })), null);
  const never = async () => { throw new Error('should not be called'); };
  assert.equal(await fetchOrgIcon('fernhill.example', never), null);
  assert.equal(await fetchOrgIcon('bad domain/../x', never), null);
});

test('rate limiter keeps background work under the per-minute quota', async () => {
  let t = 0;
  const waits = [];
  const lim = new RateLimiter({ perMinute: 6000, burst: 100, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
  for (let i = 0; i < 1200; i++) await lim.take(5); // 6,000 units of metadata fetches
  assert.ok(t >= 58000 && t <= 60000, `6,000 units took ${t} ms`);

  // urgent calls never wait, but their cost is repaid by later background work
  const before = t;
  await lim.take(100, true);
  assert.equal(t, before);
  await lim.take(5);
  assert.ok(t - before >= 1000, 'background work waited for the borrowed units');

  // a pause holds queued work, in order
  lim.pause(30000);
  const start = t;
  const order = [];
  await Promise.all([lim.take(5).then(() => order.push('a')), lim.take(5).then(() => order.push('b'))]);
  assert.ok(t - start >= 30000);
  assert.deepEqual(order, ['a', 'b']);

  assert.equal(quotaCost('https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=metadata'), 5);
  assert.equal(quotaCost('https://gmail.googleapis.com/gmail/v1/users/me/messages/send'), 100);
  assert.equal(quotaCost('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'), 100);
  assert.equal(quotaCost('https://gmail.googleapis.com/gmail/v1/users/me/history'), 2);
  assert.equal(quotaCost('https://people.googleapis.com/v1/otherContacts'), 0);
});

test('Gmail client: a quota error pauses the limiter and the request then succeeds', async () => {
  let t = 0, calls = 0;
  const lim = new RateLimiter({ now: () => t, wait: async (ms) => { t += ms; } });
  const quota = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", errors: [{ reason: 'rateLimitExceeded' }] } };
  const g = new Gmail(async () => 'tok', async () => (++calls <= 3 ? new Response(JSON.stringify(quota), { status: calls === 2 ? 403 : 429 }) : Response.json({ id: 'x' })), { limiter: lim });
  assert.deepEqual(await g.getMeta('x'), { id: 'x' });
  assert.equal(calls, 4);
  assert.ok(t >= 35000, `held back ${t} ms across three refusals`);

  // gives up eventually, flagged as a rate limit so the UI can say so
  const always = new Gmail(async () => 'tok', async () => new Response(JSON.stringify(quota), { status: 429 }), { limiter: new RateLimiter({ now: () => t, wait: async (ms) => { t += ms; } }) });
  await assert.rejects(always.getMeta('x'), (e) => e.limited === true && e.status === 429);
});

test('toFull: an image the HTML references by Content-ID is inline whatever its disposition', () => {
  const part = (cid, disp, name) => ({ mimeType: 'image/png', filename: name, headers: [{ name: 'Content-ID', value: `<${cid}>` }, { name: 'Content-Disposition', value: disp }], body: { attachmentId: `att-${name}`, size: 10 } });
  const full = toFull({ id: '1', payload: { mimeType: 'multipart/related', parts: [
    { mimeType: 'text/html', body: { data: b64u('<img src="cid:logo@x"><img src="cid:sig%40corp">') } },
    part('logo@x', 'attachment; filename="logo.png"', 'logo.png'),
    part('sig@corp', 'inline', 'sig.png'),
    part('unused@x', 'inline', 'photo.png'),
  ] } });
  assert.deepEqual(full.inline.map((i) => i.cid), ['logo@x', 'sig@corp']);
  assert.deepEqual(full.attachments.map((a) => a.filename), ['photo.png'], 'an unreferenced picture stays downloadable');
});
