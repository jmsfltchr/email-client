const { _electron } = require('playwright');
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SP = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'stillmail-e2e-'));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n   ', e.message.split('\n').slice(0, 6).join('\n    ')); process.exitCode = 1; } };
(async () => {
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules/electron')), cwd: ROOT, args: ['.', '--demo', '--no-sandbox', `--user-data-dir=${SP}/ud`], colorScheme: process.env.DARK ? 'dark' : 'light' });
  const page = await app.firstWindow();
  const logs = [];
  // (the srcdoc message is Playwright's own probe of the sandboxed email frame, which correctly refuses scripts)
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes("'about:srcdoc' because the document's frame is sandboxed")) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForSelector('.section');
  console.log('screenshots in', SP);
  const shot = (n) => page.screenshot({ path: `${SP}/${n}${process.env.DARK ? '-dark' : ''}.png` });
  await page.screenshot({ path: `${SP}/home.png` });
  const topicLabels = () => page.$$eval('.topic > .row .path', (els) => els.map((e) => e.textContent));

  await step('no unread counts / needs reply list', async () => {
    const names = await page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    assert.deepStrictEqual(names, ['Priya Raman', 'Helen Rowan', 'Marcus Oyelaran', 'Dana Whitfield']);
  });

  await step('unread dots: shown for unread mail, cleared by opening', async () => {
    const dots = (section) => page.locator(`section[aria-label="${section}"] .row:has(.unread) .who, section[aria-label="${section}"] .row:has(.unread) .subj`).allTextContents();
    assert.deepStrictEqual(await page.locator('section[aria-label="Needs reply"] .row:has(.unread) .who').allTextContents(), ['Priya Raman', 'Helen Rowan']);
    assert.equal(await page.locator('section[aria-label="Attention"] .row:has(.unread)').count(), 4);
    await page.screenshot({ path: `${SP}/unread.png` });
    await page.click('section[aria-label="Needs reply"] >> text=Helen Rowan');
    await page.waitForSelector('.reader iframe');
    assert.deepStrictEqual(await page.locator('section[aria-label="Needs reply"] .row:has(.unread) .who').allTextContents(), ['Priya Raman']);
    await page.keyboard.press('Escape');
  });

  await step('email images: protocol-relative, lazy and srcset-only pictures get a loadable address', async () => {
    const out = await page.evaluate(async () => {
      const { sanitizeEmailHtml } = await import('./util.mjs');
      const r = sanitizeEmailHtml('<img id="a" src="//cdn.example.com/a.png" loading="lazy"><img id="b" data-src="https://x.example/b.png"><img id="c" srcset="//x.example/c1.png 1x, https://x.example/c2.png 2x"><img id="d" src="data:image/png;base64,AAAA"><table background="//x.example/bg.png"></table>');
      const d = new DOMParser().parseFromString(r.html, 'text/html');
      return { remote: r.remoteImages, src: [...d.images].map((i) => i.getAttribute('src')), lazy: d.querySelector('[loading]') !== null, srcset: d.querySelector('[srcset]') !== null, bg: d.querySelector('table').getAttribute('background') };
    });
    assert.deepStrictEqual(out, { remote: true, src: ['https://cdn.example.com/a.png', 'https://x.example/b.png', 'https://x.example/c1.png', 'data:image/png;base64,AAAA'], lazy: false, srcset: false, bg: 'https://x.example/bg.png' });
  });

  await step('bump moves an item to the top and stops it fading; undo restores', async () => {
    const who = () => page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    const row = page.locator('section[aria-label="Needs reply"] .row', { hasText: 'Dana Whitfield' });
    assert.ok(await row.evaluate((el) => el.classList.contains('fading')));
    await row.hover(); await row.locator('text=Bump').click();
    assert.equal((await who())[0], 'Dana Whitfield');
    const top = page.locator('section[aria-label="Needs reply"] .row').first();
    assert.ok(await top.evaluate((el) => el.classList.contains('fresh')));
    assert.match(await top.locator('.age').textContent(), /waiting 9d/);
    await page.screenshot({ path: `${SP}/bump.png` });
    await page.click('.toast >> text=Undo');
    assert.equal((await who())[3], 'Dana Whitfield');
    const a = page.locator('section[aria-label="Attention"] .row').last();
    const subject = await a.locator('.subj').textContent();
    await a.hover(); await a.locator('text=Bump').click();
    assert.equal(await page.locator('section[aria-label="Attention"] .row').first().locator('.subj').textContent(), subject);
    await page.click('.toast >> text=Undo');
  });

  await step('open thread, body renders in sandboxed frame', async () => {
    await page.click('text=Marcus Oyelaran');
    await page.waitForSelector('.reader iframe');
    const frame = page.frameLocator('.reader iframe');
    await frame.locator('text=Wednesday 3pm works').waitFor();
    assert.equal(await page.locator('.reader .msg').count(), 3);
    assert.ok(await page.locator('.reader .att', { hasText: 'Brightwater-renewal-terms.pdf' }).count());
    await shot('reader');
  });

  await step('earlier messages are folded behind an ellipsis', async () => {
    const body = page.frameLocator('.reader iframe');
    const old = body.locator('text=Tuesday or Wednesday afternoon both work');
    assert.equal(await old.isVisible(), false, 'quoted history hidden');
    await body.locator('.sm-quote-toggle').click();
    await old.waitFor({ state: 'visible' });
    await body.locator('.sm-quote-toggle').click();
    assert.equal(await old.isVisible(), false);
  });

  await step('ctrl/cmd+F finds text across the conversation', async () => {
    await page.locator('.reader-h h1').click();
    await page.keyboard.press('Control+f');
    await page.waitForSelector('.find input:focus');
    await page.keyboard.type('wednesday');
    await page.locator('.find-n', { hasText: '1 of 3' }).waitFor();
    assert.equal(await page.locator('.reader iframe').count(), 3, 'every message opened for searching');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('.find-n', { hasText: '3 of 3' }).waitFor();
    const last = page.frameLocator('.reader iframe >> nth=2');
    await last.locator('text=Tuesday or Wednesday afternoon both work').waitFor({ state: 'visible' });
    const marks = await page.locator('.reader iframe >> nth=2').evaluate((el) => [el.contentWindow.CSS.highlights.get('find').size, el.contentWindow.CSS.highlights.get('find-current').size]);
    assert.deepStrictEqual(marks, [2, 1]);
    await page.screenshot({ path: `${SP}/find.png` });
    await page.fill('.find input', 'zzzz');
    await page.locator('.find-n', { hasText: 'No matches' }).waitFor();
    // the shortcut also works while the message itself has focus
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.find').count(), 0);
    assert.ok(await page.locator('.reader').isVisible());
    await last.locator('body').click();
    await page.keyboard.press('Meta+f');
    await page.waitForSelector('.find input');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.find').count(), 0);
    assert.ok(await page.locator('.reader').isVisible());
  });

  await step('light / dark reading theme, for plain and HTML mail', async () => {
    const bg = (n) => page.locator(`.reader iframe >> nth=${n}`).evaluate((el) => [getComputedStyle(el.contentDocument.body).backgroundColor, getComputedStyle(el.contentDocument.documentElement).filter]);
    assert.deepStrictEqual(await bg(2), ['rgb(30, 32, 36)', 'none']);
    await page.click('[aria-label="Reading theme"] >> text=Light');
    await page.waitForFunction(() => !document.querySelector('.paper.dark'));
    await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('.reader iframe')[2].contentDocument.body).backgroundColor === 'rgb(255, 255, 255)');
    await page.click('[aria-label="Reading theme"] >> text=Dark');
    await page.waitForSelector('.paper.dark');
    // HTML mail: inverted page, folded quote
    await page.click('section[aria-label="Needs reply"] >> text=Priya Raman');
    const html = page.frameLocator('.reader iframe');
    await html.locator('text=staffing trade-off').waitFor();
    assert.equal(await html.locator('text=Draft roadmap attached').isVisible(), false);
    assert.match((await bg(0))[1], /invert\(1\)/);
    await page.screenshot({ path: `${SP}/dark-html.png` });
    await html.locator('.sm-quote-toggle').click();
    await html.locator('text=Draft roadmap attached').waitFor({ state: 'visible' });
    await page.click('section[aria-label="Needs reply"] >> text=Marcus Oyelaran');
    await page.waitForSelector('.reader iframe');
  });

  await step('reply all pre-fills recipients, subject, quote', async () => {
    await page.click('.reader-actions >> text=Reply all');
    await page.waitForSelector('.compose');
    assert.equal(await page.inputValue('.compose input[aria-label="To"]'), 'Marcus Oyelaran <marcus.oyelaran@brightwater.example>');
    assert.equal(await page.inputValue('.compose input[aria-label="Subject"]'), 'Re: Contract renewal terms');
    assert.match(await page.inputValue('.compose textarea'), /wrote:\n> Wednesday 3pm works/);
  });

  await step('cc/bcc, autocomplete, attachment, send with undo window', async () => {
    await page.click('.compose >> text=Cc Bcc');
    await page.fill('.compose input[aria-label="Cc"]', 'pri');
    await page.waitForSelector('.suggest');
    await page.keyboard.press('Enter');
    assert.match(await page.inputValue('.compose input[aria-label="Cc"]'), /Priya Raman <priya@fernhill.example>/);
    await page.fill('.compose input[aria-label="Bcc"]', 'archive@fernhill.example');
    await page.setInputFiles('.compose input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('.compose .att >> text=notes.txt');
    await page.locator('.compose textarea').pressSequentially('Clause 4 is fine. ');
    await shot('compose');
    await page.click('.compose >> text=Send');
    await page.waitForSelector('.toast >> text=Sending');
    await page.waitForSelector('.toast >> text=Sent', { timeout: 9000 });
    const names = await page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    assert.ok(!names.includes('Marcus Oyelaran'), 'replied thread leaves Needs reply');
    assert.equal(await page.locator('.reader .msg').count(), 4);
  });

  await step('forward carries attachments', async () => {
    await page.keyboard.press('Escape');
    await page.click('text=Dana Whitfield');
    await page.waitForSelector('.reader iframe');
    await page.click('.reader-actions >> text=Forward');
    await page.waitForSelector('.compose');
    assert.equal(await page.inputValue('.compose input[aria-label="Subject"]'), 'Fwd: Documents for signature');
    assert.equal(await page.locator('.compose .att').count(), 2);
    await page.click('.compose-h button');
  });

  await step('no reply needed removes person row', async () => {
    await page.click('.reader-actions >> text=No reply needed');
    const names = await page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    assert.ok(!names.includes('Dana Whitfield'));
    await page.click('.reader-top button');
  });

  await step('attention: dismiss + never flag topic + mark important', async () => {
    const before = await page.locator('section[aria-label="Attention"] .row').count();
    assert.equal(before, 8);
    const row = page.locator('section[aria-label="Attention"] .row', { hasText: 'Failed: fernhill/api#8911' });
    await row.hover(); await row.locator('text=Never flag topic').click();
    assert.equal(await page.locator('section[aria-label="Attention"] .row').count(), 6);
    const r2 = page.locator('section[aria-label="Attention"] .row', { hasText: 'Rachel Okafor' });
    await r2.hover(); await r2.locator('text=Important').click();
    const names = await page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    assert.ok(names.includes('Rachel Okafor'));
  });

  await step('Needs reply and Attention have their own time tabs', async () => {
    const who = () => page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    const attn = () => page.locator('section[aria-label="Attention"] .row').count();
    const before = [await who(), await attn()];
    await page.click('[aria-label="Needs reply period"] >> text=24h');
    assert.ok((await who()).length < before[0].length && (await who()).length > 0);
    assert.equal(await attn(), before[1], 'tabs are independent');
    await page.click('section[aria-label="Needs reply"] .more');
    assert.ok((await who()).length >= before[0].length, 'older ones are one click away');
    await page.click('[aria-label="Attention period"] >> text=24h');
    const day = await attn();
    assert.ok(day > 0 && day < before[1], `${day} < ${before[1]}`);
    await page.screenshot({ path: `${SP}/tabs.png` });
    await page.click('[aria-label="Needs reply period"] >> text=30d');
    await page.click('[aria-label="Attention period"] >> text=30d');
    assert.deepStrictEqual([(await who()).length, await attn()], [before[0].length + 1, before[1]]);
  });

  await step('period selector changes topic list', async () => {
    const n7 = (await topicLabels()).length;
    await page.click('section[aria-label="Notifications"] .seg >> text=24h');
    const n1 = (await topicLabels()).length;
    await page.click('section[aria-label="Notifications"] .seg >> text=30d');
    const n30 = (await topicLabels()).length;
    assert.ok(n1 < n7 && n7 < n30, `${n1} < ${n7} < ${n30}`);
    await page.click('section[aria-label="Notifications"] .seg >> text=7d');
  });

  await step('drag handle reorders topics and order persists', async () => {
    const before = await topicLabels();
    const src = page.locator('.topic').nth(4).locator('.handle');
    const dst = page.locator('.topic').nth(0);
    await src.dragTo(dst, { targetPosition: { x: 200, y: 4 } });
    const after = await topicLabels();
    assert.equal(after[0], before[4], `moved to top: ${after[0]}`);
    assert.equal(after[1], before[0]);
    // keyboard alternative
    await page.locator('.topic').nth(0).locator('.handle').focus();
    await page.keyboard.press('Alt+ArrowDown');
    const after2 = await topicLabels();
    assert.equal(after2[1], before[4]);
  });

  await step('expand topic shows messages; flag escalates to Attention', async () => {
    const t = page.locator('.topic', { hasText: 'Payout of' });
    await t.locator('> .row').click();
    const first = t.locator('.topic-body .row').first();
    await first.hover(); await first.locator('text=Flag').click();
    await page.locator('section[aria-label="Attention"] .reason', { hasText: 'Flagged by you' }).waitFor();
    await shot('home2');
  });

  await step('account tag filter', async () => {
    await page.click('.chips >> text=Personal');
    const dots = await page.$$eval('section[aria-label="Needs reply"] .who', (e) => e.map((x) => x.textContent));
    assert.deepStrictEqual(dots, ['Helen Rowan']);
    const labels = await topicLabels();
    assert.ok(labels.length > 0 && labels.every((l) => !/Github|Circleci|Stripe/.test(l)));
    await page.click('.chips >> text=Personal');
  });

  await step('hierarchical tag filter (org + topic multi-select)', async () => {
    await page.locator('.node', { hasText: 'Github' }).locator('input').check();
    let labels = await topicLabels();
    assert.ok(labels.length > 0 && labels.every((l) => l.startsWith('Github')), labels.join('|'));
    await page.locator('.node', { hasText: 'Stripe' }).locator('.tw').click();
    await page.locator('.node.l1', { hasText: 'billing' }).locator('.tw').click();
    await page.locator('.node.l2', { hasText: 'Payout of' }).locator('input').check();
    labels = await topicLabels();
    assert.ok(labels.some((l) => l.includes('Payout of')) && labels.every((l) => /^Github|Payout of/.test(l)), labels.join('|'));
    await shot('filtered');
    await page.click('.filters-on >> text=Clear all');
  });

  await step('search: domain then address facets, text query', async () => {
    await page.keyboard.press('/');
    await page.waitForSelector('.search');
    await page.fill('input[aria-label="Filter senders"]', 'git');
    await page.locator('[aria-label="Domains"] .facet', { hasText: 'github.com' }).click();
    const addrs = await page.$$eval('[aria-label="Addresses"] .facet', (e) => e.map((x) => x.title));
    assert.deepStrictEqual(addrs.sort(), ['noreply@github.com', 'notifications@github.com']);
    await page.locator('[aria-label="Addresses"] .facet[title="noreply@github.com"]').click();
    const n = await page.locator('.result').count();
    assert.equal(n, 8);
    await page.fill('input[aria-label="Search text"]', 'ssh key');
    assert.equal(await page.locator('.result').count(), 1);
    await shot('search');
    await page.locator('.result').first().click();
    await page.waitForSelector('.reader iframe');
    await page.frameLocator('.reader iframe').locator('text=deploy-laptop').waitFor();
    await shot('search-reader');
  });

  await step('links open in the browser pane; cmd-click and the button use the system browser', async () => {
    const server = require('http').createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/two' ? '<title>Second page</title><h1>Two</h1>' : '<title>Local test page</title><h1>One</h1><a id="next" target="_blank" href="/two">next</a>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });
    const opened = () => app.evaluate(() => global.__opened);
    const link = page.frameLocator('.reader iframe').locator('a', { hasText: 'Review keys' });
    await link.evaluate((a, href) => { a.href = href; }, `${base}/one`);

    await link.click({ modifiers: ['Meta'] });
    assert.deepStrictEqual(await opened(), [`${base}/one`]);
    assert.equal(await page.locator('.web').count(), 0, 'cmd-click does not open the pane');

    await link.click();
    await page.waitForSelector('.web webview');
    await page.locator('.web-url', { hasText: 'Local test page' }).waitFor();
    assert.match(await page.locator('.web-url b').textContent(), /^127\.0\.0\.1:/);
    assert.deepStrictEqual(await opened(), [`${base}/one`], 'plain click stays in the app');
    assert.ok(await page.locator('.reader').isVisible(), 'reader stays beside the page');
    await page.screenshot({ path: `${SP}/web.png` });

    // a target=_blank link inside the page loads in the same pane, and Back returns
    await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
      await wc.executeJavaScript('document.getElementById("next").click()', true);
    });
    await page.locator('.web-url', { hasText: 'Second page' }).waitFor();
    await page.click('.web-bar >> [aria-label="Back"]');
    await page.locator('.web-url', { hasText: 'Local test page' }).waitFor();

    await page.click('.web-bar >> text=Open in default browser');
    assert.deepStrictEqual(await opened(), [`${base}/one`, `${base}/one`]);
    const prefs = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((c) => c.getType() === 'webview');
      const p = wc.getLastWebPreferences();
      return { node: p.nodeIntegration, iso: p.contextIsolation, sandbox: p.sandbox, preload: p.preload || null };
    });
    assert.deepStrictEqual(prefs, { node: false, iso: true, sandbox: true, preload: null });
    await page.locator('.reader-h h1').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.web').count(), 0);
    assert.ok(await page.locator('.reader').isVisible(), 'Esc closes the page first, not the message');
    } finally { server.closeAllConnections(); server.close(); }
  });

  await step('rule editor defines regex topic', async () => {
    await page.click('.nav >> text=Focus');
    await page.keyboard.press('Escape');
    const t = page.locator('.topic', { hasText: 'Success:' });
    await t.locator('> .row').click();
    await t.locator('text=Define topic by pattern').click();
    await page.waitForSelector('.dialog');
    await page.fill('.dialog input.mono', '^(Success|Failed): ');
    await page.fill('.dialog input >> nth=0', 'Build results');
    await shot('rule');
    await page.click('.dialog >> text=Add topic');
    const labels = await topicLabels();
    assert.ok(labels.some((l) => l.includes('Build results')), labels.join('|'));
    assert.ok(!labels.some((l) => l.includes('Success:')));
  });

  await step('one topic for this sender, and back', async () => {
    await page.click('.nav >> text=Focus');
    const count = async () => (await topicLabels()).filter((l) => l.startsWith('Harbourbank')).length;
    assert.ok(await count() > 1);
    const t = page.locator('.topic', { hasText: 'You spent' });
    await t.locator('> .row').click();
    await t.locator('text=One topic for this sender').click();
    const labels = (await topicLabels()).filter((l) => l.startsWith('Harbourbank'));
    assert.deepStrictEqual(labels, ['Harbourbank›alerts›all mail']);
    await page.locator('.topic', { hasText: 'all mail' }).filter({ hasText: 'Harbourbank' }).locator('text=Split this sender by subject').click();
    assert.ok(await count() > 1);
  });

  await step('settings renders', async () => {
    await page.click('.nav >> text=Settings');
    await page.waitForSelector('.settings');
    await page.locator('text=Topic patterns').scrollIntoViewIfNeeded();
    await shot('settings');
  });

  console.log(logs.join('\n') || 'no console errors');
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
