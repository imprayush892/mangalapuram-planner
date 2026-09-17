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
  assumptions: YamlDoc;
}

export async function loadConfig(src: AssetSource): Promise<ConfigBundle> {
  const [kmbr, client, programme, assumptions] = await Promise.all([
    src.text('config/kmbr_rules.yaml'),
    src.text('config/client_rules.yaml'),
    src.text('config/programme.yaml'),
    src.text('config/assumptions.yaml'),
  ]);
  return {
    kmbr: parseYaml(kmbr) as YamlDoc,
    client: parseYaml(client) as YamlDoc,
    programme: parseYaml(programme) as YamlDoc,
    assumptions: parseYaml(assumptions) as YamlDoc,
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
