// Sender identity visuals: photo or icon when we have one, otherwise a coloured initial.
// People are circles, organisations are rounded squares; both carry a stable identity colour.

import { html, cx } from './util.mjs';
import { S, api, notify, accountOf } from './store.mjs';
import { PALETTE, hash, hashColor, isFreeMail, initials } from '../core/colors.mjs';
import { domainOf, rootDomain, orgName } from '../core/domains.mjs';

const icons = new Map(); // root -> data URL | null | undefined while loading
const broken = new Set(); // image URLs that failed to load

function orgIcon(root) {
  if (!S.user.settings.senderImages) return null;
  if (!icons.has(root)) {
    icons.set(root, undefined);
    Promise.resolve(api.orgIcon?.(root)).catch(() => null).then((d) => { icons.set(root, d || null); if (d) notify(); });
  }
  return icons.get(root) || null;
}

export const orgColor = (root) => PALETTE[S.user.orgColor[root] ?? hash(root) % PALETTE.length];

/** Everything needed to draw one address. */
export function identity(addr, name = '') {
  const mine = S.accounts.find((a) => a.email === addr);
  if (mine) return { person: true, color: mine.color, text: initials(mine.name || 'You', addr), img: null, title: mine.email };
  const s = S.model?.senders.get(addr);
  const root = s?.root ?? rootDomain(domainOf(addr));
  if (s?.kind === 'channel') {
    return { person: false, color: orgColor(root), text: orgName(root)[0], img: orgIcon(root), title: `${s.org} · ${addr}` };
  }
  const photo = S.user.settings.senderImages ? S.photos[addr] : null;
  // Someone at a company shares its colour; someone on a public mailbox gets their own.
  const color = isFreeMail(root) ? hashColor(addr) : orgColor(root);
  return { person: true, color, text: initials(name || s?.name, addr), img: photo || null, title: addr };
}

export function Avatar({ addr, name, acct, small }) {
  const id = identity(addr, name);
  const img = id.img && !broken.has(id.img) ? id.img : null;
  const a = acct && S.accounts.length > 1 ? accountOf(acct) : null;
  return html`
    <span class=${cx('av', !id.person && 'org', img && 'has-img', small && 'sm')} style=${{ '--c': id.color }} title=${id.title} aria-hidden="true">
      ${img
        ? html`<img src=${img} alt="" referrerpolicy="no-referrer" draggable=${false} onError=${() => { broken.add(img); notify(); }} />`
        : id.text}
      ${a && html`<i class="badge" style=${{ background: a.color }} title=${a.label}></i>`}
    </span>`;
}

export const OrgChip = ({ root, org }) => html`<span class="org-chip" style=${{ '--c': orgColor(root) }}>${org}</span>`;
// Mailbox providers are not organisations, so they get a neutral marker.
export const Swatch = ({ root }) => html`<i class="swatch" style=${{ background: isFreeMail(root) ? 'var(--line)' : orgColor(root) }}></i>`;
