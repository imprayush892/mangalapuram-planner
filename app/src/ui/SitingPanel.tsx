import { useMemo, useState } from 'react';
import { useSite } from '../state/store';
import { useSiting } from '../state/sitingStore';
import { useSettings } from '../state/settingsStore';
import { useRules } from '../state/useRules';
import { Button, NumberField, Panel, Row, StatusDot } from './primitives';
import { loadProgramme } from '../engine/rules/programme';
import { runSiting } from '../engine/siting/allocate';
import { measureZones } from '../engine/siting/metrics';
import { loadWeights } from '../engine/siting/score';
import type { ScoreWeights } from '../engine/siting/score';
import { USE_LABEL } from '../engine/site/level1';
import type { ZoneUse } from '../engine/site/level1';
import type { ConstraintResult, ZoneAllocation } from '../engine/siting/types';
import { zoneColour } from './draw';
import { useEditedSite } from '../state/useEditedSite';
import { useGoal } from '../state/goalStore';

const WEIGHT_LABELS: Record<keyof ScoreWeights, string> = {
  buildable_area: 'Buildable area',
  earthwork: 'Earthwork',
  access_frontage: 'Access and frontage',
  adjacency: 'Adjacency',
  view_elevation: 'View and position',
  drainage_risk: 'Drainage',
  phase_order: 'Phase order',
  water_fit: 'Water fit',
};

