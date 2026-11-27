// In-app browser pane, to the right of the reader. Links clicked in an email open here.

import { html, useState, useEffect, useRef, cx } from './util.mjs';
import { S, api, set } from './store.mjs';

const PARTITION = 'persist:stillmail-web'; // its own cookies and storage, separate from the app

/** Route a link click from an email: Cmd/Ctrl-click goes to the system browser, otherwise the pane. */
export function openLink(url, event) {
  if (!/^https?:/i.test(url)) return false;
  if (event?.metaKey || event?.ctrlKey || !S.canEmbed) api.openExternal(url);
  else set({ web: { url, n: (S.web?.n || 0) + 1 } });
  return true;
}

export const closeWeb = () => set({ web: null });

export function WebPane() {
  return html`<${Browser} url=${S.web.url} n=${S.web.n} partition=${PARTITION} onClose=${closeWeb} />`;
}

/** A web page with navigation controls. `n` changes whenever the caller wants `url` loaded afresh; `off` hides it without unloading. */
export function Browser({ url, n, partition, onClose, onLocation, onMessage, onView, off = false, label = 'Web page' }) {
  const web = { url, n };
  const view = useRef();
  const [st, setSt] = useState({ url: web.url, title: '', loading: true, back: false, forward: false, error: null });

  const owner = useRef();
  owner.current = { onMessage, onView };

  // Wire the <webview> once.
  useEffect(() => {
    const wv = view.current;
    owner.current.onView?.(wv);
    const sync = (patch = {}) => setSt((s) => {
      let nav = {};
      try { nav = { url: wv.getURL() || s.url, back: wv.canGoBack(), forward: wv.canGoForward() }; } catch { /* not attached yet */ }
      return { ...s, ...nav, ...patch };
    });
    const on = {
      'did-start-loading': () => sync({ loading: true, error: null }),
      'did-stop-loading': () => sync({ loading: false }),
      'did-navigate': () => sync(),
      'did-navigate-in-page': () => sync(),
      'page-title-updated': (e) => sync({ title: e.title }),
      'ipc-message': (e) => owner.current.onMessage?.(e.channel, e.args || []), // from our own script in a messaging page
      'did-fail-load': (e) => { if (e.isMainFrame && e.errorCode !== -3) sync({ loading: false, error: e.errorDescription || 'This page could not be loaded.' }); },
    };
    for (const [name, fn] of Object.entries(on)) wv.addEventListener(name, fn);
    return () => { for (const [name, fn] of Object.entries(on)) wv.removeEventListener(name, fn); owner.current.onView?.(null); };
  }, []);

  // Every link click navigates the same pane.
  useEffect(() => {
    setSt((s) => ({ ...s, url: web.url, title: '', loading: true, error: null }));
    // A load that is replaced or fails is reported by the page's own events; loadURL's rejection adds nothing.
    try { view.current.loadURL(web.url).catch(() => {}); } catch { view.current.src = web.url; /* not attached yet */ }
  }, [web.n]);

  // Tell the owner where the page is now (it moves as links are followed inside it).
  useEffect(() => { onLocation?.({ url: st.url, title: st.title }); }, [st.url, st.title]);

  const [copied, setCopied] = useState(false);
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(st.url); } catch {
      // clipboard API unavailable: fall back to copying from a throwaway field
      const ta = Object.assign(document.createElement('textarea'), { value: st.url });
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const act = (fn) => () => { try { fn(view.current); } catch { /* not ready */ } };
  let host = '';
  try { host = new URL(st.url).host; } catch { /* keep empty */ }
  return html`
    <aside class=${cx('web', off && 'off')} aria-label=${label} aria-hidden=${off}>
      <div class="web-bar">
        <button class="btn ghost small" disabled=${!st.back} onClick=${act((w) => w.goBack())} title="Back" aria-label="Back">←</button>
        <button class="btn ghost small" disabled=${!st.forward} onClick=${act((w) => w.goForward())} title="Forward" aria-label="Forward">→</button>
        <button class="btn ghost small" onClick=${act((w) => (st.loading ? w.stop() : w.reload()))} title=${st.loading ? 'Stop' : 'Reload'} aria-label=${st.loading ? 'Stop' : 'Reload'}>${st.loading ? '✕' : '↻'}</button>
        <!-- at rest: site and page title; under the pointer (or keyboard focus): the full address, click to copy -->
        <button class=${cx('web-url', copied && 'copied')} onClick=${copyUrl} aria-label=${`Copy address: ${st.url}`}>
          <span class="pretty"><span class=${cx('lock', !st.url.startsWith('https:') && 'insecure')}>${st.url.startsWith('https:') ? '' : 'Not secure · '}</span><b>${host}</b>
            ${st.title && html`<span class="web-title"> — ${st.title}</span>`}</span>
          <span class="raw"><span class="addr">${st.url}</span><span class="copy">${copied ? '✓ Copied' : '⧉ Copy'}</span></span>
        </button>
        <button class="btn small ext" onClick=${() => api.openExternal(st.url)} title="Open this page in your default browser. Tip: ⌘-click (Ctrl-click) a link to go straight there.">Open in default browser</button>
        <button class="btn ghost small" onClick=${onClose} title=${`Close ${label.toLowerCase()}`} aria-label=${`Close ${label.toLowerCase()}`}>✕</button>
      </div>
      <div class=${cx('web-progress', st.loading && 'on')}></div>
      ${st.error && html`
        <div class="web-error">
          <p><b>${host || 'This page'}</b> could not be loaded.</p><p>${st.error}</p>
          <button class="btn" onClick=${act((w) => w.reload())}>Try again</button>
          <button class="btn" onClick=${() => api.openExternal(st.url)}>Open in default browser</button>
        </div>`}
      <!-- allowpopups only lets the main process see new-window requests; it denies them and loads the URL here -->
      <webview ref=${view} partition=${partition} allowpopups=${true} class=${cx(st.error && 'hidden')}></webview>
    </aside>`;
}
