import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { RawCellContent } from 'hyperformula';

/**
 * The owner's workbook with some cells changed, everything else exactly as it was (styles, widths, names, notes):
 * the .xlsx is opened as the zip it is, only those cells' XML is rewritten (each keeping its style), and the workbook
 * is set to recalculate in full when Excel opens it, so every formula shows the changed model.
 * Cells are "Sheet!A1" (a sheet name) -> a number, text, or a formula starting with "=".
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colNum = (a1: string): number => {
  const letters = /^[A-Z]+/.exec(a1)![0];
  return letters.split('').reduce((t, ch) => t * 26 + ch.charCodeAt(0) - 64, 0);
};

function cellXml(ref: string, style: string | null, v: RawCellContent): string {
  const s = style ? ` s="${style}"` : '';
  if (typeof v === 'string' && v.startsWith('=')) return `<c r="${ref}"${s}><f>${esc(v.slice(1))}</f></c>`;
  if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function patchSheet(xml: string, cells: [string, RawCellContent][]): string {
  let out = xml;
  for (const [ref, v] of cells) {
    const cellRe = new RegExp(`<c r="${ref}"(?=[\\s/>])([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
    const m = cellRe.exec(out);
    if (m) {
      const style = /\ss="(\d+)"/.exec(m[1]!)?.[1] ?? null;
      out = out.slice(0, m.index) + cellXml(ref, style, v) + out.slice(m.index + m[0].length);
      continue;
    }
    // not in the sheet yet: into its row, in column order (a new row if need be)
    const row = Number(/\d+$/.exec(ref)![0]);
    const rowRe = new RegExp(`<row r="${row}"(?=[\\s>])[^>]*?(?:/>|>([\\s\\S]*?)</row>)`);
    const rm = rowRe.exec(out);
    if (rm) {
      const open = rm[0].endsWith('/>') ? rm[0].slice(0, -2) + '>' : rm[0].slice(0, rm[0].length - (rm[1]!.length + 6));
      const inner = rm[1] ?? '';
      const parts: string[] = inner.match(/<c [\s\S]*?(?:\/>|<\/c>)/g) ?? [];
      const at = parts.findIndex((p) => colNum(/r="([A-Z]+)/.exec(p)![1]!) > colNum(ref));
      const cell = cellXml(ref, null, v);
      if (at < 0) parts.push(cell);
      else parts.splice(at, 0, cell);
      out = out.slice(0, rm.index) + `${open}${parts.join('')}</row>` + out.slice(rm.index + rm[0].length);
    } else {
      const rows = [...out.matchAll(/<row r="(\d+)"/g)];
      const next = rows.find((q) => Number(q[1]) > row);
      const add = `<row r="${row}">${cellXml(ref, null, v)}</row>`;
      if (next?.index !== undefined) out = out.slice(0, next.index) + add + out.slice(next.index);
      else out = out.replace('</sheetData>', `${add}</sheetData>`);
    }
  }
  return out;
}

export function patchXlsx(buf: ArrayBuffer, cells: Record<string, RawCellContent>): Uint8Array {
  const files = unzipSync(new Uint8Array(buf));
  const wbXml = strFromU8(files['xl/workbook.xml']!);
  const rels = strFromU8(files['xl/_rels/workbook.xml.rels']!);
  const target = new Map<string, string>();
  for (const m of wbXml.matchAll(/<sheet [^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/g)) {
    const name = m[1]!.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
    const t = new RegExp(`Id="${m[2]}"[^>]*?Target="([^"]+)"|Target="([^"]+)"[^>]*?Id="${m[2]}"`).exec(rels);
    const path = (t?.[1] ?? t?.[2] ?? '').replace(/^\/?xl\//, '');
    target.set(name, `xl/${path}`);
  }
  const bySheet = new Map<string, [string, RawCellContent][]>();
  for (const [key, v] of Object.entries(cells)) {
    const k = key.lastIndexOf('!');
    const sheet = key.slice(0, k);
    const list = bySheet.get(sheet) ?? [];
    list.push([key.slice(k + 1), v]);
    bySheet.set(sheet, list);
  }
  for (const [sheet, list] of bySheet) {
    const p = target.get(sheet);
    if (!p || !files[p]) continue;
    files[p] = strToU8(patchSheet(strFromU8(files[p]!), list));
  }
  // recalculate everything on opening; the calculation chain is rebuilt by Excel
  let wbOut = wbXml;
  if (/<calcPr\b/.test(wbOut)) wbOut = wbOut.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, attrs: string, close: string) => `<calcPr${attrs.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${close}>`);
  else wbOut = wbOut.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  files['xl/workbook.xml'] = strToU8(wbOut);
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    files['xl/_rels/workbook.xml.rels'] = strToU8(rels.replace(/<Relationship [^>]*?calcChain[^>]*?\/>/, ''));
    const ct = strFromU8(files['[Content_Types].xml']!);
    files['[Content_Types].xml'] = strToU8(ct.replace(/<Override [^>]*?calcChain[^>]*?\/>/, ''));
  }
  return zipSync(files, { level: 6 });
}
