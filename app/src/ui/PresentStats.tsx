import { useMemo } from 'react';
import { useSite } from '../state/store';
import { phaseOf } from '../state/presentStore';
import type { AnalysisResult } from '../engine/pipeline/analysis';
import type { PlanResult } from '../engine/pipeline/plan';
import type { Dem } from '../engine/terrain/dem';
import { AC, acs, n0, Big, Bars, Heading, Tiles, colourOf, GREEN_HEX } from './presentKit';

/**
 * The presentation's stats for the land analysis (steps 1-7 and the zoning) and for the phases the master plan
 * is built in (owner 7 Oct). Every figure is the analysis' or the plan's own, as the planning panels show them.
 */

const m3 = (v: number): string => `${n0(v)} m³`;
const WATER = 'rgb(80,150,210)';
const STEEP = 'rgb(227,115,94)';
const DRAIN = 'rgb(40,90,190)';
const ROAD = 'rgb(140,140,140)';
const GREEN = 'rgb(127,201,138)';

function TerrainCard({ a, dem, measured }: { a: AnalysisResult; dem: Dem; measured: Uint8Array | null }): React.ReactElement {
  const st = useMemo(() => {
    const m = a.layers.terrain.mask;
    let lo = Infinity;
    let hi = -Infinity;
    let n = 0;
    let meas = 0;
    const g: number[] = [];
    for (let k = 0; k < m.length; k += 1) {
      if (!m[k]) continue;
      n += 1;
      if (measured?.[k]) meas += 1;
      const z = dem.values[k]!;
      if (Number.isFinite(z)) {
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      const gr = a.gradient[k]!;
      if (Number.isFinite(gr)) g.push(gr);
    }
    g.sort((x, y) => x - y);
    return {
      lo,
      hi,
      meas: n > 0 ? meas / n : 0,
      median: g[Math.floor(g.length / 2)] ?? 0,
      steep: g.filter((x) => x > a.limits.plotMax).length / Math.max(1, g.length),
    };
  }, [a, dem, measured]);
  return (
    <>
      <Heading kicker="Step 1 · the ground" title="The surveyed site" />
      <Big value={acs(a.layers.terrain.areaM2)} unit="ac" label="in scope, read on a 2 m grid" />
      <Tiles
        items={[
          ['Lowest level', `RL ${st.lo.toFixed(1)}`],
          ['Highest level', `RL ${st.hi.toFixed(1)}`],
          ['Fall across the site', `${(st.hi - st.lo).toFixed(0)} m`],
          ['Typical slope', `${(st.median * 100).toFixed(0)}%`, 'median gradient'],
          ['Steeper than 1:5', `${Math.round(st.steep * 100)}%`, 'of the ground: plots there sit on graded platforms'],
          ['Surveyed', measured ? `${Math.round(st.meas * 100)}%` : '—', 'the rest is read from the terrain mesh'],
        ]}
      />
    </>
  );
}

function StormCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const w = a.storm.balance;
  const parts = [
    { label: 'Soaks in or is lost', value: w.lossM3, colour: GREEN },
    { label: 'Held in ponds', value: w.heldM3, colour: WATER },
    { label: 'Leaves the site', value: w.outflowM3, colour: DRAIN },
  ];
  return (
    <>
      <Heading kicker="Step 2 · the planning storm" title={`${a.stormMm} mm of rain in a day`} sub="Where every cubic metre goes; the balance closes to zero" />
      <Big value={n0(w.rainM3)} unit="m³" label="of rain falls on the site" />
      <div className="mb-3 flex h-4 w-full overflow-hidden rounded-full ring-1 ring-line">
        {parts.map((p) => (
          <div key={p.label} title={`${p.label}: ${m3(p.value)}`} style={{ width: `${(p.value / Math.max(1, w.rainM3)) * 100}%`, background: p.colour }} />
        ))}
      </div>
      <Bars rows={parts} total={w.rainM3} unit="m³" />
      <div className="mt-3">
        <Tiles
          items={[
            ['Runs off', m3(w.runoffM3), `runoff coefficient ${a.storm.runoffCoeff.toFixed(2)}`],
            ['Peak outflow', `${w.peak.outflowM3s.toFixed(1)} m³/s`],
            ['Flow lines', `${n0(w.peak.flowLineLengthM)} m`],
          ]}
        />
      </div>
    </>
  );
}

function WaterloggingCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const w = a.storm.balance;
  const c = a.water;
  return (
    <>
      <Heading kicker="Step 3 · waterlogging" title="Ground under water at the storm's peak" sub="Open space, never plots (KMBR Rule 22(3))" />
      <Big
        value={acs(c.counted.areaM2, 2)}
        unit="ac"
        label={`${m3(c.counted.volumeM3)} standing, ${c.counted.meanDepthM.toFixed(2)} m deep on average`}
      />
      <Tiles
        items={[
          ['Ponds', `${w.ponds.length}`],
          ['Deepest pond', `${w.peak.pondMaxDepthM.toFixed(2)} m`],
          ['Channels running', `${n0(w.peak.channelLengthM)} m`],
          [`Channels under ${c.ignoredChannels.widthM} m`, `${acs(c.ignoredChannels.areaM2, 2)} ac`, 'carried in the storm-water drains'],
          [`Patches under ${n0(c.ignoredPatches.underM2)} m²`, `${acs(c.ignoredPatches.areaM2, 2)} ac`, 'to the drains, so the land round them joins up'],
          ['Share of the site', `${Math.round(a.layers.waterlogging.share * 100)}%`],
          ...(c.drained
            ? ([
                ['Kept as lakes', `${acs(c.drained.lakesM2, 2)} ac`, 'owner 12 Oct: water only in the three lakes'],
                [`${c.drained.patches} patches drained`, `${acs(c.drained.areaM2, 2)} ac`, `${m3(c.drained.volumeM3)} of water, built on`],
                ['Lakes dug deeper', `${c.drained.extraDepthM.toFixed(2)} m`, 'to hold the drained water at the peak'],
              ] as [string, string, string][])
            : []),
        ]}
      />
    </>
  );
}

function PublicCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const L = a.layers;
  return (
    <>
      <Heading kicker="Step 4 · public space" title="The land that stays everyone's" />
      <Big value={acs(L.publicSpace.areaM2)} unit="ac" label={`${Math.round(L.publicSpace.share * 100)}% of the site, in ${L.publicSpace.pieces} pieces`} />
      <Bars
        rows={[
          { label: 'Water at the peak', value: L.waterlogging.areaM2 / AC, colour: WATER },
          { label: 'Too steep (Rule 22)', value: L.nonBuildable.areaM2 / AC, colour: STEEP },
          { label: 'Natural drains', value: L.drains.areaM2 / AC, colour: DRAIN },
          { label: 'Too narrow to plot', value: L.residual.areaM2 / AC, colour: ROAD },
        ]}
      />
    </>
  );
}

function SlopeCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const classes = useMemo(() => {
    const edges: [string, number, number, string][] = [
      ['Flat, under 1:20', 0, 0.05, 'rgb(127,201,138)'],
      ['1:20 to 1:10', 0.05, 0.1, 'rgb(180,210,120)'],
      ['1:10 to 1:5', 0.1, 0.2, 'rgb(230,200,100)'],
      ['1:5 to 1:3', 0.2, 1 / 3, 'rgb(235,160,90)'],
      ['1:3 to 1:1', 1 / 3, 1, STEEP],
      ['Over 45°', 1, Infinity, 'rgb(170,60,60)'],
    ];
    const m = a.layers.terrain.mask;
    const cnt = edges.map(() => 0);
    for (let k = 0; k < m.length; k += 1) {
      if (!m[k]) continue;
      const g = a.gradient[k]!;
      if (!Number.isFinite(g)) continue;
      const i = edges.findIndex(([, lo, hi]) => g >= lo && g < hi);
      if (i >= 0) cnt[i]! += 1;
    }
    const cellArea = a.layers.terrain.areaM2 / Math.max(1, cnt.reduce((x, y) => x + y, 0));
    return edges.map(([label, , , colour], i) => ({ label, value: (cnt[i]! * cellArea) / AC, colour }));
  }, [a]);
  return (
    <>
      <Heading kicker="Step 5 · slope" title="How steep the ground is" sub="Plots are held to 1:5; steeper ground is built on graded platforms" />
      <Big value={acs(a.layers.moderateSlope.areaM2)} unit="ac" label={`steeper than 1:5, ${Math.round(a.layers.moderateSlope.share * 100)}% of the site`} />
      <Bars rows={classes} />
    </>
  );
}

function NonBuildableCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const L = a.layers;
  return (
    <>
      <Heading kicker="Step 6 · non-buildable land" title="What KMBR Rule 22 keeps unbuilt" />
      <Big
        value={acs(L.nonBuildable.areaM2 + L.drains.areaM2, 2)}
        unit="ac"
        label="slope over 45° and natural drains (flood-liable land is the waterlogging)"
      />
      <div className="flex flex-col gap-1.5">
        {a.rule22.map((r) => (
          <div key={r.clause + r.condition} className="flex items-start gap-2.5">
            <span
              className={`mt-0.5 shrink-0 rounded px-1.5 text-[9px] uppercase leading-[16px] ${
                r.status === 'applied' ? 'bg-accent/20 text-accent' : 'bg-line/60 text-muted'
              }`}
            >
              {r.status === 'applied' ? 'applied' : 'no data'}
            </span>
            <span className="text-[12px] leading-snug text-fg/90">
              <span className="text-muted">{r.clause}</span> {r.condition}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function PlotableCard({ a }: { a: AnalysisResult }): React.ReactElement {
  const L = a.layers;
  return (
    <>
      <Heading kicker="Step 7 · land that can take plots" title="From the site to the land to build on" />
      <Big value={acs(L.plotable.areaM2)} unit="ac" label={`can take plots: ${Math.round(L.plotable.share * 100)}% of the ${acs(L.terrain.areaM2)} ac site`} />
      <Bars
        total={L.terrain.areaM2 / AC}
        rows={[
          { label: 'The site', value: L.terrain.areaM2 / AC, colour: 'rgb(150,160,165)' },
          { label: '− water at the peak', value: L.waterlogging.areaM2 / AC, colour: WATER },
          { label: '− too steep, drains', value: (L.nonBuildable.areaM2 + L.drains.areaM2) / AC, colour: STEEP },
          { label: '− existing roads', value: L.existingRoads.areaM2 / AC, colour: ROAD },
          { label: '− too narrow to plot', value: L.residual.areaM2 / AC, colour: 'rgb(110,115,120)' },
          { label: '= can take plots', value: L.plotable.areaM2 / AC, colour: GREEN },
        ]}
      />
    </>
  );
}

function ZoningCard({ plan }: { plan: PlanResult | undefined }): React.ReactElement | null {
  const site = useSite((st) => st.site?.draftZones ?? []);
  // The option's own zoning, from its plan's land account (owner 12 Oct); the model's zones before a plan is there.
  const zones = plan?.land
    ? plan.land.zones.map((z) => ({ use: z.use as string, ac: z.areaM2 / AC, phase: z.phase }))
    : site.map((z) => ({ use: z.use ?? 'other', ac: z.computedInScopeAc, phase: z.phase }));
  if (zones.length === 0) return null;
  const by = new Map<string, { ac: number; phases: Set<number> }>();
  for (const z of zones) {
    const k = z.use;
    const e = by.get(k) ?? { ac: 0, phases: new Set<number>() };
    e.ac += z.ac;
    if (z.phase && k !== 'park') e.phases.add(z.phase);
    by.set(k, e);
  }
  if (plan?.land) {
    // The open space net of the streets across it, with the strips no zone took and the edge: with the roads, the
    // rows add up to the parcel.
    by.set('park', { ac: plan.land.openSpaceM2 / AC, phases: new Set() });
    by.set('roads', { ac: plan.land.roadsM2 / AC, phases: new Set() });
  }
  const rows = [...by.entries()].sort((x, y) => y[1].ac - x[1].ac);
  const total = plan?.land ? plan.land.parcelM2 / AC : rows.reduce((t, [, e]) => t + e.ac, 0);
  const label = (u: string): string =>
    u === 'park' ? 'Open space (parks, lakes, green in the villas, strips)' : u === 'roads' ? 'Trunk roads (outside the zones)' : u.charAt(0).toUpperCase() + u.slice(1);
  return (
    <>
      <Heading kicker="The zoning · optimised" title="Where each use goes" sub="Each use where it works best; phases run outward from the main gate" />
      <Big
        value={total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
        unit="ac"
        label={plan?.land ? `the parcel, every acre once${plan.land.edgeM2 > 0 ? ` (with ${acs(plan.land.edgeM2, 2)} ac of unsurveyed edge, green)` : ''}` : 'zoned'}
      />
      <div className="flex flex-col gap-1.5">
        {rows.map(([u, e]) => (
          <div key={u} className="grid grid-cols-[1fr_auto_70px] items-center gap-3">
            <span className="flex items-center gap-2 text-[12px] text-fg/90">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colourOf(u) }} />
              {label(u)}
            </span>
            <span className="flex gap-1">
              {[...e.phases].sort().map((p) => (
                <span key={p} className="rounded bg-line/70 px-1 text-[9px] leading-[14px] text-muted">
                  P{p}
                </span>
              ))}
            </span>
            <span className="num text-right text-[13px] font-semibold tabular-nums text-fg">
              {e.ac.toFixed(2)}
              <span className="ml-0.5 text-[10px] font-normal text-muted">ac</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Owner 12 Oct: the green, by the owner's four kinds; nothing is left empty. */
function GreenCard({ plan }: { plan: PlanResult }): React.ReactElement {
  const g = plan.land.green;
  const rows = [
    { label: 'RC parks (large, public)', value: g.rcM2 / AC, colour: GREEN_HEX.rc },
    { label: 'Lakes', value: g.lakesM2 / AC, colour: GREEN_HEX.lake },
    { label: 'Green in the villas', value: g.zoneM2 / AC, colour: GREEN_HEX.zone },
    { label: 'Clubhouse zones', value: g.clubM2 / AC, colour: GREEN_HEX.club },
    { label: 'Landscape strips, edge', value: g.landscapeM2 / AC, colour: GREEN_HEX.landscape },
    { label: 'Grounds round buildings', value: g.groundsM2 / AC, colour: '#c3d9a6' },
  ].filter((r) => r.value > 0.005);
  const open = (plan.land.openSpaceM2 + g.clubM2) / AC;
  return (
    <>
      <Heading kicker="The green" title="No land left empty" sub="Open space by kind; the grounds round the buildings take their drives and parking too" />
      <Big value={open.toFixed(2)} unit="ac" label={`open space with the clubhouses, ${Math.round(((plan.land.openSpaceM2 + g.clubM2) / plan.land.parcelM2) * 100)}% of the parcel`} />
      <Bars unit="ac" rows={rows} />
    </>
  );
}

const USE_NAME: Record<string, string> = {
  hospital: 'Hospital',
  school: 'School',
  clubhouse: 'Clubhouses',
  retail: 'Retail & F&B',
  office: 'Office',
  commercial: 'Commercial',
};

/** What a phase adds, and the township so far. */
function PhaseCard({ plan, n, last }: { plan: PlanResult; n: number; last: boolean }): React.ReactElement {
  const ph = phaseOf(plan);
  const at = (k: number) => {
    const plots = plan.plots.filter((p) => ph.zone(p.zone) === k);
    const bs = plan.buildings.filter((b) => ph.zone(b.zone) === k);
    const uses = new Map<string, number>();
    for (const b of bs) if (b.typology !== 'apartments' && b.typology !== 'senior') uses.set(b.typology, (uses.get(b.typology) ?? 0) + b.builtUpM2);
    // Apartments: the flats the towers hold (owner 12 Oct: the plan's own figure).
    const apts = bs.filter((b) => b.typology === 'apartments').reduce((t, b) => t + b.units, 0);
    return {
      villas: plots.length,
      apts,
      senior: bs.filter((b) => b.typology === 'senior').reduce((t, b) => t + b.units, 0),
      bua: plots.reduce((t, p) => t + p.builtUpM2, 0) + bs.reduce((t, b) => t + b.builtUpM2, 0),
      land: plan.zones.filter((z) => Math.max(1, z.phase ?? 1) === k).reduce((t, z) => t + z.areaM2, 0),
      uses,
    };
  };
  const now = at(n);
  const sum = [1, 2, 3, 4].filter((k) => k <= n).map(at);
  const tot = (f: (x: ReturnType<typeof at>) => number): number => sum.reduce((t, x) => t + f(x), 0);
  return (
    <>
      <Heading
        kicker={`Phase ${n}${last ? ' · the master plan complete' : ''}`}
        title={`What Phase ${n} adds`}
        sub={n === 1 ? 'Built first, by the main gate on the Mangalapuram–Pothencode road' : 'Further out from the gate'}
      />
      <Tiles
        items={[
          ['Villas', n0(now.villas)],
          ['Apartments', n0(now.apts)],
          ['Senior homes', n0(now.senior)],
        ]}
      />
      {now.uses.size > 0 && (
        <div className="mt-3">
          <Bars unit="sft" rows={[...now.uses.entries()].map(([u, m2]) => ({ label: USE_NAME[u] ?? u, value: m2 * 10.7639, colour: colourOf(u) }))} />
        </div>
      )}
      <div className="mt-3 grid grid-cols-4 gap-2 rounded-md bg-line/30 px-3 py-2">
        {[
          [`Homes, phases 1–${n}`, n0(tot((x) => x.villas + x.apts + x.senior))],
          ['Villas so far', n0(tot((x) => x.villas))],
          ['Built-up so far', `${((tot((x) => x.bua) * 10.7639) / 1e5).toFixed(1)} lakh sft`],
          ['Land in these phases', `${acs(tot((x) => x.land))} ac`],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="text-[9px] uppercase tracking-wider text-muted">{k}</p>
            <p className="num text-[15px] font-semibold tabular-nums text-fg">{v}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/** The stats card for a step of the land analysis, or for a phase; null where the step has none. */
export function stepStats(key: string, phase: number | undefined, a: AnalysisResult | null, dem: Dem | null, measured: Uint8Array | null, plan: PlanResult | undefined, phased: boolean): React.ReactElement | null {
  if (a && dem) {
    if (key === 'terrain') return <TerrainCard a={a} dem={dem} measured={measured} />;
    if (key === 'water') return <StormCard a={a} />;
    if (key === 'waterlogging') return <WaterloggingCard a={a} />;
    if (key === 'public') return <PublicCard a={a} />;
    if (key === 'slope') return <SlopeCard a={a} />;
    if (key === 'nonbuildable') return <NonBuildableCard a={a} />;
    if (key === 'plotable') return <PlotableCard a={a} />;
  }
  if (key === 'zoning') return <ZoningCard plan={plan} />;
  if (key === 'typologies' && plan?.land) return <GreenCard plan={plan} />;
  if (plan && phased) {
    if (phase !== undefined) return <PhaseCard plan={plan} n={phase} last={false} />;
    if (key === 'masterplan') return <PhaseCard plan={plan} n={4} last />;
  }
  return null;
}
