// Minimal Notion API client. Talks straight to api.notion.com with an internal integration secret,
// which can only see the pages that integration has been added to.

import { NOTION_VERSION } from '../core/notion.mjs';

const BASE = 'https://api.notion.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explain(status, body) {
  const code = body?.code || '';
  if (status === 401) return 'Notion did not accept that integration secret.';
  if (status === 404 || code === 'object_not_found') return 'Notion cannot see that database. Open it in Notion, choose ••• → Connections, and add your integration.';
  if (status === 403 || code === 'restricted_resource') return 'The integration is not allowed to do that. Give it read, update and insert content capabilities in its Notion settings.';
  return body?.message || `Notion answered ${status}.`;
}

export class Notion {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async req(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if ((res.status === 429 || res.status >= 502) && attempt < 3) {
        await sleep(Math.min(10, Number(res.headers.get('retry-after')) || attempt + 1) * 1000);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok) throw Object.assign(new Error(explain(res.status, json)), { status: res.status });
      return json;
    }
  }

  /** Resolve a pasted id, which may name a database or one of its data sources. */
  async resolve(id) {
    const title = (o) => (o.title || []).map((t) => t.plain_text || '').join('') || 'Untitled';
    try {
      const db = await this.req('GET', `/databases/${id}`);
      const source = db.data_sources?.[0];
      if (!source) throw new Error('That Notion database has no data source to read.');
      return { dataSourceId: source.id, title: title(db), url: db.url || '' };
    } catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e;
      const ds = await this.req('GET', `/data_sources/${id}`);
      return { dataSourceId: ds.id, title: title(ds), url: ds.url || '' };
    }
  }

  dataSource(id) { return this.req('GET', `/data_sources/${id}`); }

  addProperties(id, properties) { return this.req('PATCH', `/data_sources/${id}`, { properties }); }

  async queryAll(id) {
    const pages = [];
    let cursor;
    do {
      const r = await this.req('POST', `/data_sources/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const p of r.results || []) if (p.object === 'page' && !p.in_trash && !p.archived) pages.push(p);
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return pages;
  }

  createPage(dataSourceId, properties) {
    return this.req('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties });
  }

  updatePage(id, body) { return this.req('PATCH', `/pages/${id}`, body); }
}
