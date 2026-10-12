import * as XLSX from 'xlsx';
import { FunctionArgumentType, FunctionPlugin, HyperFormula, CellError, ErrorType } from 'hyperformula';
import type { SimpleCellAddress } from 'hyperformula';

/**
 * The owner's draft financial model (Draft model.xlsx), live in the app (owner 12 Oct): the workbook is read with its
 * formulas and recalculated by a spreadsheet engine (HyperFormula), so a change to any cell runs through the whole
 * model as it would in Excel. Values are shown with the workbook's own number formats.
 */

/** IRR, which the engine lacks: Newton's method from the guess, bisection if that wanders. */
class IrrPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    IRR: {
      method: 'irr',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.NUMBER, defaultValue: 0.1 },
      ],
    },
  };

  public irr(ast: { args: unknown[] }, state: unknown): unknown {
    return this.runFunction(ast.args as never, state as never, this.metadata('IRR'), (range: { valuesFromTopLeftCorner: () => unknown[] }, guess: number) => {
      const cf = range.valuesFromTopLeftCorner().filter((v): v is number => typeof v === 'number');
      if (cf.length < 2 || !cf.some((v) => v > 0) || !cf.some((v) => v < 0)) return new CellError(ErrorType.NUM);
      const npv = (r: number): number => cf.reduce((s, v, i) => s + v / (1 + r) ** i, 0);
      const d = (r: number): number => cf.reduce((s, v, i) => s - (i * v) / (1 + r) ** (i + 1), 0);
      let r = guess;
      for (let k = 0; k < 100; k += 1) {
        const f = npv(r);
        const g = d(r);
        if (!Number.isFinite(f) || !Number.isFinite(g) || g === 0) break;
        const nr = r - f / g;
        if (Math.abs(nr - r) < 1e-12) return nr;
        r = nr;
        if (r <= -0.9999) break;
      }
      let lo = -0.9999;
      let hi = 10;
      if (npv(lo) * npv(hi) > 0) return new CellError(ErrorType.NUM);
      for (let k = 0; k < 300; k += 1) {
        const m = (lo + hi) / 2;
        if (npv(lo) * npv(m) <= 0) hi = m;
        else lo = m;
      }
      return (lo + hi) / 2;
    });
  }
}
HyperFormula.registerFunctionPlugin(IrrPlugin, { enGB: { IRR: 'IRR' } });

/** TEXT with Excel's own number formats (the engine's knows only a few). */
class TextPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    TEXT: {
      method: 'text',
      parameters: [{ argumentType: FunctionArgumentType.SCALAR }, { argumentType: FunctionArgumentType.STRING }],
    },
  };

  public text(ast: { args: unknown[] }, state: unknown): unknown {
    return this.runFunction(ast.args as never, state as never, this.metadata('TEXT'), (v: unknown, fmt: string) => {
      if (typeof v === 'number') {
        try {
          return XLSX.SSF.format(fmt, v);
        } catch {
          return String(v);
        }
      }
      return v === null || v === undefined ? '' : String(v);
    });
  }
}
HyperFormula.unregisterFunction('TEXT');
HyperFormula.registerFunctionPlugin(TextPlugin, { enGB: { TEXT: 'TEXT' } });

/** MOD as Excel has it: the sign of the divisor (MOD(-3, 12) = 9). */
class ModPlugin extends FunctionPlugin {
  public static implementedFunctions = {
    MOD: {
      method: 'mod',
      parameters: [{ argumentType: FunctionArgumentType.NUMBER }, { argumentType: FunctionArgumentType.NUMBER }],
    },
  };

  public mod(ast: { args: unknown[] }, state: unknown): unknown {
    return this.runFunction(ast.args as never, state as never, this.metadata('MOD'), (n: number, d: number) =>
      d === 0 ? new CellError(ErrorType.DIV_BY_ZERO) : n - d * Math.floor(n / d),
    );
  }
}
HyperFormula.unregisterFunction('MOD');
HyperFormula.registerFunctionPlugin(ModPlugin, { enGB: { MOD: 'MOD' } });

/**
 * Excel reads INDEX(one-row range, n) as the nth column; the engine as the nth row. Such a call becomes
 * INDEX(range, 1, n) on the way in.
 */
