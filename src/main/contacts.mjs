// Contact photos from the Google People API: saved contacts plus "other contacts"
// (people you have corresponded with). Returns {address: photoUrl}.

const PEOPLE = 'https://people.googleapis.com/v1';

function collect(people, out) {
  for (const p of people || []) {
    const photo = (p.photos || []).find((x) => x.url && !x.default);
    if (!photo) continue; // Google's generated letter/silhouette placeholders are skipped
    for (const e of p.emailAddresses || []) {
      const addr = (e.value || '').trim().toLowerCase();
      if (addr && !out[addr]) out[addr] = photo.url;
    }
  }
}

async function pages(gmail, url, query, key, out) {
  let pageToken;
  do {
    const r = await gmail.request(url, { query: { ...query, pageSize: 1000, pageToken } });
    collect(r[key], out);
    pageToken = r.nextPageToken;
  } while (pageToken);
}

/** @param {import('./gmail.mjs').Gmail} gmail  any client exposing request(url, {query}) */
export async function fetchContactPhotos(gmail) {
  const out = {};
  const errors = [];
  const attempt = async (fn) => { try { await fn(); } catch (e) { errors.push(e); } };
  await attempt(() => pages(gmail, `${PEOPLE}/people/me/connections`, { personFields: 'emailAddresses,photos' }, 'connections', out));
  await attempt(async () => {
    const base = { readMask: 'emailAddresses,photos' };
    try {
      // Profile source carries the person's own Google photo.
      await pages(gmail, `${PEOPLE}/otherContacts`, { ...base, sources: ['READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_PROFILE'] }, 'otherContacts', out);
    } catch (e) {
      if (e.status !== 400) throw e;
      await pages(gmail, `${PEOPLE}/otherContacts`, base, 'otherContacts', out);
    }
  });
  // Both failing with 401/403 means this sign-in predates the contacts permission.
  const denied = errors.length === 2 && errors.every((e) => e.status === 401 || e.status === 403);
  return { photos: out, denied, error: errors[0]?.message || null };
}

const RESERVED = /\.(example|invalid|test|localhost|local)$/;

/** Fetch an organisation's site icon as a data: URL. Resolves null if it has none; throws on network failure. */
export async function fetchOrgIcon(root, fetchImpl = fetch) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(root) || RESERVED.test(root)) return null;
  const res = await fetchImpl(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(root)}&sz=64`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!res.ok || !type.startsWith('image/')) return null; // unknown domains answer 404 with a placeholder
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 200000) return null;
  return `data:${type};base64,${buf.toString('base64')}`;
}
