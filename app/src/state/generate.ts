import { useLayout } from './layoutStore';
import { dataBaseUrl } from './appBase';
import { useMasterPlan } from './masterPlanStore';
import type { GenerateRequest, GenerateResponse, MasterPlanRequest, PipelineRequest } from '../engine/runGeneration';
import { usePlanning } from './planningStore';
import { usePresent } from './presentStore';
import { fetchSource } from '../engine/data/source';
import { PRESENT_PLAN_OPTIONS, loadPrebuiltPlans } from '../engine/present/prebuilt';
import type { PresentOptionId } from '../engine/present/prebuilt';
import type { PlanResult } from '../engine/pipeline/plan';
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
    if (msg.status === 'plan' || msg.status === 'zone' || msg.status === 'pipeline') return; // other runs, handled elsewhere
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

/**
 * Runs the whole master plan: every zone, then the roads between them. Uses the
 * same worker as a single zone, with the same main-thread fallback, so a host
 * that blocks workers still produces a plan — it just pauses the tab while it
 * does.
 */
export function runMasterPlanGeneration(
  overrides: MasterPlanRequest['overrides'],
  options: MasterPlanRequest['options'],
  zoneEdits: MasterPlanRequest['zoneEdits'] = [],
): void {
  const { setPlan, setStatus } = useMasterPlan.getState();
  const id = nextId++;
  const started = Date.now();
  const full: MasterPlanRequest = { job: 'masterplan', id, baseUrl: dataBaseUrl(), overrides, options, zoneEdits };

  useMasterPlan.getState().startRun();
  setStatus({ running: true, message: 'starting…', done: 0, total: 0, elapsedMs: 0, error: null });

  const fail = (error: string): void => {
    setStatus({ running: false, message: '', error, elapsedMs: Date.now() - started });
  };

  const w = ensureWorker();

  if (!w) {
    setStatus({ message: 'generating on the main thread (this tab will pause)' });
    setTimeout(() => {
      void import('../engine/runGeneration')
        .then(({ runMasterPlanJob }) =>
          runMasterPlanJob(
            full,
            (message, done, total) => setStatus({ message, done, total }),
            (zone) => useMasterPlan.getState().pushZone(zone),
          ),
        )
        .then((plan) => setPlan(plan))
        .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    }, 50);
    return;
  }

  const onMessage = (event: MessageEvent<GenerateResponse>): void => {
    const msg = event.data;
    if (msg.id !== id) return;
    if (msg.status === 'progress') {
      setStatus({
        message: msg.message,
        done: msg.done ?? 0,
        total: msg.total ?? 0,
        elapsedMs: Date.now() - started,
      });
      return;
    }
    if (msg.status === 'zone') {
      // Each zone lands as it finishes, so the plan draws itself.
      useMasterPlan.getState().pushZone(msg.zone);
      return;
    }
    w.removeEventListener('message', onMessage);
    if (msg.status === 'error') fail(msg.error);
    else if (msg.status === 'plan') setPlan(msg.plan);
  };

  const onError = (): void => {
    w.removeEventListener('message', onMessage);
    workerBlocked = true;
    worker = null;
    runMasterPlanGeneration(overrides, options, zoneEdits);
  };

  w.addEventListener('message', onMessage);
  w.addEventListener('error', onError, { once: true });
  w.postMessage(full);
}

/**
 * Runs the planning pipeline (steps 1-16) on the rules as they stand. A newer
 * run supersedes an older one: its reply is dropped. Same worker, same
 * main-thread fallback as the generators.
 */
let latestPipeline = 0;
let prebuilt: Promise<Partial<Record<PresentOptionId, PlanResult>>> | null = null;
export function runPipeline(overrides: PipelineRequest['overrides']): void {
  const { setPlanStatus, setPlanResult } = usePlanning.getState();
  const id = nextId++;
  latestPipeline = id;
  const started = Date.now();
  const full: PipelineRequest = { job: 'pipeline', id, baseUrl: dataBaseUrl(), overrides };
  setPlanStatus({ running: true, message: 'starting…', error: null });

  // The rules as written, one of the six master plans: a hosted copy ships it ready-made.
  const onlyOptions = Object.entries(overrides).every(([doc, o]) =>
    Object.keys(o ?? {}).every((k) => doc === 'planning' && k.startsWith('options.')),
  );
  if (onlyOptions) {
    const sizing = (overrides.planning?.['options.villa_sizing'] as string | undefined) ?? 'A';
    const roads = (overrides.planning?.['options.road_orientation'] as string | undefined) ?? 'terrain';
    const zoning = (overrides.planning?.['options.draft_zoning'] as string | undefined) ?? 'model';
    const opt = PRESENT_PLAN_OPTIONS.find((o) => o.sizing === sizing && o.roads === roads && o.zoning === zoning)?.id;
    prebuilt ??= loadPrebuiltPlans(fetchSource(dataBaseUrl()));
    void prebuilt.then((plans) => {
      if (id !== latestPipeline) return;
      const plan = opt ? plans[opt] : undefined;
      if (plan) {
        if (usePresent.getState().active) usePresent.getState().stash(plan);
        else setPlanResult(plan, Date.now() - started);
      } else runPipelineLive(full, id, started);
    });
    return;
  }
  runPipelineLive(full, id, started);
}

function runPipelineLive(full: PipelineRequest, id: number, started: number): void {
  const { setPlanStatus, setPlanResult } = usePlanning.getState();

  const fail = (error: string): void => {
    if (id !== latestPipeline) return;
    setPlanStatus({ running: false, message: '', error });
  };

  const w = ensureWorker();
  if (!w) {
    setPlanStatus({ running: true, message: 'planning on the main thread (this tab will pause)', error: null });
    setTimeout(() => {
      void import('../engine/runGeneration')
        .then(({ runPipelineJob }) => runPipelineJob(full, (message) => setPlanStatus({ running: true, message, error: null })))
        .then(({ plan }) => {
          if (id !== latestPipeline) return;
          if (usePresent.getState().active) usePresent.getState().stash(plan);
          else setPlanResult(plan, Date.now() - started);
        })
        .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    }, 50);
    return;
  }

  const onMessage = (event: MessageEvent<GenerateResponse>): void => {
    const msg = event.data;
    if (msg.id !== id) return;
    if (msg.status === 'progress') {
      if (id === latestPipeline) setPlanStatus({ running: true, message: msg.message, error: null });
      return;
    }
    w.removeEventListener('message', onMessage);
    if (msg.status === 'error') fail(msg.error);
    else if (msg.status === 'pipeline' && id === latestPipeline) {
      // While presenting, the views show the presentation's plans; this one waits.
      if (usePresent.getState().active) usePresent.getState().stash(msg.plan);
      else setPlanResult(msg.plan, msg.elapsedMs);
    }
  };
  const onError = (): void => {
    w.removeEventListener('message', onMessage);
    workerBlocked = true;
    worker = null;
    runPipelineLive(full, id, started);
  };
  w.addEventListener('message', onMessage);
  w.addEventListener('error', onError, { once: true });
  w.postMessage(full);
}
