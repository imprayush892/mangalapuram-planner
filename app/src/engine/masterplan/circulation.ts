import type { WaterModel } from '../terrain/water';
import type { Dem } from '../terrain/dem';
import type { MultiPoly, Pt } from '../geom/types';
import type { SiteFeature } from '../site/types';
import { bufferPolyline } from '../geom/offset';
import { intersect, union } from '../geom/boolean';
import { bboxOfMulti, multiPolyArea, pointInMulti } from '../geom/planar';

/**
 * Site circulation: the roads that exist between the zones, as opposed to the
 * ones each zone generator lays out inside itself.
 *
 * Three tiers, all of them read from the client's own road table rather than
 * invented here:
 *
 *  - `public`   existing road edges, retained and widened (client `roads.public`).
 *  - `spine`    the main spine, strictly north-south (client `roads.main_spine`).
 *  - `collector` what joins a zone to the tier above it. There is no client
 *               width for this tier, so each collector takes the KMBR access
 *               width its zone's occupancy requires, which is a rule, not a
 *               guess.
 *
 * Collectors are routed over the terrain rather than drawn straight: the cost
 * of a step is its length times a penalty on the grade it climbs, so a
 * collector contours around a slope the way a built road would, and Rule 22
 * ground is impassable. Once a collector is traced it becomes a source for the
 * next zone, so the network branches instead of every zone running its own line
 * back to the highway.
 */

export type CirculationTier = 'public' | 'spine' | 'collector';

export interface CirculationRoad {
  id: string;
  tier: CirculationTier;
  centreline: Pt[];
  widthM: number;
  geom: MultiPoly;
  lengthM: number;
  /** Zone this road was traced for, on a collector. */
  zoneId?: string;
  /** Rise over the centreline, and the steepest stretch, both in metres. */
  riseM: number;
  maxGradePct: number;
  notes: string[];
}

export interface ZoneGate {
  zoneId: string;
  /** Where the collector meets the zone. */
  point: Pt;
  /** Route length from the gate back to a public road or the spine. */
  routeLengthM: number;
  /** True when the zone already fronts a road and needed no collector. */
  direct: boolean;
}

export interface CirculationResult {
  roads: CirculationRoad[];
  gates: ZoneGate[];
  /** Zones that could not be reached at all, with the reason. */
  unreachable: { zoneId: string; reason: string }[];
  notes: string[];
}

export interface CirculationInput {
  dem: Dem;
  parcel: MultiPoly;
  features: SiteFeature[];
  /** Zones to connect, in the order they should be served. */
  zones: { id: string; name: string; geom: MultiPoly; accessWidthM: number }[];
  publicWidthM: number;
  spineWidthM: number;
  /** Rule 22 slope above which ground cannot be built on or crossed. */
  unbuildableSlopeDeg: number;
  /**
   * Metres of detour a route will accept to avoid one metre of climb. Higher
   * values hug the contours; 0 routes straight over anything passable.
   */
  gradePenaltyM: number;
  /**
   * Metres of detour a route will accept to avoid crossing a watercourse. A
   * crossing is a culvert, so a water-led plan pays to go round.
   */
  waterPenaltyM?: number;
  /** Hydrology, so a route can be charged for the water it crosses. */
  water?: WaterModel;
}

const BLOCKED = -1;

/** Rasterised cost field over the DEM grid, restricted to the parcel. */
class RouteGrid {
  readonly dem: Dem;
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  /** -1 blocked, otherwise the per-metre multiplier for entering the cell. */
  readonly passable: Int8Array;
  readonly rl: Float32Array;
  /** 1 where the cell carries water, so a step onto it is a crossing. */
  readonly wet: Uint8Array;

