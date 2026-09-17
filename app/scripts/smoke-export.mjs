// Generates a zone in the browser, then exercises every exporter and checks the
// bytes that come back: DXF structure, XLSX/GLB/PDF magic numbers, PNG header.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const outDir = process.argv[2] ?? path.join(appDir, 'export-check');
await mkdir(outDir, { recursive: true });

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

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.getByText('site data loaded').waitFor({ timeout: 60_000 });

// Generate one zone of each kind so the exports carry plots, towers and a block.
const zones = (process.env.EXPORT_ZONES ?? 'PROJECT - 2 (VILLAS)').split('|');
for (const zoneName of zones) {
  await page.getByRole('button', { name: 'Site', exact: true }).click();
  await page.getByRole('button', { name: zoneName }).click();
  await page.getByRole('button', { name: 'Zone layout', exact: true }).click();
  await page.getByRole('button', { name: /Generate 3 options|Place the block/ }).click();
  await page.getByText(/options? in [\d.]+ s/).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(400);
}

await page.getByRole('button', { name: 'Exports', exact: true }).click();
await page.waitForTimeout(1500);

const results = [];
// The DXF button fires two downloads (the drawing and its readme), so downloads
// are collected from the page rather than awaited one at a time.
const pending = [];
page.on('download', (d) => pending.push(d));

const grab = async (label, buttonName, expected = 1) => {
  pending.length = 0;
  await page.getByRole('button', { name: buttonName }).click();
  const deadline = Date.now() + 120_000;
  while (pending.length < expected && Date.now() < deadline) await page.waitForTimeout(200);
  if (pending.length < expected) throw new Error(`${label}: expected ${expected} downloads, got ${pending.length}`);
  for (const d of pending.splice(0)) {
    const target = path.join(outDir, d.suggestedFilename());
    await d.saveAs(target);
    const bytes = await readFile(target);
    results.push({ label, file: d.suggestedFilename(), size: bytes.length, bytes });
  }
};

await grab('DXF', 'Export DXF', 2);
await grab('XLSX', 'Export area statement');
await grab('PNG', 'Export PNG');
await grab('PDF', 'Export PDF');
await grab('GLB', 'Export GLB');

await page.screenshot({ path: path.join(outDir, 'exports-tab.png') });
await browser.close();
server.close();

const problems = [];
const find = (name) => results.find((r) => r.file.endsWith(name));
const dxf = find('.dxf');
if (!dxf || !dxf.bytes.toString('utf8', 0, 20).startsWith('0\nSECTION')) problems.push('DXF header wrong');
if (dxf && !dxf.bytes.toString('utf8').trimEnd().endsWith('EOF')) problems.push('DXF not terminated');
const xlsx = find('.xlsx');
if (!xlsx || xlsx.bytes[0] !== 0x50 || xlsx.bytes[1] !== 0x4b) problems.push('XLSX is not a zip');
const png = find('.png');
if (!png || png.bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') problems.push('PNG header wrong');
const pdf = find('.pdf');
if (!pdf || pdf.bytes.toString('utf8', 0, 5) !== '%PDF-') problems.push('PDF header wrong');
if (pdf && !pdf.bytes.toString('utf8').includes('%%EOF')) problems.push('PDF not terminated');
const glb = find('.glb');
if (!glb || glb.bytes.toString('utf8', 0, 4) !== 'glTF') problems.push('GLB magic wrong');
if (glb && glb.bytes.readUInt32LE(4) !== 2) problems.push('GLB is not version 2');
for (const r of results) if (r.size < 500) problems.push(`${r.file} is suspiciously small (${r.size} bytes)`);

await writeFile(path.join(outDir, 'summary.txt'), results.map((r) => `${r.label}\t${r.file}\t${r.size}`).join('\n'));
console.log(results.map((r) => `${r.label.padEnd(5)} ${String(r.size).padStart(9)} B  ${r.file}`).join('\n'));
if (errors.length) { console.error('console errors:\n' + errors.join('\n')); process.exit(1); }
if (problems.length) { console.error('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('\nall exports valid');
