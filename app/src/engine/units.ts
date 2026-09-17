/**
 * Unit conversions. The engine stores metres and square metres everywhere;
 * these helpers exist only for display and for reading client figures that
 * arrive in imperial or Kerala land units.
 */

export const SFT_PER_M2 = 10.7639;
export const M2_PER_ACRE = 4046.8564;
export const M2_PER_CENT = 40.4686;

export const m2ToSft = (m2: number): number => m2 * SFT_PER_M2;
export const sftToM2 = (sft: number): number => sft / SFT_PER_M2;
export const m2ToAcres = (m2: number): number => m2 / M2_PER_ACRE;
export const acresToM2 = (ac: number): number => ac * M2_PER_ACRE;
export const m2ToCents = (m2: number): number => m2 / M2_PER_CENT;
export const centsToM2 = (cents: number): number => cents * M2_PER_CENT;

export const DEG = Math.PI / 180;
export const toDeg = (rad: number): number => rad / DEG;
export const toRad = (deg: number): number => deg * DEG;

/** Round to `dp` decimals; keeps report tables from showing float noise. */
export function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
