import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSite } from '../state/store';
import type { RasterLayer } from './raster';
import { buildRaster } from './raster';
import { fitView, niceScaleBar, screenToWorld, worldToScreen } from './view';
import type { View } from './view';
import { fillMulti, label, strokePolyline, zoneColour } from './draw';
import { bboxOfMulti, multiCentroid, pointInMulti } from '../engine/geom/planar';
import { m2ToAcres } from '../engine/units';
import { pick } from '../engine/data/config';
import type { Pt } from '../engine/geom/types';
import { useLayout } from '../state/layoutStore';
import { drawLayout } from './drawLayout';

export default function PlanView(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const site = useSite((s) => s.site);
  const config = useSite((s) => s.config);
  const layers = useSite((s) => s.layers);
  const rasterMode = useSite((s) => s.raster);
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const selectZone = useSite((s) => s.selectZone);
  const options = useLayout((s) => s.options);
  const activeOptionIndex = useLayout((s) => s.activeOptionIndex);

  const [view, setView] = useState<View | null>(null);
  const [cursor, setCursor] = useState<{ world: Pt; rl: number; slope: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; centre: Pt } | null>(null);

  const unbuildableSlope = pick<number>(config?.kmbr, 'rule22_site_suitability.no_building_slope_deg_over', 45);

  const raster = useMemo<RasterLayer | null>(
    () => (site ? buildRaster(site.dem, rasterMode, unbuildableSlope) : null),
    [site, rasterMode, unbuildableSlope],
  );

  const activeLayout = options[activeOptionIndex] ?? null;

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
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = '#0f1518';
    ctx.fillRect(0, 0, view.width, view.height);

    if (raster) {
      const topLeft = worldToScreen(view, [raster.x0, raster.y0 + raster.heightM]);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        raster.canvas,
        topLeft[0],
        topLeft[1],
        raster.widthM * view.scale,
        raster.heightM * view.scale,
      );
      ctx.imageSmoothingEnabled = true;
    }

    if (layers.contours) {
      for (const c of site.contours) {
        if (layers.majorContoursOnly && !c.major) continue;
        strokePolyline(ctx, view, c.line, c.major ? 'rgba(146,168,178,0.55)' : 'rgba(120,140,150,0.25)', c.major ? 1 : 0.6);
      }
    }

    if (layers.zones) {
      for (const zone of site.zones) {
        if (zone.geom.length === 0) continue;
        const selected = zone.id === selectedZoneId;
        const colour = zoneColour(zone.name);
        fillMulti(
          ctx,
          view,
          zone.geom,
          selected ? `${colour}33` : `${colour}1a`,
          selected ? colour : `${colour}88`,
          selected ? 2 : 1,
        );
      }
    }

    if (layers.layout && activeLayout) drawLayout(ctx, view, activeLayout);

    if (layers.parcel) {
      fillMulti(ctx, view, site.parcel, undefined, '#e6edf0', 1.6);
    }

    if (layers.roads || layers.drains) {
      for (const f of site.features) {
        const isRoad = f.layer === 'RD';
        const isDrain = f.layer === 'DR';
        if (isRoad && !layers.roads) continue;
        if (isDrain && !layers.drains) continue;
        if (!isRoad && !isDrain) continue;
        for (const line of f.lines) {
          strokePolyline(ctx, view, line, isRoad ? 'rgba(230,180,85,0.85)' : 'rgba(110,190,230,0.8)', isRoad ? 1.2 : 1);
        }
      }
    }

    if (layers.points) {
      for (const f of site.features) {
        if (!f.point) continue;
        const [x, y] = worldToScreen(view, f.point);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = f.layer === 'TBM' ? '#e6b455' : '#9db6e6';
        ctx.fill();
        if (view.scale > 0.35) label(ctx, view, [f.point[0], f.point[1] + 8 / view.scale], f.layer);
      }
    }

    if (layers.zoneLabels && view.scale > 0.18) {
      for (const zone of site.zones) {
        if (zone.geom.length === 0) continue;
        const c = multiCentroid(zone.geom);
        label(ctx, view, c, zone.name, zoneColour(zone.name), '600 11px ui-sans-serif, system-ui, sans-serif');
        label(
          ctx,
          view,
          [c[0], c[1] - 14 / view.scale],
          `${zone.computedInScopeAc.toFixed(2)} ac`,
          'rgba(223,231,234,0.75)',
          '10px ui-sans-serif, system-ui, sans-serif',
        );
      }
    }

    drawScaleBar(ctx, view);
    drawNorthArrow(ctx, view);
  }, [view, site, raster, layers, selectedZoneId, activeLayout]);

  useEffect(() => {
    render();
  }, [render]);

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
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
        {raster?.legend && <Legend legend={raster.legend} />}
        {layers.deferredNote && (
          <div className="pointer-events-none max-w-64 rounded border border-line bg-panel/90 px-2 py-1.5 text-[11px] text-muted">
            26.4 ac deferred land is outside this survey and out of scope. The hospital waits for it.
          </div>
        )}
      </div>
      <div className="absolute right-3 top-3 flex gap-2">
        <button
          type="button"
          onClick={zoomToParcel}
          className="rounded border border-line bg-panel/90 px-2 py-1 text-[11px] text-fg hover:bg-panel-2"
        >
          Fit parcel
        </button>
      </div>
      {cursor && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-line bg-panel/90 px-2 py-1 text-[11px] num text-muted">
          x {cursor.world[0].toFixed(1)} m · y {cursor.world[1].toFixed(1)} m ·{' '}
          {Number.isFinite(cursor.rl) ? `RL ${cursor.rl.toFixed(2)}` : 'RL — (unsurveyed)'} ·{' '}
          {Number.isFinite(cursor.slope) ? `${cursor.slope.toFixed(1)}°` : '—'}
        </div>
      )}
      {site && (
        <div className="pointer-events-none absolute bottom-3 right-3 rounded border border-line bg-panel/90 px-2 py-1 text-[11px] num text-muted">
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

function drawScaleBar(ctx: CanvasRenderingContext2D, view: View): void {
  const { metres, px } = niceScaleBar(view);
  const x = view.width - px - 16;
  const y = view.height - 48;
  ctx.strokeStyle = 'rgba(223,231,234,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + px, y - 4);
  ctx.lineTo(x + px, y + 4);
  ctx.stroke();
  ctx.fillStyle = 'rgba(223,231,234,0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${metres} m`, x + px / 2, y - 8);
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, view: View): void {
  const x = view.width - 28;
  const y = 92;
  ctx.strokeStyle = 'rgba(223,231,234,0.85)';
  ctx.fillStyle = 'rgba(223,231,234,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y + 18);
  ctx.lineTo(x, y - 14);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 20);
  ctx.lineTo(x - 5, y - 8);
  ctx.lineTo(x + 5, y - 8);
  ctx.closePath();
  ctx.fill();
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', x, y + 30);
}
