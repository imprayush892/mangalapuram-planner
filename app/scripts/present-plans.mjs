// Works out the master plans the panel and the presentation offer (A1-C2) and
// writes them, each with a fingerprint of the rules and the site, to
// app/prebuilt/plans (the dev server serves them: sync-data copies them into
// public/data/plans) and, after a build, to dist/data/plans. The app loads a
// plan from there instead of planning it in the browser (the B3/B4 plans take
// over a minute each), and only while its fingerprint matches the data.
// `npm run plans`; part of `npm run build:deploy`.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The data the app serves; sync-data writes it from the repository's data and config.
const dataDir = path.join(appDir, 'public', 'data');
const outDirs = [path.join(appDir, 'prebuilt', 'plans')];
if (existsSync(path.join(appDir, 'dist', 'data'))) outDirs.push(path.join(appDir, 'dist', 'data', 'plans'));
if (existsSync(path.join(dataDir, 'plans'))) outDirs.push(path.join(dataDir, 'plans'));

const vite = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { nodeSource } = await vite.ssrLoadModule('/src/engine/data/nodeSource.ts');
  const { runPipelineJob } = await vite.ssrLoadModule('/src/engine/runGeneration.ts');
  const { EMPTY_OVERRIDES } = await vite.ssrLoadModule('/src/engine/data/overrides.ts');
  const { PRESENT_PLAN_OPTIONS, dataFingerprint, encodePlan } = await vite.ssrLoadModule('/src/engine/present/prebuilt.ts');
  const src = nodeSource(dataDir);
  const fingerprint = await dataFingerprint(src);
  for (const d of outDirs) await mkdir(d, { recursive: true });
  for (const o of PRESENT_PLAN_OPTIONS) {
    const t0 = Date.now();
    const overrides = {
      ...EMPTY_OVERRIDES,
      planning: { 'options.villa_sizing': o.sizing, 'options.road_orientation': o.roads },
    };
    const { plan } = await runPipelineJob({ job: 'pipeline', id: 0, baseUrl: '', overrides }, () => {}, src);
    const file = path.join(outDirs[0], `${o.id}.json`);
    await writeFile(file, JSON.stringify(encodePlan(plan, o.id, fingerprint)));
    for (const d of outDirs.slice(1)) await copyFile(file, path.join(d, `${o.id}.json`));
    console.log(`present-plans: ${o.id} ${plan.plots.length} villas, ${Math.round((Date.now() - t0) / 1000)} s -> ${outDirs.map((d) => path.relative(appDir, d)).join(', ')}`);
  }
  console.log(`present-plans: fingerprint ${fingerprint}`);
} finally {
  await vite.close();
}
