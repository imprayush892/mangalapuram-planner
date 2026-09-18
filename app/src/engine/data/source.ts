/**
 * Asset access is abstracted so the engine modules are identical in the browser
 * (fetch from /data) and in Vitest (read from app/public/data on disk).
 */
export interface AssetSource {
  text(relPath: string): Promise<string>;
  json<T>(relPath: string): Promise<T>;
  binary(relPath: string): Promise<ArrayBuffer>;
}

function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
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
    /**
     * Some static hosts refuse to serve an extension they do not recognise, and
     * `.f32` is one of those. Where the raw grid is missing, a base64 sibling
     * written by the deploy step stands in for it: same bytes, a served name.
     */
    binary: async (rel) => {
      try {
        return await (await get(rel)).arrayBuffer();
      } catch (err) {
        const res = await fetch(url(`${rel}.txt`));
        if (!res.ok) throw err;
        return decodeBase64(await res.text());
      }
    },
  };
}
