import type { HyperFormula, RawCellContent } from 'hyperformula';
import type { PlanResult } from '../pipeline/plan';
import type { ModelSheet } from './workbook';
import { cellAddress, formatValue, inputAddress } from './workbook';

/**
 * The draft model run on a master plan, in the app (owner 12 Oct): the plan's land, villas and the office split go into
 * the Inputs sheet (the retail split on its Costs and Retail Lease rows), the workbook recalculates, the One-Page
 * Summary is read back, and the inputs are put back as they were. The same inputs as tools/finance/run_model.py (its
 * docstring says why each one).
 */

const AC = 4046.8564224;
const ROW: Record<string, number> = {
  C01: 97, C02: 98, C08: 100, C04: 101, C05: 102, 'C16-1': 103, C15: 104, C07: 105, C10: 109,
  C13: 110, C11: 111, C19: 112, C20: 113, C12: 114, C14: 116, C16: 115,
};
const RETAIL_P1 = 'C12-1';
const OFFICE_P1: Record<string, RawCellContent> = {
  C103: 'Commercial office (strata) - Phase 1, 40%', D103: 1, E103: 'Commercial', F103: 'Y', H103: 1,
  I103: 90000, K103: 'Office', L103: 1.15, P103: 3, Q103: 10, U103: 7500, V103: 3, X103: 6, Z103: 'COMM', AB103: 0.04,
};
const OFFICE_P3: Record<string, RawCellContent> = { C115: 'Commercial office (strata) - Phase 3, 60%', D115: 3, I115: 135000, P115: 10, V115: 10, X115: 8 };
/**
 * Owner 12 Oct: retail 40% in Phase 1, 60% in Phase 3, as the office. The model's retail is one row (114), which its
 * Costs block (rows 96-99) and the Retail Lease sheet read, and no row is spare (the hospital's carries the office's
 * Phase 1), so the 40% is timed in those formulas: built from quarter 3 with the Phase 1 launch, over row 114's
 * quarters, let from its possession; the 60% keeps row 114's timing. Cost, approvals, rent and commission are linear
 * in the area, so this runs as two rows would. ASSUMPTION: the Phase 1 start (as the office's).
 */
const RETAIL_P1_START = 3;
function retailSplit(): Record<string, RawCellContent> {
  const r1 = `(${RETAIL_P1_START}+Inputs!$C$12)`;
  const s1 = `(${r1}+Inputs!$Q$114-1)`;
  const t1 = `(${s1}+Inputs!$C$60)`;
  const prog = (c: string, r: string, s: string): string => `IF(${c}$4<${r},0,IF(${c}$4>=${s},1,(1-COS(PI()*(${c}$4-${r}+1)/Inputs!$Q$114))/2))`;
  const appr = (c: string, r: string): string => `IF(${c}$4=${r},Inputs!$C$51*Inputs!$M$114/10^7*(1+Inputs!$C$10)*(1+Inputs!$C$54)^((${c}$4-1)/4),0)`;
  const occ = (c: string, t: string): string =>
    `IF(OR(${c}$4<${t},${c}$4>MIN(Inputs!$C$193,Inputs!$C$6)),0,MIN(Inputs!$C$189,Inputs!$C$189*(${c}$4-${t}+1)/Inputs!$C$190))`;
  const ph = (n: number): string => `IF(COUNTIFS($Q$8:$Q$27,"Retail F&B",$R$8:$R$27,${n})>0,"P${n} ","")`;
  const out: Record<string, RawCellContent> = {
    C114: 'Retail high street — primarily F&B (leased, not sold): 40% from Phase 1, 60% Phase 3',
    'One-Page Summary!F12': `="P1 "&${ph(2)}&${ph(3)}&${ph(4)}`, // the land card's phases: P1 with the rest
  };
  for (let i = 6; i < 46; i += 1) { // columns G-AT, quarters 1-40
    const c = i < 26 ? String.fromCharCode(65 + i) : `A${String.fromCharCode(65 + i - 26)}`;
    out[`Costs!${c}97`] = `=0.6*${prog(c, 'Inputs!$R$114', 'Inputs!$S$114')}+0.4*${prog(c, r1, s1)}`;
    out[`Costs!${c}99`] = `=0.6*${appr(c, 'Inputs!$R$114')}+0.4*${appr(c, r1)}`;
    out[`Retail Lease!${c}10`] = `=0.6*${occ(c, 'Inputs!$T$114')}+0.4*${occ(c, t1)}`;
  }
  return out;
}
const TYPES = ['1,800 sq ft plot', '2,250 sq ft plot', '2,500 sq ft plot', '2,800 sq ft plot'];
const APT_ROWS: Record<string, string> = { C02: 'E154', C11: 'E155', C19: 'E156', C20: 'E157' };
/** What each component is called in the phase descriptions (Inputs C90-C93). */
const PHRASE: Record<string, string> = {
  C08: 'villa clubhouse 1', C10: 'villa clubhouse 2 (mini-golf)', C04: '32 senior-living units', C07: 'senior enclave (160 units)',
  C15: 'senior clubhouse', C05: 'school stage A', C13: 'school stage B', 'C12-1': 'retail / F&B high street (40%)',
  C12: 'retail / F&B high street (60%)', 'C16-1': 'offices (40%)', C16: 'offices (60%)', C14: 'apartment clubhouse',
};

