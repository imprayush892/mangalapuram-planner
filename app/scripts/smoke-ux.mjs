// Drives the new shell: live metrics on a control change, auto-redraw, scenarios.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const out = process.argv[2] ?? path.join(appDir, 'smoke-ux.png');
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.csv':'text/csv','.svg':'image/svg+xml','.txt':'text/plain','.yaml':'text/yaml','.obj':'text/plain','.f32':'application/octet-stream' };
const server = createServer(async (req,res)=>{try{const u=decodeURIComponent((req.url??'/').split('?')[0]);const f=path.join(distDir,u==='/'?'index.html':u.replace(/^\//,''));const b=await readFile(f);res.writeHead(200,{'content-type':TYPES[path.extname(f)]??'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,r));
const {port}=server.address();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
page.on('response', r=>{ if (r.status()>=400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
await page.getByText('ready', { exact: true }).waitFor({timeout:60000});

const readMetric = async (label) => {
  const row = page.locator('div', { hasText: new RegExp(`^${label}$`) }).first();
  return (await page.locator('aside, div').filter({ hasText: label }).first().innerText()).slice(0, 200);
};

// The Massing section is open by default: change a lever and watch the figures.
const hud = page.locator('text=If it were built').locator('xpath=ancestor::div[1]');
const before = await hud.innerText();

// Flats per floor slider
const sliders = page.locator('input[type=range]');
const n = await sliders.count();
await sliders.nth(Math.min(1, n - 1)).fill('8');
await page.waitForTimeout(250);
const after = await hud.innerText();

const changedInstantly = before !== after;

// The plan should redraw itself with no button pressed.
let redrew = false;
try {
  await page.getByText(/Redrawing the plan/).waitFor({ timeout: 4000 });
  await page.getByText(/Plan drawn \d+ zones/).waitFor({ timeout: 300000 });
  redrew = true;
} catch { /* reported below */ }

await page.waitForTimeout(800);

// Save two scenarios and compare them.
await page.getByRole('button', { name: 'Save this one' }).click();
await page.waitForTimeout(200);
// A real change for the second scenario: a different FSI tier.
await page.getByRole('button', { name: '6', exact: true }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Save this one' }).click();
await page.waitForTimeout(400);

const cards = page.locator('text=/^Scenario [AB]$/');
const cardCount = await cards.count();
if (cardCount >= 2) {
  await cards.nth(0).click();
  await cards.nth(1).click();
  await page.waitForTimeout(200);
  const cmp = page.getByRole('button', { name: 'Compare' });
  if (await cmp.count()) { await cmp.click(); await page.waitForTimeout(400); }
}

await page.screenshot({ path: out });
const hudText = await hud.innerText();
await browser.close(); server.close();
if (errors.length) { console.error('console errors:\n'+errors.join('\n')); process.exit(1); }
console.log(`smoke-ux ok -> ${out}`);
console.log(`metrics changed with no button: ${changedInstantly}`);
console.log(`plan redrew on its own: ${redrew}`);
console.log(`scenarios saved: ${cardCount}`);
console.log('\nHUD:\n' + hudText.slice(0, 900));
