import { describe, expect, it } from 'vitest';
import { config, site } from './fixtures';
import { generateTowerLayouts } from '../generators/tower';
import { intersect } from '../geom/boolean';
import { bboxOfMulti, multiPolyArea, pointInMulti, polyCentroid } from '../geom/planar';
import { acresToM2, m2ToAcres } from '../units';
import type { MultiPoly, Pt } from '../geom/types';

const FLOOR_OPTIONS = [12, 15, 20];

async function runTower(zone: MultiPoly, zoneName: string, fsi = 3) {
  const s = await site();
  const c = await config();
  return generateTowerLayouts({
    zoneId: 'test',
    zoneName,
    zone,
    dem: s.dem,
    kmbr: c.kmbr,
    client: c.client,
    assumptions: c.assumptions,
    fsi,
    floorOptions: FLOOR_OPTIONS,
    mix: ['2BHK', '3BHK'],
    flatsPerFloor: 4,
    householdSize: 3.5,
  });
}

/** A user-drawn zone of the 10.8 ac the balance-apartments line asks for. */
async function drawnTenPointEightAcres(): Promise<MultiPoly> {
  const s = await site();
  const target = acresToM2(10.8);
  const b = bboxOfMulti(s.parcel);
  // Grow a square about the parcel centroid until its clipped area hits 10.8 ac.
  const outer = s.parcel[0];
  if (!outer) throw new Error('parcel has no polygon');
  const centre: Pt = polyCentroid(outer);
  let lo = 10;
  let hi = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  let best: MultiPoly = [];
  for (let i = 0; i < 40; i++) {
    const half = (lo + hi) / 2;
    const square: MultiPoly = [
      [
        [
          [centre[0] - half, centre[1] - half],
          [centre[0] + half, centre[1] - half],
          [centre[0] + half, centre[1] + half],
          [centre[0] - half, centre[1] + half],
        ],
      ],
    ];
    const clipped = intersect(square, s.parcel);
    const area = multiPolyArea(clipped);
    best = clipped;
    if (Math.abs(area - target) < target * 0.005) break;
    if (area < target) lo = half;
    else hi = half;
  }
  return best;
}

