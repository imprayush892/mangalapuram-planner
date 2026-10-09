import { useEffect, useRef, useState } from 'react';
import { usePresent, PRESENT_OPTIONS, FORK_STEP } from '../state/presentStore';
import type { OptionId } from '../state/presentStore';
import { useRules } from '../state/useRules';
import { pick } from '../engine/data/config';
import { GlassPanel } from './shell/Glass';

/**
 * The presentation's financial figures (owner 9 Oct): the owner's draft financial model, re-run in Excel for each
 * master plan (config/financials_draft_model.yaml, tools/finance/run_model.py). Shown from the fork on, for the
 * option on screen; switching options moves the numbers, and each carries its change against D1 (D1's own against
 * the model as given). M hides and shows it.
 */

interface Metric {
  key: string;
  label: string;
  cell: string;
  unit: string;
  better: 'up' | 'down';
}
interface Case {
  label: string;
  villas?: number;
  villas_by_phase?: number[];
  values: Record<string, number | null>;
  text: Record<string, string>;
}

const MAIN = ['pat_cr', 'project_irr', 'promoter_irr', 'revenue_cr', 'cost_cr', 'peak_funding_cr'];
const MORE = ['units', 'villa_units', 'villa_revenue_cr', 'pat_margin', 'promoter_money_cr', 'interest_cr'];

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const cr = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmt(m: Metric, v: number): string {
  if (m.unit === '%') return pct(v);
  if (m.unit === 'count') return Math.round(v).toLocaleString('en-IN');
  return cr(v);
}

function delta(m: Metric, v: number, ref: number): { text: string; tone: string } | null {
  const d = v - ref;
  if (Math.abs(d) < (m.unit === '%' ? 0.0005 : m.unit === 'count' ? 0.5 : 0.05)) return { text: 'same', tone: 'text-muted' };
  const good = (d > 0) === (m.better === 'up');
  const sign = d > 0 ? '+' : '−';
  const a = Math.abs(d);
  const text = m.unit === '%' ? `${sign}${(a * 100).toFixed(1)} pts` : m.unit === 'count' ? `${sign}${Math.round(a)}` : `${sign}${cr(a)}`;
  return { text, tone: good ? 'text-good' : 'text-bad' };
}

/** A number that runs to its new value when the option changes. */
function useTween(target: number, ms = 450): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number): void => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - (1 - k) ** 3;
      const x = a + (target - a) * e;
      setV(x);
      from.current = x;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Tile({ m, v, base, refName }: { m: Metric; v: number; base: number | null; refName: string }): React.ReactElement {
  const t = useTween(v);
  const d = base === null ? null : delta(m, v, base);
  return (
    <div className="rounded-md border border-line/70 bg-panel-2/60 px-2.5 py-1.5" title={`${m.label} · One-Page Summary ${m.cell}`}>
      <p className="truncate text-[10px] leading-tight text-muted">
        {m.label}
        {m.unit === '₹ Cr' && <span className="text-muted/70"> · ₹ Cr</span>}
      </p>
      <p className="num text-[20px] font-semibold leading-tight tabular-nums text-fg">{fmt(m, t)}</p>
      {d && (
        <p className={`text-[10px] leading-tight tabular-nums ${d.tone}`} title={`against ${refName}`}>
          {d.text}
        </p>
      )}
    </div>
  );
}

/** A secondary figure: one line, its change beside it. */
function Line({ m, v, base, refName }: { m: Metric; v: number; base: number | null; refName: string }): React.ReactElement {
  const t = useTween(v);
  const d = base === null ? null : delta(m, v, base);
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/40 py-0.5" title={`${m.label} · One-Page Summary ${m.cell} · against ${refName}`}>
      <span className="truncate text-[11px] text-muted">{m.label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="num text-[12px] font-semibold tabular-nums text-fg">
          {fmt(m, t)}
          {m.unit === '₹ Cr' && <span className="ml-0.5 text-[9px] font-normal text-muted">Cr</span>}
        </span>
        {d && <span className={`w-[52px] text-right text-[10px] tabular-nums ${d.tone}`}>{d.text}</span>}
      </span>
    </div>
  );
}

