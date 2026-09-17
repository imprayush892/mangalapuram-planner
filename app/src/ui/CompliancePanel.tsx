import { useMemo } from 'react';
import { useRules } from '../state/useRules';
import { useLayout } from '../state/layoutStore';
import { openItems, ruleConflicts } from '../engine/rules/conflicts';
import type { Finding } from '../engine/rules/findings';
import { countByStatus } from '../engine/rules/findings';
import { Panel, Row, StatusDot } from './primitives';

export default function CompliancePanel(): React.ReactElement {
  const rules = useRules();
  const options = useLayout((s) => s.options);
  const activeIndex = useLayout((s) => s.activeOptionIndex);
  const active = options[activeIndex] ?? null;

  const conflicts = useMemo(() => (rules ? ruleConflicts(rules.client, rules.kmbr) : []), [rules]);
  const items = useMemo(() => (rules ? openItems(rules.client, rules.assumptions) : []), [rules]);

  if (!rules) return <div className="p-3 text-muted">Loading rules…</div>;

  const layoutFindings = active?.findings ?? [];
  const counts = countByStatus(layoutFindings);

  return (
    <>
      <Panel title={active ? `Layout compliance — ${active.zoneName}` : 'Layout compliance'}>
        {active ? (
          <>
            <div className="mb-2 flex gap-3 text-[11px]">
              <span className="flex items-center gap-1">
                <StatusDot status="pass" /> {counts.pass} pass
              </span>
              <span className="flex items-center gap-1">
                <StatusDot status="warn" /> {counts.warn} warn
              </span>
              <span className="flex items-center gap-1">
                <StatusDot status="fail" /> {counts.fail} fail
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {layoutFindings.map((f) => (
                <FindingCard key={f.id + (f.subjectId ?? '')} finding={f} />
              ))}
            </div>
          </>
        ) : (
          <p className="text-[11px] text-muted">
            Generate a zone layout to see its compliance against KMBR and the client rules.
          </p>
        )}
      </Panel>

      <Panel title="Client rules against KMBR">
        <p className="pb-2 text-[11px] leading-snug text-muted">
          Where the two differ, both values are shown and the stricter one decides compliance. The client's first cut
          is never silently changed.
        </p>
        <div className="flex flex-col gap-1.5">
          {conflicts.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      </Panel>

      <Panel title="Open items (defaults in use)">
        {items.map((i) => (
          <Row key={i.key} label={i.label} value={i.value} hint={`${i.reference} — ${i.alternatives.join('; ')}`} />
        ))}
        <p className="pt-2 text-[11px] leading-snug text-muted">
          These are switches, not blocking questions. Hover a row to see the alternatives and where the value comes
          from.
        </p>
      </Panel>
    </>
  );
}

export function FindingCard({ finding }: { finding: Finding }): React.ReactElement {
  return (
    <div className="rounded border border-line px-2 py-1.5">
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <StatusDot status={finding.status} />
        </span>
        <div className="min-w-0">
          <div className="font-medium text-fg">{finding.title}</div>
          <div className="text-[11px] text-muted">{finding.reference}</div>
          <p className="mt-1 text-[11px] leading-snug text-muted">{finding.detail}</p>
          {finding.conflict && (
            <div className="num mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 rounded bg-panel-2 px-2 py-1 text-[11px]">
              <span className="text-muted">Client</span>
              <span className="text-fg">{finding.conflict.clientValue}</span>
              <span className="text-muted">KMBR</span>
              <span className="text-fg">{finding.conflict.kmbrValue}</span>
              <span className="text-muted">Applied</span>
              <span className={finding.conflict.appliedBy === 'KMBR' ? 'text-accent' : 'text-warn'}>
                {finding.conflict.applied} ({finding.conflict.appliedBy})
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