  constructor(dem: Dem, parcel: MultiPoly, unbuildableSlopeDeg: number, water?: WaterModel) {
    this.dem = dem;
    this.nx = dem.meta.nx;
    this.ny = dem.meta.ny;
    this.cell = dem.cell;
    this.passable = new Int8Array(this.nx * this.ny);
    this.rl = new Float32Array(this.nx * this.ny);
    this.wet = new Uint8Array(this.nx * this.ny);
    const slope = dem.slopeGrid();
    const b = bboxOfMulti(parcel);
    for (let j = 0; j < this.ny; j += 1) {
      for (let i = 0; i < this.nx; i += 1) {
        const k = j * this.nx + i;
        const p = dem.cellCentre(i, j);
        this.rl[k] = dem.at(i, j);
        if (p[0] < b.minX || p[0] > b.maxX || p[1] < b.minY || p[1] > b.maxY) {
          this.passable[k] = BLOCKED;
          continue;
        }
        if (!pointInMulti(p, parcel)) {
          this.passable[k] = BLOCKED;
          continue;
        }
        const s = slope[k] ?? Number.NaN;
        // An unsurveyed cell is crossable but flagged, never silently treated
        // as flat: NaN slope means we do not know, not that it is fine.
        this.passable[k] = Number.isNaN(s) || s <= unbuildableSlopeDeg ? 1 : BLOCKED;
        if (water && water.distanceToWaterM[k]! <= this.cell) this.wet[k] = 1;
      }
    }
  }

  index(p: Pt): number | null {
    const c = this.dem.cellAt(p);
    if (!c) return null;
    return c.j * this.nx + c.i;
  }

  centre(k: number): Pt {
    return this.dem.cellCentre(k % this.nx, Math.floor(k / this.nx));
  }
}

/**
 * Multi-source Dijkstra over the 8-neighbourhood. Sources start at cost 0; the
 * result is the cost to reach every cell and the step that got there, which is
 * what a route is traced back along.
 */
function spread(
  grid: RouteGrid,
  sources: Iterable<number>,
  gradePenaltyM: number,
  waterPenaltyM = 0,
): { cost: Float64Array; from: Int32Array } {
  const n = grid.nx * grid.ny;
  const cost = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(n).fill(-1);
  // A binary heap keyed on cost; the grid is 160k cells, so this stays cheap.
  const heap: number[] = [];
  const heapCost: number[] = [];
  const push = (k: number, c: number): void => {
    heap.push(k);
    heapCost.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapCost[parent]! <= heapCost[i]!) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      [heapCost[parent], heapCost[i]] = [heapCost[i]!, heapCost[parent]!];
      i = parent;
    }
  };
  const pop = (): { k: number; c: number } | null => {
    if (heap.length === 0) return null;
    const k = heap[0]!;
    const c = heapCost[0]!;
    const lastK = heap.pop()!;
    const lastC = heapCost.pop()!;
    if (heap.length > 0) {
      heap[0] = lastK;
      heapCost[0] = lastC;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < heap.length && heapCost[l]! < heapCost[small]!) small = l;
        if (r < heap.length && heapCost[r]! < heapCost[small]!) small = r;
        if (small === i) break;
        [heap[small], heap[i]] = [heap[i]!, heap[small]!];
        [heapCost[small], heapCost[i]] = [heapCost[i]!, heapCost[small]!];
        i = small;
      }
    }
    return { k, c };
  };

  for (const s of sources) {
    if (s < 0 || s >= n || grid.passable[s] === BLOCKED) continue;
    if (cost[s] === 0) continue;
    cost[s] = 0;
    push(s, 0);
  }

  const { nx, ny, cell } = grid;
  const diag = cell * Math.SQRT2;
  while (heap.length > 0) {
    const top = pop();
    if (!top) break;
    const { k, c } = top;
    if (c > cost[k]!) continue;
    const i = k % nx;
    const j = Math.floor(k / nx);
    for (let dj = -1; dj <= 1; dj += 1) {
      for (let di = -1; di <= 1; di += 1) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        if (grid.passable[nk] === BLOCKED) continue;
        const run = di !== 0 && dj !== 0 ? diag : cell;
        const a = grid.rl[k]!;
        const b = grid.rl[nk]!;
        // Unsurveyed ground carries no known climb, so it costs its length.
        const rise = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.abs(b - a);
        // Entering a wet cell is a crossing, charged once at the bank.
        const crossing = waterPenaltyM > 0 && grid.wet[nk] === 1 && grid.wet[k] === 0 ? waterPenaltyM : 0;
        const step = run + gradePenaltyM * rise + crossing;
        const next = c + step;
        if (next < cost[nk]!) {
          cost[nk] = next;
          from[nk] = k;
          push(nk, next);
        }
      }
    }
  }
  return { cost, from };
}

