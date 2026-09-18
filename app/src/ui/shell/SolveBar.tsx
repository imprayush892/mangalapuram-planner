import { useMasterPlan } from '../../state/masterPlanStore';
import { useGoal, goalDrifted } from '../../state/goalStore';

/**
 * Whether what is drawn is still the answer to what is set.
 *
 * The work is heavy and that is fine; what is not fine is not knowing whether
 * the drawing in front of you is current. This says so, names what changed,
 * and is the only place a solve is started.
 */
export function SolveBar({
  stale,
  reasons,
  onSolve,
}: {
  stale: boolean;
  reasons: string[];
  onSolve: () => void;
}): React.ReactElement {
  const status = useMasterPlan((s) => s.status);
  const plan = useMasterPlan((s) => s.plan);
  const streaming = useMasterPlan((s) => s.streaming);
  const goal = useGoal((s) => s.goal);
  const planGoal = useGoal((s) => s.planGoal);
  const drifted = goalDrifted(goal, planGoal);

  if (status.running) {
    const pct = status.total > 0 ? (status.done / status.total) * 100 : 0;
    return (
      <div className="flex items-center gap-3 px-3 py-1.5">
        <span className="flex h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] text-fg">{status.message}</span>
          <span className="mt-1 block h-1 overflow-hidden rounded bg-line">
            <span className="block h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </span>
        </span>
        <span className="num shrink-0 text-[11px] text-muted">
          {streaming.length}
          {status.total > 0 ? ` / ${status.total}` : ''} zones drawn
        </span>
      </div>
    );
  }

  const isStale = stale || drifted;
  const allReasons = drifted ? ['the optimisation goal', ...reasons] : reasons;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${isStale ? 'bg-warn' : plan ? 'bg-good' : 'bg-line'}`}
      />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
        {!plan
          ? 'Nothing drawn yet. The figures on the right are the rules applied to these settings.'
          : isStale
            ? `Drawn plan is behind: ${allReasons.slice(0, 3).join(', ')}${allReasons.length > 3 ? ` and ${allReasons.length - 3} more` : ''} changed since.`
            : `Current. ${plan.zones.length} zones in ${(plan.elapsedMs / 1000).toFixed(1)} s.`}
      </span>
      <button
        type="button"
        onClick={onSolve}
        className={`shrink-0 rounded border px-2.5 py-1 text-[11px] transition ${
          isStale || !plan
            ? 'border-accent/60 bg-accent/15 text-accent hover:bg-accent/25'
            : 'border-line text-muted hover:text-fg'
        }`}
      >
        {plan ? (isStale ? 'Re-solve' : 'Solve again') : 'Solve the plan'}
      </button>
    </div>
  );
}
