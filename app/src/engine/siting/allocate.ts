import type { YamlDoc } from '../data/config';
import { pick } from '../data/config';
import type { SiteModel } from '../site/loadSite';
import type { ZoneUse } from '../site/level1';
import { USE_LABEL, inferUse } from '../site/level1';
import type { ProgrammeSummary, UseKind } from '../rules/programme';
import { checkConstraints, isEligible, unevaluableNotes } from './constraints';
import { loadWeights, scoreCandidate } from './score';
import type { ScoreContext, ScoreWeights } from './score';
import { measureZones } from './metrics';
import type {
  SitingAlternative,
  SitingCandidate,
  SitingResult,
  UseAllocation,
  ZoneAllocation,
  ZoneMetrics,
} from './types';

/**
 * PRD §5.2-5.3 and module M5: decide which use goes on which zone.
 *
 * Constraints veto first, then eligible pairs are scored, then zones are taken
 * in order of how much the choice matters — the zone whose best and second-best
 * uses differ most is allocated first, because that is where a wrong call costs
 * most. Alternatives come from re-running with the weights tilted, which is
 * honest about *why* they differ: each one says which factor it favoured.
 */

/** Existing roads are retained and widened to 10 m (client decision, 15 Sep 2026). */
const RETAINED_ROAD_WIDTH_M = 10;

/** How much a use with no land at all outranks one that already has some. */
const STARVED_BOOST = 1.6;

/** Programme uses that need land allocated. Infrastructure has no programme line yet. */
const SITED_USES: ZoneUse[] = [
  'villas',
  'senior',
  'apartments',
  'school',
  'club',
  'commercial',
  'hotel',
  'office',
  'hospital_reserved',
  'infrastructure',
];

const USE_LINES: Partial<Record<ZoneUse, UseKind[]>> = {
  villas: ['villas'],
  senior: ['senior'],
  apartments: ['apartments'],
  school: ['school'],
  club: ['club'],
  commercial: ['commercial', 'convention'],
  hotel: ['hotel'],
  office: ['office'],
  hospital_reserved: ['hospital'],
};

export interface AllocateInput {
  site: SiteModel;
  kmbr: YamlDoc;
  siting: YamlDoc;
  programme: ProgrammeSummary;
  /** Zones the client has fixed; these keep their use whatever the score says. */
  locks?: Record<string, ZoneUse>;
  weights?: ScoreWeights;
  /** How many alternatives to return. The PRD asks for 3 to 5. */
  keep?: number;
  /** Supplied by the caller to avoid re-measuring; measured here when absent. */
  metrics?: ZoneMetrics[];
}

export function runSiting(input: AllocateInput): SitingResult {
  const metrics = input.metrics ?? measureZones(input.site, input.kmbr, input.siting);
  const weights = input.weights ?? loadWeights(input.siting);
  const locks = input.locks ?? pickLocks(input.siting);
  const demand = landDemand(input.programme);

  // Constraints do not depend on what else has been placed, so they are
  // evaluated once per pair and reused by every alternative.
  const constraintsByPair = new Map<string, SitingCandidate>();
  for (const m of metrics) {
    for (const use of SITED_USES) {
      const constraints = checkConstraints(input.siting, use, m, RETAINED_ROAD_WIDTH_M);
      constraintsByPair.set(pairKey(m.zoneId, use), {
        zoneId: m.zoneId,
        zoneName: m.zoneName,
        use,
        eligible: isEligible(constraints),
        constraints,
        score: Number.NaN,
        factors: [],
        unevaluable: unevaluableNotes(constraints),
      });
    }
  }

  const tilts: { id: string; label: string; strategy: string; weights: ScoreWeights }[] = [
    { id: 'balanced', label: 'Balanced', strategy: 'the weights as configured', weights },
    {
      id: 'buildability',
      label: 'Least earthwork',
      strategy: 'earthwork and buildable area weighted double',
      weights: { ...weights, earthwork: weights.earthwork * 2, buildable_area: weights.buildable_area * 2 },
    },
    {
      id: 'access',
      label: 'Access led',
      strategy: 'access, frontage and adjacency weighted double',
      weights: { ...weights, access_frontage: weights.access_frontage * 2, adjacency: weights.adjacency * 2 },
    },
    {
      id: 'phasing',
      label: 'Phase led',
      strategy: 'the zoning plan phase order weighted five times',
      weights: { ...weights, phase_order: weights.phase_order * 5 },
    },
  ];

  const alternatives = tilts
    .map((tilt) => allocateOnce(input, metrics, constraintsByPair, tilt, demand, locks))
    .filter((a): a is SitingAlternative => a !== null);

  // The balanced run is the reference; the rest are ranked behind it.
  const [balanced, ...rest] = alternatives;
  rest.sort((a, b) => b.totalScore - a.totalScore);
  const ordered = balanced ? [balanced, ...rest] : rest;

  const candidates = [...constraintsByPair.values()];
  return {
    metrics,
    candidates,
    alternatives: ordered.slice(0, input.keep ?? 4),
    unevaluable: dedupeUnevaluable(candidates),
  };
}

