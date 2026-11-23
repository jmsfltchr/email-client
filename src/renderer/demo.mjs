// Demo backend: a deterministic fake mailbox implementing the same API as the Electron preload.
// Used with `npm run demo`, from the welcome screen, or when the UI is opened in a plain browser.

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const WORK = 'alex@fernhill.example';
const HOME = 'alex.rowan@mailbox.example';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function generateDemo(now = Date.now()) {
  const rand = rng(20261118);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const messages = [];
  const bodies = new Map();
  let seq = 0;

  const add = (acct, { from, to = [acct], subject, ago, body, html, thread, sent = false, bulk = false, attachments }) => {
    const id = `d${(++seq).toString(36)}`;
    const text = body || subject;
    const m = {
      key: `${acct}:${id}`, acct, id, threadId: thread || `t${id}`, ts: Math.round(now - ago),
      from: sent ? { name: 'Alex Rowan', addr: acct } : from, to, subject,
      snippet: text.replace(/\s+/g, ' ').slice(0, 140), sent, bulk,
    };
    messages.push(m);
    bodies.set(m.key, { text, html: html || '', attachments: attachments || [] });
    return m;
  };

  // ---- people (I have written to all of these, so they are important)
  const P = {
    priya: { name: 'Priya Raman', addr: 'priya@fernhill.example' },
    tom: { name: 'Tom Becker', addr: 'tom@fernhill.example' },
    marcus: { name: 'Marcus Oyelaran', addr: 'marcus.oyelaran@brightwater.example' },
    sofia: { name: 'Sofia Lindqvist', addr: 'sofia@northlight.example' },
    dana: { name: 'Dana Whitfield', addr: 'dana@whitfield-law.example' },
    mum: { name: 'Helen Rowan', addr: 'helen.rowan@mailbox.example' },
    jo: { name: 'Jo Adeyemi', addr: 'jo.adeyemi@mailbox.example' },
  };
  const convo = (acct, person, subject, turns) => {
    let thread;
    turns.forEach(([who, ago, body, attachments, html], i) => {
      const m = add(acct, who === 'me'
        ? { sent: true, to: [person.addr], subject: i ? `Re: ${subject}` : subject, ago, body, thread }
        : { from: person, subject: i ? `Re: ${subject}` : subject, ago, body, thread, attachments, html });
      thread = m.threadId;
    });
  };

  convo(WORK, P.priya, 'Q4 roadmap review', [
    ['me', 9 * DAY, 'Hi Priya,\n\nDraft roadmap attached. Biggest open question is whether we pull the billing migration into Q4.\n\nAlex'],
    ['them', 5 * HOUR, 'Thanks Alex. I think we should, but I need your call on the staffing trade-off before Friday\'s planning session. Can you send me a yes/no and one paragraph of reasoning?\n\nPriya', undefined, '<div dir="ltr">Thanks Alex. I think we should, but I need your call on the <b>staffing trade-off</b> before Friday\'s planning session. Can you send me a yes/no and one paragraph of reasoning?<br><br>Priya</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 9 Nov 2026 at 10:02, Alex Rowan &lt;alex@fernhill.example&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">Hi Priya,<br><br>Draft roadmap attached. Biggest open question is whether we pull the billing migration into Q4.<br><br>Alex</blockquote></div>'],
  ]);
  convo(WORK, P.marcus, 'Contract renewal terms', [
    ['them', 6 * DAY, 'Hi Alex, ahead of renewal we would like to discuss moving to annual billing. Are you free next week?\n\nMarcus'],
    ['me', 5.5 * DAY, 'Hi Marcus, yes. Tuesday or Wednesday afternoon both work.\n\nAlex'],
    ['them', 2 * DAY, 'Wednesday 3pm works. I have attached our proposed terms; could you confirm you are happy with clause 4 before the call?\n\nMarcus\n\nOn Fri, 13 Nov 2026 at 09:12, Alex Rowan <alex@fernhill.example> wrote:\n> Hi Marcus, yes. Tuesday or Wednesday afternoon both work.\n>\n> Alex\n>\n> On Thu, 12 Nov 2026, Marcus Oyelaran wrote:\n>> Hi Alex, ahead of renewal we would like to discuss moving to annual billing. Are you free next week?', [{ filename: 'Brightwater-renewal-terms.pdf', mime: 'application/pdf', size: 184320 }]],
  ]);
  convo(HOME, P.dana, 'Documents for signature', [
    ['me', 40 * DAY, 'Hi Dana, could you send over the final versions when ready?\n\nAlex'],
    ['them', 9 * DAY, 'Dear Alex,\n\nPlease find the final documents attached. I need signed copies back from you to proceed.\n\nKind regards,\nDana', [{ filename: 'Deed-final.pdf', mime: 'application/pdf', size: 412000 }, { filename: 'Signing-notes.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 28100 }]],
  ]);
  convo(HOME, P.mum, 'Sunday lunch?', [
    ['them', 26 * HOUR, 'Hello love, are you two coming on Sunday? Let me know so I can get enough in. Mum x'],
  ]);
  convo(HOME, P.mum, 'Photos from the weekend', [
    ['them', 70 * DAY, 'Here are the photos! x'],
    ['me', 69 * DAY, 'These are lovely, thank you! x'],
  ]);
  convo(WORK, P.tom, 'Staging outage postmortem', [
    ['them', 3 * DAY, 'Draft postmortem is in the doc. Anything to add before I circulate?'],
    ['me', 2.8 * DAY, 'Looks good. Added one line on the alert threshold. Ship it.'],
  ]);
  convo(WORK, P.sofia, 'Design partnership — next steps', [
    ['me', 20 * DAY, 'Hi Sofia, great to meet last week. Sharing the brief as promised.'],
    ['them', 18 * DAY, 'Thanks Alex, received. We will come back with a proposal by month end.'],
    ['me', 17 * DAY, 'Perfect, thank you.'],
  ]);
  convo(HOME, P.jo, 'Climbing Thursday?', [
    ['them', 12 * DAY, 'Usual place, 7pm?'],
    ['me', 11.9 * DAY, 'In.'],
    ['them', 47 * DAY + 3 * HOUR, 'Are we still on for the trip in March?'],
  ]);
  convo(WORK, P.tom, 'On-call swap', [
    ['them', 38 * DAY, 'Could you take my on-call on the 14th? I can cover any of yours in return.'],
  ]);

  // ---- an unfamiliar human sender
  add(WORK, { from: { name: 'Rachel Okafor', addr: 'rachel.okafor@lanternstudio.example' }, subject: 'Intro from Priya — research collaboration?', ago: 3 * HOUR, body: 'Hi Alex,\n\nPriya suggested I get in touch. We are running a study on developer tooling and would love 30 minutes of your time.\n\nBest,\nRachel' });

  // ---- notification channels
  const series = (acct, from, count, spanDays, subjectFn, opts = {}) => {
    for (let i = 0; i < count; i++) {
      const ago = (opts.offset || 0) + (spanDays * DAY * (i + rand() * 0.8)) / count + int(5, 55) * MIN;
      const subject = subjectFn(i);
      add(acct, { from, subject, ago, bulk: opts.bulk !== false, body: opts.body?.(subject), html: opts.html?.(subject) });
    }
  };
  const card = (org, colour, subject, lines, cta) => `
    <div style="background:#f3f4f6;padding:24px;font-family:Helvetica,Arial,sans-serif">
      <table width="100%" style="max-width:560px;margin:auto;background:#fff;border-radius:8px;border-collapse:collapse"><tr><td style="padding:28px">
        <div style="font-weight:700;color:${colour};font-size:18px;margin-bottom:16px">${org}</div>
        <h2 style="font-size:18px;margin:0 0 12px;color:#111">${subject}</h2>
        ${lines.map((l) => `<p style="color:#444;font-size:14px;line-height:1.5;margin:0 0 10px">${l}</p>`).join('')}
        ${cta ? `<p style="margin:20px 0 0"><a href="https://example.com/demo" style="background:${colour};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px">${cta}</a></p>` : ''}
      </td></tr></table>
      <p style="text-align:center;color:#999;font-size:11px;margin-top:14px">You are receiving this because of your notification settings. <a href="https://example.com/unsubscribe" style="color:#999">Unsubscribe</a></p>
    </div>`;
  const cardFor = (org, colour, cta) => (subject) => card(org, colour, subject, ['This is a demo notification body generated by Stillmail.', 'Nothing here needs your attention unless it has been flagged.'], cta);

  const gh = { name: 'GitHub', addr: 'notifications@github.com' };
  const prTitles = ['Fix pagination cursor on empty result', 'Bump eslint to 9.2', 'Add retry to webhook dispatcher', 'Refactor session store', 'Speed up cold start', 'Remove dead feature flag', 'Handle 429 from upstream', 'Tidy README', 'Migrate to node 22', 'Cache auth lookups', 'Fix flaky invoice test', 'Add audit log export'];
  series(WORK, gh, 46, 60, () => `[fernhill/api] ${pick(prTitles)} (#${int(1200, 1460)})`, { html: cardFor('GitHub', '#24292f', 'View pull request') });
  series(WORK, gh, 22, 60, () => `[fernhill/web] ${pick(prTitles)} (#${int(300, 520)})`, { html: cardFor('GitHub', '#24292f', 'View pull request') });
  series(WORK, gh, 5, 45, () => `[fernhill/infra] ${pick(prTitles)} (#${int(40, 90)})`, { html: cardFor('GitHub', '#24292f', 'View pull request') });
  add(WORK, { from: { name: 'GitHub', addr: 'noreply@github.com' }, subject: '[GitHub] A new SSH key was added to your account', ago: 7 * HOUR, bulk: false, html: card('GitHub', '#24292f', 'A new SSH key was added to your account', ['The following SSH key was added to your account: <b>deploy-laptop (ed25519)</b>.', 'If you believe this key was added in error, you can remove it and disable access.'], 'Review keys') });
  series(WORK, { name: 'GitHub', addr: 'noreply@github.com' }, 7, 200, () => '[GitHub] Your Dependabot alerts for the week', { offset: 2 * DAY, html: cardFor('GitHub', '#24292f', 'View alerts') });

  const ci = { name: 'CircleCI Builds', addr: 'builds@circleci.com' };
  series(WORK, ci, 58, 45, () => `Success: fernhill/api#${int(8000, 8900)} (main)`, { offset: DAY, html: cardFor('CircleCI', '#343434', 'View build') });
  add(WORK, { from: ci, subject: 'Failed: fernhill/api#8911 (main)', ago: 11 * HOUR, bulk: true, html: card('CircleCI', '#343434', 'Failed: fernhill/api#8911 (main)', ['Job <b>integration-tests</b> failed after 6m 12s.', 'Commit: Handle 429 from upstream'], 'View build') });
  add(WORK, { from: ci, subject: 'Failed: fernhill/api#8794 (main)', ago: 19 * DAY, bulk: true, html: cardFor('CircleCI', '#343434', 'View build')('Failed: fernhill/api#8794 (main)') });

  const jira = { name: 'Jira', addr: 'jira@fernhill.atlassian.net' };
  const tickets = ['Checkout times out for EU cards', 'Export CSV drops last row', 'Add SSO for Brightwater', 'Rate limit admin API', 'Upgrade Postgres to 16', 'Billing migration spike', 'Dashboard shows stale totals'];
  series(WORK, jira, 34, 50, () => `[JIRA] (API-${int(400, 620)}) ${pick(tickets)}`, { html: cardFor('Jira', '#0052cc', 'View issue') });

  const cal = { name: 'Google Calendar', addr: 'calendar-notification@google.com' };
  const meetings = ['Planning', 'Brightwater sync', '1:1 Priya / Alex', 'Architecture review', 'Postmortem review', 'Hiring debrief', 'Quarterly review'];
  series(WORK, cal, 18, 40, (i) => `Invitation: ${pick(meetings)} @ ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i % 5]} ${int(1, 28)} Nov 2026 ${int(9, 16)}:00`, { bulk: false, html: cardFor('Google Calendar', '#1a73e8', 'View event') });
  series(WORK, cal, 9, 40, (i) => `Accepted: ${pick(meetings)} @ ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i % 5]} ${int(1, 28)} Nov 2026 ${int(9, 16)}:00`, { bulk: false, offset: DAY, html: cardFor('Google Calendar', '#1a73e8', 'View event') });

  const stripe = { name: 'Stripe', addr: 'billing@stripe.com' };
  series(WORK, stripe, 11, 330, () => `Your Stripe invoice #INV-${int(10000, 99999)} is available`, { offset: 4 * DAY, html: cardFor('Stripe', '#635bff', 'View invoice') });
  series(WORK, stripe, 40, 80, () => `Payout of £${int(800, 9000)}.${int(10, 99)} is on its way`, { offset: 6 * HOUR, html: cardFor('Stripe', '#635bff', 'View payout') });
  add(WORK, { from: stripe, subject: 'Payment failed for invoice #INV-48213', ago: 30 * HOUR, bulk: true, html: card('Stripe', '#635bff', 'Payment failed for invoice #INV-48213', ['We were unable to charge the card ending 4421 for <b>£1,240.00</b>.', 'We will retry in 3 days. Update the payment method to avoid interruption.'], 'Update payment method') });

  const aws = { name: 'Amazon Web Services', addr: 'no-reply-aws@amazon.com' };
  series(WORK, aws, 12, 360, () => 'Amazon Web Services Billing Statement Available', { offset: 8 * DAY, html: cardFor('AWS', '#ff9900', 'View statement') });
  series(WORK, aws, 9, 120, () => `AWS Budgets: fernhill-prod has exceeded ${pick([50, 80, 80, 100])}% of your budget`, { offset: 3 * DAY, html: cardFor('AWS', '#ff9900', 'Open Budgets') });

  const domains = { name: 'Namecheap', addr: 'support@namecheap.com' };
  for (const d of [30, 14, 7]) add(WORK, { from: domains, subject: `Your domain fernhill.dev expires in ${d} days`, ago: (365 + d - 14) * DAY, bulk: true, html: cardFor('Namecheap', '#de3723', 'Renew now')(`Your domain fernhill.dev expires in ${d} days`) });
  series(WORK, domains, 4, 300, () => 'Your Namecheap order confirmation', { offset: 40 * DAY, html: cardFor('Namecheap', '#de3723') });
  add(WORK, { from: domains, subject: 'Your domain fernhill.dev expires in 14 days', ago: 2 * DAY + 4 * HOUR, bulk: true, html: card('Namecheap', '#de3723', 'Your domain fernhill.dev expires in 14 days', ['Auto-renew is <b>off</b> for this domain.', 'Renew before 2 December to keep your site and email working.'], 'Renew now') });

  const slack = { name: 'Slack', addr: 'no-reply@slack.com' };
  series(WORK, slack, 26, 60, () => `You have ${int(2, 40)} unread messages in Fernhill`, { offset: 5 * HOUR, html: cardFor('Slack', '#4a154b', 'Open Slack') });

  // personal
  const amazon = { name: 'Amazon.co.uk', addr: 'shipment-tracking@amazon.co.uk' };
  series(HOME, amazon, 16, 90, () => `Your Amazon.co.uk order #${int(200, 299)}-${int(1000000, 9999999)}-${int(1000000, 9999999)} has been dispatched`, { offset: 2 * DAY, html: cardFor('Amazon', '#ff9900', 'Track package') });
  series(HOME, { name: 'Amazon.co.uk', addr: 'auto-confirm@amazon.co.uk' }, 16, 90, () => `Your Amazon.co.uk order of "${pick(['USB-C cable', 'Chalk bag', 'Coffee filters', 'Desk lamp', 'Notebook 3-pack', 'Bike lights', 'Tent pegs', 'Head torch', 'Phone case', 'Kettle descaler', 'Wool socks', 'HDMI adapter', 'Bird feeder', 'Paperback: The Overstory', 'Standing mat', 'AA batteries', 'Thermal flask', 'Garden twine'])}"`, { offset: 2 * DAY + HOUR, html: cardFor('Amazon', '#ff9900', 'View order') });

  const bank = { name: 'Harbour Bank', addr: 'alerts@harbourbank.example' };
  series(HOME, bank, 12, 360, () => 'Your monthly statement is ready', { offset: 10 * DAY, html: cardFor('Harbour Bank', '#0b5c7a', 'View statement') });
  series(HOME, bank, 30, 60, () => `You spent £${int(3, 180)}.${int(10, 99)} at ${pick(['Tesco', 'TfL', 'Pret', 'Waterstones', 'Shell', 'Deliveroo'])}`, { offset: 2 * HOUR, html: cardFor('Harbour Bank', '#0b5c7a') });
  add(HOME, { from: bank, subject: 'Unusual activity on your card ending 4421', ago: 50 * MIN, bulk: false, html: card('Harbour Bank', '#0b5c7a', 'Unusual activity on your card ending 4421', ['We declined a payment of <b>£612.40</b> to an online merchant we did not recognise.', 'If this was you, confirm it in the app. If not, freeze your card now.'], 'Review activity') });

  const energy = { name: 'Tidewell Energy', addr: 'noreply@tidewell-energy.example' };
  series(HOME, energy, 10, 300, () => 'Your energy statement is ready', { offset: 12 * DAY, html: cardFor('Tidewell Energy', '#1c7c54', 'View statement') });
  add(HOME, { from: energy, subject: 'Your Direct Debit payment is overdue', ago: 4 * DAY, bulk: true, html: card('Tidewell Energy', '#1c7c54', 'Your Direct Debit payment is overdue', ['We could not collect <b>£96.12</b> on 14 November.', 'Please make a payment within 7 days to avoid a late fee.'], 'Pay now') });

  const li = { name: 'LinkedIn', addr: 'notifications-noreply@linkedin.com' };
  series(HOME, li, 24, 60, () => `Alex, you have ${int(1, 12)} new notifications`, { offset: 9 * HOUR, html: cardFor('LinkedIn', '#0a66c2', 'See notifications') });
  series(HOME, { name: 'LinkedIn Job Alerts', addr: 'jobalerts-noreply@linkedin.com' }, 20, 60, () => `${int(3, 30)} new jobs for "Engineering Manager"`, { offset: 14 * HOUR, html: cardFor('LinkedIn', '#0a66c2', 'See jobs') });

  series(HOME, { name: 'Dense Signal', addr: 'hello@densesignal.example' }, 14, 98, (i) => `Dense Signal — Issue ${312 - i}`, { offset: 3 * DAY, html: cardFor('Dense Signal', '#111', 'Read online') });
  const essays = ['The quiet cost of dashboards', 'Notes on slow software', 'Why we stopped estimating', 'A field guide to on-call', 'What the map leaves out', 'Shipping is a habit', 'In praise of boring tools', 'Small teams, long games', 'The meeting that should be a doc', 'Reading the changelog'];
  series(HOME, { name: 'The Margin', addr: 'newsletter@themargin.example' }, 10, 70, (i) => essays[i], { offset: 5 * DAY, html: cardFor('The Margin', '#7a3e9d', 'Read the essay') });
  series(HOME, { name: 'Peakline Outdoors', addr: 'offers@peakline.example' }, 18, 60, () => pick(['Up to 40% off winter layers', 'New season climbing shoes are here', 'Members get early access this weekend', 'Free delivery on orders over £50', 'Your basket is waiting', 'Last few sizes left in your favourites', '5 routes to try before spring', 'Restocked: the jacket you looked at']), { offset: 8 * HOUR, html: cardFor('Peakline', '#c2571a', 'Shop now') });
  series(HOME, { name: 'Rail Tickets', addr: 'tickets@swiftrail.example' }, 7, 150, () => `Your booking confirmation ${pick(['KX', 'ED', 'MN'])}${int(100000, 999999)}`, { offset: 15 * DAY, html: cardFor('SwiftRail', '#b8365c', 'View tickets') });

  messages.sort((a, b) => a.ts - b.ts);
  return {
    accounts: [
      { email: WORK, label: 'Work', color: '#3b6fd4', name: 'Alex Rowan' },
      { email: HOME, label: 'Personal', color: '#c2571a', name: 'Alex Rowan' },
    ],
    messages,
    bodies,
  };
}

const svg = (body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`)}`;

// Stand-ins for contact photos: a plain illustrated portrait, so the photo path is visible in the demo.
const portrait = (bg, skin, hair) => svg(`<rect width="64" height="64" fill="${bg}"/><ellipse cx="32" cy="66" rx="25" ry="22" fill="${hair}"/><circle cx="32" cy="28" r="13" fill="${skin}"/><path d="M18 27a14 14 0 0 1 28 0c-4-7-10-9-14-9s-10 2-14 9z" fill="${hair}"/>`);
const DEMO_PHOTOS = {
  'priya@fernhill.example': portrait('#c9dfe8', '#b98058', '#2a1f1a'),
  'marcus.oyelaran@brightwater.example': portrait('#e6d9c3', '#7a4f36', '#17130f'),
  'helen.rowan@mailbox.example': portrait('#dfe6d2', '#e8bfa4', '#b9b4ad'),
};

// Stand-ins for organisation icons (generic shapes, not real logos). Others fall back to a coloured initial.
const DEMO_ICONS = {
  'github.com': svg('<circle cx="32" cy="32" r="26" fill="#1f2328"/><circle cx="32" cy="32" r="10" fill="#fff"/>'),
  'stripe.com': svg('<rect x="6" y="6" width="52" height="52" rx="12" fill="#5b54e8"/><path d="M18 40l28-16v18l-28 6z" fill="#fff"/>'),
  'circleci.com': svg('<circle cx="32" cy="32" r="24" fill="none" stroke="#2b2b2b" stroke-width="9"/><circle cx="32" cy="32" r="7" fill="#2b2b2b"/>'),
  'atlassian.net': svg('<path d="M10 54l22-44 22 44z" fill="#1d5fd1"/>'),
  'google.com': svg('<rect x="8" y="12" width="48" height="44" rx="6" fill="#2f73e0"/><rect x="16" y="24" width="32" height="24" rx="2" fill="#fff"/>'),
  'slack.com': svg('<rect x="10" y="26" width="44" height="12" rx="6" fill="#7a2a82"/><rect x="26" y="10" width="12" height="44" rx="6" fill="#d9952b"/>'),
  'linkedin.com': svg('<rect x="6" y="6" width="52" height="52" rx="8" fill="#0b63b8"/><rect x="16" y="26" width="8" height="22" fill="#fff"/><circle cx="20" cy="18" r="4.5" fill="#fff"/><path d="M30 26h8v4c6-8 14-4 14 4v14h-8V36c0-5-6-5-6 0v12h-8z" fill="#fff"/>'),
  'amazon.co.uk': svg('<path d="M10 40c14 10 30 10 44 0" fill="none" stroke="#d98a12" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="24" r="10" fill="#232323"/>'),
};

export function createDemoApi() {
  const demo = generateDemo();
  const byKey = new Map(demo.messages.map((m) => [m.key, m]));
  const listeners = new Set();
  const emit = (e) => listeners.forEach((l) => l(e));
  let n = 0;
  const store = (k, v) => {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* storage unavailable */ }
    return null;
  };

  return {
    async bootstrap() {
      const unread = {};
      const fresh = demo.messages.filter((m) => !m.sent && (Date.now() - m.ts < 8 * 3600000 || /Sunday lunch|Payment failed/.test(m.subject)));
      for (const m of fresh) (unread[m.acct] ||= []).push(m.id);
      return { demo: true, accounts: demo.accounts, hasOAuthClient: false, state: store('stillmail.demo.state'), messages: demo.messages, photos: DEMO_PHOTOS, unread };
    },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async saveState(state) { store('stillmail.demo.state', state); },
    async getMessage(acct, id) {
      const m = byKey.get(`${acct}:${id}`);
      const b = demo.bodies.get(m.key);
      const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : `${x.name} <${x.addr}>`)).join(', ');
      return {
        id, threadId: m.threadId, ts: m.ts, text: b.html ? '' : b.text, html: b.html,
        headers: { from: fmt([m.from]), to: fmt(m.to), cc: b.cc || '', bcc: '', replyTo: '', subject: m.subject, date: new Date(m.ts).toUTCString(), messageId: `<${id}@demo.stillmail>`, references: '' },
        attachments: b.attachments.map((a, index) => ({ index, ...a })),
      };
    },
    async saveAttachment() { return null; },
    async send(draft) {
      const id = `s${++n}`;
      const m = {
        key: `${draft.acct}:${id}`, acct: draft.acct, id, threadId: draft.threadId || `t${id}`, ts: Date.now(),
        from: { name: 'Alex Rowan', addr: draft.acct },
        to: [draft.to, draft.cc, draft.bcc].join(',').split(',').map((s) => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase()).filter(Boolean),
        subject: draft.subject, snippet: draft.text.replace(/\s+/g, ' ').slice(0, 140), sent: true, bulk: false,
      };
      byKey.set(m.key, m);
      demo.bodies.set(m.key, { text: draft.text, html: '', cc: draft.cc, attachments: (draft.attachments || []).map((a) => ({ filename: a.filename, mime: a.mime, size: a.size || 0 })) });
      emit({ type: 'messages', added: [m], removed: [] });
      return { id, threadId: m.threadId };
    },
    async searchRemote({ accts, q }) {
      const words = q.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(':') && !/^(or|and|\(|\))$/.test(w));
      return demo.messages.filter((m) => accts.includes(m.acct) && words.every((w) => `${m.subject} ${demo.bodies.get(m.key).text}`.toLowerCase().includes(w))).map((m) => m.key);
    },
    async syncNow() {},
    async orgIcon(root) { return DEMO_ICONS[root] || null; },
    async openExternal(url) { window.open(url, '_blank', 'noopener'); },
    async focusWindow() {},
    async setOAuthClient() { throw new Error('Not available in demo mode'); },
    async addAccount() { throw new Error('Not available in demo mode'); },
    async removeAccount() {},
    async updateAccount() {},
  };
}
