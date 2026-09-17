// Headless smoke check: boots the built app, waits for the site data to load,
// exercises the raster modes and writes a screenshot.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const outFile = process.argv[2] ?? path.join(appDir, 'smoke.png');
const raster = process.argv[3] ?? null;
const tab = process.argv[4] ?? null;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.f32': 'application/octet-stream', '.geojson': 'application/json', '.yaml': 'text/yaml',
  '.csv': 'text/csv', '.obj': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
    const file = path.join(distDir, rel);
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
page.on('requestfailed', (r) => errors.push(`requestfailed ${r.url()}`));
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.getByText('site data loaded').waitFor({ timeout: 45_000 });
if (tab) {
  await page.getByRole('button', { name: tab, exact: true }).click();
  await page.waitForTimeout(600);
}
if (raster) {
  await page.locator('select').first().selectOption(raster);
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(500);
await page.screenshot({ path: outFile });
await browser.close();
server.close();

if (errors.length) {
  console.error('console/page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`smoke ok -> ${outFile}`);
