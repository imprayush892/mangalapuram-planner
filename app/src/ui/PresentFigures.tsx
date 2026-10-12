import { useEffect, useState } from 'react';
import { useLiveFinancials } from '../state/modelStore';
import { usePresent, PRESENT_STEPS, hasPhases } from '../state/presentStore';
import { useAnalysisForViews } from '../state/planningStore';
import { useSite } from '../state/store';
import { Heading, colourOf, n0, n1 } from './presentKit';
import { stepStats } from './PresentStats';
import { useRules } from '../state/useRules';
import { pick } from '../engine/data/config';
import { GlassPanel } from './shell/Glass';

/**
 * The presentation's closing figures (owner 7 Oct): the draft model's One-Page Summary, sections A (land by
 * product type), E (unit sizes and tickets) and B (funding and key assumptions), drawn over the master plan.
 * Owner 12 Oct: the figures are the model run on the option on screen (config/financials_draft_model.yaml
 * cases.<option>.summary, tools/finance/run_model.py: its land, villas and the office split put into the model),
 * not the model as given; each value carries its workbook cell.
 */

interface LandRow {
  use: string;
  acres: number;
  share: number;
  phases: number[];
  cell: string;
}
interface FundRow {
  label: string;
  value?: number;
  unit?: string;
  text?: string;
  cell: string;
}
interface TicketRow {
  comp: string;
  typology: string;
  units: number;
  size_sft: number;
  plot_or_carpet_sft: number | null;
  base_rate: number;
  base_ticket_lakh: number;
  realised_rate: number;
  ticket_lakh: number;
  revenue_cr: number;
  phases: string;
  share_of_res_revenue: number;
  row: number;
}

const short = (use: string): string => use.replace(/\s*\((.*)\)\s*$/, '');
const note = (use: string): string | null => use.match(/\((.*)\)\s*$/)?.[1] ?? null;

function Source({ cells }: { cells: string }): React.ReactElement {
  return <p className="mt-4 text-[10px] text-muted/80">Draft model.xlsx, run on this plan (tools/finance/run_model.py) · One-Page Summary · {cells}</p>;
}

