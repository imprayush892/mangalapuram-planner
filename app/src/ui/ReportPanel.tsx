import { useMemo, useRef, useState } from 'react';
import { useSite } from '../state/store';
import { useLayout } from '../state/layoutStore';
import { useSettings } from '../state/settingsStore';
import { useRules } from '../state/useRules';
import { Button, Panel, Row } from './primitives';
import { FindingCard } from './CompliancePanel';
import { loadProgramme } from '../engine/rules/programme';
import { runLevel1, USE_LABEL } from '../engine/site/level1';
import type { UseBalance } from '../engine/site/level1';
import { pick } from '../engine/data/config';
import { buildScenario, parseScenario, scenarioFileName } from '../engine/scenario';
import { activeZoneUses, useSiting } from '../state/sitingStore';
import type { Scenario } from '../engine/scenario';

const fmt = (n: number, dp = 0): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

export default function ReportPanel(): React.ReactElement {
  const site = useSite((s) => s.site);
  const rules = useRules();
  const { byZone, activeOptionIndex, setOptions } = useLayout();
  const sitingResult = useSiting((s) => s.result);
  const sitingActive = useSiting((s) => s.activeIndex);
  const { overrides, switches, loadSnapshot } = useSettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const [scenarioName, setScenarioName] = useState('Scenario 1');
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; lines: string[] } | null>(null);

  const programme = useMemo(
    () => (rules ? loadProgramme(rules.programme, rules.client, rules.kmbr, rules.assumptions) : null),
    [rules],
  );

  const level1 = useMemo(() => {
    if (!site || !programme || !rules) return null;
    return runLevel1({
      zones: site.zones,
      parcel: site.parcel,
      programme,
      generated: byZone,
      householdSizes: {
        family: pick<number>(rules.assumptions, 'household_size_family', 3.5),
        senior: pick<number>(rules.assumptions, 'household_size_senior', 1.6),
      },
      // Follow the siting engine where it has run; otherwise the use is
      // inferred from the client zoning plan's own zone names.
      zoneUses: activeZoneUses({ result: sitingResult, activeIndex: sitingActive }),
    });
  }, [site, programme, rules, byZone, sitingResult, sitingActive]);

  if (!site || !rules || !programme || !level1) return <div className="p-3 text-muted">Loading…</div>;

  const configVersions = {
    kmbr: String(rules.kmbr.version),
    client: String(rules.client.version),
    programme: String(rules.programme.version),
  };

  const saveScenario = (): void => {
    const scenario = buildScenario({
      name: scenarioName,
      configVersions,
      overrides,
      switches: switches as unknown as Record<string, unknown>,
      zoneUses: Object.fromEntries(level1.assignments.map((a) => [a.zoneId, a.use])),
      layouts: Object.fromEntries(
        Object.entries(byZone).map(([id, options]) => [id, { options, chosen: activeOptionIndex }]),
      ),
    });
    const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = scenarioFileName(scenarioName);
    a.click();
    URL.revokeObjectURL(url);
    setMessage({ tone: 'ok', lines: [`Saved ${a.download} with the full input snapshot.`] });
  };

  const loadScenario = async (file: File): Promise<void> => {
    try {
      const { scenario, warnings } = parseScenario(await file.text(), configVersions);
      applyScenario(scenario);
      setMessage({
        tone: warnings.length > 0 ? 'bad' : 'ok',
        lines: [`Loaded "${scenario.name}", saved ${new Date(scenario.savedAt).toLocaleString()}.`, ...warnings],
      });
    } catch (err) {
      setMessage({ tone: 'bad', lines: [err instanceof Error ? err.message : String(err)] });
    }
  };

  const applyScenario = (scenario: Scenario): void => {
    // Unknown keys from an older scenario are ignored; known ones override the
    // current switches, so a scenario never leaves a switch undefined.
    loadSnapshot(scenario.overrides, { ...switches, ...(scenario.switches as Partial<typeof switches>) });
    for (const [zoneId, entry] of Object.entries(scenario.layouts)) {
      setOptions(zoneId, entry.options);
    }
  };

  return (
    <>
      <Panel title="Whole-site position">
        <Row label="Land in scope" value={`${level1.inScopeAc.toFixed(2)} ac`} />
        <Row label="Zoned by the client plan" value={`${level1.zonedAc.toFixed(2)} ac`} />
        <Row label="Unzoned" value={`${level1.unzonedAc.toFixed(2)} ac`} />
        <Row label="Programme asks for" value={`${level1.demandAc.toFixed(1)} ac`} />
        <Row
          label="Shortfall"
          value={
            <span className={level1.shortfallAc > 0 ? 'text-bad' : 'text-good'}>
              {level1.shortfallAc > 0 ? '+' : ''}
              {level1.shortfallAc.toFixed(1)} ac
            </span>
          }
        />
        <Row label="Units placed so far" value={fmt(level1.totalGeneratedUnits)} />
        <Row
          label="Population capacity placed"
          value={`${fmt(Math.round(level1.populationCapacity))} of ${fmt(level1.populationTarget)}`}
          hint={`final capacity to allow for: ${level1.populationFinalCapacity}`}
        />
      </Panel>

      <Panel title="Use by use">
        <div className="flex flex-col gap-1">
          {level1.balances.map((b) => (
            <BalanceRow key={b.use} balance={b} />
          ))}
        </div>
        <p className="pt-2 text-[11px] leading-snug text-muted">
          "Placed" counts the best option of each zone generated so far. Generate a zone in the Zone layout tab and it
          appears here.
        </p>
      </Panel>

      <Panel title="What has to give">
        <div className="flex flex-col gap-1.5">
          {level1.findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      </Panel>

      <Panel title="Scenario">
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-muted">Name</span>
          <input
            value={scenarioName}
            onChange={(e) => setScenarioName(e.target.value)}
            className="min-w-0 flex-1 rounded border border-line bg-panel-2 px-1.5 py-1 text-fg outline-none focus:border-accent"
          />
        </label>
        <div className="mt-1.5 flex gap-2">
          <Button tone="primary" onClick={saveScenario}>
            Save scenario
          </Button>
          <Button onClick={() => fileRef.current?.click()}>Load scenario</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void loadScenario(file);
              e.target.value = '';
            }}
          />
        </div>
        {message && (
          <div className={`mt-2 text-[11px] leading-snug ${message.tone === 'bad' ? 'text-warn' : 'text-muted'}`}>
            {message.lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        )}
        <p className="pt-2 text-[11px] leading-snug text-muted">
          A scenario records the rule and assumption edits, the design switches, the use on each zone and every
          generated option, with the config versions it was built against. Loading one that was saved before a rule
          changed says so rather than accepting it silently.
        </p>
        <Row label="KMBR rules" value={configVersions.kmbr} />
        <Row label="Client rules" value={configVersions.client} />
        <Row label="Programme" value={configVersions.programme} />
      </Panel>
    </>
  );
}

