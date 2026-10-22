// Screenshot each generated HTML page (desktop full page capped, after animations settle). Network allowed only for CDNs.
import { createRequire } from 'module';
const require = createRequire(process.env.PW_REQUIRE_FROM);
const { chromium } = require('playwright');
import fs from 'fs'; import path from 'path';
const root = process.argv[2]; const outDir = process.argv[3];
const browser = await chromium.launch();
for (const id of fs.readdirSync(root)) {
  for (const f of fs.readdirSync(path.join(root, id)).filter(f => f.endsWith('.html'))) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
    try {
      await page.goto('file://' + path.resolve(root, id, f), { waitUntil: 'networkidle', timeout: 30000 });
    } catch (e) { errors.push('load: ' + String(e).slice(0, 120)); }
    await page.waitForTimeout(2500);
    // scroll through to trigger scroll animations, then back to top
    const h = await page.evaluate(() => document.body ? document.body.scrollHeight : 0).catch(() => 0);
    for (let y = 0; y < Math.min(h, 9000); y += 700) { await page.evaluate(v => window.scrollTo(0, v), y).catch(() => {}); await page.waitForTimeout(250); }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); await page.waitForTimeout(800);
    const base = path.join(outDir, `${id}__${f.replace('.html', '')}`);
    await page.screenshot({ path: base + '_top.jpg', type: 'jpeg', quality: 70 });
    await page.screenshot({ path: base + '_full.jpg', type: 'jpeg', quality: 55, fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(900, Math.min(h || 900, 5400)) } }).catch(async () => {
      await page.screenshot({ path: base + '_full.jpg', type: 'jpeg', quality: 55 });
    });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try { await mobile.goto('file://' + path.resolve(root, id, f), { waitUntil: 'networkidle', timeout: 30000 }); } catch (e) {}
    await mobile.waitForTimeout(2000);
    await mobile.screenshot({ path: base + '_mobile.jpg', type: 'jpeg', quality: 60 });
    fs.writeFileSync(base + '_errors.json', JSON.stringify({ errors, height: h }));
    await page.close(); await mobile.close();
    console.log(id, f, 'h=' + h, 'errors=' + errors.length);
  }
}
await browser.close();