export function fixIndex(f: string): string {
  let out = '';
  let i = 0;
  while (i < f.length) {
    const k = f.indexOf('INDEX(', i);
    if (k < 0 || (k > 0 && /[A-Z0-9_.]/.test(f[k - 1]!))) {
      if (k < 0) {
        out += f.slice(i);
        break;
      }
      out += f.slice(i, k + 6);
      i = k + 6;
      continue;
    }
    out += f.slice(i, k + 6);
    // the arguments, split at the top level
    let depth = 0;
    let quote = false;
    let j = k + 6;
    const args: string[] = [];
    let start = j;
    for (; j < f.length; j += 1) {
      const ch = f[j]!;
      if (ch === "'" || ch === '"') quote = !quote;
      if (quote) continue;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        args.push(f.slice(start, j));
        start = j + 1;
      }
    }
    args.push(f.slice(start, j));
    const fixed = args.map(fixIndex);
    const m = /([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(fixed[0]!.replace(/\$/g, '').trim());
    if (fixed.length === 3 && fixed[2]!.trim() === '0' && m && Number(m[4]) > Number(m[2])) {
      // INDEX(range, i, 0), the whole of row i (the engine takes no 0): the row, chosen by i
      const sheet = /^(.*!)/.exec(fixed[0]!.trim())?.[1] ?? '';
      const [r0, r1] = [Number(m[2]), Number(m[4])];
      const pick = Array.from({ length: r1 - r0 + 1 }, (_, q) => `${sheet}$${m[1]}$${r0 + q}:$${m[3]}$${r0 + q}`);
      out = out.slice(0, out.length - 6);
      out += `CHOOSE(${fixed[1]},${pick.join(',')})`;
      i = j + 1;
      continue;
    }
    if (fixed.length === 2 && m && m[2] === m[4] && m[1] !== m[3]) out += `${fixed[0]},1,${fixed[1]}`;
    else out += fixed.join(',');
    out += ')';
    i = j + 1;
  }
  return out;
}

export interface SheetCell {
  /** The formula without '=', when the cell has one. */
  f?: string;
  /** The value Excel last saved. */
  v?: number | string | boolean;
  /** Excel number format. */
  z?: string;
}
export interface ModelSheet {
  name: string;
  rows: number;
  cols: number;
  cells: Map<string, SheetCell>;
  /** Column widths in characters, where the workbook sets them. */
  widths: number[];
}

export interface Workbook {
  sheets: ModelSheet[];
  hf: HyperFormula;
}

const addr = (r: number, c: number): string => XLSX.utils.encode_cell({ r, c });

/** Reads the workbook (its formulas, values and number formats). */
export function readWorkbook(buf: ArrayBuffer | Uint8Array): ModelSheet[] {
  const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellNF: true, cellDates: false, cellStyles: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    const cells = new Map<string, SheetCell>();
    for (const [k, cell] of Object.entries(ws)) {
      if (k.startsWith('!')) continue;
      const c = cell as XLSX.CellObject;
      cells.set(k, {
        ...(c.f ? { f: c.f } : {}),
        ...(c.v !== undefined ? { v: c.v as number | string | boolean } : {}),
        ...(c.z ? { z: String(c.z) } : {}),
      });
    }
    const widths = (ws['!cols'] ?? []).map((col) => (col?.wch ?? (col?.wpx ? col.wpx / 7 : 9)));
    return { name, rows: ref.e.r + 1, cols: ref.e.c + 1, cells, widths };
  });
}

/** The engine over the sheets: every formula live. */
export function buildEngine(sheets: ModelSheet[]): HyperFormula {
  const data: Record<string, (string | number | boolean | null)[][]> = {};
  for (const s of sheets) {
    const grid: (string | number | boolean | null)[][] = Array.from({ length: s.rows }, () => Array<string | number | boolean | null>(s.cols).fill(null));
    for (const [k, c] of s.cells) {
      const { r, c: col } = XLSX.utils.decode_cell(k);
      grid[r]![col] = c.f !== undefined ? `=${fixIndex(c.f)}` : c.v ?? null;
    }
    data[s.name] = grid;
  }
  return HyperFormula.buildFromSheets(data, {
    licenseKey: 'gpl-v3',
    useArrayArithmetic: true,
    smartRounding: false,
    precisionRounding: 15,
    nullDate: { year: 1899, month: 12, day: 30 },
    leapYear1900: false,
  });
}

export function sheetId(hf: HyperFormula, name: string): number {
  const id = hf.getSheetId(name);
  if (id === undefined) throw new Error(`no sheet ${name}`);
  return id;
}

/** "Inputs!C33" style or a sheet and cell. */
export function cellAddress(hf: HyperFormula, sheet: string, a1: string): SimpleCellAddress {
  const { r, c } = XLSX.utils.decode_cell(a1);
  return { sheet: sheetId(hf, sheet), row: r, col: c };
}

/** An input's address: "C33" on the Inputs sheet, or "One-Page Summary!C15". */
export function inputAddress(hf: HyperFormula, key: string): SimpleCellAddress {
  const k = key.lastIndexOf('!');
  return k < 0 ? cellAddress(hf, 'Inputs', key) : cellAddress(hf, key.slice(0, k), key.slice(k + 1));
}

export function valueAt(hf: HyperFormula, sheet: string, a1: string): unknown {
  return hf.getCellValue(cellAddress(hf, sheet, a1));
}

/** A value as Excel would show it, with the cell's number format. */
export function formatValue(v: unknown, z?: string): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v !== null && 'type' in v) return `#${String((v as { type: string }).type)}`;
  if (typeof v === 'number') {
    if (z && z !== 'General') {
      try {
        return XLSX.SSF.format(z, v);
      } catch {
        /* fall through */
      }
    }
    return Math.abs(v) >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

export { addr };
