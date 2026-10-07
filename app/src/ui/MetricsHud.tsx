import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveMetrics } from '../state/useLiveMetrics';
import { useMasterPlan } from '../state/masterPlanStore';
import { builtMetrics } from '../engine/metrics/live';
import { m2ToSft } from '../engine/units';
import { useEditedSite } from '../state/useEditedSite';
import { unmeasuredAcIn } from '../engine/terrain/fill';
import { usePlanning } from '../state/planningStore';

function PipelineRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-[11px]">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-fg">{value}</span>
    </div>
  );
}
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
  const site = useEditedSite();
  const fill = site?.filled ?? null;
  // Unmeasured ground inside the parcel, which is what the plan is built on.
  const unsurveyedAc = useMemo(
    () => (site ? unmeasuredAcIn(site.dem, site.measured, site.parcel) : 0),
    [site],
  );
  const built = builtMetrics(plan);
  const pipeline = usePlanning((s) => s.plan);

  if (!live) return <div className="px-3 pb-3 text-[11px] text-muted">Waiting for the site to load…</div>;

  // The draft model (owner 7 Oct) has its own programme and zones: the earlier engine's figures and its land by
  // use come from the client's programme, so on this basis the panel shows the plan's own instead.
  const draft = pipeline?.option.basis === 'draft_model';
  const flats = pipeline
    ? draft
      ? pipeline.option.apartmentUnits
      : pipeline.buildings.filter((b) => b.typology === 'apartments').reduce((s, b) => s + b.units, 0)
    : 0;
  const otherUnits = pipeline ? pipeline.buildings.filter((b) => b.typology !== 'apartments').reduce((s, b) => s + b.units, 0) : 0;
  const landByUse = pipeline
    ? // Parks net of the streets that run through the green pockets: the model's open space is net land.
      [...pipeline.zones.reduce((m, z) => m.set(z.use, (m.get(z.use) ?? 0) + (z.use === 'park' ? (z.openNetM2 ?? z.areaM2) : z.areaM2)), new Map<string, number>())]
        .map(([use, m2]) => ({ use, ac: m2 / 4046.8564224 }))
        .sort((a, b) => b.ac - a.ac)
    : [];
  const breach = (id: string): boolean => live.constraints.find((c) => c.id === id)?.breached ?? false;
  const breaches = live.constraints.filter((c) => c.breached);

  return (
    <div className="px-3 pb-3">
      {pipeline && (
        <div className="mb-2 rounded border border-accent/40 bg-accent/5 px-2 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-accent">The plan · steps 8–16</div>
          <PipelineRow label="Villa plots" value={pipeline.plots.length.toLocaleString()} />
          <PipelineRow
            label="Senior units"
            value={pipeline.buildings.filter((b) => b.typology === 'senior').reduce((s, b) => s + b.units, 0).toLocaleString()}
          />
          <PipelineRow label="Apartment flats" value={flats.toLocaleString()} />
          <PipelineRow label="Dwellings" value={(pipeline.plots.length + otherUnits + flats).toLocaleString()} />
          {draft && <PipelineRow label="Villa land in plots" value={`${Math.round(pipeline.option.plottedShare * 100)}%`} />}
          <PipelineRow
            label="Built-up area"
            value={`${Math.round(
              m2ToSft(pipeline.plots.reduce((s, p) => s + p.builtUpM2, 0) + pipeline.buildings.reduce((s, b) => s + b.builtUpM2, 0)),
            ).toLocaleString('en-IN')} sft`}
          />
          <PipelineRow label="Cut / fill" value={`${Math.round(pipeline.cutM3).toLocaleString()} / ${Math.round(pipeline.fillM3).toLocaleString()} m³`} />
        </div>
      )}
      {draft && landByUse.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Land by use · draft model zones</div>
          {landByUse.map((u) => (
            <div key={u.use} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="truncate text-[11px] capitalize text-muted">{u.use}</span>
              <span className="num shrink-0 text-[11px] text-fg">{u.ac.toFixed(2)} ac</span>
            </div>
          ))}
        </div>
      )}
      {!draft && (
        <>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">
            {pipeline ? 'Earlier zone-by-zone engine' : 'If it were built'}
          </span>
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

        {fill && unsurveyedAc > 0.05 && (
          <div className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-warn">Levels partly inferred</div>
            <div className="mt-0.5 text-[10px] leading-snug text-muted">
              The survey left {unsurveyedAc.toFixed(1)} ac of the parcel unmeasured. Those levels come from the terrain
              mesh or are interpolated, not read; the 3D view shades them paler the further they sit from a reading.
              Every figure above that depends on ground level carries that uncertainty.
            </div>
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
        </>
      )}
    </div>
  );
}
