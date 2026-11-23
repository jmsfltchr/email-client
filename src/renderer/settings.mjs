import { html, useState, useMemo, cx, escapeRe } from './util.mjs';
import { S, api, set, mutate, setSetting, setSenderKind, toggleQuiet, toast, setDemo } from './store.mjs';
import { DEFAULT_KEYWORDS, baseSubject } from '../core/classify.mjs';

function OAuthForm({ onSaved }) {
  const [clientId, setId] = useState('');
  const [clientSecret, setSecret] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    try {
      await api.setOAuthClient({ clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      set({ hasOAuthClient: true });
      setError('');
      onSaved?.();
    } catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  return html`
    <div class="card">
      <div class="form-row"><label>Client ID</label><input class="input mono" value=${clientId} onInput=${(e) => setId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" /></div>
      <div class="form-row"><label>Client secret</label><input class="input mono" type="password" value=${clientSecret} onInput=${(e) => setSecret(e.target.value)} /></div>
      <div class="form-row">
        <button class="btn primary" onClick=${save} disabled=${!clientId.trim()}>Save</button>
        ${S.hasOAuthClient && html`<span>A client is saved. Saving again replaces it.</span>`}
        ${error && html`<span class="err-text">${error}</span>`}
      </div>
    </div>`;
}

function ConnectButton({ primary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try { await api.addAccount({}); } catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    setBusy(false);
  };
  return html`
    <button class=${cx('btn', primary && 'primary')} onClick=${go} disabled=${busy || !S.hasOAuthClient}>${busy ? 'Waiting for Google sign-in in your browser…' : 'Connect a Gmail account'}</button>
    ${error && html`<span class="err-text">${error}</span>`}`;
}

export function Welcome() {
  return html`
    <div class="welcome">
      <h1>Stillmail</h1>
      <p>A calm Gmail client. People you correspond with come first; everything else is grouped by topic and stays out of your way unless something is out of the ordinary.</p>
      <p>Stillmail talks to Gmail directly from this computer using your own Google OAuth client, so no third party sees your mail.</p>
      <ol>
        <li>In Google Cloud Console, create a project, enable the <b>Gmail API</b>, and create an OAuth client of type <b>Desktop app</b> (the README walks through it).</li>
        <li>Paste the client ID and secret below.</li>
        <li>Connect your work and personal accounts.</li>
      </ol>
      <${OAuthForm} />
      <div class="form-row" style=${{ padding: '6px 0', border: 0 }}>
        <${ConnectButton} primary />
        <button class="btn" onClick=${() => setDemo(true)}>Explore with demo data</button>
      </div>
    </div>`;
}

function NumberRow({ label, hint, k, min = 1, max = 3650 }) {
  return html`
    <div class="form-row">
      <label>${label}<small>${hint}</small></label>
      <input class="input num" type="number" min=${min} max=${max} value=${S.user.settings[k]}
        onChange=${(e) => { const v = Math.round(Number(e.target.value)); if (v >= min && v <= max) setSetting(k, v); }} />
    </div>`;
}

export function Settings() {
  const { user, model, accounts } = S;
  const st = user.settings;
  const [kw, setKw] = useState(st.keywords.join('\n'));
  const [senderQ, setSenderQ] = useState('');
  const senders = useMemo(() => {
    const f = senderQ.trim().toLowerCase();
    return [...model.senders.values()]
      .filter((s) => (f ? s.addr.includes(f) || s.name.toLowerCase().includes(f) : s.kind === 'important' || !s.auto))
      .sort((a, b) => b.lastTs - a.lastTs).slice(0, 60);
  }, [model, senderQ]);
  const quiet = Object.keys(user.quietTopics);

  return html`
    <div class="settings main-inner">
      <h1>Settings</h1>

      <h3>Accounts</h3>
      <div class="card">
        ${accounts.map((a) => html`
          <div class="form-row" key=${a.email}>
            <input type="color" value=${a.color} disabled=${S.demo} onChange=${(e) => api.updateAccount(a.email, { color: e.target.value })} title="Tag colour" />
            <input class="input" style=${{ flex: 'none', width: '120px' }} value=${a.label} disabled=${S.demo} aria-label="Tag name" onChange=${(e) => api.updateAccount(a.email, { label: e.target.value.trim() || a.label })} />
            <span style=${{ flex: 1 }}>${a.email}</span>
            <input class="input" style=${{ flex: 'none', width: '170px' }} value=${a.name || ''} disabled=${S.demo} placeholder="Name shown when sending" onChange=${(e) => api.updateAccount(a.email, { name: e.target.value.trim() })} />
            ${!S.demo && html`<button class="btn danger small" onClick=${() => { if (window.confirm(`Disconnect ${a.email}? Its local cache is deleted; nothing changes in Gmail.`)) api.removeAccount(a.email); }}>Disconnect</button>`}
          </div>`)}
        <div class="form-row">
          ${S.demo
            ? html`<span>Demo mode — these accounts are fictional.</span><button class="btn" onClick=${() => setDemo(false)}>Leave demo</button>`
            : html`<${ConnectButton} />`}
        </div>
      </div>
      ${!S.demo && html`
        <h3>Google OAuth client</h3>
        <p>Stillmail signs in with your own OAuth client (Desktop app type). It requests read-only access plus permission to send; it never modifies or deletes mail in Gmail.</p>
        <${OAuthForm} />`}

      <h3>Fading</h3>
      <p>Nothing here needs clearing. Mail simply fades: after the first cutoff it dims, after the second it leaves the home view and lives on in Search.</p>
      <div class="card">
        <${NumberRow} label="Recent for" hint="days at full strength" k="nearDays" max=${Math.max(1, st.farDays - 1)} />
        <${NumberRow} label="Searchable-only after" hint="days until mail leaves the home view" k="farDays" min=${st.nearDays + 1} />
        <${NumberRow} label="History to keep" hint="months of received mail (0 = everything). Sent mail is always kept in full." k="syncMonths" min=${0} max=${600} />
      </div>

      <h3>Senders</h3>
      <p>Anyone you have ever written to is important. Addresses that send repeatedly and never get a reply become notification channels.</p>
      <div class="card">
        <${NumberRow} label="Channel threshold" hint="emails received with no reply ever sent" k="channelMin" min=${2} max=${50} />
        <div class="form-row">
          <label>Find a sender<small>override how any address is treated</small></label>
          <input class="input" value=${senderQ} onInput=${(e) => setSenderQ(e.target.value)} placeholder="Name or address… (showing important senders)" />
        </div>
        ${senders.map((s) => html`
          <div class="form-row" key=${s.addr}>
            <span style=${{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}><b>${s.name || s.addr}</b> ${s.name && html`<span class="mono" style=${{ color: 'var(--muted)' }}>${s.addr}</span>`}</span>
            <span class="seg">
              ${[['important', 'Important'], ['channel', 'Notifications']].map(([k, label]) => html`
                <button class=${cx(s.kind === k && 'on')} onClick=${() => setSenderKind(s.addr, k)}>${label}</button>`)}
            </span>
            <button class="btn ghost small" disabled=${s.auto} onClick=${() => setSenderKind(s.addr, null)}>${s.auto ? 'automatic' : 'Reset'}</button>
          </div>`)}
      </div>

      <h3>Attention</h3>
      <p>Notification emails are escalated when their topic is new or rare for that channel, or when the subject or preview contains one of these words. Each entry matches as a word prefix (“expir” catches expired, expires, expiring).</p>
      <div class="card">
        <div class="form-row">
          <label>Keywords<small>one per line</small></label>
          <textarea class="input" value=${kw} onInput=${(e) => setKw(e.target.value)}
            onBlur=${() => setSetting('keywords', kw.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean))}></textarea>
          <button class="btn small" onClick=${() => { setKw(DEFAULT_KEYWORDS.join('\n')); setSetting('keywords', [...DEFAULT_KEYWORDS]); }}>Restore defaults</button>
        </div>
        <div class="form-row">
          <label>Desktop notifications<small>only for important people and escalated mail</small></label>
          <input type="checkbox" checked=${st.notify} onChange=${(e) => setSetting('notify', e.target.checked)} />
        </div>
        <div class="form-row">
          <label>Sender photos and icons<small>contact photos from your Google contacts; organisation icons from Google's favicon service</small></label>
          <input type="checkbox" checked=${st.senderImages} onChange=${(e) => setSetting('senderImages', e.target.checked)} />
          ${S.photosDenied.length > 0 && html`<span class="err-text">Reconnect ${S.photosDenied.join(', ')} to allow contact photos.</span>`}
        </div>
        <div class="form-row">
          <label>Remote images<small>off blocks tracking pixels</small></label>
          <input type="checkbox" checked=${st.loadImages} onChange=${(e) => setSetting('loadImages', e.target.checked)} /> <span>Always load</span>
        </div>
      </div>

      <h3>Topic patterns</h3>
      <p>Topics are detected automatically from recurring subjects. Add a pattern from any topic row when you want to group subjects yourself.</p>
      <div class="card">
        ${user.topicRules.length === 0 && html`<div class="empty">No custom patterns.</div>`}
        ${user.topicRules.map((r) => html`
          <div class="form-row" key=${r.id}>
            <b>${r.name}</b><span class="mono" style=${{ flex: 1 }}>/${r.pattern}/i</span><span style=${{ color: 'var(--muted)' }}>${r.scope === '*' ? 'all channels' : r.scope}</span>
            <button class="btn danger small" onClick=${() => mutate((u) => { u.topicRules = u.topicRules.filter((x) => x.id !== r.id); })}>Remove</button>
          </div>`)}
      </div>
      ${quiet.length > 0 && html`
        <h3>Topics never flagged</h3>
        <div class="card">
          ${quiet.map((k) => {
            const t = model.topics.get(k);
            return html`<div class="form-row" key=${k}><span style=${{ flex: 1 }}>${t ? `${t.org} › ${t.channel} › ${t.label}` : k}</span><button class="btn small" onClick=${() => toggleQuiet(k)}>Flag again</button></div>`;
          })}
        </div>`}
    </div>`;
}

/** Dialog: define a topic for a channel with a regular expression over the subject. */
export function RuleEditor() {
  const { topic } = S.ruleEditor;
  const sender = S.model.senders.get(topic.addr);
  const initial = topic.label.split('⋯').map((p) => escapeRe(p.trim())).filter((p, i, all) => p || all.length > 1).join('.*').replace(/^\.\*|\.\*$/g, '') || '.*';
  const [name, setName] = useState(topic.kind === 'sender' ? '' : topic.label.replace(/\s*⋯\s*/g, ' … ').trim());
  const [pattern, setPattern] = useState(topic.kind === 'sender' ? '' : initial);
  const [scope, setScope] = useState(topic.addr);
  let re = null, error = '';
  try { if (pattern) re = new RegExp(pattern, 'i'); } catch (e) { error = e.message; }
  const subjects = useMemo(() => {
    const seen = new Set();
    const pool = scope === topic.addr ? sender?.msgs || [] : [...S.model.senders.values()].filter((s) => s.root === topic.root && s.kind === 'channel').flatMap((s) => s.msgs);
    for (const m of [...pool].sort((a, b) => b.ts - a.ts)) { seen.add(baseSubject(m.subject)); if (seen.size >= 400) break; }
    return [...seen];
  }, [scope]);
  const hits = re ? subjects.filter((s) => re.test(s)) : [];
  const close = () => set({ ruleEditor: null });
  const save = () => {
    mutate((u) => { u.topicRules.push({ id: Date.now().toString(36), scope, pattern, name: name.trim() || pattern }); });
    close();
    toast('Topic pattern added');
  };
  return html`
    <div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="dialog" role="dialog" aria-label="Define topic" onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
        <h3>Define a topic</h3>
        <div class="body">
          <div><label>Topic name</label><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. Build results" /></div>
          <div><label>Subject matches (regular expression, case-insensitive)</label>
            <input class="input mono" value=${pattern} onInput=${(e) => setPattern(e.target.value)} placeholder="^(Success|Failed): " ref=${(el) => { if (el && !el.dataset.f) { el.dataset.f = 1; el.focus(); } }} />
            ${error && html`<div class="err-text">${error}</div>`}
          </div>
          <div><label>Applies to</label>
            <span class="seg">
              <button class=${cx(scope === topic.addr && 'on')} onClick=${() => setScope(topic.addr)}>${topic.addr}</button>
              <button class=${cx(scope === topic.root && 'on')} onClick=${() => setScope(topic.root)}>All of ${topic.root}</button>
            </span>
          </div>
          <div><label>${re ? `${hits.length} of ${subjects.length} recent distinct subjects match` : 'Recent subjects'}</label>
            <div class="preview">
              ${subjects.slice(0, 60).map((s) => html`<div class=${!re || re.test(s) ? 'hit' : 'miss'}>${s || '(no subject)'}</div>`)}
            </div>
          </div>
        </div>
        <div class="foot">
          <button class="btn" onClick=${close}>Cancel</button>
          <button class="btn primary" disabled=${!re} onClick=${save}>Add topic</button>
        </div>
      </div>
    </div>`;
}
