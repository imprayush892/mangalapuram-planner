// Runs the whole master plan in the browser and screenshots the result.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const outFile = process.argv[2] ?? path.join(appDir, 'smoke-masterplan.png');
const zoomSteps = Number(process.env.ZOOM_STEPS ?? 0);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.f32': 'application/octet-stream', '.geojson': 'application/json', '.yaml': 'text/yaml',
  '.csv': 'text/csv', '.obj': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
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
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.getByText('site data loaded').waitFor({ timeout: 60_000 });

// Site the uses first, so the master plan follows the engine rather than names.
if (!process.env.SKIP_SITING) {
  await page.getByRole('button', { name: 'Siting', exact: true }).click();
  await page.getByRole('button', { name: 'Place the uses' }).click();
  await page.getByText(/alternatives in [\d.]+ s/).waitFor({ timeout: 120_000 });
}

await page.getByRole('button', { name: 'Master plan', exact: true }).click();
await page.getByRole('button', { name: 'Generate the master plan' }).click();
try {
  await page.getByText(/zones in [\d.]+ s/).waitFor({ timeout: 600_000 });
} catch (e) {
  console.error('the master plan did not finish. sidebar:');
  console.error((await page.locator('aside').innerText()).slice(0, 2500));
  console.error('errors:', errors.join('\n'));
  await page.screenshot({ path: outFile });
  await browser.close();
  server.close();
  process.exit(1);
}
await page.waitForTimeout(1500);

if (zoomSteps > 0) {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  for (let i = 0; i < zoomSteps; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
}

await page.screenshot({ path: outFile });

if (process.env.SHOT_3D) {
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: process.env.SHOT_3D });
}

const summary = (await page.locator('aside').innerText()).slice(0, 2600);
await browser.close();
server.close();
if (errors.length) { console.error('console errors:\n' + errors.join('\n')); process.exit(1); }
console.log(`smoke-masterplan ok -> ${outFile}\n\n${summary}`);
