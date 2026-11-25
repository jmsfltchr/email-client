// Notifications raised by the messaging pages in the Testers browser, kept as a list of people to answer.
// A note: {id, platform, title, body, tag, ts, done} where `done` is 0 while waiting, else when it was archived.

const MAX_WAITING = 200;
const MAX_ARCHIVED = 100;

const trim = (notes) => {
  const waiting = notes.filter((n) => !n.done).slice(0, MAX_WAITING);
  const archived = notes.filter((n) => n.done).sort((a, b) => b.done - a.done).slice(0, MAX_ARCHIVED);
  return [...waiting, ...archived];
};

/** Add a note, newest first. As on the desktop, a note with the same tag from the same place replaces the waiting one. */
export function addNote(notes, note) {
  const rest = (notes || []).filter((n) => n.id !== note.id && !(note.tag && !n.done && n.platform === note.platform && n.tag === note.tag));
  return trim([{ ...note, done: 0 }, ...rest]);
}

export function archiveNote(notes, id, now = Date.now()) {
  return trim((notes || []).map((n) => (n.id === id && !n.done ? { ...n, done: now } : n)));
}

export const clearArchive = (notes) => (notes || []).filter((n) => !n.done);

/**
 * When the page that raised a note is gone, find the conversation by name instead: the one person whose name
 * appears in the note and who has a conversation on that platform. Returns {row, link} or null.
 */
export function linkForNote(note, rows) {
  const text = ` ${note.title} `.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const hits = [];
  for (const row of rows || []) {
    const name = String(row.name || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (name.length < 3) continue;
    const link = row.links.find((l) => l.platform === note.platform && l.url);
    if (link && (text.includes(` ${name} `) || text.includes(` ${name.split(' ')[0]} `))) hits.push({ row, link, exact: text.includes(` ${name} `) });
  }
  const exact = hits.filter((h) => h.exact);
  const pool = exact.length ? exact : hits;
  return pool.length === 1 ? { row: pool[0].row, link: pool[0].link } : null;
}
