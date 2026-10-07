import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Dem } from '../terrain/dem';
import type { LayoutOption } from '../generators/types';
import type { MultiPoly, Ring } from '../geom/types';
import { ringSignedArea } from '../geom/planar';
import { confidenceAt } from '../terrain/fill';
import type { FilledDem } from '../terrain/fill';
import type { WaterModel } from '../terrain/water';
import type { StormResult } from '../terrain/hydrology';
import type { Tin } from '../terrain/tin';
import type { PlanResult, Typology } from '../pipeline/plan';

/**
 * GLB massing: the terrain mesh plus extruded plots, towers and blocks, in
 * local metres with Z up mapped to three.js Y. Rhino, Blender and the Windows
 * viewer all open it; the scene is grouped so the massing can be hidden.
 */

export interface GlbOptions {
  dem: Dem;
  layouts: LayoutOption[];
  parcel: MultiPoly;
  /** Clip the terrain to this bounding box, in local metres. Defaults to the parcel. */
  terrainStep?: number;
  villaHeightM?: number;
  /** Levels with the survey's holes closed, so the mesh is continuous. */
  filled?: FilledDem;
  /**
   * The terrain mesh as delivered. When given, the terrain is drawn from its
   * own triangles rather than resampled from the 2 m grid, so what is on
   * screen is the mesh itself.
   */
  tin?: Tin;
  /**
   * Draw a storm's water: standing water at its own level and the channels
   * carrying flow, from the same simulation the panel and the 2D raster use.
   * Off when absent.
   */
  water?: WaterOptions;
  overlay?: TerrainOverlay;
  /** Steps 8-16: villas, senior buildings, towers on podiums, school and clubhouse. */
  plan?: PlanResult;
  /** The villas as masses with the plan's buildings; on unless set false. */
  planVillas?: boolean;
}

const PLAN_COLOURS: Record<Exclude<Typology, 'open' | 'golf' | 'reserved' | 'future'>, number> = {
  villas: 0xf4e3b0,
  senior: 0xd9c2ec,
  apartments: 0xf0c4c0,
  school: 0xc4dcf4,
  clubhouse: 0xc8ecc8,
  commercial: 0xf2c9e0,
  retail: 0xf2c9e0,
  office: 0xe2c4dc,
  hospital: 0xb9d6e0,
  batching: 0xc9b9a6,
  park: 0x9fd69a,
};

/**
 * Planning layers laid on the terrain: an image in plan (north up, covering
 * x0..x0+widthM, y0..y0+heightM) draped over the terrain mesh, and zone
 * outlines traced along the ground. Tinted ground and lines, never solids, so
 * they read apart from the building masses.
 */
export interface TerrainOverlay {
  image: TexImageSource;
  x0: number;
  y0: number;
  widthM: number;
  heightM: number;
  outlines: { rings: Ring[]; colour: number }[];
}

export interface WaterOptions {
  model: WaterModel;
  storm: StormResult;
}

const COLOURS = {
  terrain: 0x6f7f74,
  /** Ground whose level was interpolated, not measured. */
  inferredTerrain: 0x8a97a8,
  plot: 0x6fd3c7,
  villa: 0xdfe7ea,
  tower: 0xe0a3d6,
  block: 0xf0956b,
  road: 0xbac4ca,
};

