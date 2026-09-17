import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import type { LayoutOption } from '../generators/types';
import type { ApartmentSizing } from './client';
import {
  apartmentRecreation,
  liftCount,
  needsDtpApproval,
  parkingForFlats,
} from './kmbr';
import type { Yards } from './kmbr';
import type { Finding } from './findings';
import { fail, info, pass, warn } from './findings';
import { m2ToAcres, m2ToSft, sftToM2 } from '../units';

export interface TowerCheckContext {
  client: YamlDoc;
  kmbr: YamlDoc;
  assumptions: YamlDoc;
  sizing: ApartmentSizing;
  heightM: number;
  floors: number;
  yards: Yards;
  yardM: number;
  insetM: number;
  minClearM: number;
  requiredClearM: number;
  joinedCount: number;
  /** Towers the zone could not hold, and how many the sizing asked for. */
  towersShort: number;
  towersWanted: number;
  plateDepthM: number;
  plateLengthM: number;
  /** Plate actually built, after spreading the footprint over the tower count. */
  builtPlateM2: number;
  /** Deepest plate the daylight rule allows, with the corridor assumption. */
  maxPlateDepthM: number;
  accessWidthM: number;
  isHighRise: boolean;
  highRiseReason: string;
  travelDistanceM: number;
  daylightDepthM: number;
  aaiCapM: number | null;
}

