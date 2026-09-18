import type { OverrideSet } from './data/overrides';
import type { LayoutOption } from './generators/types';
import type { ZoneUse } from './site/level1';

export const SCENARIO_FORMAT = 'mangalapuram-planner/scenario';
export const SCENARIO_VERSION = 2;

/**
 * A scenario is a complete snapshot of what produced a set of layouts: the rule
 * and assumption edits, the design switches, the use assigned to each zone, and
 * the generated options themselves. Loading one reproduces the drawing without
 * regenerating, and the snapshot says exactly which inputs it came from.
 */
export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  version: number;
  name: string;
  savedAt: string;
  notes: string;
  /** Versions of the config files the scenario was built against. */
  configVersions: {
    kmbr: string;
    client: string;
    programme: string;
  };
  overrides: OverrideSet;
  switches: Record<string, unknown>;
  /** Use assigned to each zone, where the user changed it from the default. */
  zoneUses: Record<string, ZoneUse>;
  /** Generated options per zone, and which one was chosen. */
  layouts: Record<string, { options: LayoutOption[]; chosen: number }>;
}

export function buildScenario(input: {
  name: string;
  notes?: string;
  configVersions: Scenario['configVersions'];
  overrides: OverrideSet;
  switches: Record<string, unknown>;
  zoneUses: Record<string, ZoneUse>;
  layouts: Record<string, { options: LayoutOption[]; chosen: number }>;
}): Scenario {
  return {
    format: SCENARIO_FORMAT,
    version: SCENARIO_VERSION,
    name: input.name,
    savedAt: new Date().toISOString(),
    notes: input.notes ?? '',
    configVersions: input.configVersions,
    overrides: input.overrides,
    switches: input.switches,
    zoneUses: input.zoneUses,
    layouts: input.layouts,
  };
}

export interface ScenarioLoadResult {
  scenario: Scenario;
  warnings: string[];
}

/**
 * Parses a scenario file. Config versions that differ from the ones now on disk
 * are reported rather than silently accepted: a rule change since the scenario
 * was saved may make its layouts non-compliant.
 */
export function parseScenario(text: string, currentVersions: Scenario['configVersions']): ScenarioLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a scenario file: the JSON could not be parsed.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Not a scenario file.');
  const s = parsed as Partial<Scenario>;
  if (s.format !== SCENARIO_FORMAT) {
    throw new Error(`Not a Mangalapuram planner scenario (format '${String(s.format)}').`);
  }

  const warnings: string[] = [];
  if (typeof s.version === 'number' && s.version !== SCENARIO_VERSION) {
    warnings.push(
      `Saved by version ${s.version} of the scenario format; this build writes version ${SCENARIO_VERSION}. Anything it does not recognise is left at the default.`,
    );
  }
  for (const key of ['kmbr', 'client', 'programme'] as const) {
    const saved = s.configVersions?.[key];
    const now = currentVersions[key];
    if (saved && now && String(saved) !== String(now)) {
      warnings.push(
        `${key}_rules.yaml has changed since this scenario was saved (${saved} → ${now}). Regenerate before relying on its compliance.`,
      );
    }
  }

  const scenario: Scenario = {
    format: SCENARIO_FORMAT,
    version: s.version ?? SCENARIO_VERSION,
    name: s.name ?? 'Untitled scenario',
    savedAt: s.savedAt ?? new Date().toISOString(),
    notes: s.notes ?? '',
    configVersions: {
      kmbr: String(s.configVersions?.kmbr ?? ''),
      client: String(s.configVersions?.client ?? ''),
      programme: String(s.configVersions?.programme ?? ''),
    },
    overrides: s.overrides ?? { kmbr: {}, client: {}, programme: {}, assumptions: {}, siting: {} },
    switches: s.switches ?? {},
    zoneUses: s.zoneUses ?? {},
    layouts: s.layouts ?? {},
  };
  return { scenario, warnings };
}

export const scenarioFileName = (name: string): string =>
  `${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'scenario'}-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
