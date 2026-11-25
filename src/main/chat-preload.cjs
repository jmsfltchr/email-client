// Runs inside each messaging page of the Testers browser, before the page's own scripts.
// A page's desktop notifications are handed to Stillmail (which lists them) instead of the operating system,
// and each one is kept so that Stillmail can later "click" it: the site then opens the conversation itself.
// The page gets no access to Stillmail; the only thing that crosses over is the notification's text.

const { contextBridge, ipcRenderer } = require('electron');

const clip = (v, n) => String(v ?? '').slice(0, n);
const report = (note) => {
  try { ipcRenderer.sendToHost('stillmail-notification', { id: clip(note.id, 64), title: clip(note.title, 300), body: clip(note.body, 1000), tag: clip(note.tag, 200) }); } catch { /* host gone */ }
};

// Executed in the page's own world.
function install(report) {
  const KEY = Symbol.for('stillmail.notifications');
  if (window[KEY]) return;
  const live = new Map(); // id -> the notification object the site is holding (null when it has none to click)
  const keep = (n) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    live.set(id, n);
    if (live.size > 300) live.delete(live.keys().next().value);
    return id;
  };
  const TYPES = ['click', 'show', 'close', 'error'];

  class Notification extends EventTarget {
    constructor(title, options) {
      if (!arguments.length) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
      super();
      const o = options || {};
      const fixed = { title: String(title), body: String(o.body ?? ''), tag: String(o.tag ?? ''), icon: String(o.icon ?? ''), image: String(o.image ?? ''), badge: String(o.badge ?? ''), lang: String(o.lang ?? ''), dir: o.dir || 'auto', data: o.data ?? null, silent: o.silent ?? null, requireInteraction: !!o.requireInteraction, renotify: !!o.renotify, timestamp: o.timestamp ?? Date.now(), actions: [], vibrate: [] };
      for (const [k, v] of Object.entries(fixed)) Object.defineProperty(this, k, { value: v, enumerable: true });
      for (const t of TYPES) { this[`on${t}`] = null; this.addEventListener(t, (e) => { const fn = this[`on${t}`]; if (typeof fn === 'function') fn.call(this, e); }); }
      report({ id: keep(this), title: fixed.title, body: fixed.body, tag: fixed.tag });
      setTimeout(() => this.dispatchEvent(new Event('show')), 0);
    }
    // Sites close their notifications after a few seconds; the entry in Stillmail's list stays until it is dealt with.
    close() { this.dispatchEvent(new Event('close')); }
    static get permission() { return 'granted'; }
    static get maxActions() { return 0; }
    static requestPermission(callback) { if (typeof callback === 'function') callback('granted'); return Promise.resolve('granted'); }
  }
  Object.defineProperty(window, 'Notification', { value: Notification, writable: true, configurable: true });

  // Notifications shown through the page's service worker registration: listed too, though there is nothing to click.
  if (window.ServiceWorkerRegistration) {
    ServiceWorkerRegistration.prototype.showNotification = function showNotification(title, options) {
      const o = options || {};
      report({ id: keep(null), title: String(title), body: String(o.body ?? ''), tag: String(o.tag ?? '') });
      return Promise.resolve();
    };
  }

  // "May I notify?" is answered yes, so sites offer their desktop notification setting.
  if (navigator.permissions?.query) {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === 'notifications'
      ? Promise.resolve(Object.assign(new EventTarget(), { name: 'notifications', state: 'granted', onchange: null }))
      : query(d));
  }

  Object.defineProperty(window, KEY, {
    value: Object.freeze({
      /** Act as if the person clicked the notification; false if this page no longer has it. */
      click(id) {
        const n = live.get(id);
        if (!n) return false;
        n.dispatchEvent(new Event('click'));
        return true;
      },
    }),
  });
}

if (process.isMainFrame !== false) {
  try { contextBridge.executeInMainWorld({ func: install, args: [report] }); } catch (e) { console.error('Stillmail could not capture notifications on this page:', e); }
}
