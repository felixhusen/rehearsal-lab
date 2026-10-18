import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { userDataDir } from './env'
import { DEFAULT_SETTINGS, type AppSettings, type MetronomeSound } from '../shared/types'

function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const data = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return { ...DEFAULT_SETTINGS, ...(data && typeof data === 'object' ? data : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  const metronomeSounds: MetronomeSound[] = [
    'Blip', 'Classic', 'Cowbell', 'Digital', 'Gentle', 'Percussive', 'Saw', 'Woodblock'
  ]
  const next: AppSettings = {
    shifts: merged.shifts === 2 ? 2 : 1,
    htdemucsFt: !!merged.htdemucsFt,
    roformerVocals: !!merged.roformerVocals,
    gpuSplit: !!merged.gpuSplit,
    hideVideo: !!merged.hideVideo,
    metronomeSound: metronomeSounds.includes(merged.metronomeSound)
      ? merged.metronomeSound
      : DEFAULT_SETTINGS.metronomeSound,
    exportFormat: merged.exportFormat === 'aac' ? 'aac' : 'wav'
  }
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings:changed', next)
  }
  return next
}
