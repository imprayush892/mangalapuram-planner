import type { ReactNode } from 'react';
import { useUi } from '../../state/uiStore';

/**
 * A control that shows its own limits.
 *
 * Pushing past a legal value is allowed — the user is exploring, and being
 * blocked teaches nothing. The control turns red instead and says which rule it
 * has crossed, so the tool is a guardrail rather than a fence.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  /** Value beyond which the setting breaks a rule; the track marks it. */
  legalMax,
  legalMin,
  breached,
  message,
  reference,
  constraintId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
  legalMax?: number;
  legalMin?: number;
  breached?: boolean;
  message?: string;
  reference?: string;
  constraintId?: string;
}): React.ReactElement {
  const setHovered = useUi((s) => s.setHoveredConstraint);
  const pct = (v: number): number => ((v - min) / Math.max(1e-9, max - min)) * 100;

  return (
    <div
      className="py-1.5"
      onPointerEnter={() => constraintId && setHovered(constraintId)}
      onPointerLeave={() => constraintId && setHovered(null)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">{label}</span>
        <span className={`num text-[11px] ${breached ? 'text-bad' : 'text-fg'}`}>
          {value}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </div>
      <div className="relative mt-1">
        {/* The legal band, drawn on the track itself. */}
        {(legalMax !== undefined || legalMin !== undefined) && (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded">
            <div
              className="absolute h-full bg-good/25"
              style={{
                left: `${Math.max(0, pct(legalMin ?? min))}%`,
                width: `${Math.max(0, pct(legalMax ?? max) - pct(legalMin ?? min))}%`,
              }}
            />
          </div>
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`relative w-full cursor-pointer ${breached ? 'accent-bad' : 'accent-accent'}`}
        />
      </div>
      {message && (
        <p className={`mt-0.5 text-[10px] leading-snug ${breached ? 'text-bad' : 'text-muted'}`}>
          {message}
          {reference && <span className="text-muted"> · {reference}</span>}
        </p>
      )}
    </div>
  );
}

/** A row of mutually exclusive choices, with the same breach treatment. */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
  breached,
  message,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; illegal?: boolean }[];
  onChange: (v: T) => void;
  breached?: boolean;
  message?: ReactNode;
}): React.ReactElement {
  return (
    <div className="py-1.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded border px-2 py-1 text-[11px] transition ${
              o.value === value
                ? o.illegal
                  ? 'border-bad/70 bg-bad/15 text-bad'
                  : 'border-accent/60 bg-accent/15 text-accent'
                : 'border-line bg-panel-2 text-muted hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {message && (
        <p className={`mt-0.5 text-[10px] leading-snug ${breached ? 'text-bad' : 'text-muted'}`}>{message}</p>
      )}
    </div>
  );
}