function allocateOnce(
  input: AllocateInput,
  metrics: ZoneMetrics[],
  constraintsByPair: Map<string, SitingCandidate>,
  tilt: { id: string; label: string; strategy: string; weights: ScoreWeights },
  demand: Map<ZoneUse, number>,
  locks: Record<string, ZoneUse>,
): SitingAlternative | null {
  const remaining = new Map(demand);
  const placed = new Map<ZoneUse, { centroid: [number, number]; areaAc: number }[]>();
  const deferred = deferredUses(input.programme);
  const allocations: ZoneAllocation[] = [];
  const unallocated: SitingAlternative['unallocated'] = [];
  const pending = new Map(metrics.map((m) => [m.zoneId, m]));

  const ctx: ScoreContext = {
    centroidsByUse: placed,
    phaseForUse: () => null,
  };

  // Locked zones are placed first: they are the fixed points everything else
  // is judged against, and their adjacency should influence the rest.
  for (const [zoneId, use] of Object.entries(locks)) {
    const m = pending.get(zoneId);
    if (!m) continue;
    pending.delete(zoneId);
    const candidate = constraintsByPair.get(pairKey(zoneId, use));
    allocations.push({
      zoneId,
      zoneName: m.zoneName,
      use,
      areaAc: m.areaAc,
      score: Number.NaN,
      priority: Number.NaN,
      locked: true,
      runnerUp: null,
      factors: [],
      constraints: candidate?.constraints ?? [],
      unevaluable: candidate?.unevaluable ?? [],
    });
    record(placed, use, m);
    remaining.set(use, (remaining.get(use) ?? 0) - m.areaAc);
  }

  // A deferred use never competes for land that has to be built on now: it is
  // pinned to the zone the client zoning plan already reserves for it, and
  // takes no demand into the allocation below.
  for (const [use] of deferred) {
    const reserved = [...pending.values()].find((m) => inferUse(m.zoneName) === use);
    if (!reserved) continue;
    pending.delete(reserved.zoneId);
    const candidate = constraintsByPair.get(pairKey(reserved.zoneId, use));
    allocations.push({
      zoneId: reserved.zoneId,
      zoneName: reserved.zoneName,
      use,
      areaAc: reserved.areaAc,
      score: Number.NaN,
      priority: Number.NaN,
      locked: true,
      runnerUp: null,
      factors: [],
      constraints: candidate?.constraints ?? [],
      unevaluable: candidate?.unevaluable ?? [],
    });
    record(placed, use, reserved);
  }

  while (pending.size > 0) {
    // Priority is the siting score tempered by two things the score alone
    // cannot see: how badly a use still needs land, and whether this zone is
    // anywhere near the right size for it. Without the first, a use that is
    // merely tolerant everywhere takes the whole site and the rest get
    // nothing; without the second, a 1.5 ac use wins an 8.5 ac zone.
    let best: {
      m: ZoneMetrics;
      use: ZoneUse;
      score: number;
      priority: number;
      factors: ZoneAllocation['factors'];
      runnerUp: { use: ZoneUse; score: number; priority: number } | null;
    } | null = null;

    const anyDemandLeft = [...remaining.values()].some((ac) => ac > 0.05);

    for (const m of pending.values()) {
      const ranked: {
        use: ZoneUse;
        score: number;
        priority: number;
        factors: ZoneAllocation['factors'];
      }[] = [];

      for (const use of SITED_USES) {
        const candidate = constraintsByPair.get(pairKey(m.zoneId, use));
        if (!candidate?.eligible) continue;
        const demandAc = demand.get(use) ?? 0;
        const remainingAc = remaining.get(use) ?? 0;
        // Once every demand is met the leftover land goes to whoever suits it
        // best, so the need and fit factors drop out.
        if (anyDemandLeft && remainingAc <= 0.05) continue;

        const { score, factors } = scoreCandidate(input.siting, tilt.weights, use, m, ctx);
        const need = demandAc > 0 ? Math.min(1, remainingAc / demandAc) : 0.2;
        const fit = remainingAc > 0 ? Math.min(1, remainingAc / m.areaAc) : 1;
        // Serving every use at all beats serving one of them perfectly, so a
        // use still holding no land at all is pushed up the queue. Without
        // this the small uses — the 1.5 ac business hub, the 3 ac hotel —
        // lose every round to a use that suits the zone slightly better.
        const starved = (placed.get(use)?.length ?? 0) === 0 ? STARVED_BOOST : 1;
        const priority = anyDemandLeft
          ? score * (0.35 + 0.65 * need) * (0.4 + 0.6 * fit) * starved
          : score * 0.5;
        ranked.push({ use, score, priority, factors });
      }

      if (ranked.length === 0) continue;
      ranked.sort((a, b) => b.priority - a.priority);
      const top = ranked[0]!;
      const second = ranked[1] ?? null;
      if (!best || top.priority > best.priority) {
        best = {
          m,
          use: top.use,
          score: top.score,
          priority: top.priority,
          factors: top.factors,
          runnerUp: second
            ? { use: second.use, score: second.score, priority: second.priority }
            : null,
        };
      }
    }

    if (!best) {
      // Nothing eligible is left; everything still pending is unallocatable.
      for (const m of pending.values()) {
        unallocated.push({
          zoneId: m.zoneId,
          zoneName: m.zoneName,
          areaAc: m.areaAc,
          reason: unallocatableReason(m, constraintsByPair),
        });
      }
      break;
    }

    pending.delete(best.m.zoneId);
    const candidate = constraintsByPair.get(pairKey(best.m.zoneId, best.use))!;
    const remainingAc = remaining.get(best.use) ?? 0;
    const surplusAc = Math.max(0, best.m.areaAc - Math.max(0, remainingAc));
    allocations.push({
      zoneId: best.m.zoneId,
      zoneName: best.m.zoneName,
      use: best.use,
      areaAc: best.m.areaAc,
      score: best.score,
      priority: best.priority,
      locked: false,
      runnerUp: best.runnerUp,
      factors: best.factors,
      constraints: candidate.constraints,
      unevaluable: candidate.unevaluable,
      surplusAc,
    });
    record(placed, best.use, best.m);
    remaining.set(best.use, remainingAc - best.m.areaAc);
  }

  const byUse = buildUseAllocations(demand, allocations);
  const scored = allocations.filter((a) => Number.isFinite(a.score));
  const totalScore =
    scored.length > 0
      ? scored.reduce((s, a) => s + a.score * a.areaAc, 0) / scored.reduce((s, a) => s + a.areaAc, 0)
      : 0;

  const sorted = allocations.sort((a, b) => b.areaAc - a.areaAc);
  return {
    id: tilt.id,
    label: tilt.label,
    strategy: tilt.strategy,
    allocations: sorted,
    byUse,
    totalScore,
    totalShortfallAc: byUse.reduce((s, u) => s + Math.max(0, u.shortfallAc), 0),
    unallocated,
    notes: structuralNotes(sorted, byUse),
  };
}

