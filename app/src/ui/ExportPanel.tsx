import { useMemo, useState } from 'react';
import { useSite } from '../state/store';
import { useLayout } from '../state/layoutStore';
import { useRules } from '../state/useRules';
import { Button, Check, Panel, Row, Select } from './primitives';
import { exportDxf, dxfReadme } from '../engine/export/dxf';
import { buildAreaStatement, workbookToBlob } from '../engine/export/xlsx';
import { buildMassingScene, exportGlb } from '../engine/export/glb';
import { jpegToPdf, sheetPixels } from '../engine/export/sheet';
import type { SheetSize } from '../engine/export/sheet';
import { loadProgramme } from '../engine/rules/programme';
import { runLevel1 } from '../engine/site/level1';
import { pick } from '../engine/data/config';
import { buildRaster } from './raster';
import { drawPlan, drawTitleBlock } from './planRenderer';
import { fitView } from './view';
import { bboxOfMulti, multiPolyArea } from '../engine/geom/planar';
import { m2ToAcres } from '../engine/units';
import type { RasterMode } from '../state/store';
import { useEditedSite } from '../state/useEditedSite';

const SHEETS: readonly { value: SheetSize; label: string }[] = [
  { value: 'A3', label: 'A3 (420 × 297 mm)' },
  { value: 'A2', label: 'A2 (594 × 420 mm)' },
  { value: 'A1', label: 'A1 (841 × 594 mm)' },
];

const RASTERS: readonly { value: RasterMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'rl', label: 'Levels (RL)' },
  { value: 'slope', label: 'Slope' },
  { value: 'fall', label: 'Fall across a plot window' },
  { value: 'buildable', label: 'Buildability (Rule 22)' },
];

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

