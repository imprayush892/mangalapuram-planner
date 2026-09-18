import { useMemo, useState } from 'react';
import { useRules } from '../state/useRules';
import { useSettings } from '../state/settingsStore';
import { useGoal } from '../state/goalStore';
import { useLiveMetrics } from '../state/useLiveMetrics';
import { useUi } from '../state/uiStore';
import { coverageFsi } from '../engine/rules/kmbr';
import { normaliseGoal } from '../engine/optimise/goal';
import { pick } from '../engine/data/config';
import type { BandName } from '../engine/rules/client';

const MIXES: { value: string; label: string; mix: BandName[] }[] = [
  { value: '2+3', label: '2+3', mix: ['2BHK', '3BHK'] },
  { value: '3+4', label: '3+4', mix: ['3BHK', '4BHK'] },
  { value: '4+5', label: '4+5', mix: ['4BHK', '5BHK'] },
];

/**
 * One permanent strip of levers along the bottom.
 *
 * These are the point of the tool, so they are never inside an accordion and
 * never more than one gesture away. Each names what it changes on hover, shows
 * its legal band on its own track, and turns red — not blocked — when it is
 * pushed past a rule.
 */
function Lever({
  label,
  does,
  value,
  display,
  min,
  max,
  step = 1,
  legalMin,
  legalMax,
  breached,
  message,
  onChange,
  constraintId,
}: {
  label: string;
  does: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  legalMin?: number;
  legalMax?: number;
  breached?: boolean;
  message?: string;
  onChange: (v: number) => void;
  constraintId?: string;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const setHovered = useUi((s) => s.setHoveredConstraint);
  const pct = (v: number): number => ((v - min) / Math.max(1e-9, max - min)) * 100;

  return (
    <div
      className="relative min-w-0 flex-1 px-2 py-1.5"
      onPointerEnter={() => {
        setHover(true);
        if (constraintId) setHovered(constraintId);
      }}
      onPointerLeave={() => {
        setHover(false);
        if (constraintId) setHovered(null);
      }}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[10px] uppercase tracking-wide text-muted">{label}</span>
        <span className={`num shrink-0 text-[11px] ${breached ? 'text-bad' : 'text-fg'}`}>{display}</span>
      </div>
      <div className="relative mt-0.5">
        {(legalMin !== undefined || legalMax !== undefined) && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded">
            <div
              className="absolute h-full bg-good/25"
              style={{
                left: `${Math.max(0, pct(legalMin ?? min))}%`,
                width: `${Math.max(0, pct(legalMax ?? max) - pct(legalMin ?? min))}%`,
              }}
            />
          </div>
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`relative w-full cursor-pointer ${breached ? 'accent-bad' : 'accent-accent'}`}
        />
      </div>
      {hover && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 w-56 -translate-x-1/2 rounded-lg border border-line/80 bg-panel/95 px-2.5 py-2 shadow-xl backdrop-blur-md">
          <div className="text-[11px] font-semibold text-fg">{label}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-muted">{does}</div>
          {message && (
            <div className={`mt-1 text-[10px] leading-snug ${breached ? 'text-bad' : 'text-good'}`}>{message}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LeverStrip(): React.ReactElement {
  const rules = useRules();
  const switches = useSettings((s) => s.switches);
  const setSwitch = useSettings((s) => s.setSwitch);
  const { goal, set: setGoal } = useGoal();
  const metrics = useLiveMetrics();
  const normal = useMemo(() => normaliseGoal(goal), [goal]);

  const constraint = (id: string) => metrics?.constraints.find((c) => c.id === id);
  const fsiTiers = useMemo(() => (rules ? coverageFsi(rules.kmbr, 'A1').fsiTiers : [3]), [rules]);
  const perFloor = useMemo(
    () => (rules ? pick<{ min: number; max: number }>(rules.client, 'apartments.flats_per_floor', { min: 4, max: 6 }) : { min: 4, max: 6 }),
    [rules],
  );
  const maxFloors = useMemo(() => (rules ? pick<number>(rules.client, 'apartments.max_floors', 20) : 20), [rules]);
  const towerFloors = Math.max(...switches.towerFloorOptions, 1);
  const mixValue = MIXES.find((m) => m.mix.join() === switches.apartmentMix.join())?.value ?? '2+3';

  if (!rules) return <div className="px-3 py-2 text-[11px] text-muted">Loading the rules…</div>;

  return (
    <div className="flex flex-wrap items-stretch divide-x divide-line/60">
      {/* the goal: three weights, the thing everything else is optimised against */}
      <Lever
        label="Space"
        does="How much the engine cares about fitting the programme in: more plots, more floor area, zones filled harder."
        value={goal.space}
        display={`${Math.round(normal.space * 100)}%`}
        min={0}
        max={5}
        step={0.5}
        onChange={(v) => setGoal({ space: v })}
      />
      <Lever
        label="Terrain"
        does="How much it cares about working with the ground: flatter plots, flatter streets, least cut and fill."
        value={goal.terrain}
        display={`${Math.round(normal.terrain * 100)}%`}
        min={0}
        max={5}
        step={0.5}
        onChange={(v) => setGoal({ terrain: v })}
      />
      <Lever
        label="Water"
        does="How much it organises around water: wider watercourse buffers, ponding ground taken out, uses placed by how they suit the hydrology."
        value={goal.water}
        display={`${Math.round(normal.water * 100)}%`}
        min={0}
        max={5}
        step={0.5}
        onChange={(v) => setGoal({ water: v })}
      />

      {/* what to build */}
      <Lever
        label="FSI"
        does="Which KMBR Table 6 tier to build to. A higher tier buys floor area and towers, and costs fees."
        value={switches.fsiTierIndex}
        display={String(fsiTiers[switches.fsiTierIndex] ?? fsiTiers[0])}
        min={0}
        max={Math.max(0, fsiTiers.length - 1)}
        onChange={(v) => setSwitch('fsiTierIndex', Math.round(v))}
        breached={constraint('fsi')?.breached}
        message={constraint('fsi')?.message}
        constraintId="fsi"
      />
      <Lever
        label="Floors"
        does="Tallest tower the generator will try. Taller towers mean fewer of them on the same floor area."
        value={towerFloors}
        display={`${towerFloors}`}
        min={4}
        max={30}
        legalMax={maxFloors}
        onChange={(v) =>
          setSwitch('towerFloorOptions', [
            Math.max(4, Math.round(v * 0.6)),
            Math.round(v * 0.8),
            Math.round(v),
          ])
        }
        breached={constraint('towerFloors')?.breached}
        message={constraint('towerFloors')?.message}
        constraintId="towerFloors"
      />
      <Lever
        label="Flats / floor"
        does="Flats on each tower floor. More flats per floor is a bigger plate, so fewer towers carry the same area."
        value={switches.flatsPerFloor}
        display={`${switches.flatsPerFloor}`}
        min={2}
        max={10}
        legalMin={perFloor.min}
        legalMax={perFloor.max}
        onChange={(v) => setSwitch('flatsPerFloor', Math.round(v))}
        breached={constraint('flatsPerFloor')?.breached}
        message={constraint('flatsPerFloor')?.message}
        constraintId="flatsPerFloor"
      />

      <div className="flex min-w-0 flex-col justify-center px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-muted">Mix</span>
        <div className="mt-0.5 flex gap-0.5">
          {MIXES.map((m) => (
            <button
              key={m.value}
              type="button"
              title={`${m.label} BHK — larger flats mean fewer of them in the same floor area`}
              onClick={() => setSwitch('apartmentMix', m.mix)}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition ${
                mixValue === m.value
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-line text-muted hover:text-fg'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
