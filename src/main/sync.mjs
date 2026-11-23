// Per-account sync: resumable backfill of message metadata, then incremental via Gmail history.

import { toMeta } from '../core/mime.mjs';
import { pool, GmailError } from './gmail.mjs';

const EXCLUDE = '-in:drafts -in:chats';
const BATCH = 100;

export class AccountSync {
  /**
   * @param {object} o
   * @param {string} o.email
   * @param {import('./gmail.mjs').Gmail} o.gmail
   * @param {object|null} o.saved        previously persisted {historyId, backfillDone, horizon, messages}
   * @param {()=>void} o.save  mark dirty; caller persists snapshot() later
   * @param {(event:object)=>void} o.emit
   * @param {()=>number} o.syncMonths    how many months of received mail to keep (0 = all)
   */
  constructor({ email, gmail, saved, save, emit, syncMonths }) {
    this.email = email;
    this.gmail = gmail;
    this.save = save;
    this.emit = emit;
    this.syncMonths = syncMonths;
    this.messages = new Map((saved?.messages || []).map((m) => [m.id, m]));
    this.historyId = saved?.historyId || null;
    this.unread = new Set(saved?.unread || []); // ids Gmail currently marks unread (recent mail only)
    this.backfillDone = !!saved?.backfillDone;
    this.horizon = saved?.horizon ?? null;
    this.running = false;
    this.stopped = false;
  }

  snapshot() {
    return { historyId: this.historyId, backfillDone: this.backfillDone, horizon: this.horizon, unread: [...this.unread], messages: [...this.messages.values()] };
  }

  stop() { this.stopped = true; }

  /** One sync pass. Safe to call repeatedly; overlapping calls are ignored. */
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (this.horizon !== this.syncMonths()) this.backfillDone = false; // horizon changed: top up
      if (!this.backfillDone) { await this.refreshUnread(); await this.backfill(); } else await this.incremental();
      await this.refreshUnread();
      this.emit({ type: 'progress', acct: this.email, phase: 'idle', at: Date.now() });
    } catch (e) {
      const auth = e.code === 'invalid_grant' || e.status === 401;
      const message = auth ? 'Sign-in expired. Reconnect this account in Settings.'
        : e.limited ? 'Gmail is rate-limiting this account. Sync is paused and will carry on by itself in a minute.'
        : e.message;
      this.emit({ type: 'error', acct: this.email, auth, message });
    } finally {
      this.running = false;
    }
  }

  /**
   * Mirror Gmail's unread state for recent mail. Re-read in full each pass (a cheap id listing), so
   * mail read on another device loses its marker here too. Stillmail itself never changes it.
   */
  async refreshUnread() {
    const ids = [];
    for await (const id of this.gmail.listIds(`is:unread newer_than:90d ${EXCLUDE}`, { max: 5000 })) ids.push(id);
    const same = ids.length === this.unread.size && ids.every((id) => this.unread.has(id));
    if (same) return;
    this.unread = new Set(ids);
    this.emit({ type: 'unread', acct: this.email, ids });
    this.save();
  }

  async backfill() {
    if (!this.historyId) this.historyId = (await this.gmail.profile()).historyId;
    const months = this.syncMonths();
    const after = new Date();
    after.setMonth(after.getMonth() - months);
    const ymd = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
    // Recent mail first so the app is useful immediately; then everything I ever sent
    // (that is what defines important senders); then the rest of the horizon.
    const phases = [
      ['recent mail', `newer_than:30d ${EXCLUDE}`],
      ['sent mail', `in:sent ${EXCLUDE}`],
      ['history', months > 0 ? `after:${ymd} ${EXCLUDE}` : EXCLUDE],
    ];
    for (const [phase, q] of phases) {
      const ids = [];
      for await (const id of this.gmail.listIds(q)) {
        if (this.stopped) return;
        if (!this.messages.has(id)) ids.push(id);
      }
      await this.fetchMany(ids, phase);
      if (this.stopped) return;
    }
    this.backfillDone = true;
    this.horizon = months;
    this.save();
  }

  async incremental() {
    let h;
    try {
      h = await this.gmail.history(this.historyId);
    } catch (e) {
      if (!(e instanceof GmailError) || e.status !== 404) throw e;
      // History expired: re-anchor and re-scan the recent window.
      this.historyId = (await this.gmail.profile()).historyId;
      const ids = [];
      for await (const id of this.gmail.listIds(`newer_than:30d ${EXCLUDE}`)) if (!this.messages.has(id)) ids.push(id);
      await this.fetchMany(ids, 'catching up', true);
      this.save();
      return;
    }
    const removed = [...h.removed].filter((id) => this.messages.delete(id));
    if (removed.length) this.emit({ type: 'messages', added: [], removed: removed.map((id) => `${this.email}:${id}`) });
    const fresh = [...h.added].filter((id) => !this.messages.has(id));
    await this.fetchMany(fresh, 'new mail', true);
    if (h.historyId !== this.historyId || removed.length || fresh.length) {
      this.historyId = h.historyId;
      this.save();
    }
  }

  /** Fetch metadata for ids, emitting in batches. `live` marks mail that arrived while running. */
  async fetchMany(ids, phase, live = false) {
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      if (this.stopped) return;
      const added = [];
      await pool(ids.slice(i, i + BATCH), 8, async (id) => {
        const m = await this.fetchOne(id);
        if (m) added.push(m);
      });
      done += Math.min(BATCH, ids.length - i);
      if (added.length) this.emit({ type: 'messages', added, removed: [], live });
      if (!live) this.emit({ type: 'progress', acct: this.email, phase, done, total: ids.length });
      this.save();
    }
  }

  /** Fetch + store one message's metadata. Returns the record, or null if skipped/gone. */
  async fetchOne(id) {
    let raw;
    try {
      raw = await this.gmail.getMeta(id);
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) return null;
      throw e;
    }
    const m = toMeta(this.email, raw);
    if (m) this.messages.set(id, m);
    return m;
  }
}
