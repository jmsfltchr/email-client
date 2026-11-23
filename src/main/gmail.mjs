// Minimal Gmail REST client (no SDK): retrying fetch + the handful of calls we need.

import { META_HEADERS } from '../core/mime.mjs';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gmail allows 15,000 quota units per user per minute. Stay well inside it so that a long
// backfill never trips the limit and there is headroom for opening and sending mail.
const UNITS_PER_MINUTE = 9000;
const COSTS = [[/\/messages\/send$/, 100], [/\/history$/, 2], [/\/profile$/, 1], [/\/(messages|attachments)(\/|$)/, 5]];

export function quotaCost(url) {
  const u = new URL(url);
  if (u.hostname !== 'gmail.googleapis.com') return 0; // other Google APIs have their own quotas
  return COSTS.find(([re]) => re.test(u.pathname))?.[1] ?? 5;
}

/** Token bucket over quota units. Background work queues in order; urgent calls go straight through. */
export class RateLimiter {
  constructor({ perMinute = UNITS_PER_MINUTE, burst = 300, now = Date.now, wait = sleep } = {}) {
    this.rate = perMinute / 60000; // units per ms
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.wait = wait;
    this.at = now();
    this.pausedUntil = 0;
    this.queue = Promise.resolve();
  }

  refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.at) * this.rate);
    this.at = t;
  }

  /** Resolve once `cost` units may be spent. Urgent calls never wait; they borrow from the bucket. */
  take(cost, urgent = false) {
    if (!cost) return Promise.resolve();
    if (urgent) { this.refill(); this.tokens -= cost; return Promise.resolve(); }
    const turn = this.queue.then(async () => {
      for (;;) {
        const t = this.now();
        if (t < this.pausedUntil) { await this.wait(this.pausedUntil - t); continue; }
        this.refill();
        if (this.tokens >= cost) { this.tokens -= cost; return; }
        await this.wait(Math.ceil((cost - this.tokens) / this.rate));
      }
    });
    this.queue = turn;
    return turn;
  }

  /** Google said we are over quota: hold all background work for a while. */
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); }
}

export class GmailError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
}

export class Gmail {
  /** getToken: async () => access token string */
  constructor(getToken, fetchImpl = fetch, { limiter = new RateLimiter() } = {}) {
    this.getToken = getToken;
    this.fetch = fetchImpl;
    this.limiter = limiter; // one per account: the quota is per user
  }

  async request(url, { method = 'GET', query, body, headers = {}, raw, urgent = false } = {}) {
    const u = new URL(url.startsWith('http') ? url : BASE + url);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else u.searchParams.set(k, v);
    }
    const cost = quotaCost(u);
    for (let attempt = 0; ; attempt++) {
      let res;
      await this.limiter?.take(cost, urgent);
      try {
        res = await this.fetch(u, {
          method,
          headers: { Authorization: `Bearer ${await this.getToken()}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: raw ? body : body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt >= 5) throw new GmailError(0, `Network error: ${e.message}`, 'network');
        await sleep(Math.min(30000, 500 * 2 ** attempt));
        continue;
      }
      if (res.ok) return res.status === 204 ? {} : res.json();
      const json = await res.json().catch(() => ({}));
      const reason = json.error?.errors?.[0]?.reason || json.error?.status || '';
      const message = json.error?.message || `Gmail API error ${res.status}`;
      const limited = res.status === 429 || (res.status === 403 && /rateLimit|RESOURCE_EXHAUSTED/i.test(`${reason} ${json.error?.status}`) && !/daily/i.test(reason));
      if (limited && attempt < 8) {
        // The quota is counted per minute, so short retries cannot help: back off for real.
        const hold = Math.min(65000, 5000 * 2 ** attempt);
        if (this.limiter) this.limiter.pause(hold); else await sleep(hold);
        continue;
      }
      if (res.status >= 500 && attempt < 6) {
        await sleep(Math.min(60000, 800 * 2 ** attempt) + Math.random() * 400);
        continue;
      }
      const err = new GmailError(res.status, message, reason);
      err.limited = limited;
      throw err;
    }
  }

  profile() { return this.request('/profile'); }

  /** Async-iterate all message ids matching q. */
  async *listIds(q, { max = Infinity, urgent = false } = {}) {
    let pageToken;
    let n = 0;
    do {
      const r = await this.request('/messages', { query: { q, maxResults: 500, pageToken }, urgent });
      for (const m of r.messages || []) { yield m.id; if (++n >= max) return; }
      pageToken = r.nextPageToken;
    } while (pageToken);
  }

  getMeta(id) {
    return this.request(`/messages/${id}`, { query: { format: 'metadata', metadataHeaders: META_HEADERS } });
  }

  // Things the user is waiting on skip the queue.
  getFull(id) { return this.request(`/messages/${id}`, { query: { format: 'full' }, urgent: true }); }

  async getAttachment(msgId, attId) {
    const r = await this.request(`/messages/${msgId}/attachments/${attId}`, { urgent: true });
    return Buffer.from(r.data || '', 'base64url');
  }

  /** History since startHistoryId -> {added:Set, removed:Set, historyId}. Throws GmailError 404 if too old. */
  async history(startHistoryId) {
    const added = new Set(), removed = new Set();
    let pageToken, historyId = startHistoryId;
    do {
      const r = await this.request('/history', { query: { startHistoryId, pageToken, maxResults: 500, historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded'] } });
      for (const h of r.history || []) {
        for (const x of h.messagesAdded || []) added.add(x.message.id);
        for (const x of h.messagesDeleted || []) { removed.add(x.message.id); added.delete(x.message.id); }
        for (const x of h.labelsAdded || []) {
          if (x.labelIds?.some((l) => l === 'TRASH' || l === 'SPAM')) { removed.add(x.message.id); added.delete(x.message.id); }
        }
      }
      if (r.historyId) historyId = r.historyId;
      pageToken = r.nextPageToken;
    } while (pageToken);
    return { added, removed, historyId };
  }

  /** Send a raw RFC 5322 message, optionally into an existing thread. */
  send(raw, threadId) {
    const bytes = Buffer.from(raw, 'utf8');
    if (bytes.length < 3 * 1024 * 1024) {
      return this.request('/messages/send', { method: 'POST', urgent: true, body: { raw: bytes.toString('base64url'), ...(threadId ? { threadId } : {}) } });
    }
    // Large message: multipart media upload (metadata + message/rfc822).
    const boundary = `stillmail_upload_${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.request(`${UPLOAD}/messages/send`, {
      method: 'POST', query: { uploadType: 'multipart' }, raw: true, urgent: true, body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
  }
}

/** Run fn over items with bounded concurrency. */
export async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}
