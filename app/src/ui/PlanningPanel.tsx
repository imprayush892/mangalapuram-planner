import { useEffect, useState } from 'react';
import { usePlanning, usePlanningAnalysis } from '../state/planningStore';
import { useSite } from '../state/store';
import { Panel } from './primitives';
import { LAYER_STYLE, rgba } from './planningStyle';
import type { LayerId } from '../engine/pipeline/analysis';
import PipelinePlanSection from './PipelinePlanSection';

const AC = 4046.8564224;

/**
 * Planning steps 1-7, in order. Each row is one layer: its swatch, its area,
 * and, opened, the rule and numbers that made it. Ticking a row draws it on
 * the plan and on the 3D terrain.
 */
export default function PlanningPanel(): React.ReactElement {
  const analysis = usePlanningAnalysis();
  const { visible, toggle, zoningHidden, markZoningHidden } = usePlanning();
  const layers = useSite((s) => s.layers);
  const setLayer = useSite((s) => s.setLayer);
  const [open, setOpen] = useState<LayerId | null>(null);

  // The client's hand-drawn zones are what this replaces: out of the way the
  // first time, one tick away for comparison.
  useEffect(() => {
    if (zoningHidden) return;
    setLayer('zones', false);
    setLayer('zoneLabels', false);
    markZoningHidden();
  }, [zoningHidden, setLayer, markZoningHidden]);

  if (!analysis) return <div className="p-3 text-muted">Loading the site…</div>;
  if ('error' in analysis) return <div className="p-3 text-bad">{analysis.error}</div>;

  const parcelAc = analysis.parcelAreaM2 / AC;
  const plotable = analysis.layers.plotable;

  return (
    <div className="flex flex-col">
      <Panel title="Planning basis">
        <div className="text-[11px] leading-snug text-muted">
          {analysis.stormMm} mm in 24 h · non-buildable: slope {analysis.limits.nonBuildableLabel}, flood-liable land and
          natural drains · plots at most 1:{(1 / analysis.limits.plotMax).toFixed(0)}. Each layer below is worked out
          from the ones above it (config/planning_rules.yaml).
        </div>
        <div className="mt-2 rounded border border-line bg-panel-2 px-2 py-1.5 text-[11px]">
          <span className="text-fg">{(plotable.areaM2 / AC).toFixed(1)} ac</span>
          <span className="text-muted">
            {' '}
            of {parcelAc.toFixed(1)} ac can take plots, in {plotable.pieces} zones.
          </span>
        </div>
      </Panel>

      <Panel title="KMBR Rule 22 — site suitability">
        <ul className="flex flex-col gap-1 text-[10px] leading-snug">
          {analysis.rule22.map((c) => (
            <li key={c.condition} className="flex gap-2">
              <span
                className={`mt-0.5 shrink-0 rounded px-1 font-semibold ${
                  c.status === 'applied' ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn'
                }`}
              >
                {c.status === 'applied' ? 'applied' : 'no data'}
              </span>
              <span className="text-muted">
                <span className="text-fg">
                  {c.clause} {c.condition}
                </span>{' '}
                — {c.how}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Layers">
        <ul className="flex flex-col">
          {analysis.order.map((id) => {
            const L = analysis.layers[id];
            const style = LAYER_STYLE[id];
            const on = visible.includes(id);
            const expanded = open === id;
            return (
              <li key={id} className="border-b border-line/40 last:border-b-0">
                <div className="flex items-center gap-2 py-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggle(id)}
                    aria-label={`Show ${L.title}`}
                    className="accent-accent"
                  />
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-sm"
                    style={{
                      background: rgba(style.rgb, Math.max(style.fill, 0.15)),
                      border: `1px ${style.dashed ? 'dashed' : 'solid'} ${rgba(style.rgb, 1)}`,
                    }}
                  />
                  <button
                    onClick={() => setOpen(expanded ? null : id)}
                    className="flex min-w-0 flex-1 items-baseline justify-between gap-2 text-left"
                    title="Why this layer is what it is"
                  >
                    <span className="truncate text-fg">
                      <span className="text-muted">{L.step}</span> {L.title}
                    </span>
                    <span className="shrink-0 font-mono text-muted">
                      {(L.areaM2 / AC).toFixed(1)} ac · {(L.share * 100).toFixed(0)}%
                    </span>
                  </button>
                </div>
                {expanded && (
                  <ul className="mb-1.5 ml-7 list-disc pl-3 text-[10px] leading-snug text-muted">
                    {L.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                    <li>
                      {L.pieces} piece{L.pieces === 1 ? '' : 's'}, {(L.areaM2 / 1e4).toFixed(2)} ha
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={layers.zones}
            onChange={(e) => {
              setLayer('zones', e.target.checked);
              setLayer('zoneLabels', e.target.checked);
            }}
            className="accent-accent"
          />
          Client's zoning plan, for comparison
        </label>
      </Panel>

      <PipelinePlanSection />
    </div>
  );
}
