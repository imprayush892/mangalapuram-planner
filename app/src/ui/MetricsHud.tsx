import { useEffect, useRef, useState } from 'react';
import { useLiveMetrics } from '../state/useLiveMetrics';
import { useMasterPlan } from '../state/masterPlanStore';
import { builtMetrics } from '../engine/metrics/live';
import { m2ToSft } from '../engine/units';
import { useUi } from '../state/uiStore';

const fmt = (n: number | undefined, d = 0): string =>
  n === undefined || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });

/**
 * A figure that shows where it is going as well as where it is.
 *
 * The number itself is what the rules give for the current settings, so it moves
 * the instant a control does. The small figure under it is what the last drawn
 * plan actually achieved — the two are never the same thing, and collapsing
 * them into one number would be the lie that makes this kind of tool useless.
 */
function Metric({
  label,
  value,
  built,
  decimals = 0,
  suffix,
  breached,
  hint,
}: {
  label: string;
  value: number | undefined;
  built?: number;
  decimals?: number;
  suffix?: string;
  breached?: boolean;
  hint?: string;
}): React.ReactElement {
  const prev = useRef<number | undefined>(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (prev.current !== undefined && value !== undefined && value !== prev.current) {
      setFlash(value > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 450);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  const drift =
    built !== undefined && value !== undefined && Math.abs(built - value) > (decimals === 0 ? 0.5 : 0.01);

  return (
    <div className="py-1" title={hint}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] text-muted">{label}</span>
        <span
          className={`num text-[13px] tabular-nums transition-colors duration-300 ${
            breached ? 'text-bad' : flash === 'up' ? 'text-good' : flash === 'down' ? 'text-warn' : 'text-fg'
          }`}
        >
          {fmt(value, decimals)}
          {suffix ? <span className="ml-0.5 text-[10px] text-muted">{suffix}</span> : null}
        </span>
      </div>
      {drift && (
        <div className="flex justify-end text-[10px] text-muted">
          drawn {fmt(built, decimals)}
        </div>
      )}
    </div>
  );
}

export default function MetricsHud(): React.ReactElement {
  const live = useLiveMetrics();
  const plan = useMasterPlan((s) => s.plan);
  const status = useMasterPlan((s) => s.status);
  const hovered = useUi((s) => s.hoveredConstraint);
  const built = builtMetrics(plan);

  if (!live) return <div className="px-3 pb-3 text-[11px] text-muted">Waiting for the site to load…</div>;

  const breach = (id: string): boolean => live.constraints.find((c) => c.id === id)?.breached ?? false;
  const breaches = live.constraints.filter((c) => c.breached);

  return (
    <div className="px-3 pb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted">If it were built</span>
        <span className="text-[10px] text-muted">{live.elapsedMs.toFixed(1)} ms</span>
      </div>

      <Metric label="Dwellings" value={live.dwellings} built={built?.dwellings} />
      <Metric label="Villa plots" value={live.villaPlots} built={built?.villaPlots} />
      <Metric label="Towers" value={live.towers} built={built?.towers} />
      <Metric label="Flats" value={live.flats} built={built?.flats} />

      <div className="my-1.5 h-px bg-line" />

      <Metric
        label="Saleable floor area"
        value={m2ToSft(live.floorAreaM2)}
        built={built ? m2ToSft(built.floorAreaM2 ?? 0) : undefined}
        suffix="sft"
        hint="Plinth over every floor, from the rules"
      />
      <Metric
        label="FSI used"
        value={live.fsi}
        built={built?.fsi}
        decimals={2}
        breached={breach('fsi')}
        hint="Against the KMBR Table 6 tier"
      />
      <Metric
        label="Coverage"
        value={live.coveragePct}
        built={built?.coveragePct}
        decimals={1}
        suffix="%"
        breached={breach('coverage')}
      />
      <Metric label="Population" value={live.population} built={built?.population} />
      <Metric label="Parking" value={live.parkingCars} suffix="cars" hint="KMBR Tables 9 and 10" />
      <Metric label="Land planned" value={live.landAc} built={built?.landAc} decimals={2} suffix="ac" />

      {breaches.length > 0 && (
        <div className="mt-2 rounded border border-bad/50 bg-bad/10 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-bad">
            {breaches.length} limit{breaches.length === 1 ? '' : 's'} crossed
          </div>
          {breaches.map((c) => (
            <div
              key={c.id}
              className={`mt-0.5 text-[10px] leading-snug ${hovered === c.id ? 'text-fg' : 'text-muted'}`}
            >
              <span className="text-bad">{c.label}</span> — {c.message}
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 text-[10px] leading-snug text-muted">
        {status.running ? (
          <span className="text-accent">
            Redrawing the plan… {status.total > 0 ? `${status.done}/${status.total}` : ''}
          </span>
        ) : plan ? (
          <>Plan drawn {plan.zones.length} zones in {(plan.elapsedMs / 1000).toFixed(1)} s. Figures above are the rules; “drawn” is what the ground took.</>
        ) : (
          <>These are the rules applied to the current settings. The plan has not been drawn yet.</>
        )}
      </div>

      {live.byUse.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Land by use</div>
          {live.byUse.map((u) => (
            <div key={u.use} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="truncate text-[11px] text-muted">{u.label}</span>
              <span className="num shrink-0 text-[11px] text-fg">{u.landAc.toFixed(2)} ac</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
