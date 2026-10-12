import { create } from 'zustand';
import { useSite } from './store';
import type { LayerFlags, RasterMode } from './store';
import { usePlanning } from './planningStore';
import type { PlanLayer } from './planningStore';
import { useSettings } from './settingsStore';
import { dataBaseUrl } from './appBase';
import type { LayerId } from '../engine/pipeline/analysis';
import type { BuildingUse, PlanResult } from '../engine/pipeline/plan';
import type { GenerateResponse, PipelineRequest } from '../engine/runGeneration';
import type { OverrideSet } from '../engine/data/overrides';
import { fetchSource } from '../engine/data/source';
import { PRESENT_PLAN_OPTIONS, loadPrebuiltPlans, optionOverrides } from '../engine/present/prebuilt';
import { pointInMulti } from '../engine/geom/planar';
import { draftZonesFor } from '../engine/pipeline/basis';
import type { PresentOptionId } from '../engine/present/prebuilt';

/**
 * Presentation mode: the planning pipeline revealed one step at a time on the
 * 2D plan and the 3D terrain, each step adding to the last. At the plots the
 * plan forks into the six master plans; from there on any of them can be
 * shown. Every step only switches what the views already draw.
 */

export type OptionId = PresentOptionId;

export const PRESENT_OPTIONS = PRESENT_PLAN_OPTIONS;

export interface PresentStep {
  key: string;
  /** The pipeline step it shows (PIPELINE.md). */
  num: string;
  title: string;
  /** Analysis layers (steps 1-7) drawn. */
  layers: LayerId[];
  raster: RasterMode;
  /** The client's zoning: off, outlined, or filled and labelled. */
  zones: 'off' | 'filled';
  /** What of the plan is drawn; none before the roads. */
  plan: PlanLayer[];
  /** Building masses shown: none, some uses, or all. */
  uses: BuildingUse[] | 'all' | 'none';
  /** Villa masses on their plots. */
  villas: boolean;
  /** The six master plans part here. */
  fork?: boolean;
  /** The draft model's One-Page Summary figures shown over the plan (ui/PresentFigures.tsx). */
  card?: 'land' | 'tickets' | 'funding';
  /** The plan built up to this phase (owner 7 Oct: the master plan develops phase by phase). */
  phase?: number;
}

export const PRESENT_STEPS: PresentStep[] = [
  {
    key: 'terrain',
    num: '1',
    title: 'Terrain',
    layers: [],
    raster: 'rl',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'water',
    num: '2',
    title: 'The planning storm',
    layers: ['flowPaths'],
    raster: 'hydrology',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'waterlogging',
    num: '3',
    title: 'Waterlogging',
    layers: ['flowPaths', 'waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'public',
    num: '4',
    title: 'Public space',
    layers: ['waterlogging', 'publicSpace'],
    raster: 'none',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'slope',
    num: '5',
    title: 'Slope',
    layers: ['waterlogging', 'moderateSlope'],
    raster: 'slope',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'nonbuildable',
    num: '6',
    title: 'Non-buildable land',
    layers: ['waterlogging', 'nonBuildable', 'drains'],
    raster: 'none',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'plotable',
    num: '7',
    title: 'Land that can take plots',
    layers: ['waterlogging', 'drains', 'plotable'],
    raster: 'none',
    zones: 'off',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'zoning',
    num: '0',
    title: 'The zoning, optimised',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'filled',
    plan: [],
    uses: 'none',
    villas: false,
  },
  {
    key: 'roads',
    num: '8',
    title: 'Roads',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads'],
    uses: 'none',
    villas: false,
  },
  {
    key: 'plots',
    num: '9',
    title: 'Villa plots: six master plans',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'plots'],
    uses: 'none',
    villas: false,
    fork: true,
  },
  {
    key: 'earthwork',
    num: '10–11',
    title: 'Plot slope, cut and fill',
    layers: [],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'plots', 'earthwork'],
    uses: 'none',
    villas: false,
  },
  {
    key: 'typologies',
    num: '12',
    title: 'Uses and the green',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots'],
    uses: 'none',
    villas: false,
  },
  {
    key: 'towers',
    num: '13',
    title: 'Towers under the airport line',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: ['apartments'],
    villas: false,
  },
  {
    key: 'placement',
    num: '14',
    title: 'School, clubhouse, senior living, commercial',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: false,
  },
  {
    key: 'massing',
    num: '15',
    title: 'The villas in 3D',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
  },
  // Built phase by phase, outward from the gate (owner 7 Oct): each step adds a phase's roads, plots and buildings.
  ...[1, 2, 3].map(
    (n): PresentStep => ({
      key: `phase-${n}`,
      num: `P${n}`,
      title: n === 1 ? 'Phase 1, by the gate' : `Phases 1–${n}`,
      layers: ['waterlogging'],
      raster: 'none',
      zones: 'off',
      plan: ['roads', 'blocks', 'plots', 'buildings'],
      uses: 'all',
      villas: true,
      phase: n,
    }),
  ),
  {
    key: 'masterplan',
    num: '16',
    title: 'Phase 4: the master plan',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
  },
  // The draft model's figures over the finished plan (owner 7 Oct): One-Page Summary A, E and B.
  {
    key: 'figures-land',
    num: 'A',
    title: 'Land by product type',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
    card: 'land',
  },
  {
    key: 'figures-tickets',
    num: 'E',
    title: 'Homes, sizes and ticket prices',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
    card: 'tickets',
  },
  {
    key: 'figures-funding',
    num: 'B',
    title: 'Funding and key assumptions',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
    card: 'funding',
  },
];

