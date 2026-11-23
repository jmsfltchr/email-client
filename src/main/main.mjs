import { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, powerMonitor, nativeTheme, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authorize, refresh } from './oauth.mjs';
import { Gmail } from './gmail.mjs';
import { AccountSync } from './sync.mjs';
import { buildRaw, toFull } from '../core/mime.mjs';
import { fetchContactPhotos, fetchOrgIcon } from './contacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.argv.includes('--demo');
const POLL_MS = 60000;
const COLORS = ['#3b6fd4', '#c2571a', '#2f8f6b', '#8a4fc7', '#b8365c', '#5f6b7a'];

let win = null;
let config = { oauth: null, accounts: [] }; // accounts: {email, label, color, name, refreshEnc}
const syncs = new Map(); // email -> AccountSync
const tokens = new Map(); // email -> {access_token, expires_at}
const fullCache = new Map(); // `${email}:${id}` -> toFull() result (small LRU)
const saveTimers = new Map();

// ------------------------------------------------------------ persistence

const dataPath = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataPath(name), 'utf8')); } catch { return fallback; }
}

function writeJson(name, value) {
  const file = dataPath(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const mailFile = (email) => `mail-${email.replace(/[^a-z0-9@._-]/gi, '_')}.json`;

function enc(s) {
  if (safeStorage.isEncryptionAvailable()) return { v: safeStorage.encryptString(s).toString('base64') };
  return { plain: s }; // no OS keychain available; file is still mode 0600
}

function dec(o) {
  if (!o) return '';
  if (o.plain !== undefined) return o.plain;
  return safeStorage.decryptString(Buffer.from(o.v, 'base64'));
}

const saveConfig = () => writeJson('config.json', config);
const oauthClient = () => (config.oauth ? { clientId: config.oauth.clientId, clientSecret: dec(config.oauth.secretEnc) } : null);
const publicAccounts = () => config.accounts.map(({ email, label, color, name }) => ({ email, label, color, name }));
const emit = (event) => { if (win && !win.isDestroyed()) win.webContents.send('event', event); };

function scheduleSave(email, delay = 8000) {
  if (saveTimers.has(email)) return;
  saveTimers.set(email, setTimeout(() => flushSave(email), delay));
}

function flushSave(email) {
  clearTimeout(saveTimers.get(email));
  saveTimers.delete(email);
  const s = syncs.get(email);
  if (s) writeJson(mailFile(email), s.snapshot());
}

// ------------------------------------------------------------ accounts

// Sender images. Photos: {email: {at, photos:{addr:url}, denied}}. Icons: {root: {at, d: dataUrl|null}}.
let photoCache = {};
let iconCache = {};
const iconPending = new Map();
let iconActive = 0;
const iconQueue = [];
let iconSaveTimer = null;
const DAY_MS = 86400000;

const allPhotos = () => Object.assign({}, ...config.accounts.map((a) => photoCache[a.email]?.photos || {}));
const photosDenied = () => config.accounts.filter((a) => photoCache[a.email]?.denied).map((a) => a.email);

async function refreshPhotos(email, force = false) {
  const cached = photoCache[email];
  if (!force && cached && Date.now() - cached.at < DAY_MS) return;
  const sync = syncs.get(email);
  if (!sync) return;
  const r = await fetchContactPhotos(sync.gmail).catch(() => null);
  if (!r || (r.error && !r.denied && !Object.keys(r.photos).length)) return; // transient failure: keep what we have
  photoCache[email] = { at: Date.now(), photos: r.photos, denied: r.denied };
  writeJson('photos.json', photoCache);
  emit({ type: 'photos', photos: allPhotos(), denied: photosDenied() });
}

function runIconQueue() {
  while (iconActive < 4 && iconQueue.length) {
    const job = iconQueue.shift();
    iconActive++;
    job().finally(() => { iconActive--; runIconQueue(); });
  }
}

function orgIcon(root) {
  root = String(root || '').toLowerCase();
  const hit = iconCache[root];
  if (hit && Date.now() - hit.at < (hit.d ? 30 : 7) * DAY_MS) return hit.d;
  if (iconPending.has(root)) return iconPending.get(root);
  const p = new Promise((resolve) => {
    iconQueue.push(async () => {
      try {
        const d = await fetchOrgIcon(root);
        iconCache[root] = { at: Date.now(), d };
        clearTimeout(iconSaveTimer);
        iconSaveTimer = setTimeout(() => writeJson('icons.json', iconCache), 3000);
        resolve(d);
      } catch {
        resolve(null); // offline: try again next session, do not cache
      }
    });
    runIconQueue();
  });
  iconPending.set(root, p);
  return p;
}

async function accessToken(email) {
  const cached = tokens.get(email);
  if (cached && cached.expires_at - Date.now() > 60000) return cached.access_token;
  const acct = config.accounts.find((a) => a.email === email);
  if (!acct) throw new Error(`Unknown account ${email}`);
  const tok = await refresh(oauthClient(), dec(acct.refreshEnc));
  tokens.set(email, tok);
  return tok.access_token;
}

function startSync(email) {
  const state = readJson('state.json', null);
  const sync = new AccountSync({
    email,
    gmail: new Gmail(() => accessToken(email)),
    saved: readJson(mailFile(email), null),
    save: () => scheduleSave(email),
    emit,
    syncMonths: () => readJson('state.json', state)?.settings?.syncMonths ?? 12,
  });
  syncs.set(email, sync);
  sync.tick();
  refreshPhotos(email);
  return sync;
}

function requireSync(email) {
  const s = syncs.get(email);
  if (!s) throw new Error(`Account ${email} is not connected`);
  return s;
}

async function getFull(email, id) {
  const key = `${email}:${id}`;
  if (fullCache.has(key)) return fullCache.get(key);
  const full = toFull(await requireSync(email).gmail.getFull(id));
  fullCache.set(key, full);
  if (fullCache.size > 60) fullCache.delete(fullCache.keys().next().value);
  return full;
}

async function attachmentBytes(email, msgId, att) {
  if (att.attId) return requireSync(email).gmail.getAttachment(msgId, att.attId);
  return Buffer.from(att.data || '', 'base64url');
}

// ------------------------------------------------------------ IPC

const handlers = {
  bootstrap() {
    const messages = [];
    for (const s of syncs.values()) for (const m of s.messages.values()) messages.push(m);
    return { demo: DEMO, accounts: publicAccounts(), hasOAuthClient: !!config.oauth, state: readJson('state.json', null), messages, photos: allPhotos(), photosDenied: photosDenied() };
  },

  saveState(state) { writeJson('state.json', state); },

  setOAuthClient({ clientId, clientSecret }) {
    if (!/\.apps\.googleusercontent\.com$/.test(clientId || '')) throw new Error('That does not look like a Google OAuth client ID (it should end in .apps.googleusercontent.com).');
    config.oauth = { clientId: clientId.trim(), secretEnc: enc((clientSecret || '').trim()) };
    saveConfig();
    return true;
  },

  async addAccount({ label } = {}) {
    if (!config.oauth) throw new Error('Add your Google OAuth client in Settings first.');
    const tok = await authorize(oauthClient(), (url) => shell.openExternal(url));
    const profile = await new Gmail(async () => tok.access_token).profile();
    const email = profile.emailAddress.toLowerCase();
    tokens.set(email, tok);
    const existing = config.accounts.find((a) => a.email === email);
    if (existing) existing.refreshEnc = enc(tok.refresh_token);
    else config.accounts.push({ email, label: label || (config.accounts.length ? 'Personal' : 'Work'), color: COLORS[config.accounts.length % COLORS.length], name: '', refreshEnc: enc(tok.refresh_token) });
    saveConfig();
    syncs.get(email)?.stop();
    delete photoCache[email]; // new sign-in may carry new permissions
    startSync(email);
    emit({ type: 'accounts', accounts: publicAccounts() });
    win?.focus();
    return email;
  },

  removeAccount(email) {
    syncs.get(email)?.stop();
    const removed = [...(syncs.get(email)?.messages.keys() || [])].map((id) => `${email}:${id}`);
    syncs.delete(email);
    tokens.delete(email);
    clearTimeout(saveTimers.get(email));
    saveTimers.delete(email);
    config.accounts = config.accounts.filter((a) => a.email !== email);
    saveConfig();
    delete photoCache[email];
    writeJson('photos.json', photoCache);
    fs.rmSync(dataPath(mailFile(email)), { force: true });
    emit({ type: 'messages', added: [], removed });
    emit({ type: 'accounts', accounts: publicAccounts() });
  },

  updateAccount(email, patch) {
    const a = config.accounts.find((x) => x.email === email);
    if (!a) return;
    for (const k of ['label', 'color', 'name']) if (typeof patch[k] === 'string') a[k] = patch[k];
    saveConfig();
    emit({ type: 'accounts', accounts: publicAccounts() });
  },

  async getMessage(email, id) {
    const full = await getFull(email, id);
    let html = full.html;
    // Inline images referenced by cid: become data URIs (bounded).
    let budget = 12;
    for (const img of full.inline) {
      if (!html.includes(`cid:${img.cid}`) || img.size > 3e6 || budget-- <= 0) continue;
      const bytes = await attachmentBytes(email, id, img);
      html = html.split(`cid:${img.cid}`).join(`data:${img.mime};base64,${bytes.toString('base64')}`);
    }
    const strip = ({ filename, mime, size }, index) => ({ index, filename, mime, size });
    return { ...full, html, inline: undefined, attachments: full.attachments.map(strip) };
  },

  async saveAttachment(email, msgId, index) {
    const full = await getFull(email, msgId);
    const att = full.attachments[index];
    if (!att) throw new Error('Attachment not found');
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(att.filename)) });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, await attachmentBytes(email, msgId, att));
    shell.showItemInFolder(filePath);
    return filePath;
  },

  async send(draft) {
    const sync = requireSync(draft.acct);
    const acct = config.accounts.find((a) => a.email === draft.acct);
    const attachments = [];
    for (const a of draft.attachments || []) {
      if (a.fwd) {
        const src = (await getFull(draft.acct, a.fwd.msgId)).attachments[a.fwd.index];
        if (src) attachments.push({ filename: src.filename, mime: src.mime, data: await attachmentBytes(draft.acct, a.fwd.msgId, src) });
      } else {
        attachments.push({ filename: a.filename, mime: a.mime, data: Buffer.from(a.dataB64, 'base64') });
      }
    }
    const raw = buildRaw({ ...draft, from: { name: acct.name, addr: acct.email }, attachments });
    const sent = await sync.gmail.send(raw, draft.threadId);
    const meta = await sync.fetchOne(sent.id).catch(() => null);
    if (meta) { emit({ type: 'messages', added: [meta], removed: [] }); scheduleSave(draft.acct, 500); }
    return { id: sent.id, threadId: sent.threadId };
  },

  /** Full-text search on Gmail's side. Returns message keys; unknown messages are fetched and emitted. */
  async searchRemote({ accts, q }) {
    const keys = [];
    for (const email of accts) {
      const sync = syncs.get(email);
      if (!sync) continue;
      const ids = [];
      for await (const id of sync.gmail.listIds(`${q} -in:drafts -in:chats`, { max: 200, urgent: true })) ids.push(id);
      const missing = ids.filter((id) => !sync.messages.has(id));
      if (missing.length) await sync.fetchMany(missing, 'search', true);
      for (const id of ids) if (sync.messages.has(id)) keys.push(`${email}:${id}`);
    }
    return keys;
  },

  syncNow() { for (const s of syncs.values()) { s.tick(); refreshPhotos(s.email); } },

  orgIcon,

  openExternal(url) {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
  },

  focusWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  },
};