function Land({ rows, total }: { rows: LandRow[]; total: number }): React.ReactElement {
  const shown = rows.filter((r) => r.acres > 0);
  return (
    <>
      <Heading kicker="A · Land allocation by product type" title={`${Number.isInteger(total) ? n0(total) : total.toFixed(2)} acres, by what is built on them`} />
      <div className="flex h-5 w-full overflow-hidden rounded-full ring-1 ring-line">
        {shown.map((r) => (
          <div key={r.use} title={`${short(r.use)} · ${r.acres} ac`} style={{ width: `${r.share * 100}%`, background: colourOf(r.use) }} />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
        {shown.map((r) => (
          <div key={r.use} className="flex items-start gap-2.5" title={`cell ${r.cell}`}>
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colourOf(r.use) }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[13px] text-fg">{short(r.use)}</span>
                <span className="num shrink-0 text-[17px] font-semibold tabular-nums text-fg">
                  {r.acres.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  <span className="ml-0.5 text-[10px] font-normal text-muted">ac</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-muted">{note(r.use) ?? ' '}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {r.phases.map((p) => (
                    <span key={p} className="rounded bg-line/70 px-1 text-[9px] leading-[14px] text-muted">
                      P{p}
                    </span>
                  ))}
                  <span className="w-9 text-right text-[11px] tabular-nums text-muted">{Math.round(r.share * 100)}%</span>
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Source cells="C8:F20" />
    </>
  );
}

function Tickets({ rows, avg, footnote }: { rows: TicketRow[]; avg: { units: number; size_sft: number; ticket_lakh: number; revenue_cr: number } | null; footnote: string | null }): React.ReactElement {
  const groups: { name: string; colour: string; rows: TicketRow[] }[] = [
    { name: 'Villas', colour: colourOf('villas'), rows: rows.filter((r) => r.comp === 'V') },
    { name: 'Apartments', colour: colourOf('apartments'), rows: rows.filter((r) => r.comp === 'A') },
    { name: 'Senior living', colour: colourOf('senior'), rows: rows.filter((r) => r.comp !== 'V' && r.comp !== 'A') },
  ];
  const maxTicket = Math.max(...rows.map((r) => r.ticket_lakh));
  return (
    <>
      <Heading kicker="E · Unit sizes & average ticket, all phases" title="What each home sells for" sub="₹ lakh a home, realised (after escalation); ₹/sft on saleable area" />
      <div className="grid grid-cols-[1fr_auto_auto_auto_150px] items-baseline gap-x-4 border-b border-line pb-1 text-[10px] uppercase tracking-wider text-muted">
        <span>Typology</span>
        <span className="text-right">Homes</span>
        <span className="text-right">Size · plot/carpet</span>
        <span className="text-right">₹/sft</span>
        <span className="text-right">Avg ticket</span>
      </div>
      {groups.map((g) => (
        <div key={g.name} className="mt-2">
          <p className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-fg">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: g.colour }} />
            {g.name}
          </p>
          {g.rows.map((r) => (
            <div key={r.typology} className="grid grid-cols-[1fr_auto_auto_auto_150px] items-center gap-x-4 py-0.5" title={`row ${r.row}`}>
              <span className="truncate text-[12px] text-fg/90">{r.comp === 'V' || r.comp === 'A' ? r.typology.replace(/^.*? — /, '') : r.typology.replace(' — ', ' · ')}</span>
              <span className="num text-right text-[12px] tabular-nums text-fg">{n0(r.units)}</span>
              <span className="num text-right text-[12px] tabular-nums text-muted">
                {n0(r.size_sft)}
                {r.plot_or_carpet_sft ? ` · ${n0(r.plot_or_carpet_sft)}` : ''}
              </span>
              <span className="num text-right text-[12px] tabular-nums text-muted">{n0(r.realised_rate)}</span>
              <span className="flex items-center justify-end gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line/60">
                  <span className="block h-full rounded-full" style={{ width: `${(r.ticket_lakh / maxTicket) * 100}%`, background: g.colour }} />
                </span>
                <span className="num w-16 text-right text-[15px] font-semibold tabular-nums text-accent">₹{n1(r.ticket_lakh)}L</span>
              </span>
            </div>
          ))}
        </div>
      ))}
      {avg && (
        <div className="mt-3 grid grid-cols-4 gap-2 rounded-md bg-line/30 px-3 py-2">
          {[
            ['Homes', n0(avg.units)],
            ['Average size', `${n0(avg.size_sft)} sft`],
            ['Average ticket', `₹${n1(avg.ticket_lakh)} L`],
            ['Residential revenue', `₹${n0(avg.revenue_cr)} Cr`],
          ].map(([k, v]) => (
            <div key={k}>
              <p className="text-[9px] uppercase tracking-wider text-muted">{k}</p>
              <p className="num text-[16px] font-semibold tabular-nums text-fg">{v}</p>
            </div>
          ))}
        </div>
      )}
      {footnote && <p className="mt-2 text-[11px] leading-snug text-muted">{footnote.replace(/ Detail on .*$/, '')}</p>}
      <Source cells="B57:M68" />
    </>
  );
}

function Funding({ rows }: { rows: FundRow[] }): React.ReactElement {
  const money = rows.filter((r) => r.value !== undefined && r.unit === '₹ Cr');
  const other = rows.filter((r) => !(r.value !== undefined && r.unit === '₹ Cr'));
  return (
    <>
      <Heading kicker="B · Funding & key assumptions" title="How it is paid for" />
      <div className="grid grid-cols-4 gap-2.5">
        {money.map((r) => (
          <div key={r.label} className="rounded-md border border-line/80 bg-panel-2/70 px-3 py-2.5" title={`cell ${r.cell}`}>
            <p className="text-[10px] leading-tight text-muted">{r.label}</p>
            <p className="num mt-1 text-[24px] font-semibold leading-none tabular-nums text-fg">
              <span className="mr-0.5 text-[14px] text-muted">₹</span>
              {n0(r.value!)}
              <span className="ml-1 text-[11px] font-normal text-muted">Cr</span>
            </p>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
        {other.map((r) => {
          const key = /cash turns positive/i.test(r.label);
          return (
            <div
              key={r.label}
              className={`flex items-baseline justify-between gap-3 border-b border-line/50 pb-1.5 ${(r.text ?? '').length > 28 ? 'col-span-2' : ''}`}
              title={`cell ${r.cell}`}
            >
              <span className="text-[12px] text-muted">{r.label}</span>
              <span className={`text-right text-[13px] font-semibold tabular-nums ${key ? 'text-accent' : 'text-fg'}`}>
                {r.text ?? `${r.value}${r.unit === '%' ? '%' : ` ${r.unit}`}`}
              </span>
            </div>
          );
        })}
      </div>
      <Source cells="H8:K17" />
    </>
  );
}

/** The card for the step on screen, faded in when the step changes; closed with its ✕ or F. */
export default function PresentFigures(): React.ReactElement | null {
  const step = usePresent((st) => st.step);
  const cardsOn = usePresent((st) => st.cards);
  const toggle = usePresent((st) => st.toggleCards);
  const plan = usePresent((st) => st.plans[st.option]);
  const option = usePresent((st) => st.option);
  const rules = useRules();
  const live = useLiveFinancials(rules?.financials);
  const a = useAnalysisForViews();
  const site = useSite((st) => st.site);
  const s = PRESENT_STEPS[step];
  const key = s?.card ?? s?.key ?? '';
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const t = setTimeout(() => setShown(true), 30);
    return () => clearTimeout(t);
  }, [key]);
  if (!s || !cardsOn || !rules) return null;
  // The option's own run of the model; the model as given only when no run is there yet.
  const fin = live as typeof rules.financials;
  const doc = pick(fin, `cases.${option}.summary`, null) ? { summary: pick(fin, `cases.${option}.summary`, {}) } : rules.programmeDraft;
  let body: React.ReactElement | null = null;
  if (s.card === 'land') body = <Land rows={pick<LandRow[]>(doc, 'summary.land', [])} total={pick<number>(doc, 'summary.land_total_ac', 73)} />;
  else if (s.card === 'tickets')
    body = (
      <Tickets
        rows={pick<TicketRow[]>(doc, 'summary.tickets', [])}
        avg={pick(doc, 'summary.tickets_average', null)}
        footnote={pick<string | null>(doc, 'summary.tickets_note', null)}
      />
    );
  else if (s.card === 'funding') body = <Funding rows={pick<FundRow[]>(doc, 'summary.funding', [])} />;
  else body = stepStats(s.key, s.phase, a, site?.dem ?? null, site?.measured ?? null, plan, hasPhases(plan));
  if (!body) return null;
  return (
    <div className="pointer-events-none absolute right-4 top-16 z-30 flex justify-end">
      <GlassPanel
        className={`pointer-events-auto relative w-[620px] max-w-[calc(100vw-2rem)] px-6 py-5 transition-all duration-500 ${
          shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          title="Close the figures (F brings them back)"
          aria-label="Close the figures"
          className="absolute right-3 top-3 rounded px-1.5 text-[13px] leading-none text-muted hover:bg-line/60 hover:text-fg"
        >
          ✕
        </button>
        {body}
      </GlassPanel>
    </div>
  );
}
