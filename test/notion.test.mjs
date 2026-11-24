import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationOf, nameFromTitle, parseDatabaseId, platformOf, linkFromInput, parseLinks, linksToRichText, describeSchema, missingProperties, pageToRow, rowToProperties, NOTION_VERSION } from '../src/core/notion.mjs';
import { Notion } from '../src/main/notion.mjs';
import { createDemoNotion } from '../src/renderer/testers-demo.mjs';

const ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const DASHED = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

test('database id from a link, a bare id or a dashed id', () => {
  assert.equal(parseDatabaseId(`https://www.notion.so/acme/Alpha-testers-${ID}?v=ffffffffffffffffffffffffffffffff`), DASHED);
  assert.equal(parseDatabaseId(`https://www.notion.so/${ID}`), DASHED);
  assert.equal(parseDatabaseId(ID.toUpperCase()), DASHED);
  assert.equal(parseDatabaseId(DASHED), DASHED);
  assert.equal(parseDatabaseId('https://www.notion.so/acme/Alpha-testers'), null);
  assert.equal(parseDatabaseId(''), null);
});

test('platform is recognised from the address', () => {
  assert.equal(platformOf('https://www.instagram.com/direct/t/123'), 'instagram');
  assert.equal(platformOf('https://discord.com/channels/@me/1'), 'discord');
  assert.equal(platformOf('https://acme.slack.com/archives/D012'), 'slack');
  assert.equal(platformOf('https://app.slack.com/client/T1/D1'), 'slack');
  assert.equal(platformOf('https://teams.microsoft.com/l/chat/0/0'), 'teams');
  assert.equal(platformOf('https://teams.live.com/l/invite/x'), 'teams');
  assert.equal(platformOf('https://notslack.com/x'), 'web');
  assert.equal(platformOf('https://slack.com.evil.example/x'), 'web');
  assert.equal(platformOf('javascript:alert(1)'), null);
  assert.equal(platformOf('nonsense'), null);
});

test('typed input becomes a link or is refused', () => {
  assert.deepEqual(linkFromInput(' https://discord.com/channels/@me/1 ', ' DM '), { platform: 'discord', url: 'https://discord.com/channels/@me/1', label: 'DM' });
  assert.deepEqual(linkFromInput('acme.slack.com/archives/D1'), { platform: 'slack', url: 'https://acme.slack.com/archives/D1', label: '' });
  assert.deepEqual(linkFromInput('Sam@Example.com', 'work'), { platform: 'email', address: 'sam@example.com', label: 'work' });
  assert.deepEqual(linkFromInput('mailto:sam@example.com?subject=x'), { platform: 'email', address: 'sam@example.com', label: '' });
  assert.equal(linkFromInput('hello there'), null);
  assert.equal(linkFromInput('file:///etc/passwd'), null);
});

test('links survive a round trip through Notion rich text', () => {
  const links = [
    { platform: 'slack', url: 'https://acme.slack.com/archives/D1', label: 'DM' },
    { platform: 'discord', url: 'https://discord.com/channels/@me/1', label: '' },
    { platform: 'discord', url: 'https://discord.com/channels/2/3', label: '#alpha: feedback' },
    { platform: 'email', address: 'sam@example.com', label: 'work' },
    { platform: 'email', address: 'sam@home.example', label: '' },
    { platform: 'web', url: 'https://forum.example/u/sam', label: '' },
    { platform: 'note', text: 'prefers mornings' },
  ];
  const rich = linksToRichText(links);
  assert.equal(rich[0].text.content, 'Slack: DM');
  assert.equal(rich[0].text.link.url, 'https://acme.slack.com/archives/D1');
  assert.ok(rich.every((r) => r.text.content.length <= 2000));
  assert.deepEqual(parseLinks(rich), links);
  // as Notion returns it: plain_text and href
  const returned = rich.map((r) => ({ type: 'text', text: r.text, plain_text: r.text.content, href: r.text.link?.url || null }));
  assert.deepEqual(parseLinks(returned), links);
  assert.deepEqual(parseLinks([]), []);
  assert.deepEqual(linksToRichText([]), []);
});

