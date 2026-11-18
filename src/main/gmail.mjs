// Minimal Gmail REST client (no SDK): retrying fetch + the handful of calls we need.

import { META_HEADERS } from '../core/mime.mjs';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GmailError extends Error {
  constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
}

export class Gmail {
  /** getToken: async () => access token string */
  constructor(getToken, fetchImpl = fetch) {
    this.getToken = getToken;
    this.fetch = fetchImpl;
  }

  async request(url, { method = 'GET', query, body, headers = {}, raw } = {}) {
    const u = new URL(url.startsWith('http') ? url : BASE + url);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else u.searchParams.set(k, v);
    }
    for (let attempt = 0; ; attempt++) {
      let res;
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
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimit|userRateLimit/i.test(reason));
      if (retryable && attempt < 6) {
        await sleep(Math.min(60000, 800 * 2 ** attempt) + Math.random() * 400);
        continue;
      }
      throw new GmailError(res.status, json.error?.message || `Gmail API error ${res.status}`, reason);
    }
  }

  profile() { return this.request('/profile'); }

  /** Async-iterate all message ids matching q. */
  async *listIds(q, { max = Infinity } = {}) {
    let pageToken;
    let n = 0;
    do {
      const r = await this.request('/messages', { query: { q, maxResults: 500, pageToken } });
      for (const m of r.messages || []) { yield m.id; if (++n >= max) return; }
      pageToken = r.nextPageToken;
    } while (pageToken);
  }

  getMeta(id) {
    return this.request(`/messages/${id}`, { query: { format: 'metadata', metadataHeaders: META_HEADERS } });
  }

  getFull(id) { return this.request(`/messages/${id}`, { query: { format: 'full' } }); }

  async getAttachment(msgId, attId) {
    const r = await this.request(`/messages/${msgId}/attachments/${attId}`);
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
      return this.request('/messages/send', { method: 'POST', body: { raw: bytes.toString('base64url'), ...(threadId ? { threadId } : {}) } });
    }
    // Large message: multipart media upload (metadata + message/rfc822).
    const boundary = `stillmail_upload_${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(threadId ? { threadId } : {})}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.request(`${UPLOAD}/messages/send`, {
      method: 'POST', query: { uploadType: 'multipart' }, raw: true, body,
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
