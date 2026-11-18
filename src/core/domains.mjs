// Domain helpers: root ("registrable") domain, organisation and channel names.

// Common two-level public suffixes. Not the full Public Suffix List, but
// covers the overwhelming majority of real-world sender domains.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne', 'go', 'govt', 'ltd', 'plc', 'me', 'sch', 'nhs', 'mil', 'gob', 'nom', 'firm', 'gen', 'ind', 'in']);
const CC_WITH_SECOND_LEVEL = new Set(['uk', 'au', 'nz', 'jp', 'in', 'br', 'mx', 'za', 'sg', 'hk', 'cn', 'tw', 'kr', 'tr', 'ar', 'co', 'pl', 'ua', 'il', 'my', 'ph', 'pk', 'ng', 'eg', 'sa', 'id', 'th', 'vn', 'es', 'pt', 'gr', 'ru', 'ke', 'pe', 've', 'ec', 'uy', 'bd', 'lk', 'np', 'gh', 'tz', 'ug', 'cy', 'mt', 'ae', 'qa', 'kw', 'bh', 'om', 'jo', 'lb', 'ir', 'at']);

export function domainOf(addr) {
  const i = addr.lastIndexOf('@');
  return i < 0 ? '' : addr.slice(i + 1).toLowerCase();
}

export function rootDomain(domain) {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && CC_WITH_SECOND_LEVEL.has(tld) && SECOND_LEVEL.has(sld)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** Organisation name shown in the UI: the registrable label, e.g. "github.com" -> "Github". */
export function orgName(root) {
  const label = root.split('.')[0] || root;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Short channel name: local part, prefixed by any subdomain ("billing.noreply"). */
export function channelName(addr) {
  const at = addr.lastIndexOf('@');
  if (at < 0) return addr;
  const local = addr.slice(0, at).replace(/\+.*$/, '');
  const domain = addr.slice(at + 1);
  const root = rootDomain(domain);
  const sub = domain.length > root.length ? domain.slice(0, domain.length - root.length - 1) : '';
  const cleanSub = sub.replace(/^(mail|email|e|em|mg|send|smtp|bounce|bounces|reply)\.?/, '');
  return cleanSub ? `${cleanSub}.${local}` : local;
}

const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer(-daemon)?|bounces?|newsletter|news|updates?|digest|marketing|promo(tions)?|offers?|billing|receipts?|invoices?|statements?|automated|system|postmaster)([-_.+].*)?$/i;

/** True when the local part looks like an automated sender. */
export function looksAutomated(addr) {
  const at = addr.lastIndexOf('@');
  return NOREPLY.test(at < 0 ? addr : addr.slice(0, at));
}
