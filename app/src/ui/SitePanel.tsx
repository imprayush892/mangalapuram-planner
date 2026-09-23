import { useMemo } from 'react';
import { useSite } from '../state/store';
import { Check, Panel, Row, Select } from './primitives';
import type { RasterMode } from '../state/store';
import { m2ToAcres } from '../engine/units';
import { zoneColour } from './draw';
import { useEditedSite } from '../state/useEditedSite';

const RASTERS: readonly { value: RasterMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'rl', label: 'Levels (RL)' },
  { value: 'slope', label: 'Slope' },
  { value: 'fall', label: 'Fall across a plot window' },
  { value: 'buildable', label: 'Buildability (Rule 22)' },
  { value: 'hydrology', label: 'Hydrology (Water & Ponding)' },
];

const SLOPE_EDGES = [0, 5, 10, 15, 20, 30, 45, 90];
const SLOPE_LABELS = ['0–5°', '5–10°', '10–15°', '15–20°', '20–30°', '30–45°', 'over 45°'];
const FALL_EDGES = [0, 0.5, 1, 2, 3, Infinity];
const FALL_LABELS = ['under 0.5 m', '0.5–1 m', '1–2 m', '2–3 m', 'over 3 m'];

export default function SitePanel(): React.ReactElement {
  const site = useEditedSite();
  const layers = useSite((s) => s.layers);
  const setLayer = useSite((s) => s.setLayer);
  const raster = useSite((s) => s.raster);
  const setRaster = useSite((s) => s.setRaster);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const selectZone = useSite((s) => s.selectZone);

  const terrain = useMemo(() => {
    if (!site) return null;
    const demStats = site.dem.stats();
    const slopeBands = site.tin ? site.tin.slopeBandsAc(SLOPE_EDGES) : site.dem.slopeBandsAc(SLOPE_EDGES);
    const fall = site.dem.fallBandsAc(FALL_EDGES, 11.4, 14.2, 0.75);
    const tinStats = site.tin?.stats() ?? null;
    return { demStats, slopeBands, fall, tinStats };
  }, [site]);

  if (!site || !terrain) return <div className="p-3 text-muted">Loading site…</div>;

  const meshedAc = tinOrDemAc(terrain);
  const fill = site.filled;
  const fillAc = fill ? m2ToAcres(fill.interpolatedCells * site.dem.cell * site.dem.cell) : 0;
  const unsurveyedAc = Math.max(0, site.parcelAreaAc - meshedAc);

  return (
    <>
      <Panel title="Site">
        <Row label="In-scope parcel" value={`${site.parcelAreaAc.toFixed(2)} ac`} hint="parcel.geojson, P1 + P2 merged" />
        {site.parcelParts.map((p) => (
          <Row
            key={p.id}
            label={`  ${p.id} · ${p.deedLabel}`}
            value={`${p.areaAc.toFixed(2)} ac`}
            hint="deed label from data/raw/pdf/Existing_Roads.pdf"
          />
        ))}
        <Row label="Deferred land" value="26.40 ac" hint="programme.yaml scope.deferred_land_ac — out of scope" />
        <Row label="Surveyed (meshed)" value={`${meshedAc.toFixed(2)} ac`} hint="parcel-clipped TIN plan area" />
        <Row
          label="Unsurveyed"
          value={`${unsurveyedAc.toFixed(2)} ac`}
          hint="NaN in dem_2m.f32 — allowed but flagged low-confidence"
        />
        {fill && (
          <>
            <Row
              label="Levels recovered"
              value={`${fill.harvestedCells} cells`}
              hint="spot levels and contour vertices on ground the TIN never carried"
            />
            <Row
              label="Levels interpolated"
              value={`${fillAc.toFixed(2)} ac`}
              hint={`Laplace on the residual over a plane fitted to the ground around each hole; converged in ${fill.iterations} passes to ${fill.residualM.toFixed(3)} m`}
            />
            <Row
              label="Furthest from a reading"
              value={`${fill.maxFillDistanceM.toFixed(0)} m`}
              hint="the middle of the largest hole; confidence falls with this distance"
            />
          </>
        )}
        <Row
          label="Relief"
          value={`RL ${terrain.demStats.rlMin.toFixed(1)} – ${terrain.demStats.rlMax.toFixed(1)}`}
          hint="assumed datum TBM = 100.000; MSL offset unknown"
        />
        {terrain.tinStats && (
          <Row
            label="Mean slope"
            value={`${terrain.tinStats.meanSlopeDeg.toFixed(1)}°`}
            hint="plan-area weighted over TIN facets"
          />
        )}
      </Panel>

      <Panel title="Terrain — slope bands">
        {terrain.slopeBands.map((ac, i) => (
          <Row key={SLOPE_LABELS[i]} label={SLOPE_LABELS[i]!} value={`${ac.toFixed(2)} ac`} />
        ))}
        <p className="pt-1 text-[11px] text-muted">
          Ground over 45° is unbuildable (KMBR Rule 22) and is removed from every layout.
        </p>
      </Panel>

      <Panel title="Terrain — fall across a plot window">
        {terrain.fall.bands.map((ac, i) => (
          <Row key={FALL_LABELS[i]} label={FALL_LABELS[i]!} value={`${ac.toFixed(2)} ac`} />
        ))}
        <Row label="Median fall" value={`${terrain.fall.medianFall.toFixed(2)} m`} />
        <p className="pt-1 text-[11px] text-muted">
          11.4 × 14.2 m window on the 2 m DEM. Only about a fifth of the surveyed ground takes a plot without a
          level change.
        </p>
      </Panel>

      <Panel title="Layers">
        <Select label="Raster" value={raster} options={RASTERS} onChange={setRaster} />
        <div className="mt-2 grid grid-cols-2 gap-x-3">
          <Check label="Parcel" checked={layers.parcel} onChange={(v) => setLayer('parcel', v)} />
          <Check label="Zones" checked={layers.zones} onChange={(v) => setLayer('zones', v)} />
          <Check label="Contours" checked={layers.contours} onChange={(v) => setLayer('contours', v)} />
          <Check label="5 m only" checked={layers.majorContoursOnly} onChange={(v) => setLayer('majorContoursOnly', v)} />
          <Check label="Roads" checked={layers.roads} onChange={(v) => setLayer('roads', v)} />
          <Check label="Drains" checked={layers.drains} onChange={(v) => setLayer('drains', v)} />
          <Check label="Points" checked={layers.points} onChange={(v) => setLayer('points', v)} />
          <Check label="Labels" checked={layers.zoneLabels} onChange={(v) => setLayer('zoneLabels', v)} />
          <Check label="Layout" checked={layers.layout} onChange={(v) => setLayer('layout', v)} />
          <Check label="Deferred note" checked={layers.deferredNote} onChange={(v) => setLayer('deferredNote', v)} />
        </div>
      </Panel>

      <Panel title="Client zones (starting point)">
        <div className="flex flex-col">
          {site.zones.map((z) => (
            <button
              key={z.id}
              type="button"
              onClick={() => selectZone(z.id === selectedZoneId ? null : z.id)}
              className={`flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left transition hover:bg-panel-2 ${
                z.id === selectedZoneId ? 'bg-panel-2' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: zoneColour(z.name) }} />
                <span className="truncate text-fg">{z.name}</span>
              </span>
              <span className="num shrink-0 text-muted">
                {z.computedInScopeAc.toFixed(2)} ac
                {z.confidence === 'approximate' && <span className="text-warn" title="geometry approximate (±1 ac)"> ~</span>}
              </span>
            </button>
          ))}
        </div>
        <p className="pt-2 text-[11px] text-muted">
          From the client Zoning Plan, registered to the survey (median fit {site.registration.fit_error_m.median} m)
          and clipped to the in-scope parcel. A starting point only — zoning follows the project parameters.
        </p>
      </Panel>
    </>
  );
}

function tinOrDemAc(t: { tinStats: { planAreaM2: number } | null; demStats: { areaM2: number } }): number {
  return m2ToAcres(t.tinStats ? t.tinStats.planAreaM2 : t.demStats.areaM2);
}
