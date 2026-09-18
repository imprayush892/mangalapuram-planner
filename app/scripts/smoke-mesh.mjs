// Screenshots the 3D terrain so the filled mesh can be checked by eye.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(appDir, 'dist');
const out = process.argv[2] ?? path.join(appDir, 'smoke-mesh.png');
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.csv':'text/csv','.svg':'image/svg+xml','.txt':'text/plain','.yaml':'text/yaml','.obj':'text/plain','.f32':'application/octet-stream' };
const server = createServer(async (req,res)=>{try{const u=decodeURIComponent((req.url??'/').split('?')[0]);const f=path.join(distDir,u==='/'?'index.html':u.replace(/^\//,''));const b=await readFile(f);res.writeHead(200,{'content-type':TYPES[path.extname(f)]??'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,r));
const {port}=server.address();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
await page.getByText('ready', { exact: true }).waitFor({ timeout: 90_000 });

if (process.env.SOLVE) {
  await page.getByRole('button', { name: /Solve the plan/ }).click();
  await page.getByText(/^Current\./).waitFor({ timeout: 400_000 });
  await page.waitForTimeout(500);
}

await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(5000);
await page.screenshot({ path: out });

// Orbit a little so the far side of the fill is visible too.
const box = await page.locator('canvas').boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.42, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(1500);
await page.screenshot({ path: out.replace('.png', '-b.png') });

await browser.close(); server.close();
if (errors.length) { console.error('console errors:\n'+errors.join('\n')); process.exit(1); }
console.log(`smoke-mesh ok -> ${out}`);
