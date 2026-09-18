import { create } from 'zustand';

/**
 * Shell state: which panels are open and how much of the complexity is shown.
 *
 * The 3D and 2D views are the work; the panels float over them and every one of
 * them collapses, so the model is never permanently crushed by a sidebar.
 */
export type Section =
  | 'goal'
  | 'site'
  | 'zones'
  | 'siting'
  | 'plan'
  | 'zone'
  | 'programme'
  | 'compliance'
  | 'report'
  | 'exports';

export const SECTIONS: readonly { id: Section; label: string; hint: string }[] = [
  { id: 'goal', label: 'Optimisation goal', hint: 'space, terrain and water, weighted' },
  { id: 'site', label: 'Site context', hint: 'terrain, layers, what the survey holds' },
  { id: 'zones', label: 'Zoning', hint: 'split, merge and draw the zones' },
  { id: 'siting', label: 'What goes where', hint: 'scores, vetoes, alternatives' },
  { id: 'plan', label: 'The plan', hint: 'what was drawn, road by road and zone by zone' },
  { id: 'zone', label: 'Selected zone', hint: 'three layout options for one zone' },
  { id: 'programme', label: 'Programme', hint: 'what the brief asks for' },
  { id: 'compliance', label: 'Compliance', hint: 'findings against KMBR and the client rules' },
  { id: 'report', label: 'Report', hint: 'use by use, and scenarios' },
  { id: 'exports', label: 'Exports', hint: 'DXF, XLSX, PDF, GLB' },
];

interface UiState {
  /** Only one section is open at a time: complexity is disclosed, not dumped. */
  section: Section | null;
  leftOpen: boolean;
  rightOpen: boolean;
  dockOpen: boolean;
  /** Layer 2: the micro-levers behind the gear. */
  advanced: boolean;
  /** Which constraint the pointer is over, so the viewport can echo it. */
  hoveredConstraint: string | null;
  setSection: (section: Section | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleDock: () => void;
  setAdvanced: (advanced: boolean) => void;
  setHoveredConstraint: (id: string | null) => void;
}

export const useUi = create<UiState>((set) => ({
  section: 'goal',
  leftOpen: true,
  rightOpen: true,
  dockOpen: true,
  advanced: false,
  hoveredConstraint: null,

  setSection: (section) => set((s) => ({ section: s.section === section ? null : section })),
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setAdvanced: (advanced) => set({ advanced }),
  setHoveredConstraint: (hoveredConstraint) => set({ hoveredConstraint }),
}));

/**
 * The plan canvas, so a scenario snapshot can take a thumbnail of exactly what
 * the user is looking at. Set by whichever view is mounted.
 */
let liveCanvas: HTMLCanvasElement | null = null;
export const registerCanvas = (canvas: HTMLCanvasElement | null): void => {
  liveCanvas = canvas;
};
export function snapshotCanvas(maxWidth = 240): string | null {
  if (!liveCanvas || liveCanvas.width === 0) return null;
  try {
    const scale = Math.min(1, maxWidth / liveCanvas.width);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(liveCanvas.width * scale));
    out.height = Math.max(1, Math.round(liveCanvas.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(liveCanvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.7);
  } catch {
    // A tainted or zero-sized canvas is not worth failing a snapshot over.
    return null;
  }
}