export default function ExportPanel(): React.ReactElement {
  const site = useEditedSite();
  const layers = useSite((s) => s.layers);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const rules = useRules();
  const { byZone, activeOptionIndex } = useLayout();
  const [utm, setUtm] = useState(false);
  const [includeContours, setIncludeContours] = useState(true);
  const [sheetSize, setSheetSize] = useState<SheetSize>('A2');
  const [sheetRaster, setSheetRaster] = useState<RasterMode>('slope');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const layouts = useMemo(
    () =>
      Object.values(byZone)
        .map((options) => options[Math.min(activeOptionIndex, options.length - 1)])
        .filter((o): o is NonNullable<typeof o> => Boolean(o)),
    [byZone, activeOptionIndex],
  );

  const programme = useMemo(
    () => (rules ? loadProgramme(rules.programme, rules.client, rules.kmbr, rules.assumptions) : null),
    [rules],
  );

  if (!site || !rules || !programme) return <div className="p-3 text-muted">Loading…</div>;

  const level1 = runLevel1({
    zones: site.zones,
    parcel: site.parcel,
    programme,
    generated: byZone,
    householdSizes: {
      family: pick<number>(rules.assumptions, 'household_size_family', 3.5),
      senior: pick<number>(rules.assumptions, 'household_size_senior', 1.6),
    },
  });

  const run = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
      setMessage(`${name} written.`);
    } catch (err) {
      setMessage(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const doDxf = (): void => {
    const opts = { site, layouts, includeContours, utm };
    download(new Blob([exportDxf(opts)], { type: 'application/dxf' }), `mangalapuram-plan-${stamp()}.dxf`);
    download(new Blob([dxfReadme(opts)], { type: 'text/plain' }), `mangalapuram-plan-${stamp()}-readme.txt`);
  };

  const doXlsx = (): void => {
    const wb = buildAreaStatement({ site, layouts, programme, level1, client: rules.client });
    download(workbookToBlob(wb), `mangalapuram-area-statement-${stamp()}.xlsx`);
  };

  const doGlb = async (): Promise<void> => {
    const scene = buildMassingScene({ dem: site.dem, layouts, parcel: site.parcel, terrainStep: 4 });
    const buffer = await exportGlb(scene);
    download(new Blob([buffer], { type: 'model/gltf-binary' }), `mangalapuram-massing-${stamp()}.glb`);
  };

  const renderSheet = async (): Promise<HTMLCanvasElement> => {
    const { width, height } = sheetPixels(sheetSize, 150);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas not available');

    const zone = site.zones.find((z) => z.id === selectedZoneId);
    const focus = zone && zone.geom.length > 0 ? zone.geom : site.parcel;
    const panelWidth = Math.round(width * 0.22);
    const view = fitView(bboxOfMulti(focus), width - panelWidth, height, 40);

    drawPlan(ctx, { ...view, width: width - panelWidth, height }, {
      site,
      layers: { ...layers, layout: true },
      raster: buildRaster(site.dem, sheetRaster, 45),
      layouts,
      selectedZoneId,
      background: '#0f1518',
      // 150 dpi on paper against roughly 96 dpi on screen, plus a little extra
      // so a printed line is not hairline thin.
      pen: 2.4,
      rasterOpacity: 0.45,
    });

    const focusAc = m2ToAcres(multiPolyArea(focus));
    const active = layouts.find((l) => l.zoneId === selectedZoneId) ?? layouts[0];
    drawTitleBlock(ctx, width, height, {
      title: zone ? zone.name : 'Mangalapuram township — site plan',
      subtitle: active ? active.strategy : 'Client zoning plan registered onto the survey',
      rows: [
        ['Area', `${focusAc.toFixed(2)} ac`],
        ['Scale', 'as drawn'],
        ['Datum', `TBM = ${site.origin.tbm.rl.toFixed(3)}`],
        ['Coordinates', 'local metres'],
        ['Sheet', sheetSize],
        ['Date', stamp()],
        ...(active
          ? ([
              ['Plots', String(active.metrics.plotCount)],
              ['Units', `${active.metrics.unitCount} of ${active.metrics.targetUnits}`],
              ['Towers', String(active.metrics.towerCount)],
              ['Roads', `${(active.metrics.shares.roads * 100).toFixed(1)}%`],
              ['Open space', `${(active.metrics.shares.openSpace * 100).toFixed(1)}%`],
              ['Saleable', `${(active.metrics.shares.saleable * 100).toFixed(1)}%`],
            ] as [string, string][])
          : []),
      ],
      notes: [
        'Levels are RL on an assumed datum (TBM = 100.000). The MSL offset is not known, so outfall design is not covered.',
        'About 12.9 ac of the parcel is unsurveyed and is left open rather than filled.',
        'The 26.4 ac of deferred land is out of scope; the hospital waits for it.',
        'KMBR 2019 (amended to 17.01.2023) with the 2025 amendment. Client rules govern the first cut; KMBR is checked on top.',
      ],
    });
    return canvas;
  };

  const doPng = async (): Promise<void> => {
    const canvas = await renderSheet();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('the browser refused to encode the sheet');
    download(blob, `mangalapuram-sheet-${sheetSize}-${stamp()}.png`);
  };

  const doPdf = async (): Promise<void> => {
    const canvas = await renderSheet();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('the browser refused to encode the sheet');
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const pdf = jpegToPdf({
      jpeg,
      widthPx: canvas.width,
      heightPx: canvas.height,
      dpi: 150,
      title: `Mangalapuram township — ${sheetSize} sheet`,
    });
    download(pdf, `mangalapuram-sheet-${sheetSize}-${stamp()}.pdf`);
  };

  return (
    <>
      <Panel title="What will be exported">
        <Row label="Layouts" value={`${layouts.length}`} hint="the chosen option of every zone generated" />
        {layouts.map((l) => (
          <Row key={l.id} label={`  ${l.zoneName}`} value={l.kind} />
        ))}
        {layouts.length === 0 && (
          <p className="pt-1 text-[11px] leading-snug text-muted">
            Nothing has been generated yet. The site, contours and client zones still export; generate a zone in the
            Zone layout tab to include plots, roads and towers.
          </p>
        )}
      </Panel>

      <Panel title="DXF plan">
        <Check label="Contours" checked={includeContours} onChange={setIncludeContours} />
        <Check label="Write UTM 43N instead of local metres" checked={utm} onChange={setUtm} />
        <div className="mt-1.5">
          <Button tone="primary" disabled={busy !== null} onClick={() => void run('DXF', doDxf)}>
            {busy === 'DXF' ? 'Writing…' : 'Export DXF'}
          </Button>
        </div>
        <p className="pt-2 text-[11px] leading-snug text-muted">
          One layer per use, road type, plot, open space and tower, with plot and tower labels carrying their area and
          platform RL. A readme goes with it giving the origin, the datum and the layer list.
        </p>
      </Panel>

      <Panel title="XLSX area statement">
        <Button tone="primary" disabled={busy !== null} onClick={() => void run('XLSX', doXlsx)}>
          {busy === 'XLSX' ? 'Writing…' : 'Export area statement'}
        </Button>
        <p className="pt-2 text-[11px] leading-snug text-muted">
          Sheets: summary, programme, zones, plots, towers, blocks, compliance and the cashflow-shaped lines. Every
          row carries area, units, plinth, SBUA, UDS, FSI, coverage, parking and population where they apply, and the
          rule or file each number came from.
        </p>
      </Panel>

      <Panel title="Sheet (PNG and PDF)">
        <Select label="Size" value={sheetSize} options={SHEETS} onChange={setSheetSize} />
        <Select label="Raster" value={sheetRaster} options={RASTERS} onChange={setSheetRaster} />
        <div className="mt-1.5 flex gap-2">
          <Button tone="primary" disabled={busy !== null} onClick={() => void run('PNG', doPng)}>
            {busy === 'PNG' ? 'Rendering…' : 'Export PNG'}
          </Button>
          <Button disabled={busy !== null} onClick={() => void run('PDF', doPdf)}>
            {busy === 'PDF' ? 'Rendering…' : 'Export PDF'}
          </Button>
        </div>
        <p className="pt-2 text-[11px] leading-snug text-muted">
          The sheet frames the selected zone, or the whole parcel when none is selected, and carries a title block
          with the areas, the datum and the standing caveats. 150 dpi.
        </p>
      </Panel>

      <Panel title="GLB massing">
        <Button tone="primary" disabled={busy !== null} onClick={() => void run('GLB', doGlb)}>
          {busy === 'GLB' ? 'Writing…' : 'Export GLB'}
        </Button>
        <p className="pt-2 text-[11px] leading-snug text-muted">
          Terrain mesh from the 2 m DEM plus extruded villas, towers and blocks on their platform levels, grouped per
          zone. Unsurveyed ground is left open, not filled. Opens in Rhino, Blender and the Windows 3D viewer.
        </p>
      </Panel>

      {message && <div className="px-3 pb-3 pt-1 text-[11px] text-muted">{message}</div>}
    </>
  );
}
