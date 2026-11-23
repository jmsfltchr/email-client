// MIME helpers: build an RFC 5322 message for sending, and digest Gmail API payloads.

import { parseAddressList, parseAddress } from './address.mjs';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeaderText(s) {
  if (isAscii(s)) return s;
  const bytes = Buffer.from(s, 'utf8');
  const words = [];
  // 39 bytes -> 52 base64 chars: keeps header lines under 78 chars. Split on char boundaries.
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 39, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${bytes.subarray(start, end).toString('base64')}?=`);
    start = end;
  }
  return words.join('\r\n ');
}

function encodeAddresses(list) {
  return list.map(({ name, addr }) => {
    if (!name || name === addr) return addr;
    if (!isAscii(name)) return `${encodeHeaderText(name)} <${addr}>`;
    return /^[\w .'-]+$/.test(name) ? `${name} <${addr}>` : `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
  }).join(',\r\n ');
}

const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

/**
 * Build a raw RFC 5322 message.
 * draft: {from:{name,addr}, to, cc, bcc (strings or [{name,addr}]), subject, text,
 *         inReplyTo, references, attachments:[{filename, mime, data: Buffer}]}
 */
export function buildRaw(draft) {
  const list = (v) => (Array.isArray(v) ? v : parseAddressList(v || ''));
  const to = list(draft.to), cc = list(draft.cc), bcc = list(draft.bcc);
  if (!to.length && !cc.length && !bcc.length) throw new Error('No recipients');
  const h = [];
  h.push(`From: ${encodeAddresses([draft.from])}`);
  if (to.length) h.push(`To: ${encodeAddresses(to)}`);
  if (cc.length) h.push(`Cc: ${encodeAddresses(cc)}`);
  if (bcc.length) h.push(`Bcc: ${encodeAddresses(bcc)}`);
  h.push(`Subject: ${encodeHeaderText(clean(draft.subject))}`);
  h.push(`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  if (draft.inReplyTo) h.push(`In-Reply-To: ${clean(draft.inReplyTo)}`);
  if (draft.references) h.push(`References: ${clean(draft.references).split(/\s+/).join('\r\n ')}`);
  h.push('MIME-Version: 1.0');

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(Buffer.from((draft.text || '').replace(/\r?\n/g, '\r\n'), 'utf8'))),
  ].join('\r\n');

  const atts = draft.attachments || [];
  if (!atts.length) return `${h.join('\r\n')}\r\n${textPart}\r\n`;

  const boundary = `=_stillmail_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts = [textPart];
  for (const a of atts) {
    const name = clean(a.filename || 'attachment').replace(/["\\]/g, '_');
    const param = isAscii(name) ? `"${name}"` : `"${encodeHeaderText(name)}"`;
    const star = isAscii(name) ? '' : `;\r\n filename*=UTF-8''${encodeURIComponent(name)}`;
    parts.push([
      `Content-Type: ${clean(a.mime) || 'application/octet-stream'}; name=${param}`,
      `Content-Disposition: attachment; filename=${param}${star}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(a.data)),
    ].join('\r\n'));
  }
  h.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  return `${h.join('\r\n')}\r\n\r\n--${boundary}\r\n${parts.join(`\r\n--${boundary}\r\n`)}\r\n--${boundary}--\r\n`;
}

// ------------------------------------------------------------ Gmail payloads

const header = (headers, name) => {
  const n = name.toLowerCase();
  return (headers || []).find((h) => h.name.toLowerCase() === n)?.value || '';
};

const SKIP_LABELS = ['DRAFT', 'SPAM', 'TRASH', 'CHAT'];

/** Gmail message resource (format=metadata or full) -> compact metadata record, or null to skip. */
export function toMeta(acct, msg) {
  const labels = msg.labelIds || [];
  if (SKIP_LABELS.some((l) => labels.includes(l))) return null;
  const hs = msg.payload?.headers || [];
  const from = parseAddress(header(hs, 'From')) || { name: '', addr: 'unknown@unknown.invalid' };
  const addrs = (n) => parseAddressList(header(hs, n)).map((a) => a.addr);
  return {
    key: `${acct}:${msg.id}`,
    acct,
    id: msg.id,
    threadId: msg.threadId,
    ts: Number(msg.internalDate) || Date.parse(header(hs, 'Date')) || 0,
    from,
    to: [...addrs('To'), ...addrs('Cc')].slice(0, 30),
    subject: header(hs, 'Subject'),
    snippet: decodeEntities(msg.snippet || ''),
    sent: labels.includes('SENT'),
    bulk: !!(header(hs, 'List-Unsubscribe') || header(hs, 'List-Id') || /bulk|list|junk/i.test(header(hs, 'Precedence'))),
    // Machine-generated (vacation responder, read receipt): never evidence that I wrote to someone.
    auto: /^auto-/i.test(header(hs, 'Auto-Submitted')) || !!header(hs, 'X-Autoreply') || undefined,
  };
}

export const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted', 'X-Autoreply'];

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const decodeBody = (data) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

/** Gmail message resource (format=full) -> {headers, text, html, attachments, inline}. */
export function toFull(msg) {
  const hs = msg.payload?.headers || [];
  const out = {
    id: msg.id,
    threadId: msg.threadId,
    ts: Number(msg.internalDate) || 0,
    headers: {
      from: header(hs, 'From'), to: header(hs, 'To'), cc: header(hs, 'Cc'), bcc: header(hs, 'Bcc'),
      replyTo: header(hs, 'Reply-To'), subject: header(hs, 'Subject'), date: header(hs, 'Date'),
      messageId: header(hs, 'Message-ID'), references: header(hs, 'References'),
    },
    text: '',
    html: '',
    attachments: [], // {attId, filename, mime, size}
    inline: [], // {cid, attId, mime, size}
  };
  const walk = (p) => {
    if (!p) return;
    const mime = (p.mimeType || '').toLowerCase();
    const cid = header(p.headers, 'Content-ID').replace(/^<|>$/g, '');
    const disp = header(p.headers, 'Content-Disposition').toLowerCase();
    if (p.parts?.length) { p.parts.forEach(walk); return; }
    if (p.filename || p.body?.attachmentId) {
      const rec = { attId: p.body?.attachmentId || null, data: p.body?.attachmentId ? undefined : p.body?.data, filename: p.filename || 'attachment', mime, size: p.body?.size || 0 };
      if (cid && mime.startsWith('image/') && !disp.startsWith('attachment')) out.inline.push({ cid, ...rec });
      else out.attachments.push(rec);
      return;
    }
    if (mime === 'text/html') out.html += decodeBody(p.body?.data);
    else if (mime === 'text/plain') out.text += decodeBody(p.body?.data);
  };
  walk(msg.payload);
  return out;
}
