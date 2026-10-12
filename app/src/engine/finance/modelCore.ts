import type { HyperFormula, RawCellContent } from 'hyperformula';
import * as XLSX from 'xlsx';
import { buildEngine, cellAddress, formatValue, inputAddress, readWorkbook } from './workbook';
import type { ModelSheet } from './workbook';
import { expandInputs, runCase } from './optionRun';
import { patchXlsx } from './xlsxPatch';
import type { CaseResult } from './optionRun';

/**
 * The live model, behind one interface whether it runs in a worker or (where the host starts none) on the page:
 * the workbook, the owner's edits on it, the run on each plan, and a sheet's cells as shown.
 */
export interface SheetMeta {
  name: string;
  rows: number;
  cols: number;
  widths: number[];
}
export interface SheetView {
  name: string;
  /** Row-major: the text shown, the formula or value as entered (for the formula bar), a number where there is one. */
  text: string[][];
  input: string[][];
}
export type Edits = Record<string, RawCellContent>; // "Sheet!A1" -> content as entered ("=..." for a formula)

export class ModelCore {
  private sheets: ModelSheet[] = [];
  private hf: HyperFormula | null = null;
  private applied: Edits = {};
  private original = new Map<string, RawCellContent>();

  init(buf: ArrayBuffer): SheetMeta[] {
    this.sheets = readWorkbook(buf);
    this.hf = buildEngine(this.sheets);
    return this.sheets.map((s) => ({ name: s.name, rows: s.rows, cols: s.cols, widths: s.widths }));
  }

  private at(key: string): ReturnType<typeof cellAddress> {
    const k = key.lastIndexOf('!');
    return cellAddress(this.hf!, key.slice(0, k), key.slice(k + 1));
  }

  /** The owner's edits, replacing the last set (cells no longer edited go back to the workbook's). */
  setEdits(edits: Edits): void {
    const hf = this.hf!;
    const keys = new Set([...Object.keys(this.applied), ...Object.keys(edits)]);
    const plan: [ReturnType<typeof cellAddress>, RawCellContent][] = [];
    for (const key of keys) {
      const at = this.at(key);
      if (!this.original.has(key)) this.original.set(key, hf.getCellSerialized(at) as RawCellContent);
      plan.push([at, key in edits ? edits[key]! : this.original.get(key)!]);
    }
    hf.batch(() => {
      for (const [at, v] of plan) hf.setCellContents(at, [[v]]);
    });
    this.applied = { ...edits };
  }

  run(inputs: Record<string, RawCellContent>): CaseResult {
    return runCase(this.hf!, this.sheets, inputs);
  }

  /** A sheet as shown, with a plan's inputs on it when one is given (and taken off again). */
  view(name: string, inputs?: Record<string, RawCellContent>): SheetView {
    const hf = this.hf!;
    const s = this.sheets.find((q) => q.name === name)!;
    const sid = hf.getSheetId(name)!;
    const all = inputs ? Object.entries(expandInputs(hf, inputs)).map(([a, v]) => [inputAddress(hf, a), v] as const) : [];
    const before = all.map(([at]) => [at, hf.getCellSerialized(at) as RawCellContent] as const);
    if (all.length) hf.batch(() => all.forEach(([at, v]) => hf.setCellContents(at, [[v]])));
    const values = hf.getSheetValues(sid);
    const serial = hf.getSheetSerialized(sid);
    const text: string[][] = [];
    const input: string[][] = [];
    for (let r = 0; r < s.rows; r += 1) {
      const tr: string[] = [];
      const ir: string[] = [];
      for (let c = 0; c < s.cols; c += 1) {
        const z = s.cells.get(XLSX.utils.encode_cell({ r, c }))?.z;
        tr.push(formatValue(values[r]?.[c] ?? null, z));
        const raw = serial[r]?.[c];
        ir.push(raw === null || raw === undefined ? '' : String(raw));
      }
      text.push(tr);
      input.push(ir);
    }
    if (all.length) hf.batch(() => before.forEach(([at, v]) => hf.setCellContents(at, [[v]])));
    return { name, text, input };
  }

  /**
   * The owner's workbook as .xlsx with an option's masterplan in it (when given) and the edits: only those cells
   * change, every style and note stays, and Excel recalculates the whole model when it opens the file.
   */
  exportXlsx(buf: ArrayBuffer, inputs?: Record<string, RawCellContent>): Uint8Array {
    const cells: Record<string, RawCellContent> = {};
    for (const [a, v] of Object.entries(inputs ? expandInputs(this.hf!, inputs) : {})) cells[a.includes('!') ? a : `Inputs!${a}`] = v;
    for (const [key, v] of Object.entries(this.applied)) cells[key] = v;
    return patchXlsx(buf, cells);
  }
}