export const FORK_STEP = PRESENT_STEPS.findIndex((s) => s.fork);

interface Saved {
  visible: LayerId[];
  planVisible: PlanLayer[];
  plan: PlanResult | null;
  villaMasses: boolean;
  viewMode: '2d' | '3d';
  raster: RasterMode;
  layers: LayerFlags;
}

interface PresentState {
  active: boolean;
  step: number;
  option: OptionId;
  plans: Partial<Record<OptionId, PlanResult>>;
  /** What each option's plan is doing while it is prepared; absent once ready. */
  prep: Partial<Record<OptionId, string>>;
  errors: Partial<Record<OptionId, string>>;
  saved: Saved | null;
  /** The figure cards over the views: on unless the presenter closes them (F, or the card's ✕). */
  cards: boolean;
  toggleCards: () => void;
  start: () => void;
  stop: () => void;
  go: (step: number) => void;
  next: () => void;
  back: () => void;
  choose: (option: OptionId) => void;
  /** A plan the normal re-plan produced while presenting: kept for when presenting ends. */
  stash: (plan: PlanResult) => void;
}

function optionOf(plan: PlanResult): OptionId {
  return PRESENT_OPTIONS.find((o) => o.sizing === plan.option.villaSizing && o.roads === plan.option.roads && o.zoning === (plan.option.zoning ?? 'model'))?.id ?? 'D1';
}

/**
 * The phase each piece of the plan is built in: a zone's own (open space comes with the first phase); a road
 * the earliest phase of the zones it runs through, or the first phase where it runs through none (the trunk).
 */
export function phaseOf(plan: PlanResult): { zone: (name: string | null) => number; road: (r: PlanResult['roads'][number]) => number } {
  const byName = new Map(plan.zones.map((z) => [z.name, Math.max(1, z.phase ?? 1)]));
  const site = useSite.getState().site;
  const drawn = site ? draftZonesFor(site, plan.option.zoning ?? 'model', plan.option.roads) : [];
  const zones = drawn.filter((z) => z.phase !== undefined && byName.has(z.name));
  const zone = (name: string | null): number => (name ? (byName.get(name) ?? 1) : 1);
  const road = (r: PlanResult['roads'][number]): number => {
    let best = Infinity;
    for (const p of r.centreline) {
      for (const z of zones) if (pointInMulti(p, z.geom)) best = Math.min(best, Math.max(1, z.phase ?? 1));
    }
    return Number.isFinite(best) ? best : 1;
  };
  return { zone, road };
}

