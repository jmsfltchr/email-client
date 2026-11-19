import { html, useState, useMemo, useEffect, useRef, cx, ago, fullDate, displayName } from './util.mjs';
import { S, api, passes, cutoffs, openMessage, toast } from './store.mjs';
import { domainOf, rootDomain } from '../core/domains.mjs';
import { Avatar, Swatch } from './avatar.mjs';

const RANGES = [['all', 'Any time'], ['near', 'Recent'], ['far', 'Fading'], ['old', 'Older']];

// The other party of a message: sender for received mail, recipients for mail I sent.
function parties(m) {
  if (m.kind !== 'me') return [m.from.addr];
  return m.to.length ? m.to : [m.from.addr];
}

function hay(m) {
  return (m._hay ||= `${m.subject} ${m.snippet || ''} ${m.from.name} ${m.from.addr} ${m.to.join(' ')}`.toLowerCase());
}

export function Search() {
  const [q, setQ] = useState('');
  const [senderQ, setSenderQ] = useState('');
  const [domains, setDomains] = useState(new Set());
  const [addrs, setAddrs] = useState(new Set());
  const [range, setRange] = useState('all');
  const [withSent, setWithSent] = useState(true);
  const [remote, setRemote] = useState(null); // {q, keys:Set} when showing Gmail full-text results
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(150);
  const qRef = useRef();
  useEffect(() => { qRef.current?.focus(); }, []);
  useEffect(() => { setLimit(150); }, [q, domains, addrs, range, remote]);

  const c = cutoffs();
  const { model } = S;

  // 1. everything that matches the text query and global filters
  const base = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const m of S.messages.values()) {
      if (!passes(m)) continue;
      if (!withSent && m.kind === 'me') continue;
      if (range === 'near' && m.ts < c.near) continue;
      if (range === 'far' && (m.ts >= c.near || m.ts < c.far)) continue;
      if (range === 'old' && m.ts >= c.far) continue;
      if (remote) { if (!remote.keys.has(m.key)) continue; } else if (words.length) {
        const h = hay(m);
        if (!words.every((w) => h.includes(w))) continue;
      }
      out.push(m);
    }
    return out;
  }, [q, range, withSent, remote, model, S.acctSel, S.tagSel]);

  // 2. facets: domain -> count, and address -> count
  const { domainList, addrList } = useMemo(() => {
    const dCount = new Map(), aCount = new Map();
    for (const m of base) {
      const seen = new Set();
      for (const a of parties(m)) {
        const root = rootDomain(domainOf(a));
        if (!seen.has(root)) { seen.add(root); dCount.set(root, (dCount.get(root) || 0) + 1); }
        const rec = aCount.get(a) || { addr: a, root, n: 0 };
        rec.n++;
        aCount.set(a, rec);
      }
    }
    const f = senderQ.trim().toLowerCase();
    const name = (a) => model.senders.get(a)?.name || '';
    let dl = [...dCount].map(([root, n]) => ({ root, n }));
    let al = [...aCount.values()].map((r) => ({ ...r, name: name(r.addr) }));
    if (f) {
      const hitAddr = al.filter((r) => r.addr.includes(f) || r.name.toLowerCase().includes(f));
      const roots = new Set(hitAddr.map((r) => r.root));
      dl = dl.filter((d) => d.root.includes(f) || roots.has(d.root) || domains.has(d.root));
      al = al.filter((r) => r.addr.includes(f) || r.name.toLowerCase().includes(f) || addrs.has(r.addr));
    }
    if (domains.size) al = al.filter((r) => domains.has(r.root));
    dl.sort((a, b) => b.n - a.n || a.root.localeCompare(b.root));
    al.sort((a, b) => b.n - a.n || a.addr.localeCompare(b.addr));
    return { domainList: dl, addrList: al };
  }, [base, senderQ, domains, addrs]);

  // 3. results after the sender facets
  const results = useMemo(() => {
    let out = base;
    if (addrs.size) out = out.filter((m) => parties(m).some((a) => addrs.has(a)));
    else if (domains.size) out = out.filter((m) => parties(m).some((a) => domains.has(rootDomain(domainOf(a)))));
    else if (senderQ.trim()) {
      const ok = new Set(addrList.map((r) => r.addr));
      out = out.filter((m) => parties(m).some((a) => ok.has(a)));
    }
    return out.sort((a, b) => b.ts - a.ts);
  }, [base, domains, addrs, senderQ, addrList]);

  const toggleDomain = (root) => {
    const n = new Set(domains);
    if (n.has(root)) {
      n.delete(root);
      setAddrs(new Set([...addrs].filter((a) => rootDomain(domainOf(a)) !== root)));
    } else n.add(root);
    setDomains(n);
  };
  const toggleAddr = (a) => { const n = new Set(addrs); if (n.has(a)) n.delete(a); else n.add(a); setAddrs(n); };

  const searchGmail = async () => {
    const from = addrs.size ? [...addrs] : [...domains];
    const scope = from.length ? ` {${from.map((x) => `from:${x} to:${x}`).join(' ')}}` : '';
    setBusy(true);
    try {
      const accts = S.acctSel.size ? [...S.acctSel] : S.accounts.map((a) => a.email);
      const keys = await api.searchRemote({ accts, q: `${q.trim()}${scope}` });
      setRemote({ q: q.trim(), keys: new Set(keys) });
    } catch (e) { toast(`Gmail search failed: ${e.message}`); }
    setBusy(false);
  };

  return html`
    <div class="search">
      <div class="search-top">
        <input class="input q" ref=${qRef} value=${q} placeholder="Search subjects and previews…" aria-label="Search text"
          onInput=${(e) => { setQ(e.target.value); setRemote(null); }}
          onKeyDown=${(e) => { if (e.key === 'Enter' && q.trim()) searchGmail(); }} />
        <span class="seg">
          ${RANGES.map(([k, label]) => html`<button class=${cx(range === k && 'on')} onClick=${() => setRange(k)}
            title=${k === 'near' ? `Last ${S.user.settings.nearDays} days` : k === 'far' ? `${S.user.settings.nearDays}–${S.user.settings.farDays} days old` : k === 'old' ? `Older than ${S.user.settings.farDays} days` : ''}>${label}</button>`)}
        </span>
        <label class="chip"><input type="checkbox" checked=${withSent} onChange=${(e) => setWithSent(e.target.checked)} /> Include sent</label>
        <button class="btn" disabled=${busy || !q.trim()} onClick=${searchGmail} title="Search full message bodies on Gmail (Enter)">${busy ? 'Searching…' : 'Search full text'}</button>
      </div>
      <div class="search-cols">
        <div class="col">
          <div class="col-h"><input class="input" value=${senderQ} placeholder="Filter senders…" aria-label="Filter senders" onInput=${(e) => setSenderQ(e.target.value)} /></div>
          <div class="col-h"><span>Domain</span>${domains.size > 0 && html`<button onClick=${() => { setDomains(new Set()); setAddrs(new Set()); }}>Clear</button>`}</div>
          <div class="col-list" role="listbox" aria-label="Domains" aria-multiselectable="true">
            ${domainList.slice(0, 300).map((d) => html`
              <div class=${cx('facet', domains.has(d.root) && 'on')} role="option" aria-selected=${domains.has(d.root)} onClick=${() => toggleDomain(d.root)}>
                <${Swatch} root=${d.root} /><span class="nm">${d.root}</span><span class="ct">${d.n}</span>
              </div>`)}
            ${domainList.length === 0 && html`<div class="empty">No senders</div>`}
          </div>
        </div>
        <div class="col">
          <div class="col-h"><span>Address</span>${addrs.size > 0 && html`<button onClick=${() => setAddrs(new Set())}>Clear</button>`}</div>
          <div class="col-list" role="listbox" aria-label="Addresses" aria-multiselectable="true">
            ${addrList.slice(0, 300).map((r) => html`
              <div class=${cx('facet', addrs.has(r.addr) && 'on')} role="option" aria-selected=${addrs.has(r.addr)} onClick=${() => toggleAddr(r.addr)} title=${r.addr}>
                <span class="nm">${r.addr.split('@')[0]}<span class="sub">@${r.addr.split('@')[1]}${r.name ? ` · ${r.name}` : ''}</span></span>
                <span class="ct">${r.n}</span>
              </div>`)}
            ${addrList.length > 300 && html`<div class="empty">${addrList.length - 300} more — pick a domain or type to narrow</div>`}
          </div>
        </div>
        <div class="col">
          <div class="col-h"><span>${results.length.toLocaleString()} ${results.length === 1 ? 'message' : 'messages'}</span></div>
          ${remote && html`<div class="banner">Full-text matches from Gmail for “${remote.q}”. <button onClick=${() => setRemote(null)}>Back to quick search</button></div>`}
          <div class="col-list">
            ${results.slice(0, limit).map((m) => html`
              <div class=${cx('result', S.open?.key === m.key && 'sel')} onClick=${() => openMessage(m)}>
                <span class="d" title=${fullDate(m.ts)}>${ago(m.ts)}</span>
                <span class="f"><${Avatar} addr=${m.kind === 'me' ? m.to[0] || m.from.addr : m.from.addr} name=${m.kind === 'me' ? '' : m.from.name} small /> ${m.kind === 'me' ? `To ${m.to[0] || ''}` : displayName(m.from)}</span>
                <span class="s">${m.subject || '(no subject)'} ${m.snippet && m.snippet !== m.subject && html`<span>— ${m.snippet}</span>`}</span>
              </div>`)}
            ${results.length > limit && html`<button class="more" onClick=${() => setLimit(limit + 300)}>Show more</button>`}
            ${results.length === 0 && html`<div class="empty">Nothing matches. ${q.trim() && !remote ? 'Press Enter to search full message text on Gmail.' : ''}</div>`}
          </div>
        </div>
      </div>
    </div>`;
}
