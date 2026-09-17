import * as XLSX from 'xlsx';
import type { LayoutOption } from '../generators/types';
import type { SiteModel } from '../site/loadSite';
import type { ProgrammeSummary } from '../rules/programme';
import type { Level1Result } from '../site/level1';
import { USE_LABEL } from '../site/level1';
import { m2ToAcres, m2ToCents, m2ToSft } from '../units';
import { apartmentSbuaSft, villaSbuaSft } from '../rules/client';
import type { YamlDoc } from '../data/config';

/**
 * The area statement, as the workbook a quantity surveyor would expect: one
 * sheet per level of detail, every number traceable to the rule or data file it
 * came from. UDS is the undivided share of the land that goes with a unit.
 */

export interface XlsxExportOptions {
  site: SiteModel;
  layouts: LayoutOption[];
  programme: ProgrammeSummary;
  level1: Level1Result;
  client: YamlDoc;
}

type Row = Record<string, string | number>;

export function buildAreaStatement(opts: XlsxExportOptions): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  add(wb, 'Summary', summarySheet(opts));
  add(wb, 'Programme', programmeSheet(opts));
  add(wb, 'Zones', zoneSheet(opts));
  add(wb, 'Plots', plotSheet(opts));
  add(wb, 'Towers', towerSheet(opts));
  add(wb, 'Blocks', blockSheet(opts));
  add(wb, 'Compliance', complianceSheet(opts));
  add(wb, 'Cashflow lines', cashflowSheet(opts));
  return wb;
}

function add(wb: XLSX.WorkBook, name: string, rows: Row[]): void {
  const sheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ Note: 'Nothing generated for this sheet yet.' }]);
  XLSX.utils.book_append_sheet(wb, sheet, name.slice(0, 31));
}

function summarySheet(opts: XlsxExportOptions): Row[] {
  const { site, level1, programme } = opts;
  const rows: Row[] = [
    { Item: 'Site', Value: 'Mangalapuram township, Thiruvananthapuram, Kerala', Source: 'docs/SPEC.md' },
    { Item: 'Land in scope (ac)', Value: round(site.parcelAreaAc, 3), Source: 'data/processed/parcel.geojson' },
    { Item: 'Land in scope (m²)', Value: round(site.parcelAreaM2, 1), Source: 'data/processed/parcel.geojson' },
    { Item: 'Land in scope (cents)', Value: round(m2ToCents(site.parcelAreaM2), 1), Source: 'computed' },
    { Item: 'Deferred land (ac)', Value: programme.deferredAc, Source: 'programme.yaml scope' },
    { Item: 'Programme land demand (ac)', Value: round(programme.demandedAc, 2), Source: 'programme.yaml lines' },
    { Item: 'Land shortfall (ac)', Value: round(programme.shortfallAc, 2), Source: 'computed' },
    { Item: 'Zoned by the client plan (ac)', Value: round(level1.zonedAc, 2), Source: 'zones_client_registered.geojson' },
    { Item: 'Unzoned (ac)', Value: round(level1.unzonedAc, 2), Source: 'computed' },
    { Item: 'Level datum', Value: `TBM = ${site.origin.tbm.rl.toFixed(3)} (assumed; MSL offset unknown)`, Source: 'site_origin.json' },
    { Item: 'Coordinates', Value: `local metres; UTM 43N origin E ${site.origin.local_origin_utm[0]} N ${site.origin.local_origin_utm[1]}`, Source: 'site_origin.json' },
    { Item: 'Regulation', Value: `KMBR ${String(opts.site ? '2019 amended 2023' : '')} + 2025 amendment`, Source: 'config/kmbr_rules.yaml' },
    { Item: 'Units placed', Value: level1.totalGeneratedUnits, Source: 'Level 2 generators' },
    { Item: 'Population capacity placed', Value: Math.round(level1.populationCapacity), Source: 'assumptions.household_size_*' },
    { Item: 'Population target now', Value: level1.populationTarget, Source: 'programme.yaml population' },
    { Item: 'Population final capacity', Value: level1.populationFinalCapacity, Source: 'programme.yaml population' },
  ];
  return rows;
}

function programmeSheet(opts: XlsxExportOptions): Row[] {
  return opts.programme.lines.map((l) => ({
    Line: l.id,
    Use: l.use,
    Occupancy: l.occupancy,
    Units: l.units,
    'Plinth per unit (sft)': round(l.plinthSftPerUnit, 0),
    'Plinth total (sft)': round(l.totalPlinthSft, 0),
    'SBUA per unit (sft)': round(l.sbuaSftPerUnit, 1),
    'SBUA total (sft)': round(l.totalSbuaSft, 0),
    'Land (ac)': l.landAc,
    'Coverage (%)': l.coveragePct,
    'FSI (free)': l.fsiFree,
    'Parking (cars)': l.parkingCars,
    'Access (m)': l.accessWidthM,
    'DTP approval': l.dtpApproval ? 'yes' : 'no',
    Status: l.deferred ? 'deferred' : l.isAssumption ? 'assumption' : 'confirmed',
    Notes: l.notes.join(' '),
  }));
}

