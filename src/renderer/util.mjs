import { splitQuotedText } from '../core/quotes.mjs';

export { html, render, useState, useEffect, useRef, useMemo, useCallback } from '../../node_modules/htm/preact/standalone.module.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

/** Compact age: "now", "12m", "5h", "3d", then a date. */
export function ago(ts, now = Date.now()) {
  const d = now - ts;
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 60 * DAY) return `${Math.floor(d / DAY)}d`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(ts) {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const cx = (...xs) => xs.filter(Boolean).join(' ');

export function displayName(from) {
  return from.name || from.addr.split('@')[0];
}

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip anything active from email HTML. Parsed inertly; the result is further sandboxed in an iframe. */
export function sanitizeEmailHtml(src) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  doc.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,form,base,link,meta,noscript,audio,video,source,svg use').forEach((n) => n.remove());
  let remoteImages = false;
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'ping') el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'action' || name === 'background') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'IMG' && /^\s*(https?:)?\/\//i.test(el.getAttribute('src') || '')) remoteImages = true;
  }
  if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(src)) remoteImages = true;
  const styles = [...doc.querySelectorAll('style')].map((s) => s.outerHTML).join('');
  doc.body.querySelectorAll('style').forEach((s) => s.remove());
  collapseQuoted(doc);
  return { html: styles + doc.body.innerHTML, remoteImages };
}

export function htmlToText(src) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  doc.querySelectorAll('script,style,head').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,blockquote').forEach((n) => n.append('\n'));
  return doc.body.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const QUOTE_TOGGLE = '<div class="sm-quote-toggle" role="button" title="Show earlier messages">•••</div>';

export function textToHtml(text) {
  const block = (t) => {
    const linked = escapeHtml(t).replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
    return `<div style="white-space:pre-wrap;font:14px/1.55 system-ui,sans-serif">${linked}</div>`;
  };
  const split = splitQuotedText(text);
  if (!split) return block(text);
  return `${block(split.head)}${QUOTE_TOGGLE}<div class="sm-quote" hidden>${block(split.quoted)}</div>`;
}

// Where common mail programs put the earlier messages of a conversation.
const QUOTE_SEL = '.gmail_quote_container, .gmail_quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, #appendonsend, .moz-cite-prefix, .protonmail_quote, [id^="mail-editor-reference-message"], #reply-intro';

/** Fold quoted earlier correspondence behind a "•••" toggle (the parent page handles the click). */
function collapseQuoted(doc) {
  let start = doc.body.querySelector(QUOTE_SEL);
  if (!start) return;
  if (/forwarded message/i.test(start.textContent.slice(0, 300))) return; // a forward's content is the message
  const prev = start.previousElementSibling;
  if (prev && (prev.tagName === 'HR' || (prev.textContent.length < 300 && /wrote:\s*$/i.test(prev.textContent.trim())))) start = prev;
  const before = doc.createRange();
  before.setStart(doc.body, 0);
  before.setEndBefore(start);
  if (!before.toString().trim() && !before.cloneContents().querySelector('img')) return; // nothing but the quote: show it
  const wrap = doc.createElement('div');
  wrap.className = 'sm-quote';
  wrap.setAttribute('hidden', '');
  start.insertAdjacentHTML('beforebegin', QUOTE_TOGGLE);
  start.parentNode.insertBefore(wrap, start);
  for (let n = start; n;) { const next = n.nextSibling; wrap.appendChild(n); n = next; }
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
