// Writes the analysis layers (steps 1-7) as raw masks, for the Python tools that
// draw on them (tools/zoning). `node scripts/export-layers.mjs <out dir>`.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(appDir, '..', 'tools', 'zoning', 'layers'));
const vite = await createServer({ root: appDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { nodeSource } = await vite.ssrLoadModule('/src/engine/data/nodeSource.ts');
  const { loadSite } = await vite.ssrLoadModule('/src/engine/site/loadSite.ts');
  const { loadConfig } = await vite.ssrLoadModule('/src/engine/data/config.ts');
  const { runAnalysis } = await vite.ssrLoadModule('/src/engine/pipeline/analysis.ts');
  const src = nodeSource(path.join(appDir, 'public', 'data'));
  const [s, c] = await Promise.all([loadSite(src), loadConfig(src)]);
  const a = runAnalysis({ dem: s.dem, parcel: s.parcel, features: s.features, measured: s.measured, surveySlopeDeg: s.surveySlopeDeg, planning: c.planning, assumptions: c.assumptions, client: c.client, kmbr: c.kmbr });
  await mkdir(out, { recursive: true });
  const areas = {};
  for (const [id, l] of Object.entries(a.layers)) {
    await writeFile(path.join(out, `layer_${id}.u8`), Buffer.from(l.mask.buffer, l.mask.byteOffset, l.mask.byteLength));
    areas[id] = { areaM2: l.areaM2, share: l.share };
  }
  await writeFile(path.join(out, 'gradient.f32'), Buffer.from(a.gradient.buffer, a.gradient.byteOffset, a.gradient.byteLength));
  await writeFile(path.join(out, 'areas.json'), JSON.stringify({ parcelAreaM2: a.parcelAreaM2, areas }, null, 1));
  console.log(`export-layers: ${Object.keys(areas).length} layers -> ${path.relative(process.cwd(), out)}`);
} finally {
  await vite.close();
}
