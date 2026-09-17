/**
 * Node-only asset source, used by the engine tests. Kept out of the app bundle
 * by never importing it from UI code.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetSource } from './source';

export function nodeSource(dir?: string): AssetSource {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = dir ?? path.resolve(here, '../../../public/data');
  const read = (rel: string): Promise<Buffer> => readFile(path.join(base, rel));
  return {
    text: async (rel) => (await read(rel)).toString('utf8'),
    json: async <T,>(rel: string) => JSON.parse((await read(rel)).toString('utf8')) as T,
    binary: async (rel) => {
      const buf = await read(rel);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}

/** Repository root source, for tests that need data/raw as well. */
export function repoSource(): AssetSource {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return nodeSource(path.resolve(here, '../../../..'));
}
