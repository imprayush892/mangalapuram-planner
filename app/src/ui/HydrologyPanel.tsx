import { useEffect, useState } from 'react';
import { useHydrology, useActiveHydrology } from '../state/hydrologyStore';
import { Panel, Row } from './primitives';

const HA_TO_AC = 2.47105;

const fmt = (v: number): string => Math.round(v).toLocaleString();
const fmtRate = (v: number): string => v.toFixed(3);

export default function HydrologyPanel(): React.ReactElement {
  const { status, error, load, setOverride, resetOverrides } = useHydrology();
  const active = useActiveHydrology();
  const [tab, setTab] = useState<'site' | 'basins'>('site');

  useEffect(() => {
    void load();
  }, [load]);

  if (status === 'idle' || status === 'loading') {
    return <div className="p-3 text-muted">Loading hydrology analysis…</div>;
  }
  if (status === 'error' || !active) {
    return (
      <div className="p-3 text-bad">
        No hydrology report. Run <code>tools/preprocess/hydrology_analysis.py</code>, then restart the app.
        {error && <div className="mt-1 text-[10px] text-muted">{error}</div>}
      </div>
    );
  }

  const {
    activeParams,
    siteTotals,
    sitePeak,
    siteDevelopedPeak,
    siteAnnual,
    catchments,
    catchmentCount,
    minCatchmentHa,
    designedSitePondM3,
    isEdited,
  } = active;

  const edit = (key: string, val: string): void => {
    const num = parseFloat(val);
    if (!Number.isNaN(num)) setOverride(key, num);
  };

  const input = (key: string, value: number, extra: Record<string, string | number> = {}): React.ReactElement => (
    <input
      type="number"
      className="w-24 bg-ink border border-line rounded px-1 text-fg font-mono text-right"
      value={value}
      onChange={(e) => edit(key, e.target.value)}
      {...extra}
    />
  );

  return (
    <div className="flex flex-col gap-2 p-2 overflow-y-auto max-h-[calc(100vh-120px)]">
      <Panel title="Storm and soil inputs">
        <div className="flex flex-col gap-2">
          <label className="flex justify-between text-xs items-center">
            <span title="The 24 h storm the balance and the 3D water are drawn for">Peak daily storm (mm)</span>
            {input('peak_daily_rainfall_mm', activeParams.peak_daily_rainfall_mm)}
          </label>
          <label className="flex justify-between text-xs items-center">
            <span>Annual rainfall (mm)</span>
            {input('annual_rainfall_mm', activeParams.annual_rainfall_mm)}
          </label>
          <label className="flex justify-between text-xs items-center">
            <span>Runoff coefficient, natural</span>
            {input('runoff_coeff_natural', activeParams.runoff_coeff_natural, { step: 0.05, min: 0.05, max: 1 })}
          </label>
          <label className="flex justify-between text-xs items-center">
            <span>Runoff coefficient, developed</span>
            {input('runoff_coeff_developed', activeParams.runoff_coeff_developed, { step: 0.05, min: 0.05, max: 1 })}
          </label>
          {isEdited && (
            <button
              onClick={resetOverrides}
              className="mt-1 text-xs bg-panel-2 hover:bg-line text-fg py-1 rounded border border-line transition-colors"
            >
              ↻ Reset to the report's values
            </button>
          )}
        </div>
      </Panel>

      <div className="flex gap-1 bg-ink/50 p-1 rounded border border-line text-xs font-semibold">
        <button
          onClick={() => setTab('site')}
          className={`flex-1 py-1 rounded transition-colors ${
            tab === 'site' ? 'bg-panel-2 text-fg border border-line/60' : 'text-muted hover:text-fg'
          }`}
        >
          Whole survey
        </button>
        <button
          onClick={() => setTab('basins')}
          className={`flex-1 py-1 rounded transition-colors ${
            tab === 'basins' ? 'bg-panel-2 text-fg border border-line/60' : 'text-muted hover:text-fg'
          }`}
        >
          Catchments ({catchments.length})
        </button>
      </div>

      {tab === 'site' && (
        <Panel title={`Surveyed ground (${siteTotals.total_area_ha.toFixed(2)} ha)`}>
          <div className="flex flex-col gap-1 text-[11px]">
            <Row
              label="Surveyed area"
              value={`${siteTotals.total_area_ha.toFixed(2)} ha (${(siteTotals.total_area_ha * HA_TO_AC).toFixed(1)} ac)`}
            />
            <Row label="Hollows in the DEM hold" value={`${fmt(siteTotals.total_sinks_m3)} m³`} />
            <Row
              label={`Ponds (≥ ${siteTotals.ponding_depth_m} m deep)`}
              value={`${siteTotals.total_ponding_area_ha.toFixed(2)} ha, ${siteTotals.max_sink_depth_m.toFixed(1)} m at most`}
            />

            <label className="flex justify-between text-xs items-center my-1 text-accent border-y border-line/40 py-1">
              <span>+ Designed retention (m³)</span>
              {input('site_designed_pond', designedSitePondM3, { step: 500, min: 0 })}
            </label>

            <div className="mt-2 font-bold text-xs text-accent">
              PEAK DAY, {activeParams.peak_daily_rainfall_mm} mm, C = {activeParams.runoff_coeff_natural}
            </div>
            <Row label="Rain on the survey" value={`${fmt(sitePeak.rain_m3)} m³`} />
            <Row label="Soaks in" value={`${fmt(sitePeak.infiltrated_m3)} m³`} />
            <Row label="Runs off" value={`${fmt(sitePeak.runoff_m3)} m³`} />
            <div className="bg-line/20 p-1.5 rounded my-1 border border-line/40">
              <Row
                label="Held in hollows and ponds"
                value={`${fmt(sitePeak.ponded_m3)} m³ (${sitePeak.storage_fill_pct.toFixed(0)}% full)`}
              />
              <Row label="Leaves the survey" value={`${fmt(sitePeak.outflow_m3)} m³`} />
            </div>
            <Row label="Mean runoff rate over 24 h" value={`${fmtRate(sitePeak.mean_runoff_rate_m3s)} m³/s`} />
            <Row label="Mean outflow rate over 24 h" value={`${fmtRate(sitePeak.mean_outflow_rate_m3s)} m³/s`} />
            <div className="text-[10px] text-muted mt-0.5">
              Means, not peaks: an IDF peak would be several times higher and needs a rainfall intensity curve.
            </div>

            <div className="mt-2 font-bold text-xs text-muted">IF DEVELOPED, C = {activeParams.runoff_coeff_developed}</div>
            <Row label="Runs off" value={`${fmt(siteDevelopedPeak.runoff_m3)} m³`} />
            <Row label="Leaves the survey" value={`${fmt(siteDevelopedPeak.outflow_m3)} m³`} />
            <div className="text-[10px] text-amber-300 mt-0.5">
              Development adds {fmt(siteDevelopedPeak.outflow_m3 - sitePeak.outflow_m3)} m³ of outflow on the peak day; that is
              the retention to design for.
            </div>

            <div className="mt-2 font-bold text-xs text-muted">YEAR, {fmt(activeParams.annual_rainfall_mm)} mm</div>
            <Row label="Rain on the survey" value={`${fmt(siteAnnual.rain_m3)} m³`} />
            <Row label="Soaks in" value={`${fmt(siteAnnual.infiltrated_m3)} m³`} />
            <Row label="Runs off" value={`${fmt(siteAnnual.runoff_m3)} m³`} />
            <Row label="Leaves, after one fill of the hollows" value={`${fmt(siteAnnual.outflow_m3)} m³`} />
          </div>
        </Panel>
      )}

      {tab === 'basins' && (
        <Panel title="Catchments">
          <div className="text-[10px] text-muted mb-1">
            {catchmentCount} outlets on the survey edge; the {catchments.length} of {minCatchmentHa} ha or more are listed,
            largest first.
          </div>
          {catchments.map((node, i) => (
            <div key={node.node_id} className={`flex flex-col gap-1 ${i > 0 ? 'mt-3 border-t border-line/50 pt-2' : ''}`}>
              <div className="text-[11px] font-semibold text-fg flex justify-between">
                <span>{node.name}</span>
                <span className="text-muted font-normal">{node.catchment_area_ha.toFixed(2)} ha</span>
              </div>
              <Row
                label="Outlet"
                value={`x ${node.outlet_xy_m[0].toFixed(0)}, y ${node.outlet_xy_m[1].toFixed(0)} m`}
              />
              <Row label="Hollows hold" value={`${fmt(node.storage_capacity_m3)} m³`} />
              <Row label="Ponds" value={`${node.water_surface_ha.toFixed(2)} ha`} />
              <label className="flex justify-between text-xs items-center my-0.5 text-accent">
                <span>+ Designed pond (m³)</span>
                {input(`retention_${node.node_id}`, node.designed_storage_m3, { step: 200, min: 0 })}
              </label>

              <div className="mt-1 text-[10px] font-semibold text-accent">PEAK DAY</div>
              <Row label="Runs off" value={`${fmt(node.peak.runoff_m3)} m³`} />
              <Row
                label="Held"
                value={`${fmt(node.peak.ponded_m3)} m³ (${node.peak.storage_fill_pct.toFixed(0)}%)`}
              />
              <Row label="Leaves at the outlet" value={`${fmt(node.peak.outflow_m3)} m³`} />
              <Row label="Year, leaves" value={`${fmt(node.annual.outflow_m3)} m³`} />
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