export function buildMassingScene(opts: GlbOptions): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = 'Mangalapuram massing';

  const terrain = opts.tin
    ? buildTinMesh(opts.tin, opts.dem, opts.filled)
    : buildTerrainMesh(opts.dem, opts.terrainStep ?? 2, opts.filled);
  if (terrain) {
    terrain.name = 'Terrain';
    scene.add(terrain);
  }
  if (opts.overlay && terrain) {
    const group = new THREE.Group();
    group.name = 'Planning layers';
    group.add(buildDrape(terrain.geometry, opts.overlay));
    const lines = buildOutlines(opts.dem, opts.overlay, opts.filled);
    if (lines) group.add(lines);
    scene.add(group);
  }
  if (opts.plan) scene.add(buildPlanMasses(opts.plan, opts.planVillas ?? true));
  if (opts.water) {
    const water = new THREE.Group();
    water.name = 'Water';
    const surface = buildWaterSurface(opts.dem, opts.water.storm);
    if (surface) water.add(surface);
    const lines = buildFlowLines(opts.dem, opts.water.model, opts.water.storm);
    if (lines) water.add(lines);
    scene.add(water);
  }

  const massing = new THREE.Group();
  massing.name = 'Massing';
  const villaHeight = opts.villaHeightM ?? 7;

  for (const layout of opts.layouts) {
    const group = new THREE.Group();
    group.name = layout.zoneName;

    for (const plot of layout.plots) {
      if (!plot.footprint) continue;
      const base = Number.isFinite(plot.terrain.platformRl) ? plot.terrain.platformRl : 0;
      group.add(extrude(plot.footprint, base, villaHeight, COLOURS.villa, `${plot.id}-villa`));
    }
    for (const tower of layout.towers) {
      const base = Number.isFinite(tower.podiumRl) ? tower.podiumRl : 0;
      group.add(extrude(tower.ring, base, tower.heightM, COLOURS.tower, tower.id));
    }
    for (const block of layout.blocks) {
      const base = Number.isFinite(block.terrain.platformRl) ? block.terrain.platformRl : 0;
      group.add(extrude(block.ring, base, block.heightM, COLOURS.block, `${block.id}-${block.use}`));
    }
    massing.add(group);
  }
  scene.add(massing);
  return scene;
}

/** Terrain mesh from the DEM. NaN cells are left out rather than filled. */
/**
 * The terrain mesh.
 *
 * Given a filled surface the mesh is continuous, and every vertex is tinted by
 * where its level came from: surveyed ground keeps the terrain colour,
 * interpolated ground fades towards a paler, bluer grey the further it sits
 * from a real measurement. A continuous mesh that does not say which parts are
 * measured would be the whole point of the fill thrown away.
 */
export function buildTerrainMesh(dem: Dem, step = 2, filled?: FilledDem): THREE.Mesh | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const stride = Math.max(1, Math.round(step / cell_m));
  const cols = Math.floor((nx - 1) / stride) + 1;
  const rows = Math.floor((ny - 1) / stride) + 1;

  const positions: number[] = [];
  const colours: number[] = [];
  const indices: number[] = [];
  const index = new Int32Array(cols * rows).fill(-1);

  const surveyed = new THREE.Color(COLOURS.terrain);
  const inferred = new THREE.Color(COLOURS.inferredTerrain);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = c * stride;
      const j = r * stride;
      const k = j * nx + i;
      const z = filled ? filled.values[k]! : dem.at(i, j);
      if (!Number.isFinite(z)) continue;
      index[r * cols + c] = positions.length / 3;
      // three.js is Y-up: local x -> x, RL -> y, local y -> -z.
      positions.push(x0 + cell_m * (i + 0.5), z, -(y0 + cell_m * (j + 0.5)));

      if (filled) {
        const conf = confidenceAt(filled.distanceToMeasuredM[k] ?? 0);
        const tint = surveyed.clone().lerp(inferred, 1 - conf);
        colours.push(tint.r, tint.g, tint.b);
      }
    }
  }
  if (positions.length === 0) return null;

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = index[r * cols + c]!;
      const b = index[r * cols + c + 1]!;
      const d = index[(r + 1) * cols + c]!;
      const e = index[(r + 1) * cols + c + 1]!;
      // A quad is only emitted where all four corners are surveyed.
      if (a < 0 || b < 0 || d < 0 || e < 0) continue;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colours.length > 0) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: colours.length > 0 ? 0xffffff : COLOURS.terrain,
      vertexColors: colours.length > 0,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
}

/**
 * The masses of the plan. Each villa is its ground floor (60% of the plot) with
 * the smaller first floor (40%) on it, on the plot's platform level; towers
 * stand on podiums that fill down to the low side of their ground.
 */
function buildPlanMasses(plan: PlanResult, withVillas = true): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Masterplan';
  const villas = new THREE.Group();
  villas.name = 'Villas';
  for (const p of withVillas ? plan.plots : []) {
    if (!Number.isFinite(p.baseRl)) continue;
    villas.add(extrude(p.groundFloor, p.baseRl, p.floorHeightM, PLAN_COLOURS.villas, `${p.id} ground floor`));
    if (p.upperFloorM2 > 0.5) villas.add(extrude(p.upperFloor, p.baseRl + p.floorHeightM, p.floorHeightM, PLAN_COLOURS.villas, `${p.id} first floor`));
    if (p.roofRoom) villas.add(extrude(p.roofRoom, p.baseRl + 2 * p.floorHeightM, p.floorHeightM, PLAN_COLOURS.villas, `${p.id} roof room`));
  }
  group.add(villas);
  const others = new THREE.Group();
  others.name = 'Buildings';
  for (const b of plan.buildings) {
    if (!Number.isFinite(b.baseRl)) continue;
    const colour = PLAN_COLOURS[b.typology];
    if (b.podium) {
      const h = Math.max(0.3, b.podium.heightM);
      others.add(extrude(b.podium.ring, b.podium.topRl - h, h, 0x9a9aa2, `${b.id} podium`));
      others.add(extrude(b.ring, b.podium.topRl, b.heightM, colour, `${b.id} tower`));
    } else {
      others.add(extrude(b.ring, b.baseRl, b.heightM, colour, b.id));
    }
  }
  group.add(others);
  return group;
}

