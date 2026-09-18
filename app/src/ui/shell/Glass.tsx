import type { ReactNode } from 'react';

/**
 * A floating panel over the viewport rather than a column beside it, so the
 * model keeps the whole screen and the panels sit on top of it. Every one of
 * them collapses to a slim bar.
 */
export function GlassPanel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`rounded-lg border border-line/80 bg-panel/85 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-md ${className}`}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  hint,
  right,
  onClick,
  open,
}: {
  title: string;
  hint?: string;
  right?: ReactNode;
  onClick?: () => void;
  open?: boolean;
}): React.ReactElement {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left ${
        onClick ? 'transition hover:bg-panel-2/60' : ''
      }`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          {onClick && (
            <span
              className={`text-muted transition-transform ${open ? 'rotate-90' : ''}`}
              aria-hidden
            >
              ›
            </span>
          )}
          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-fg">{title}</span>
        </span>
        {hint && <span className="mt-0.5 block truncate pl-4 text-[10px] text-muted">{hint}</span>}
      </span>
      {right}
    </Tag>
  );
}

/** A slim vertical tab that reopens a collapsed panel. */
export function EdgeTab({
  label,
  onClick,
  side,
}: {
  label: string;
  onClick: () => void;
  side: 'left' | 'right';
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg border border-line/80 bg-panel/85 px-2 py-3 text-[10px] uppercase tracking-wider text-muted shadow-lg backdrop-blur-md transition hover:text-fg`}
      style={{ writingMode: 'vertical-rl', transform: side === 'left' ? 'rotate(180deg)' : undefined }}
    >
      {label}
    </button>
  );
}