/**
 * Findings about the allocation itself rather than any one zone: a use left
 * with nothing, and zones carrying far more land than their use needs. Both
 * come from the same thing — the client zoning plan's zone sizes do not match
 * the programme's land demands, and zones are allocated whole.
 */
function structuralNotes(allocations: ZoneAllocation[], byUse: UseAllocation[]): string[] {
  const notes: string[] = [];

  const starved = byUse.filter((u) => u.demandAc > 0 && u.allocatedAc <= 0);
  if (starved.length > 0) {
    notes.push(
      `No zone could be given to ${starved
        .map((u) => `${USE_LABEL[u.use].toLowerCase()} (${u.demandAc.toFixed(1)} ac)`)
        .join(', ')}. Every zone suited another use better under this weighting. Splitting a zone would let it in.`,
    );
  }

  const oversized = allocations.filter((a) => {
    const demand = byUse.find((u) => u.use === a.use)?.demandAc ?? 0;
    return !a.locked && demand > 0 && a.areaAc > demand * 1.5;
  });
  if (oversized.length > 0) {
    notes.push(
      `${oversized
        .map((a) => {
          const demand = byUse.find((u) => u.use === a.use)?.demandAc ?? 0;
          return `${a.zoneName} is ${a.areaAc.toFixed(1)} ac for a ${demand.toFixed(1)} ac use`;
        })
        .join('; ')}. Zones are allocated whole, so the balance is surplus until the zone can be split.`,
    );
  }

  return notes;
}