/** The overlay image on a copy of the terrain surface, a hair above it. */
function buildDrape(terrain: THREE.BufferGeometry, o: TerrainOverlay): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const pos = terrain.getAttribute('position') as THREE.BufferAttribute;
  geometry.setAttribute('position', pos);
  if (terrain.index) geometry.setIndex(terrain.index);
  const uv = new Float32Array(pos.count * 2);
  for (let v = 0; v < pos.count; v++) {
    // three.js is Y-up: local x = x, local y = -z.
    uv[v * 2] = (pos.getX(v) - o.x0) / o.widthM;
    uv[v * 2 + 1] = (-pos.getZ(v) - o.y0) / o.heightM;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  const texture = new THREE.Texture(o.image);
  texture.needsUpdate = true;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  mesh.name = 'Planning layers on the ground';
  return mesh;
}

/** Zone outlines traced along the ground, every metre, half a metre up. */
function buildOutlines(dem: Dem, o: TerrainOverlay, filled?: FilledDem): THREE.LineSegments | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const level = (x: number, y: number): number => {
    const z = dem.sampleBilinear([x, y]);
    if (Number.isFinite(z)) return z;
    const c = dem.cellAt([x, y]);
    return c && filled ? filled.values[c.j * dem.meta.nx + c.i] ?? Number.NaN : Number.NaN;
  };
  for (const { rings, colour } of o.outlines) {
    const col = new THREE.Color(colour);
    for (const ring of rings) {
      for (let a = 0; a < ring.length; a++) {
        const p = ring[a]!;
        const q = ring[(a + 1) % ring.length]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1])));
        for (let s = 0; s < steps; s++) {
          const x1 = p[0] + ((q[0] - p[0]) * s) / steps;
          const y1 = p[1] + ((q[1] - p[1]) * s) / steps;
          const x2 = p[0] + ((q[0] - p[0]) * (s + 1)) / steps;
          const y2 = p[1] + ((q[1] - p[1]) * (s + 1)) / steps;
          const z1 = level(x1, y1);
          const z2 = level(x2, y2);
          if (!Number.isFinite(z1) || !Number.isFinite(z2)) continue;
          positions.push(x1, z1 + 0.5, -y1, x2, z2 + 0.5, -y2);
          colors.push(col.r, col.g, col.b, col.r, col.g, col.b);
        }
      }
    }
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
  lines.name = 'Zone outlines';
  return lines;
}

/**
 * The terrain mesh from its own triangles. Vertices are tinted like the grid
 * mesh: the terrain colour where a survey point stands behind the level,
 * paler the further the nearest reading is.
 */
export function buildTinMesh(tin: Tin, dem: Dem, filled?: FilledDem): THREE.Mesh | null {
  if (tin.faceCount === 0) return null;
  const positions = new Float32Array(tin.vertexCount * 3);
  const colours = new Float32Array(tin.vertexCount * 3);
  const surveyed = new THREE.Color(COLOURS.terrain);
  const inferred = new THREE.Color(COLOURS.inferredTerrain);
  for (let v = 0; v < tin.vertexCount; v++) {
    const [x, y, z] = tin.vertex(v);
    // three.js is Y-up: local x -> x, RL -> y, local y -> -z.
    positions[v * 3] = x;
    positions[v * 3 + 1] = z;
    positions[v * 3 + 2] = -y;
    let tint = surveyed;
    if (filled) {
      const c = dem.cellAt([x, y]);
      const d = c ? filled.distanceToMeasuredM[c.j * dem.meta.nx + c.i] ?? 0 : 0;
      tint = surveyed.clone().lerp(inferred, 1 - confidenceAt(d));
    }
    colours[v * 3] = tint.r;
    colours[v * 3 + 1] = tint.g;
    colours[v * 3 + 2] = tint.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(tin.faces), 1));
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
}

