import { useLayout } from './layoutStore';
import { dataBaseUrl } from './appBase';
import type { GenerateRequest, GenerateResponse } from '../engine/runGeneration';
import type { LayoutOption } from '../engine/generators/types';

let worker: Worker | null = null;
let workerBlocked = false;
let nextId = 1;

/**
 * Returns the worker, or null where the host will not start one — a sandboxed
 * iframe, a file:// page, or a browser with module workers disabled. The engine
 * then runs on the main thread instead: slower to the point of a visible pause,
 * but the same result rather than a dead button.
 */
function ensureWorker(): Worker | null {
  if (workerBlocked) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/generate.worker.ts', import.meta.url), { type: 'module' });
    return worker;
  } catch {
    workerBlocked = true;
    return null;
  }
}


/**
 * Runs one generation and files the result in the layout store. A newer request
 * supersedes an older one: late replies are dropped.
 */
export function runGenerate(request: Omit<GenerateRequest, 'id' | 'baseUrl'>): void {
  const { setStatus, setOptions } = useLayout.getState();
  const id = nextId++;
  const started = Date.now();
  const full: GenerateRequest = { ...request, id, baseUrl: dataBaseUrl() };

  setStatus({ running: true, zoneId: request.zoneId, message: 'starting…', elapsedMs: 0, error: null });

  const finish = (options: LayoutOption[], elapsedMs: number): void => {
    setOptions(request.zoneId, options);
    setStatus({
      running: false,
      message: `${options.length} option${options.length === 1 ? '' : 's'} in ${(elapsedMs / 1000).toFixed(1)} s`,
      elapsedMs,
      error: options.length === 0 ? 'No option could be generated for this zone.' : null,
    });
  };

  const fail = (error: string): void => {
    setStatus({ running: false, message: '', error, elapsedMs: Date.now() - started });
  };

  const w = ensureWorker();

  if (!w) {
    // No worker: run on the main thread. The yield lets the "generating…"
    // message paint before the engine locks the thread.
    setStatus({ message: 'generating on the main thread (this tab will pause)' });
    setTimeout(() => {
      void import('../engine/runGeneration')
        .then(({ runGeneration }) => runGeneration(full, (message) => setStatus({ message })))
        .then((options) => finish(options, Date.now() - started))
        .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    }, 50);
    return;
  }

  const onMessage = (event: MessageEvent<GenerateResponse>): void => {
    const msg = event.data;
    if (msg.id !== id) return;
    if (msg.status === 'progress') {
      setStatus({ message: msg.message, elapsedMs: Date.now() - started });
      return;
    }
    w.removeEventListener('message', onMessage);
    if (msg.status === 'error') fail(msg.error);
    else finish(msg.options, msg.elapsedMs);
  };

  // A worker that fails after construction (a blocked module import, say) would
  // otherwise leave the button spinning for good.
  const onError = (): void => {
    w.removeEventListener('message', onMessage);
    workerBlocked = true;
    worker = null;
    runGenerate(request);
  };

  w.addEventListener('message', onMessage);
  w.addEventListener('error', onError, { once: true });
  w.postMessage(full);
}
