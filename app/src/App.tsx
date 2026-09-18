import { Suspense, lazy, useEffect, useState } from 'react';
import { useSite } from './state/store';
import PlanView from './ui/PlanView';
import SitePanel from './ui/SitePanel';
import ProgrammePanel from './ui/ProgrammePanel';
import RulesPanel from './ui/RulesPanel';
import CompliancePanel from './ui/CompliancePanel';
import ZonePanel from './ui/ZonePanel';
import SitingPanel from './ui/SitingPanel';
import MasterPlanPanel from './ui/MasterPlanPanel';
import ReportPanel from './ui/ReportPanel';
// three.js, SheetJS and the DXF writer are only needed once the user asks for
// 3D or an export, so they load on demand rather than in the first bundle.
const ExportPanel = lazy(() => import('./ui/ExportPanel'));
const ThreeView = lazy(() => import('./ui/ThreeView'));

type Tab = 'site' | 'programme' | 'siting' | 'master' | 'zone' | 'rules' | 'compliance' | 'report' | 'exports';
type ViewMode = '2d' | '3d';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'site', label: 'Site' },
  { id: 'programme', label: 'Programme' },
  { id: 'siting', label: 'Siting' },
  { id: 'master', label: 'Master plan' },
  { id: 'zone', label: 'Zone layout' },
  { id: 'rules', label: 'Rules' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'report', label: 'Report' },
  { id: 'exports', label: 'Exports' },
];

export default function App(): React.ReactElement {
  const status = useSite((s) => s.status);
  const error = useSite((s) => s.error);
  const load = useSite((s) => s.load);
  const [tab, setTab] = useState<Tab>('site');
  const [viewMode, setViewMode] = useState<ViewMode>('2d');

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full w-full flex-col bg-ink">
      <header className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold text-fg">Mangalapuram Township Planner</h1>
          <span className="text-[11px] text-muted">
            73.54 ac in scope · Thiruvananthapuram · KMBR 2019 (amended 2023) + 2025 amendment
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded border border-line">
            {(['2d', '3d'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`px-2 py-1 text-[11px] transition ${
                  viewMode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'
                }`}
              >
                {mode === '2d' ? '2D plan' : '3D'}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted">
            {status === 'loading' && 'loading site data…'}
            {status === 'ready' && 'site data loaded'}
            {status === 'error' && <span className="text-bad">{error}</span>}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel">
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`shrink-0 rounded px-2 py-1 text-[11px] transition ${
                  tab === t.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {status !== 'ready' ? (
              <div className="p-3 text-muted">
                {status === 'error' ? <span className="text-bad">{error}</span> : 'Loading site data…'}
              </div>
            ) : (
              <TabBody tab={tab} />
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          {viewMode === '2d' ? (
            <PlanView />
          ) : (
            <Suspense fallback={<Loading what="the 3D view" />}>
              <ThreeView />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}

function Loading({ what }: { what: string }): React.ReactElement {
  return <div className="p-3 text-muted">Loading {what}…</div>;
}

function TabBody({ tab }: { tab: Tab }): React.ReactElement {
  switch (tab) {
    case 'site':
      return <SitePanel />;
    case 'programme':
      return <ProgrammePanel />;
    case 'siting':
      return <SitingPanel />;
    case 'master':
      return <MasterPlanPanel />;
    case 'zone':
      return <ZonePanel />;
    case 'rules':
      return <RulesPanel />;
    case 'compliance':
      return <CompliancePanel />;
    case 'report':
      return <ReportPanel />;
    case 'exports':
      return (
        <Suspense fallback={<Loading what="the exporters" />}>
          <ExportPanel />
        </Suspense>
      );
    default:
      return (
        <div className="p-3 text-muted">
          <p>Coming with the next milestone.</p>
        </div>
      );
  }
}
