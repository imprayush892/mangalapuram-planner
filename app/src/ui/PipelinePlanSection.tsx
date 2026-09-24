import { useEffect, useMemo, useState } from 'react';
import { usePlanning } from '../state/planningStore';
import type { PlanLayer } from '../state/planningStore';
import { useSettings } from '../state/settingsStore';
import { runPipeline } from '../state/generate';
import { Panel, Row } from './primitives';
import { TIER_RGB, TYPOLOGY_LABEL, TYPOLOGY_RGB, rgba } from './planningStyle';
import type { RoadTier, Typology } from '../engine/pipeline/plan';

const AC = 4046.8564224;
const fmt = (v: number): string => Math.round(v).toLocaleString();

const LAYERS: { id: PlanLayer; label: string }[] = [
  { id: 'roads', label: 'Roads by tier' },
  { id: 'blocks', label: 'Blocks by use' },
  { id: 'plots', label: 'Plot boundaries' },
  { id: 'buildings', label: 'Buildings' },
  { id: 'earthwork', label: 'Cut and fill' },
];

/**
 * Steps 8-16: the plan the analysis leads to. It runs on its own whenever the
 * rules change, in the background, and reports what it built, what it could
 * not, and why each block is what it is.
 */
export default function PipelinePlanSection(): React.ReactElement {
  const overrides = useSettings((s) => s.overrides);
  const { plan, planMs, planStatus, planVisible, togglePlan } = usePlanning();
  const [open, setOpen] = useState<string | null>(null);

  // Re-plan when a rule changes, a moment after the last change.
  useEffect(() => {
    const t = setTimeout(() => runPipeline(overrides), 400);
    return () => clearTimeout(t);
  }, [overrides]);

  const byTier = useMemo(() => {
    if (!plan) return [];
    return (['primary', 'secondary', 'tertiary'] as RoadTier[]).map((tier) => {
      const rs = plan.roads.filter((r) => r.tier === tier);
      return {
        tier,
        count: rs.length,
        km: rs.reduce((s, r) => s + r.lengthM, 0) / 1000,
        asIs: rs.filter((r) => r.withinLimitAsIs).length,
        limit: rs[0]?.limit ?? 0,
        cut: rs.reduce((s, r) => s + r.cutM3, 0),
        fill: rs.reduce((s, r) => s + r.fillM3, 0),
      };
    });
  }, [plan]);

  const byUse = useMemo(() => {
    if (!plan) return [];
    const m = new Map<Typology, { area: number; blocks: number }>();
    for (const b of plan.blocks) {
      const e = m.get(b.typology) ?? { area: 0, blocks: 0 };
      e.area += b.areaM2;
      e.blocks += 1;
      m.set(b.typology, e);
    }
    return [...m.entries()].sort((a, b) => b[1].area - a[1].area);
  }, [plan]);

  const plotStats = useMemo(() => {
    if (!plan) return null;
    const ps = plan.plots;
    return {
      n: ps.length,
      asIs: ps.filter((p) => p.platform.withinLimitAsIs).length,
      cut: ps.reduce((s, p) => s + p.platform.cutM3, 0),
      fill: ps.reduce((s, p) => s + p.platform.fillM3, 0),
      maxDepth: ps.reduce((s, p) => Math.max(s, p.platform.maxCutM, p.platform.maxFillM), 0),
    };
  }, [plan]);

  return (
    <>
      <Panel
        title="Steps 8–16 · the plan"
        right={
          <button
            onClick={() => runPipeline(overrides)}
            disabled={planStatus.running}
            className="rounded border border-line px-2 py-0.5 text-[10px] text-muted hover:text-fg disabled:opacity-50"
          >
            {planStatus.running ? 'planning…' : 'Re-plan'}
          </button>
        }
      >
        {planStatus.running && <div className="mb-1 text-[10px] text-accent">{planStatus.message}</div>}
        {planStatus.error && <div className="mb-1 text-[10px] text-bad">{planStatus.error}</div>}
        {!plan ? (
          <div className="text-[11px] text-muted">Working out roads, blocks, plots and buildings…</div>
        ) : (
          <div className="flex flex-col gap-1 text-[11px]">
            <div className="text-[10px] text-muted">
              Planned in {(planMs / 1000).toFixed(1)} s. Every block's use and every road's line come from the layers above.
            </div>

            <div className="mt-1 font-semibold text-fg">What the programme asked, and what fits</div>
            <table className="w-full text-[10px]">
              <tbody>
                {plan.programme.map((r) => (
                  <tr key={r.use} className="border-b border-line/30 align-top" title={r.note}>
                    <td className="py-0.5 pr-1 text-fg">{r.use}</td>
                    <td className="py-0.5 pr-1 text-muted">{r.asked}</td>
                    <td className={`py-0.5 text-right ${r.met ? 'text-accent' : 'text-warn'}`}>{r.placed}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-2 font-semibold text-fg">Step 8 · roads</div>
            <Row
              label="Existing roads (fixed)"
              value={`${fmt(plan.existingRoads.lengthM)} m · ${fmt(plan.existingRoads.overLimitM)} m over 1:${Math.round(1 / plan.existingRoads.limit)}`}
              hint={`steepest ${(plan.existingRoads.maxGrade * 100).toFixed(0)}%; checked, never moved`}
            />
            {byTier.map((t) => (
              <Row
                key={t.tier}
                label={`${t.tier[0]!.toUpperCase()}${t.tier.slice(1)} (1:${t.limit ? Math.round(1 / t.limit) : '–'})`}
                value={`${t.count} · ${t.km.toFixed(2)} km · ${t.asIs}/${t.count} as the ground lies`}
                hint={`the rest are graded to the limit: cut ${fmt(t.cut)} m³, fill ${fmt(t.fill)} m³`}
              />
            ))}

            <div className="mt-2 font-semibold text-fg">Step 12 · blocks by use</div>
            {byUse.map(([use, v]) => (
              <div key={use} className="flex items-center gap-2 text-[11px]">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: rgba(TYPOLOGY_RGB[use], 0.85) }} />
                <span className="flex-1 text-muted">{TYPOLOGY_LABEL[use]}</span>
                <span className="font-mono text-muted">
                  {(v.area / AC).toFixed(1)} ac · {v.blocks}
                </span>
              </div>
            ))}

            {plotStats && (
              <>
                <div className="mt-2 font-semibold text-fg">Steps 9–11 · villa plots</div>
                <Row label="Plots" value={`${plotStats.n}`} hint="2,850 sq ft built on a 15 m wide plot; FSI 1.0" />
                <Row
                  label="Within 1:5 as the ground lies"
                  value={`${plotStats.asIs} of ${plotStats.n}`}
                  hint="the rest get a platform graded to 1:5, cut and fill balanced"
                />
                <Row
                  label="Plot earthwork"
                  value={`cut ${fmt(plotStats.cut)} · fill ${fmt(plotStats.fill)} m³`}
                  hint={`deepest cut or fill on any plot ${plotStats.maxDepth.toFixed(1)} m`}
                />
              </>
            )}

            <div className="mt-2 font-semibold text-fg">Step 13 · FSI by parcel</div>
            {plan.parcels
              .filter((p) => p.use !== 'villas')
              .map((p) => (
                <Row
                  key={p.id}
                  label={`${TYPOLOGY_LABEL[p.use]} · ${p.buildings} bldg`}
                  value={`FSI ${p.fsi.toFixed(2)} on ${(p.areaM2 / AC).toFixed(1)} ac`}
                  hint={`${fmt(p.builtUpM2)} m² built over ${fmt(p.areaM2)} m² of parcel`}
                />
              ))}
            <Row label="Villa plots" value="FSI 1.00 each" hint="ground floor 60% + first floor 40% of the plot" />

            <div className="mt-2 font-semibold text-fg">Earthwork, all told</div>
            <Row label="Cut / fill" value={`${fmt(plan.cutM3)} / ${fmt(plan.fillM3)} m³`} hint="roads, plot platforms and building pads" />

            {plan.notes.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-[10px] leading-snug text-warn">
                {plan.notes.map((nt) => (
                  <li key={nt}>{nt}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      {plan && (
        <Panel title="Show">
          <div className="flex flex-col gap-0.5 text-[11px]">
            {LAYERS.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={planVisible.includes(l.id)} onChange={() => togglePlan(l.id)} className="accent-accent" />
                <span className="text-muted">{l.label}</span>
              </label>
            ))}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
              {(['primary', 'secondary', 'tertiary', 'existing'] as RoadTier[]).map((t) => (
                <span key={t} className="flex items-center gap-1">
                  <span className="inline-block h-1 w-4" style={{ background: rgba(TIER_RGB[t], 1) }} />
                  {t}
                </span>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {plan && (
        <Panel title="Why each block is what it is">
          <ul className="flex max-h-64 flex-col overflow-y-auto text-[10px]">
            {plan.blocks.map((b) => (
              <li key={b.id} className="border-b border-line/30">
                <button onClick={() => setOpen(open === b.id ? null : b.id)} className="flex w-full items-center gap-2 py-0.5 text-left">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: rgba(TYPOLOGY_RGB[b.typology], 0.9) }} />
                  <span className="text-fg">{b.id}</span>
                  <span className="flex-1 text-muted">{TYPOLOGY_LABEL[b.typology]}</span>
                  <span className="font-mono text-muted">{(b.areaM2 / AC).toFixed(2)} ac</span>
                </button>
                {open === b.id && (
                  <ul className="mb-1 ml-4 list-disc pl-3 leading-snug text-muted">
                    {b.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                    <li>
                      mean ground 1:{(1 / Math.max(b.meanGrade, 1e-3)).toFixed(0)}; frontage {b.frontage.join(', ') || 'none'}
                    </li>
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
