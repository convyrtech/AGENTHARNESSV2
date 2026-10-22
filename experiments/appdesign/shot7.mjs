// Render a landing page: desktop top (1440x900), desktop full page (capped 5400px), mobile top (390x844). Usage: node shot7.mjs <html> <outbase>
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [html, base] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy, args: ['--ignore-certificate-errors'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
try { await page.goto('file://' + html, { waitUntil: 'networkidle', timeout: 30000 }); } catch (e) { errors.push('load: ' + String(e).slice(0, 120)); }
await page.waitForTimeout(1500);
await page.screenshot({ path: base + '-top.png' });
const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 900);
for (let y = 0; y < Math.min(h, 9000); y += 700) { await page.evaluate(v => window.scrollTo(0, v), y).catch(() => {}); await page.waitForTimeout(200); }
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(600);
await page.screenshot({ path: base + '-full.jpg', type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.max(900, Math.min(h, 5400)) } }).catch(async () => page.screenshot({ path: base + '-full.jpg', type: 'jpeg', quality: 70 }));
const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
try { await m.goto('file://' + html, { waitUntil: 'networkidle', timeout: 30000 }); } catch (e) {}
await m.waitForTimeout(1200);
await m.screenshot({ path: base + '-mobile.png' });
console.log(JSON.stringify({ errors, height: h }));
await browser.close();
