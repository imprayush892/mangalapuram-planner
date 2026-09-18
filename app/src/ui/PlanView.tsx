import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSite } from '../state/store';
import type { RasterLayer } from './raster';
import { buildRaster } from './raster';
import { fitView, screenToWorld } from './view';
import type { View } from './view';
import { bboxOfMulti, pointInMulti } from '../engine/geom/planar';
import { drawPlan } from './planRenderer';
import { USE_COLOUR } from './draw';
import { useSiting } from '../state/sitingStore';
import { useMasterPlan } from '../state/masterPlanStore';
import { useZoneEdit } from '../state/zoneEditStore';
import { registerCanvas, useUi } from '../state/uiStore';
import { USE_LABEL } from '../engine/site/level1';
import { m2ToAcres } from '../engine/units';
import { pick } from '../engine/data/config';
import type { Pt } from '../engine/geom/types';
import { useLayout } from '../state/layoutStore';
import { useEditedSite } from '../state/useEditedSite';

export default function PlanView(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const site = useEditedSite();
  const config = useSite((s) => s.config);
  const layers = useSite((s) => s.layers);
  const rasterMode = useSite((s) => s.raster);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const selectZone = useSite((s) => s.selectZone);
  const options = useLayout((s) => s.options);
  const activeOptionIndex = useLayout((s) => s.activeOptionIndex);
  const sitingResult = useSiting((s) => s.result);
  const sitingActive = useSiting((s) => s.activeIndex);
  const masterPlan = useMasterPlan((s) => s.plan);
  const rightOpen = useUi((s) => s.rightOpen);
  const dockOpen = useUi((s) => s.dockOpen);
  const editTool = useZoneEdit((s) => s.tool);
  const editPending = useZoneEdit((s) => s.pending);
  const editSelected = useZoneEdit((s) => s.selected);
  const addEditPoint = useZoneEdit((s) => s.addPoint);
  const toggleEditSelected = useZoneEdit((s) => s.toggleSelected);

  // Where the siting engine has run, the plan shows what it decided.
  const { zoneColours, zoneLabels } = useMemo(() => {
    const alt = sitingResult?.alternatives[sitingActive];
    if (!alt) return { zoneColours: undefined, zoneLabels: undefined };
    const colours: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (const a of alt.allocations) {
      colours[a.zoneId] = USE_COLOUR[a.use] ?? '#b9c6cc';
      labels[a.zoneId] = USE_LABEL[a.use];
    }
    return { zoneColours: colours, zoneLabels: labels };
  }, [sitingResult, sitingActive]);

  const [view, setView] = useState<View | null>(null);
  const [cursor, setCursor] = useState<{ world: Pt; rl: number; slope: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; centre: Pt } | null>(null);

  const unbuildableSlope = pick<number>(config?.kmbr, 'rule22_site_suitability.no_building_slope_deg_over', 45);

  const raster = useMemo<RasterLayer | null>(
    () => (site ? buildRaster(site.dem, rasterMode, unbuildableSlope) : null),
    [site, rasterMode, unbuildableSlope],
  );

  const activeLayout = options[activeOptionIndex] ?? null;

  /**
   * A master plan run supersedes the single-zone view: once the whole site has
   * been generated, the plan shows every zone's chosen layout, not just the one
   * zone last worked on.
   */
  const layouts = useMemo(() => {
    if (masterPlan) {
      return masterPlan.zones
        .map((z) => z.options[z.chosenIndex])
        .filter((l): l is NonNullable<typeof l> => Boolean(l));
    }
    return activeLayout ? [activeLayout] : [];
  }, [masterPlan, activeLayout]);

  // Fit the parcel on first load and on resize.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !site) return;
    const resize = (): void => {
      const { clientWidth, clientHeight } = wrap;
      setView((prev) => {
        if (prev) return { ...prev, width: clientWidth, height: clientHeight };
        return fitView(bboxOfMulti(site.parcel), clientWidth, clientHeight);
      });
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [site]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !site) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = view.width * dpr;
    canvas.height = view.height * dpr;
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${view.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPlan(ctx, view, {
      site,
      layers,
      raster,
      layouts,
      circulation: masterPlan?.circulation.roads,
      splays: masterPlan?.junctions.splays,
      selectedZoneId,
      background: '#0f1518',
      zoneColours,
      zoneLabels,
      editPending: editTool === 'none' ? undefined : editPending,
      editTool,
      editSelected,
      // Keep the scale bar and north arrow clear of the floating panels.
      chromeInset: { right: rightOpen ? 280 : 48, bottom: dockOpen ? 150 : 40 },
    });
  }, [
    view,
    site,
    raster,
    layers,
    selectedZoneId,
    layouts,
    masterPlan,
    zoneColours,
    zoneLabels,
    editTool,
    editPending,
    editSelected,
    rightOpen,
    dockOpen,
  ]);

  useEffect(() => {
    render();
  }, [render]);

  // The scenario dock takes its thumbnail from whatever is on screen.
  useEffect(() => {
    registerCanvas(canvasRef.current);
    return () => registerCanvas(null);
  }, []);

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    if (!view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px: Pt = [e.clientX - rect.left, e.clientY - rect.top];
    const before = screenToWorld(view, px);
    const scale = Math.min(20, Math.max(0.05, view.scale * Math.exp(-e.deltaY * 0.0015)));
    const after = screenToWorld({ ...view, scale }, px);
    setView({ ...view, scale, centre: [view.centre[0] + before[0] - after[0], view.centre[1] + before[1] - after[1]] });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, centre: view.centre };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!view || !site) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const world = screenToWorld(view, [e.clientX - rect.left, e.clientY - rect.top]);
    const drag = dragRef.current;
    if (drag) {
      setView({
        ...view,
        centre: [
          drag.centre[0] - (e.clientX - drag.x) / view.scale,
          drag.centre[1] + (e.clientY - drag.y) / view.scale,
        ],
      });
      return;
    }
    const rl = site.dem.sampleBilinear(world);
    const { slopeDeg } = site.dem.slopeAt(world);
    setCursor({ world, rl, slope: slopeDeg });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !view || !site) return;
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (moved > 4) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const world = screenToWorld(view, [e.clientX - rect.left, e.clientY - rect.top]);
    const hit = site.zones.find((z) => pointInMulti(world, z.geom));

    // With an edit tool live, a click builds the edit. Splitting still needs a
    // zone picked, so the first click inside one selects it as well.
    if (editTool === 'split') {
      if (!selectedZoneId && hit) selectZone(hit.id);
      addEditPoint(world);
      return;
    }
    if (editTool === 'draw') {
      addEditPoint(world);
      return;
    }
    if (editTool === 'merge') {
      if (hit) toggleEditSelected(hit.id);
      return;
    }

    selectZone(hit ? hit.id : null);
  };

  const zoomToParcel = (): void => {
    if (!site || !view) return;
    setView(fitView(bboxOfMulti(site.parcel), view.width, view.height));
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-ink">
      <canvas
        ref={canvasRef}
        className="block touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
      />
      {/*
        The shell floats its own panels over this canvas, so the plan's chrome
        sits in the strip between them rather than underneath them.
      */}
      <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-2">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={zoomToParcel}
            className="pointer-events-auto shrink-0 rounded border border-line bg-panel/85 px-2 py-1 text-[11px] text-fg backdrop-blur-md hover:bg-panel-2"
          >
            Fit parcel
          </button>
          {layers.deferredNote && (
            <div className="max-w-md rounded border border-line bg-panel/85 px-2 py-1 text-[10px] leading-snug text-muted backdrop-blur-md">
              26.4 ac deferred land is outside this survey and out of scope. The hospital waits for it.
            </div>
          )}
        </div>
        {raster?.legend && <Legend legend={raster.legend} />}
      </div>

      {cursor && (
        <div className="pointer-events-none absolute bottom-3 left-[360px] rounded border border-line bg-panel/85 px-2 py-1 text-[11px] num text-muted backdrop-blur-md">
          x {cursor.world[0].toFixed(1)} m · y {cursor.world[1].toFixed(1)} m ·{' '}
          {Number.isFinite(cursor.rl) ? `RL ${cursor.rl.toFixed(2)}` : 'RL — (unsurveyed)'} ·{' '}
          {Number.isFinite(cursor.slope) ? `${cursor.slope.toFixed(1)}°` : '—'}
        </div>
      )}
      {site && (
        <div className="pointer-events-none absolute bottom-3 right-[290px] hidden rounded border border-line bg-panel/85 px-2 py-1 text-[11px] num text-muted backdrop-blur-md lg:block">
          parcel {m2ToAcres(site.parcelAreaM2).toFixed(2)} ac
        </div>
      )}
    </div>
  );
}

function Legend({ legend }: { legend: NonNullable<RasterLayer['legend']> }): React.ReactElement {
  return (
    <div className="rounded border border-line bg-panel/90 px-2 py-1.5">
      <div className="mb-1 text-[11px] text-fg">{legend.label}</div>
      <div className="flex items-center gap-1">
        {legend.stops.map((s) => (
          <div key={s.value} className="flex flex-col items-center">
            <div className="h-3 w-8" style={{ background: s.colour }} />
            <div className="num text-[10px] text-muted">{s.value.toFixed(s.value < 10 ? 1 : 0)}</div>
          </div>
        ))}
        <div className="ml-1 text-[10px] text-muted">{legend.unit}</div>
      </div>
    </div>
  );
}


