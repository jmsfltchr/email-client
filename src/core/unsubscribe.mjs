// Work out how to unsubscribe from a mailing, from its headers and its links.

const web = (u) => /^https:\/\//i.test(u);

/** Parse a List-Unsubscribe header: `<https://…>, <mailto:…>` -> {urls, mailto}. */
export function parseListUnsubscribe(header) {
  const out = { urls: [], mailto: null };
  for (const m of (header || '').matchAll(/<([^<>]+)>/g)) {
    const v = m[1].trim();
    if (/^mailto:/i.test(v)) out.mailto ||= parseMailto(v);
    else if (/^https?:\/\//i.test(v)) out.urls.push(v);
  }
  return out;
}

export function parseMailto(href) {
  const [addr, query = ''] = href.replace(/^mailto:/i, '').split('?');
  const q = new URLSearchParams(query);
  let to = addr;
  try { to = decodeURIComponent(addr); } catch { /* keep as written */ }
  to = to.split(',')[0].trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) return null;
  return { to, subject: q.get('subject') || 'unsubscribe', body: q.get('body') || '' };
}

const LINK_TEXT = /\bunsubscribe\b|\bopt[\s-]?out\b|\bstop (receiving|getting) (these )?emails?\b|\b(manage|update|email) (your )?(email |notification |subscription )?preferences\b|se désabonner|abmelden|darse de baja|cancelar suscripción/i;
const LINK_HREF = /unsubscribe|unsub\b|opt[-_]?out|optout|email[-_]?preferences/i;

/**
 * Choose the best way to unsubscribe, in the order mail programs use:
 *   one-click request (RFC 8058) > unsubscribe email > the sender's unsubscribe page.
 * `links` are {href, text} from the message body. Returns null when there is none.
 */
export function findUnsubscribe({ listUnsubscribe, listUnsubscribePost, links = [] }) {
  const header = parseListUnsubscribe(listUnsubscribe);
  const secure = header.urls.find(web);
  if (secure && /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubscribePost || '')) return { kind: 'oneclick', url: secure };
  if (header.mailto) return { kind: 'mailto', ...header.mailto };
  if (header.urls[0]) return { kind: 'link', url: header.urls[0] };
  // Prefer a link that says "unsubscribe" outright over a preferences page.
  const candidates = links.filter((l) => /^https?:\/\//i.test(l.href) && (LINK_TEXT.test(l.text || '') || LINK_HREF.test(l.href)));
  const best = candidates.find((l) => /unsubscribe/i.test(l.text || '')) || candidates.find((l) => /unsub/i.test(l.href)) || candidates[0];
  if (best) return { kind: 'link', url: best.href };
  const mail = links.find((l) => /^mailto:/i.test(l.href) && /unsubscribe/i.test(`${l.text} ${l.href}`));
  const parsed = mail && parseMailto(mail.href);
  return parsed ? { kind: 'mailto', ...parsed } : null;
}

export function describeUnsubscribe(u) {
  const host = (url) => { try { return new URL(url).host; } catch { return 'the sender'; } };
  if (u.kind === 'oneclick') return `Sends an unsubscribe request to ${host(u.url)}.`;
  if (u.kind === 'mailto') return `Sends an unsubscribe email from your account to ${u.to}.`;
  return `Opens the unsubscribe page at ${host(u.url)} for you to finish there.`;
}