test('links typed by hand in Notion are understood', () => {
  const rich = [
    { plain_text: 'https://www.instagram.com/direct/t/9\nDiscord DM: ', href: null },
    { plain_text: 'https://discord.com/channels/@me/1', href: 'https://discord.com/channels/@me/1' },
    { plain_text: '\nsam@example.com\n\n', href: null },
    { plain_text: 'write to Sam', href: 'mailto:sam@work.example' },
  ];
  assert.deepEqual(parseLinks(rich), [
    { platform: 'instagram', url: 'https://www.instagram.com/direct/t/9', label: '' },
    { platform: 'discord', url: 'https://discord.com/channels/@me/1', label: 'Discord DM: https://discord.com/channels/@me/1' },
    { platform: 'email', address: 'sam@example.com', label: '' },
    { platform: 'email', address: 'sam@work.example', label: 'write to Sam' },
  ]);
});

const PROPS = {
  Person: { type: 'title', title: {} },
  Notes: { type: 'rich_text', rich_text: {} },
  Links: { type: 'rich_text', rich_text: {} },
  Labels: { type: 'multi_select', multi_select: { options: [{ name: 'iOS', color: 'blue' }] } },
  Stage: { type: 'status', status: { options: [{ name: 'Active', color: 'green' }] } },
  Owner: { type: 'people', people: {} },
  Seats: { type: 'number', number: {} },
};

test('schema: uses the columns that are there, and asks only for what is missing', () => {
  const s = describeSchema(PROPS);
  assert.equal(s.title, 'Person');
  assert.equal(s.links, 'Links');
  assert.deepEqual(s.fields.map((f) => f.name), ['Labels', 'Stage', 'Seats', 'Notes']);
  assert.deepEqual(s.fields[0].options, [{ name: 'iOS', color: 'blue' }]);
  assert.deepEqual(missingProperties(PROPS), {});
  assert.deepEqual(missingProperties({ Name: { type: 'title', title: {} } }), { 'Conversation links': { rich_text: {} }, Tags: { multi_select: {} } });
});

test('rows are read from and written to Notion pages', () => {
  const schema = describeSchema(PROPS);
  const page = {
    id: 'p1', url: 'https://www.notion.so/p1', last_edited_time: '2026-11-01T10:00:00.000Z',
    properties: {
      Person: { type: 'title', title: [{ plain_text: 'Sam ' }, { plain_text: 'Okafor' }] },
      Notes: { type: 'rich_text', rich_text: [{ plain_text: 'likes dark mode' }] },
      Links: { type: 'rich_text', rich_text: [{ plain_text: 'Slack: DM', href: 'https://acme.slack.com/archives/D1' }] },
      Labels: { type: 'multi_select', multi_select: [{ name: 'iOS' }] },
      Stage: { type: 'status', status: { name: 'Active' } },
      Seats: { type: 'number', number: 3 },
    },
  };
  const row = pageToRow(page, schema);
  assert.equal(row.name, 'Sam Okafor');
  assert.deepEqual(row.values, { Labels: ['iOS'], Stage: 'Active', Seats: 3, Notes: 'likes dark mode' });
  assert.deepEqual(row.links, [{ platform: 'slack', url: 'https://acme.slack.com/archives/D1', label: 'DM' }]);
  assert.deepEqual(pageToRow({ id: 'p2', properties: {} }, schema).values, { Labels: [], Stage: '', Seats: null, Notes: '' });

  assert.deepEqual(rowToProperties(schema, { name: ' Sam ', values: { Labels: ['iOS', 'beta'], Stage: '', Seats: '', Notes: 'x', Owner: 'ignored' } }), {
    Person: { title: [{ type: 'text', text: { content: 'Sam' } }] },
    Labels: { multi_select: [{ name: 'iOS' }, { name: 'beta' }] },
    Stage: { status: null },
    Seats: { number: null },
    Notes: { rich_text: [{ type: 'text', text: { content: 'x' } }] },
  });
  assert.deepEqual(rowToProperties(schema, { values: { Notes: 'a'.repeat(4100) } }).Notes.rich_text.map((r) => r.text.content.length), [2000, 2000, 100]);
  assert.throws(() => rowToProperties({ ...schema, links: null }, { links: [] }), /Conversation links/);
});

test('client: pages through results, retries when rate limited, explains refusals', async () => {
  const calls = [];
  const reply = (status, body, headers = {}) => ({ ok: status < 400, status, headers: new Headers(headers), json: async () => body });
  const script = [
    reply(429, { code: 'rate_limited' }, { 'retry-after': '0.01' }),
    reply(200, { results: [{ object: 'page', id: 'a' }, { object: 'page', id: 'gone', in_trash: true }], has_more: true, next_cursor: 'c2' }),
    reply(200, { results: [{ object: 'page', id: 'b' }], has_more: false, next_cursor: null }),
    reply(404, { code: 'object_not_found', message: 'Could not find database' }),
  ];
  const client = new Notion('secret', async (url, init) => { calls.push({ url, init }); return script.shift(); });
  assert.deepEqual((await client.queryAll('ds1')).map((p) => p.id), ['a', 'b']);
  assert.equal(calls[0].url, 'https://api.notion.com/v1/data_sources/ds1/query');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['Notion-Version'], NOTION_VERSION);
  assert.equal(JSON.parse(calls[2].init.body).start_cursor, 'c2');
  await assert.rejects(client.dataSource('nope'), /Connections/);
});

