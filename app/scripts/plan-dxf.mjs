// Writes each prebuilt master plan (app/prebuilt/plans, `npm run plans`) as a clean DXF (owner 12 Oct: like his
// D6-revised.dxf): the plan and its zoning go to tools/export/clean_dxf.py as plain JSON, which draws the road edges
// as the blocks' outlines with rounded corners, the green and water filled, the plots, houses and buildings by layer.
// `node scripts/plan-dxf.mjs [outDir]`.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(appDir, 'prebuilt', 'dxf'));
const tool = path.resolve(appDir, '..', 'tools', 'export', 'clean_dxf.py');
const vite = await createServer({ root: appDir, server: { middlewareMode: true, watch: null }, appType: 'custom', logLevel: 'error' });
try {
  const { nodeSource } = await vite.ssrLoadModule('/src/engine/data/nodeSource.ts');
  const { loadSite } = await vite.ssrLoadModule('/src/engine/site/loadSite.ts');
  const { PRESENT_PLAN_OPTIONS, decodePlan } = await vite.ssrLoadModule('/src/engine/present/prebuilt.ts');
  const { draftZonesFor } = await vite.ssrLoadModule('/src/engine/pipeline/basis.ts');
  const site = await loadSite(nodeSource(path.join(appDir, 'public', 'data')));
  await mkdir(outDir, { recursive: true });
  for (const o of PRESENT_PLAN_OPTIONS) {
    const plan = decodePlan(JSON.parse(await readFile(path.join(appDir, 'prebuilt', 'plans', `${o.id}.json`), 'utf8')));
    const zones = draftZonesFor(site, o.zoning, o.roads);
    const data = {
      title: `${o.id} ${o.label} · ${plan.plots.length} villas · local metres (site_origin.json)`,
      parcel: site.parcel,
      existing: site.features.filter((f) => f.layer === 'RD').flatMap((f) => f.lines),
      zones: zones.map((z) => ({ name: z.name, use: z.use ?? 'park', green: z.green ?? null, water: !!z.water, within: z.within ?? null, geom: z.geom })),
      roads: plan.roads.map((r) => ({ tier: r.tier, width: r.widthM, centreline: r.centreline, geom: r.geom })),
      plots: plan.plots.map((q) => ({ ring: q.ring, house: q.groundFloor ?? null })),
      buildings: plan.buildings.map((b) => ({ ring: b.ring, typology: b.typology, id: b.id, floors: b.floors, units: b.units ?? 0 })),
    };
    const tmp = path.join(os.tmpdir(), `plan-dxf-${o.id}.json`);
    await writeFile(tmp, JSON.stringify(data));
    const file = path.join(outDir, `${o.id}.dxf`);
    execFileSync('python', [tool, tmp, file], { stdio: 'inherit' });
    await rm(tmp, { force: true });
    console.log(`plan-dxf: ${o.id} ${plan.plots.length} villas -> ${path.relative(process.cwd(), file)}`);
  }
} finally {
  await vite.close();
}
