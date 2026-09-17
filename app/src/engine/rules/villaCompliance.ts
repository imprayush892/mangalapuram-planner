import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import type { LayoutOption } from '../generators/types';
import { clientSetbacks, landSplit, sizeVillaPlots, roadWidths } from './client';
import { baseYards, subdivisionRules, villaGapM } from './kmbr';
import type { Finding } from './findings';
import { fail, info, pass, warn } from './findings';
import { m2ToAcres } from '../units';

const SHARE_TOLERANCE_POINTS = 2;

/**
 * Checks a generated villa or senior layout against the client rules first and
 * KMBR on top, per SPEC section 5. Where the two differ, the finding carries
 * both values and the stricter one decides the status.
 */
export function checkVillaLayout(
  layout: LayoutOption,
  client: YamlDoc,
  kmbr: YamlDoc,
  assumptions: YamlDoc,
): Finding[] {
  const out: Finding[] = [];
  const m = layout.metrics;
  const split = landSplit(client);
  const sub = subdivisionRules(kmbr);
  const setbacks = clientSetbacks(client);
  const roads = roadWidths(client);
  const sizing = sizeVillaPlots(client, m.zoneAreaM2, m.targetUnits);

  /* ------------------------------------------------ the 20/30/50 land split */
  const shareRows: [string, number, number][] = [
    ['Roads', m.shares.roads, split.roads],
    ['Open space', m.shares.openSpace, split.openSpace],
    ['Saleable', m.shares.saleable, split.saleable],
  ];
  for (const [label, actual, target] of shareRows) {
    const deltaPoints = (actual - target) * 100;
    const within = Math.abs(deltaPoints) <= SHARE_TOLERANCE_POINTS;
    out.push(
      (within ? pass : warn)({
        id: `villa.share.${label.toLowerCase().replace(/\s+/g, '_')}`,
        source: 'CLIENT',
        reference: 'client_rules.villa_and_senior_land_split',
        title: `${label} share ${(actual * 100).toFixed(1)}% against the ${(target * 100).toFixed(0)}% rule`,
        detail: within
          ? `Within the ±${SHARE_TOLERANCE_POINTS} point tolerance (${deltaPoints >= 0 ? '+' : ''}${deltaPoints.toFixed(1)} points).`
          : `Off by ${deltaPoints >= 0 ? '+' : ''}${deltaPoints.toFixed(1)} points. The zone boundary, the unbuildable ground and the plot module together will not give the exact split; the residual is reported rather than fudged.`,
      }),
    );
  }

  /* ----------------------------------------------------- plots and minimums */
  const undersized = layout.plots.filter((p) => p.areaM2 < sizing.minPlotAreaWithToleranceM2);
  out.push(
    (undersized.length === 0 ? pass : fail)({
      id: 'villa.min_plot_area',
      source: 'CLIENT',
      reference: 'client_rules.villa_plots.min_side_m (18 m long side, 3% tolerance)',
      title: `Plot minimum ${sizing.minPlotAreaM2.toFixed(1)} m²`,
      detail:
        undersized.length === 0
          ? `All ${layout.plots.length} plots are at or above the minimum (tolerance floor ${sizing.minPlotAreaWithToleranceM2.toFixed(1)} m²).`
          : `${undersized.length} of ${layout.plots.length} plots fall below the ${sizing.minPlotAreaWithToleranceM2.toFixed(1)} m² tolerance floor.`,
    }),
  );

  const minSide = pick<number>(client, 'villa_plots.min_side_m', 18);
  const shortSided = layout.plots.filter((p) => Math.max(p.widthM, p.depthM) < minSide * 0.97);
  out.push(
    (shortSided.length === 0 ? pass : fail)({
      id: 'villa.min_side',
      source: 'CLIENT',
      reference: 'client_rules.villa_plots.min_side_m',
      title: `Long side at least ${minSide} m`,
      detail:
        shortSided.length === 0
          ? `Every plot is ${sizing.depthM.toFixed(1)} m deep, at or above the ${minSide} m minimum.`
          : `${shortSided.length} plots have a long side under ${minSide} m.`,
    }),
  );

  const aspectMax = pick<number>(client, 'villa_plots.aspect_ratio.max', 2.5);
  const tolerance = pick<number>(client, 'villa_plots.aspect_tolerance', 0.03);
  const aspect = sizing.aspect;
  const aspectOk = aspect <= aspectMax * (1 + tolerance);
  out.push(
    (aspect <= aspectMax ? pass : aspectOk ? warn : fail)({
      id: 'villa.aspect',
      source: 'CLIENT',
      reference: 'client_rules.villa_plots.aspect_ratio',
      title: `Plot aspect 1:${aspect.toFixed(2)} against the 1:${aspectMax} rule`,
      detail:
        aspect <= aspectMax
          ? 'Within the 1:1 to 1:2.5 range.'
          : aspectOk
            ? `Over the rule but inside the ${(tolerance * 100).toFixed(0)}% tolerance the client's own 126 m² example implies.`
            : 'Beyond the rule and the tolerance. Regroup the row housing or change the unit count.',
    }),
  );

  /* ---------------------------------------------------------- yield vs target */
  out.push(
    (m.unitCount <= m.targetUnits ? (m.unitCount >= m.targetUnits * 0.95 ? pass : warn) : fail)({
      id: 'villa.yield',
      source: 'PROGRAMME',
      reference: 'programme.yaml line units',
      title: `${m.unitCount} units placed against a target of ${m.targetUnits}`,
      detail:
        m.unitCount > m.targetUnits
          ? 'The layout places more units than the programme asks for; the generator is not allowed to exceed the target.'
          : `${m.plotCount} plots at ${sizing.grouping} unit${sizing.grouping === 1 ? '' : 's'} each. ${
              m.unitCount < m.targetUnits
                ? `${m.targetUnits - m.unitCount} units short — the zone, its unbuildable ground and the plot module do not hold the full line.`
                : 'On target.'
            }`,
    }),
  );

  /* ---------------------------------------------------------------- setbacks */
  const a1 = baseYards(kmbr, { occupancy: 'A1', heightM: 10 }).yards;
  out.push(
    warn({
      id: 'villa.front_setback',
      source: 'KMBR',
      reference: 'KMBR Table 4 row 1 vs client_rules.setbacks_client.front_m',
      title: `Front setback: client ${setbacks.frontM.toFixed(1)} m against KMBR ${a1.frontAvg.toFixed(1)} m average`,
      detail:
        'Plots are cut to the client rule; the villa footprint is placed to the KMBR average, which is the stricter figure, and compliance follows KMBR.',
      conflict: {
        clientValue: `${setbacks.frontM.toFixed(1)} m`,
        kmbrValue: `${a1.frontAvg.toFixed(1)} m average / ${a1.frontMin.toFixed(1)} m minimum`,
        applied: `${Math.max(setbacks.frontM, a1.frontAvg).toFixed(1)} m`,
        appliedBy: 'KMBR',
      },
    }),
  );

  const gap = villaGapM(kmbr);
  const actualGap = setbacks.sideM * 2;
  out.push(
    (actualGap >= gap ? pass : fail)({
      id: 'villa.gap',
      source: 'KMBR',
      reference: 'KMBR Rule 26 villa_groups_upto_8m_gap_m',
      title: `Gap between villas ${actualGap.toFixed(1)} m against ${gap} m`,
      detail: `Two adjacent villas at ${setbacks.sideM.toFixed(1)} m side setbacks stand ${actualGap.toFixed(1)} m apart. Rule 26 asks ${gap} m for villa groups up to 8 m high.`,
    }),
  );

  /* ------------------------------------------------------------------- roads */
  out.push(
    warn({
      id: 'villa.road_width',
      source: 'KMBR',
      reference: 'KMBR Rule 31 street_min_m vs client_rules.roads.internal.width_m',
      title: `Internal roads ${roads.internalM} m against the Rule 31 ${sub.streetMinM} m street`,
      detail:
        'Reported, not blocked: the client has set the subdivision approval route aside, so the layout keeps the client width.',
      conflict: {
        clientValue: `${roads.internalM} m`,
        kmbrValue: `${sub.streetMinM} m`,
        applied: `${roads.internalM} m`,
        appliedBy: 'CLIENT',
      },
    }),
  );

  /* -------------------------------------------------- recreation and open space */
  const recreation = layout.openSpace.filter((o) => o.countsAsRecreation);
  const recreationArea = recreation.reduce((s, o) => s + o.areaM2, 0);
  const recreationTarget = m.zoneAreaM2 * pick<number>(client, 'recreational_area.share_of_development_or_cluster', 0.1);
  out.push(
    (recreationArea >= recreationTarget ? pass : warn)({
      id: 'villa.recreation',
      source: 'CLIENT',
      reference: 'client_rules.recreational_area + KMBR Rule 31 recreation',
      title: `Recreation ${m2ToAcres(recreationArea).toFixed(2)} ac against a ${m2ToAcres(recreationTarget).toFixed(2)} ac target`,
      detail: `${recreation.length} pieces of at least ${sub.recreationMinAreaM2} m² and ${sub.recreationMinWidthM} m wide qualify, out of ${layout.openSpace.length} open-space pieces totalling ${m2ToAcres(m.openSpaceAreaM2).toFixed(2)} ac.`,
    }),
  );

  /* ------------------------------------------------------------- the terrain */
  const thresholds = pick<Record<string, number>>(assumptions, 'plot_fall_thresholds_m', {});
  const byClass = new Map<string, number>();
  for (const p of layout.plots) byClass.set(p.terrain.fallClass, (byClass.get(p.terrain.fallClass) ?? 0) + 1);
  const hard = (byClass.get('split_level') ?? 0) + (byClass.get('over_split_level') ?? 0);
  // No rule is breached by difficult ground, so this never reads as a failure:
  // it is a cost and buildability warning, and the detail carries the numbers.
  out.push(
    (hard === 0 ? pass : warn)({
      id: 'villa.terrain',
      source: 'ASSUMPTION',
      reference: 'assumptions.plot_fall_thresholds_m',
      title: `${hard} of ${layout.plots.length} plots need a split level or worse`,
      detail: `Fall classes: ${[...byClass.entries()]
        .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
        .join(', ')}. Thresholds: ${Object.entries(thresholds)
        .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v} m`)
        .join(', ')}. Cut ${Math.round(m.cutM3).toLocaleString('en-IN')} m³, fill ${Math.round(m.fillM3).toLocaleString('en-IN')} m³, retaining face about ${Math.round(m.retainingFaceM2).toLocaleString('en-IN')} m².`,
    }),
  );

  const unsurveyedShare = m.zoneAreaM2 > 0 ? m.unsurveyedAreaM2 / m.zoneAreaM2 : 0;
  if (unsurveyedShare > 0.01) {
    out.push(
      warn({
        id: 'villa.unsurveyed',
        source: 'DATA',
        reference: 'data/processed/dem_2m.f32 (NaN = unsurveyed)',
        title: `${(unsurveyedShare * 100).toFixed(0)}% of this zone is unsurveyed`,
        detail:
          'Plots on unsurveyed ground are kept but their levels, cut and fill are low-confidence. Google Earth levels may be added later; they will carry the same flag until a physical survey replaces them.',
      }),
    );
  }

  /* ----------------------------------------------------- unbuildable ground */
  if (m.unbuildableAreaM2 > 0) {
    out.push(
      info({
        id: 'villa.rule22',
        source: 'KMBR',
        reference: 'KMBR Rule 22 no_building_slope_deg_over',
        title: `${m2ToAcres(m.unbuildableAreaM2).toFixed(2)} ac of this zone is too steep to build on`,
        detail: 'Ground over the Rule 22 slope limit is removed from the buildable area and carried as open space.',
      }),
    );
  }

  /* ------------------------------------------------ orientation and corners */
  out.push(
    (m.goodOrientationShare >= 0.75 ? pass : warn)({
      id: 'villa.orientation',
      source: 'CLIENT',
      reference: 'client_rules.plot_orientation.preferred_facing',
      title: `${(m.goodOrientationShare * 100).toFixed(0)}% of plots face E, W or N`,
      detail: `${m.cornerPlots} corner plots, which the client treats as premium.`,
    }),
  );

  return out;
}
