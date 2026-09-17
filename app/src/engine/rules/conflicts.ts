import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import { clientSetbacks, landSplit, roadWidths, sizeVillaPlots } from './client';
import { baseYards, subdivisionRules, villaGapM } from './kmbr';
import type { Finding } from './findings';
import { info, warn } from './findings';

/**
 * Where a client rule is looser than KMBR, both values are shown, the stricter
 * one is applied in compliance status, and the client's first cut is never
 * silently changed. This module produces that list once, from config, so the
 * same wording appears in the UI and in the exported report.
 */
export function ruleConflicts(client: YamlDoc, kmbr: YamlDoc): Finding[] {
  const out: Finding[] = [];
  const setbacks = clientSetbacks(client);
  const roads = roadWidths(client);
  const sub = subdivisionRules(kmbr);
  const a1 = baseYards(kmbr, { occupancy: 'A1', heightM: 10 }).yards;

  if (setbacks.frontM < a1.frontAvg) {
    out.push(
      warn({
        id: 'conflict.front_yard',
        source: 'KMBR',
        reference: 'KMBR Table 4 row 1 vs client_rules.setbacks_client.front_m',
        title: 'Front setback: client 2.0 m against KMBR 3.0 m average',
        detail:
          'The client sheet sets a 2.0 m front setback for roads of 6 m and below. KMBR Table 4 asks for a 3.0 m average with a 1.8 m minimum for A1. Plots are cut to the client rule; the building envelope and compliance status use the KMBR figure.',
        conflict: {
          clientValue: `${setbacks.frontM.toFixed(1)} m`,
          kmbrValue: `${a1.frontAvg.toFixed(1)} m average / ${a1.frontMin.toFixed(1)} m minimum`,
          applied: `${a1.frontAvg.toFixed(1)} m`,
          appliedBy: 'KMBR',
        },
      }),
    );
  }

  if (roads.internalM < sub.streetMinM) {
    out.push(
      warn({
        id: 'conflict.internal_road_width',
        source: 'KMBR',
        reference: 'KMBR Rule 31 street_min_m vs client_rules.roads.internal.width_m',
        title: `Internal roads: client ${roads.internalM} m against KMBR ${sub.streetMinM} m for subdivision streets`,
        detail:
          'Rule 31 asks for 7 m through-streets in a subdivision layout. The client sets 6 m internally. The client set the subdivision approval route aside, so this is flagged, not blocked: the layout keeps 6 m and the finding carries the 7 m figure.',
        conflict: {
          clientValue: `${roads.internalM} m`,
          kmbrValue: `${sub.streetMinM} m`,
          applied: `${roads.internalM} m (client first cut; Rule 31 reported only)`,
          appliedBy: 'CLIENT',
        },
      }),
    );
  }

  const sizing = sizeVillaPlots(client, 1e6, 1e6 / 200);
  if (sizing.minPlotAreaM2 > sub.minPlotM2) {
    out.push(
      info({
        id: 'conflict.min_plot_area',
        source: 'CLIENT',
        reference: 'client_rules.villa_plots.min_side_m vs KMBR Rule 31 min_plot_m2',
        title: `Minimum plot: client ${sizing.minPlotAreaM2.toFixed(1)} m² against KMBR ${sub.minPlotM2} m²`,
        detail:
          "The client's 18 m minimum side at a 1:2.5 aspect gives a larger minimum plot than Rule 31's 125 m². The client rule is the stricter one, so it governs.",
        conflict: {
          clientValue: `${sizing.minPlotAreaM2.toFixed(1)} m²`,
          kmbrValue: `${sub.minPlotM2} m²`,
          applied: `${sizing.minPlotAreaM2.toFixed(1)} m²`,
          appliedBy: 'CLIENT',
        },
      }),
    );
  }

  const clientSpacing = pick<number>(client, 'apartments.spacing.min_clear_m', 12);
  const kmbrHighRiseGap = pick<number>(kmbr, 'chapter17_high_rise.gap_between_blocks_m', 5);
  if (clientSpacing > kmbrHighRiseGap) {
    out.push(
      info({
        id: 'conflict.tower_spacing',
        source: 'CLIENT',
        reference: 'client_rules.apartments.spacing.min_clear_m vs KMBR Ch.XVII gap_between_blocks_m',
        title: `Tower spacing: client ${clientSpacing} m against KMBR ${kmbrHighRiseGap} m`,
        detail:
          'The client asks for towers as far apart as possible and never under 12 m. KMBR Chapter XVII only asks 5 m between high-rise blocks. The client rule is stricter and governs; the 0 m join is allowed only where the zone cannot hold 12 m.',
        conflict: {
          clientValue: `${clientSpacing} m`,
          kmbrValue: `${kmbrHighRiseGap} m`,
          applied: `${clientSpacing} m`,
          appliedBy: 'CLIENT',
        },
      }),
    );
  }

  const split = landSplit(client);
  if (split.openSpace > sub.recreationShare) {
    out.push(
      info({
        id: 'conflict.open_space_share',
        source: 'CLIENT',
        reference: 'client_rules.villa_and_senior_land_split.open_space vs KMBR Rule 31 recreation.share',
        title: `Open space: client ${(split.openSpace * 100).toFixed(0)}% against KMBR ${(sub.recreationShare * 100).toFixed(0)}% recreation`,
        detail:
          "The client's 30% open-space share is well above Rule 31's 10% recreation requirement. The 10% still has to be met as usable recreation in pieces of at least 200 m² and 6 m wide, with their own access; the remaining open space may be drainage, slope or landscape.",
        conflict: {
          clientValue: `${(split.openSpace * 100).toFixed(0)}% open space`,
          kmbrValue: `${(sub.recreationShare * 100).toFixed(0)}% recreation, min ${sub.recreationMinAreaM2} m² pieces`,
          applied: 'both: 30% open space of which 10% must qualify as recreation',
          appliedBy: 'CLIENT',
        },
      }),
    );
  }

  const gap = villaGapM(kmbr);
  if (setbacks.sideM * 2 < gap) {
    out.push(
      warn({
        id: 'conflict.villa_gap',
        source: 'KMBR',
        reference: 'KMBR Rule 26 villa_groups_upto_8m_gap_m vs client_rules.setbacks_client.side_m_each',
        title: `Gap between villas: client side setbacks give ${(setbacks.sideM * 2).toFixed(1)} m against KMBR ${gap} m`,
        detail:
          'Two adjacent villas at the client 1.0 m side setback stand 2.0 m apart, which clears the 1.5 m KMBR asks for villa groups up to 8 m high. Above 8 m the Rule 26 group gaps apply instead.',
        conflict: {
          clientValue: `${(setbacks.sideM * 2).toFixed(1)} m between villas`,
          kmbrValue: `${gap} m`,
          applied: `${gap} m`,
          appliedBy: 'KMBR',
        },
      }),
    );
  }

  out.push(
    info({
      id: 'conflict.approval_route',
      source: 'CLIENT',
      reference: 'docs/DECISIONS.md, 17 Sep 2026',
      title: 'Villa approval route (subdivision vs group housing) is set aside',
      detail:
        'The client has parked the approval route, so Rule 31 subdivision figures are reported and never used to block a layout. If the subdivision route is taken later, the 7 m streets, 125 m² minimum plot, 10% recreation and junction splays become binding.',
    }),
  );

  return out;
}

