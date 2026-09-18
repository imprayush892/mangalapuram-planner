import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const distDir = '/home/user/mangalapuram-planner/app/dist';
const out = process.argv[2];
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.csv':'text/csv','.svg':'image/svg+xml','.txt':'text/plain','.yaml':'text/yaml','.obj':'text/plain' };
const server = createServer(async (req,res)=>{try{const u=decodeURIComponent((req.url??'/').split('?')[0]);const f=path.join(distDir,u==='/'?'index.html':u.replace(/^\//,''));const b=await readFile(f);res.writeHead(200,{'content-type':TYPES[path.extname(f)]??'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end('nf');}});
await new Promise(r=>server.listen(0,r));
const {port}=server.address();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const errors=[]; page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
await page.getByText('site data loaded').waitFor({timeout:60000});

await page.getByRole('button',{name:'Edit zones',exact:true}).click();
await page.getByRole('button',{name:'Split a zone'}).click();

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
// Pick a villa zone, then draw a cut across it.
await page.mouse.click(box.x + box.width*0.60, box.y + box.height*0.55);
await page.waitForTimeout(300);
await page.mouse.click(box.x + box.width*0.50, box.y + box.height*0.55);
await page.waitForTimeout(200);
await page.mouse.click(box.x + box.width*0.72, box.y + box.height*0.55);
await page.waitForTimeout(300);
await page.getByRole('button',{name:'Cut it'}).click();
await page.waitForTimeout(600);
const sidebar = await page.locator('aside').innerText();
await page.screenshot({path: out});
await browser.close(); server.close();
if (errors.length) { console.error('errors:\n'+errors.join('\n')); process.exit(1); }
console.log(sidebar.slice(0, 1600));
