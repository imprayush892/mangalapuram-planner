import type { ReactNode } from 'react';

export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line">
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {right}
      </header>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

export function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5" title={hint}>
      <span className="text-muted">{label}</span>
      <span className="num text-right text-fg">{value}</span>
    </div>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-accent"
      />
      <span className="text-fg">{label}</span>
    </label>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary';
  className?: string;
}) {
  const base =
    tone === 'primary'
      ? 'border-accent/60 bg-accent/15 text-accent hover:bg-accent/25'
      : 'border-line bg-panel-2 text-fg hover:bg-line';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-40 ${base} ${className}`}
    >
      {children}
    </button>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      {label && <span className="text-muted">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-1.5 py-1 text-fg outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5" title={hint}>
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(n);
          }}
          className="num w-20 rounded border border-line bg-panel-2 px-1.5 py-1 text-right text-fg outline-none focus:border-accent"
        />
        {suffix && <span className="w-6 text-[11px] text-muted">{suffix}</span>}
      </span>
    </label>
  );
}

export function StatusDot({ status }: { status: 'pass' | 'fail' | 'warn' | 'info' }) {
  const colour =
    status === 'pass' ? 'bg-good' : status === 'fail' ? 'bg-bad' : status === 'warn' ? 'bg-warn' : 'bg-muted';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${colour}`} />;
}