/** Whether the plan carries phases (the draft model's zoning does; the client's does not). */
export const hasPhases = (plan: PlanResult | undefined): boolean => Boolean(plan?.zones.some((z) => (z.phase ?? 0) > 0));

/** The plan as a step shows it: only the building uses it has reached, and only up to its phase. */
function shownPlan(plan: PlanResult | undefined, step: PresentStep): PlanResult | null {
  if (!plan) return null;
  let p = plan;
  if (step.uses !== 'all') {
    const uses = step.uses === 'none' ? [] : step.uses;
    p = { ...p, buildings: p.buildings.filter((b) => uses.includes(b.typology)) };
  }
  if (step.phase !== undefined && hasPhases(plan)) {
    const n = step.phase;
    const ph = phaseOf(plan);
    p = {
      ...p,
      roads: p.roads.filter((r) => ph.road(r) <= n),
      blocks: p.blocks.filter((b) => ph.zone(b.zone) <= n),
      plots: p.plots.filter((q) => ph.zone(q.zone) <= n),
      buildings: p.buildings.filter((b) => ph.zone(b.zone) <= n),
    };
  }
  return p;
}

function apply(): void {
  const { step, option, plans } = usePresent.getState();
  const s = PRESENT_STEPS[step]!;
  const site = useSite.getState();
  useSite.setState({
    raster: s.raster,
    layers: {
      ...site.layers,
      parcel: true,
      contours: true,
      majorContoursOnly: true,
      roads: false,
      drains: false,
      points: false,
      layout: false,
      deferredNote: false,
      zones: s.zones !== 'off',
      zoneLabels: s.zones === 'filled',
    },
  });
  usePlanning.setState({
    visible: s.layers,
    planVisible: s.plan,
    villaMasses: s.villas,
    plan: s.plan.length > 0 ? shownPlan(plans[option], s) : null,
  });
}

let workers: Worker[] = [];
let prepId = 1_000_000;
/** Bumped when presenting ends, so a plan still being worked out lands nowhere. */
let epoch = 0;
/** Plans worked out on the main thread, one at a time, where a worker will not run. */
let mainQueue: Promise<void> = Promise.resolve();

/** Only the option switches differ from the rules as written: prebuilt plans answer them. */
function rulesAsWritten(overrides: OverrideSet): boolean {
  return Object.entries(overrides).every(([doc, o]) =>
    Object.keys(o ?? {}).every((k) => doc === 'planning' && k.startsWith('options.')),
  );
}

/**
 * The four plans: the prebuilt ones where they answer the rules as they stand
 * (a hosted copy ships them), the rest worked out in background workers, or on
 * the main thread one at a time where the host will not start a worker.
 */
