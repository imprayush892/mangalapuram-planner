/// <reference lib="webworker" />
import { ModelCore } from './modelCore';

// The live model off the page (owner 12 Oct): one message in, one out, in order.
const core = new ModelCore();
self.onmessage = (e: MessageEvent<{ id: number; method: keyof ModelCore; args: unknown[] }>) => {
  const { id, method, args } = e.data;
  try {
    const fn = core[method] as unknown as (...a: unknown[]) => unknown;
    const result = fn.apply(core, args);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
