// Writes a base64 `.txt` sibling for every binary asset whose own extension a
// static host may refuse to serve. `fetchSource` falls back to it. Run after
// `npm run build`, against `dist`.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY_EXTENSIONS = ['.f32'];
const distDir = process.argv[2]
  ?? path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'dist');

const manifest = JSON.parse(await readFile(path.join(distDir, 'data/manifest.json'), 'utf8'));
let written = 0;
for (const [group, files] of Object.entries(manifest.files)) {
  for (const name of files) {
    if (!BINARY_EXTENSIONS.includes(path.extname(name))) continue;
    const file = path.join(distDir, 'data', group, name);
    await writeFile(`${file}.txt`, (await readFile(file)).toString('base64'));
    written += 1;
  }
}
console.log(`base64-assets: ${written} file(s) in ${path.relative(process.cwd(), distDir)}`);