const fmt = (n: number, dp = 0): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** SPEC 6.2.7: every check the tower generator must report. */
export function checkTowerLayout(layout: LayoutOption, ctx: TowerCheckContext): Finding[] {
  const out: Finding[] = [];
  const m = layout.metrics;
  const { sizing } = ctx;

  /* ------------------------------------------------------------ FSI and coverage */
  const fsiTiers = pick<number[]>(ctx.kmbr, 'table6_coverage_fsi.A1_residential.fsi', [3, 4, 6]);
  const coverageLimit = pick<number>(ctx.kmbr, 'table6_coverage_fsi.A1_residential.coverage', 65);
  const fsiAllowed = Math.max(...fsiTiers);
  const tierLabel = sizing.fsi === fsiTiers[0] ? 'free' : `fee tier (${sizing.fsi})`;
  out.push(
    (m.fsiUsed <= sizing.fsi + 1e-6 ? pass : fail)({
      id: 'tower.fsi',
      source: 'KMBR',
      reference: 'KMBR Table 6 · A1_residential',
      title: `FSI ${m.fsiUsed.toFixed(2)} against the ${sizing.fsi} chosen (${tierLabel}; up to ${fsiAllowed} with fees)`,
      detail: `${fmt(Math.round(m.totalFloorAreaM2))} m² (${fmt(Math.round(m2ToSft(m.totalFloorAreaM2)))} sft) of floor area on ${m2ToAcres(m.zoneAreaM2).toFixed(2)} ac.`,
    }),
  );
  out.push(
    (m.coveragePct <= coverageLimit ? pass : fail)({
      id: 'tower.coverage',
      source: 'KMBR',
      reference: 'KMBR Table 6 coverage',
      title: `Coverage ${m.coveragePct.toFixed(1)}% against the ${coverageLimit}% limit`,
      detail: `${m.towerCount} towers at ${Math.round(ctx.builtPlateM2)} m² each (the client's method gives a ${Math.round(sizing.plateM2)} m² maximum plate; the footprint is spread evenly over the tower count).`,
    }),
  );

  const share = sizing.footprintShareOfLand;
  out.push(
    (sizing.footprintShareOk ? pass : warn)({
      id: 'tower.buildable_share',
      source: 'CLIENT',
      reference: 'client_rules.apartments.buildable_share_of_land',
      title: `Footprint is ${(share * 100).toFixed(0)}% of the land against the client's ${(sizing.buildableShare.min * 100).toFixed(0)}–${(sizing.buildableShare.max * 100).toFixed(0)}%`,
      detail: sizing.footprintShareOk
        ? 'Inside the client band.'
        : `At FSI ${sizing.fsi} over ${sizing.floors > 0 ? 20 : 20} floors the footprint comes out below the band. Either the land is under-used at this FSI, or some of it should go to another use. Raising the FSI tier lifts the share.`,
    }),
  );

  /* ---------------------------------------------------------------- the height */
  const maxFloors = pick<number>(ctx.client, 'apartments.max_floors', 20);
  const maxHeight = pick<number>(ctx.client, 'apartments.max_height_m', 70);
  out.push(
    (ctx.floors <= maxFloors && ctx.heightM <= maxHeight ? pass : fail)({
      id: 'tower.height',
      source: 'CLIENT',
      reference: 'client_rules.apartments.max_floors / max_height_m',
      title: `${ctx.floors} floors, ${ctx.heightM.toFixed(0)} m against the client cap of ${maxFloors} floors / ${maxHeight} m`,
      detail: `At ${pick<number>(ctx.assumptions, 'floor_to_floor_m.apartments', 3)} m floor to floor (assumption).`,
    }),
  );

  if (ctx.aaiCapM === null) {
    out.push(
      warn({
        id: 'tower.aai',
        source: 'DATA',
        reference: 'KMBR aai_noc + assumptions.aai_height_cap_m',
        title: 'AAI height cap is unknown',
        detail:
          'The site is within 20 km of the airport, so an AAI NOC is required and the permissible height is not yet known. The client cap of 20 floors / 70 m is used until the NOC sets one. Enter the cap in the Rules tab to test against it.',
      }),
    );
  } else {
    out.push(
      (ctx.heightM <= ctx.aaiCapM ? pass : fail)({
        id: 'tower.aai',
        source: 'DATA',
        reference: 'assumptions.aai_height_cap_m',
        title: `${ctx.heightM.toFixed(0)} m against the AAI cap of ${ctx.aaiCapM} m`,
        detail: 'Entered by the user; confirm against the NOC itself.',
      }),
    );
  }

  /* --------------------------------------------------------------- the spacing */
  const clearLabel = Number.isFinite(ctx.minClearM) ? `${ctx.minClearM.toFixed(1)} m` : 'n/a (single tower)';
  const kmbrGap = pick<number>(ctx.kmbr, 'chapter17_high_rise.gap_between_blocks_m', 5);
  // A join is allowed only because the zone is too small, so it is always
  // flagged even though the remaining towers keep their clear distance.
  const spacingKept = (!Number.isFinite(ctx.minClearM) || ctx.minClearM >= ctx.requiredClearM) && ctx.joinedCount === 0;
  out.push(
    (spacingKept ? pass : warn)({
      id: 'tower.spacing',
      source: 'CLIENT',
      reference: 'client_rules.apartments.spacing.min_clear_m vs KMBR Ch.XVII',
      title:
        ctx.joinedCount > 0
          ? `${ctx.joinedCount} towers join at 0 m; the rest keep ${clearLabel} against the client minimum of ${ctx.requiredClearM} m`
          : `Closest towers ${clearLabel} against the client minimum of ${ctx.requiredClearM} m`,
      detail:
        ctx.joinedCount > 0
          ? `The zone cannot keep ${ctx.requiredClearM} m for every tower. The client allows a 0 m join only on short sides or in an L, inside the zone offset ${ctx.insetM.toFixed(1)} m inward, and that is what these towers do — an intermediate gap would satisfy neither the client rule nor, below ${kmbrGap} m, KMBR. Check the joined pairs on the plan before accepting this option.`
          : 'Placement maximises the smallest distance between towers, which is what the client asked for.',
      conflict: {
        clientValue: `${ctx.requiredClearM} m clear`,
        kmbrValue: `${kmbrGap} m between high-rise blocks`,
        applied: `${ctx.requiredClearM} m`,
        appliedBy: 'CLIENT',
      },
    }),
  );

  if (ctx.towersShort > 0) {
    out.push(
      fail({
        id: 'tower.capacity',
        source: 'PROGRAMME',
        reference: 'client_rules.apartments + programme land',
        title: `The zone holds ${layout.towers.length} of the ${ctx.towersWanted} towers this scheme needs`,
        detail: `At FSI ${sizing.fsi} over ${ctx.floors} floors the client method asks for ${ctx.towersWanted} towers of ${Math.round(ctx.builtPlateM2)} m². ${ctx.towersShort} of them will not fit inside the zone while keeping the KMBR gap, even with joins. Either raise the FSI tier so fewer, taller towers carry the floor area, give the use more land, or take the shortfall to the programme.`,
      }),
    );
  }

  out.push(
    (!Number.isFinite(ctx.minClearM) || ctx.minClearM >= kmbrGap ? pass : fail)({
      id: 'tower.kmbr_gap',
      source: 'KMBR',
      reference: 'KMBR Chapter XVII gap_between_blocks_m',
      title: `Gap between blocks ${clearLabel} against the KMBR ${kmbrGap} m`,
      detail: 'The KMBR minimum is the one that cannot be traded away, whatever the client rule allows.',
    }),
  );

  out.push(
    info({
      id: 'tower.yards',
      source: 'KMBR',
      reference: 'KMBR Table 4 with the Rule 26 height increment',
      title: `Yards at ${ctx.heightM.toFixed(0)} m: front ${ctx.yards.frontAvg.toFixed(1)} m, rear ${ctx.yards.rearAvg.toFixed(1)} m, side ${ctx.yards.sideAvg.toFixed(1)} m`,
      detail: `Towers are placed inside the zone offset by ${ctx.insetM.toFixed(1)} m, which is the larger of the client's 6 m and the governing KMBR yard of ${ctx.yardM.toFixed(1)} m.`,
    }),
  );

  /* ------------------------------------------------------- plate and daylight */
  const depthOk = ctx.plateDepthM <= ctx.maxPlateDepthM + 1e-6;
  out.push(
    (depthOk ? pass : fail)({
      id: 'tower.daylight',
      source: 'KMBR',
      reference: 'KMBR Rule 41 + assumptions.corridor_width_m',
      title: `Plate depth ${ctx.plateDepthM.toFixed(1)} m against ${ctx.maxPlateDepthM.toFixed(1)} m`,
      detail: `Habitable space must be within ${ctx.daylightDepthM} m of an opening. A double-loaded plate can be twice that plus the corridor, which is not habitable. Plate is ${ctx.plateLengthM.toFixed(0)} × ${ctx.plateDepthM.toFixed(0)} m.`,
    }),
  );

  const twoCoreLimit = 1080;
  if (ctx.builtPlateM2 > twoCoreLimit) {
    out.push(
      warn({
        id: 'tower.cores',
        source: 'KMBR',
        reference: 'KMBR Rule 36 travel distance',
        title: `Plate ${Math.round(ctx.builtPlateM2)} m² needs two cores`,
        detail: `With one core the travel distance on a plate this size exceeds the ${ctx.travelDistanceM} m limit${
          ctx.travelDistanceM === 45 ? ' (sprinklered)' : ''
        }. Each tower is reported with two cores.`,
      }),
    );
  } else {
    out.push(
      pass({
        id: 'tower.cores',
        source: 'KMBR',
        reference: 'KMBR Rule 36 travel distance',
        title: `One core serves a ${Math.round(ctx.builtPlateM2)} m² plate`,
        detail: `Travel distance limit ${ctx.travelDistanceM} m${ctx.travelDistanceM === 45 ? ' (towers sprinklered — an assumption)' : ''}.`,
      }),
    );
  }

  /* ------------------------------------------------------------- the high rise */
  if (ctx.isHighRise) {
    const staircases = pick<number>(ctx.kmbr, 'chapter17_high_rise.staircases_min', 2);
    const gate = pick<number>(ctx.kmbr, 'chapter17_high_rise.entry_gate.width_m_min', 5);
    const stretcherIf = pick<number>(ctx.kmbr, 'chapter17_high_rise.stretcher_lift_if_units_gt', 16);
    const fireLanes = layout.roads.filter((r) => r.kind === 'fire_lane').length;
    out.push(
      (fireLanes >= layout.towers.length ? pass : warn)({
        id: 'tower.high_rise',
        source: 'KMBR',
        reference: 'KMBR Chapter XVII',
        title: `High rise (${ctx.highRiseReason})`,
        detail: `${staircases} staircases per tower, a ${gate} m entry gate with ${gate} m headroom, and 5 m motorable fire lanes on two adjacent sides. ${fireLanes} of ${layout.towers.length} towers have their fire lane drawn; the rest are blocked by the zone edge or steep ground.`,
      }),
    );
    const flatsPerTower = layout.towers[0]?.flats ?? 0;
    out.push(
      info({
        id: 'tower.stretcher_lift',
        source: 'KMBR',
        reference: 'KMBR Chapter XVII stretcher_lift_if_units_gt',
        title: flatsPerTower > stretcherIf ? 'A stretcher lift is required' : 'No stretcher lift required',
        detail: `${flatsPerTower} flats per tower against the ${stretcherIf}-flat trigger.`,
      }),
    );
  }

  /* ------------------------------------------------------------------- lifts */
  const lifts = liftCount(ctx.kmbr, ctx.floors, ctx.builtPlateM2 * ctx.floors, 'A1');
  out.push(
    info({
      id: 'tower.lifts',
      source: 'KMBR',
      reference: 'KMBR Rule 40',
      title: `${lifts} lifts per tower`,
      detail: `One beyond the first four storeys, plus one per 2,500 m² of built-up area over 4,000 m². An NBC traffic calculation may ask for more.`,
    }),
  );

  /* ---------------------------------------------------------------- parking */
  const grossPerCar = pick<number>(ctx.assumptions, 'parking_gross_m2_per_car', 30);
  const floorAreaPerUnit = sftToM2(sizing.avgUnitPlinthSft);
  const parking = parkingForFlats(ctx.kmbr, m.unitCount, floorAreaPerUnit, grossPerCar);
  const parkingFits = parking.totalParkingAreaM2 <= (m.footprintM2 + m.roadAreaM2) * 3;
  out.push(
    (parkingFits ? pass : warn)({
      id: 'tower.parking',
      source: 'KMBR',
      reference: 'KMBR Table 9 + Rule 29',
      title: `${fmt(parking.totalCars)} cars, ${fmt(Math.round(parking.totalParkingAreaM2))} m² of parking`,
      detail: `${parking.basis}. Two-wheeler space at 25% of the car area is included. At ${grossPerCar} m² gross per car (assumption) this is about ${(parking.totalParkingAreaM2 / Math.max(1, m.footprintM2)).toFixed(1)} podium or basement levels under the tower footprints. Ramps no steeper than 1:7, 3.5 m one-way or 5.5 m two-way, with 4 m aisles.`,
    }),
  );

  /* ------------------------------------------------------------- recreation */
  const recreation = apartmentRecreation(ctx.kmbr, m.unitCount, m.totalFloorAreaM2);
  const openAtGround = layout.openSpace
    .filter((o) => o.countsAsRecreation)
    .reduce((s, o) => s + o.areaM2, 0);
  out.push(
    (!recreation.applies || openAtGround >= recreation.groundAreaM2 ? pass : warn)({
      id: 'tower.recreation',
      source: 'KMBR',
      reference: 'KMBR Rule 43',
      title: `Recreation ${fmt(Math.round(recreation.areaM2))} m² required, ${fmt(Math.round(recreation.groundAreaM2))} m² of it at ground`,
      detail: `6% of the total floor area, at least 35% at ground level. The layout leaves ${fmt(Math.round(openAtGround))} m² of usable open space at ground.`,
    }),
  );

  /* ------------------------------------------------------------------ access */
  out.push(
    (layout.roads.some((r) => r.kind === 'access' && r.widthM >= ctx.accessWidthM) ? pass : warn)({
      id: 'tower.access',
      source: 'KMBR',
      reference: 'KMBR Table 7 (A1 by total floor area)',
      title: `Access road ${ctx.accessWidthM} m`,
      detail: `Required for ${fmt(Math.round(m.totalFloorAreaM2))} m² of total floor area. High-rise access must be at least 5 m in any case, with a 5 m gate and 5 m headroom.`,
    }),
  );

  const dtp = needsDtpApproval(ctx.kmbr, 'A1', { dwellingUnits: m.unitCount });
  out.push(
    info({
      id: 'tower.dtp',
      source: 'KMBR',
      reference: 'KMBR Table 11',
      title: dtp.needed ? 'District Town Planner approval is required' : 'No DTP approval trigger',
      detail: dtp.reason,
    }),
  );

  /* ------------------------------------------------------------- the terrain */
  const worst = layout.towers.reduce((w, t) => (Number.isFinite(t.terrain.fall) ? Math.max(w, t.terrain.fall) : w), 0);
  const podiumMax = pick<number>(ctx.kmbr, 'rule26.podium.max_height_m', 16);
  out.push(
    (worst <= 3 ? pass : warn)({
      id: 'tower.podium',
      source: 'KMBR',
      reference: 'KMBR Rule 26 podium',
      title: `Worst fall across a tower footprint is ${worst.toFixed(1)} m`,
      detail: `Terrace the podium so no platform carries more than 3 m. Podiums up to ${podiumMax} m take ground yards sized for the podium height (3 m minimum), with full-height yards at the podium top. Cut ${fmt(Math.round(m.cutM3))} m³, fill ${fmt(Math.round(m.fillM3))} m³.`,
    }),
  );

  if (m.unsurveyedAreaM2 > m.zoneAreaM2 * 0.01) {
    out.push(
      warn({
        id: 'tower.unsurveyed',
        source: 'DATA',
        reference: 'data/processed/dem_2m.f32 (NaN = unsurveyed)',
        title: `${((m.unsurveyedAreaM2 / m.zoneAreaM2) * 100).toFixed(0)}% of this zone is unsurveyed`,
        detail: 'Podium levels over unsurveyed ground are low-confidence until the survey is extended.',
      }),
    );
  }

  return out;
}
