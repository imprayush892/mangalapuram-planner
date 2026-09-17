import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Dem } from '../terrain/dem';
import type { LayoutOption } from '../generators/types';
import type { MultiPoly, Ring } from '../geom/types';
import { ringSignedArea } from '../geom/planar';

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
}

const COLOURS = {
  terrain: 0x6f7f74,
  plot: 0x6fd3c7,
  villa: 0xdfe7ea,
  tower: 0xe0a3d6,
  block: 0xf0956b,
  road: 0xbac4ca,
};

export function buildMassingScene(opts: GlbOptions): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = 'Mangalapuram massing';

  const terrain = buildTerrainMesh(opts.dem, opts.terrainStep ?? 2);
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
export function buildTerrainMesh(dem: Dem, step = 2): THREE.Mesh | null {
  const { nx, ny, x0, y0, cell_m } = dem.meta;
  const stride = Math.max(1, Math.round(step / cell_m));
  const cols = Math.floor((nx - 1) / stride) + 1;
  const rows = Math.floor((ny - 1) / stride) + 1;

  const positions: number[] = [];
  const indices: number[] = [];
  const index = new Int32Array(cols * rows).fill(-1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = c * stride;
      const j = r * stride;
      const z = dem.at(i, j);
      if (!Number.isFinite(z)) continue;
      index[r * cols + c] = positions.length / 3;
      // three.js is Y-up: local x -> x, RL -> y, local y -> -z.
      positions.push(x0 + cell_m * (i + 0.5), z, -(y0 + cell_m * (j + 0.5)));
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
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: COLOURS.terrain, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }),
  );
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
