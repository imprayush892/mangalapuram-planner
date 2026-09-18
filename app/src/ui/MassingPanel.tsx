import { useEffect, useMemo, useRef, useState } from 'react';
import { Slider, Choice } from './shell/Slider';
import { useRules } from '../state/useRules';
import { useSettings } from '../state/settingsStore';
import { useSiting } from '../state/sitingStore';
import { useMasterPlan } from '../state/masterPlanStore';
import { useZoneEdit } from '../state/zoneEditStore';
import { useUi } from '../state/uiStore';
import { useLiveMetrics, useZoneUses } from '../state/useLiveMetrics';
import { runMasterPlanGeneration } from '../state/generate';
import { coverageFsi } from '../engine/rules/kmbr';
import { pick } from '../engine/data/config';
import type { BandName } from '../engine/rules/client';

const MIXES: { value: string; label: string; mix: BandName[] }[] = [
  { value: '2+3', label: '2+3 BHK', mix: ['2BHK', '3BHK'] },
  { value: '3+4', label: '3+4 BHK', mix: ['3BHK', '4BHK'] },
  { value: '4+5', label: '4+5 BHK', mix: ['4BHK', '5BHK'] },
];

/**
 * The levers that change the plan, and nothing else.
 *
 * Moving one updates the figures on the right immediately, because those come
 * from the rules rather than from geometry. The drawn plan then regenerates on
 * its own a moment after the control settles: there is no Generate button,
 * only a plan that is either current or catching up.
 */
