/// <reference lib="webworker" />
import { runGeneration, runMasterPlanJob } from '../engine/runGeneration';
import type { GenerateResponse, WorkerRequest } from '../engine/runGeneration';

/**
 * The generators run here so a regeneration never blocks the plan view. All the
 * work itself lives in engine/runGeneration, which the main thread also calls
 * when a host will not start a worker.
 */

const post = (message: GenerateResponse): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const started = Date.now();
  try {
    if (req.job === 'masterplan') {
      const plan = await runMasterPlanJob(
        req,
        (message, done, total) => post({ id: req.id, status: 'progress', message, done, total }),
        (zone) => post({ id: req.id, status: 'zone', zone }),
      );
      post({ id: req.id, status: 'plan', plan, elapsedMs: Date.now() - started });
      return;
    }
    const options = await runGeneration(req, (message) =>
      post({ id: req.id, status: 'progress', message }),
    );
    post({ id: req.id, status: 'done', options, elapsedMs: Date.now() - started });
  } catch (err) {
    post({ id: req.id, status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