export default function SitingPanel(): React.ReactElement {
  const site = useEditedSite();
  const goal = useGoal((s) => s.goal);
  const selectZone = useSite((s) => s.selectZone);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const rules = useRules();
  const { overrides, setOverride } = useSettings();
  const { result, activeIndex, running, error, elapsedMs, locks, setResult, setActive, setRunning, setError, toggleLock, clearLocks } =
    useSiting();

  const [expanded, setExpanded] = useState<string | null>(null);

  const weights = useMemo(() => (rules ? loadWeights(rules.siting) : null), [rules]);

  if (!site || !rules || !weights) return <div className="p-3 text-muted">Loading…</div>;

  const run = (): void => {
    setRunning(true);
    // Measuring every zone takes about a second; yield first so the button
    // paints its running state.
    setTimeout(() => {
      try {
        const started = Date.now();
        const programme = loadProgramme(rules.programme, rules.client, rules.kmbr, rules.assumptions);
        const metrics = measureZones(site, rules.kmbr, rules.siting);
        const out = runSiting({
          site,
          kmbr: rules.kmbr,
          siting: rules.siting,
          programme,
          metrics,
          locks,
          // The same goal the layouts are optimised against, so what goes
          // where and how it is laid out answer one question, not two.
          goal,
        });
        setResult(out, Date.now() - started);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 30);
  };

  const active = result?.alternatives[activeIndex] ?? null;

  return (
    <>
      <Panel
        title="Siting engine"
        right={
          <Button tone="primary" onClick={run} disabled={running}>
            {running ? 'Running…' : result ? 'Re-run' : 'Place the uses'}
          </Button>
        }
      >
        <p className="text-[11px] leading-snug text-muted">
          Hard constraints veto a zone for a use, then the survivors are scored 0–100 and the land is shared out.
          The client zoning plan is a starting point: this decides what should go where, and says why.
        </p>
        {result && (
          <p className="pt-1.5 text-[11px] text-muted">
            {result.alternatives.length} alternatives in {(elapsedMs / 1000).toFixed(1)} s across{' '}
            {result.metrics.length} zones.
          </p>
        )}
        {error && <p className="pt-1.5 text-[11px] text-bad">{error}</p>}
        {Object.keys(locks).length > 0 && (
          <div className="mt-2 flex items-center justify-between rounded border border-line px-2 py-1">
            <span className="text-[11px] text-warn">
              {Object.keys(locks).length} zone{Object.keys(locks).length === 1 ? '' : 's'} pinned
            </span>
            <Button onClick={clearLocks}>Clear</Button>
          </div>
        )}
      </Panel>

      <Panel title="Scoring weights">
        {(Object.keys(WEIGHT_LABELS) as (keyof ScoreWeights)[]).map((key) => (
          <NumberField
            key={key}
            label={WEIGHT_LABELS[key]}
            value={weights[key]}
            step={5}
            min={0}
            onChange={(v) => setOverride('siting', `scoring_weights.${key}`, v)}
            hint="relative weight; re-run the engine to apply"
          />
        ))}
        <p className="pt-1.5 text-[11px] leading-snug text-muted">
          Weights are relative and normalised when scoring. Edits live in this scenario, not in
          config/siting_rules.yaml.
          {Object.keys(overrides.siting).length > 0 && ' Re-run to apply your changes.'}
        </p>
      </Panel>

      {result && (
        <Panel title="Alternatives">
          <div className="flex flex-col gap-1">
            {result.alternatives.map((alt, i) => (
              <button
                key={alt.id}
                type="button"
                onClick={() => setActive(i)}
                className={`rounded border px-2 py-1.5 text-left transition ${
                  i === activeIndex ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-2'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-fg">{alt.label}</span>
                  <span className="num text-muted">score {alt.totalScore.toFixed(0)}</span>
                </div>
                <div className="text-[11px] leading-snug text-muted">{alt.strategy}</div>
                <div className="num mt-0.5 flex gap-3 text-[11px] text-muted">
                  <span>{alt.allocations.length} zones placed</span>
                  <span className={alt.totalShortfallAc > 0 ? 'text-warn' : 'text-good'}>
                    {alt.totalShortfallAc.toFixed(1)} ac short
                  </span>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {active && (
        <>
          <Panel title="Land by use">
            {active.byUse
              .filter((u) => u.demandAc > 0 || u.allocatedAc > 0)
              .map((u) => (
                <Row
                  key={u.use}
                  label={USE_LABEL[u.use]}
                  value={
                    <span className={u.shortfallAc > 0.5 ? 'text-warn' : 'text-fg'}>
                      {u.allocatedAc.toFixed(1)} / {u.demandAc.toFixed(1)} ac
                    </span>
                  }
                  hint={u.demandAc === 0 ? 'reserved; its land waits for the deferred parcel' : undefined}
                />
              ))}
          </Panel>

          {active.notes.length > 0 && (
            <Panel title="What this alternative cannot do">
              {active.notes.map((n) => (
                <p key={n} className="pb-1.5 text-[11px] leading-snug text-warn">
                  {n}
                </p>
              ))}
            </Panel>
          )}

          <Panel title="Zone by zone">
            <div className="flex flex-col gap-1">
              {active.allocations.map((alloc) => (
                <AllocationCard
                  key={alloc.zoneId}
                  alloc={alloc}
                  expanded={expanded === alloc.zoneId}
                  selected={selectedZoneId === alloc.zoneId}
                  onToggle={() => setExpanded(expanded === alloc.zoneId ? null : alloc.zoneId)}
                  onSelect={() => selectZone(alloc.zoneId)}
                  onLock={() => toggleLock(alloc.zoneId, alloc.use)}
                  pinned={locks[alloc.zoneId] === alloc.use}
                />
              ))}
            </div>
            {active.unallocated.length > 0 && (
              <div className="mt-2">
                <div className="text-[11px] uppercase tracking-wider text-muted">Not allocated</div>
                {active.unallocated.map((u) => (
                  <p key={u.zoneId} className="pt-1 text-[11px] leading-snug text-bad">
                    {u.zoneName} ({u.areaAc.toFixed(2)} ac): {u.reason}
                  </p>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}

      {result && result.unevaluable.length > 0 && (
        <Panel title="Constraints not tested">
          <p className="pb-1.5 text-[11px] leading-snug text-muted">
            These are in the rules but cannot be settled from the data held. They are listed rather than passed, so
            a green row is never read as "checked and fine".
          </p>
          {result.unevaluable.map((u) => (
            <div key={`${u.use}-${u.note}`} className="flex items-start gap-2 py-1">
              <span className="mt-1.5">
                <StatusDot status="info" />
              </span>
              <div className="min-w-0">
                <div className="text-[11px] text-fg">{USE_LABEL[u.use]}</div>
                <div className="text-[11px] leading-snug text-muted">{u.note}</div>
              </div>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

function AllocationCard({
  alloc,
  expanded,
  selected,
  onToggle,
  onSelect,
  onLock,
  pinned,
}: {
  alloc: ZoneAllocation;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onLock: () => void;
  pinned: boolean;
}): React.ReactElement {
  const failed = alloc.constraints.filter((c) => c.status === 'fail');
  return (
    <div className={`rounded border px-2 py-1.5 ${selected ? 'border-accent' : 'border-line'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-2 text-left">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: zoneColour(alloc.zoneName) }} />
          <span className="truncate text-fg">{alloc.zoneName}</span>
        </button>
        <span className="num shrink-0 text-muted">
          {Number.isFinite(alloc.score) ? alloc.score.toFixed(0) : '—'}
        </span>
      </div>
      <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span className="text-fg">{USE_LABEL[alloc.use]}</span>
        <span>{alloc.areaAc.toFixed(2)} ac</span>
        {alloc.locked && <span className="text-warn">reserved</span>}
        {(alloc.surplusAc ?? 0) > 0.5 && (
          <span className="text-warn" title="zones are allocated whole; this is land the use did not need">
            {alloc.surplusAc!.toFixed(1)} ac surplus
          </span>
        )}
        {failed.length > 0 && <span className="text-bad">{failed.length} vetoed elsewhere</span>}
      </div>
      {alloc.runnerUp && (
        <div className="text-[11px] leading-snug text-muted">
          Instead of {USE_LABEL[alloc.runnerUp.use].toLowerCase()}
          {alloc.runnerUp.score > alloc.score
            ? `, which scored higher (${alloc.runnerUp.score.toFixed(0)}) but needed less land or fitted the zone worse`
            : ` (${alloc.runnerUp.score.toFixed(0)})`}
          .
        </div>
      )}
      <div className="mt-1 flex gap-2">
        <Button onClick={onToggle}>{expanded ? 'Hide why' : 'Why here'}</Button>
        <Button onClick={onLock}>{pinned ? 'Unpin' : 'Pin this use'}</Button>
      </div>
      {expanded && (
        <div className="mt-2 flex flex-col gap-1.5">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Score</div>
            {alloc.factors.map((f) => (
              <div key={f.key} className="py-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted">
                    {f.label} <span className="text-[10px]">×{f.weight}</span>
                  </span>
                  <span className="num text-fg">{f.value.toFixed(0)}</span>
                </div>
                <div className="text-[11px] leading-snug text-muted">{f.detail}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Constraints</div>
            {alloc.constraints.map((c) => (
              <ConstraintRow key={c.id} constraint={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConstraintRow({ constraint }: { constraint: ConstraintResult }): React.ReactElement {
  const status = constraint.status === 'unevaluable' ? 'info' : constraint.status === 'fail' ? 'fail' : 'pass';
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="mt-1.5">
        <StatusDot status={status} />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] text-fg">
          {constraint.requirement} <span className="text-muted">— {constraint.actual}</span>
        </div>
        {constraint.reason && <div className="text-[11px] leading-snug text-muted">{constraint.reason}</div>}
        <div className="text-[10px] uppercase tracking-wider text-muted">{constraint.provenance}</div>
      </div>
    </div>
  );
}

export type { ZoneUse };
