import { create } from 'zustand';
import { fetchSource } from '../engine/data/source';
import type { AssetSource } from '../engine/data/source';
import { loadConfig } from '../engine/data/config';
import type { ConfigBundle } from '../engine/data/config';
import { loadSite } from '../engine/site/loadSite';
import type { SiteModel } from '../engine/site/loadSite';
import { dataBaseUrl } from './appBase';

export type RasterMode = 'none' | 'rl' | 'slope' | 'fall' | 'buildable';

export interface LayerFlags {
  parcel: boolean;
  contours: boolean;
  majorContoursOnly: boolean;
  roads: boolean;
  drains: boolean;
  points: boolean;
  zones: boolean;
  zoneLabels: boolean;
  layout: boolean;
  deferredNote: boolean;
}

export const DEFAULT_LAYERS: LayerFlags = {
  parcel: true,
  contours: true,
  majorContoursOnly: true,
  roads: true,
  drains: true,
  points: true,
  zones: true,
  zoneLabels: true,
  layout: true,
  deferredNote: true,
};

interface SiteState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  site: SiteModel | null;
  /** Which view the shell shows; kept here so any panel can switch it. */
  viewMode: '2d' | '3d';
  setViewMode: (mode: '2d' | '3d') => void;
  config: ConfigBundle | null;
  layers: LayerFlags;
  raster: RasterMode;
  selectedZoneId: string | null;
  load: (src?: AssetSource) => Promise<void>;
  setLayer: (key: keyof LayerFlags, value: boolean) => void;
  setRaster: (mode: RasterMode) => void;
  selectZone: (id: string | null) => void;
}

export const useSite = create<SiteState>((set, get) => ({
  status: 'idle',
  error: null,
  site: null,
  config: null,
  viewMode: '2d',
  setViewMode: (viewMode) => set({ viewMode }),
  layers: DEFAULT_LAYERS,
  raster: 'none',
  selectedZoneId: null,

  load: async (src = fetchSource(dataBaseUrl())) => {
    if (get().status === 'loading') return;
    set({ status: 'loading', error: null });
    try {
      const [site, config] = await Promise.all([
        // The fill closes the survey's holes so the mesh is continuous; the
        // measured DEM is untouched and every filled cell stays labelled.
        loadSite(src, { withTin: true, withFill: true }),
        loadConfig(src),
      ]);
      set({ site, config, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  setLayer: (key, value) => set((s) => ({ layers: { ...s.layers, [key]: value } })),
  setRaster: (raster) => set({ raster }),
  selectZone: (selectedZoneId) => set({ selectedZoneId }),
}));
