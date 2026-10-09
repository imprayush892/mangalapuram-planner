import { parse as parseYaml } from 'yaml';
import type { AssetSource } from './source';

/**
 * Config files stay YAML-shaped and loosely typed on purpose: the UI edits them
 * and the engine reads named keys through small accessors, so a client edit
 * never needs a code change. Accessors live in engine/rules.
 */
export type YamlDoc = Record<string, unknown>;

export interface ConfigBundle {
  kmbr: YamlDoc;
  client: YamlDoc;
  programme: YamlDoc;
  /** The owner's draft financial model (config/programme_draft_model.yaml), read with options.basis: draft_model. */
  programmeDraft: YamlDoc;
  assumptions: YamlDoc;
  siting: YamlDoc;
  /** Owner overrides (config/planning_rules.yaml): win where they overlap client rules. */
  planning: YamlDoc;
  /**
   * The draft financial model run on each master plan (config/financials_draft_model.yaml, written by
   * tools/finance/run_model.py): the presentation's financial figures. Absent where the file is not shipped.
   */
  financials?: YamlDoc;
}

export async function loadConfig(src: AssetSource): Promise<ConfigBundle> {
  const [kmbr, client, programme, programmeDraft, assumptions, siting, planning] = await Promise.all([
    src.text('config/kmbr_rules.yaml'),
    src.text('config/client_rules.yaml'),
    src.text('config/programme.yaml'),
    src.text('config/programme_draft_model.yaml'),
    src.text('config/assumptions.yaml'),
    src.text('config/siting_rules.yaml'),
    src.text('config/planning_rules.yaml'),
  ]);
  const financials = await src.text('config/financials_draft_model.yaml').catch(() => '');
  return {
    kmbr: parseYaml(kmbr) as YamlDoc,
    client: parseYaml(client) as YamlDoc,
    programme: parseYaml(programme) as YamlDoc,
    programmeDraft: parseYaml(programmeDraft) as YamlDoc,
    assumptions: parseYaml(assumptions) as YamlDoc,
    siting: parseYaml(siting) as YamlDoc,
    planning: parseYaml(planning) as YamlDoc,
    ...(financials ? { financials: parseYaml(financials) as YamlDoc } : {}),
  };
}

export async function loadExpectedValues(src: AssetSource): Promise<YamlDoc> {
  return parseYaml(await src.text('tests/expected_values.yaml')) as YamlDoc;
}

/** Dotted-path read with a typed default; returns the default on any miss. */
export function pick<T>(doc: unknown, path: string, fallback: T): T {
  let cur: unknown = doc;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return fallback;
    cur = (cur as Record<string, unknown>)[key];
  }
  return (cur === undefined || cur === null ? fallback : cur) as T;
}

/** Like `pick`, but throws — for regulation values that must never be invented. */
export function require$<T>(doc: unknown, path: string, what: string): T {
  const sentinel = Symbol('missing');
  const value = pick<unknown>(doc, path, sentinel);
  if (value === sentinel) {
    throw new Error(
      `${what}: '${path}' is missing from config. Add it (with a clause reference and verified: status) rather than hard-coding a value.`,
    );
  }
  return value as T;
}
