import { create } from 'zustand';
import type { DesignSwitches } from './settingsStore';
import type { OverrideSet } from '../engine/data/overrides';
import type { ZoneEdit } from '../engine/site/zoneEdit';
import type { LiveMetrics } from '../engine/metrics/live';

/**
 * Snapshots, because a tool that generates fifty variations in five minutes
 * makes remembering them the user's real problem.
 *
 * A snapshot stores everything needed to put the tool back exactly as it was —
 * the switches, the rule overrides, the zone edits and which siting alternative
 * was active — plus the headline metrics and a thumbnail of the view at the
 * moment it was taken, so two can be read side by side without restoring either.
 */
export interface Scenario {
  id: string;
  name: string;
  takenAt: number;
  thumbnail: string | null;
  switches: DesignSwitches;
  overrides: OverrideSet;
  zoneEdits: ZoneEdit[];
  sitingIndex: number;
  sitingLabel: string;
  metrics: LiveMetrics;
  /** Set where a plan had actually been generated when the snapshot was taken. */
  built: boolean;
}

interface DockState {
  scenarios: Scenario[];
  /** Up to two, for the side-by-side comparison. */
  compare: string[];
  save: (scenario: Omit<Scenario, 'id' | 'takenAt'>) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  toggleCompare: (id: string) => void;
  clearCompare: () => void;
}

export const useDock = create<DockState>((set) => ({
  scenarios: [],
  compare: [],

  save: (scenario) =>
    set((s) => ({
      scenarios: [
        ...s.scenarios,
        { ...scenario, id: `sc-${Date.now()}-${s.scenarios.length}`, takenAt: Date.now() },
      ],
    })),

  remove: (id) =>
    set((s) => ({
      scenarios: s.scenarios.filter((x) => x.id !== id),
      compare: s.compare.filter((x) => x !== id),
    })),

  rename: (id, name) =>
    set((s) => ({ scenarios: s.scenarios.map((x) => (x.id === id ? { ...x, name } : x)) })),

  toggleCompare: (id) =>
    set((s) => {
      if (s.compare.includes(id)) return { compare: s.compare.filter((x) => x !== id) };
      // Two at a time: a third pushes the oldest out.
      return { compare: [...s.compare, id].slice(-2) };
    }),

  clearCompare: () => set({ compare: [] }),
}));

/** Rows for the side-by-side table: only what actually differs is worth showing. */
export interface CompareRow {
  label: string;
  a: string;
  b: string;
  changed: boolean;
}

const fmt = (n: number, d = 0): string =>
  Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';

export function compareScenarios(a: Scenario, b: Scenario): CompareRow[] {
  const rows: [string, number, number, number][] = [
    ['Dwellings', a.metrics.dwellings, b.metrics.dwellings, 0],
    ['Villa plots', a.metrics.villaPlots, b.metrics.villaPlots, 0],
    ['Towers', a.metrics.towers, b.metrics.towers, 0],
    ['Flats', a.metrics.flats, b.metrics.flats, 0],
    ['Floor area m²', a.metrics.floorAreaM2, b.metrics.floorAreaM2, 0],
    ['FSI used', a.metrics.fsi, b.metrics.fsi, 2],
    ['Coverage %', a.metrics.coveragePct, b.metrics.coveragePct, 1],
    ['Population', a.metrics.population, b.metrics.population, 0],
    ['Land planned ac', a.metrics.landAc, b.metrics.landAc, 2],
  ];
  return rows.map(([label, x, y, d]) => ({
    label,
    a: fmt(x, d),
    b: fmt(y, d),
    changed: Math.abs(x - y) > (d === 0 ? 0.5 : 10 ** -d / 2),
  }));
}
