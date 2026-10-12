import { Suspense, lazy, useEffect, useState } from 'react';
import { useSite } from './state/store';
import PlanView from './ui/PlanView';
import MetricsHud from './ui/MetricsHud';
import ModelView from './ui/ModelView';
import { GlassPanel } from './ui/shell/Glass';
import PresentBar from './ui/PresentBar';
import PresentFigures from './ui/PresentFigures';
import PresentFinance from './ui/PresentFinance';
import { usePresent } from './state/presentStore';
import { useWalk } from './state/walkStore';
import { useModel } from './state/modelStore';
import { PRESENT_PLAN_OPTIONS } from './engine/present/prebuilt';

const ThreeView = lazy(() => import('./ui/ThreeView'));

/**
 * The app as the owner uses it (owner 12 Oct, branch clean-app): the presentation (the analysis steps and the six
 * master plans) with its figures and the financials, walk mode, 2D / 3D, the plan's stats, the plans as DXF, and the
 * draft financial model live in its own tab. The earlier planner's panels, levers and scenarios are gone.
 */
export default function App(): React.ReactElement {
  const status = useSite((s) => s.status);
  const error = useSite((s) => s.error);
  const load = useSite((s) => s.load);
  const viewMode = useSite((s) => s.viewMode);
  const setViewMode = useSite((s) => s.setViewMode);
  const presenting = usePresent((s) => s.active);
  const startPresenting = usePresent((s) => s.start);
  const walking = useWalk((s) => s.walking);
  const modelOpen = useModel((s) => s.open);
  const setModelOpen = useModel((s) => s.setOpen);
  const loadModel = useModel((s) => s.load);
  const [stats, setStats] = useState(false);
  const [dxf, setDxf] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);
  // Straight into the presentation, and the model loads behind it (its figures replace the precomputed ones).
  useEffect(() => {
    if (status === 'ready') {
      if (!usePresent.getState().active) startPresenting();
      void loadModel();
    }
  }, [status, startPresenting, loadModel]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink">
      <div className="absolute inset-0">
        {viewMode === '2d' ? (
          <PlanView />
        ) : (
          <Suspense fallback={<div className="p-4 text-muted">Loading the 3D view…</div>}>
            <ThreeView />
          </Suspense>
        )}
      </div>
      <div className={walking ? 'hidden' : 'contents'}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
          <GlassPanel className="pointer-events-auto px-3 py-1.5">
            <h1 className="text-[12px] font-semibold text-fg">Mangalapuram Township Planner</h1>
            <p className="text-[10px] text-muted">73.54 ac · KMBR 2019 (amended 2023) + 2025</p>
          </GlassPanel>
          <GlassPanel className="pointer-events-auto relative flex items-center gap-2 px-2 py-1.5">
            <span className="flex overflow-hidden rounded border border-line">
              {(['2d', '3d'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={`px-2 py-0.5 text-[11px] transition ${viewMode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'}`}
                >
                  {mode === '2d' ? '2D' : '3D'}
                </button>
              ))}
            </span>
            {!presenting && (
              <button
                type="button"
                onClick={startPresenting}
                disabled={status !== 'ready'}
                title="Present the plan step by step: terrain, water, the land that can be built on, roads, the six master plans, the massing. Next / Back, arrow keys or a clicker."
                className="rounded border border-accent/70 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent hover:bg-accent/20 disabled:opacity-40"
              >
                ▶ Present
              </button>
            )}
            <button
              type="button"
              onClick={() => setModelOpen(true)}
              title="The draft financial model, live: change any cell and every option's financials recalculate"
              className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            >
              Model
            </button>
            <button
              type="button"
              onClick={() => setStats((s) => !s)}
              className={`rounded border border-line px-2 py-0.5 text-[11px] ${stats ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'}`}
            >
              Stats
            </button>
            <button type="button" onClick={() => setDxf((d) => !d)} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg">
              DXF ▾
            </button>
            {dxf && (
              <div className="absolute right-2 top-full mt-1 flex flex-col rounded border border-line bg-panel p-1 text-[11px] shadow-lg">
                {PRESENT_PLAN_OPTIONS.map((o) => (
                  <a key={o.id} href={`data/dxf/${o.id}.dxf`} download={`Mangalapuram ${o.id}.dxf`} className="whitespace-nowrap rounded px-2 py-1 text-muted hover:bg-accent/10 hover:text-fg">
                    {o.id} · {o.label}
                  </a>
                ))}
              </div>
            )}
            <span className="text-[10px] text-muted">
              {status === 'loading' && 'loading…'}
              {status === 'error' && <span className="text-bad">{error}</span>}
            </span>
          </GlassPanel>
        </div>

        {stats && (
          <div className="pointer-events-none absolute bottom-40 right-0 top-16 z-30 flex items-start justify-end p-3">
            <GlassPanel className="pointer-events-auto flex max-h-full w-[260px] flex-col">
              <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted">Stats</span>
                <button type="button" onClick={() => setStats(false)} className="px-1 text-[11px] text-muted hover:text-fg">
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pt-2">
                <MetricsHud />
              </div>
            </GlassPanel>
          </div>
        )}

        {presenting && (
          <>
            {!stats && <PresentFigures />}
            <PresentFinance />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center p-4">
              <PresentBar />
            </div>
          </>
        )}
      </div>
      {modelOpen && <ModelView />}
    </div>
  );
}
