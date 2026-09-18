import { useMemo } from 'react';
import { Button, Panel, Row } from './primitives';
import { useSite } from '../state/store';
import { useEditedSite } from '../state/useEditedSite';
import { useZoneEdit, pendingRing } from '../state/zoneEditStore';
import { useSiting } from '../state/sitingStore';
import { useMasterPlan } from '../state/masterPlanStore';
import { applyZoneEdits, unzonedLand, validateZones } from '../engine/site/zoneEdit';

const TOOL_HELP: Record<string, string> = {
  none: 'Pick a tool, then work on the plan.',
  split: 'Click twice on the plan to draw a line across a zone. The line is extended to cut the whole zone, not only where you dragged.',
  draw: 'Click around the new zone, then close it. It takes only land no other zone holds.',
  merge: 'Click two or more zones on the plan, then merge them.',
};

export default function ZoneEditPanel(): React.ReactElement {
  const loaded = useSite((s) => s.site);
  const site = useEditedSite();
  const selectedZoneId = useSite((s) => s.selectedZoneId);
  const { edits, tool, pending, selected, setTool, clearPending, push, undo, reset } = useZoneEdit();
  const clearSiting = useSiting((s) => s.clear);
  const clearPlan = useMasterPlan((s) => s.clear);

  const outcome = useMemo(
    () => (loaded ? applyZoneEdits(loaded.zones, edits) : null),
    [loaded, edits],
  );
  const validity = useMemo(
    () => (site ? validateZones(site.zones, site.parcel) : []),
    [site],
  );
  const unzoned = useMemo(() => (site ? unzonedLand(site.zones, site.parcel) : null), [site]);

  if (!site || !loaded) return <div className="p-3 text-muted">Loading…</div>;

  const invalid = validity.filter((v) => !v.ok);

  /** Any edit invalidates the siting and the plan built on the old zones. */
  const afterEdit = (): void => {
    clearSiting();
    clearPlan();
  };

  const commitSplit = (): void => {
    if (pending.length < 2 || !selectedZoneId) return;
    push({ kind: 'split', zoneId: selectedZoneId, line: [pending[0]!, pending[pending.length - 1]!] });
    afterEdit();
  };

  const commitDraw = (): void => {
    const ring = pendingRing(pending);
    if (!ring) return;
    push({ kind: 'create', id: `drawn-${edits.length + 1}`, name: `New zone ${edits.length + 1}`, ring });
    afterEdit();
  };

  const commitMerge = (): void => {
    if (selected.length < 2) return;
    push({ kind: 'merge', zoneIds: [...selected] });
    afterEdit();
  };

  return (
    <>
      <Panel
        title="Edit the zoning plan"
        right={
          edits.length > 0 ? (
            <span className="flex gap-1">
              <Button onClick={() => { undo(); afterEdit(); }}>Undo</Button>
              <Button onClick={() => { reset(); afterEdit(); }}>Reset</Button>
            </span>
          ) : undefined
        }
      >
        <p className="text-[11px] leading-snug text-muted">
          The client's zoning plan is the starting point, not a fixed input. Split, merge or draw a zone and every
          engine follows: the siting scores, the layouts, the plan, the 3D view and the exports.
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {(['split', 'draw', 'merge'] as const).map((t) => (
            <Button key={t} tone={tool === t ? 'primary' : 'default'} onClick={() => setTool(tool === t ? 'none' : t)}>
              {t === 'split' ? 'Split a zone' : t === 'draw' ? 'Draw a zone' : 'Merge zones'}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-muted">{TOOL_HELP[tool]}</p>

        {tool === 'split' && (
          <div className="mt-2">
            <Row label="Zone to cut" value={site.zones.find((z) => z.id === selectedZoneId)?.name ?? 'none picked'} />
            <Row label="Points" value={`${pending.length} / 2`} />
            <div className="mt-1 flex gap-1">
              <Button tone="primary" onClick={commitSplit} disabled={pending.length < 2 || !selectedZoneId}>
                Cut it
              </Button>
              <Button onClick={clearPending} disabled={pending.length === 0}>
                Clear points
              </Button>
            </div>
          </div>
        )}

        {tool === 'draw' && (
          <div className="mt-2">
            <Row label="Points" value={`${pending.length} (3 or more)`} />
            <div className="mt-1 flex gap-1">
              <Button tone="primary" onClick={commitDraw} disabled={pending.length < 3}>
                Close and add
              </Button>
              <Button onClick={clearPending} disabled={pending.length === 0}>
                Clear points
              </Button>
            </div>
          </div>
        )}

        {tool === 'merge' && (
          <div className="mt-2">
            <Row
              label="Picked"
              value={selected.length === 0 ? 'none' : `${selected.length} zones`}
              hint={selected.map((id) => site.zones.find((z) => z.id === id)?.name ?? id).join(', ')}
            />
            <Button tone="primary" onClick={commitMerge} disabled={selected.length < 2} className="mt-1">
              Merge them
            </Button>
          </div>
        )}
      </Panel>

      <Panel title="Where the land stands">
        <Row label="Zones" value={site.zones.length} hint={`${loaded.zones.length} in the client plan`} />
        <Row
          label="Zoned land"
          value={`${site.zones.reduce((s, z) => s + z.computedInScopeAc, 0).toFixed(2)} ac`}
        />
        <Row
          label="Unzoned"
          value={`${unzoned?.areaAc.toFixed(2) ?? '—'} ac`}
          hint="in-scope parcel land no zone holds; nothing is generated on it"
        />
        {invalid.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-warn">Zones that will not plan cleanly</div>
            {invalid.map((v) => (
              <div key={v.zoneId} className="py-0.5 text-[11px] leading-snug text-warn">
                {site.zones.find((z) => z.id === v.zoneId)?.name ?? v.zoneId}: {v.reasons.join('; ')}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {outcome && outcome.notes.length > 0 && (
        <Panel title="What each edit did">
          {outcome.notes.map((n, i) => (
            <div key={i} className="py-0.5 text-[11px] leading-snug text-muted">
              {i + 1}. {n}
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
