// Drives a real zone generation in the browser and screenshots the result.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const outFile = process.argv[2] ?? path.join(appDir, 'smoke-layout.png');
const zoneName = process.argv[3] ?? 'PROJECT - 2 (VILLAS)';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.f32': 'application/octet-stream', '.geojson': 'application/json', '.yaml': 'text/yaml',
  '.csv': 'text/csv', '.obj': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(distDir, url === '/' ? 'index.html' : url.replace(/^\//, ''));
    if (!file.startsWith(distDir)) throw new Error('escape');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const { port } = server.address();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.getByText('site data loaded').waitFor({ timeout: 60_000 });

// Pick the zone in the Site tab, then generate from the Zone layout tab.
await page.getByRole('button', { name: zoneName }).click();
await page.getByRole('button', { name: 'Zone layout', exact: true }).click();
const genButton = page.getByRole('button', { name: /Generate 3 options|Place the block/ });
await genButton.click();
try {
  await page.getByText(/options? in [\d.]+ s/).waitFor({ timeout: 90_000 });
} catch (e) {
  console.error('generation did not report success. sidebar text:');
  console.error((await page.locator('aside').innerText()).slice(0, 2000));
  console.error('errors:', errors.join('\n'));
  await page.screenshot({ path: outFile });
  await browser.close();
  server.close();
  process.exit(1);
}
await page.waitForTimeout(1200);
// Zoom in on the generated zone so the plots and roads are legible.
const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
const focus = { x: box.x + box.width * 0.36, y: box.y + box.height * 0.58 };
await page.mouse.move(focus.x, focus.y);
for (let i = 0; i < Number(process.env.ZOOM_STEPS ?? 8); i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(800);
await page.screenshot({ path: outFile });

let summary = '';
if (process.env.THREE_D) {
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForTimeout(3000);
  const c = page.locator('canvas').last();
  const bb = await c.boundingBox();
  await page.mouse.move(bb.x + bb.width * 0.42, bb.y + bb.height * 0.62);
  for (let i = 0; i < Number(process.env.THREE_D_ZOOM ?? 0); i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: outFile });
  summary = '3D view rendered';
} else if (process.env.REPORT_TAB) {
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: outFile });
  summary = (await page.locator('aside').innerText()).slice(0, 1400);
} else {
  summary = await page.locator('button:has-text("Option 1")').first().innerText();
}
await browser.close();
server.close();

if (errors.length) {
  console.error('console/page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`smoke-layout ok -> ${outFile}\n${summary}`);
