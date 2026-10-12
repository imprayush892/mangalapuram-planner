import { create } from 'zustand';
import type { RawCellContent } from 'hyperformula';
import { ModelCore } from '../engine/finance/modelCore';
import type { Edits, SheetMeta, SheetView } from '../engine/finance/modelCore';
import { KEYS, optionInputs } from '../engine/finance/optionRun';
import type { CaseResult } from '../engine/finance/optionRun';
import type { PlanResult } from '../engine/pipeline/plan';
import { PRESENT_PLAN_OPTIONS } from '../engine/present/prebuilt';
import { dataBaseUrl } from './appBase';
import { usePresent } from './presentStore';

/**
 * The owner's draft financial model, live (owner 12 Oct): the workbook (data/model/draft_model.xlsx.txt, base64,
 * copied in by sync-data from the owner's file) recalculated in the browser. Edits to any cell are kept in this
 * browser and run through every option; the presentation's financial figures are this run's.
 */

type Call = <T>(method: keyof ModelCore, ...args: unknown[]) => Promise<T>;

function onPage(): Call {
  const core = new ModelCore();
  return async <T,>(method: keyof ModelCore, ...args: unknown[]) => (core[method] as unknown as (...a: unknown[]) => T).apply(core, args);
}

function host(): Call {
  try {
    const w = new Worker(new URL('../engine/finance/model.worker.ts', import.meta.url), { type: 'module' });
    let next = 0;
    const waiting = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
    w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!p) return;
      if (e.data.error) p.no(new Error(e.data.error));
      else p.ok(e.data.result);
    };
    return <T,>(method: keyof ModelCore, ...args: unknown[]) =>
      new Promise<T>((ok, no) => {
        const id = (next += 1);
        waiting.set(id, { ok: ok as (v: unknown) => void, no });
        w.postMessage({ id, method, args });
      });
  } catch {
    return onPage(); // no worker on this host: on the page
  }
}

const STORE_KEY = 'mangalapuram.modelEdits.v1';
const loadEdits = (): Edits => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Edits;
  } catch {
    return {};
  }
};
const saveEdits = (e: Edits): void => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(e));
  } catch {
    /* private window: edits last this visit */
  }
};

export interface LiveCase extends CaseResult {
  label: string;
  inputs: Record<string, RawCellContent>;
  [k: string]: unknown;
}

interface ModelState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  sheets: SheetMeta[];
  edits: Edits;
  running: boolean;
  /** The model as given (with the edits) and each option's run. */
  cases: Record<string, LiveCase>;
  open: boolean;
  setOpen: (on: boolean) => void;
  load: () => Promise<void>;
  edit: (key: string, value: RawCellContent | null) => Promise<void>;
  resetEdits: () => Promise<void>;
  view: (sheet: string, option: string | null) => Promise<SheetView>;
  download: (option: string | null) => Promise<void>;
}

let call: Call | null = null;
let workbookBuf: ArrayBuffer | null = null;
let runToken = 0;

async function runAll(): Promise<void> {
  if (!call) return;
  const my = (runToken += 1);
  useModel.setState({ running: true });
  const plans = usePresent.getState().plans as Partial<Record<string, PlanResult>>;
  const cases: Record<string, LiveCase> = {};
  const base = await call<CaseResult>('run', {});
  cases.model = { label: 'Draft model as given', ...base };
  for (const o of PRESENT_PLAN_OPTIONS) {
    const plan = plans[o.id];
    if (!plan) continue;
    const { inputs, meta } = optionInputs(plan);
    const r = await call<CaseResult>('run', inputs); // r.inputs: as set, the earthwork expanded
    cases[o.id] = { label: o.label, ...meta, ...r };
    if (my !== runToken) return;
  }
  if (my === runToken) useModel.setState({ cases, running: false });
}

export const useModel = create<ModelState>((set, get) => ({
  status: 'idle',
  sheets: [],
  edits: loadEdits(),
  running: false,
  cases: {},
  open: false,
  setOpen: (on) => set({ open: on }),
  load: async () => {
    if (get().status !== 'idle') return;
    set({ status: 'loading' });
    try {
      const b64 = await (await fetch(`${dataBaseUrl()}/model/draft_model.xlsx.txt`)).text();
      const bin = atob(b64.trim());
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      workbookBuf = bytes.buffer;
      // In a worker; on the page where the host starts none, or one that does not answer within 10 s
      call = host();
      let sheets: SheetMeta[];
      try {
        sheets = await Promise.race([
          call<SheetMeta[]>('init', workbookBuf.slice(0)),
          new Promise<never>((_, no) => setTimeout(() => no(new Error('worker silent')), 10000)),
        ]);
      } catch {
        call = onPage();
        sheets = await call<SheetMeta[]>('init', workbookBuf.slice(0));
      }
      await call('setEdits', get().edits);
      set({ status: 'ready', sheets });
      await runAll();
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },
  edit: async (key, value) => {
    const edits = { ...get().edits };
    if (value === null) delete edits[key];
    else edits[key] = value;
    set({ edits });
    saveEdits(edits);
    await call?.('setEdits', edits);
    await runAll();
  },
  resetEdits: async () => {
    set({ edits: {} });
    saveEdits({});
    await call?.('setEdits', {});
    await runAll();
  },
  view: async (sheet, option) => {
    const inputs = option ? (get().cases[option]?.inputs as Record<string, RawCellContent> | undefined) : undefined;
    return (await call!<SheetView>('view', sheet, inputs)) as SheetView;
  },
  download: async (option) => {
    if (!workbookBuf || !call) return;
    const inputs = option ? (get().cases[option]?.inputs as Record<string, RawCellContent> | undefined) : undefined;
    const out = await call<Uint8Array>('exportXlsx', workbookBuf.slice(0), inputs);
    const url = URL.createObjectURL(new Blob([out as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `Draft model${option ? ` - ${option} masterplan` : ''}${Object.keys(get().edits).length ? ' (edited)' : ''}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
}));

// A new plan in the presentation (they load one by one): run the model on it.
usePresent.subscribe((st, prev) => {
  if (st.plans !== prev.plans && useModel.getState().status === 'ready') void runAll();
});

/** The financial figures the presentation shows: the live run where it is ready, else the precomputed one. */
export function liveFinancials(fallback: unknown): unknown {
  const { cases, status } = useModel.getState();
  if (status !== 'ready' || !cases.model) return fallback;
  return {
    source: 'Draft model.xlsx, live in the app (with any edits made in the Model tab)',
    metrics: KEYS.map(([key, label, cell, unit, better]) => ({ key, label, cell, unit, better })),
    cases,
  };
}

export function useLiveFinancials(fallback: unknown): unknown {
  useModel((s) => s.cases);
  useModel((s) => s.status);
  return liveFinancials(fallback);
}

if (import.meta.env.DEV) (globalThis as unknown as { __model: typeof useModel }).__model = useModel;
