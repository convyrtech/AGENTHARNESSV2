/**
 * Render the app icons from build/icon.svg (the PRSLOY monogram).
 *
 *   node apps/desktop/scripts/render-icons.cjs
 *
 * Writes build/icon.png (1024), build/icon.ico (16–256, PNG entries) and build/icon.icns
 * (ic07–ic10 PNG entries). Uses the preinstalled Playwright Chromium to rasterize, so the
 * output matches what a browser draws for the SVG. Not part of the build: run it after
 * editing icon.svg and commit the results. When the project's Playwright has no browser
 * downloaded, point PLAYWRIGHT_MODULE at another Playwright install that has one.
 */
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const BUILD = join(__dirname, "..", "build");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = { 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };

async function rasterize(svg, sizes) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = new Map();
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace(
      "<svg ",
      `<svg style="display:block;width:${size}px;height:${size}px" `,
    );
    await page.setContent(`<html><body style="margin:0">${sized}</body></html>`);
    out.set(size, await page.screenshot({ omitBackground: true }));
  }
  await browser.close();
  return out;
}

function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(([size, data], i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map(([, data]) => data)]);
}

function icns(entries) {
  const chunks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

void (async () => {
  const svg = readFileSync(join(BUILD, "icon.svg"), "utf8");
  const sizes = [...new Set([...ICO_SIZES, ...Object.keys(ICNS_TYPES).map(Number)])];
  const pngs = await rasterize(svg, sizes);
  writeFileSync(join(BUILD, "icon.png"), pngs.get(1024));
  writeFileSync(join(BUILD, "icon.ico"), ico(ICO_SIZES.map((s) => [s, pngs.get(s)])));
  writeFileSync(
    join(BUILD, "icon.icns"),
    icns(Object.entries(ICNS_TYPES).map(([s, type]) => [type, pngs.get(Number(s))])),
  );
  console.log("icon.png, icon.ico, icon.icns written");
})();
