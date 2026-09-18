// Runs the siting engine in the browser and screenshots the result.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const outFile = process.argv[2] ?? path.join(appDir, 'smoke-siting.png');

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
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, r));
const { port } = server.address();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.getByText('site data loaded').waitFor({ timeout: 60_000 });

await page.getByRole('button', { name: 'Siting', exact: true }).click();
await page.getByRole('button', { name: 'Place the uses' }).click();
await page.getByText(/alternatives in [\d.]+ s/).waitFor({ timeout: 120_000 });
await page.waitForTimeout(600);

// Open the rationale on the first zone, which is what a rationale card reports.
await page.getByRole('button', { name: 'Why here' }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: outFile });

const summary = (await page.locator('aside').innerText()).slice(0, 2200);
await browser.close();
server.close();
if (errors.length) { console.error('console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`smoke-siting ok -> ${outFile}\n\n${summary}`);
