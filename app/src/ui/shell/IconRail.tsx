import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * A rail of glyphs down the left edge, each naming itself on hover and saying
 * what it does to the drawing. Icons cost almost no space, which is the point:
 * the model keeps the screen.
 */
export interface RailItem {
  id: string;
  glyph: ReactNode;
  label: string;
  /** What this does to what is on screen — not what it is. */
  does: string;
}

export function IconRail({
  items,
  active,
  onPick,
  footer,
}: {
  items: readonly RailItem[];
  active: string | null;
  onPick: (id: string) => void;
  footer?: ReactNode;
}): React.ReactElement {
  const [hover, setHover] = useState<string | null>(null);
  const shown = items.find((i) => i.id === hover);

  return (
    <div className="pointer-events-auto relative flex flex-col items-center gap-1 rounded-lg border border-line/80 bg-panel/85 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-md">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onPick(item.id)}
          onPointerEnter={() => setHover(item.id)}
          onPointerLeave={() => setHover(null)}
          aria-label={item.label}
          className={`flex h-9 w-9 items-center justify-center rounded text-[15px] transition ${
            active === item.id
              ? 'bg-accent/20 text-accent'
              : 'text-muted hover:bg-panel-2 hover:text-fg'
          }`}
        >
          {item.glyph}
        </button>
      ))}
      {footer}

      {shown && (
        <div className="pointer-events-none absolute left-full top-0 z-30 ml-2 w-56 rounded-lg border border-line/80 bg-panel/95 px-2.5 py-2 shadow-xl backdrop-blur-md">
          <div className="text-[11px] font-semibold text-fg">{shown.label}</div>
          <div className="mt-0.5 text-[10px] leading-snug text-muted">{shown.does}</div>
        </div>
      )}
    </div>
  );
}
