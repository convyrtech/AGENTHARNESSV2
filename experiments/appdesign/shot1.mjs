// Render one HTML file at 1440x900 (desktop app window) and save a PNG. Usage: node shot1.mjs <html> <out.png>
import { createRequire } from 'module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [html, out] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy, args: ['--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
try { await page.goto('file://' + html, { waitUntil: 'networkidle', timeout: 30000 }); } catch (e) { errors.push('load: ' + String(e).slice(0, 120)); }
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
console.log(JSON.stringify({ errors }));
await browser.close();