/** Drops collinear points so a traced route is a polyline, not a cell chain. */
function simplify(points: Pt[], toleranceM: number): Pt[] {
  if (points.length <= 2) return points;
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len > 0 && Math.abs(cross) / len > toleranceM) out.push(b);
  }
  out.push(points[points.length - 1]!);
  return out;
}

function polylineLength(line: readonly Pt[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    total += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
  }
  return total;
}

function profile(dem: Dem, line: readonly Pt[]): { riseM: number; maxGradePct: number } {
  let rise = 0;
  let maxGrade = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = dem.sampleBilinear(line[i - 1]!);
    const b = dem.sampleBilinear(line[i]!);
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const run = Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
    rise += Math.abs(b - a);
    if (run > 0) maxGrade = Math.max(maxGrade, (Math.abs(b - a) / run) * 100);
  }
  return { riseM: rise, maxGradePct: maxGrade };
}

/**
 * The main spine runs strictly north-south (client `roads.main_spine`, angular
 * tolerance 0), so the only choice is where to put it. Each easting is scored
 * on the length of its longest usable north-south run times how much zone land
 * that run serves, so the line is both long and useful rather than merely
 * central.
 */
function placeSpine(input: CirculationInput, grid: RouteGrid): CirculationRoad | null {
  const b = bboxOfMulti(input.parcel);
  const zoneCentres = input.zones
    .filter((z) => z.geom.length > 0)
    .map((z) => ({ box: bboxOfMulti(z.geom), area: multiPolyArea(z.geom) }));
  if (zoneCentres.length === 0) return null;

  const step = grid.cell;
  // A notch in the boundary or a stretch of Rule 22 ground is something a road
  // bridges, not something that ends it; a gap longer than this does end it.
  const bridgeM = 40;

  /** The longest north-south run on one easting, gaps up to `bridgeM` bridged. */
  const bestRunOn = (x: number): { y0: number; y1: number; onSite: number } | null => {
    let best: { y0: number; y1: number; onSite: number } | null = null;
    let runStart: number | null = null;
    let lastGood: number | null = null;
    let onSite = 0;
    const close = (): void => {
      if (runStart === null || lastGood === null) return;
      if (!best || lastGood - runStart > best.y1 - best.y0) best = { y0: runStart, y1: lastGood, onSite };
      runStart = null;
      lastGood = null;
      onSite = 0;
    };
    for (let y = b.minY; y <= b.maxY; y += step) {
      const k = grid.index([x, y]);
      const ok = k !== null && grid.passable[k] !== BLOCKED;
      if (ok) {
        if (runStart === null) runStart = y;
        lastGood = y;
        onSite += 1;
      } else if (lastGood !== null && y - lastGood > bridgeM) {
        close();
      }
    }
    close();
    return best;
  };

  let best: { x: number; score: number; run: { y0: number; y1: number; onSite: number } } | null = null;
  for (let x = b.minX + step; x < b.maxX - step; x += step * 2) {
    const run = bestRunOn(x);
    if (!run) continue;
    const length = run.y1 - run.y0;
    if (length < 100) continue;
    // How much zone land the line passes near, weighted by area and distance.
    let served = 0;
    for (const z of zoneCentres) {
      const cx = (z.box.minX + z.box.maxX) / 2;
      served += z.area / (1 + Math.abs(cx - x) / 200);
    }
    // A line that spends most of its length off the parcel is not a road.
    const solid = run.onSite / Math.max(1, length / step);
    const score = length * served * solid * solid;
    if (!best || score > best.score) best = { x, score, run };
  }
  if (!best) return null;

  const centreline: Pt[] = [
    [best.x, best.run.y0],
    [best.x, best.run.y1],
  ];
  const geom = intersect(bufferPolyline(centreline, input.spineWidthM), input.parcel);
  if (geom.length === 0) return null;
  const samples: Pt[] = [];
  for (let y = best.run.y0; y <= best.run.y1; y += 20) samples.push([best.x, y]);
  const prof = profile(input.dem, samples);
  const bridged = Math.round((1 - best.run.onSite / Math.max(1, (best.run.y1 - best.run.y0) / step)) * 100);
  return {
    id: 'spine-main',
    tier: 'spine',
    centreline,
    widthM: input.spineWidthM,
    geom,
    lengthM: polylineLength(centreline),
    riseM: prof.riseM,
    maxGradePct: prof.maxGradePct,
    notes: [
      'north-south alignment fixed by the client rule roads.main_spine (angular tolerance 0°)',
      `placed at x = ${best.x.toFixed(0)} m, the easting whose longest north-south run serves the most zone land`,
      ...(bridged > 2 ? [`${bridged}% of the line bridges a notch in the boundary or Rule 22 ground`] : []),
    ],
  };
}

