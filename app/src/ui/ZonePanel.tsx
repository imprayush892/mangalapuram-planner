import { useMemo } from 'react';
import { useSite } from '../state/store';
import { useLayout } from '../state/layoutStore';
import { useSettings } from '../state/settingsStore';
import { useRules } from '../state/useRules';
import { runGenerate } from '../state/generate';
import { Button, Panel, Row, StatusDot } from './primitives';
import { loadProgramme } from '../engine/rules/programme';
import { sizeVillaPlots } from '../engine/rules/client';
import { coverageFsi } from '../engine/rules/kmbr';
import { multiPolyArea } from '../engine/geom/planar';
import { m2ToAcres, m2ToSft } from '../engine/units';
import { pick } from '../engine/data/config';
import { countByStatus } from '../engine/rules/findings';
import { FindingCard } from './CompliancePanel';
import type { LayoutOption } from '../engine/generators/types';

/** Zones the villa generator applies to: villa projects, phases and senior living. */
const VILLA_ZONE = /VILLA|PHASE|SENIOR/i;
const SENIOR_ZONE = /SENIOR/i;
const TOWER_ZONE = /APARTMENT/i;

/** The cashflow sizes villa land at 20 units per acre (sheet C17: 640 / 20). */
const VILLA_UNITS_PER_AC = 20;

