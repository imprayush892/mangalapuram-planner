import { useState } from 'react';
import { useDock, compareScenarios } from '../state/scenarioDock';
import { useSettings } from '../state/settingsStore';
import { useSiting } from '../state/sitingStore';
import { useZoneEdit } from '../state/zoneEditStore';
import { useMasterPlan } from '../state/masterPlanStore';
import { useLiveMetrics } from '../state/useLiveMetrics';
import { useUi, snapshotCanvas } from '../state/uiStore';

/**
 * The snapshot gallery.
 *
 * Fifty variations in five minutes makes remembering them the real problem, so
 * a scenario keeps everything needed to go back to it — the switches, the rule
 * overrides, the zone edits, the siting choice — beside a thumbnail of the view
 * and the figures at that moment. Two can be put side by side without restoring
 * either, and only the rows that differ are marked.
 */
export default function ScenarioDock(): React.ReactElement {
  const { scenarios, compare, save, remove, toggleCompare, clearCompare } = useDock();
  const switches = useSettings((s) => s.switches);
  const overrides = useSettings((s) => s.overrides);
  const loadSnapshot = useSettings((s) => s.loadSnapshot);
  const sitingResult = useSiting((s) => s.result);
  const sitingIndex = useSiting((s) => s.activeIndex);
  const setSitingActive = useSiting((s) => s.setActive);
  const zoneEdits = useZoneEdit((s) => s.edits);
  const resetEdits = useZoneEdit((s) => s.reset);
  const plan = useMasterPlan((s) => s.plan);
  const metrics = useLiveMetrics();
  const dockOpen = useUi((s) => s.dockOpen);
  const toggleDock = useUi((s) => s.toggleDock);
  const [showCompare, setShowCompare] = useState(false);

  const take = (): void => {
    if (!metrics) return;
    save({
      name: `Scenario ${String.fromCharCode(65 + scenarios.length)}`,
      thumbnail: snapshotCanvas(),
      switches,
      overrides,
      zoneEdits: [...zoneEdits],
      sitingIndex,
      sitingLabel: sitingResult?.alternatives[sitingIndex]?.label ?? '—',
      metrics,
      built: Boolean(plan),
    });
  };

  const restore = (id: string): void => {
    const sc = scenarios.find((s) => s.id === id);
    if (!sc) return;
    loadSnapshot(sc.overrides, sc.switches);
    setSitingActive(sc.sitingIndex);
    // Zone edits are replayed from the snapshot, not merged into what is there.
    resetEdits();
    for (const edit of sc.zoneEdits) useZoneEdit.getState().push(edit);
  };

  const [a, b] = compare.map((id) => scenarios.find((s) => s.id === id));
  const rows = a && b ? compareScenarios(a, b) : [];

  if (!dockOpen) {
    return (
      <button
        type="button"
        onClick={toggleDock}
        className="pointer-events-auto rounded-t-lg border border-b-0 border-line/80 bg-panel/85 px-3 py-1 text-[10px] uppercase tracking-wider text-muted shadow-lg backdrop-blur-md transition hover:text-fg"
      >
        Scenarios {scenarios.length > 0 && `(${scenarios.length})`}
      </button>
    );
  }

  return (
    <div className="pointer-events-auto w-full rounded-t-lg border border-b-0 border-line/80 bg-panel/85 shadow-[0_-8px_30px_rgba(0,0,0,0.45)] backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted">
          Scenarios {scenarios.length > 0 && `· ${scenarios.length}`}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={take}
            disabled={!metrics}
            className="rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-[11px] text-accent disabled:opacity-40"
          >
            Save this one
          </button>
          {compare.length === 2 && (
            <button
              type="button"
              onClick={() => setShowCompare(!showCompare)}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-fg hover:bg-panel-2"
            >
              {showCompare ? 'Hide' : 'Compare'}
            </button>
          )}
          {compare.length > 0 && (
            <button
              type="button"
              onClick={() => { clearCompare(); setShowCompare(false); }}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
            >
              Clear
            </button>
          )}
          <button type="button" onClick={toggleDock} className="px-1 text-[11px] text-muted hover:text-fg">
            ▾
          </button>
        </span>
      </div>

      {showCompare && a && b && (
        <div className="border-t border-line px-3 py-2">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-0.5 text-[11px]">
            <span className="text-[10px] uppercase tracking-wider text-muted">Metric</span>
            <span className="num text-right text-[10px] uppercase tracking-wider text-accent">{a.name}</span>
            <span className="num text-right text-[10px] uppercase tracking-wider text-accent">{b.name}</span>
            {rows.map((r) => (
              <>
                <span key={`${r.label}-l`} className={r.changed ? 'text-fg' : 'text-muted'}>
                  {r.label}
                </span>
                <span key={`${r.label}-a`} className={`num text-right ${r.changed ? 'text-fg' : 'text-muted'}`}>
                  {r.a}
                </span>
                <span key={`${r.label}-b`} className={`num text-right ${r.changed ? 'text-good' : 'text-muted'}`}>
                  {r.b}
                </span>
              </>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto border-t border-line px-3 py-2">
        {scenarios.length === 0 && (
          <p className="py-3 text-[11px] text-muted">
            Nothing saved yet. Change the levers, then save the ones worth keeping and put two side by side.
          </p>
        )}
        {scenarios.map((sc) => {
          const picked = compare.includes(sc.id);
          return (
            <div
              key={sc.id}
              className={`w-40 shrink-0 rounded border p-1.5 transition ${
                picked ? 'border-accent/70 bg-accent/10' : 'border-line bg-panel-2/60'
              }`}
            >
              <button type="button" onClick={() => toggleCompare(sc.id)} className="block w-full text-left">
                {sc.thumbnail ? (
                  <img src={sc.thumbnail} alt="" className="mb-1 h-16 w-full rounded object-cover" />
                ) : (
                  <div className="mb-1 flex h-16 w-full items-center justify-center rounded bg-ink text-[10px] text-muted">
                    no preview
                  </div>
                )}
                <div className="truncate text-[11px] text-fg">{sc.name}</div>
                <div className="num text-[10px] text-muted">
                  {sc.metrics.dwellings.toLocaleString('en-IN')} dwellings · FSI {sc.metrics.fsi.toFixed(2)}
                </div>
                <div className="truncate text-[10px] text-muted">{sc.sitingLabel}</div>
              </button>
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  onClick={() => restore(sc.id)}
                  className="flex-1 rounded border border-line px-1 py-0.5 text-[10px] text-muted hover:text-fg"
                >
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => remove(sc.id)}
                  className="rounded border border-line px-1 py-0.5 text-[10px] text-muted hover:text-bad"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
