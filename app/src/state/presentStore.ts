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

/**
 * Presentation mode: the planning pipeline revealed one step at a time on the
 * 2D plan and the 3D terrain, each step adding to the last. At the plots the
 * plan forks into the four master plans; from there on any of the four can be
 * shown. Every step only switches what the views already draw.
 */

export type OptionId = 'A1' | 'A2' | 'B1' | 'B2';

export const PRESENT_OPTIONS: {
  id: OptionId;
  sizing: 'rules' | 'count';
  roads: 'terrain' | 'north_south';
  label: string;
}[] = [
  {
    id: 'A1',
    sizing: 'rules',
    roads: 'terrain',
    label: 'Plot rules · roads to the ground',
  },
  {
    id: 'A2',
    sizing: 'rules',
    roads: 'north_south',
    label: 'Plot rules · north–south roads',
  },
  {
    id: 'B1',
    sizing: 'count',
    roads: 'terrain',
    label: 'To the count · roads to the ground',
  },
  {
    id: 'B2',
    sizing: 'count',
    roads: 'north_south',
    label: 'To the count · north–south roads',
  },
];

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
  /** The four master plans part here. */
  fork?: boolean;
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
    title: "The client's zoning",
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
    title: 'Villa plots: four master plans',
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
    title: 'Uses and golf',
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
  {
    key: 'masterplan',
    num: '16',
    title: 'The master plan',
    layers: ['waterlogging'],
    raster: 'none',
    zones: 'off',
    plan: ['roads', 'blocks', 'plots', 'buildings'],
    uses: 'all',
    villas: true,
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
  const count = plan.option.villaSizing === 'count';
  const ns = plan.option.roads === 'north_south';
  return count ? (ns ? 'B2' : 'B1') : ns ? 'A2' : 'A1';
}

/** The plan as a step shows it: only the building uses it has reached. */
function shownPlan(plan: PlanResult | undefined, step: PresentStep): PlanResult | null {
  if (!plan) return null;
  if (step.uses === 'all') return plan;
  const uses = step.uses === 'none' ? [] : step.uses;
  return {
    ...plan,
    buildings: plan.buildings.filter((b) => uses.includes(b.typology)),
  };
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

/** Works out the four plans in the background, each in its own worker. */
function prepare(overrides: OverrideSet): void {
  const have = usePresent.getState().plans;
  for (const o of PRESENT_OPTIONS) {
    if (have[o.id]) continue;
    const ov: OverrideSet = {
      ...overrides,
      planning: {
        ...overrides.planning,
        'options.villa_sizing': o.sizing,
        'options.road_orientation': o.roads,
      },
    };
    const id = prepId++;
    const req: PipelineRequest = {
      job: 'pipeline',
      id,
      baseUrl: dataBaseUrl(),
      overrides: ov,
    };
    const setPrep = (msg: string | undefined): void =>
      usePresent.setState((st) => {
        const prep = { ...st.prep };
        if (msg === undefined) delete prep[o.id];
        else prep[o.id] = msg;
        return { prep };
      });
    const done = (plan: PlanResult): void => {
      usePresent.setState((st) => ({ plans: { ...st.plans, [o.id]: plan } }));
      setPrep(undefined);
      if (usePresent.getState().active && usePresent.getState().option === o.id) apply();
    };
    const fail = (error: string): void => {
      usePresent.setState((st) => ({
        errors: { ...st.errors, [o.id]: error },
      }));
      setPrep(undefined);
    };
    setPrep('starting…');
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('../workers/generate.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      w = null;
    }
    if (!w) {
      void import('../engine/runGeneration')
        .then(({ runPipelineJob }) => runPipelineJob(req, (m) => setPrep(m)))
        .then(({ plan }) => done(plan))
        .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
      continue;
    }
    const worker = w;
    workers.push(worker);
    worker.onmessage = (ev: MessageEvent<GenerateResponse>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.status === 'progress') {
        setPrep(msg.message);
        return;
      }
      if (msg.status === 'pipeline') done(msg.plan);
      else if (msg.status === 'error') fail(msg.error);
      worker.terminate();
      workers = workers.filter((x) => x !== worker);
    };
    worker.onerror = () => {
      fail('the worker stopped');
      worker.terminate();
      workers = workers.filter((x) => x !== worker);
    };
    worker.postMessage(req);
  }
}

export const usePresent = create<PresentState>((set, get) => ({
  active: false,
  step: 0,
  option: 'A1',
  plans: {},
  prep: {},
  errors: {},
  saved: null,
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
    let option: OptionId = 'A1';
    if (pl.plan) {
      option = optionOf(pl.plan);
      plans[option] = pl.plan;
    }
    set({ active: true, step: 0, option, plans, prep: {}, errors: {}, saved });
    useSite.setState({ viewMode: '3d' });
    apply();
    prepare(useSettings.getState().overrides);
  },
  stop: () => {
    const { saved } = get();
    for (const w of workers) w.terminate();
    workers = [];
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