function zoneSheet(opts: XlsxExportOptions): Row[] {
  const byZone = new Map(opts.layouts.map((l) => [l.zoneId, l]));
  return opts.site.zones
    .filter((z) => z.geom.length > 0)
    .map((z) => {
      const layout = byZone.get(z.id);
      const m = layout?.metrics;
      const assignment = opts.level1.assignments.find((a) => a.zoneId === z.id);
      return {
        Zone: z.name,
        Use: assignment ? USE_LABEL[assignment.use] : '',
        'In scope (ac)': round(z.computedInScopeAc, 3),
        'Drawn (ac)': z.drawnAreaAc,
        'Label (ac)': z.labelAreaAc,
        Confidence: z.confidence,
        Layout: layout?.strategy ?? '',
        'Buildable (ac)': m ? round(m2ToAcres(m.buildableAreaM2), 3) : '',
        'Too steep (ac)': m ? round(m2ToAcres(m.unbuildableAreaM2), 3) : '',
        'Unsurveyed (ac)': m ? round(m2ToAcres(m.unsurveyedAreaM2), 3) : '',
        'Roads (ac)': m ? round(m2ToAcres(m.roadAreaM2), 3) : '',
        'Roads (%)': m ? round(m.shares.roads * 100, 1) : '',
        'Open space (ac)': m ? round(m2ToAcres(m.openSpaceAreaM2), 3) : '',
        'Open space (%)': m ? round(m.shares.openSpace * 100, 1) : '',
        'Saleable (ac)': m ? round(m2ToAcres(m.saleableAreaM2), 3) : '',
        'Saleable (%)': m ? round(m.shares.saleable * 100, 1) : '',
        Plots: m?.plotCount ?? '',
        Units: m?.unitCount ?? '',
        'Target units': m?.targetUnits ?? '',
        Towers: m?.towerCount ?? '',
        'Floor area (sft)': m ? round(m2ToSft(m.totalFloorAreaM2), 0) : '',
        'FSI used': m ? round(m.fsiUsed, 3) : '',
        'Coverage (%)': m ? round(m.coveragePct, 1) : '',
        'Cut (m³)': m ? round(m.cutM3, 0) : '',
        'Fill (m³)': m ? round(m.fillM3, 0) : '',
        'Retaining face (m²)': m ? round(m.retainingFaceM2, 0) : '',
        'Population capacity': m ? Math.round(m.populationCapacity) : '',
      };
    });
}

function plotSheet(opts: XlsxExportOptions): Row[] {
  const rows: Row[] = [];
  for (const layout of opts.layouts) {
    if (layout.plots.length === 0) continue;
    // UDS: the plot itself plus its share of the roads and open space in the zone.
    const saleable = layout.metrics.saleableAreaM2;
    const shared = layout.metrics.roadAreaM2 + layout.metrics.openSpaceAreaM2;
    for (const p of layout.plots) {
      const share = saleable > 0 ? p.areaM2 / saleable : 0;
      const plinthSft = m2ToSft(p.footprintAreaM2);
      rows.push({
        Zone: layout.zoneName,
        Option: layout.strategy,
        Plot: p.id,
        'Area (m²)': round(p.areaM2, 2),
        'Area (cents)': round(m2ToCents(p.areaM2), 2),
        'Width (m)': round(p.widthM, 2),
        'Depth (m)': round(p.depthM, 2),
        Facing: p.facing,
        Corner: p.corner ? 'yes' : 'no',
        'Units on plot': p.unitsOnPlot,
        'Footprint (m²)': round(p.footprintAreaM2, 2),
        'Plinth (sft)': round(plinthSft, 0),
        'SBUA (sft)': round(villaSbuaSft(opts.client, plinthSft), 0),
        'UDS (m²)': round(p.areaM2 + shared * share, 2),
        'Platform RL': Number.isFinite(p.terrain.platformRl) ? round(p.terrain.platformRl, 3) : '',
        'Fall (m)': Number.isFinite(p.terrain.fall) ? round(p.terrain.fall, 2) : '',
        'Fall class': p.terrain.fallClass,
        'Cut (m³)': round(p.terrain.cutM3, 1),
        'Fill (m³)': round(p.terrain.fillM3, 1),
        'Unsurveyed (%)': round(p.terrain.unsurveyedShare * 100, 0),
        Notes: p.notes.join(' '),
      });
    }
  }
  return rows;
}

