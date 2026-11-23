// Regenerates the app icon files from assets/icon.svg:
//   build/icon.png (1024), build/icon.icns (macOS), build/icon.ico (Windows), src/assets/icon.png (512, used at runtime)
// Needs Playwright (npm i -D playwright). Run: node scripts/make-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8');

function icns(pngs) {
  // type -> pixel size; each entry holds PNG data
  const types = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
  const chunks = Object.entries(types).map(([type, size]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(pngs[size].length + 8, 4);
    return Buffer.concat([head, pngs[size]]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function ico(pngs, sizes) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s === 256 ? 0 : s, 0);
    e.writeUInt8(s === 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(pngs[s].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[s].length;
    return e;
  });
  return Buffer.concat([head, ...entries, ...sizes.map((s) => pngs[s])]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pngs = {};
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body>`);
    pngs[size] = await page.screenshot({ omitBackground: true });
  }
  await browser.close();
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/icon.png'), pngs[1024]);
  fs.writeFileSync(path.join(root, 'build/icon.icns'), icns(pngs));
  fs.writeFileSync(path.join(root, 'build/icon.ico'), ico(pngs, [16, 24, 32, 48, 64, 128, 256]));
  fs.writeFileSync(path.join(root, 'src/assets/icon.png'), pngs[512]);
  console.log('icons written');
})();
