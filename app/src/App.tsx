import { Suspense, lazy, useEffect } from 'react';
import { useSite } from './state/store';
import { useUi, SECTIONS } from './state/uiStore';
import type { Section } from './state/uiStore';
import { useMasterPlan } from './state/masterPlanStore';
import PlanView from './ui/PlanView';
import SitePanel from './ui/SitePanel';
import ProgrammePanel from './ui/ProgrammePanel';
import RulesPanel from './ui/RulesPanel';
import CompliancePanel from './ui/CompliancePanel';
import SitingPanel from './ui/SitingPanel';
import ZoneEditPanel from './ui/ZoneEditPanel';
import ReportPanel from './ui/ReportPanel';
import MassingPanel from './ui/MassingPanel';
import MasterPlanPanel from './ui/MasterPlanPanel';
import ZonePanel from './ui/ZonePanel';
import MetricsHud from './ui/MetricsHud';
import ScenarioDock from './ui/ScenarioDock';
import { GlassPanel, PanelHeader, EdgeTab } from './ui/shell/Glass';

// three.js, SheetJS and the DXF writer are only needed once the user asks for
// 3D or an export, so they load on demand rather than in the first bundle.
const ExportPanel = lazy(() => import('./ui/ExportPanel'));
const ThreeView = lazy(() => import('./ui/ThreeView'));

/**
 * The shell puts the model first.
 *
 * The viewport is full bleed and everything else floats over it: the levers on
 * the left, what they produce on the right, the saved scenarios along the
 * bottom. Each collapses to a tab, so the drawing can always have the whole
 * screen. There is no Generate button — the figures follow the controls at
 * once and the plan redraws itself a moment behind them.
 */
export default function App(): React.ReactElement {
  const status = useSite((s) => s.status);
  const error = useSite((s) => s.error);
  const load = useSite((s) => s.load);
  const { section, leftOpen, rightOpen, setSection, toggleLeft, toggleRight } = useUi();
  const planStatus = useMasterPlan((s) => s.status);
  const viewMode = useSite((s) => s.viewMode);
  const setViewMode = useSite((s) => s.setViewMode);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink">
      {/* the model, full bleed */}
      <div className="absolute inset-0">
        {viewMode === '2d' ? (
          <PlanView />
        ) : (
          <Suspense fallback={<div className="p-4 text-muted">Loading the 3D view…</div>}>
            <ThreeView />
          </Suspense>
        )}
      </div>

      {/* title bar, floating */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
        <GlassPanel className="pointer-events-auto px-3 py-1.5">
          <h1 className="text-[12px] font-semibold text-fg">Mangalapuram Township Planner</h1>
          <p className="text-[10px] text-muted">
            73.54 ac in scope · KMBR 2019 (amended 2023) + 2025 amendment
          </p>
        </GlassPanel>

        <GlassPanel className="pointer-events-auto flex items-center gap-2 px-2 py-1.5">
          <span className="flex overflow-hidden rounded border border-line">
            {(['2d', '3d'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`px-2 py-0.5 text-[11px] transition ${
                  viewMode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'
                }`}
              >
                {mode === '2d' ? '2D' : '3D'}
              </button>
            ))}
          </span>
          <span className="text-[10px] text-muted">
            {status === 'loading' && 'loading…'}
            {status === 'error' && <span className="text-bad">{error}</span>}
            {status === 'ready' &&
              (planStatus.running ? (
                <span className="flex items-center gap-1 text-accent">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  redrawing
                </span>
              ) : (
                'ready'
              ))}
          </span>
        </GlassPanel>
      </div>

      {/* the levers */}
      <div className="pointer-events-none absolute bottom-0 left-0 top-16 z-10 flex items-start p-3">
        {leftOpen ? (
          <GlassPanel className="pointer-events-auto flex max-h-full w-[340px] flex-col">
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted">Controls</span>
              <button type="button" onClick={toggleLeft} className="px-1 text-[11px] text-muted hover:text-fg">
                ◂
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {status !== 'ready' ? (
                <div className="p-3 text-muted">
                  {status === 'error' ? <span className="text-bad">{error}</span> : 'Loading site data…'}
                </div>
              ) : (
                SECTIONS.map((s) => (
                  <div key={s.id} className="border-b border-line/70 last:border-b-0">
                    <PanelHeader
                      title={s.label}
                      hint={section === s.id ? undefined : s.hint}
                      open={section === s.id}
                      onClick={() => setSection(s.id)}
                    />
                    {section === s.id && <SectionBody section={s.id} />}
                  </div>
                ))
              )}
            </div>
          </GlassPanel>
        ) : (
          <EdgeTab label="Controls" side="left" onClick={toggleLeft} />
        )}
      </div>

      {/* what they produce */}
      <div className="pointer-events-none absolute bottom-0 right-0 top-16 z-10 flex items-start justify-end p-3">
        {rightOpen ? (
          <GlassPanel className="pointer-events-auto flex max-h-full w-[260px] flex-col">
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted">Metrics</span>
              <button type="button" onClick={toggleRight} className="px-1 text-[11px] text-muted hover:text-fg">
                ▸
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pt-2">
              <MetricsHud />
            </div>
          </GlassPanel>
        ) : (
          <EdgeTab label="Metrics" side="right" onClick={toggleRight} />
        )}
      </div>

      {/* the scenarios */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3">
        <div className="pointer-events-none w-full max-w-[min(1100px,calc(100%-640px))]">
          <ScenarioDock />
        </div>
      </div>
    </div>
  );
}

function SectionBody({ section }: { section: Section }): React.ReactElement {
  switch (section) {
    case 'site':
      return <SitePanel />;
    case 'zones':
      return <ZoneEditPanel />;
    case 'siting':
      return <SitingPanel />;
    case 'massing':
      return <MassingPanel />;
    case 'plan':
      return <MasterPlanPanel />;
    case 'zone':
      return <ZonePanel />;
    case 'programme':
      return <ProgrammePanel />;
    case 'compliance':
      return (
        <>
          <CompliancePanel />
          <RulesPanel />
        </>
      );
    case 'report':
      return <ReportPanel />;
    case 'exports':
      return (
        <Suspense fallback={<div className="p-3 text-muted">Loading the exporters…</div>}>
          <ExportPanel />
        </Suspense>
      );
    default:
      return <div className="p-3 text-muted">Nothing here yet.</div>;
  }
}
