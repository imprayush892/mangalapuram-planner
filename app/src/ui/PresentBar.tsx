import { useEffect, useMemo } from 'react';
import { FORK_STEP, PRESENT_OPTIONS, PRESENT_STEPS, usePresent } from '../state/presentStore';
import { useAnalysisForViews } from '../state/planningStore';
import { useSite } from '../state/store';
import { useRules } from '../state/useRules';
import { pick } from '../engine/data/config';
import type { AnalysisResult } from '../engine/pipeline/analysis';
import type { PlanResult } from '../engine/pipeline/plan';
import type { Dem } from '../engine/terrain/dem';
import { GlassPanel } from './shell/Glass';

const AC = 4046.8564224;
const ac = (m2: number): string => (m2 / AC).toFixed(1);
const n0 = (v: number): string => Math.round(v).toLocaleString('en-IN');

/** One sentence per step, with the number the step turns on. */
function caption(key: string, a: AnalysisResult | null, dem: Dem | null, plan: PlanResult | undefined, stormMm: number): string {
  const L = a?.layers;
  switch (key) {
    case 'terrain': {
      if (!L || !dem) return 'The surveyed ground on a 2 m grid.';
      let lo = Infinity;
      let hi = -Infinity;
      const m = L.terrain.mask;
      for (let k = 0; k < m.length; k += 1) {
        if (!m[k]) continue;
        const z = dem.values[k]!;
        if (!Number.isFinite(z)) continue;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      return `The surveyed ground on a 2 m grid: RL ${lo.toFixed(0)} to RL ${hi.toFixed(0)}, ${(hi - lo).toFixed(0)} m of fall across ${ac(L.terrain.areaM2)} ac.`;
    }
    case 'water':
      return `A ${stormMm} mm day falls on the site. The flow paths show where it runs off the crown.`;
    case 'waterlogging':
      return L ? `${ac(L.waterlogging.areaM2)} ac stands under water at the storm's peak. It becomes open space, never plots.` : '';
    case 'public':
      return L ? `${ac(L.publicSpace.areaM2)} ac is public space: the water, the steep ground, the drains, and slivers too narrow to plot.` : '';
    case 'slope':
      return L ? `${ac(L.moderateSlope.areaM2)} ac is steeper than the 1:5 plot limit. It can be built on graded platforms.` : '';
    case 'nonbuildable':
      return L
        ? `KMBR Rule 22: slopes over 45°, flood-liable land and natural drains stay unbuilt, ${ac(L.nonBuildable.areaM2 + L.drains.areaM2)} ac in all.`
        : '';
    case 'plotable':
      return L ? `${ac(L.plotable.areaM2)} ac is left that can take plots, ${Math.round(L.plotable.share * 100)}% of the site.` : '';
    case 'zoning':
      return "The client's zoning sets where each use goes. The plan leaves it only where water or slope demand.";
    case 'roads': {
      if (!plan) return 'Laying the roads…';
      const km = plan.roads.reduce((s, r) => s + r.lengthM, 0) / 1000;
      return `${km.toFixed(1)} km of new roads, primary, secondary and tertiary, each held to its gradient limit.`;
    }
    case 'plots': {
      if (!plan) return 'Laying the plots…';
      const avg = plan.plots.reduce((s, p) => s + p.areaM2, 0) / Math.max(1, plan.plots.length);
      return `${plan.plots.length} villa plots, typically ${n0(avg * 10.7639)} sq ft. Pick a master plan below.`;
    }
    case 'earthwork':
      return plan ? `Every plot's platform held to 1:5: ${n0(plan.cutM3)} m³ of cut and ${n0(plan.fillM3)} m³ of fill, roads included.` : '';
    case 'typologies':
      return plan ? `Every block takes its use from the zoning. Golf lies on ${ac(plan.golf.areaM2)} ac of gentle open ground by the clubhouse.` : '';
    case 'towers': {
      if (!plan) return '';
      const t = plan.buildings.filter((b) => b.typology === 'apartments');
      const floors = t.map((b) => b.floors);
      return `${t.length} towers of 16,500 sq ft, ${Math.min(...floors)}–${Math.max(...floors)} floors, on the lower ground. Every top stays under the airport's ${plan.airport.capAmslM} m AMSL line.`;
    }
    case 'placement':
      return 'The school, the clubhouse, senior living, commercial and the batching plant, each as one compact group in its zone.';
    case 'massing':
      return plan ? `${plan.plots.length} villas, ground and first floor, each on its own platform.` : '';
    case 'masterplan':
      return plan
        ? `${plan.plots.length} villas, ${plan.buildings.filter((b) => b.typology === 'apartments').length} towers, ${(plan.roads.reduce((s, r) => s + r.lengthM, 0) / 1000).toFixed(1)} km of new roads.`
        : '';
    default:
      return '';
  }
}

/**
 * The presenter's bar: where the reveal has got to, what the step shows, the
 * six master plans once the plots are laid, and Back / Next. Arrow keys,
 * Page Up / Down (a clicker) and the space bar step; 1-6 pick a plan; Esc ends.
 */
export default function PresentBar(): React.ReactElement {
  const { step, option, plans, prep, errors, next, back, go, choose, stop } = usePresent();
  const s = PRESENT_STEPS[step]!;
  const analysis = useAnalysisForViews();
  const site = useSite((st) => st.site);
  const rules = useRules();
  const stormMm = pick<number>(rules?.planning, 'hydrology.planning_storm_mm', 300);
  const plan = plans[option];
  const forked = step >= FORK_STEP;
  const waiting = s.plan.length > 0 && !plan;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        usePresent.getState().next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        usePresent.getState().back();
      } else if (e.key === 'Escape') {
        usePresent.getState().stop();
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= PRESENT_OPTIONS.length && usePresent.getState().step >= FORK_STEP) {
        usePresent.getState().choose(PRESENT_OPTIONS[Number(e.key) - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const text = useMemo(() => caption(s.key, analysis, site?.dem ?? null, plan, stormMm), [s.key, analysis, site, plan, stormMm]);
  const current = PRESENT_OPTIONS.find((o) => o.id === option)!;

  return (
    <GlassPanel className="pointer-events-auto w-full max-w-[860px] px-5 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-accent">
          {s.num === '0' ? 'The zoning' : `Step ${s.num}`}
          {forked && (
            <span className="text-muted">
              {' '}
              · {current.id} · {current.label}
            </span>
          )}
        </p>
        <button type="button" onClick={stop} className="text-[11px] text-muted hover:text-fg" title="End the presentation (Esc)">
          End ✕
        </button>
      </div>
      <h2 className="mt-1 text-[22px] font-semibold leading-tight text-fg">{s.title}</h2>
      <p className="mt-1 min-h-[20px] text-[13px] leading-snug text-muted">
        {waiting ? `Preparing ${current.id}: ${prep[option] ?? errors[option] ?? 'waiting…'}` : text}
      </p>

      {forked && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {PRESENT_OPTIONS.map((o, i) => {
            const ready = Boolean(plans[o.id]);
            const on = o.id === option;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => choose(o.id)}
                title={`${o.label} (key ${i + 1})`}
                className={`rounded border px-2 py-1.5 text-left transition ${
                  on ? 'border-accent bg-accent/15' : 'border-line hover:border-accent/60'
                }`}
              >
                <span className={`block text-[13px] font-semibold ${on ? 'text-accent' : 'text-fg'}`}>{o.id}</span>
                <span className="block text-[10px] leading-tight text-muted">{o.label}</span>
                <span className="block text-[10px] leading-tight text-muted">
                  {ready ? (
                    `${plans[o.id]!.plots.length} villas`
                  ) : errors[o.id] ? (
                    <span className="text-bad">failed</span>
                  ) : (
                    `preparing… ${prep[o.id] ?? ''}`.slice(0, 40)
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={back}
          disabled={step === 0}
          className="rounded border border-line px-3 py-1 text-[12px] text-fg hover:border-accent/60 disabled:opacity-30"
        >
          ◀ Back
        </button>
        <div className="flex items-center gap-1.5">
          {PRESENT_STEPS.map((p, i) => (
            <button
              key={p.key}
              type="button"
              onClick={() => go(i)}
              title={p.title}
              aria-label={p.title}
              className={`h-2 rounded-full transition-all ${
                i === step ? 'w-6 bg-accent' : i < step ? 'w-2 bg-accent/50' : 'w-2 bg-line'
              } ${i === FORK_STEP ? 'ring-1 ring-accent/60 ring-offset-1 ring-offset-transparent' : ''}`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={next}
          disabled={step === PRESENT_STEPS.length - 1}
          className="rounded border border-accent/70 bg-accent/15 px-3 py-1 text-[12px] font-semibold text-accent hover:bg-accent/25 disabled:opacity-30"
        >
          Next ▶
        </button>
      </div>
    </GlassPanel>
  );
}
