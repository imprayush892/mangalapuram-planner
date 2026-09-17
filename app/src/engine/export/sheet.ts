/**
 * A single-page PDF holding one JPEG image. The plan sheet is already a raster
 * by the time it is exported, so a JPEG in a DCTDecode stream is the whole
 * document — no PDF library, and nothing that can drift from what was drawn.
 */

export interface PdfPageOptions {
  /** JPEG bytes, as produced by canvas.toBlob('image/jpeg'). */
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** Output resolution; 150 dpi keeps an A1 sheet a sensible file size. */
  dpi?: number;
  title?: string;
  author?: string;
}

const PT_PER_INCH = 72;

export function jpegToPdf(opts: PdfPageOptions): Blob {
  const dpi = opts.dpi ?? 150;
  const widthPt = (opts.widthPx / dpi) * PT_PER_INCH;
  const heightPt = (opts.heightPx / dpi) * PT_PER_INCH;

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const startObject = (): void => {
    offsets.push(length);
  };

  const esc = (s: string): string => s.replace(/([\\()])/g, '\\$1');
  const title = esc(opts.title ?? 'Mangalapuram Township Planner');
  const author = esc(opts.author ?? 'Mangalapuram Township Planner');

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  startObject();
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObject();
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  startObject();
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt.toFixed(2)} ${heightPt.toFixed(
      2,
    )}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );

  startObject();
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${opts.widthPx} /Height ${opts.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${opts.jpeg.length} >>\nstream\n`,
  );
  push(opts.jpeg);
  push('\nendstream\nendobj\n');

  const content = `q\n${widthPt.toFixed(2)} 0 0 ${heightPt.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
  startObject();
  push(`5 0 obj\n<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);

  startObject();
  push(`6 0 obj\n<< /Title (${title}) /Producer (${author}) /Creator (${author}) >>\nendobj\n`);

  const xrefOffset = length;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

/** Common sheet sizes, in pixels at the given dpi. */
export const SHEET_SIZES = {
  A3: { widthMm: 420, heightMm: 297 },
  A2: { widthMm: 594, heightMm: 420 },
  A1: { widthMm: 841, heightMm: 594 },
} as const;

export type SheetSize = keyof typeof SHEET_SIZES;

export function sheetPixels(size: SheetSize, dpi = 150): { width: number; height: number } {
  const { widthMm, heightMm } = SHEET_SIZES[size];
  return {
    width: Math.round((widthMm / 25.4) * dpi),
    height: Math.round((heightMm / 25.4) * dpi),
  };
}
