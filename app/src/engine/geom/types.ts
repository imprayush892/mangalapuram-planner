/**
 * Planar geometry types. Every coordinate in the engine is LOCAL METRES
 * (x = UTM43N E - 706106.927, y = N - 953717.901). There is no geodesic maths
 * anywhere in the engine: at this site scale the local grid is planar.
 */

export type Pt = readonly [number, number];

/** Closed-by-convention ring: first point is NOT repeated at the end. */
export type Ring = Pt[];

/** [outer, ...holes] */
export type Poly = Ring[];

/** A set of polygons (the result of any boolean op). */
export type MultiPoly = Poly[];

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Segment {
  a: Pt;
  b: Pt;
}