/** The plan's earthwork cost (Rs Cr): goes in as Inputs G45 (labelled in F45), and C45 (infrastructure, Rs Cr a gross
 * acre) becomes the model's own rate (or the owner's edit of it) plus G45 over the gross acres, so it is spent as the
 * infrastructure is (Costs row 118). */
export const EARTHWORK = 'EARTHWORK_CR';

export function expandInputs(hf: HyperFormula, inputs: Record<string, RawCellContent>): Record<string, RawCellContent> {
  if (!(EARTHWORK in inputs)) return inputs;
  const { [EARTHWORK]: cr, ...rest } = inputs;
  const base = hf.getCellValue(inputAddress(hf, 'C45'));
  return {
    ...rest,
    F45: 'Earthwork & retaining walls, this plan (Rs Cr)',
    G45: cr ?? 0,
    C45: `=${typeof base === 'number' ? base : 0.75}+G45/C16`,
  };
}

export const KEYS: [string, string, string, string, 'up' | 'down'][] = [
  ['units', 'Residential units', 'D5', 'count', 'up'],
  ['saleable_lakh_sft', 'Saleable area', 'E5', 'lakh sft', 'up'],
  ['revenue_cr', 'Total revenue', 'F5', '₹ Cr', 'up'],
  ['cost_cr', 'Total cost', 'G5', '₹ Cr', 'down'],
  ['pbt_cr', 'Profit before tax', 'H5', '₹ Cr', 'up'],
  ['pat_cr', 'Profit after tax', 'I5', '₹ Cr', 'up'],
  ['pat_margin', 'PAT margin', 'J5', '%', 'up'],
  ['project_irr', 'Project IRR (pre-tax)', 'K5', '%', 'up'],
  ['promoter_irr', 'Promoter IRR', 'L5', '%', 'up'],
  ['peak_funding_cr', 'Peak funding need', 'M5', '₹ Cr', 'down'],
  ['promoter_money_cr', 'Promoter money needed', 'N5', '₹ Cr', 'down'],
  ['peak_loan_cr', 'Peak construction loan', 'K10', '₹ Cr', 'down'],
  ['interest_cr', 'Interest & fees', 'K12', '₹ Cr', 'down'],
  ['villa_units', 'Villas', 'E25', 'count', 'up'],
  ['villa_revenue_cr', 'Villa revenue', 'J25', '₹ Cr', 'up'],
  ['villa_margin', 'Villa margin', 'M25', '%', 'up'],
];

