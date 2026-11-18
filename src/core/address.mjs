// RFC 5322-ish address list parsing and formatting. Shared by main and renderer.

/** Parse `"Doe, Jane" <jane@x.com>, bob@y.org` into [{name, addr}]. */
export function parseAddressList(input) {
  if (!input) return [];
  const out = [];
  let buf = '';
  let inQuote = false;
  let depth = 0;
  const flush = () => {
    const one = parseAddress(buf);
    if (one) out.push(one);
    buf = '';
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && inQuote) { buf += c + (input[++i] ?? ''); continue; }
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === '<') depth++;
    else if (!inQuote && c === '>') depth = Math.max(0, depth - 1);
    if (!inQuote && depth === 0 && (c === ',' || c === ';')) flush();
    else buf += c;
  }
  flush();
  return out;
}

export function parseAddress(s) {
  s = (s || '').trim();
  if (!s) return null;
  const m = s.match(/^(.*)<([^<>]+)>\s*$/s);
  let name = '';
  let addr = s;
  if (m) {
    name = m[1].trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
    addr = m[2];
  }
  addr = addr.trim().replace(/^mailto:/i, '').toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(addr)) return null;
  return { name, addr };
}

export function formatAddress({ name, addr }) {
  if (!name || name === addr) return addr;
  return /^[\w .'-]+$/.test(name) ? `${name} <${addr}>` : `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
}

export function formatAddressList(list) {
  return list.map(formatAddress).join(', ');
}