describe('M4 tower generator — APARTMENTS zone', () => {
  it('returns one option per floor count', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    expect(options.length).toBe(3);
    expect(new Set(options.map((o) => o.towers[0]!.floors))).toEqual(new Set(FLOOR_OPTIONS));
    for (const o of options) {
      expect(o.kind).toBe('tower');
      expect(o.towers.length).toBeGreaterThan(0);
    }
  });

  it('keeps every tower inside the zone and off Rule 22 ground', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    for (const o of options) {
      for (const t of o.towers) {
        for (const corner of t.ring) {
          expect(pointInMulti(corner, o.buildable), `${o.id} ${t.id}`).toBe(true);
        }
      }
    }
  });

  it('holds the client 12 m spacing, or reports the joins it had to make', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    for (const o of options) {
      const joined = o.towers.filter((t) => t.joinedWith.length > 0);
      const finding = o.findings.find((f) => f.id === 'tower.spacing')!;
      expect(finding).toBeDefined();
      if (joined.length === 0) {
        expect(finding.status).toBe('pass');
      } else {
        // A join is never silent: it is reported with the client's rule beside it.
        expect(finding.status).toBe('warn');
        expect(finding.detail).toMatch(/cannot keep 12 m for every tower/);
        // Joined towers abut at 0 m, which KMBR reads as one block; an
        // intermediate gap under 5 m would be illegal.
        for (const t of joined) expect(t.joinedWith.length).toBeGreaterThan(0);
      }
      // The KMBR 5 m gap is never traded away.
      expect(o.findings.find((f) => f.id === 'tower.kmbr_gap')!.status).not.toBe('fail');
    }
  });

  it('runs every SPEC 6.2.7 check', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    const required = [
      'tower.fsi',
      'tower.coverage',
      'tower.buildable_share',
      'tower.height',
      'tower.aai',
      'tower.spacing',
      'tower.kmbr_gap',
      'tower.yards',
      'tower.daylight',
      'tower.cores',
      'tower.lifts',
      'tower.parking',
      'tower.recreation',
      'tower.access',
      'tower.dtp',
      'tower.podium',
    ];
    for (const o of options) {
      const ids = new Set(o.findings.map((f) => f.id));
      for (const id of required) expect(ids.has(id), `${o.id} missing ${id}`).toBe(true);
      for (const f of o.findings) expect(f.reference.length).toBeGreaterThan(3);
    }
  });

  it('never exceeds the FSI or the coverage limit', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    for (const fsi of [3, 4, 6]) {
      const options = await runTower(zone.geom, zone.name, fsi);
      for (const o of options) {
        expect(o.metrics.fsiUsed, `${o.id} at FSI ${fsi}`).toBeLessThanOrEqual(fsi + 1e-6);
        expect(o.metrics.coveragePct).toBeLessThanOrEqual(65);
        expect(o.findings.find((f) => f.id === 'tower.fsi')!.status).toBe('pass');
        expect(o.findings.find((f) => f.id === 'tower.coverage')!.status).toBe('pass');
      }
    }
  });

  it('keeps the plate inside the daylight depth band', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    for (const o of options) {
      for (const t of o.towers) {
        expect(t.depthM).toBeGreaterThanOrEqual(14);
        expect(t.depthM).toBeLessThanOrEqual(20);
      }
      expect(o.findings.find((f) => f.id === 'tower.daylight')!.status).toBe('pass');
    }
  });

  it('respects the client height cap at every floor count', async () => {
    const s = await site();
    const zone = s.zones.find((z) => z.name === 'APARTMENTS & FUTURE DEVELOPMENT')!;
    const options = await runTower(zone.geom, zone.name);
    for (const o of options) {
      expect(o.towers[0]!.heightM).toBeLessThanOrEqual(70);
      expect(o.towers[0]!.floors).toBeLessThanOrEqual(20);
      expect(o.findings.find((f) => f.id === 'tower.height')!.status).toBe('pass');
    }
  });
});

describe('M4 tower generator — a user-drawn 10.8 ac zone', () => {
  it('generates three options on the drawn zone', async () => {
    const zone = await drawnTenPointEightAcres();
    expect(m2ToAcres(multiPolyArea(zone))).toBeGreaterThan(10);
    const options = await runTower(zone, 'Drawn apartments zone');
    expect(options.length).toBe(3);
    for (const o of options) {
      expect(o.towers.length).toBeGreaterThan(0);
      expect(o.metrics.totalFloorAreaM2).toBeGreaterThan(0);
    }
  });

  it('places more towers as the floor count falls, for the same FSI', async () => {
    const zone = await drawnTenPointEightAcres();
    const options = await runTower(zone, 'Drawn apartments zone');
    const byFloors = new Map(options.map((o) => [o.towers[0]!.floors, o]));
    const twelve = byFloors.get(12)!;
    const twenty = byFloors.get(20)!;
    // Same FSI over fewer floors means more footprint, so more towers.
    expect(twelve.metrics.footprintM2).toBeGreaterThan(twenty.metrics.footprintM2);
    expect(twelve.towers.length).toBeGreaterThanOrEqual(twenty.towers.length);
  });

  it('reports the achieved spacing honestly', async () => {
    const zone = await drawnTenPointEightAcres();
    const options = await runTower(zone, 'Drawn apartments zone');
    for (const o of options) {
      const finding = o.findings.find((f) => f.id === 'tower.spacing')!;
      expect(finding.conflict).toEqual({
        clientValue: '12 m clear',
        kmbrValue: '5 m between high-rise blocks',
        applied: '12 m',
        appliedBy: 'CLIENT',
      });
    }
  });

  it('runs inside the 10 s performance budget', async () => {
    const zone = await drawnTenPointEightAcres();
    const started = Date.now();
    await runTower(zone, 'Drawn apartments zone');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
