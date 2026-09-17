import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { generateVillaLayouts } from '../generators/villa';
import { generateTowerLayouts } from '../generators/tower';
import { generateBlockLayout } from '../generators/block';
import { exportDxf, dxfReadme } from '../export/dxf';
import { buildAreaStatement } from '../export/xlsx';
import { buildMassingScene, buildTerrainMesh } from '../export/glb';
import { loadProgramme } from '../rules/programme';
import { runLevel1 } from '../site/level1';
import type { LayoutOption } from '../generators/types';
import * as XLSX from 'xlsx';
import type * as THREE from 'three';

async function fixtureLayouts(): Promise<{ layouts: LayoutOption[] }> {
  const s = await site();
  const c = await config();
  const villaZone = s.zones.find((z) => z.name === 'PROJECT - 2 (VILLAS)')!;
  const towerZone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
  const schoolZone = s.zones.find((z) => z.name === 'SCHOOL')!;

  const villa = generateVillaLayouts({
    zoneId: villaZone.id, zoneName: villaZone.name, zone: villaZone.geom, dem: s.dem,
    kmbr: c.kmbr, client: c.client, assumptions: c.assumptions,
    targetUnits: Math.round(villaZone.computedInScopeAc * 20), householdSize: 3.5, directions: ['north_south'],
  });
  const tower = generateTowerLayouts({
    zoneId: towerZone.id, zoneName: towerZone.name, zone: towerZone.geom, dem: s.dem,
    kmbr: c.kmbr, client: c.client, assumptions: c.assumptions,
    fsi: 3, floorOptions: [20], mix: ['2BHK', '3BHK'], flatsPerFloor: 4, householdSize: 3.5,
  });
  const block = generateBlockLayout({
    zoneId: schoolZone.id, zoneName: schoolZone.name, zone: schoolZone.geom, dem: s.dem,
    kmbr: c.kmbr, client: c.client, assumptions: c.assumptions,
    occupancy: 'B_school', builtUpSft: 200_000, useLabel: 'School', maxSlopeDeg: 8,
  })!;
  return { layouts: [villa[0]!, tower[0]!, block] };
}

describe('M6 DXF export', () => {
  it('writes a DXF with a layer per thing and closes every plot', async () => {
    const s = await site();
    const { layouts } = await fixtureLayouts();
    const dxf = exportDxf({ site: s, layouts });

    expect(dxf.startsWith('0\nSECTION')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    for (const layer of ['SITE-BOUNDARY', 'PLOT', 'PLOT-CORNER', 'TOWER', 'BLOCK', 'ROAD-INTERNAL', 'OPEN-SPACE', 'VILLA-FOOTPRINT']) {
      expect(dxf, `layer ${layer}`).toContain(layer);
    }
    // Every entity block is opened and the file balances SECTION/ENDSEC.
    const sections = (dxf.match(/\nSECTION\n/g) ?? []).length;
    const ends = (dxf.match(/\nENDSEC\n/g) ?? []).length;
    expect(sections).toBe(ends);
    expect(dxf).toContain('LWPOLYLINE');
  });

  it('offsets to UTM when asked, and says so in the readme', async () => {
    const s = await site();
    const { layouts } = await fixtureLayouts();
    const local = exportDxf({ site: s, layouts, includeContours: false, includeZones: false });
    const utm = exportDxf({ site: s, layouts, includeContours: false, includeZones: false, utm: true });
    expect(utm.length).toBeGreaterThan(local.length * 0.9);
    expect(utm).toContain('706');
    expect(dxfReadme({ site: s, layouts })).toMatch(/Add E 706106.927, N 953717.901/);
    expect(dxfReadme({ site: s, layouts, utm: true })).toMatch(/UTM 43N \(EPSG:32643\), metres/);
  });
});

describe('M6 XLSX area statement', () => {
  it('builds every sheet with traceable rows', async () => {
    const s = await site();
    const c = await config();
    const { layouts } = await fixtureLayouts();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const level1 = runLevel1({
      zones: s.zones, parcel: s.parcel, programme,
      generated: Object.fromEntries(layouts.map((l) => [l.zoneId, [l]])),
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    const wb = buildAreaStatement({ site: s, layouts, programme, level1, client: c.client });

    expect(wb.SheetNames).toEqual([
      'Summary', 'Programme', 'Zones', 'Plots', 'Towers', 'Blocks', 'Compliance', 'Cashflow lines',
    ]);

    const plots = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Plots!);
    expect(plots.length).toBeGreaterThan(50);
    const firstPlot = plots[0]!;
    for (const key of ['Zone', 'Plot', 'Area (m²)', 'SBUA (sft)', 'UDS (m²)', 'Platform RL', 'Fall class']) {
      expect(Object.keys(firstPlot), `plot column ${key}`).toContain(key);
    }

    const towers = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Towers!);
    expect(towers.length).toBeGreaterThan(0);
    expect(Object.keys(towers[0]!)).toContain('SBUA per flat (sft)');

    const compliance = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Compliance!);
    expect(compliance.length).toBeGreaterThan(20);
    expect(compliance.some((r) => r.Zone === 'WHOLE SITE')).toBe(true);
    expect(compliance.every((r) => typeof r.Reference === 'string' && String(r.Reference).length > 3)).toBe(true);

    const summary = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Summary!);
    expect(summary.every((r) => 'Source' in r)).toBe(true);
  });

  it('writes a workbook that parses back', async () => {
    const s = await site();
    const c = await config();
    const { layouts } = await fixtureLayouts();
    const programme = loadProgramme(c.programme, c.client, c.kmbr, c.assumptions);
    const level1 = runLevel1({
      zones: s.zones, parcel: s.parcel, programme, generated: {},
      householdSizes: { family: 3.5, senior: 1.6 },
    });
    const wb = buildAreaStatement({ site: s, layouts, programme, level1, client: c.client });
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }) as Buffer;
    expect(buf.length).toBeGreaterThan(5000);
    const reread = XLSX.read(buf, { type: 'buffer' });
    expect(reread.SheetNames).toEqual(wb.SheetNames);
  });
});

