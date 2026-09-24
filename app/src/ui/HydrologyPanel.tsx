import { useEffect, useState } from 'react';
import { useActiveStorm, useHydrology } from '../state/hydrologyStore';
import { useSettings } from '../state/settingsStore';
import { Panel, Row } from './primitives';

const HA_TO_AC = 2.47105;
const fmt = (v: number): string => Math.round(v).toLocaleString();

/** Assumption keys the storm inputs write to, under config/assumptions.yaml `hydrology`. */
const KEYS = {
  storm: 'hydrology.design_storm_mm',
  annual: 'hydrology.annual_rainfall_mm',
  stormC: 'hydrology.storm_runoff_coeff',
  annualC: 'hydrology.annual_runoff_coeff',
  impervious: 'hydrology.impervious_share_developed',
} as const;

export default function HydrologyPanel(): React.ReactElement {
  const { status, error, report, retention, load, setRetention, clearRetention } = useHydrology();
  const active = useActiveStorm();
  const overrides = useSettings((s) => s.overrides.assumptions);
  const setOverride = useSettings((s) => s.setOverride);
  const clearOverride = useSettings((s) => s.clearOverride);
  const [tab, setTab] = useState<'site' | 'basins'>('site');

  useEffect(() => {
    void load();
  }, [load]);

  if (!active) return <div className="p-3 text-muted">Loading the site…</div>;
  if ('error' in active) return <div className="p-3 text-bad">{active.error}</div>;

  const { params: p, natural, developed, naturalC, developedC, cFromFormula } = active;
  const edited = Object.values(KEYS).some((k) => overrides?.[k] !== undefined) || Object.keys(retention).length > 0;
  const siteRetention = retention['site'] ?? 0;
  const afterRetention = (out: number, kept: number): number => Math.max(0, out - kept);

  const num = (key: string, value: number, extra: Record<string, string | number> = {}): React.ReactElement => (
    <input
      type="number"
      className="w-24 bg-ink border border-line rounded px-1 text-fg font-mono text-right"
      value={Number.isFinite(value) ? Number(value.toFixed(3)) : ''}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) setOverride('assumptions', key, v);
      }}
      {...extra}
    />
  );

  const annualRunoff = (siteHa: number): number => siteHa * 1e4 * (p.annualRainfallMm / 1000) * p.annualRunoffCoeff;
  const siteHa = natural.rainM3 / (p.designStormMm / 1000) / 1e4;

  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto max-h-[calc(100vh-120px)]">
      <Panel title="Storm and soil">
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex justify-between items-center">
            <span title="Default: 100-yr 24 h, KSDMA TVM CDMP 2016 Table 3.1, Nedumangad (1986–2013)">
              Storm, 24 h (mm)
            </span>
            {num(KEYS.storm, p.designStormMm, { min: 0 })}
          </label>
          {p.presets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {p.presets.map((preset) => (
                <button
                  key={preset.label}
                  title={preset.note}
                  onClick={() => setOverride('assumptions', KEYS.storm, preset.mm)}
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    p.designStormMm === preset.mm
                      ? 'border-accent text-accent'
                      : 'border-line text-muted hover:text-fg'
                  }`}
                >
                  {preset.label} · {preset.mm}
                </button>
              ))}
            </div>
          )}
          <label className="flex justify-between items-center">
            <span title={cFromFormula ? 'CWC/RBF-16 coastal formula C = 0.332 (R F)^0.2, R in cm' : 'fixed in the assumptions'}>
              Storm runoff coefficient {cFromFormula ? '(formula)' : '(fixed)'}
            </span>
            {num(KEYS.stormC, naturalC, { step: 0.05, min: 0, max: 1 })}
          </label>
          {!cFromFormula && (
            <button
              onClick={() => clearOverride('assumptions', KEYS.stormC)}
              className="self-end text-[10px] text-accent hover:underline"
            >
              use the formula again
            </button>
          )}
          <label className="flex justify-between items-center">
            <span title="Benchmark from KWRA-2024 (CWRDM/KSCSTE): 2024 range for the district 2,078–2,675 mm">
              Annual rainfall (mm)
            </span>
            {num(KEYS.annual, p.annualRainfallMm, { min: 0 })}
          </label>
          <label className="flex justify-between items-center">
            <span title="Unverified assumption: no local source found">Annual runoff coefficient ⚠</span>
            {num(KEYS.annualC, p.annualRunoffCoeff, { step: 0.05, min: 0, max: 1 })}
          </label>
          <label className="flex justify-between items-center">
            <span title={`Built-out C = share × ${p.imperviousRunoffCoeff} + rest × natural C`}>
              Impervious share when built
            </span>
            {num(KEYS.impervious, p.imperviousShareDeveloped, { step: 0.05, min: 0, max: 1 })}
          </label>
          {edited && (
            <button
              onClick={() => {
                Object.values(KEYS).forEach((k) => clearOverride('assumptions', k));
                clearRetention();
              }}
              className="mt-1 text-xs bg-panel-2 hover:bg-line text-fg py-1 rounded border border-line transition-colors"
            >
              ↻ Back to the sourced values
            </button>
          )}
        </div>
      </Panel>

      <div className="flex gap-1 bg-ink/50 p-1 rounded border border-line text-xs font-semibold">
        {(['site', 'basins'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1 rounded transition-colors ${
              tab === t ? 'bg-panel-2 text-fg border border-line/60' : 'text-muted hover:text-fg'
            }`}
          >
            {t === 'site' ? 'Whole site' : `Catchments (${report?.catchments.length ?? 0})`}
          </button>
        ))}
      </div>

      {tab === 'site' && (
        <Panel title={`Terrain mesh (${siteHa.toFixed(2)} ha)`}>
          <div className="flex flex-col gap-1 text-[11px]">
            <Row label="Area" value={`${siteHa.toFixed(2)} ha (${(siteHa * HA_TO_AC).toFixed(1)} ac)`} />
            <Row
              label={`Ponds (hollows ≥ ${p.pondingDepthM} m deep)`}
              value={`${natural.pondsTotal}, holding ${fmt(active.model.depressions.reduce((s, d) => s + (d.maxDepthM >= p.pondingDepthM ? d.capacityM3 : 0), 0))} m³ full`}
            />
            <Row
              label="All hollows hold, brim-full"
              value={`${fmt(active.model.depressions.reduce((s, d) => s + d.capacityM3, 0))} m³`}
            />

            <label className="flex justify-between text-xs items-center my-1 text-accent border-y border-line/40 py-1">
              <span>+ Designed retention (m³)</span>
              <input
                type="number"
                step="500"
                min="0"
                className="w-24 bg-ink border border-line rounded px-1 text-fg font-mono text-right"
                value={siteRetention}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!Number.isNaN(v)) setRetention('site', v);
                }}
              />
            </label>

            <div className="mt-2 font-bold text-xs text-accent">
              {p.designStormMm} mm IN 24 h, C = {naturalC.toFixed(2)}
            </div>
            <div className="bg-accent/10 p-1.5 rounded my-1 border border-accent/30">
              <Row
                label="Under water at the peak"
                value={`${(natural.peakWetAreaM2 / 1e4).toFixed(2)} ha`}
                hint={`≥ ${p.standingWaterShowM} m deep: ponds risen over their rims and water running in the swales`}
              />
              <Row
                label="Peak flow leaving the site"
                value={`${natural.peakOutflowM3s.toFixed(2)} m³/s`}
                hint={`largest outlet; time of concentration ${natural.peakOutflowTcMin.toFixed(0)} min`}
              />
            </div>
            <Row label="Rain on the site" value={`${fmt(natural.rainM3)} m³`} />
            <Row label="Soaks in" value={`${fmt(natural.rainM3 - natural.runoffM3)} m³`} />
            <Row label="Runs off" value={`${fmt(natural.runoffM3)} m³`} />
            <div className="bg-line/20 p-1.5 rounded my-1 border border-line/40">
              <Row
                label="Held in hollows"
                value={`${fmt(natural.heldM3)} m³ · ${natural.pondsFull} of ${natural.pondsTotal} ponds full`}
              />
              <Row label="Standing water after the storm" value={`${(natural.standingAreaM2 / 1e4).toFixed(2)} ha`} />
              <Row label="Leaves the site" value={`${fmt(afterRetention(natural.outflowM3, siteRetention))} m³`} />
            </div>
            <div className="text-[10px] text-muted">
              Hollows fill from the bottom with what reaches them and spill the rest. After the storm a full pond
              cannot stand higher than its rim; at the peak it rises over it, and running water spreads wider the
              harder it rains. Steady flow at the peak, no culverts or backwater (none surveyed).
            </div>

            <div className="mt-2 font-bold text-xs text-muted">IF BUILT, C = {developedC.toFixed(2)}</div>
            <Row label="Runs off" value={`${fmt(developed.runoffM3)} m³`} />
            <Row label="Leaves the site" value={`${fmt(afterRetention(developed.outflowM3, siteRetention))} m³`} />
            <Row label="Peak flow leaving" value={`${developed.peakOutflowM3s.toFixed(2)} m³/s`} />
            <div className="text-[10px] text-amber-300 mt-0.5">
              Building adds {fmt(developed.outflowM3 - natural.outflowM3)} m³ of outflow in the design storm: the
              retention to design for.
            </div>

            <div className="mt-2 font-bold text-xs text-muted">YEAR, {fmt(p.annualRainfallMm)} mm</div>
            <Row label="Rain on the site" value={`${fmt(siteHa * 1e4 * (p.annualRainfallMm / 1000))} m³`} />
            <Row label="Runs off (C unverified)" value={`${fmt(annualRunoff(siteHa))} m³`} />
          </div>
        </Panel>
      )}

      {tab === 'basins' && (
        <Panel title="Catchments">
          {status !== 'ready' || !report ? (
            <div className="text-[11px] text-bad">
              No hydrology report. Run <code>tools/preprocess/hydrology_analysis.py</code>.
              {error && <div className="mt-1 text-[10px] text-muted">{error}</div>}
            </div>
          ) : (
            <>
              <div className="text-[10px] text-muted mb-1">
                {report.catchment_count} outlets on the mesh edge; the {report.catchments.length} of{' '}
                {report.method.min_catchment_area_ha} ha or more, largest first.
              </div>
              {report.catchments.map((node, i) => {
                const live = natural.catchments.get(node.outlet_cell);
                const kept = retention[String(node.outlet_cell)] ?? 0;
                return (
                  <div
                    key={node.node_id}
                    className={`flex flex-col gap-1 text-[11px] ${i > 0 ? 'mt-3 border-t border-line/50 pt-2' : ''}`}
                  >
                    <div className="font-semibold text-fg flex justify-between">
                      <span>{node.name}</span>
                      <span className="text-muted font-normal">{node.catchment_area_ha.toFixed(2)} ha</span>
                    </div>
                    <Row label="Outlet" value={`x ${node.outlet_xy_m[0].toFixed(0)}, y ${node.outlet_xy_m[1].toFixed(0)} m`} />
                    <Row label="Hollows hold" value={`${fmt(node.storage_capacity_m3)} m³`} />
                    <label className="flex justify-between text-xs items-center my-0.5 text-accent">
                      <span>+ Designed pond (m³)</span>
                      <input
                        type="number"
                        step="200"
                        min="0"
                        className="w-20 bg-ink border border-line rounded px-1 text-fg font-mono text-right"
                        value={kept}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) setRetention(String(node.outlet_cell), v);
                        }}
                      />
                    </label>
                    {live ? (
                      <>
                        <Row label="Runs off" value={`${fmt(live.runoffM3)} m³`} />
                        <Row label="Held" value={`${fmt(live.heldM3 + Math.min(kept, live.outflowM3))} m³`} />
                        <Row label="Leaves at the outlet" value={`${fmt(afterRetention(live.outflowM3, kept))} m³`} />
                      </>
                    ) : (
                      <div className="text-[10px] text-bad">This outlet is not on the loaded DEM: re-run the report.</div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
