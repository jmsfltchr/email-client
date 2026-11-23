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
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
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

  await step('open thread, body renders in sandboxed frame', async () => {
    await page.click('text=Marcus Oyelaran');
    await page.waitForSelector('.reader iframe');
    const frame = page.frameLocator('.reader iframe');
    await frame.locator('text=Wednesday 3pm works').waitFor();
    assert.equal(await page.locator('.reader .msg').count(), 3);
    assert.ok(await page.locator('.reader .att', { hasText: 'Brightwater-renewal-terms.pdf' }).count());
    await shot('reader');
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