/** The Inputs cells a plan sets, and what it holds that the presentation shows beside the figures. */
export function optionInputs(plan: PlanResult): { inputs: Record<string, RawCellContent>; meta: Record<string, unknown> } {
  const L = plan.land;
  const parcel = L.parcelM2 / AC;
  const comp: Record<string, number> = {};
  const vland: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const z of L.zones) {
    const a = z.areaM2 / AC;
    if (z.use === 'villas') vland[z.phase ?? 1] = (vland[z.phase ?? 1] ?? 0) + a;
    else if (z.component) comp[z.component] = (comp[z.component] ?? 0) + a;
  }
  comp.C12 = (comp.C12 ?? 0) + (comp[RETAIL_P1] ?? 0);
  delete comp[RETAIL_P1];
  const villaAc = vland[1]! + vland[2]! + vland[3]! + vland[4]!;
  const openAc = L.openSpaceM2 / AC;
  const roadsAc = L.roadsM2 / AC;
  const phaseOf = new Map(plan.zones.map((z) => [z.name, z.phase ?? 1]));
  const villas: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const q of plan.plots) villas[phaseOf.get(q.zone) ?? 1] = (villas[phaseOf.get(q.zone) ?? 1] ?? 0) + 1;
  const nv = plan.plots.length;
  const mix = TYPES.map((t) => plan.plots.filter((q) => q.kind === t).length / Math.max(1, nv));
  const inputs: Record<string, RawCellContent> = {
    C16: parcel, C33: roadsAc / parcel, C35: 0, C37: openAc - 0.1 * parcel, C41: plan.option.plottedShare,
    D123: vland[1]! / villaAc, D124: vland[2]! / villaAc, D125: vland[3]! / villaAc, D126: 1 - (vland[1]! + vland[2]! + vland[3]!) / villaAc,
    H99: villas[1]!, H106: villas[2]!, H107: villas[3]!, H108: villas[4]!,
  };
  for (const [c, r] of Object.entries(ROW)) inputs[`G${r}`] = comp[c] ?? 0;
  // The apartments' land as the plan has it, phase by phase, where the model splits its own (C151 x D154-D157; G98,
  // G111-G113 read it): the units stay the model's (its envelope), as the plan places them.
  for (const [c, a] of Object.entries(APT_ROWS)) inputs[a] = comp[c] ?? 0;
  inputs.C151 = Object.keys(APT_ROWS).reduce((t, c) => t + (comp[c] ?? 0), 0);
  // (Owner 12 Oct: the FSI is the township's, over the whole site, so no KMBR additional-FSI fee on the tower land.)
  // The villa mix and plots phase by phase as the plan cuts them (rows 130-145, four types a phase: the model copies
  // Phase 1's mix to every phase, and its plots are the types' nominal sizes)
  for (const ph of [1, 2, 3, 4]) {
    const inPh = plan.plots.filter((q) => (phaseOf.get(q.zone) ?? 1) === ph);
    TYPES.forEach((t, i) => {
      const row = 130 + 4 * (ph - 1) + i;
      const ps = inPh.filter((q) => q.kind === t);
      inputs[`D${row}`] = inPh.length ? ps.length / inPh.length : mix[i]!;
      if (ps.length) inputs[`F${row}`] = Math.round((ps.reduce((a, q) => a + q.areaM2, 0) / ps.length) * 10.7639);
    });
  }
  // The phases in words, from the plan (the model's still had the hospital in Phase 2, the offices in Phase 4)
  const byPhase: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const z of L.zones) {
    const ph = z.phase ?? 1;
    if (z.use === 'apartments') byPhase[ph]!.push(`apartments (phase ${ph})`);
    else if (z.use === 'villas') byPhase[ph]!.push(`villas (phase ${ph})`);
    else if (z.component && PHRASE[z.component]) byPhase[ph]!.push(PHRASE[z.component]!);
  }
  byPhase[1]!.push('sales office');
  for (const ph of [1, 2, 3, 4]) {
    const items = [...new Set(byPhase[ph])];
    inputs[`C${89 + ph}`] = `${ph === 1 ? 'Launch: ' : ''}${items.join(', ')}`;
  }
  inputs['One-Page Summary!C15'] = 'Hospital (not in this plan)';
  // Owner 12 Oct: the earthwork at the owner's rates, into the model's infrastructure (see expandInputs)
  if (plan.earthworkCost) inputs[EARTHWORK] = plan.earthworkCost.rs.total / 1e7;
  Object.assign(inputs, OFFICE_P1, OFFICE_P3, retailSplit());
  const g = L.green;
  const meta = {
    earthwork: plan.earthworkCost,
    villas: nv, villas_by_phase: [villas[1], villas[2], villas[3], villas[4]], villa_land_ac: villaAc, villas_per_acre: nv / villaAc,
    open_space_ac: openAc, roads_ac: roadsAc, parcel_ac: parcel, plot_efficiency: plan.option.plottedShare,
    green_ac: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v / AC])),
  };
  return { inputs, meta };
}