// ------------------------------------------------------------ app

const WEB_PARTITION = 'persist:stillmail-web';
const isWebUrl = (url) => /^https?:\/\//i.test(url);

function setupWebPane() {
  // Pages in the pane get no device or notification permissions.
  session.fromPartition(WEB_PARTITION).setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return;
    // Links that want a new window load in the pane itself; nothing but web pages may load there.
    contents.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) contents.loadURL(url); return { action: 'deny' }; });
    contents.on('will-navigate', (e, url) => { if (!isWebUrl(url)) e.preventDefault(); });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    title: 'Stillmail',
    backgroundColor: '#16171a',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: true, webviewTag: true },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // The UI never navigates; anything else goes to the system browser.
  // The in-app browser pane is a <webview>: an ordinary sandboxed web page with no access to the app.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    if (params.partition !== WEB_PARTITION || (params.src && !isWebUrl(params.src))) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { handlers.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win.webContents.getURL()) return; // reloading the app itself is fine
    e.preventDefault();
    handlers.openExternal(url);
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => handlers.focusWindow());
  app.whenReady().then(() => {
    setupWebPane();
    nativeTheme.themeSource = 'dark'; // native menus, dialogs and form controls match the UI
    config = readJson('config.json', config);
    photoCache = readJson('photos.json', {});
    iconCache = readJson('icons.json', {});
    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.handle(name, async (_e, ...args) => fn(...args));
    }
    if (!DEMO) for (const a of config.accounts) startSync(a.email);
    createWindow();
    setInterval(() => handlers.syncNow(), POLL_MS);
    powerMonitor.on('resume', () => handlers.syncNow());
    app.on('activate', () => { if (!win) createWindow(); else handlers.focusWindow(); });
  });
  app.on('before-quit', () => { for (const email of syncs.keys()) flushSave(email); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
