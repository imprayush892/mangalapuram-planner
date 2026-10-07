import { describe, expect, it } from 'vitest';
import { bufferPolyline, roadFromEdge } from '../geom/offset';
import { multiPolyArea } from '../geom/planar';

describe('strips along a line', () => {
  const line: [number, number][] = [[0, 0], [100, 0]];

  it('bufferPolyline gives the total width asked for (a 10 m road is 10 m wide)', () => {
    expect(multiPolyArea(bufferPolyline(line, 10))).toBeCloseTo(1000, 0);
    expect(multiPolyArea(bufferPolyline([[0, 0], [60, 0], [60, 40]], 6))).toBeCloseTo(6 * 100, -1);
  });

  it('roadFromEdge buffers a surveyed road edge by a quarter of the road width either side', () => {
    // Two edges 6 m apart (the survey's median) make a corridor of about the road width + 1 m.
    const a = roadFromEdge([[0, 0], [100, 0]], 10);
    const b = roadFromEdge([[0, 6], [100, 6]], 10);
    expect(multiPolyArea(a)).toBeCloseTo(500, 0);
    const ys = [...a, ...b].flatMap((poly) => poly[0]!.map((p) => p[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(11, 1);
  });
});
