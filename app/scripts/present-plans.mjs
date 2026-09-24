// Works out the four master plans the presentation forks into (A1, A2, B1, B2)
// and writes them to dist/data/plans, each with a fingerprint of the rules and
// the site. A hosted copy then loads them instead of planning in the viewer's
// browser (the two sized to the count take a minute each). Run after
// `npm run build`; part of `npm run build:deploy`.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = process.argv[2] ?? path.join(appDir, 'dist');
const dataDir = path.join(distDir, 'data');

const vite = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { nodeSource } = await vite.ssrLoadModule('/src/engine/data/nodeSource.ts');
  const { runPipelineJob } = await vite.ssrLoadModule('/src/engine/runGeneration.ts');
  const { EMPTY_OVERRIDES } = await vite.ssrLoadModule('/src/engine/data/overrides.ts');
  const { PRESENT_PLAN_OPTIONS, dataFingerprint, encodePlan } = await vite.ssrLoadModule('/src/engine/present/prebuilt.ts');
  const src = nodeSource(dataDir);
  const fingerprint = await dataFingerprint(src);
  await mkdir(path.join(dataDir, 'plans'), { recursive: true });
  for (const o of PRESENT_PLAN_OPTIONS) {
    const t0 = Date.now();
    const overrides = {
      ...EMPTY_OVERRIDES,
      planning: { 'options.villa_sizing': o.sizing, 'options.road_orientation': o.roads },
    };
    const { plan } = await runPipelineJob({ job: 'pipeline', id: 0, baseUrl: '', overrides }, () => {}, src);
    const file = path.join(dataDir, 'plans', `${o.id}.json`);
    await writeFile(file, JSON.stringify(encodePlan(plan, o.id, fingerprint)));
    console.log(`present-plans: ${o.id} ${plan.plots.length} villas, ${Math.round((Date.now() - t0) / 1000)} s -> ${path.relative(appDir, file)}`);
  }
  console.log(`present-plans: fingerprint ${fingerprint}`);
} finally {
  await vite.close();
}
