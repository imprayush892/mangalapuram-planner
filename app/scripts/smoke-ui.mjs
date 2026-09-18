// Drives the new shell: goal sliders, streaming solve, stale state, tooltips.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const out = process.argv[2] ?? path.join(appDir, 'smoke-ui.png');
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.csv':'text/csv','.svg':'image/svg+xml','.txt':'text/plain','.yaml':'text/yaml','.obj':'text/plain','.f32':'application/octet-stream' };
const server = createServer(async (req,res)=>{try{const u=decodeURIComponent((req.url??'/').split('?')[0]);const f=path.join(distDir,u==='/'?'index.html':u.replace(/^\//,''));const b=await readFile(f);res.writeHead(200,{'content-type':TYPES[path.extname(f)]??'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,r));
const {port}=server.address();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('response', r=>{ if (r.status()>=400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
await page.getByText('ready', { exact: true }).waitFor({ timeout: 60_000 });

const results = {};

// 1. The rail explains itself on hover.
await page.locator('button[aria-label="Optimisation goal"]').hover();
await page.waitForTimeout(350);
results.railTooltip = await page.getByText(/Sets how much space, terrain and water/).first().isVisible();

// 2. The levers are there without opening anything.
results.leversVisible = await page.getByText('Terrain', { exact: true }).first().isVisible();

// 3. Solve, and watch it stream.
await page.getByRole('button', { name: /Solve the plan/ }).click();
let sawStreaming = false;
try {
  await page.getByText(/zones drawn/).waitFor({ timeout: 8000 });
  sawStreaming = true;
} catch {}
results.streamed = sawStreaming;
if (sawStreaming) {
  await page.screenshot({ path: out.replace('.png', '-streaming.png') });
}
await page.getByText(/^Current\./).waitFor({ timeout: 400_000 });
results.solved = true;

// 4. Change the goal; the bar must say the drawing is behind.
const sliders = page.locator('input[type=range]');
await sliders.nth(1).fill('5');   // terrain
await page.waitForTimeout(400);
results.staleShown = await page.getByText(/Drawn plan is behind/).isVisible();
results.staleNamesGoal = (await page.getByText(/Drawn plan is behind/).innerText()).includes('goal');

await page.screenshot({ path: out });

// 5. Re-solve under the terrain goal and compare.
await page.getByRole('button', { name: /Re-solve/ }).click();
await page.getByText(/^Current\./).waitFor({ timeout: 400_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: out.replace('.png', '-terrain.png') });

// 6. Water goal.
await sliders.nth(1).fill('0');
await sliders.nth(2).fill('5');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Re-solve/ }).click();
await page.getByText(/^Current\./).waitFor({ timeout: 400_000 });
await page.waitForTimeout(600);
await page.screenshot({ path: out.replace('.png', '-water.png') });

// The plan panel must report what each objective did.
await page.locator('button[aria-label="The drawn plan"]').click();
await page.waitForTimeout(400);
const panel = await page.locator('aside, div').filter({ hasText: 'What the run reports' }).last().innerText().catch(() => '');
results.reportsObjectives = /Space \d+%/.test(panel) && /Water \d+%/.test(panel);

await browser.close(); server.close();
if (errors.length) { console.error('console errors:\n'+errors.join('\n')); process.exit(1); }
console.log(JSON.stringify(results, null, 2));
