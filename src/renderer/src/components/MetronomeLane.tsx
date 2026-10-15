import { fmtTime } from '../lib/format'

interface Props {
  enabled: boolean
  bpm: number
  firstBeat: number
  volume: number
  disabled?: boolean
  onEnabled: (enabled: boolean) => void
  onBpm: (bpm: number) => void
  onSetFirstBeat: () => void
  onVolume: (volume: number) => void
}

export function MetronomeLane({
  enabled,
  bpm,
  firstBeat,
  volume,
  disabled = false,
  onEnabled,
  onBpm,
  onSetFirstBeat,
  onVolume
}: Props): React.ReactElement {
  return (
    <section className="glass rounded-xl px-4 py-3 flex items-center gap-4 min-h-16" aria-label="Metronome track">
      <button
        type="button"
        onClick={() => onEnabled(!enabled)}
        disabled={disabled}
        aria-pressed={enabled}
        className={`no-drag rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
          enabled ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/5 text-white/60 hover:bg-white/10'
        }`}
      >
        {enabled ? 'Metronome on' : 'Metronome off'}
      </button>

      <span className="text-sm font-medium text-white/80">Click track</span>

      <label className="flex items-center gap-2 text-xs text-white/55">
        BPM
        <input
          type="number"
          min={40}
          max={240}
          step={1}
          value={bpm}
          disabled={disabled}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value >= 40 && value <= 240) onBpm(Math.round(value))
          }}
          className="no-drag w-16 rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-center font-mono text-white disabled:opacity-40"
          aria-label="Metronome tempo in beats per minute"
        />
      </label>

      <button
        type="button"
        onClick={onSetFirstBeat}
        disabled={disabled}
        title="Use the current playhead position as beat one and enable the metronome"
        className="no-drag rounded-lg bg-white/5 px-3 py-2 text-xs text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
      >
        Set first beat
      </button>

      <span className="text-[11px] font-mono text-white/40">{fmtTime(firstBeat)}</span>

      <label className="ml-auto flex min-w-36 items-center gap-3 text-xs text-white/50">
        Volume
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          disabled={disabled}
          onChange={(event) => onVolume(Number(event.target.value))}
          className="no-drag w-24 disabled:opacity-40"
          aria-label="Metronome volume"
        />
      </label>
    </section>
  )
}