function towerSheet(opts: XlsxExportOptions): Row[] {
  const rows: Row[] = [];
  for (const layout of opts.layouts) {
    for (const t of layout.towers) {
      const plinthPerFlat = t.flats > 0 ? m2ToSft((t.plateM2 * 0.8 * t.floors) / t.flats) : 0;
      rows.push({
        Zone: layout.zoneName,
        Option: layout.strategy,
        Tower: t.id,
        Floors: t.floors,
        'Height (m)': round(t.heightM, 1),
        'Plate (m²)': round(t.plateM2, 1),
        'Length (m)': round(t.lengthM, 1),
        'Depth (m)': round(t.depthM, 1),
        Cores: t.cores,
        Flats: t.flats,
        'Floor area (m²)': round(t.plateM2 * t.floors, 0),
        'Floor area (sft)': round(m2ToSft(t.plateM2 * t.floors), 0),
        'Plinth per flat (sft)': round(plinthPerFlat, 0),
        'SBUA per flat (sft)': round(apartmentSbuaSft(opts.client, plinthPerFlat), 0),
        'Podium RL': Number.isFinite(t.podiumRl) ? round(t.podiumRl, 3) : '',
        'Fall (m)': Number.isFinite(t.terrain.fall) ? round(t.terrain.fall, 2) : '',
        'Cut (m³)': round(t.terrain.cutM3, 0),
        'Fill (m³)': round(t.terrain.fillM3, 0),
        'Joined to': t.joinedWith.join(', '),
        Notes: t.notes.join(' '),
      });
    }
  }
  return rows;
}

function blockSheet(opts: XlsxExportOptions): Row[] {
  const rows: Row[] = [];
  for (const layout of opts.layouts) {
    for (const b of layout.blocks) {
      rows.push({
        Zone: layout.zoneName,
        Use: b.use,
        Block: b.id,
        Floors: b.floors,
        'Height (m)': round(b.heightM, 1),
        'Footprint (m²)': round(b.footprintM2, 1),
        'Built up (m²)': round(b.builtUpM2, 1),
        'Built up (sft)': round(m2ToSft(b.builtUpM2), 0),
        'Coverage (%)': round(layout.metrics.coveragePct, 1),
        'FSI used': round(layout.metrics.fsiUsed, 3),
        'Platform RL': Number.isFinite(b.terrain.platformRl) ? round(b.terrain.platformRl, 3) : '',
        'Fall (m)': Number.isFinite(b.terrain.fall) ? round(b.terrain.fall, 2) : '',
        Notes: b.notes.join(' '),
      });
    }
  }
  return rows;
}

function complianceSheet(opts: XlsxExportOptions): Row[] {
  const rows: Row[] = [];
  for (const layout of opts.layouts) {
    for (const f of layout.findings) {
      rows.push({
        Zone: layout.zoneName,
        Status: f.status,
        Source: f.source,
        Reference: f.reference,
        Finding: f.title,
        Detail: f.detail,
        'Client value': f.conflict?.clientValue ?? '',
        'KMBR value': f.conflict?.kmbrValue ?? '',
        Applied: f.conflict ? `${f.conflict.applied} (${f.conflict.appliedBy})` : '',
      });
    }
  }
  for (const f of opts.level1.findings) {
    rows.push({
      Zone: 'WHOLE SITE',
      Status: f.status,
      Source: f.source,
      Reference: f.reference,
      Finding: f.title,
      Detail: f.detail,
      'Client value': '',
      'KMBR value': '',
      Applied: '',
    });
  }
  return rows;
}

/** Programme lines in the shape the client's cashflow workbook uses. */
function cashflowSheet(opts: XlsxExportOptions): Row[] {
  return opts.programme.lines.map((l) => ({
    Line: l.id,
    Use: l.use,
    'Units / keys': l.units,
    'Area per unit (sft plinth)': round(l.plinthSftPerUnit, 0),
    'Total area (sft)': round(l.totalPlinthSft, 0),
    'SBUA (sft)': round(l.totalSbuaSft, 0),
    'Land (ac)': l.landAc,
    'Land (m²)': round(l.landAc * 4046.8564, 0),
    Status: l.deferred ? 'DEFERRED' : 'in scope',
    Source: 'Phasing_and_Cashflows_V4_06092026.xlsx + docs/DECISIONS.md',
  }));
}

const round = (n: number, dp: number): number => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

export function workbookToBlob(wb: XLSX.WorkBook): Blob {
  const array = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([array], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
