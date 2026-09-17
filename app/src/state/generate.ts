import { useLayout } from './layoutStore';
import type { GenerateRequest, GenerateResponse } from '../workers/generate.worker';

let worker: Worker | null = null;
let nextId = 1;

function ensureWorker(): Worker {
  worker ??= new Worker(new URL('../workers/generate.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/**
 * Runs one generation in the worker and files the result in the layout store.
 * A newer request supersedes an older one: late replies are dropped.
 */
export function runGenerate(request: Omit<GenerateRequest, 'id' | 'baseUrl'>): void {
  const { setStatus, setOptions } = useLayout.getState();
  const id = nextId++;
  const w = ensureWorker();
  const started = Date.now();

  setStatus({ running: true, zoneId: request.zoneId, message: 'starting…', elapsedMs: 0, error: null });

  const onMessage = (event: MessageEvent<GenerateResponse>): void => {
    const msg = event.data;
    if (msg.id !== id) return;
    if (msg.status === 'progress') {
      setStatus({ message: msg.message, elapsedMs: Date.now() - started });
      return;
    }
    w.removeEventListener('message', onMessage);
    if (msg.status === 'error') {
      setStatus({ running: false, message: '', error: msg.error, elapsedMs: Date.now() - started });
      return;
    }
    setOptions(request.zoneId, msg.options);
    setStatus({
      running: false,
      message: `${msg.options.length} option${msg.options.length === 1 ? '' : 's'} in ${(msg.elapsedMs / 1000).toFixed(1)} s`,
      elapsedMs: msg.elapsedMs,
      error: msg.options.length === 0 ? 'No option could be generated for this zone.' : null,
    });
  };

  w.addEventListener('message', onMessage);
  // Resolved here, on the main thread: the worker bundle lives under /assets,
  // so a relative base URL would resolve against the wrong directory there.
  const baseUrl = new URL(`${import.meta.env.BASE_URL}data`, window.location.href).href;
  w.postMessage({ ...request, id, baseUrl } satisfies GenerateRequest);
}