export interface CaseResult {
  /** The inputs as set (the earthwork expanded into its cells). */
  inputs: Record<string, RawCellContent>;
  values: Record<string, number | null>;
  text: Record<string, string>;
  summary: Record<string, unknown>;
}

/** Sets the inputs, reads the summary, puts the inputs back. */
export function runCase(hf: HyperFormula, sheets: ModelSheet[], given: Record<string, RawCellContent>): CaseResult {
  const inputs = expandInputs(hf, given);
  const set = Object.entries(inputs).map(([a, v]) => [inputAddress(hf, a), v] as const);
  const before = set.map(([at]) => [at, hf.getCellSerialized(at) as RawCellContent] as const);
  hf.batch(() => {
    for (const [at, v] of set) hf.setCellContents(at, [[v]]);
  });
  const summ = sheets.find((s) => s.name === 'One-Page Summary')!;
  const raw = (a: string): unknown => hf.getCellValue(cellAddress(hf, 'One-Page Summary', a));
  const num = (a: string): number | null => (typeof raw(a) === 'number' ? (raw(a) as number) : null);
  const txt = (a: string): string => formatValue(raw(a), summ.cells.get(a)?.z).trim();
  const values: Record<string, number | null> = {};
  const text: Record<string, string> = {};
  for (const [k, , cell] of KEYS) {
    values[k] = num(cell);
    text[k] = txt(cell);
  }
  const land = [];
  for (let r = 9; r <= 19; r += 1) {
    land.push({
      use: txt(`C${r}`), acres: num(`D${r}`) ?? 0, share: num(`E${r}`) ?? 0,
      phases: [...txt(`F${r}`).matchAll(/P(\d)/g)].map((m) => Number(m[1])), cell: `D${r}`,
    });
  }
  const funding = [];
  for (let r = 8; r <= 17; r += 1) {
    const v = num(`K${r}`);
    if ([8, 9, 10, 12].includes(r) && v !== null) funding.push({ label: txt(`H${r}`), value: Math.round(v * 100) / 100, unit: '₹ Cr', cell: `K${r}` });
    else if (r === 16 && v !== null) funding.push({ label: txt(`H${r}`), value: Math.round(v * 1000) / 10, unit: '%', cell: `K${r}` });
    else funding.push({ label: txt(`H${r}`), text: txt(`K${r}`), cell: `K${r}` });
  }
  const tickets = [];
  for (let r = 58; r <= 66; r += 1) {
    if (!txt(`C${r}`)) continue;
    const f = num(`F${r}`);
    tickets.push({
      comp: txt(`B${r}`), typology: txt(`C${r}`), units: Math.round(num(`D${r}`) ?? 0), size_sft: Math.round(num(`E${r}`) ?? 0),
      plot_or_carpet_sft: f ? Math.round(f) : null, base_rate: Math.round(num(`G${r}`) ?? 0), base_ticket_lakh: num(`H${r}`) ?? 0,
      realised_rate: Math.round(num(`I${r}`) ?? 0), ticket_lakh: num(`J${r}`) ?? 0, revenue_cr: num(`K${r}`) ?? 0,
      phases: txt(`L${r}`).replace('-', '–'), share_of_res_revenue: num(`M${r}`) ?? 0, row: r,
    });
  }
  const summary = {
    source: 'Draft model.xlsx · One-Page Summary', land, land_total_ac: num('D20') ?? 0, funding, tickets,
    tickets_average: { units: Math.round(num('D67') ?? 0), size_sft: Math.round(num('E67') ?? 0), ticket_lakh: num('J67') ?? 0, revenue_cr: num('K67') ?? 0, row: 67 },
    tickets_note: txt('C68'),
  };
  hf.batch(() => {
    for (const [at, v] of before) hf.setCellContents(at, [[v]]);
  });
  return { values, text, summary, inputs };
}