export default function ZonePanel(): React.ReactElement {
  const site = useSite((s) => s.site);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const selectZone = useSite((s) => s.selectZone);
  const rules = useRules();
  const switches = useSettings((s) => s.switches);
  const overrides = useSettings((s) => s.overrides);
  const { options, activeOptionIndex, setActiveOption, status, byZone, showZone } = useLayout();

  const zone = site?.zones.find((z) => z.id === selectedZoneId) ?? null;

  const programme = useMemo(
    () => (rules ? loadProgramme(rules.programme, rules.client, rules.kmbr, rules.assumptions) : null),
    [rules],
  );

  const isTower = zone ? TOWER_ZONE.test(zone.name) : false;
  const isVilla = zone ? VILLA_ZONE.test(zone.name) && !isTower : false;
  const isSenior = zone ? SENIOR_ZONE.test(zone.name) : false;

  const targetUnits = useMemo(() => {
    if (!zone) return 0;
    if (isSenior && programme) {
      // Senior lines state their own unit counts and land.
      const lines = programme.lines.filter((l) => l.use === 'senior');
      const totalAc = lines.reduce((s, l) => s + l.landAc, 0);
      const totalUnits = lines.reduce((s, l) => s + l.units, 0);
      return totalAc > 0 ? Math.round((totalUnits / totalAc) * zone.computedInScopeAc) : 0;
    }
    return Math.round(zone.computedInScopeAc * VILLA_UNITS_PER_AC);
  }, [zone, isSenior, programme]);

  const sizing = useMemo(() => {
    if (!zone || !rules || targetUnits <= 0) return null;
    return sizeVillaPlots(rules.client, multiPolyArea(zone.geom), targetUnits, {
      minSideApplies: switches.minSideApplies,
    });
  }, [zone, rules, targetUnits, switches.minSideApplies]);

  if (!site || !rules) return <div className="p-3 text-muted">Loading…</div>;

  if (!zone) {
    return (
      <Panel title="Zone layout">
        <p className="text-[11px] leading-snug text-muted">
          Pick a zone on the plan, or in the Site tab, to generate its internal layout. This is the priority: plots
          and roads inside each zone, on the real terrain.
        </p>
        {Object.keys(byZone).length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            <div className="text-[11px] uppercase tracking-wider text-muted">Generated this session</div>
            {Object.entries(byZone).map(([id, opts]) => {
              const z = site.zones.find((s) => s.id === id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    selectZone(id);
                    showZone(id);
                  }}
                  className="flex justify-between rounded px-1.5 py-1 text-left hover:bg-panel-2"
                >
                  <span className="truncate text-fg">{z?.name ?? id}</span>
                  <span className="num text-muted">{opts.length} options</span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>
    );
  }

  const householdSize = pick<number>(
    rules.assumptions,
    isSenior ? 'household_size_senior' : 'household_size_family',
    isSenior ? 1.6 : 3.5,
  );

  const fsiTiers = coverageFsi(rules.kmbr, 'A1').fsiTiers;
  const fsi = fsiTiers[switches.fsiTierIndex] ?? fsiTiers[0] ?? 3;

  const generate = (): void => {
    if (isTower) {
      runGenerate({
        overrides,
        zoneId: zone.id,
        kind: 'tower',
        targetUnits,
        householdSize,
        fsi,
        floorOptions: switches.towerFloorOptions,
        mix: switches.apartmentMix,
        flatsPerFloor: switches.flatsPerFloor,
      });
      return;
    }
    runGenerate({
      overrides,
      zoneId: zone.id,
      kind: 'villa',
      targetUnits,
      householdSize,
      senior: isSenior,
      minSideApplies: switches.minSideApplies,
      directions: switches.roadAngleCandidates,
    });
  };

  return (
    <>
      <Panel title={zone.name}>
        <Row label="In scope" value={`${zone.computedInScopeAc.toFixed(2)} ac`} />
        <Row label="Drawn on the zoning plan" value={`${zone.drawnAreaAc.toFixed(2)} ac`} />
        <Row
          label="Geometry confidence"
          value={zone.confidence}
          hint="registration of the client Zoning Plan onto the survey"
        />
        {!isVilla && !isTower && (
          <p className="pt-2 text-[11px] leading-snug text-warn">
            Villa, phase, senior-living and apartment zones have generators. The school, club, commercial, hotel and
            business-hub blocks arrive with the next milestone.
          </p>
        )}
      </Panel>

      {isTower && (
        <>
          <Panel title="Sizing from the client method">
            <Row label="FSI tier" value={`${fsi}`} hint="KMBR Table 6 A1 — change it in the Rules tab" />
            <Row label="Mix" value={switches.apartmentMix.join(' + ')} />
            <Row label="Flats per floor" value={`${switches.flatsPerFloor}`} />
            <Row label="Floor counts explored" value={switches.towerFloorOptions.join(' / ')} />
            <p className="pt-1 text-[11px] leading-snug text-muted">
              Floor area = land × FSI; footprint = floor area ÷ floors; plate = flats per floor × average flat ÷ 0.80;
              towers = ceil(footprint ÷ plate). Towers run with their long axis along the contours and are placed to
              maximise the smallest distance between them, on the flattest ground that keeps it.
            </p>
          </Panel>

          <Panel
            title="Generate"
            right={
              <Button tone="primary" onClick={generate} disabled={status.running}>
                {status.running ? 'Generating…' : 'Generate 3 options'}
              </Button>
            }
          >
            {status.message && <p className="text-[11px] text-muted">{status.message}</p>}
            {status.error && <p className="text-[11px] text-bad">{status.error}</p>}
          </Panel>
        </>
      )}

      {isVilla && sizing && (
        <>
          <Panel title="Sizing from the client rules">
            <Row label="Target units" value={`${targetUnits}`} hint="cashflow: 20 villa units per acre" />
            <Row label="Roads / open / saleable" value="20 / 30 / 50 %" hint="client_rules.villa_and_senior_land_split" />
            <Row label="Saleable land" value={`${Math.round(sizing.saleableM2).toLocaleString('en-IN')} m²`} />
            <Row label="Unit plot" value={`${sizing.unitPlotAreaM2.toFixed(1)} m²`} />
            <Row
              label="Grouping"
              value={sizing.rowHousing ? `${sizing.grouping} units per plot (row housing)` : 'detached'}
              hint="triggered when the unit plot falls below the minimum"
            />
            <Row label="Plot" value={`${sizing.plotAreaM2.toFixed(1)} m² · ${sizing.widthM.toFixed(2)} × ${sizing.depthM.toFixed(2)} m`} />
            <Row label="Plots" value={`${sizing.plots}`} />
            <Row label="Aspect" value={`1:${sizing.aspect.toFixed(2)}`} />
            <Row label="Villa footprint (placeholder)" value={`${sizing.footprintM2.toFixed(1)} m²`} />
            {sizing.notes.map((n) => (
              <p key={n} className="pt-1 text-[11px] leading-snug text-muted">
                {n}
              </p>
            ))}
          </Panel>

          <Panel
            title="Generate"
            right={
              <Button tone="primary" onClick={generate} disabled={status.running}>
                {status.running ? 'Generating…' : 'Generate 3 options'}
              </Button>
            }
          >
            {status.running && <p className="text-[11px] text-muted">{status.message}</p>}
            {!status.running && status.message && <p className="text-[11px] text-muted">{status.message}</p>}
            {status.error && <p className="text-[11px] text-bad">{status.error}</p>}
            <p className="pt-1 text-[11px] leading-snug text-muted">
              Road directions searched: contour-parallel, north–south and east–west. Each is iterated over pitch,
              phase and cross-road spacing; the best of each is kept.
            </p>
          </Panel>
        </>
      )}

      {options.length > 0 && options[0]!.zoneId === zone.id && (
        <>
          <Panel title="Options">
            <div className="flex flex-col gap-1">
              {options.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setActiveOption(i)}
                  className={`rounded border px-2 py-1.5 text-left transition ${
                    i === activeOptionIndex ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-2'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-fg">Option {i + 1}</span>
                    <span className="num text-muted">score {o.score.total.toFixed(0)}</span>
                  </div>
                  <div className="text-[11px] leading-snug text-muted">{o.strategy}</div>
                  <div className="num mt-0.5 flex gap-2 text-[11px] text-muted">
                    <span>{o.metrics.unitCount} units</span>
                    <span>{(o.metrics.shares.roads * 100).toFixed(1)}/{(o.metrics.shares.openSpace * 100).toFixed(1)}/{(o.metrics.shares.saleable * 100).toFixed(1)}</span>
                    <FindingChips option={o} />
                  </div>
                </button>
              ))}
            </div>
          </Panel>
          <OptionDetail option={options[activeOptionIndex] ?? options[0]!} />
        </>
      )}
    </>
  );
}

function FindingChips({ option }: { option: LayoutOption }): React.ReactElement {
  const counts = countByStatus(option.findings);
  return (
    <span className="flex items-center gap-1.5">
      {counts.fail > 0 && (
        <span className="flex items-center gap-0.5">
          <StatusDot status="fail" />
          {counts.fail}
        </span>
      )}
      {counts.warn > 0 && (
        <span className="flex items-center gap-0.5">
          <StatusDot status="warn" />
          {counts.warn}
        </span>
      )}
      <span className="flex items-center gap-0.5">
        <StatusDot status="pass" />
        {counts.pass}
      </span>
    </span>
  );
}

function OptionDetail({ option }: { option: LayoutOption }): React.ReactElement {
  const m = option.metrics;
  const fmt = (n: number, dp = 0): string =>
    n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const recreation = option.openSpace.filter((o) => o.countsAsRecreation);

  return (
    <>
      <Panel title="Area statement">
        <Row label="Zone" value={`${m2ToAcres(m.zoneAreaM2).toFixed(2)} ac`} />
        <Row label="Buildable" value={`${m2ToAcres(m.buildableAreaM2).toFixed(2)} ac`} hint="zone minus Rule 22 ground and any no-go area" />
        <Row label="Too steep (Rule 22)" value={`${m2ToAcres(m.unbuildableAreaM2).toFixed(2)} ac`} />
        <Row label="Unsurveyed" value={`${m2ToAcres(m.unsurveyedAreaM2).toFixed(2)} ac`} hint="NaN in the DEM — low confidence" />
        <Row
          label="Roads"
          value={`${m2ToAcres(m.roadAreaM2).toFixed(2)} ac · ${(m.shares.roads * 100).toFixed(1)}%`}
          hint="target 20%"
        />
        <Row
          label="Open space"
          value={`${m2ToAcres(m.openSpaceAreaM2).toFixed(2)} ac · ${(m.shares.openSpace * 100).toFixed(1)}%`}
          hint="target 30%"
        />
        <Row
          label="Saleable"
          value={`${m2ToAcres(m.saleableAreaM2).toFixed(2)} ac · ${(m.shares.saleable * 100).toFixed(1)}%`}
          hint="target 50%"
        />
        {option.kind === 'tower' ? (
          <>
            <Row label="Towers" value={`${m.towerCount}`} />
            <Row label="Flats" value={`${m.unitCount} of ${m.targetUnits}`} />
            <Row label="Total floor area" value={`${fmt(m2ToSft(m.totalFloorAreaM2))} sft`} />
            <Row label="Footprint" value={`${fmt(m2ToSft(m.footprintM2))} sft`} />
            <Row label="FSI used" value={m.fsiUsed.toFixed(2)} hint="floor area / zone area" />
            <Row label="Coverage" value={`${m.coveragePct.toFixed(1)}%`} hint="KMBR Table 6 limit 65%" />
          </>
        ) : (
          <>
            <Row label="Plots" value={`${m.plotCount}`} />
            <Row label="Units" value={`${m.unitCount} of ${m.targetUnits}`} />
            <Row label="Corner plots" value={`${m.cornerPlots}`} hint="the client prices corners as premium" />
            <Row label="Facing E, W or N" value={`${(m.goodOrientationShare * 100).toFixed(0)}%`} />
            <Row label="Villa footprint total" value={`${fmt(m2ToSft(m.footprintM2))} sft`} />
          </>
        )}
        <Row label="Population capacity" value={`${fmt(Math.round(m.populationCapacity))}`} />
      </Panel>

      <Panel title={option.kind === 'tower' ? 'Earthwork and podiums' : 'Earthwork'}>
        <Row label="Cut" value={`${fmt(Math.round(m.cutM3))} m³`} hint="to the median platform RL of each plot" />
        <Row label="Fill" value={`${fmt(Math.round(m.fillM3))} m³`} />
        <Row label="Retaining face" value={`${fmt(Math.round(m.retainingFaceM2))} m²`} />
        <FallBreakdown option={option} />
      </Panel>

      {option.kind === 'tower' && (
        <Panel title="Towers">
          {option.towers.map((t) => (
            <div key={t.id} className="border-b border-line py-1.5 last:border-0">
              <div className="flex items-baseline justify-between">
                <span className="text-fg">
                  {t.id}
                  {t.joinedWith.length > 0 && (
                    <span className="ml-1 text-warn" title="joined at 0 m because the zone is too small">
                      · joined to {t.joinedWith.join(', ')}
                    </span>
                  )}
                </span>
                <span className="num text-muted">
                  {t.floors} F · {t.heightM.toFixed(0)} m
                </span>
              </div>
              <div className="num flex flex-wrap gap-x-3 text-[11px] text-muted">
                <span>
                  plate {Math.round(t.plateM2)} m² ({t.lengthM.toFixed(0)} × {t.depthM.toFixed(0)} m)
                </span>
                <span>{t.flats} flats</span>
                <span>{t.cores} core{t.cores === 1 ? '' : 's'}</span>
                <span>
                  podium RL {Number.isFinite(t.podiumRl) ? t.podiumRl.toFixed(2) : '—'}
                </span>
                <span>fall {Number.isFinite(t.terrain.fall) ? `${t.terrain.fall.toFixed(1)} m` : '—'}</span>
              </div>
              {t.notes.map((n) => (
                <p key={n} className="text-[11px] leading-snug text-muted">
                  {n}
                </p>
              ))}
            </div>
          ))}
        </Panel>
      )}

      <Panel title="Roads and open space">
        <Row label="Road runs" value={`${option.roads.length}`} />
        <Row label="Cul-de-sacs" value={`${option.roads.filter((r) => r.kind === 'cul_de_sac').length}`} />
        {option.kind === 'tower' && (
          <Row
            label="Fire lanes"
            value={`${option.roads.filter((r) => r.kind === 'fire_lane').length}`}
            hint="KMBR Chapter XVII: 5 m motorable, two adjacent sides"
          />
        )}
        <Row label="Open-space pieces" value={`${option.openSpace.length}`} />
        <Row
          label="Qualifying recreation"
          value={`${recreation.length} · ${m2ToAcres(recreation.reduce((s, o) => s + o.areaM2, 0)).toFixed(2)} ac`}
          hint="at least 200 m² and 6 m wide, with its own access"
        />
      </Panel>

      <Panel title="Compliance">
        <div className="flex flex-col gap-1.5">
          {option.findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      </Panel>
    </>
  );
}

function FallBreakdown({ option }: { option: LayoutOption }): React.ReactElement {
  const counts = new Map<string, number>();
  const subjects = option.kind === 'tower' ? option.towers : option.plots;
  for (const p of subjects) counts.set(p.terrain.fallClass, (counts.get(p.terrain.fallClass) ?? 0) + 1);
  return (
    <>
      {[...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => (
          <Row
            key={cls}
            label={cls.replace(/_/g, ' ')}
            value={`${n} ${option.kind === 'tower' ? 'towers' : 'plots'}`}
          />
        ))}
    </>
  );
}