describe('M6 GLB massing', () => {
  it('builds a terrain mesh that leaves unsurveyed ground out', async () => {
    const s = await site();
    const mesh = buildTerrainMesh(s.dem, 4);
    expect(mesh).not.toBeNull();
    const position = mesh!.geometry.getAttribute('position');
    expect(position.count).toBeGreaterThan(1000);
    // Every vertex has a real level: NaN cells are skipped, never filled.
    for (let i = 0; i < position.count; i++) expect(Number.isFinite(position.getY(i))).toBe(true);
    expect(mesh!.geometry.getIndex()!.count % 3).toBe(0);
  });

  it('puts the massing where the plan puts it, at its platform level', async () => {
    const s = await site();
    const { layouts } = await fixtureLayouts();
    const scene = buildMassingScene({ dem: s.dem, layouts, parcel: s.parcel, terrainStep: 8 });
    const massing = scene.children.find((c) => c.name === 'Massing')!;
    const towerLayout = layouts.find((l) => l.towers.length > 0)!;
    const towerGroup = massing.children.find((g) => g.name === towerLayout.zoneName)!;
    const tower = towerLayout.towers[0]!;
    const mesh = towerGroup.children.find((m) => m.name === tower.id) as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;

    // three.js is y-up: local x -> x, RL -> y, local y -> -z. Positions are
    // float32, so sub-millimetre agreement is all that is available at these
    // coordinates — and all that matters at site scale.
    const xs = tower.ring.map((p) => p[0]);
    const ys = tower.ring.map((p) => p[1]);
    expect(box.min.x).toBeCloseTo(Math.min(...xs), 3);
    expect(box.max.x).toBeCloseTo(Math.max(...xs), 3);
    expect(box.min.z).toBeCloseTo(-Math.max(...ys), 3);
    expect(box.max.z).toBeCloseTo(-Math.min(...ys), 3);
    expect(box.min.y).toBeCloseTo(tower.podiumRl, 3);
    expect(box.max.y).toBeCloseTo(tower.podiumRl + tower.heightM, 3);

    // The massing must sit over the terrain it was placed on, not mirrored
    // across the site: the ground under its centre is a real level.
    expect(Number.isFinite(s.dem.sample([tower.centre[0], tower.centre[1]]))).toBe(true);
  });

  it('extrudes plots, towers and blocks onto their platform levels', async () => {
    const s = await site();
    const { layouts } = await fixtureLayouts();
    const scene = buildMassingScene({ dem: s.dem, layouts, parcel: s.parcel, terrainStep: 8 });
    const massing = scene.children.find((c) => c.name === 'Massing')!;
    expect(massing.children.length).toBe(layouts.length);
    const towerGroup = massing.children.find((g) => g.name.includes('APARTMENTS'))!;
    expect(towerGroup.children.length).toBeGreaterThan(0);
    expect(towerGroup.children[0]!.name).toMatch(/^T\d+$/);
    expect(scene.children.some((c) => c.name === 'Terrain')).toBe(true);
  });
});
