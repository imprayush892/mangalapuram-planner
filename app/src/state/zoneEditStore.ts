import { create } from 'zustand';
import type { ZoneEdit } from '../engine/site/zoneEdit';
import type { Pt, Ring } from '../engine/geom/types';

export type EditTool = 'none' | 'split' | 'draw' | 'merge';

interface ZoneEditState {
  /** Applied in order to the client's zoning plan. */
  edits: ZoneEdit[];
  tool: EditTool;
  /** Points collected for the operation in progress. */
  pending: Pt[];
  /** Zones picked for a merge. */
  selected: string[];
  setTool: (tool: EditTool) => void;
  addPoint: (p: Pt) => void;
  clearPending: () => void;
  toggleSelected: (zoneId: string) => void;
  push: (edit: ZoneEdit) => void;
  undo: () => void;
  reset: () => void;
}

export const useZoneEdit = create<ZoneEditState>((set) => ({
  edits: [],
  tool: 'none',
  pending: [],
  selected: [],

  setTool: (tool) => set({ tool, pending: [], selected: [] }),
  addPoint: (p) => set((s) => ({ pending: [...s.pending, p] })),
  clearPending: () => set({ pending: [] }),

  toggleSelected: (zoneId) =>
    set((s) => ({
      selected: s.selected.includes(zoneId)
        ? s.selected.filter((id) => id !== zoneId)
        : [...s.selected, zoneId],
    })),

  push: (edit) => set((s) => ({ edits: [...s.edits, edit], pending: [], selected: [] })),
  undo: () => set((s) => ({ edits: s.edits.slice(0, -1) })),
  reset: () => set({ edits: [], tool: 'none', pending: [], selected: [] }),
}));

/** A closed ring from the points collected so far, or null if there are too few. */
export function pendingRing(pending: Pt[]): Ring | null {
  if (pending.length < 3) return null;
  return [...pending];
}
