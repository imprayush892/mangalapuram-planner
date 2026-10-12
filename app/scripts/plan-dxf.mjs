// Writes each prebuilt master plan (app/prebuilt/plans, `npm run plans`) as DXF, with the zoning it was drawn on:
// app/prebuilt/dxf/<option>.dxf (owner 12 Oct). `node scripts/plan-dxf.mjs [outDir]`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(appDir, 'prebuilt', 'dxf'));
const vite = await createServer({ root: appDir, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
try {
  const { nodeSource } = await vite.ssrLoadModule('/src/engine/data/nodeSource.ts');
  const { loadSite } = await vite.ssrLoadModule('/src/engine/site/loadSite.ts');
  const { PRESENT_PLAN_OPTIONS, decodePlan } = await vite.ssrLoadModule('/src/engine/present/prebuilt.ts');
  const { draftZonesFor } = await vite.ssrLoadModule('/src/engine/pipeline/basis.ts');
  const { exportPlanDxf } = await vite.ssrLoadModule('/src/engine/export/planDxf.ts');
  const site = await loadSite(nodeSource(path.join(appDir, 'public', 'data')));
  await mkdir(outDir, { recursive: true });
  for (const o of PRESENT_PLAN_OPTIONS) {
    const plan = decodePlan(JSON.parse(await readFile(path.join(appDir, 'prebuilt', 'plans', `${o.id}.json`), 'utf8')));
    const zones = draftZonesFor(site, o.zoning, o.roads);
    const file = path.join(outDir, `${o.id}.dxf`);
    await writeFile(file, exportPlanDxf({ site, plan, zones, title: `${o.id} ${o.label}` }));
    console.log(`plan-dxf: ${o.id} ${plan.plots.length} villas -> ${path.relative(process.cwd(), file)}`);
  }
} finally {
  await vite.close();
}
