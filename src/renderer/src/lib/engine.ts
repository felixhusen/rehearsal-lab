import {
  DEFAULT_METRONOME_SETTINGS,
  type MetronomeSettings,
  type MetronomeSound,
  type StemId,
  type StemPanMap
} from '../../../shared/types'
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

const metronomeSampleUrls = import.meta.glob('../assets/metronome/*.wav', {
  eager: true,
  query: '?inline',
  import: 'default'
}) as Record<string, string>

function sampleFilename(sound: MetronomeSound, variant: string): string {
  const path = `../assets/metronome/${sound}-${variant}.wav`
  if (metronomeSampleUrls[path]) return path
  throw new Error(`Missing metronome sample: ${path}`)
}

function regularSampleFilename(sound: MetronomeSound, timeSignature: MetronomeSettings['timeSignature']): string {
  const preferred = timeSignature === '6/8' ? 'eighth' : 'quarter'
  for (const variant of [preferred, 'quarter', 'eighth', 'sixteenth', 'accents']) {
    const path = `../assets/metronome/${sound}-${variant}.wav`
    if (metronomeSampleUrls[path]) return path
  }
  return sampleFilename('Classic', 'quarter')
}

function audioBufferPeak(buffer: AudioBuffer): number {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]))
  }
  return peak
}

export type BufferMap = Partial<Record<StemId, AudioBuffer>>

function encodeFloatWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels
  const dataBytes = buffer.length * channels * 4
  const output = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(output)
  const write = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  write(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true)
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 4, true)
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true)
  write(36, 'data'); view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      view.setFloat32(offset, buffer.getChannelData(channel)[i], true)
      offset += 4
    }
  }
  return new Uint8Array(output)
}

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
    songVolume: 0.9
  }
  private songGain: GainNode | null = null
  private metronomePanNode: StereoPannerNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private metronomeSettings: MetronomeSettings = { ...DEFAULT_METRONOME_SETTINGS }
  private metronomeSound: MetronomeSound = 'Classic'
  private metronomeTimer: ReturnType<typeof setInterval> | null = null
  private metronomeClicks = new Set<AudioScheduledSourceNode>()
  private metronomeAudioBuffers = new Map<string, AudioBuffer>()
  private metronomeBufferLoads = new Map<string, Promise<AudioBuffer>>()
  private metronomeSoundBuffers = new Map<string, {
    regular: AudioBuffer
    accent: AudioBuffer
    regularPeak: number
    accentPeak: number
  }>()
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
      this.songGain = this.ctx.createGain()
      this.songGain.gain.value = this.mix.songVolume
      this.songGain.connect(this.ctx.destination)
      this.metronomePanNode = this.ctx.createStereoPanner()
      this.metronomePanNode.pan.value = this.metronomeSettings.pan
      this.metronomePanNode.connect(this.ctx.destination)
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
      pan.connect(this.songGain!)
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
    this.mix = { vols: {}, pans: {}, mutes: new Set(), solos: new Set(), songVolume: 0.9 }
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
    if (this.metronomeSettings.enabled) {
      try {
        await this.loadMetronomeSound(this.metronomeSound, this.metronomeSettings.timeSignature)
      } catch (error) {
        console.error('Could not load metronome samples', error)
      }
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

  async renderExportMix(): Promise<Uint8Array | null> {
    if ((!this.metronomeSettings.enabled && this.transpose === 0) || !this.hasBuffers()) return null
    const duration = this.trackDuration()
    const sampleRate = this.ctx?.sampleRate ?? 44100
    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate)
    if (this.transpose !== 0) await SoundTouchNode.register(offline, processorUrl)
    for (const [id, buffer] of Object.entries(this.buffers) as [StemId, AudioBuffer][]) {
      if (!buffer) continue
      const source = offline.createBufferSource()
      source.buffer = buffer
      if (this.transpose !== 0) {
        const pitch = new SoundTouchNode({ context: offline })
        pitch.pitchSemitones.setValueAtTime(id === 'drums' ? 0 : this.transpose, 0)
        pitch.playbackRate.setValueAtTime(1, 0)
        source.connect(pitch)
        pitch.connect(offline.destination)
      } else {
        source.connect(offline.destination)
      }
      source.start(0)
    }
    if (this.metronomeSettings.enabled) {
      await this.loadMetronomeSound(this.metronomeSound, this.metronomeSettings.timeSignature)
      const buffers = this.metronomeSoundBuffers.get(`${this.metronomeSound}:${this.metronomeSettings.timeSignature}`)!
      const settings = this.metronomeSettings
      const beatDuration = 60 / settings.bpm * (settings.timeSignature === '6/8' ? 0.5 : 1)
      const beatsPerBar = this.metronomeBeatsPerBar()
      const panner = offline.createStereoPanner()
      panner.pan.value = settings.pan
      panner.connect(offline.destination)
      // Match live playback: the first-beat marker defines beat zero, so earlier
      // clicks continue on the same grid instead of leaving a silent lead-in.
      const firstBeatIndex = Math.ceil(-settings.firstBeat / beatDuration - 1e-6)
      for (
        let beat = firstBeatIndex,
          position = settings.firstBeat + firstBeatIndex * beatDuration;
        position <= duration;
        beat++, position = settings.firstBeat + beat * beatDuration
      ) {
        if (position < 0 || settings.volume <= 0) continue
        const beatInBar = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar
        const accent = beatInBar === 0 || (settings.timeSignature === '6/8' && beatInBar === 3)
        const sample = accent ? buffers.accent : buffers.regular
        const peak = accent ? buffers.accentPeak : buffers.regularPeak
        const source = offline.createBufferSource()
        const gain = offline.createGain()
        source.buffer = sample
        gain.gain.value = Math.min(2.5, settings.volume * (accent ? 1 : 0.8) / Math.max(0.0001, peak))
        source.connect(gain)
        gain.connect(panner)
        source.start(position, 0, Math.min(sample.duration, 0.25))
      }
    }
    return encodeFloatWav(await offline.startRendering())
  }

  applyMix(
    vols: Partial<Record<StemId, number>>,
    mutes: Set<StemId>,
    solos: Set<StemId>,
    songVolume: number,
    pans: StemPanMap = {}
  ): void {
    this.mix = {
      vols: { ...vols }, pans: { ...pans },
      mutes: new Set(mutes), solos: new Set(solos), songVolume
    }
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const id of Object.keys(this.buffers) as StemId[]) {
      this.getGain(id).gain.setTargetAtTime(this.stemVolume(id), now, 0.012)
      this.panners[id]?.pan.setTargetAtTime(pans[id] ?? 0, now, 0.012)
    }
    this.songGain?.gain.setTargetAtTime(songVolume, now, 0.012)
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
    const previous = this.metronomeSettings
    const pan = Number.isFinite(settings.pan) ? Math.max(-1, Math.min(1, settings.pan)) : 0
    this.metronomeSettings = { ...settings, pan }
    if (previous.pan !== pan && this.ctx && this.metronomePanNode) {
      this.metronomePanNode.pan.cancelScheduledValues(this.ctx.currentTime)
      this.metronomePanNode.pan.setTargetAtTime(pan, this.ctx.currentTime, 0.012)
    }
    if (
      previous.enabled === settings.enabled && previous.bpm === settings.bpm &&
      previous.timeSignature === settings.timeSignature && previous.firstBeat === settings.firstBeat &&
      previous.volume === settings.volume
    ) return
    this.refreshMetronome()
  }

  setMetronomeSound(sound: MetronomeSound): void {
    if (this.metronomeSound === sound) return
    this.metronomeSound = sound
    this.refreshMetronome()
  }

  private refreshMetronome(): void {
    this.stopMetronome()
    if (!this.playing || !this.metronomeSettings.enabled || !this.ctx) return
    const generation = this.generation
    const sound = this.metronomeSound
    const timeSignature = this.metronomeSettings.timeSignature
    void this.loadMetronomeSound(sound, timeSignature).then(() => {
      if (generation !== this.generation || !this.playing || !this.metronomeSettings.enabled) return
      if (
        sound !== this.metronomeSound ||
        timeSignature !== this.metronomeSettings.timeSignature
      ) return
      const position = this.expected()
      this.startMetronome(position, this.ctx!.currentTime)
    }).catch((error: unknown) => {
      console.error('Could not load metronome samples', error)
      if (generation !== this.generation || !this.playing || !this.metronomeSettings.enabled) return
      if (
        sound !== this.metronomeSound ||
        timeSignature !== this.metronomeSettings.timeSignature
      ) return
      this.startMetronome(this.expected(), this.ctx!.currentTime)
    })
  }

  private async loadMetronomeSound(
    sound: MetronomeSound,
    timeSignature: MetronomeSettings['timeSignature']
  ): Promise<void> {
    const regularFile = regularSampleFilename(sound, timeSignature)
    const accentFile = metronomeSampleUrls[`../assets/metronome/${sound}-accents.wav`]
      ? `../assets/metronome/${sound}-accents.wav`
      : regularFile
    const [regular, accent] = await Promise.all([
      this.loadMetronomeBuffer(regularFile),
      this.loadMetronomeBuffer(accentFile)
    ])
    this.metronomeSoundBuffers.set(`${sound}:${timeSignature}`, {
      regular,
      accent,
      regularPeak: audioBufferPeak(regular),
      accentPeak: audioBufferPeak(accent)
    })
  }

  private loadMetronomeBuffer(filename: string): Promise<AudioBuffer> {
    const cached = this.metronomeAudioBuffers.get(filename)
    if (cached) return Promise.resolve(cached)
    const pending = this.metronomeBufferLoads.get(filename)
    if (pending) return pending
    const ctx = this.ensureCtx()
    const url = metronomeSampleUrls[filename]
    if (!url) return Promise.reject(new Error(`Missing metronome sample asset: ${filename}`))
    const request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Could not fetch metronome sample (${response.status})`)
        return response.arrayBuffer()
      })
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        this.metronomeAudioBuffers.set(filename, buffer)
        this.metronomeBufferLoads.delete(filename)
        return buffer
      })
      .catch((error: unknown) => {
        this.metronomeBufferLoads.delete(filename)
        throw error
      })
    this.metronomeBufferLoads.set(filename, request)
    return request
  }

  private startMetronome(position: number, startAt: number): void {
    this.stopMetronome()
    if (!this.ctx || !this.metronomeSettings.enabled) return
    this.metronomeAnchorPosition = position
    this.metronomeAnchorContext = startAt
    const beatDuration = this.metronomeBeatDuration()
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
    const beatDuration = this.metronomeBeatDuration()
    const songDuration = this.trackDuration()
    while (true) {
      const beat = this.nextMetronomeBeat
      const position = this.metronomeSettings.firstBeat + beat * beatDuration
      const when = this.metronomeAnchorContext + (position - this.metronomeAnchorPosition) / this.rate
      if (when > horizon) break
      this.nextMetronomeBeat++
      if (when < now - 0.005 || position < 0 || (songDuration > 0 && position > songDuration)) continue
      if (this.metronomeSettings.volume <= 0) continue
      const beatsPerBar = this.metronomeBeatsPerBar()
      const beatInBar = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar
      const accent = beatInBar === 0 ||
        (this.metronomeSettings.timeSignature === '6/8' && beatInBar === 3)
      const buffers = this.metronomeSoundBuffers.get(
        `${this.metronomeSound}:${this.metronomeSettings.timeSignature}`
      )
      const sample = buffers ? (accent ? buffers.accent : buffers.regular) : null
      const source = sample ? this.ctx.createBufferSource() : this.ctx.createOscillator()
      const envelope = this.ctx.createGain()
      let duration = 0.25
      if (sample) {
        const sampleSource = source as AudioBufferSourceNode
        sampleSource.buffer = sample
        const targetPeak = this.metronomeSettings.volume * (accent ? 1 : 0.8)
        const samplePeak = accent ? buffers!.accentPeak : buffers!.regularPeak
        envelope.gain.setValueAtTime(
          Math.min(2.5, targetPeak / Math.max(0.0001, samplePeak)),
          when
        )
        duration = Math.min(sample.duration, duration)
      } else {
        const oscillator = source as OscillatorNode
        const peak = this.metronomeSettings.volume * (accent ? 1 : 0.8)
        oscillator.type = 'triangle'
        oscillator.frequency.setValueAtTime(accent ? 1760 : 1320, when)
        envelope.gain.setValueAtTime(0.0001, when)
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.002)
        envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.045)
      }
      source.connect(envelope)
      // Keep the click outside the song fader so lowering the stems brings
      // the metronome forward without changing its own volume.
      envelope.connect(this.metronomePanNode ?? this.ctx.destination)
      source.onended = () => {
        source.disconnect()
        envelope.disconnect()
        this.metronomeClicks.delete(source)
      }
      this.metronomeClicks.add(source)
      if (sample) (source as AudioBufferSourceNode).start(when, 0, duration)
      else {
        source.start(when)
        source.stop(when + 0.05)
      }
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

  private metronomeBeatsPerBar(): number {
    switch (this.metronomeSettings.timeSignature) {
      case '3/4': return 3
      case '6/8': return 6
      default: return 4
    }
  }

  private metronomeBeatDuration(): number {
    return 60 / this.metronomeSettings.bpm * (this.metronomeSettings.timeSignature === '6/8' ? 0.5 : 1)
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
