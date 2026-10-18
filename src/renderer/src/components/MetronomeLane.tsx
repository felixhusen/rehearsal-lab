import { fmtTime } from "../lib/format";
import { BeatMarkerIcon, MetronomeIcon } from "./Icons";
import { PanKnob } from "./PanKnob";

type Props = {
  enabled: boolean;
  soloed: boolean;
  bpm: number;
  timeSignature: "3/4" | "4/4" | "6/8";
  firstBeat: number;
  volume: number;
  pan: number;
  disabled?: boolean;
  onEnabled: (enabled: boolean) => void;
  onSolo: () => void;
  onBpm: (bpm: number) => void;
  onTimeSignature: (timeSignature: "3/4" | "4/4" | "6/8") => void;
  onSetFirstBeat: () => void;
  onVolume: (volume: number) => void;
  onPan: (pan: number) => void;
};

export const MetronomeLane = ({
  enabled,
  soloed,
  bpm,
  timeSignature,
  firstBeat,
  volume,
  pan = 0,
  disabled = false,
  onEnabled,
  onSolo,
  onBpm,
  onTimeSignature,
  onSetFirstBeat,
  onVolume,
  onPan,
}: Props): React.ReactElement => {
  return (
    <div
      className={`group flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 transition-all duration-200 glass ${enabled ? "opacity-100" : "opacity-45"}`}
    >
      <div className="flex w-36 shrink-0 items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-400/10 text-emerald-300">
          <MetronomeIcon className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">Metronome</span>
      </div>

      <button
        type="button"
        onClick={() => onEnabled(!enabled)}
        disabled={disabled}
        title={enabled ? "Mute metronome" : "Unmute metronome"}
        aria-label={enabled ? "Mute metronome" : "Unmute metronome"}
        aria-pressed={!enabled}
        className={`no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold transition-colors disabled:opacity-40 ${
          !enabled
            ? "bg-rose-400 text-black"
            : "bg-white/5 text-white/50 hover:bg-white/10"
        }`}
      >
        M
      </button>
      <button
        type="button"
        onClick={onSolo}
        disabled={disabled}
        title="Solo metronome"
        aria-label="Solo metronome"
        aria-pressed={soloed}
        className={`no-drag flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold transition-colors disabled:opacity-40 ${
          soloed
            ? "bg-amber-300 text-black"
            : "bg-white/5 text-white/50 hover:bg-white/10"
        }`}
      >
        S
      </button>

      <label className="flex shrink-0 items-center gap-2 text-xs text-white/55">
        BPM
        <input
          type="number"
          min={40}
          max={240}
          step={0.1}
          value={bpm}
          disabled={disabled}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value >= 40 && value <= 240)
              onBpm(Math.round(value * 10) / 10);
          }}
          className="no-drag w-16 rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-center font-mono text-white disabled:opacity-40"
          aria-label="Metronome tempo in beats per minute"
        />
      </label>

      <label className="flex shrink-0 items-center gap-2 text-xs text-white/55">
        Time
        <select
          value={timeSignature}
          disabled={disabled}
          onChange={(event) =>
            onTimeSignature(event.target.value as Props["timeSignature"])
          }
          className="no-drag rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-white disabled:opacity-40"
          aria-label="Metronome time signature"
        >
          <option value="3/4">3/4</option>
          <option value="4/4">4/4</option>
          <option value="6/8">6/8</option>
        </select>
      </label>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className="shrink-0 text-[11px] font-mono text-white/40">
          {fmtTime(firstBeat)}
        </span>
        <button
          type="button"
          onClick={onSetFirstBeat}
          disabled={disabled}
          title="Use the current playhead position as beat one and enable the metronome"
          aria-label="Set first beat"
          className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <BeatMarkerIcon className="h-4 w-4" />
        </button>
      </div>

      <label className="flex min-w-36 items-center gap-3 text-xs text-white/50">
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          disabled={disabled}
          onChange={(event) => onVolume(Number(event.target.value))}
          className="no-drag w-24 disabled:opacity-40"
          style={{
            background: `linear-gradient(to right, #6ee7b7 ${volume * 100}%, rgba(255,255,255,0.14) ${volume * 100}%)`,
          }}
          aria-label="Metronome volume"
        />
      </label>

      <PanKnob label="Metronome" color="#6ee7b7" value={pan} onChange={onPan} />
    </div>
  );
};
