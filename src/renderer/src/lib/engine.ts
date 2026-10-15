import {
  DEFAULT_METRONOME_SETTINGS,
  type MetronomeSettings,
  type StemId,
  type StemPanMap
} from '../../../shared/types'
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

export type BufferMap = Partial<Record<StemId, AudioBuffer>>

export async function decodePayload(
  payload: Record<string, Uint8Array>
): Promise<BufferMap> {
  const ctx = new AudioContext()
  void ctx.resume()
  const ids = Object.keys(payload)
  // decodeAudioData detaches the source buffer — the IPC payload is throwaway,
  // so hand it over as-is (skips a full copy per stem)
  const decoded = await Promise.all(
    ids.map((id) => ctx.decodeAudioData(payload[id].buffer as ArrayBuffer))
  )
  const out: BufferMap = {}
  ids.forEach((id, i) => {
    out[id as StemId] = decoded[i]
  })
  return out
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private buffers: BufferMap = {}
  private gains: Partial<Record<StemId, GainNode>> = {}
  private panners: Partial<Record<StemId, StereoPannerNode>> = {}
  private pitchNodes: Partial<Record<StemId, SoundTouchNode>> = {}
  private workletReady: Promise<void> | null = null
  private mix = {
    vols: {} as Partial<Record<StemId, number>>,
    pans: {} as StemPanMap,
    mutes: new Set<StemId>(),
    solos: new Set<StemId>(),
    master: 0.9
  }
  private master: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private metronomeSettings: MetronomeSettings = { ...DEFAULT_METRONOME_SETTINGS }
  private metronomeTimer: ReturnType<typeof setInterval> | null = null
  private metronomeClicks = new Set<OscillatorNode>()
  private metronomeAnchorPosition = 0
  private metronomeAnchorContext = 0
  private nextMetronomeBeat = 0
  private generation = 0
  private playing = false
  private anchorYt = 0
  private anchorCtx = 0
  rate = 1
  transpose = 0

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.mix.master
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  private getGain(id: StemId): GainNode {
    const ctx = this.ensureCtx()
    let g = this.gains[id]
    if (!g) {
      g = ctx.createGain()
      const pan = ctx.createStereoPanner()
      pan.pan.value = this.mix.pans[id] ?? 0
      g.gain.value = this.stemVolume(id)
      g.connect(pan)
      pan.connect(this.master!)
      this.panners[id] = pan
      this.gains[id] = g
    }
    return g
  }

  resume(): void {
    void this.ensureCtx().resume()
  }

  async decode(payload: Record<string, Uint8Array>): Promise<void> {
    const buffers = await decodePayload(payload)
    this.buffers = buffers
  }

  setBuffers(buffers: BufferMap): void {
    this.stopAll()
    for (const pitch of Object.values(this.pitchNodes)) pitch?.disconnect()
    for (const gain of Object.values(this.gains)) gain?.disconnect()
    for (const pan of Object.values(this.panners)) pan?.disconnect()
    this.gains = {}
    this.panners = {}
    this.pitchNodes = {}
    this.mix = { vols: {}, pans: {}, mutes: new Set(), solos: new Set(), master: 0.9 }
    this.buffers = buffers
  }

  private stemVolume(id: StemId): number {
    const { vols, mutes, solos } = this.mix
    return !mutes.has(id) && (solos.size === 0 || solos.has(id)) ? vols[id] ?? 1 : 0
  }

  hasBuffers(): boolean {
    return Object.keys(this.buffers).length > 0
  }

  setPlaying(playing: boolean, time: number): void {
    if (playing) this.resume()
    this.playing = playing
    this.align(time)
  }

  align(time: number): void {
    this.stopSources()
    this.anchorYt = time
    if (!this.ctx || !this.playing || !this.hasBuffers()) return
    const generation = ++this.generation
    void this.startSources(time, generation)
  }

  private async startSources(time: number, generation: number): Promise<void> {
    const ctx = this.ensureCtx()
    this.workletReady ??= SoundTouchNode.register(ctx, processorUrl)
    try {
      await this.workletReady
    } catch (error) {
      this.workletReady = null
      console.error('Could not initialize SoundTouch audio worklet', error)
      return
    }
    if (generation !== this.generation || !this.playing) return
    if (!ctx) return
    const startAt = ctx.currentTime + 0.04
    for (const id of Object.keys(this.buffers) as StemId[]) {
      const buf = this.buffers[id]
      if (!buf) continue
      const gain = this.getGain(id)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = this.rate
      let pitch = this.pitchNodes[id]
      if (!pitch) {
        pitch = new SoundTouchNode({ context: ctx })
        pitch.connect(gain)
        this.pitchNodes[id] = pitch
      }
      pitch.pitchSemitones.setValueAtTime(id === 'drums' ? 0 : this.transpose, startAt)
      pitch.playbackRate.setValueAtTime(this.rate, startAt)
      src.connect(pitch)
      src.start(startAt, Math.min(Math.max(0, time), Math.max(0, buf.duration - 0.01)))
      this.sources.push(src)
    }
    this.anchorCtx = startAt
    this.startMetronome(time, startAt)
  }

  expected(): number {
    if (!this.ctx || !this.playing) return this.anchorYt
    return this.anchorYt + (this.ctx.currentTime - this.anchorCtx) * this.rate
  }

  trackDuration(): number {
    let d = 0
    for (const buf of Object.values(this.buffers)) {
      if (buf && buf.duration > d) d = buf.duration
    }
    return d
  }

  applyMix(
    vols: Partial<Record<StemId, number>>,
    mutes: Set<StemId>,
    solos: Set<StemId>,
    masterVol: number,
    pans: StemPanMap = {}
  ): void {
    this.mix = {
      vols: { ...vols }, pans: { ...pans },
      mutes: new Set(mutes), solos: new Set(solos), master: masterVol
    }
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const id of Object.keys(this.buffers) as StemId[]) {
      this.getGain(id).gain.setTargetAtTime(this.stemVolume(id), now, 0.012)
      this.panners[id]?.pan.setTargetAtTime(pans[id] ?? 0, now, 0.012)
    }
    this.master?.gain.setTargetAtTime(masterVol, now, 0.012)
  }

  stopAll(): void {
    this.playing = false
    this.generation++
    this.stopSources()
  }

  setTranspose(semitones: number): void {
    const value = Math.max(-12, Math.min(12, Math.round(semitones)))
    if (value === this.transpose) return
    this.transpose = value
    if (this.playing) this.align(this.expected())
  }

  setMetronome(settings: MetronomeSettings): void {
    this.metronomeSettings = { ...settings }
    this.stopMetronome()
    if (!this.playing || !this.metronomeSettings.enabled || !this.ctx) return
    const lead = 0.05
    const position = this.expected() + lead * this.rate
    this.startMetronome(position, this.ctx.currentTime + lead)
  }

  private startMetronome(position: number, startAt: number): void {
    this.stopMetronome()
    if (!this.ctx || !this.metronomeSettings.enabled) return
    this.metronomeAnchorPosition = position
    this.metronomeAnchorContext = startAt
    const beatDuration = 60 / this.metronomeSettings.bpm
    this.nextMetronomeBeat = Math.ceil(
      (position - this.metronomeSettings.firstBeat) / beatDuration - 1e-6
    )
    this.scheduleMetronomeClicks()
    this.metronomeTimer = setInterval(() => this.scheduleMetronomeClicks(), 25)
  }

  private scheduleMetronomeClicks(): void {
    if (!this.ctx || !this.playing || !this.metronomeSettings.enabled) return
    const now = this.ctx.currentTime
    const horizon = now + 0.12
    const beatDuration = 60 / this.metronomeSettings.bpm
    const songDuration = this.trackDuration()
    while (true) {
      const beat = this.nextMetronomeBeat
      const position = this.metronomeSettings.firstBeat + beat * beatDuration
      const when = this.metronomeAnchorContext + (position - this.metronomeAnchorPosition) / this.rate
      if (when > horizon) break
      this.nextMetronomeBeat++
      if (when < now - 0.005 || position < 0 || (songDuration > 0 && position > songDuration)) continue
      if (this.metronomeSettings.volume <= 0) continue
      const oscillator = this.ctx.createOscillator()
      const envelope = this.ctx.createGain()
      const accent = beat % 4 === 0
      const peak = this.metronomeSettings.volume * (accent ? 0.55 : 0.35)
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(accent ? 1760 : 1320, when)
      envelope.gain.setValueAtTime(0.0001, when)
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.002)
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)
      oscillator.connect(envelope)
      envelope.connect(this.master!)
      oscillator.onended = () => {
        oscillator.disconnect()
        envelope.disconnect()
        this.metronomeClicks.delete(oscillator)
      }
      this.metronomeClicks.add(oscillator)
      oscillator.start(when)
      oscillator.stop(when + 0.05)
    }
  }

  private stopMetronome(): void {
    if (this.metronomeTimer !== null) clearInterval(this.metronomeTimer)
    this.metronomeTimer = null
    for (const click of this.metronomeClicks) {
      click.onended = null
      try {
        click.stop()
        click.disconnect()
      } catch {}
    }
    this.metronomeClicks.clear()
  }

  private stopSources(): void {
    this.generation++
    this.stopMetronome()
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
      try {
        s.disconnect()
      } catch {}
    }
    this.sources = []
    for (const pitch of Object.values(this.pitchNodes)) pitch?.disconnect()
    this.pitchNodes = {}
  }
}

export const engine = new StemEngine()