/** The open items of SPEC §11, shown as switches with their defaults. */
export interface OpenItem {
  key: string;
  label: string;
  value: string;
  alternatives: string[];
  reference: string;
}

export function openItems(client: YamlDoc, assumptions: YamlDoc): OpenItem[] {
  return [
    {
      key: 'core_flats_split',
      label: 'Core / flats split of the tower footprint',
      value: `${(pick<number>(client, 'apartments.core_share_of_footprint', 0.2) * 100).toFixed(0)} / ${(
        pick<number>(client, 'apartments.flats_share_of_footprint', 0.8) * 100
      ).toFixed(0)}`,
      alternatives: ['client note reads "remaining 20%" — a 20% flats reading is possible but implausible'],
      reference: 'client_rules.apartments.core_share_of_footprint',
    },
    {
      key: 'min_side_applies_to',
      label: 'The 18 m minimum applies to',
      value: pick<string>(client, 'villa_plots.min_side_applies_to', 'long_side').replace(/_/g, ' '),
      alternatives: ['both sides — gives a 324 m² minimum plot'],
      reference: 'client_rules.villa_plots.min_side_applies_to',
    },
    {
      key: 'front_yard',
      label: 'Front yard where client and KMBR differ',
      value: 'show both; compliance uses KMBR',
      alternatives: ['apply the client 2.0 m and accept the finding'],
      reference: 'KMBR Table 4 vs client_rules.setbacks_client',
    },
    {
      key: 'fsi_tier',
      label: 'FSI tier for apartments',
      value: '3 (free)',
      alternatives: ['4 (Rs 5,000/m² fee)', '6 (Rs 7,500/m² fee)'],
      reference: 'KMBR Table 6 A1',
    },
    {
      key: 'sprinklered',
      label: 'Towers sprinklered',
      value: String(pick<boolean>(assumptions, 'sprinklered_towers', true)),
      alternatives: ['false — travel distance drops from 45 m to 30 m'],
      reference: 'assumptions.sprinklered_towers',
    },
    {
      key: 'aai_height_cap_m',
      label: 'AAI height cap',
      value: pick<number | null>(assumptions, 'aai_height_cap_m', null) === null ? 'unset' : `${pick<number>(assumptions, 'aai_height_cap_m', 0)} m`,
      alternatives: ['set once the AAI NOC is in hand; the client cap is 20 floors / 70 m'],
      reference: 'assumptions.aai_height_cap_m',
    },
    {
      key: 'tbm_msl_offset_m',
      label: 'TBM to MSL offset',
      value: pick<number | null>(assumptions, 'tbm_msl_offset_m', null) === null ? 'unset — outfall design blocked' : `${pick<number>(assumptions, 'tbm_msl_offset_m', 0)} m`,
      alternatives: ['set after the surveyor ties the TBM to MSL'],
      reference: 'assumptions.tbm_msl_offset_m',
    },
  ];
}
