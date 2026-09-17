import { useMemo } from 'react';
import { useRules } from '../state/useRules';
import { loadProgramme } from '../engine/rules/programme';
import type { ProgrammeLine } from '../engine/rules/programme';
import { Panel, Row } from './primitives';

const USE_LABEL: Record<string, string> = {
  apartments: 'Apartments',
  villas: 'Villas',
  senior: 'Senior living',
  school: 'School',
  hospital: 'Hospital',
  club: 'Club',
  commercial: 'Commercial',
  hotel: 'Hotel',
  convention: 'Convention',
  office: 'Business hub',
};

const fmt = (n: number, dp = 0): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ProgrammePanel(): React.ReactElement {
  const rules = useRules();
  const programme = useMemo(
    () => (rules ? loadProgramme(rules.programme, rules.client, rules.kmbr, rules.assumptions) : null),
    [rules],
  );

  if (!programme) return <div className="p-3 text-muted">Loading programme…</div>;

  return (
    <>
      <Panel title="Programme against the land in scope">
        <Row label="In scope" value={`${programme.inScopeAc.toFixed(2)} ac`} hint="programme.yaml scope.in_scope_land_ac" />
        <Row label="Programme asks for" value={`${programme.demandedAc.toFixed(1)} ac`} />
        <Row
          label="Shortfall"
          value={
            <span className={programme.shortfallAc > 0 ? 'text-bad' : 'text-good'}>
              {programme.shortfallAc > 0 ? '+' : ''}
              {programme.shortfallAc.toFixed(1)} ac
            </span>
          }
        />
        <Row label="Deferred (hospital)" value={`${programme.deferredDemandAc.toFixed(1)} ac`} />
        <div className="mt-2 space-y-1.5">
          {programme.notes.map((n) => (
            <p key={n} className="text-[11px] leading-snug text-muted">
              {n}
            </p>
          ))}
        </div>
      </Panel>

      <Panel title="Totals">
        <Row label="Units (in scope)" value={fmt(programme.totalUnits)} />
        <Row label="Plinth" value={`${fmt(programme.totalPlinthSft)} sft`} />
        <Row label="SBUA" value={`${fmt(programme.totalSbuaSft)} sft`} hint="client point 9 definitions" />
        <Row label="Population at build-out" value={fmt(Math.round(programme.population))} />
        <Row label="Client target now" value={fmt(programme.populationTargetNow)} />
        <Row label="Final capacity to allow for" value={fmt(programme.populationFinalCapacity)} />
        <Row label="Car parking (KMBR)" value={fmt(programme.totalParkingCars)} />
      </Panel>

      <Panel title="Lines">
        <div className="flex flex-col gap-1.5">
          {programme.lines.map((line) => (
            <LineCard key={line.id} line={line} />
          ))}
        </div>
      </Panel>
    </>
  );
}

function LineCard({ line }: { line: ProgrammeLine }): React.ReactElement {
  return (
    <div className={`rounded border border-line px-2 py-1.5 ${line.deferred ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-fg">
          {USE_LABEL[line.use] ?? line.use}
          {line.isAssumption && (
            <span className="ml-1 text-warn" title="educated assumption, editable">
              ·assumed
            </span>
          )}
          {line.deferred && <span className="ml-1 text-muted">·deferred</span>}
        </span>
        <span className="num shrink-0 text-muted">{line.landAc.toFixed(1)} ac</span>
      </div>
      <div className="num mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
        {line.units > 0 && <span>{fmt(line.units)} units</span>}
        {line.plinthSftPerUnit > 0 && <span>{fmt(line.plinthSftPerUnit)} sft plinth each</span>}
        <span>{fmt(line.totalPlinthSft)} sft total</span>
        {line.sbuaSftPerUnit > 0 && <span>SBUA {fmt(Math.round(line.sbuaSftPerUnit))} sft</span>}
        <span title={`KMBR Table 6 · ${line.occupancyRaw}`}>
          {line.occupancy} · cover {line.coveragePct}% · FSI {line.fsiFree}
        </span>
        <span title="KMBR Tables 9 / 10 plus visitor parking">{fmt(line.parkingCars)} cars</span>
        <span title="KMBR Tables 7 / 8">access {line.accessWidthM} m</span>
        {line.dtpApproval && <span className="text-warn">DTP approval (Table 11)</span>}
      </div>
      {line.notes.map((n) => (
        <p key={n} className="mt-1 text-[11px] leading-snug text-muted">
          {n}
        </p>
      ))}
    </div>
  );
}
