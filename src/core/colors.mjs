// Identity colours: a fixed palette of well-separated hues, assigned so that the
// organisations you see most get colours that differ from each other.

const HUES = 16;
/** oklch keeps perceived brightness even across hues, so every colour reads the same on dark. */
export const PALETTE = Array.from({ length: HUES }, (_, i) => `oklch(0.76 0.13 ${Math.round(i * (360 / HUES) + 12)})`);

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Random-looking but stable colour for any string (used for individuals). */
export const hashColor = (id) => PALETTE[hash(id) % HUES];

/**
 * Give each id without a colour the least-used palette slot, so the first 16 organisations
 * are all different and later ones spread evenly. `ids` should be most-important first.
 * Returns only the new assignments ({id: paletteIndex}).
 */
export function assignColors(existing, ids) {
  const used = new Array(HUES).fill(0);
  for (const v of Object.values(existing)) if (v >= 0 && v < HUES) used[v]++;
  const out = {};
  for (const id of ids) {
    if (id in existing || id in out) continue;
    const min = Math.min(...used);
    const start = hash(id) % HUES;
    for (let k = 0; k < HUES; k++) {
      const idx = (start + k) % HUES;
      if (used[idx] === min) { out[id] = idx; used[idx]++; break; }
    }
  }
  return out;
}

// Mailbox providers: an address here says nothing about which organisation someone belongs to.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'fastmail.com', 'hey.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'comcast.net', 'verizon.net', 'att.net', 'qq.com', '163.com',
  'mailbox.example', // demo mailbox provider
]);
export const isFreeMail = (root) => FREE_MAIL.has(root);

export function initials(name, addr) {
  const words = (name || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return (words[0] || addr || '?').slice(0, 1).toUpperCase();
}
