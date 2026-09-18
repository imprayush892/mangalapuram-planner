import type { YamlDoc } from './config';

/**
 * UI edits to config are stored as dotted-path overrides rather than as mutated
 * copies of the YAML, so a scenario can record exactly what the user changed and
 * the original file stays the source of truth.
 */
export type Overrides = Record<string, unknown>;

export interface OverrideSet {
  kmbr: Overrides;
  client: Overrides;
  programme: Overrides;
  assumptions: Overrides;
  siting: Overrides;
}

export const EMPTY_OVERRIDES: OverrideSet = {
  kmbr: {},
  client: {},
  programme: {},
  assumptions: {},
  siting: {},
};

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next = cur[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[key] = {};
    else cur[key] = { ...(next as Record<string, unknown>) };
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Shallow-clones down each overridden path; untouched branches are shared. */
export function applyOverrides(doc: YamlDoc, overrides: Overrides): YamlDoc {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return doc;
  const out: Record<string, unknown> = { ...doc };
  for (const path of keys) setPath(out, path, overrides[path]);
  return out;
}

export const countOverrides = (set: OverrideSet): number =>
  Object.values(set).reduce((n, o) => n + Object.keys(o).length, 0);
