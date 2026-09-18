import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useSite } from './state/store';
import { useUi } from './state/uiStore';
import { useMasterPlan } from './state/masterPlanStore';
import { useSettings } from './state/settingsStore';
import { useZoneEdit } from './state/zoneEditStore';
import { useSiting } from './state/sitingStore';
import { useGoal } from './state/goalStore';
import { useZoneUses } from './state/useLiveMetrics';
import { useRules } from './state/useRules';
import { runMasterPlanGeneration } from './state/generate';
import { coverageFsi } from './engine/rules/kmbr';
import PlanView from './ui/PlanView';
import SitePanel from './ui/SitePanel';
import ProgrammePanel from './ui/ProgrammePanel';
import RulesPanel from './ui/RulesPanel';
import CompliancePanel from './ui/CompliancePanel';
import SitingPanel from './ui/SitingPanel';
import ZoneEditPanel from './ui/ZoneEditPanel';
import ReportPanel from './ui/ReportPanel';
import MasterPlanPanel from './ui/MasterPlanPanel';
import ZonePanel from './ui/ZonePanel';
import GoalPanel from './ui/GoalPanel';
import MetricsHud from './ui/MetricsHud';
import ScenarioDock from './ui/ScenarioDock';
import LeverStrip from './ui/LeverStrip';
import { GlassPanel, EdgeTab } from './ui/shell/Glass';
import { IconRail } from './ui/shell/IconRail';
import type { RailItem } from './ui/shell/IconRail';
import { SolveBar } from './ui/shell/SolveBar';

const ExportPanel = lazy(() => import('./ui/ExportPanel'));
const ThreeView = lazy(() => import('./ui/ThreeView'));

/**
 * Each rail item says what it DOES to what is on screen, not what it is. That
 * sentence is the whole tooltip, and it is the thing the old tab bar never had.
 */
const RAIL: readonly RailItem[] = [
  { id: 'goal', glyph: '◎', label: 'Optimisation goal', does: 'Sets how much space, terrain and water each count. Re-aims every choice the engine makes; nothing on screen changes until you solve.' },
  { id: 'site', glyph: '◳', label: 'Site and terrain', does: 'Turns the terrain layers on and off underneath the plan: slope, plot fall, contours, surveyed ground.' },
  { id: 'zones', glyph: '✂', label: 'Edit the zoning', does: 'Split, merge, draw or delete zones by clicking on the plan. Changes the boundaries everything else is built inside.' },
  { id: 'siting', glyph: '◈', label: 'What goes where', does: 'Runs the siting engine and recolours every zone by the use it chose, with the score and the reason.' },
  { id: 'plan', glyph: '▦', label: 'The drawn plan', does: 'Reads back what was drawn: totals, roads by tier, junctions, gradients, and each zone in turn.' },
  { id: 'zone', glyph: '⬚', label: 'Selected zone', does: 'Three layout options for the one zone you picked on the plan, and what each holds.' },
  { id: 'programme', glyph: '≣', label: 'Programme', does: 'Shows what the brief asks for against the land in scope. Read-only.' },
  { id: 'compliance', glyph: '✓', label: 'Compliance and rules', does: 'Findings against KMBR and the client rules, and every rule value you can override.' },
  { id: 'report', glyph: '▤', label: 'Report', does: 'Use by use, what has to give, and saved scenarios. Read-only.' },
  { id: 'exports', glyph: '↧', label: 'Export', does: 'Writes DXF, XLSX, PNG, PDF and GLB of the plan as drawn.' },
];

