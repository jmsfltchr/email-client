// Notion database <-> tester rows. Pure functions: no network, no Electron.
//
// One database row is one person. Their conversation links live in a single rich-text property,
// one link per line, so the list stays readable (and clickable) inside Notion itself:
//   Slack: design feedback        <- the whole line is a hyperlink to the conversation
//   Email: sam@example.com (work) <- plain text

export const NOTION_VERSION = '2025-09-03';
export const LINKS_PROPERTY = 'Conversation links';
export const TAGS_PROPERTY = 'Tags';

export const PLATFORMS = {
  instagram: { name: 'Instagram', short: 'IG', color: '#e8589a' },
  discord: { name: 'Discord', short: 'DC', color: '#8c96f7' },
  slack: { name: 'Slack', short: 'SL', color: '#ecb22e' },
  teams: { name: 'Teams', short: 'TM', color: '#9aa2f2' },
  email: { name: 'Email', short: '@', color: '#7fd1b6' },
  web: { name: 'Web', short: '↗', color: '#878a8f' },
};

const HOSTS = [
  ['instagram', /(^|\.)(instagram\.com|ig\.me)$/],
  ['discord', /(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/],
  ['slack', /(^|\.)slack\.com$/],
  ['teams', /(^|\.)(teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|teams\.microsoft\.us)$/],
];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/i;
const URL_RE = /https?:\/\/[^\s<>"]+/i;

/** Which messaging platform a web address belongs to; 'web' for anything else, null if it is not a web address. */
export function platformOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  for (const [id, re] of HOSTS) if (re.test(host)) return id;
  return 'web';
}

/**
 * The conversation a web address shows, if it shows one: {platform, key, url}. Two addresses for the same
 * conversation give the same key (a Slack "archives" link and the address the Slack app settles on, a Discord
 * channel and a message inside it). An inbox, a profile or any other page gives null.
 */
export function conversationOf(url) {
  const platform = platformOf(url);
  if (!platform || platform === 'web') return null;
  const u = new URL(url);
  let m;
  if (platform === 'instagram') {
    m = u.pathname.match(/^\/direct\/t\/([\w.-]+)/);
    return m ? { platform, key: `instagram:${m[1]}`, url: `https://www.instagram.com/direct/t/${m[1]}/` } : null;
  }
  if (platform === 'discord') {
    m = u.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
    return m ? { platform, key: `discord:${m[2]}`, url: `https://discord.com/channels/${m[1]}/${m[2]}` } : null;
  }
  if (platform === 'slack') {
    m = u.pathname.match(/^\/client\/([A-Z0-9]+)\/([CDG][A-Z0-9]{5,})/);
    if (m) return { platform, key: `slack:${m[2]}`, url: `https://app.slack.com/client/${m[1]}/${m[2]}` };
    m = u.pathname.match(/^\/(?:archives|messages)\/([CDG][A-Z0-9]{5,})/);
    return m ? { platform, key: `slack:${m[1]}`, url: `${u.origin}/archives/${m[1]}` } : null;
  }
  // Teams: a chat is named by its thread id, or (in "chat with these people" links) by the people.
  let text = u.href;
  try { text = decodeURIComponent(text); } catch { /* keep as is */ }
  m = text.match(/19:[\w-]+@(?:thread\.\w+|unq\.gbl\.spaces)/);
  if (m) return { platform, key: `teams:${m[0].toLowerCase()}`, url };
  const users = u.searchParams.get('users');
  return users ? { platform, key: `teams:users:${users.toLowerCase().split(',').map((s) => s.trim()).sort().join(',')}`, url } : null;
}

const TITLE_NOISE = /^(instagram|discord|slack|microsoft teams|teams|chats?|inbox|direct|messages?|friends|threads|activity|new message|\d+ new items?)$/i;

/** A guess at who a conversation is with, from the page title ("alice (DM) - Acme - Slack" -> "alice"). */
export function nameFromTitle(title) {
  const parts = String(title || '').replace(/^[•*!\s]+/, '').replace(/^\(\d+\+?\)\s*/, '').split(/\s+[|•·–—-]\s+/)
    .map((p) => p.replace(/^\(\d+\+?\)\s*/, '').replace(/^[@#]/, '').replace(/\s*\((DM|you|private)\)\s*$/i, '').trim())
    .filter((p) => p && !TITLE_NOISE.test(p));
  return parts[0] || '';
}

/** Turn what someone typed or pasted into a link: a web address, an email address, or null. */
export function linkFromInput(input, label = '') {
  const text = String(input || '').trim();
  label = String(label || '').trim();
  if (/^mailto:/i.test(text) || (!/^https?:/i.test(text) && EMAIL_RE.test(text) && !/[\s/]/.test(text))) {
    const address = text.replace(/^mailto:/i, '').split('?')[0].toLowerCase();
    return EMAIL_RE.test(address) ? { platform: 'email', address, label } : null;
  }
  const url = /^https?:\/\//i.test(text) ? text : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(text) ? `https://${text}` : '';
  const platform = platformOf(url);
  return platform ? { platform, url, label } : null;
}

/** The 32-hex id of a database from its link (or the id itself), as a dashed UUID. */
export function parseDatabaseId(input) {
  let s = String(input || '').trim();
  try { if (/^https?:/i.test(s)) s = new URL(s).pathname; } catch { /* treat as an id */ }
  const m = s.replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/gi);
  if (!m) return null;
  const h = m[m.length - 1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const plain = (rich) => (rich || []).map((t) => t.plain_text ?? t.text?.content ?? '').join('');

const chunks = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i += 2000) out.push({ type: 'text', text: { content: s.slice(i, i + 2000) } });
  return out;
};

// ------------------------------------------------------------ conversation links

function cleanLabel(text, platform) {
  let t = text.trim();
  const names = [PLATFORMS[platform]?.name, 'Link'].filter(Boolean);
  for (const n of names) {
    if (t.toLowerCase() === n.toLowerCase()) return '';
    if (t.toLowerCase().startsWith(`${n.toLowerCase()}:`)) { t = t.slice(n.length + 1).trim(); break; }
  }
  return t;
}

/** Read the links property. Lines that are not links are kept as notes so nothing typed in Notion is lost. */
export function parseLinks(rich) {
  const lines = [{ text: '', href: null }];
  for (const item of rich || []) {
    const href = item.href || item.text?.link?.url || null;
    const parts = (item.plain_text ?? item.text?.content ?? '').split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push({ text: '', href: null });
      const line = lines[lines.length - 1];
      line.text += part;
      if (part.trim() && href && !line.href) line.href = href;
    });
  }
  const out = [];
  for (const { text, href } of lines) {
    const t = text.trim();
    if (!t && !href) continue;
    if (href && /^mailto:/i.test(href)) {
      const address = href.slice(7).split('?')[0].toLowerCase();
      const label = cleanLabel(t, 'email').replace(address, '').replace(/^[\s(]+|[\s)]+$/g, '');
      out.push({ platform: 'email', address, label });
    } else if (href && platformOf(href)) {
      const platform = platformOf(href);
      const label = cleanLabel(t, platform);
      out.push({ platform, url: href, label: label === href ? '' : label });
    } else if (URL_RE.test(t)) {
      const url = t.match(URL_RE)[0].replace(/[.,;)]+$/, '');
      const platform = platformOf(url) || 'web';
      out.push({ platform, url, label: cleanLabel(t.replace(url, '').replace(/[\s:–—-]+$/, ''), platform) });
    } else if (EMAIL_RE.test(t)) {
      const address = t.match(EMAIL_RE)[0].toLowerCase();
      const rest = cleanLabel(t, 'email');
      const label = rest.replace(new RegExp(address.replace(/[.+]/g, '\\$&'), 'i'), '').replace(/^[\s(:–—-]+|[\s):–—-]+$/g, '');
      out.push({ platform: 'email', address, label });
    } else {
      out.push({ platform: 'note', text: t });
    }
  }
  return out;
}

