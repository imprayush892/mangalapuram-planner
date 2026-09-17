/**
 * Asset access is abstracted so the engine modules are identical in the browser
 * (fetch from /data) and in Vitest (read from app/public/data on disk).
 */
export interface AssetSource {
  text(relPath: string): Promise<string>;
  json<T>(relPath: string): Promise<T>;
  binary(relPath: string): Promise<ArrayBuffer>;
}

export function fetchSource(baseUrl: string): AssetSource {
  const url = (rel: string): string => `${baseUrl.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
  const get = async (rel: string): Promise<Response> => {
    const res = await fetch(url(rel));
    if (!res.ok) throw new Error(`asset ${rel}: HTTP ${res.status}`);
    return res;
  };
  return {
    text: async (rel) => (await get(rel)).text(),
    json: async <T,>(rel: string) => (await get(rel)).json() as Promise<T>,
    binary: async (rel) => (await get(rel)).arrayBuffer(),
  };
}