export default function App(): React.ReactElement {
  const status = useSite((s) => s.status);
  const error = useSite((s) => s.error);
  const load = useSite((s) => s.load);
  const viewMode = useSite((s) => s.viewMode);
  const setViewMode = useSite((s) => s.setViewMode);
  const { section, leftOpen, rightOpen, setSection, toggleLeft, toggleRight } = useUi();

  const rules = useRules();
  const switches = useSettings((s) => s.switches);
  const overrides = useSettings((s) => s.overrides);
  const zoneEdits = useZoneEdit((s) => s.edits);
  const sitingResult = useSiting((s) => s.result);
  const sitingActive = useSiting((s) => s.activeIndex);
  const { plan, chosen } = useMasterPlan();
  const goal = useGoal((s) => s.goal);
  const markSolved = useGoal((s) => s.markSolved);
  const zoneUses = useZoneUses();

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * What has changed since the plan was drawn. A heavy solve is fine; being
   * unsure whether the drawing answers the current settings is not.
   */
  const solvedRef = useRef<string | null>(null);
  const [staleReasons, setStaleReasons] = useState<string[]>([]);
  const fingerprint = useMemo(
    () =>
      JSON.stringify({
        switches,
        overrides,
        zoneEdits,
        zoneUses,
        siting: sitingResult?.alternatives[sitingActive]?.id ?? null,
      }),
    [switches, overrides, zoneEdits, zoneUses, sitingResult, sitingActive],
  );
  const parts = useMemo(
    () => ({
      'the massing levers': JSON.stringify(switches),
      'a rule override': JSON.stringify(overrides),
      'the zoning': JSON.stringify(zoneEdits),
      'what goes where': JSON.stringify(zoneUses),
    }),
    [switches, overrides, zoneEdits, zoneUses],
  );
  const solvedParts = useRef<Record<string, string>>({});

  useEffect(() => {
    if (solvedRef.current === null) return;
    const changed = Object.entries(parts)
      .filter(([k, v]) => solvedParts.current[k] !== undefined && solvedParts.current[k] !== v)
      .map(([k]) => k);
    setStaleReasons(changed);
  }, [parts]);

  const solve = (): void => {
    if (!rules) return;
    const fsiTiers = coverageFsi(rules.kmbr, 'A1').fsiTiers;
    runMasterPlanGeneration(
      overrides,
      {
        zoneUses,
        sitingLabel: sitingResult?.alternatives[sitingActive]?.label ?? 'zone names (siting not run)',
        chosen,
        minSideApplies: switches.minSideApplies,
        directions: switches.roadAngleCandidates,
        fsi: fsiTiers[switches.fsiTierIndex] ?? fsiTiers[0] ?? 3,
        floorOptions: switches.towerFloorOptions,
        apartmentMix: switches.apartmentMix,
        flatsPerFloor: switches.flatsPerFloor,
        runId: (plan?.runId ?? 0) + 1,
        goal,
      },
      zoneEdits,
    );
    solvedRef.current = fingerprint;
    solvedParts.current = { ...parts };
    setStaleReasons([]);
    markSolved(goal);
  };

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

      {/* title and view mode */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3">
        <GlassPanel className="pointer-events-auto px-3 py-1.5">
          <h1 className="text-[12px] font-semibold text-fg">Mangalapuram Township Planner</h1>
          <p className="text-[10px] text-muted">73.54 ac · KMBR 2019 (amended 2023) + 2025</p>
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
            {status === 'ready' && 'ready'}
          </span>
        </GlassPanel>
      </div>

      {/* the rail, and whatever it opened */}
      <div className="pointer-events-none absolute bottom-40 left-0 top-16 z-10 flex items-start gap-2 p-3">
        <IconRail
          items={RAIL}
          active={section}
          onPick={(id) => setSection(id as never)}
        />
        {section && leftOpen && (
          <GlassPanel className="pointer-events-auto flex max-h-full w-[330px] flex-col">
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wider text-fg">
                {RAIL.find((r) => r.id === section)?.label}
              </span>
              <button
                type="button"
                onClick={() => setSection(section)}
                className="px-1 text-[11px] text-muted hover:text-fg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="border-b border-line/70 px-3 py-1.5 text-[10px] leading-snug text-muted">
              {RAIL.find((r) => r.id === section)?.does}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto pt-1">
              {status !== 'ready' ? (
                <div className="p-3 text-muted">
                  {status === 'error' ? <span className="text-bad">{error}</span> : 'Loading site data…'}
                </div>
              ) : (
                <SectionBody section={section} />
              )}
            </div>
          </GlassPanel>
        )}
        {!leftOpen && <EdgeTab label="Panels" side="left" onClick={toggleLeft} />}
      </div>

      {/* what the settings produce */}
      <div className="pointer-events-none absolute bottom-40 right-0 top-16 z-10 flex items-start justify-end p-3">
        {rightOpen ? (
          <GlassPanel className="pointer-events-auto flex max-h-full w-[250px] flex-col">
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

      {/* the levers, the solve state and the scenarios: always there */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-0 px-3 pb-0">
        <div className="pointer-events-auto w-full max-w-[1200px]">
          <GlassPanel className="mb-1 rounded-b-none border-b-0">
            <LeverStrip />
            <div className="border-t border-line/70">
              <SolveBar stale={staleReasons.length > 0} reasons={staleReasons} onSolve={solve} />
            </div>
          </GlassPanel>
        </div>
        <div className="pointer-events-none w-full max-w-[1200px]">
          <ScenarioDock />
        </div>
      </div>
    </div>
  );
}

function SectionBody({ section }: { section: string }): React.ReactElement {
  switch (section) {
    case 'goal':
      return <GoalPanel />;
    case 'site':
      return <SitePanel />;
    case 'zones':
      return <ZoneEditPanel />;
    case 'siting':
      return <SitingPanel />;
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
