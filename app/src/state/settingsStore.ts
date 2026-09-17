import { create } from 'zustand';
import type { OverrideSet } from '../engine/data/overrides';
import { EMPTY_OVERRIDES } from '../engine/data/overrides';
import type { BandName, MinSideApplies } from '../engine/rules/client';

/** Design choices the generators take, separate from the rule documents. */
export interface DesignSwitches {
  /** Index into the KMBR Table 6 FSI tier list. */
  fsiTierIndex: number;
  minSideApplies: MinSideApplies;
  apartmentMix: BandName[];
  flatsPerFloor: number;
  towerFloors: number;
  /** Candidate floor counts the tower generator explores. */
  towerFloorOptions: number[];
  roadAngleCandidates: ('contour' | 'north_south' | 'east_west')[];
  includeDeferredLand: boolean;
}

export const DEFAULT_SWITCHES: DesignSwitches = {
  fsiTierIndex: 0,
  minSideApplies: 'long_side',
  apartmentMix: ['2BHK', '3BHK'],
  flatsPerFloor: 4,
  towerFloors: 20,
  towerFloorOptions: [12, 15, 20],
  roadAngleCandidates: ['contour', 'north_south', 'east_west'],
  includeDeferredLand: false,
};

interface SettingsState {
  overrides: OverrideSet;
  switches: DesignSwitches;
  setOverride: (doc: keyof OverrideSet, path: string, value: unknown) => void;
  clearOverride: (doc: keyof OverrideSet, path: string) => void;
  resetOverrides: () => void;
  setSwitch: <K extends keyof DesignSwitches>(key: K, value: DesignSwitches[K]) => void;
  loadSnapshot: (overrides: OverrideSet, switches: DesignSwitches) => void;
}

export const useSettings = create<SettingsState>((set) => ({
  overrides: EMPTY_OVERRIDES,
  switches: DEFAULT_SWITCHES,

  setOverride: (doc, path, value) =>
    set((s) => ({ overrides: { ...s.overrides, [doc]: { ...s.overrides[doc], [path]: value } } })),

  clearOverride: (doc, path) =>
    set((s) => {
      const next = { ...s.overrides[doc] };
      delete next[path];
      return { overrides: { ...s.overrides, [doc]: next } };
    }),

  resetOverrides: () => set({ overrides: EMPTY_OVERRIDES, switches: DEFAULT_SWITCHES }),

  setSwitch: (key, value) => set((s) => ({ switches: { ...s.switches, [key]: value } })),

  loadSnapshot: (overrides, switches) => set({ overrides, switches }),
}));
