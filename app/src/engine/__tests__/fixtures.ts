import { nodeSource, repoSource } from '../data/nodeSource';
import { loadSite } from '../site/loadSite';
import type { SiteModel } from '../site/loadSite';
import { loadConfig, loadExpectedValues } from '../data/config';
import type { ConfigBundle, YamlDoc } from '../data/config';

/**
 * Loading the DEM, TIN and config takes a second; every suite shares one copy.
 */
let sitePromise: Promise<SiteModel> | null = null;
let configPromise: Promise<ConfigBundle> | null = null;
let expectedPromise: Promise<YamlDoc> | null = null;

export const site = (): Promise<SiteModel> =>
  (sitePromise ??= loadSite(nodeSource(), { withTin: true }));

export const config = (): Promise<ConfigBundle> => (configPromise ??= loadConfig(nodeSource()));

export const expected = (): Promise<YamlDoc> => (expectedPromise ??= loadExpectedValues(nodeSource()));

export const repo = repoSource;

/** Golden entries are either a bare number or {value, tol_pct | tol_m | tol}. */
export interface Golden {
  value: number;
  tol_pct?: number;
  tol_m?: number;
  tol?: number;
}

export function tolerance(g: Golden): number {
  if (g.tol_pct !== undefined) return Math.abs(g.value) * (g.tol_pct / 100);
  if (g.tol_m !== undefined) return g.tol_m;
  if (g.tol !== undefined) return g.tol;
  return Math.abs(g.value) * 1e-6;
}