/** Write links back as Notion rich text, one per line. */
export function linksToRichText(links) {
  const out = [];
  for (const l of links || []) {
    if (out.length) out.push({ type: 'text', text: { content: '\n' } });
    if (l.platform === 'note') out.push(...chunks(l.text));
    else if (l.platform === 'email') out.push({ type: 'text', text: { content: `Email: ${l.address}${l.label ? ` (${l.label})` : ''}`.slice(0, 2000) } });
    else {
      const name = l.platform === 'web' ? 'Link' : PLATFORMS[l.platform].name;
      out.push({ type: 'text', text: { content: `${name}${l.label ? `: ${l.label}` : ''}`.slice(0, 2000), link: { url: l.url } } });
    }
  }
  if (out.length > 100) throw new Error('Too many conversation links for one person (Notion allows about 50).');
  return out;
}

// ------------------------------------------------------------ schema and rows

const EDITABLE = ['multi_select', 'select', 'status', 'checkbox', 'date', 'number', 'url', 'email', 'phone_number', 'rich_text'];

/** What the app needs to know about the database's columns. */
export function describeSchema(properties) {
  const all = Object.entries(properties || {}).map(([name, p]) => ({ name, type: p.type, options: (p[p.type]?.options || []).map((o) => ({ name: o.name, color: o.color || 'default' })) }));
  const title = all.find((p) => p.type === 'title')?.name || 'Name';
  const links = all.find((p) => p.type === 'rich_text' && /^(conversation )?links$/i.test(p.name.trim()))?.name || null;
  const fields = all
    .filter((p) => EDITABLE.includes(p.type) && p.name !== links)
    .sort((a, b) => EDITABLE.indexOf(a.type) - EDITABLE.indexOf(b.type));
  return { title, links, fields };
}

