import type { AnalysisResult } from '../engine/pipeline/analysis';
import { Panel, Row } from './primitives';

const AC = 4046.8564224;
const m3 = (v: number): string => `${Math.round(v).toLocaleString()} m³`;
const m = (v: number, d = 2): string => `${v.toFixed(d)} m`;

/**
 * Where the planning storm's water goes, so the volumes can be checked
 * against each other: the day's rain split into loss, held and outflow, and
 * the water standing at the peak split into ponds and channels, each with its
 * area, depth and volume. Everything here adds up; the test suite checks it.
 */
export default function WaterBalancePanel({ analysis }: { analysis: AnalysisResult }): React.ReactElement {
  const w = analysis.storm.balance;
  const pk = w.peak;
  const counted = analysis.water;
  const c = analysis.storm.runoffCoeff;
  return (
    <Panel title={`Water balance · ${analysis.stormMm} mm day`}>
      <div className="flex flex-col gap-0.5 text-[11px]">
        <div className="text-[10px] text-muted">The day's water</div>
        <Row label="Rain on the site" value={m3(w.rainM3)} hint={`${analysis.stormMm} mm over the modelled ground`} />
        <Row label="Soaks in or is lost" value={m3(w.lossM3)} hint={`1 − C, with runoff coefficient C = ${c.toFixed(2)}`} />
        <Row label="Runs off" value={m3(w.runoffM3)} hint="rain × C" />
        <Row
          label="Held in ponds when it stops"
          value={m3(w.heldM3)}
          hint={`${m3(w.heldInPondsM3)} in ponds, ${m3(w.heldInShallowHollowsM3)} in shallow hollows`}
        />
        <Row label="Leaves the site" value={m3(w.outflowM3)} hint={`peak outflow ${pk.outflowM3s.toFixed(1)} m³/s`} />
        <Row label="Left over (runoff − held − outflow)" value={m3(w.closureM3)} hint="zero: no water made or lost" />

        <div className="mt-1.5 text-[10px] text-muted">Standing at the peak (at least 5 cm deep)</div>
        <Row
          label={`Ponds · ${w.ponds.length}`}
          value={`${(pk.pondAreaM2 / AC).toFixed(2)} ac × ${m(pk.pondMeanDepthM)} = ${m3(pk.pondVolumeM3)}`}
          hint={`area × mean depth; deepest ${m(pk.pondMaxDepthM)}`}
        />
        <Row
          label="Channels"
          value={`${Math.round(pk.channelLengthM).toLocaleString()} m × ${m(pk.channelMeanWidthM, 1)} × ${m(pk.channelMeanDepthM)} = ${m3(pk.channelVolumeM3)}`}
          hint={`length × mean wetted width × mean depth; deepest ${m(pk.channelMaxDepthM)}. ${Math.round(pk.flowLineLengthM).toLocaleString()} m of flow lines in all; the rest run under 5 cm. Manning sections used for the water level: median ${m(pk.sectionMedianWidthM, 0)}, 90% under ${m(pk.sectionP90WidthM, 0)} wide`}
        />
        {pk.shallowAreaM2 > 0 && (
          <Row label="Shallow hollows" value={`${Math.round(pk.shallowAreaM2).toLocaleString()} m² · ${m3(pk.shallowVolumeM3)}`} />
        )}

        <div className="mt-1.5 text-[10px] text-muted">What the plan counts as waterlogging</div>
        <Row
          label="Counted"
          value={`${(counted.counted.areaM2 / AC).toFixed(2)} ac · ${m3(counted.counted.volumeM3)}`}
          hint={`mean depth ${m(counted.counted.meanDepthM)}: open space`}
        />
        <Row
          label={`Channels under ${counted.ignoredChannels.widthM} m wide`}
          value={`${(counted.ignoredChannels.areaM2 / AC).toFixed(2)} ac · ${m3(counted.ignoredChannels.volumeM3)}`}
          hint="ignored: carried in the storm-water drains (owner, 25 Sep)"
        />
        <Row
          label={`Patches under ${counted.ignoredPatches.underM2.toLocaleString()} m²`}
          value={`${(counted.ignoredPatches.areaM2 / AC).toFixed(2)} ac · ${m3(counted.ignoredPatches.volumeM3)}`}
          hint="ignored so the land round them joins up; this water has to go to the drains instead"
        />

        <details className="mt-1 text-[10px]">
          <summary className="cursor-pointer text-muted hover:text-fg">Ponds one by one</summary>
          <table className="mt-1 w-full">
            <thead>
              <tr className="text-muted">
                <th className="text-left font-normal">area m²</th>
                <th className="text-right font-normal">mean</th>
                <th className="text-right font-normal">max</th>
                <th className="text-right font-normal">peak m³</th>
                <th className="text-right font-normal">end m³</th>
              </tr>
            </thead>
            <tbody>
              {w.ponds.slice(0, 20).map((p) => (
                <tr key={p.id} className="border-t border-line/30 font-mono text-muted" title={p.full ? 'full to the rim: spills' : 'not full'}>
                  <td>{Math.round(p.areaM2).toLocaleString()}</td>
                  <td className="text-right">{p.meanDepthM.toFixed(2)}</td>
                  <td className="text-right">{p.maxDepthM.toFixed(2)}</td>
                  <td className="text-right">{Math.round(p.peakVolumeM3).toLocaleString()}</td>
                  <td className="text-right">{Math.round(p.endVolumeM3).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {w.ponds.length > 20 && <div className="text-muted">and {w.ponds.length - 20} smaller</div>}
        </details>
      </div>
    </Panel>
  );
}
