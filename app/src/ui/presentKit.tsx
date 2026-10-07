import { TYPOLOGY_RGB } from './planningStyle';
import type { Typology } from '../engine/pipeline/plan';

/** Shared pieces of the presentation's figure cards (PresentFigures, PresentStats). */

export const AC = 4046.8564224;
export const n0 = (v: number): string => Math.round(v).toLocaleString('en-IN');
export const n1 = (v: number): string => v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const acs = (m2: number, d = 1): string => (m2 / AC).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const rgb = (t: [number, number, number]): string => `rgb(${t[0]},${t[1]},${t[2]})`;

/** The colour the plan gives each product type, so the figures read against the map behind them. */
export function colourOf(use: string): string {
  const u = use.toLowerCase();
  const t: Typology | null = u.startsWith('apart')
    ? 'apartments'
    : u.startsWith('villa')
      ? 'villas'
      : u.startsWith('senior')
        ? 'senior'
        : u.startsWith('retail')
          ? 'retail'
          : u.includes('office') && !u.startsWith('sales')
            ? 'office'
            : u.startsWith('school')
              ? 'school'
              : u.startsWith('hospital')
                ? 'hospital'
                : u.startsWith('club')
                  ? 'clubhouse'
                  : u.includes('open space') || u === 'park'
                    ? 'park'
                    : null;
  return t ? rgb(TYPOLOGY_RGB[t]) : 'rgb(120,130,136)';
}

export function Heading({ kicker, title, sub }: { kicker: string; title: string; sub?: string }): React.ReactElement {
  return (
    <div className="mb-4 pr-6">
      <p className="text-[10px] uppercase tracking-[0.22em] text-accent">{kicker}</p>
      <h3 className="mt-1 text-[22px] font-semibold leading-tight text-fg">{title}</h3>
      {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
    </div>
  );
}

/** A headline figure with its label: the step's one number, large. */
export function Big({ value, unit, label }: { value: string; unit?: string; label: string }): React.ReactElement {
  return (
    <div className="mb-3">
      <p className="num text-[38px] font-semibold leading-none tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1.5 text-[16px] font-normal text-muted">{unit}</span>}
      </p>
      <p className="mt-1 text-[12px] text-muted">{label}</p>
    </div>
  );
}

export function Tiles({ items }: { items: [string, string, string?][] }): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map(([k, v, hint]) => (
        <div key={k} className="rounded-md border border-line/70 bg-panel-2/60 px-2.5 py-2" title={hint}>
          <p className="text-[10px] leading-tight text-muted">{k}</p>
          <p className="num mt-0.5 text-[16px] font-semibold tabular-nums text-fg">{v}</p>
        </div>
      ))}
    </div>
  );
}

/** Horizontal bars, each against the largest (or a given total). */
export function Bars({
  rows,
  total,
  unit = 'ac',
}: {
  rows: { label: string; value: number; colour: string; note?: string }[];
  total?: number;
  unit?: string;
}): React.ReactElement {
  const max = total ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[150px_1fr_84px] items-center gap-3">
          <span className="truncate text-[12px] text-fg/90" title={r.note}>
            {r.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-line/50">
            <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (r.value / max) * 100)}%`, background: r.colour }} />
          </span>
          <span className="num text-right text-[12px] tabular-nums text-fg">
            {r.value.toLocaleString('en-IN', { maximumFractionDigits: unit === 'ac' ? 1 : 0 })}
            <span className="ml-0.5 text-[10px] text-muted">{unit}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
