import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import type { RawCellContent } from 'hyperformula';
import { useModel } from '../state/modelStore';
import type { SheetView } from '../engine/finance/modelCore';
import { PRESENT_PLAN_OPTIONS } from '../engine/present/prebuilt';

/**
 * The Model tab (owner 12 Oct): the owner's draft financial model, every sheet, live. Any cell can be changed (a value,
 * or a formula starting with =); the workbook recalculates, every option is run again, and the presentation's financial
 * figures follow. "Show with" puts an option's plan into the Inputs sheet (its cells tinted) to see the model as that
 * option runs it. Edits stay in this browser; Download writes the workbook with them.
 */

const ROW_H = 22;
const COL_PX = (wch: number | undefined): number => Math.max(48, Math.min(420, Math.round((wch ?? 10) * 7.2 + 10)));

function parseEntry(s: string): RawCellContent {
  const t = s.trim();
  if (t === '') return '';
  if (t.startsWith('=')) return t;
  const pct = /^(-?[\d,]*\.?\d+)\s*%$/.exec(t);
  if (pct) return Number(pct[1]!.replace(/,/g, '')) / 100;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) && /^-?[\d,]*\.?\d+(e-?\d+)?$/i.test(t.replace(/,/g, '')) ? n : t;
}

export default function ModelView(): React.ReactElement | null {
  const open = useModel((s) => s.open);
  const setOpen = useModel((s) => s.setOpen);
  const status = useModel((s) => s.status);
  const error = useModel((s) => s.error);
  const sheets = useModel((s) => s.sheets);
  const edits = useModel((s) => s.edits);
  const running = useModel((s) => s.running);
  const cases = useModel((s) => s.cases);
  const load = useModel((s) => s.load);
  const edit = useModel((s) => s.edit);
  const resetEdits = useModel((s) => s.resetEdits);
  const view = useModel((s) => s.view);
  const download = useModel((s) => s.download);

  const [sheet, setSheet] = useState('Inputs');
  const [option, setOption] = useState<string>('');
  const [data, setData] = useState<SheetView | null>(null);
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [draft, setDraft] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const gridRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const refresh = useCallback(async () => {
    if (status !== 'ready') return;
    setData(await view(sheet, option || null));
  }, [status, view, sheet, option]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, edits, cases]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && draft === null) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, draft, setOpen]);

  const meta = sheets.find((s) => s.name === sheet);
  const widths = useMemo(() => (meta ? Array.from({ length: meta.cols }, (_, c) => COL_PX(meta.widths[c])) : []), [meta]);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = 0;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);
  const totalW = widths.reduce((a, b) => a + b, 0);
  const overlay = useMemo(() => new Set(option && sheet === 'Inputs' ? Object.keys((cases[option]?.inputs as object) ?? {}) : []), [option, sheet, cases]);

  if (!open) return null;
  const key = (r: number, c: number): string => `${sheet}!${XLSX.utils.encode_cell({ r, c })}`;
  const selKey = key(sel.r, sel.c);
  const selInput = data?.input[sel.r]?.[sel.c] ?? '';
  const commit = async (text: string): Promise<void> => {
    setDraft(null);
    const orig = edits[selKey];
    if (text === (orig !== undefined ? String(orig) : selInput)) return;
    await edit(selKey, parseEntry(text));
  };
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 5);
  const last = Math.min(meta?.rows ?? 0, Math.ceil((scroll.top + scroll.height) / ROW_H) + 5);
  const nEdits = Object.keys(edits).length;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-ink text-fg">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
        <span className="text-[12px] font-semibold">Draft financial model</span>
        <span className="text-[10px] text-muted">
          {status === 'loading' && 'opening the workbook…'}
          {status === 'error' && <span className="text-bad">{error}</span>}
          {status === 'ready' && (running ? 'recalculating every option…' : 'live: change a cell and every option recalculates')}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px]">
          <label className="text-muted">
            Show with{' '}
            <select value={option} onChange={(e) => setOption(e.target.value)} className="rounded border border-line bg-panel px-1 py-0.5 text-fg">
              <option value="">the model as given</option>
              {PRESENT_PLAN_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id} · {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void resetEdits()} disabled={nEdits === 0} className="rounded border border-line px-2 py-0.5 text-muted hover:text-fg disabled:opacity-40">
            Undo all edits ({nEdits})
          </button>
          <button type="button" onClick={() => void download()} disabled={status !== 'ready'} className="rounded border border-line px-2 py-0.5 text-muted hover:text-fg disabled:opacity-40">
            Download .xlsx
          </button>
          <button type="button" onClick={() => setOpen(false)} className="rounded border border-accent/70 px-2 py-0.5 text-accent hover:bg-accent/10">
            Back to the plan
          </button>
        </span>
      </div>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1">
        <span className="num w-16 text-[11px] text-muted">{XLSX.utils.encode_cell(sel)}</span>
        <input
          ref={barRef}
          value={draft ?? (edits[selKey] !== undefined ? String(edits[selKey]) : selInput)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') {
              setDraft(null);
              gridRef.current?.focus();
            }
          }}
          className="num flex-1 rounded border border-line bg-panel px-2 py-0.5 text-[12px] text-fg"
          placeholder="a value, or a formula starting with ="
        />
        {edits[selKey] !== undefined && (
          <button type="button" onClick={() => void edit(selKey, null)} className="text-[11px] text-muted hover:text-fg">
            put back the workbook's
          </button>
        )}
      </div>
      <div
        ref={gridRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        onScroll={(e) => setScroll({ top: (e.target as HTMLDivElement).scrollTop, height: (e.target as HTMLDivElement).clientHeight })}
        onKeyDown={(e) => {
          if (!meta || draft !== null) return;
          const mv = (dr: number, dc: number): void => {
            e.preventDefault();
            setSel((s) => ({ r: Math.max(0, Math.min(meta.rows - 1, s.r + dr)), c: Math.max(0, Math.min(meta.cols - 1, s.c + dc)) }));
          };
          if (e.key === 'ArrowDown') mv(1, 0);
          else if (e.key === 'ArrowUp') mv(-1, 0);
          else if (e.key === 'ArrowLeft') mv(0, -1);
          else if (e.key === 'ArrowRight' || e.key === 'Tab') mv(0, 1);
          else if (e.key === 'Enter' || e.key === 'F2') {
            e.preventDefault();
            barRef.current?.focus();
          } else if (e.key === 'Delete' && edits[selKey] !== undefined) void edit(selKey, null);
          else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            setDraft(e.key);
            barRef.current?.focus();
            e.preventDefault();
          }
        }}
      >
        {meta && data && (
          <div style={{ height: (meta.rows + 1) * ROW_H, width: totalW + 48, position: 'relative' }}>
            <div className="sticky top-0 z-10 flex bg-panel" style={{ height: ROW_H, width: totalW + 48 }}>
              <div className="w-12 shrink-0 border-b border-r border-line" />
              {widths.map((w, c) => (
                <div key={c} style={{ width: w }} className="shrink-0 border-b border-r border-line text-center text-[10px] leading-[22px] text-muted">
                  {XLSX.utils.encode_col(c)}
                </div>
              ))}
            </div>
            {Array.from({ length: last - first }, (_, q) => first + q).map((r) => (
              <div key={r} className="absolute left-0 flex" style={{ top: (r + 1) * ROW_H, height: ROW_H, width: totalW + 48 }}>
                <div className="num sticky left-0 z-[5] w-12 shrink-0 border-b border-r border-line bg-panel text-center text-[10px] leading-[22px] text-muted">{r + 1}</div>
                {widths.map((w, c) => {
                  const k = key(r, c);
                  const t = data.text[r]?.[c] ?? '';
                  const isSel = sel.r === r && sel.c === c;
                  const isEdit = edits[k] !== undefined;
                  const isPlan = overlay.has(XLSX.utils.encode_cell({ r, c }));
                  const numLike = /^[-(₹\d]/.test(t) && !/[a-z]{3}/i.test(t.replace(/Cr|L|%|sft/g, ''));
                  return (
                    <div
                      key={c}
                      title={data.input[r]?.[c] ?? ''}
                      onClick={() => {
                        setSel({ r, c });
                        setDraft(null);
                        gridRef.current?.focus();
                      }}
                      onDoubleClick={() => barRef.current?.focus()}
                      style={{ width: w, left: lefts[c]! + 48 }}
                      className={`absolute h-full overflow-hidden whitespace-nowrap border-b border-r border-line/50 px-1 text-[11px] leading-[22px] ${numLike ? 'num text-right' : ''} ${
                        isSel ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
                      } ${isEdit ? 'bg-amber-400/20 text-fg' : isPlan ? 'bg-accent/15 text-fg' : (data.input[r]?.[c] ?? '').startsWith('=') ? 'text-fg/85' : 'text-fg'}`}
                    >
                      {t}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-t border-line px-2 py-1">
        {sheets.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => {
              setSheet(s.name);
              setSel({ r: 0, c: 0 });
              gridRef.current?.scrollTo(0, 0);
            }}
            className={`whitespace-nowrap rounded px-2 py-0.5 text-[11px] ${sheet === s.name ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'}`}
          >
            {s.name}
          </button>
        ))}
        <span className="ml-auto self-center text-[10px] text-muted">
          <span className="mr-2 inline-block h-2 w-2 bg-amber-400/40" /> your edit <span className="mx-2 inline-block h-2 w-2 bg-accent/30" /> set by the plan
        </span>
      </div>
    </div>
  );
}