test('demo database behaves like the real one', async () => {
  const api = createDemoNotion();
  const { rows, schema } = await api.notionLoad();
  assert.ok(rows.length >= 4 && rows.every((r) => r.links.every(Boolean)));
  const made = await api.notionCreate({ name: 'New Person' });
  const saved = await api.notionUpdate(made.id, { values: { Tags: ['brand new'] }, links: [linkFromInput('https://discord.com/channels/@me/5')] });
  assert.deepEqual(saved.values.Tags, ['brand new']);
  assert.equal(saved.links[0].platform, 'discord');
  await api.notionTrash(made.id);
  assert.equal((await api.notionLoad()).rows.length, rows.length);
  await api.notionTrash(made.id, false);
  assert.equal((await api.notionLoad()).rows.length, rows.length + 1);
  assert.ok(schema.fields.some((f) => f.type === 'multi_select'));
});

test('a web address is recognised as a conversation, and the same conversation always gets the same key', () => {
  const key = (u) => conversationOf(u)?.key ?? null;
  assert.equal(key('https://app.slack.com/client/T0ACME/D0PRIYA1'), 'slack:D0PRIYA1');
  assert.equal(key('https://app.slack.com/client/T0ACME/D0PRIYA1/thread/D0PRIYA1-1700000000.000100'), 'slack:D0PRIYA1');
  assert.equal(key('https://acme.slack.com/archives/D0PRIYA1/p1700000000000100'), 'slack:D0PRIYA1');
  assert.equal(key('https://app.slack.com/client/T0ACME/unreads'), null);
  assert.equal(key('https://app.slack.com/client'), null);
  assert.equal(key('https://discord.com/channels/@me/200000000000000001'), 'discord:200000000000000001');
  assert.equal(key('https://discord.com/channels/3000/4000/5000'), 'discord:4000');
  assert.equal(key('https://discord.com/channels/@me'), null);
  assert.equal(key('https://www.instagram.com/direct/t/1000001/'), 'instagram:1000001');
  assert.equal(key('https://www.instagram.com/direct/inbox/'), null);
  assert.equal(key('https://teams.microsoft.com/l/chat/19%3Aabc-def_123%40thread.v2/conversations?tenantId=x'), 'teams:19:abc-def_123@thread.v2');
  assert.equal(key('https://teams.microsoft.com/l/chat/0/0?users=B@x.example,a@x.example'), key('https://teams.microsoft.com/l/chat/0/0?users=a@x.example,b@x.example'));
  assert.equal(key('https://teams.microsoft.com/v2/'), null);
  assert.equal(key('https://example.com/direct/t/1'), null);
  assert.equal(key('not a url'), null);
  // what gets stored is the conversation, not the message or thread that happened to be open
  assert.equal(conversationOf('https://discord.com/channels/3000/4000/5000').url, 'https://discord.com/channels/3000/4000');
  assert.equal(conversationOf('https://app.slack.com/client/T0ACME/D0PRIYA1/thread/x').url, 'https://app.slack.com/client/T0ACME/D0PRIYA1');
  assert.equal(conversationOf('https://app.slack.com/client/T0ACME/D0PRIYA1').platform, 'slack');
});

test('a name is guessed from the page title', () => {
  assert.equal(nameFromTitle('alice (DM) - Acme - Slack'), 'alice');
  assert.equal(nameFromTitle('Slack | Sam Okafor | Acme'), 'Sam Okafor');
  assert.equal(nameFromTitle('(3) Discord | @marcus'), 'marcus');
  assert.equal(nameFromTitle('• Discord | @marcus'), 'marcus');
  assert.equal(nameFromTitle('Chat | Dana Whitfield | Microsoft Teams'), 'Dana Whitfield');
  assert.equal(nameFromTitle('(1) Inbox • Chats'), '');
  assert.equal(nameFromTitle('Instagram'), '');
  assert.equal(nameFromTitle(''), '');
});