function BalanceRow({ balance }: { balance: UseBalance }): React.ReactElement {
  const landShort = balance.demandAc - balance.zonedAc;
  const unitsShort = balance.targetUnits - balance.generatedUnits;
  return (
    <div className={`rounded border border-line px-2 py-1.5 ${balance.deferred ? 'opacity-60' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-fg">
          {USE_LABEL[balance.use]}
          {balance.deferred && <span className="ml-1 text-muted">· deferred</span>}
        </span>
        <span className="num shrink-0 text-muted">
          {balance.zonedAc.toFixed(2)} / {balance.demandAc.toFixed(1)} ac
          {landShort > 0.5 && <span className="ml-1 text-warn">−{landShort.toFixed(1)}</span>}
        </span>
      </div>
      <div className="num flex flex-wrap gap-x-3 text-[11px] text-muted">
        {balance.targetUnits > 0 && (
          <span>
            {fmt(balance.generatedUnits)} / {fmt(balance.targetUnits)} units
            {unitsShort > 0 && balance.zonesGenerated > 0 && <span className="ml-1 text-warn">−{fmt(unitsShort)}</span>}
          </span>
        )}
        {balance.targetBuiltUpSft > 0 && balance.targetUnits === 0 && (
          <span>
            {fmt(Math.round(balance.generatedBuiltUpSft))} / {fmt(Math.round(balance.targetBuiltUpSft))} sft
          </span>
        )}
        <span>
          {balance.zonesGenerated} of {balance.zonesTotal} zones generated
        </span>
      </div>
    </div>
  );
}
