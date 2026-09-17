import { useEffect, useState } from 'react';
import { useSite } from './state/store';
import PlanView from './ui/PlanView';
import SitePanel from './ui/SitePanel';
import ProgrammePanel from './ui/ProgrammePanel';
import RulesPanel from './ui/RulesPanel';
import CompliancePanel from './ui/CompliancePanel';
import ZonePanel from './ui/ZonePanel';
import ReportPanel from './ui/ReportPanel';

type Tab = 'site' | 'programme' | 'zone' | 'rules' | 'compliance' | 'report';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'site', label: 'Site' },
  { id: 'programme', label: 'Programme' },
  { id: 'zone', label: 'Zone layout' },
  { id: 'rules', label: 'Rules' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'report', label: 'Report' },
];

export default function App(): React.ReactElement {
  const status = useSite((s) => s.status);
  const error = useSite((s) => s.error);
  const load = useSite((s) => s.load);
  const [tab, setTab] = useState<Tab>('site');

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
        <span className="text-[11px] text-muted">
          {status === 'loading' && 'loading site data…'}
          {status === 'ready' && 'site data loaded'}
          {status === 'error' && <span className="text-bad">{error}</span>}
        </span>
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
          <PlanView />
        </main>
      </div>
    </div>
  );
}

function TabBody({ tab }: { tab: Tab }): React.ReactElement {
  switch (tab) {
    case 'site':
      return <SitePanel />;
    case 'programme':
      return <ProgrammePanel />;
    case 'zone':
      return <ZonePanel />;
    case 'rules':
      return <RulesPanel />;
    case 'compliance':
      return <CompliancePanel />;
    case 'report':
      return <ReportPanel />;
    default:
      return (
        <div className="p-3 text-muted">
          <p>Coming with the next milestone.</p>
        </div>
      );
  }
}
