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

/**
 * Find a logo's brand colour from its pixels (RGBA bytes).
 * Returns {color, invert}: `color` is the dominant hue that is neither near white, near black
 * nor grey, as "rgb(r g b)" (null when the logo is monochrome); `invert` is true for a dark
 * shape on a transparent background, which would vanish on a dark surface.
 */
export function analyseIcon(data) {
  const BINS = 24;
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let opaque = 0, clear = 0, lum = 0, colourful = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) { clear++; continue; }
    opaque++;
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    if (l > 0.92 || l < 0.1 || d < 0.12) continue;
    const s = d / (1 - Math.abs(2 * l - 1));
    if (s < 0.3) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
    bin.w += s; bin.r += r * s; bin.g += g * s; bin.b += b * s;
    colourful++;
  }
  if (!opaque) return { color: null, invert: false };
  if (colourful / opaque < 0.04) {
    return { color: null, invert: lum / opaque < 0.35 && clear / (opaque + clear) > 0.15 };
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
  let [r, g, b] = [best.r / best.w, best.g / best.w, best.b / best.w];
  // Keep the hue but make sure a thin line of it shows on a dark surface.
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  if (l < 0.5) { const k = (0.55 - l) / (1 - l); r += (1 - r) * k; g += (1 - g) * k; b += (1 - b) * k; }
  const to = (v) => Math.round(v * 255);
  return { color: `rgb(${to(r)} ${to(g)} ${to(b)})`, invert: false };
}