export default function MassingPanel(): React.ReactElement {
  const rules = useRules();
  const switches = useSettings((s) => s.switches);
  const setSwitch = useSettings((s) => s.setSwitch);
  const overrides = useSettings((s) => s.overrides);
  const sitingResult = useSiting((s) => s.result);
  const sitingActive = useSiting((s) => s.activeIndex);
  const zoneEdits = useZoneEdit((s) => s.edits);
  const { plan, status, chosen } = useMasterPlan();
  const advanced = useUi((s) => s.advanced);
  const setAdvanced = useUi((s) => s.setAdvanced);
  const metrics = useLiveMetrics();
  const zoneUses = useZoneUses();

  const [auto, setAuto] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRun = useRef(true);

  const constraint = (id: string) => metrics?.constraints.find((c) => c.id === id);

  const fsiTiers = useMemo(
    () => (rules ? coverageFsi(rules.kmbr, 'A1').fsiTiers : [3]),
    [rules],
  );
  const perFloor = useMemo(
    () => (rules ? pick<{ min: number; max: number }>(rules.client, 'apartments.flats_per_floor', { min: 4, max: 6 }) : { min: 4, max: 6 }),
    [rules],
  );
  const maxFloors = useMemo(
    () => (rules ? pick<number>(rules.client, 'apartments.max_floors', 20) : 20),
    [rules],
  );

  const sitingLabel = sitingResult?.alternatives[sitingActive]?.label ?? 'zone names (siting not run)';
  const towerFloors = Math.max(...switches.towerFloorOptions, 1);

  /*
   * Regeneration follows the controls rather than a button. A drag fires many
   * changes; only the last one is worth laying out, so the run waits for the
   * control to settle.
   */
  useEffect(() => {
    if (!auto || !rules) return;
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      runMasterPlanGeneration(
        overrides,
        {
          zoneUses,
          sitingLabel,
          chosen,
          minSideApplies: switches.minSideApplies,
          directions: switches.roadAngleCandidates,
          fsi: fsiTiers[switches.fsiTierIndex] ?? fsiTiers[0] ?? 3,
          floorOptions: switches.towerFloorOptions,
          apartmentMix: switches.apartmentMix,
          flatsPerFloor: switches.flatsPerFloor,
          runId: (useMasterPlan.getState().plan?.runId ?? 0) + 1,
        },
        zoneEdits,
      );
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // The plan follows the settings, the zoning and the siting; it must not
    // re-fire on its own result, so `plan` is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, switches, overrides, zoneEdits, zoneUses, sitingLabel, rules]);

  const runNow = (): void => {
    if (!rules) return;
    runMasterPlanGeneration(
      overrides,
      {
        zoneUses,
        sitingLabel,
        chosen,
        minSideApplies: switches.minSideApplies,
        directions: switches.roadAngleCandidates,
        fsi: fsiTiers[switches.fsiTierIndex] ?? fsiTiers[0] ?? 3,
        floorOptions: switches.towerFloorOptions,
        apartmentMix: switches.apartmentMix,
        flatsPerFloor: switches.flatsPerFloor,
        runId: (plan?.runId ?? 0) + 1,
      },
      zoneEdits,
    );
  };

  if (!rules) return <div className="px-3 pb-3 text-muted">Loading…</div>;

  const mixValue = MIXES.find((m) => m.mix.join() === switches.apartmentMix.join())?.value ?? '2+3';
  const fsiC = constraint('fsi');
  const floorsC = constraint('towerFloors');
  const perFloorC = constraint('flatsPerFloor');
  const villaC = constraint('villaPlinth');

  return (
    <div className="px-3 pb-3">
      <div className="mb-2 flex items-center justify-between">
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted select-none">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-3 w-3 accent-accent" />
          Redraw as I change things
        </label>
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          title="Advanced settings"
          className={`rounded border border-line px-1.5 py-0.5 text-[11px] transition ${advanced ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'}`}
        >
          ⚙
        </button>
      </div>

      {!auto && (
        <button
          type="button"
          onClick={runNow}
          disabled={status.running}
          className="mb-2 w-full rounded border border-accent/60 bg-accent/15 px-2 py-1 text-[11px] text-accent disabled:opacity-40"
        >
          {status.running ? 'Redrawing…' : 'Redraw the plan'}
        </button>
      )}

      <Choice
        label="FSI tier"
        value={switches.fsiTierIndex}
        onChange={(v) => setSwitch('fsiTierIndex', Number(v))}
        options={fsiTiers.map((t, i) => ({ value: i, label: String(t) }))}
        breached={fsiC?.breached}
        message={fsiC?.message}
      />

      <Slider
        label="Tower floors"
        value={towerFloors}
        min={4}
        max={30}
        legalMax={maxFloors}
        onChange={(v) => setSwitch('towerFloorOptions', [Math.max(4, Math.round(v * 0.6)), Math.round(v * 0.8), Math.round(v)])}
        breached={floorsC?.breached}
        message={floorsC?.message}
        constraintId="towerFloors"
      />

      <Slider
        label="Flats per floor"
        value={switches.flatsPerFloor}
        min={2}
        max={10}
        legalMin={perFloor.min}
        legalMax={perFloor.max}
        onChange={(v) => setSwitch('flatsPerFloor', Math.round(v))}
        breached={perFloorC?.breached}
        message={perFloorC?.message}
        constraintId="flatsPerFloor"
      />

      <Choice
        label="Apartment mix"
        value={mixValue}
        onChange={(v) => setSwitch('apartmentMix', MIXES.find((m) => m.value === v)?.mix ?? ['2BHK', '3BHK'])}
        options={MIXES.map((m) => ({ value: m.value, label: m.label }))}
      />

      <Choice
        label="Plot minimum side applies to"
        value={switches.minSideApplies}
        onChange={(v) => setSwitch('minSideApplies', v)}
        options={[
          { value: 'long_side' as const, label: 'long side' },
          { value: 'both_sides' as const, label: 'both sides' },
        ]}
        breached={villaC?.breached}
        message={villaC?.message}
      />

      {advanced && (
        <div className="mt-2 rounded border border-line/70 bg-panel-2/50 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Advanced</div>
          <div className="text-[11px] text-muted">Road directions searched</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(['contour', 'north_south', 'east_west'] as const).map((d) => {
              const on = switches.roadAngleCandidates.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() =>
                    setSwitch(
                      'roadAngleCandidates',
                      on
                        ? switches.roadAngleCandidates.filter((x) => x !== d)
                        : [...switches.roadAngleCandidates, d],
                    )
                  }
                  className={`rounded border px-2 py-1 text-[11px] transition ${
                    on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line bg-panel-2 text-muted hover:text-fg'
                  }`}
                >
                  {d === 'contour' ? 'contour-parallel' : d === 'north_south' ? 'north–south' : 'east–west'}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            Every regulation and assumption is editable under Compliance → rules. Anything changed there feeds this
            plan too.
          </p>
        </div>
      )}
    </div>
  );
}
