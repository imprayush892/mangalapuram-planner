import { useSite } from '../state/store';
import { useSettings } from '../state/settingsStore';
import { useRules } from '../state/useRules';
import { Button, Check, NumberField, Panel, Row, Select } from './primitives';
import { countOverrides } from '../engine/data/overrides';
import { pick } from '../engine/data/config';
import { coverageFsi } from '../engine/rules/kmbr';
import type { BandName, MinSideApplies } from '../engine/rules/client';
import { allowedMixes } from '../engine/rules/client';

export default function RulesPanel(): React.ReactElement {
  const base = useSite((s) => s.config);
  const rules = useRules();
  const { overrides, switches, setOverride, resetOverrides, setSwitch } = useSettings();

  if (!rules || !base) return <div className="p-3 text-muted">Loading rules…</div>;

  const fsiTiers = coverageFsi(rules.kmbr, 'A1').fsiTiers;
  const mixes = allowedMixes(rules.client);
  const changed = countOverrides(overrides);

  const clientNum = (path: string, fallback: number): number => pick<number>(rules.client, path, fallback);
  const assumeNum = (path: string, fallback: number): number => pick<number>(rules.assumptions, path, fallback);

  return (
    <>
      <Panel
        title="Design switches"
        right={
          changed > 0 ? (
            <Button onClick={resetOverrides}>Reset {changed} edit{changed === 1 ? '' : 's'}</Button>
          ) : undefined
        }
      >
        <Select
          label="FSI tier (KMBR Table 6 A1)"
          value={String(switches.fsiTierIndex)}
          options={fsiTiers.map((f, i) => ({
            value: String(i),
            label: `${f}${i === 0 ? ' — free' : i === 1 ? ' — Rs 5,000/m² fee' : ' — Rs 7,500/m² fee'}`,
          }))}
          onChange={(v) => setSwitch('fsiTierIndex', Number(v))}
        />
        <Select
          label="18 m minimum applies to"
          value={switches.minSideApplies}
          options={[
            { value: 'long_side' as MinSideApplies, label: 'long side (min plot 129.6 m²)' },
            { value: 'both_sides' as MinSideApplies, label: 'both sides (min plot 324 m²)' },
          ]}
          onChange={(v) => setSwitch('minSideApplies', v)}
        />
        <Select
          label="Apartment mix"
          value={switches.apartmentMix.join('+')}
          options={mixes.map((m) => ({ value: m.join('+'), label: m.join(' + ') }))}
          onChange={(v) => setSwitch('apartmentMix', v.split('+') as BandName[])}
        />
        <NumberField
          label="Flats per floor"
          value={switches.flatsPerFloor}
          min={4}
          max={6}
          onChange={(v) => setSwitch('flatsPerFloor', v)}
          hint="client rule: 4 to 6"
        />
        <NumberField
          label="Tower floors"
          value={switches.towerFloors}
          min={1}
          max={20}
          onChange={(v) => setSwitch('towerFloors', v)}
          hint="client cap 20 floors / 70 m"
        />
      </Panel>

      <Panel title="Client rules (govern the first cut)">
        <p className="pb-1.5 text-[11px] leading-snug text-muted">
          Edits here override config/client_rules.yaml for this scenario. The file on disk is never changed; the
          scenario records what you changed.
        </p>
        <NumberField
          label="Roads share"
          value={clientNum('villa_and_senior_land_split.roads', 0.2)}
          step={0.01}
          suffix="×"
          onChange={(v) => setOverride('client', 'villa_and_senior_land_split.roads', v)}
        />
        <NumberField
          label="Open space share"
          value={clientNum('villa_and_senior_land_split.open_space', 0.3)}
          step={0.01}
          suffix="×"
          onChange={(v) => setOverride('client', 'villa_and_senior_land_split.open_space', v)}
        />
        <NumberField
          label="Saleable share"
          value={clientNum('villa_and_senior_land_split.saleable', 0.5)}
          step={0.01}
          suffix="×"
          onChange={(v) => setOverride('client', 'villa_and_senior_land_split.saleable', v)}
        />
        <NumberField
          label="Minimum plot side"
          value={clientNum('villa_plots.min_side_m', 18)}
          suffix="m"
          onChange={(v) => setOverride('client', 'villa_plots.min_side_m', v)}
        />
        <NumberField
          label="Max plot aspect"
          value={clientNum('villa_plots.aspect_ratio.max', 2.5)}
          step={0.1}
          suffix=":1"
          onChange={(v) => setOverride('client', 'villa_plots.aspect_ratio.max', v)}
        />
        <NumberField
          label="Internal road width"
          value={clientNum('roads.internal.width_m', 6)}
          step={0.5}
          suffix="m"
          onChange={(v) => setOverride('client', 'roads.internal.width_m', v)}
        />
        <NumberField
          label="Public road width"
          value={clientNum('roads.public.width_m', 10)}
          step={0.5}
          suffix="m"
          onChange={(v) => setOverride('client', 'roads.public.width_m', v)}
        />
        <NumberField
          label="Spine width"
          value={clientNum('roads.main_spine.width_m', 18)}
          step={0.5}
          suffix="m"
          onChange={(v) => setOverride('client', 'roads.main_spine.width_m', v)}
        />
        <NumberField
          label="Front setback"
          value={clientNum('setbacks_client.front_m', 2)}
          step={0.1}
          suffix="m"
          onChange={(v) => setOverride('client', 'setbacks_client.front_m', v)}
        />
        <NumberField
          label="Rear setback"
          value={clientNum('setbacks_client.rear_m', 1.5)}
          step={0.1}
          suffix="m"
          onChange={(v) => setOverride('client', 'setbacks_client.rear_m', v)}
        />
        <NumberField
          label="Side setback (each)"
          value={clientNum('setbacks_client.side_m_each', 1)}
          step={0.1}
          suffix="m"
          onChange={(v) => setOverride('client', 'setbacks_client.side_m_each', v)}
        />
        <NumberField
          label="Villa footprint share of plot"
          value={clientNum('villa_plots.footprint_placeholder.share_of_plot_area', 0.45)}
          step={0.01}
          suffix="×"
          onChange={(v) => setOverride('client', 'villa_plots.footprint_placeholder.share_of_plot_area', v)}
        />
        <NumberField
          label="Minimum tower spacing"
          value={clientNum('apartments.spacing.min_clear_m', 12)}
          suffix="m"
          onChange={(v) => setOverride('client', 'apartments.spacing.min_clear_m', v)}
        />
        <NumberField
          label="Core share of footprint"
          value={clientNum('apartments.core_share_of_footprint', 0.2)}
          step={0.05}
          suffix="×"
          onChange={(v) => {
            setOverride('client', 'apartments.core_share_of_footprint', v);
            setOverride('client', 'apartments.flats_share_of_footprint', Number((1 - v).toFixed(3)));
          }}
        />
      </Panel>

      <Panel title="Assumptions">
        <p className="pb-1.5 text-[11px] leading-snug text-muted">
          Every value here is an assumption, not a client instruction or a regulation. Reported numbers cite the key
          they came from.
        </p>
        <NumberField
          label="Household size (family)"
          value={assumeNum('household_size_family', 3.5)}
          step={0.1}
          onChange={(v) => setOverride('assumptions', 'household_size_family', v)}
        />
        <NumberField
          label="Household size (senior)"
          value={assumeNum('household_size_senior', 1.6)}
          step={0.1}
          onChange={(v) => setOverride('assumptions', 'household_size_senior', v)}
        />
        <NumberField
          label="Parking, gross per car"
          value={assumeNum('parking_gross_m2_per_car', 30)}
          suffix="m²"
          onChange={(v) => setOverride('assumptions', 'parking_gross_m2_per_car', v)}
        />
        <NumberField
          label="Floor to floor (apartments)"
          value={assumeNum('floor_to_floor_m.apartments', 3)}
          step={0.1}
          suffix="m"
          onChange={(v) => setOverride('assumptions', 'floor_to_floor_m.apartments', v)}
        />
        <NumberField
          label="Hotel, gross per key"
          value={assumeNum('hotel_gross_sft_per_key', 1000)}
          step={50}
          suffix="sft"
          onChange={(v) => setOverride('assumptions', 'hotel_gross_sft_per_key', v)}
        />
        <Check
          label="Towers sprinklered (travel distance 45 m, not 30 m)"
          checked={pick<boolean>(rules.assumptions, 'sprinklered_towers', true)}
          onChange={(v) => setOverride('assumptions', 'sprinklered_towers', v)}
        />
        <AaiCap />
      </Panel>

      <Panel title="Plot fall thresholds (assumption)">
        {(['build_as_drawn', 'absorb_in_plinth', 'stepped_plinth', 'split_level'] as const).map((key) => (
          <NumberField
            key={key}
            label={key.replace(/_/g, ' ')}
            value={assumeNum(`plot_fall_thresholds_m.${key}`, 0)}
            step={0.1}
            suffix="m"
            onChange={(v) => setOverride('assumptions', `plot_fall_thresholds_m.${key}`, v)}
          />
        ))}
      </Panel>

      <Panel title="Regulation (read-only here)">
        <Row label="KMBR version" value={String(rules.kmbr.version)} />
        <Row label="Client rules version" value={String(rules.client.version)} />
        <p className="pt-1.5 text-[11px] leading-snug text-muted">
          KMBR values are read from config/kmbr_rules.yaml with clause references. A value that is missing there stops
          the engine rather than being guessed — add it to the YAML with its clause and verified status.
        </p>
      </Panel>
    </>
  );
}

function AaiCap(): React.ReactElement {
  const rules = useRules();
  const setOverride = useSettings((s) => s.setOverride);
  const current = pick<number | null>(rules?.assumptions ?? {}, 'aai_height_cap_m', null);
  return (
    <div className="pt-1">
      <Check
        label="AAI height cap known"
        checked={current !== null}
        onChange={(v) => setOverride('assumptions', 'aai_height_cap_m', v ? 70 : null)}
      />
      {current !== null && (
        <NumberField
          label="AAI cap"
          value={current}
          suffix="m"
          onChange={(v) => setOverride('assumptions', 'aai_height_cap_m', v)}
          hint="site is within 20 km of the airport; NOC required"
        />
      )}
    </div>
  );
}
