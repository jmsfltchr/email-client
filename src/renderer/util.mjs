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
export function sanitizeEmailHtml(src, { forward = false } = {}) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  doc.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,form,base,link,meta,noscript,audio,video,source,svg use').forEach((n) => n.remove());
  let remoteImages = false;
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'ping') el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'action' || name === 'background') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    // "//host/pic.png" would resolve against the app's own file: address inside the frame.
    for (const name of ['src', 'background', 'poster']) {
      const v = el.getAttribute(name);
      if (v && /^\s*\/\//.test(v)) el.setAttribute(name, `https:${v.trim()}`);
    }
    if (el.tagName === 'IMG') {
      // Lazy-loading and responsive hints misfire in an auto-sized frame; fall back to them only when src is missing.
      el.removeAttribute('loading');
      if (!el.getAttribute('src')) {
        const alt = el.getAttribute('data-src') || (el.getAttribute('srcset') || '').trim().split(/[\s,]+/)[0];
        if (alt) el.setAttribute('src', alt.startsWith('//') ? `https:${alt}` : alt);
      }
      if (/^\s*https?:\/\//i.test(el.getAttribute('src') || '')) remoteImages = true;
    }
  }
  if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(src)) remoteImages = true;
  doc.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));
  const styles = [...doc.querySelectorAll('style')].map((s) => s.outerHTML).join('');
  doc.body.querySelectorAll('style').forEach((s) => s.remove());
  if (!forward) collapseQuoted(doc);
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

/** Is there any text or picture before `el` inside `within` (default: its parent)? */
function hasContentBefore(el, within = el.parentElement) {
  const r = el.ownerDocument.createRange();
  r.setStart(within, 0);
  r.setEndBefore(el);
  return !!r.toString().trim() || !!r.cloneContents().querySelector('img');
}

// Where common mail programs put the earlier messages of a conversation.
const QUOTE_SEL = '.gmail_quote_container, .gmail_quote, blockquote[type="cite"], .yahoo_quoted, #divRplyFwdMsg, #appendonsend, .moz-cite-prefix, .protonmail_quote, [id^="mail-editor-reference-message"], #reply-intro';

// Mail programs without quote markup (desktop Outlook above all) start the earlier message with a
// header block: "From: … Sent: … To: … Subject: …", or an "Original Message" rule, or "On … wrote:".
const HEADER_BLOCK = /^(From|Von|De|Da|Van):\s.{1,300}?\b(Sent|Date|Gesendet|Datum|Envoyé|Inviato|Enviado|Verzonden):\s.{1,400}?\b(Subject|Betreff|Objet|Oggetto|Asunto|Onderwerp):\s/s;
const ORIGINAL_RULE = /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}/i;
const WROTE_LINE = /^On\s.{8,250}\swrote:$/s;

function findQuoteHeader(doc) {
  for (const el of doc.body.querySelectorAll('div, p, span, td, blockquote, font')) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 12 || text.length > 1500) continue; // the header itself, not a container of the whole quote
    if (HEADER_BLOCK.test(text) || ORIGINAL_RULE.test(text)) return el;
    if (text.length < 300 && WROTE_LINE.test(text) && el.nextElementSibling?.tagName === 'BLOCKQUOTE') return el;
  }
  return null;
}

/** Fold quoted earlier correspondence behind a "•••" toggle (the parent page handles the click). */
function collapseQuoted(doc) {
  const marked = doc.body.querySelector(QUOTE_SEL);
  const header = findQuoteHeader(doc);
  // whichever comes first in the message
  let start = marked && header ? (marked.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_PRECEDING ? header : marked) : marked || header;
  if (!start) return;
  // A header that is the first thing inside its wrappers: fold from the outermost such wrapper.
  while (start.parentElement && start.parentElement !== doc.body && !hasContentBefore(start)) start = start.parentElement;
  if (/forwarded message/i.test(start.textContent.slice(0, 300))) return; // a forward's content is the message
  const prev = start.previousElementSibling;
  if (prev && (prev.tagName === 'HR' || (prev.textContent.length < 300 && /wrote:\s*$/i.test(prev.textContent.trim())))) start = prev;
  if (!hasContentBefore(start, doc.body)) return; // nothing but the quote: show it
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