async function prepare(overrides: OverrideSet): Promise<void> {
  const my = epoch;
  const setPrep = (id: OptionId, msg: string | undefined): void =>
    usePresent.setState((st) => {
      const prep = { ...st.prep };
      if (msg === undefined) delete prep[id];
      else prep[id] = msg;
      return { prep };
    });
  const done = (id: OptionId, plan: PlanResult): void => {
    if (my !== epoch) return;
    usePresent.setState((st) => ({ plans: { ...st.plans, [id]: plan } }));
    setPrep(id, undefined);
    if (usePresent.getState().active && usePresent.getState().option === id) apply();
  };
  const fail = (id: OptionId, error: string): void => {
    if (my !== epoch) return;
    usePresent.setState((st) => ({ errors: { ...st.errors, [id]: error } }));
    setPrep(id, undefined);
  };

  const missing = PRESENT_OPTIONS.filter((o) => !usePresent.getState().plans[o.id]);
  for (const o of missing) setPrep(o.id, 'loading…');
  if (rulesAsWritten(overrides)) {
    const pre = await loadPrebuiltPlans(fetchSource(dataBaseUrl()));
    if (my !== epoch) return;
    for (const o of missing) {
      const plan = pre[o.id];
      if (plan) done(o.id, plan);
    }
  }

  for (const o of PRESENT_OPTIONS) {
    if (usePresent.getState().plans[o.id]) continue;
    const req: PipelineRequest = {
      job: 'pipeline',
      id: prepId++,
      baseUrl: dataBaseUrl(),
      overrides: { ...overrides, planning: { ...overrides.planning, ...optionOverrides(o) } },
    };
    const onMain = (): void => {
      setPrep(o.id, 'queued on this page (it may pause)…');
      mainQueue = mainQueue.then(async () => {
        if (my !== epoch) return;
        try {
          const { runPipelineJob } = await import('../engine/runGeneration');
          const { plan } = await runPipelineJob(req, (m) => setPrep(o.id, m));
          done(o.id, plan);
        } catch (e) {
          fail(o.id, e instanceof Error ? e.message : String(e));
        }
      });
    };
    setPrep(o.id, 'starting…');
    let worker: Worker;
    try {
      worker = new Worker(new URL('../workers/generate.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      onMain();
      continue;
    }
    workers.push(worker);
    const drop = (): void => {
      worker.terminate();
      workers = workers.filter((x) => x !== worker);
    };
    worker.onmessage = (ev: MessageEvent<GenerateResponse>) => {
      const msg = ev.data;
      if (msg.id !== req.id) return;
      if (msg.status === 'progress') {
        setPrep(o.id, msg.message);
        return;
      }
      if (msg.status === 'pipeline') done(o.id, msg.plan);
      else if (msg.status === 'error') fail(o.id, msg.error);
      drop();
    };
    // A host that blocks workers fails them here, not at construction: plan on the page instead.
    worker.onerror = (ev) => {
      ev.preventDefault();
      drop();
      onMain();
    };
    worker.postMessage(req);
  }
}

export const usePresent = create<PresentState>((set, get) => ({
  active: false,
  step: 0,
  option: 'D1',
  plans: {},
  prep: {},
  errors: {},
  saved: null,
  cards: true,
  toggleCards: () => set((st) => ({ cards: !st.cards })),
  start: () => {
    if (get().active) return;
    const site = useSite.getState();
    const pl = usePlanning.getState();
    const saved: Saved = {
      visible: pl.visible,
      planVisible: pl.planVisible,
      plan: pl.plan,
      villaMasses: pl.villaMasses,
      viewMode: site.viewMode,
      raster: site.raster,
      layers: site.layers,
    };
    // The plan on screen answers the rules as they stand: it is one of the four.
    const plans: Partial<Record<OptionId, PlanResult>> = {};
    let option: OptionId = 'D1';
    if (pl.plan) {
      option = optionOf(pl.plan);
      plans[option] = pl.plan;
    }
    set({ active: true, step: 0, option, plans, prep: {}, errors: {}, saved });
    useSite.setState({ viewMode: '3d' });
    apply();
    void prepare(useSettings.getState().overrides);
  },
  stop: () => {
    const { saved } = get();
    for (const w of workers) w.terminate();
    workers = [];
    epoch += 1;
    set({ active: false, prep: {} });
    if (saved) {
      useSite.setState({
        viewMode: saved.viewMode,
        raster: saved.raster,
        layers: saved.layers,
      });
      usePlanning.setState({
        visible: saved.visible,
        planVisible: saved.planVisible,
        plan: saved.plan,
        villaMasses: saved.villaMasses,
      });
    }
    set({ saved: null, plans: {} });
  },
  go: (step) => {
    const s = Math.max(0, Math.min(PRESENT_STEPS.length - 1, step));
    set({ step: s });
    apply();
  },
  next: () => get().go(get().step + 1),
  back: () => get().go(get().step - 1),
  choose: (option) => {
    set({ option });
    apply();
  },
  stash: (plan) => set((st) => (st.saved ? { saved: { ...st.saved, plan } } : {})),
}));
