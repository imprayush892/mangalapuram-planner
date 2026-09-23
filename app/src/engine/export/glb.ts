import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Dem } from '../terrain/dem';
import type { LayoutOption } from '../generators/types';
import type { MultiPoly, Ring } from '../geom/types';
import { ringSignedArea } from '../geom/planar';
import { confidenceAt } from '../terrain/fill';
import type { FilledDem } from '../terrain/fill';
import type { WaterModel } from '../terrain/water';
import type { SiteFeature } from '../site/types';
import { channelThresholdCells, waterModelFor } from '../terrain/hydrology';

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
   * Draw the water: ponds, channels and flow lines for a storm, on the same
   * rules as the panel and the 2D raster. Off when absent.
   */
  water?: WaterOptions;
}

export interface WaterOptions {
  features: SiteFeature[];
  /** The storm being looked at against the report's design storm; 1 is the design storm. */
  stormScale: number;
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

  const terrain = buildTerrainMesh(opts.dem, opts.terrainStep ?? 2, opts.filled, opts.water);
  if (terrain) {
    terrain.name = 'Terrain';
    scene.add(terrain);
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
export function buildTerrainMesh(dem: Dem, step = 2, filled?: FilledDem, water?: WaterOptions): THREE.Object3D | null {
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
  
  const waterModel: WaterModel | null = water ? waterModelFor(dem, water.features) : null;
  const channelCells = water ? channelThresholdCells(water.stormScale) : Infinity;

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

      let rCol = surveyed.r, gCol = surveyed.g, bCol = surveyed.b;
      if (filled) {
        const conf = confidenceAt(filled.distanceToMeasuredM[k] ?? 0);
        const tint = surveyed.clone().lerp(inferred, 1 - conf);
        rCol = tint.r; gCol = tint.g; bCol = tint.b;
      }
      
      if (waterModel) {
        // The same rules as the 2D raster and the panel: a pond is a hollow
        // at least the ponding depth deep, and a channel carries the storm's
        // threshold of upslope cells. Wet ground in between is the wetness
        // index the scoring already uses.
        const depthM = waterModel.depressionDepthM[k] ?? 0;
        const upslope = waterModel.flowAccumulation[k] ?? 0;
        const wet = waterModel.wetness[k] ?? Number.NaN;
        if (waterModel.ponding[k] === 1) {
          const t = Math.min(1, depthM / 1.0);
          rCol = 0.08;
          gCol = 0.40 + 0.20 * (1 - t);
          bCol = 0.65 + 0.35 * t;
        } else if (upslope >= channelCells) {
          const t = Math.min(1, Math.log(upslope / channelCells + 1) / Math.log(50));
          rCol = 0.08 + 0.10 * (1 - t);
          gCol = 0.45 + 0.25 * t;
          bCol = 0.70 + 0.25 * t;
        } else if (Number.isFinite(wet) && waterModel.maxWetness > 0 && wet > waterModel.maxWetness * 0.7) {
          const t = (wet - waterModel.maxWetness * 0.7) / (waterModel.maxWetness * 0.3);
          rCol = rCol * (1 - t * 0.25);
          gCol = gCol * (1 - t * 0.1) + t * 0.1;
          bCol = Math.min(1, bCol + t * 0.2);
        }
      }

      if (filled || waterModel) {
        colours.push(rCol, gCol, bCol);
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
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: colours.length > 0 ? 0xffffff : COLOURS.terrain,
      vertexColors: colours.length > 0,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
  );
  
  if (waterModel && water) {
    const group = new THREE.Group();
    group.name = 'Terrain and water';
    group.add(mesh);
    const flowLines = buildFlowLines(waterModel, dem, channelThresholdCells(water.stormScale));
    if (flowLines) group.add(flowLines);
    return group;
  }
  return mesh;
}

function buildFlowLines(waterModel: WaterModel, dem: Dem, channelCells: number): THREE.LineSegments | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const { flowAccumulation, receiver, filledLevel } = waterModel;

  // One segment per channel cell to its receiver, drawn on the filled surface
  // so a line crosses a pond at its water level rather than diving into it.
  const positions: number[] = [];
  const colors: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const upslope = flowAccumulation[k] ?? 0;
      const r = receiver[k] ?? -1;
      if (upslope < channelCells || r < 0) continue;
      const z1 = filledLevel[k]!;
      const z2 = filledLevel[r]!;
      if (!Number.isFinite(z1) || !Number.isFinite(z2)) continue;
      const ri = r % nx;
      const rj = (r - ri) / nx;
      positions.push(x0 + cell_m * (i + 0.5), z1 + 0.35, -(y0 + cell_m * (j + 0.5)));
      positions.push(x0 + cell_m * (ri + 0.5), z2 + 0.35, -(y0 + cell_m * (rj + 0.5)));
      const t = Math.min(1, Math.log(upslope / channelCells + 1) / Math.log(80));
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
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 }));
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