function record(
  placed: Map<ZoneUse, { centroid: [number, number]; areaAc: number }[]>,
  use: ZoneUse,
  m: ZoneMetrics,
): void {
  const list = placed.get(use) ?? [];
  list.push({ centroid: [m.centroid[0], m.centroid[1]], areaAc: m.areaAc });
  placed.set(use, list);
}

function buildUseAllocations(demand: Map<ZoneUse, number>, allocations: ZoneAllocation[]): UseAllocation[] {
  const uses = new Set<ZoneUse>([...demand.keys(), ...allocations.map((a) => a.use)]);
  return [...uses]
    .map((use) => {
      const mine = allocations.filter((a) => a.use === use);
      const allocatedAc = mine.reduce((s, a) => s + a.areaAc, 0);
      const demandAc = demand.get(use) ?? 0;
      return {
        use,
        demandAc,
        allocatedAc,
        zoneIds: mine.map((a) => a.zoneId),
        shortfallAc: demandAc - allocatedAc,
      };
    })
    .sort((a, b) => b.demandAc - a.demandAc);
}

/**
 * Land each use asks for from the land IN SCOPE. A deferred line asks for
 * nothing here — the hospital waits for the 26.4 ac balance land — so it never
 * competes with a use that has to be built now.
 */
function landDemand(programme: ProgrammeSummary): Map<ZoneUse, number> {
  const out = new Map<ZoneUse, number>();
  for (const [use, kinds] of Object.entries(USE_LINES) as [ZoneUse, UseKind[]][]) {
    const lines = programme.lines.filter((l) => kinds.includes(l.use));
    if (lines.length === 0 || lines.every((l) => l.deferred)) continue;
    const ac = lines.filter((l) => !l.deferred).reduce((s, l) => s + l.landAc, 0);
    if (ac > 0) out.set(use, ac);
  }
  return out;
}

/** Uses whose every programme line is deferred; reserved, never allocated. */
function deferredUses(programme: ProgrammeSummary): Map<ZoneUse, number> {
  const out = new Map<ZoneUse, number>();
  for (const [use, kinds] of Object.entries(USE_LINES) as [ZoneUse, UseKind[]][]) {
    const lines = programme.lines.filter((l) => kinds.includes(l.use));
    if (lines.length > 0 && lines.every((l) => l.deferred)) {
      out.set(use, lines.reduce((s, l) => s + l.landAc, 0));
    }
  }
  return out;
}

function pickLocks(siting: YamlDoc): Record<string, ZoneUse> {
  const raw = pick<Record<string, unknown>>(siting, 'locks', {});
  const out: Record<string, ZoneUse> = {};
  for (const [zoneId, use] of Object.entries(raw)) {
    if (zoneId === 'provenance') continue;
    if (typeof use === 'string') out[zoneId] = use as ZoneUse;
  }
  return out;
}

function unallocatableReason(m: ZoneMetrics, pairs: Map<string, SitingCandidate>): string {
  const failures = new Map<string, number>();
  for (const use of SITED_USES) {
    const candidate = pairs.get(pairKey(m.zoneId, use));
    for (const c of candidate?.constraints ?? []) {
      if (c.status === 'fail') failures.set(c.requirement, (failures.get(c.requirement) ?? 0) + 1);
    }
  }
  if (failures.size === 0) return 'No use had land left to place here.';
  const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return `Every use is vetoed here; the commonest reason is "${worst[0]}".`;
}

function dedupeUnevaluable(candidates: SitingCandidate[]): { use: ZoneUse; note: string }[] {
  const seen = new Set<string>();
  const out: { use: ZoneUse; note: string }[] = [];
  for (const c of candidates) {
    for (const note of c.unevaluable) {
      const key = `${c.use}::${note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ use: c.use, note });
    }
  }
  return out;
}

const pairKey = (zoneId: string, use: ZoneUse): string => `${zoneId}::${use}`;

export { SITED_USES, USE_LABEL };