export default function PresentFinance(): React.ReactElement | null {
  const step = usePresent((s) => s.step);
  const option = usePresent((s) => s.option);
  const plan = usePresent((s) => s.plans[s.option]);
  const choose = usePresent((s) => s.choose);
  const rules = useRules();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'm' || e.key === 'M') setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const doc = rules?.financials;
  const metrics = pick<Metric[]>(doc, 'metrics', []);
  const cases = pick<Record<string, Case>>(doc, 'cases', {});
  const cur = cases[option];
  if (step < FORK_STEP || !cur || metrics.length === 0) return null;
  const by = new Map(metrics.map((m) => [m.key, m]));
  const refId = option === 'D1' ? 'model' : 'D1';
  const refCase = cases[refId];
  const refName = option === 'D1' ? 'the model as given' : 'D1';
  const stale = plan && cur.villas !== undefined && plan.plots.length !== cur.villas;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="pointer-events-auto absolute left-4 top-16 z-30 rounded-md border border-line bg-panel/90 px-2.5 py-1 text-[11px] text-muted hover:text-fg"
        title="Show the financials (M)"
      >
        ₹ Financials · {option}
      </button>
    );
  }

  const tile = (k: string, big: boolean): React.ReactElement | null => {
    const m = by.get(k);
    const v = cur.values[k];
    if (!m || v === null || v === undefined) return null;
    const r = refCase?.values[k] ?? null;
    return big ? <Tile key={k} m={m} v={v} base={r} refName={refName} /> : <Line key={k} m={m} v={v} base={r} refName={refName} />;
  };
  const pat = by.get('pat_cr');
  const irr = by.get('project_irr');
  const maxPat = Math.max(...PRESENT_OPTIONS.map((o) => cases[o.id]?.values.pat_cr ?? 0));

  return (
    <div className="pointer-events-none absolute left-4 top-16 z-30">
      <GlassPanel className="pointer-events-auto relative max-h-[calc(100vh-17rem)] w-[400px] max-w-[calc(100vw-2rem)] overflow-y-auto px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide the financials (M brings them back)"
          aria-label="Hide the financials"
          className="absolute right-2.5 top-2.5 rounded px-1.5 text-[13px] leading-none text-muted hover:bg-line/60 hover:text-fg"
        >
          ✕
        </button>
        <p className="text-[10px] uppercase tracking-[0.22em] text-accent">Financials · {option}</p>
        <h3 className="mt-0.5 pr-6 text-[15px] font-semibold leading-tight text-fg">{cur.label}</h3>
        <p className="mb-2 text-[11px] leading-snug text-muted">
          The draft model run on this plan{cur.villas_by_phase ? ` (${cur.villas_by_phase.join(' · ')} villas by phase)` : ''}; changes against{' '}
          <span className="text-fg">{refName}</span>
        </p>
        <div className="grid grid-cols-3 gap-1.5">{MAIN.map((k) => tile(k, true))}</div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-4">{MORE.map((k) => tile(k, false))}</div>
        {pat && irr && (
          <div className="mt-2">
            <p className="mb-0.5 text-[10px] uppercase tracking-wider text-muted">The plans · PAT, ₹ Cr · project IRR</p>
            {PRESENT_OPTIONS.map((o) => {
              const c = cases[o.id];
              if (!c) return null;
              const on = o.id === option;
              const p = c.values.pat_cr ?? 0;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => choose(o.id as OptionId)}
                  title={o.label}
                  className={`grid w-full grid-cols-[26px_1fr_64px_44px] items-center gap-2 rounded px-1 py-px text-left ${on ? 'bg-accent/15' : 'hover:bg-line/40'}`}
                >
                  <span className={`text-[11px] font-semibold ${on ? 'text-accent' : 'text-fg'}`}>{o.id}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-line/60">
                    <span className={`block h-full rounded-full ${on ? 'bg-accent' : 'bg-muted/60'}`} style={{ width: `${(p / maxPat) * 100}%` }} />
                  </span>
                  <span className="num text-right text-[11px] tabular-nums text-fg">₹{cr(p)}</span>
                  <span className="num text-right text-[11px] tabular-nums text-muted">{pct(c.values.project_irr ?? 0)}</span>
                </button>
              );
            })}
          </div>
        )}
        {stale && (
          <p className="mt-2 text-[10px] leading-snug text-warn">
            This plan now has {plan!.plots.length} villas; the model was run on {cur.villas}. Re-run tools/finance/run_model.py.
          </p>
        )}
        <p className="mt-1.5 text-[9.5px] leading-snug text-muted/80">
          Draft model.xlsx re-run per plan ({pick<string>(doc, 'run', '')}) · M hides
        </p>
      </GlassPanel>
    </div>
  );
}