/** Columns the app needs that the database does not have yet, as a schema update. */
export function missingProperties(properties) {
  const s = describeSchema(properties);
  const add = {};
  if (!s.links) add[LINKS_PROPERTY] = { rich_text: {} };
  if (!s.fields.some((f) => f.type === 'multi_select')) add[TAGS_PROPERTY] = { multi_select: {} };
  return add;
}

function readValue(type, p) {
  const v = p?.[type];
  switch (type) {
    case 'multi_select': return (v || []).map((o) => o.name);
    case 'select': case 'status': return v?.name || '';
    case 'checkbox': return !!v;
    case 'date': return v?.start || '';
    case 'number': return v ?? null;
    case 'rich_text': return plain(v);
    default: return v || '';
  }
}

function writeValue(type, value) {
  switch (type) {
    case 'multi_select': return { multi_select: (value || []).map((name) => ({ name })) };
    case 'select': case 'status': return { [type]: value ? { name: value } : null };
    case 'checkbox': return { checkbox: !!value };
    case 'date': return { date: value ? { start: value } : null };
    case 'number': return { number: value === '' || value == null || Number.isNaN(Number(value)) ? null : Number(value) };
    case 'rich_text': return { rich_text: chunks(String(value || '')) };
    default: return { [type]: String(value || '').trim() || null };
  }
}

export function pageToRow(page, schema) {
  const props = page.properties || {};
  const values = {};
  for (const f of schema.fields) values[f.name] = readValue(f.type, props[f.name]);
  return {
    id: page.id,
    url: page.url || '',
    name: plain(props[schema.title]?.title),
    links: schema.links ? parseLinks(props[schema.links]?.rich_text) : [],
    values,
    edited: Date.parse(page.last_edited_time || '') || 0,
  };
}

/** A partial row ({name, links, values}) as the `properties` of a Notion page create or update. */
export function rowToProperties(schema, patch) {
  const out = {};
  if (patch.name !== undefined) out[schema.title] = { title: chunks(String(patch.name).trim()) };
  if (patch.links !== undefined) {
    if (!schema.links) throw new Error(`The database has no "${LINKS_PROPERTY}" text property. Reconnect it to add one.`);
    out[schema.links] = { rich_text: linksToRichText(patch.links) };
  }
  for (const [name, value] of Object.entries(patch.values || {})) {
    const f = schema.fields.find((x) => x.name === name);
    if (f) out[name] = writeValue(f.type, value);
  }
  return out;
}