/**
 * Water at the storm's peak: one flat quad per wet cell at the level the water
 * stands or runs at, full-resolution, so a pond or a flooded swale reads as a
 * surface rather than a tint on the terrain.
 */
function buildWaterSurface(dem: Dem, storm: StormResult): THREE.Mesh | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const half = cell_m / 2;
  const positions: number[] = [];
  const colours: number[] = [];
  const shallow = new THREE.Color(0x78c8f0);
  const deep = new THREE.Color(0x185caa);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (storm.peakWet[k] !== 1) continue;
      const depth = storm.peakDepthM[k]!;
      const level = dem.values[k]! + depth;
      const x = x0 + cell_m * (i + 0.5);
      const zc = -(y0 + cell_m * (j + 0.5));
      const a: [number, number] = [x - half, zc - half];
      const b: [number, number] = [x + half, zc - half];
      const c: [number, number] = [x + half, zc + half];
      const d: [number, number] = [x - half, zc + half];
      for (const p of [a, d, b, b, d, c]) positions.push(p[0], level, p[1]);
      const tint = shallow.clone().lerp(deep, Math.min(1, depth / 1.5));
      for (let v = 0; v < 6; v++) colours.push(tint.r, tint.g, tint.b);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      roughness: 0.2,
      metalness: 0,
      side: THREE.DoubleSide,
      // Shallow water sits within centimetres of the ground: keep it on top.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.name = 'Water at the peak';
  return mesh;
}

/**
 * The channels carrying flow in the storm: a segment from each channel cell to
 * where its water goes next, brighter the more passes. Drawn on the flooded
 * surface so a line crossing a full pond runs across its water level.
 */
function buildFlowLines(dem: Dem, model: WaterModel, storm: StormResult): THREE.LineSegments | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const { receiver, filledLevel } = model;
  const positions: number[] = [];
  const colors: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const r = receiver[k] ?? -1;
      if (storm.channel[k] !== 1 || r < 0) continue;
      const z1 = filledLevel[k]!;
      const z2 = filledLevel[r]!;
      if (!Number.isFinite(z1) || !Number.isFinite(z2)) continue;
      const ri = r % nx;
      const rj = (r - ri) / nx;
      positions.push(x0 + cell_m * (i + 0.5), z1 + 0.35, -(y0 + cell_m * (j + 0.5)));
      positions.push(x0 + cell_m * (ri + 0.5), z2 + 0.35, -(y0 + cell_m * (rj + 0.5)));
      const t = Math.min(1, Math.log10(storm.flowM3[k]! / storm.channelFlowM3 + 1) / 3);
      const red = 0.05 + 0.15 * (1 - t);
      const green = 0.55 + 0.35 * t;
      const blue = 0.85 + 0.15 * t;
      colors.push(red, green, blue, red, green, blue);
    }
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }),
  );
  lines.name = 'Flow lines';
  return lines;
}

function extrude(ring: Ring, baseRl: number, heightM: number, colour: number, name: string): THREE.Mesh {
  const shape = new THREE.Shape();
  // The shape is drawn in the local x/y plane as-is. rotateX(-90°) then maps
  // (x, y, z) to (x, z, -y), which is exactly the y-up convention the terrain
  // mesh uses: local x -> x, extrusion height -> y, local y -> -z. Negating y
  // here instead would mirror the massing across the site.
  const winding = ringSignedArea(ring) >= 0 ? ring : [...ring].reverse();
  winding.forEach((p, i) => {
    if (i === 0) shape.moveTo(p[0], p[1]);
    else shape.lineTo(p[0], p[1]);
  });
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.1, heightM), bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, baseRl, 0);
  const mesh = new THREE.Mesh(
    geometry,
    // The rotation mirrors the shape's winding, so faces are drawn both ways
    // rather than turning inside out.
    new THREE.MeshStandardMaterial({
      color: colour,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = name;
  return mesh;
}

/** Serialises the scene to a .glb ArrayBuffer. */
export async function exportGlb(scene: THREE.Scene): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true });
  if (result instanceof ArrayBuffer) return result;
  // parseAsync returns JSON when binary is not honoured; encode it instead.
  return new TextEncoder().encode(JSON.stringify(result)).buffer as ArrayBuffer;
}
