import { create } from 'zustand';
import type { LayoutOption } from '../engine/generators/types';

export interface GenerateStatus {
  running: boolean;
  zoneId: string | null;
  message: string;
  elapsedMs: number;
  error: string | null;
}

interface LayoutState {
  /** The three options kept for the zone last generated. */
  options: LayoutOption[];
  activeOptionIndex: number;
  /** Every option generated this session, keyed by zone id. */
  byZone: Record<string, LayoutOption[]>;
  status: GenerateStatus;
  setOptions: (zoneId: string, options: LayoutOption[]) => void;
  setActiveOption: (index: number) => void;
  showZone: (zoneId: string) => void;
  setStatus: (status: Partial<GenerateStatus>) => void;
  clear: () => void;
}

const IDLE: GenerateStatus = { running: false, zoneId: null, message: '', elapsedMs: 0, error: null };

export const useLayout = create<LayoutState>((set, get) => ({
  options: [],
  activeOptionIndex: 0,
  byZone: {},
  status: IDLE,

  setOptions: (zoneId, options) =>
    set((s) => ({
      options,
      activeOptionIndex: 0,
      byZone: { ...s.byZone, [zoneId]: options },
    })),

  setActiveOption: (activeOptionIndex) => set({ activeOptionIndex }),

  showZone: (zoneId) => {
    const stored = get().byZone[zoneId];
    set({ options: stored ?? [], activeOptionIndex: 0 });
  },

  setStatus: (status) => set((s) => ({ status: { ...s.status, ...status } })),
  clear: () => set({ options: [], activeOptionIndex: 0, byZone: {}, status: IDLE }),
}));
