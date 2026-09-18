import { useMemo } from 'react';
import { useGoal } from '../state/goalStore';
import { normaliseGoal, settingsFor, goalExplanation } from '../engine/optimise/goal';
import { useRules } from '../state/useRules';
import { pick } from '../engine/data/config';

const OBJECTIVES = [
  {
    key: 'space' as const,
    label: 'Space',
    hint: 'Fit the programme into the land: more plots, more floor area, zones filled harder.',
    // Tailwind generates classes from literals it can see, so these are whole
    // class names rather than a colour token interpolated at runtime.
    dot: 'bg-accent',
    accent: 'accent-accent',
  },
  {
    key: 'terrain' as const,
    label: 'Terrain',
    hint: 'Work with the ground: flatter plots, flatter streets, least cut and fill.',
    dot: 'bg-warn',
    accent: 'accent-warn',
  },
  {
    key: 'water' as const,
    label: 'Water',
    hint: 'Organise around water: wider watercourse buffers, uses placed by how they suit the hydrology.',
    dot: 'bg-good',
    accent: 'accent-good',
  },
];

/**
 * The super goal: one objective made of three, weighted by the user.
 *
 * These are not modes. All three are pursued at once and the weights say how
 * much each counts, so the engine is never switched — only re-aimed.
 */
export default function GoalPanel(): React.ReactElement {
  const { goal, set, preset } = useGoal();
  const rules = useRules();
  const normal = useMemo(() => normaliseGoal(goal), [goal]);

  const settings = useMemo(
    () =>
      settingsFor(normal, {
        routeGradePenaltyM: rules ? pick<number>(rules.assumptions, 'route_grade_penalty_m', 12) : 12,
        waterBufferM: rules ? pick<number>(rules.siting, 'defaults.water_buffer_m', 15) : 15,
      }),
    [normal, rules],
  );
  const explanation = useMemo(() => goalExplanation(normal, settings), [normal, settings]);

  return (
    <div className="px-3 pb-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-fg">{normal.label}</span>
        <span className="num text-[10px] text-muted">
          {Math.round(normal.space * 100)} / {Math.round(normal.terrain * 100)} / {Math.round(normal.water * 100)}
        </span>
      </div>

      <div className="mt-1 flex gap-1">
        {(['balanced', 'space', 'terrain', 'water'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => preset(p)}
            title={`Weight ${p === 'balanced' ? 'all three equally' : `${p} three times the others`}`}
            className="flex-1 rounded border border-line bg-panel-2 px-1 py-0.5 text-[10px] capitalize text-muted transition hover:text-fg"
          >
            {p}
          </button>
        ))}
      </div>

      {/* One bar showing how the goal is split, so the balance reads at a glance. */}
      <div className="mt-2 flex h-1.5 overflow-hidden rounded">
        <div className="bg-accent" style={{ width: `${normal.space * 100}%` }} />
        <div className="bg-warn" style={{ width: `${normal.terrain * 100}%` }} />
        <div className="bg-good" style={{ width: `${normal.water * 100}%` }} />
      </div>

      {OBJECTIVES.map((o) => (
        <div key={o.key} className="mt-2" title={o.hint}>
          <div className="flex items-baseline justify-between">
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className={`inline-block h-2 w-2 rounded-sm ${o.dot}`} />
              {o.label}
            </span>
            <span className="num text-[11px] text-fg">{Math.round(normal[o.key] * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={5}
            step={0.5}
            value={goal[o.key]}
            onChange={(e) => set({ [o.key]: Number(e.target.value) } as never)}
            className={`w-full cursor-pointer ${o.accent}`}
          />
          <p className="text-[10px] leading-snug text-muted">{o.hint}</p>
        </div>
      ))}

      <div className="mt-2 rounded border border-line/70 bg-panel-2/50 px-2 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-muted">What this asks the engine to do</div>
        {explanation.map((line, i) => (
          <p key={i} className="mt-0.5 text-[10px] leading-snug text-muted">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}
