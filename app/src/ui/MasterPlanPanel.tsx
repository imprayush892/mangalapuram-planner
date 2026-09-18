import { useMemo } from 'react';
import { Button, Panel, Row } from './primitives';
import { useRules } from '../state/useRules';
import { useSiting, activeZoneUses } from '../state/sitingStore';
import { useMasterPlan, planDelta } from '../state/masterPlanStore';
import { inferUse } from '../engine/site/level1';
import type { ZoneUse } from '../engine/site/level1';
import { M2_PER_ACRE, m2ToSft } from '../engine/units';
import { asRatio } from '../engine/rules/roadGradient';
import { useEditedSite } from '../state/useEditedSite';

const nf = (n: number, d = 0): string =>
  Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';

export default function MasterPlanPanel(): React.ReactElement {
  const site = useEditedSite();
  const rules = useRules();
  const sitingResult = useSiting((s) => s.result);
  const sitingActive = useSiting((s) => s.activeIndex);
  const sitingLocks = useSiting((s) => s.locks);
  const { plan, previous, status, chooseOption } = useMasterPlan();

  /**
   * The use per zone comes from the siting engine where it has run, and from
   * the zone's own name where it has not, so the master plan can be generated
   * before siting and still means something.
   */
  const zoneUses = useMemo<Record<string, ZoneUse>>(() => {
    const fromSiting = activeZoneUses({ result: sitingResult, activeIndex: sitingActive });
    const out: Record<string, ZoneUse> = {};
    for (const zone of site?.zones ?? []) {
      if (zone.geom.length === 0) continue;
      out[zone.id] = sitingLocks[zone.id] ?? fromSiting[zone.id] ?? inferUse(zone.name);
    }
    return out;
  }, [site, sitingResult, sitingActive, sitingLocks]);

  const sitingLabel = sitingResult?.alternatives[sitingActive]?.label ?? 'zone names (siting engine not run)';

  if (!site || !rules) return <div className="p-3 text-muted">Loading…</div>;

  // What moved since the run before it, so a lever's effect is stated, not
  // left for the eye to spot.
  const delta = plan ? planDelta(plan, previous) : [];
  const zoneCount = Object.keys(zoneUses).length;


  return (
    <>
      {!plan && !status.running && (
        <Panel title="Nothing drawn yet">
          <p className="text-[11px] leading-snug text-muted">
            Move a lever under Massing rules and the plan draws itself. Until then these are the zones and the uses
            it will use.
          </p>
          <div className="mt-2">
            <Row label="Zones to plan" value={zoneCount} />
            <Row label="Uses from" value={sitingLabel} />
          </div>
        </Panel>
      )}

      {status.running && (
        <Panel title="Drawing the plan">
          <div className="text-[11px] text-accent">
            {status.message}
            {status.total > 0 && ` · ${status.done}/${status.total}`}
          </div>
        </Panel>
      )}

      {status.error && (
        <Panel title="The plan could not be drawn">
          <div className="text-[11px] text-bad">{status.error}</div>
        </Panel>
      )}

      {plan && delta.length > 0 && (
        <Panel title="Changed from the run before">
          {delta.map((d) => (
            <div key={d} className="py-0.5 text-[11px] text-fg">
              {d}
            </div>
          ))}
        </Panel>
      )}

      {plan && (
        <>
          <Panel title="What the plan holds">
            <Row label="Villa plots" value={nf(plan.totals.villaPlots)} />
            <Row label="Villa units" value={nf(plan.totals.villaUnits)} />
            <Row label="Towers" value={nf(plan.totals.towers)} />
            <Row label="Flats" value={nf(plan.totals.flats)} />
            <Row label="Other buildings" value={nf(plan.totals.blocks)} />
            <Row label="Dwellings" value={nf(plan.totals.dwellings)} hint="villa units plus flats" />
            <Row label="Population" value={nf(plan.totals.population)} hint="at the assumed household sizes" />
            <Row
              label="Built floor area"
              value={`${nf(m2ToSft(plan.totals.builtFloorM2))} sft`}
              hint={`${nf(plan.totals.builtFloorM2)} m²`}
            />
            <Row
              label="Building footprint"
              value={`${nf(plan.totals.builtFootprintM2)} m²`}
              hint="plinth of everything drawn"
            />
            <Row label="Roads between zones" value={`${nf(plan.totals.circulationRoadLengthM)} m`} />
            <Row label="Roads inside zones" value={`${nf(plan.totals.internalRoadLengthM)} m`} />
            <Row
              label="Road land"
              value={`${(plan.totals.roadAreaM2 / M2_PER_ACRE).toFixed(2)} ac`}
              hint="every tier, internal and between zones"
            />
            <Row
              label="Open space"
              value={`${(plan.totals.openSpaceM2 / M2_PER_ACRE).toFixed(2)} ac`}
            />
            <Row label="Land planned" value={`${plan.totals.plannedAreaAc.toFixed(2)} ac`} />
          </Panel>

          <Panel title="Circulation">
            {(['spine', 'public', 'collector'] as const).map((tier) => {
              const roads = plan.circulation.roads.filter((r) => r.tier === tier);
              if (roads.length === 0) return null;
              const length = roads.reduce((s, r) => s + r.lengthM, 0);
              const worst = Math.max(...roads.map((r) => r.maxGradePct));
              const label =
                tier === 'spine' ? 'Main spine' : tier === 'public' ? 'Retained public roads' : 'Collectors';
              return (
                <Row
                  key={tier}
                  label={label}
                  value={`${nf(length)} m`}
                  hint={`${roads.length} road${roads.length === 1 ? '' : 's'}, steepest ${worst.toFixed(1)}%`}
                />
              );
            })}
            {plan.circulation.roads
              .filter((r) => r.tier === 'spine')
              .map((r) => (
                <p key={r.id} className="mt-1.5 text-[10px] leading-snug text-muted">
                  {r.notes.join('. ')}.
                </p>
              ))}
          </Panel>

          <Panel title="Junctions and gradients">
            <Row
              label="Junctions"
              value={nf(plan.totals.junctions)}
              hint="where any two roads meet, internal or between zones"
            />
            <Row
              label="Splay land"
              value={`${nf(plan.totals.splayAreaM2)} m²`}
              hint="KMBR Rule 31: 4 m on roads up to 10 m, 10 m above"
            />
            <Row
              label="Stubs added"
              value={nf(plan.junctions.stubs.length)}
              hint="internal roads that stopped short of the network and are now joined to it"
            />
            <Row
              label="Steepest road"
              value={asRatio(plan.gradients.steepestGrade)}
              hint={plan.gradients.steepestRoadId ?? undefined}
            />
            <Row
              label={`Over ${plan.gradients.limits.desirableLabel}`}
              value={`${nf(plan.gradients.overDesirableM)} m`}
              hint={`of ${nf(plan.gradients.totalLengthM)} m measured; the client's desirable maximum`}
            />
            <Row
              label={`Over ${plan.gradients.limits.maxShortLabel}`}
              value={`${nf(plan.gradients.overMaxM)} m`}
              hint="the absolute maximum, allowed only over a short stretch"
            />
            {plan.gradients.unsurveyedShare > 0.01 && (
              <p className="mt-1.5 text-[10px] leading-snug text-warn">
                {(plan.gradients.unsurveyedShare * 100).toFixed(0)}% of the road length crosses unsurveyed ground and
                carries no measured gradient. It is excluded, not counted as level.
              </p>
            )}
            {plan.gradients.roads.filter((r) => r.longSteepRun).length > 0 && (
              <p className="mt-1.5 text-[10px] leading-snug text-warn">
                {plan.gradients.roads.filter((r) => r.longSteepRun).length} road
                {plan.gradients.roads.filter((r) => r.longSteepRun).length === 1 ? '' : 's'} hold the steeper gradient
                for longer than the {plan.gradients.limits.shortRunM} m the assumption allows.
              </p>
            )}
          </Panel>

          <Panel title="Zone by zone">
            {plan.zones.map((z) => {
              const layout = z.options[z.chosenIndex];
              return (
                <div key={z.zoneId} className="mb-2 rounded border border-line px-2 py-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-fg">{z.useLabel}</span>
                    <span className="num shrink-0 text-muted">{z.areaAc.toFixed(2)} ac</span>
                  </div>
                  <div className="truncate text-[10px] text-muted">{z.zoneName}</div>
                  {layout ? (
                    <>
                      <div className="mt-1 text-[11px] text-fg">
                        {layout.plots.length > 0 && `${layout.plots.length} plots · ${layout.metrics.unitCount} units`}
                        {layout.towers.length > 0 &&
                          `${layout.towers.length} towers · ${layout.towers.reduce((s, t) => s + t.flats, 0)} flats`}
                        {layout.blocks.length > 0 &&
                          `${layout.blocks.length} block${layout.blocks.length === 1 ? '' : 's'} · ${nf(
                            layout.metrics.totalFloorAreaM2,
                          )} m²`}
                      </div>
                      <div className="text-[10px] leading-snug text-muted">{layout.strategy}</div>
                      <div className="text-[10px] text-muted">{z.brief.basis}</div>
                      {z.options.length > 1 && (
                        <div className="mt-1 flex gap-1">
                          {z.options.map((o, i) => (
                            <Button
                              key={o.id}
                              onClick={() => chooseOption(z.zoneId, i)}
                              tone={i === z.chosenIndex ? 'primary' : 'default'}
                            >
                              {`Option ${i + 1}`}
                            </Button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="mt-1 text-[11px] text-warn">{z.empty}</div>
                  )}
                </div>
              );
            })}
            {plan.zones.some((z) => z.options.length > 1) && (
              <p className="text-[10px] leading-snug text-muted">
                Picking a different option takes effect on the next run.
              </p>
            )}
          </Panel>

          {plan.notes.length > 0 && (
            <Panel title="What the run reports">
              {plan.notes.map((n, i) => (
                <div key={i} className="py-0.5 text-[11px] leading-snug text-muted">
                  {n}
                </div>
              ))}
            </Panel>
          )}
        </>
      )}

    </>
  );
}