/** Existing road edges, retained and widened to the client's public width. */
function publicRoads(input: CirculationInput): CirculationRoad[] {
  const edges = input.features.filter((f) => f.kind === 'existing_road_edge');
  const out: CirculationRoad[] = [];
  let n = 0;
  for (const line of edges.flatMap((f) => f.lines)) {
    if (line.length < 2) continue;
    const geom = intersect(bufferPolyline(line, input.publicWidthM), input.parcel);
    if (geom.length === 0) continue;
    const prof = profile(input.dem, line);
    n += 1;
    out.push({
      id: `public-${n}`,
      tier: 'public',
      centreline: line,
      widthM: input.publicWidthM,
      geom,
      lengthM: polylineLength(line),
      riseM: prof.riseM,
      maxGradePct: prof.maxGradePct,
      notes: ['existing road edge retained and widened (client roads.public)'],
    });
  }
  return out;
}

export function generateCirculation(input: CirculationInput): CirculationResult {
  const grid = new RouteGrid(input.dem, input.parcel, input.unbuildableSlopeDeg, input.water);
  const notes: string[] = [];
  const roads: CirculationRoad[] = [];

  const pubs = publicRoads(input);
  roads.push(...pubs);
  notes.push(`${pubs.length} existing road edges retained at ${input.publicWidthM} m`);

  const spine = placeSpine(input, grid);
  if (spine) {
    roads.push(spine);
    notes.push(`main spine ${spine.lengthM.toFixed(0)} m at ${input.spineWidthM} m, north-south`);
  } else {
    notes.push('no north-south line long enough for the main spine was found inside the parcel');
  }

  // Everything already built is a source the collectors can join.
  const sources = new Set<number>();
  const seed = (geom: MultiPoly): void => {
    const b = bboxOfMulti(geom);
    const c = grid.cell;
    for (let y = b.minY; y <= b.maxY; y += c) {
      for (let x = b.minX; x <= b.maxX; x += c) {
        const p: Pt = [x, y];
        if (!pointInMulti(p, geom)) continue;
        const k = grid.index(p);
        if (k !== null && grid.passable[k] !== BLOCKED) sources.add(k);
      }
    }
  };
  for (const r of roads) seed(r.geom);

  const gates: ZoneGate[] = [];
  const unreachable: { zoneId: string; reason: string }[] = [];

  if (sources.size === 0) {
    return {
      roads,
      gates,
      unreachable: input.zones.map((z) => ({ zoneId: z.id, reason: 'no road to connect to' })),
      notes: [...notes, 'no existing road or spine fell inside the parcel, so no collector could be traced'],
    };
  }

  // Serve the cheapest zone first and fold its collector into the sources, so
  // the next zone joins the network rather than the highway.
  const pending = input.zones.filter((z) => z.geom.length > 0);
  let collectorCount = 0;
  while (pending.length > 0) {
    const { cost, from } = spread(grid, sources, input.gradePenaltyM, input.waterPenaltyM ?? 0);

    let bestZone: { index: number; cell: number; cost: number } | null = null;
    for (let z = 0; z < pending.length; z += 1) {
      const zone = pending[z]!;
      const b = bboxOfMulti(zone.geom);
      let cheapest: { cell: number; cost: number } | null = null;
      for (let y = b.minY; y <= b.maxY; y += grid.cell) {
        for (let x = b.minX; x <= b.maxX; x += grid.cell) {
          const p: Pt = [x, y];
          if (!pointInMulti(p, zone.geom)) continue;
          const k = grid.index(p);
          if (k === null) continue;
          const c = cost[k]!;
          if (!Number.isFinite(c)) continue;
          if (!cheapest || c < cheapest.cost) cheapest = { cell: k, cost: c };
        }
      }
      if (!cheapest) continue;
      if (!bestZone || cheapest.cost < bestZone.cost) {
        bestZone = { index: z, cell: cheapest.cell, cost: cheapest.cost };
      }
    }

    if (!bestZone) {
      for (const zone of pending) {
        unreachable.push({
          zoneId: zone.id,
          reason: 'no route inside the parcel avoids Rule 22 ground',
        });
      }
      break;
    }

    const zone = pending[bestZone.index]!;
    pending.splice(bestZone.index, 1);

    // Trace back to whichever source the route came from.
    const chain: Pt[] = [];
    let k: number = bestZone.cell;
    let guard = 0;
    while (k >= 0 && guard < grid.nx * grid.ny) {
      chain.push(grid.centre(k));
      const prev = from[k]!;
      if (prev < 0) break;
      k = prev;
      guard += 1;
    }
    chain.reverse();
    const gatePoint = chain[chain.length - 1] ?? grid.centre(bestZone.cell);

    if (chain.length < 2) {
      // The zone already sits on a road: it needs a gate, not a collector.
      gates.push({ zoneId: zone.id, point: gatePoint, routeLengthM: 0, direct: true });
      seed(zone.geom);
      continue;
    }

    const line = simplify(chain, grid.cell * 0.75);
    const width = Math.max(zone.accessWidthM, 0);
    const geom = intersect(bufferPolyline(line, width), input.parcel);
    const length = polylineLength(line);
    if (geom.length === 0 || length < grid.cell) {
      gates.push({ zoneId: zone.id, point: gatePoint, routeLengthM: length, direct: true });
      seed(zone.geom);
      continue;
    }

    collectorCount += 1;
    const prof = profile(input.dem, line);
    const road: CirculationRoad = {
      id: `collector-${collectorCount}`,
      tier: 'collector',
      centreline: line,
      widthM: width,
      geom,
      lengthM: length,
      zoneId: zone.id,
      riseM: prof.riseM,
      maxGradePct: prof.maxGradePct,
      notes: [`${width} m is the KMBR access width for this zone's occupancy`],
    };
    roads.push(road);
    gates.push({ zoneId: zone.id, point: gatePoint, routeLengthM: length, direct: false });
    seed(road.geom);
    seed(zone.geom);
  }

  notes.push(
    `${collectorCount} collectors traced over the terrain to join the zones to the network, detouring ${input.gradePenaltyM.toFixed(0)} m per metre of climb${
      (input.waterPenaltyM ?? 0) > 0 ? ` and ${(input.waterPenaltyM ?? 0).toFixed(0)} m to avoid each watercourse crossing` : ''
    }`,
  );
  return { roads, gates, unreachable, notes };
}

/** Every circulation road as one shape, for area take-offs. */
export function circulationFootprint(roads: CirculationRoad[]): MultiPoly {
  if (roads.length === 0) return [];
  return union(...roads.map((r) => r.geom));
}
