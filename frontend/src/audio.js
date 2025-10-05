let audioCtx = null

function getCtx() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    audioCtx = new AudioContext()
  }
  return audioCtx
}

export function playJoinSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(520, now)
  o.frequency.exponentialRampToValueAtTime(880, now + 0.12)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25)
  o.connect(g).connect(ctx.destination)
  o.start(now)
  o.stop(now + 0.26)
}

export function playPairSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o1 = ctx.createOscillator()
  const o2 = ctx.createOscillator()
  const g = ctx.createGain()
  o1.type = 'triangle'
  o2.type = 'sine'
  o1.frequency.setValueAtTime(440, now)
  o2.frequency.setValueAtTime(660, now)
  o1.frequency.exponentialRampToValueAtTime(660, now + 0.18)
  o2.frequency.exponentialRampToValueAtTime(990, now + 0.18)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.25, now + 0.03)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
  o1.connect(g)
  o2.connect(g)
  g.connect(ctx.destination)
  o1.start(now)
  o2.start(now)
  o1.stop(now + 0.32)
  o2.stop(now + 0.32)
}

// Short retro beeps
export function playSendSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'square'
  o.frequency.setValueAtTime(520, now)
  o.frequency.linearRampToValueAtTime(780, now + 0.08)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.18, now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
  o.connect(g).connect(ctx.destination)
  o.start(now)
  o.stop(now + 0.13)
}

// Quieter short beep for TV float chat send
export function playTvSendSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'square'
  o.frequency.setValueAtTime(520, now)
  o.frequency.linearRampToValueAtTime(740, now + 0.07)
  g.gain.setValueAtTime(0.00005, now) // very quiet
  g.gain.exponentialRampToValueAtTime(0.06, now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.00005, now + 0.11)
  o.connect(g).connect(ctx.destination)
  o.start(now)
  o.stop(now + 0.12)
}

export function playReceiveSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'square'
  o.frequency.setValueAtTime(880, now)
  o.frequency.linearRampToValueAtTime(440, now + 0.12)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)
  o.connect(g).connect(ctx.destination)
  o.start(now)
  o.stop(now + 0.17)
}

export function playConnectSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o1 = ctx.createOscillator()
  const o2 = ctx.createOscillator()
  const g = ctx.createGain()
  o1.type = 'square'
  o2.type = 'triangle'
  o1.frequency.setValueAtTime(330, now)
  o2.frequency.setValueAtTime(660, now)
  o1.frequency.linearRampToValueAtTime(660, now + 0.12)
  o2.frequency.linearRampToValueAtTime(990, now + 0.12)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.22, now + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)
  o1.connect(g); o2.connect(g); g.connect(ctx.destination)
  o1.start(now); o2.start(now)
  o1.stop(now + 0.22); o2.stop(now + 0.22)
}

export function playDisconnectSound() {
  const ctx = getCtx()
  const now = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sawtooth'
  o.frequency.setValueAtTime(440, now)
  o.frequency.exponentialRampToValueAtTime(220, now + 0.18)
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)
  o.connect(g).connect(ctx.destination)
  o.start(now)
  o.stop(now + 0.22)
}

// Optional GM soundfont instruments (lazy-loaded). Falls back silently if unavailable.
let _sfModule = null
const _sfCache = new Map()
export let sfLoaded = false

export async function ensureSoundfontInstrument(name) {
  if (!name) name = 'acoustic_grand_piano'
  if (_sfCache.has(name)) return _sfCache.get(name)
  try {
    // Try local dependency first, then CDN fallback
    _sfModule = _sfModule || await import('soundfont-player').catch(() => import('https://cdn.jsdelivr.net/npm/soundfont-player@0.12.0/dist/soundfont-player.es.js'))
    const ctx = getCtx()
    const inst = await _sfModule.instrument(ctx, name, { gain: 0.7 })
    _sfCache.set(name, inst)
    sfLoaded = true
    return inst
  } catch (e) {
    sfLoaded = false
    return null
  }
}

// Load a GM instrument for a provided AudioContext/OfflineAudioContext (no shared cache)
export async function ensureSoundfontInstrumentForContext(ctx, name) {
  try {
    if (!name) name = 'acoustic_grand_piano'
    _sfModule = _sfModule || await import('soundfont-player').catch(() => import('https://cdn.jsdelivr.net/npm/soundfont-player@0.12.0/dist/soundfont-player.es.js'))
    const inst = await _sfModule.instrument(ctx, name, { gain: 0.7 })
    return inst
  } catch {
    return null
  }
}

// Play a MIDI note via a GM soundfont instrument (default: acoustic piano)
export function playSf(midi, when = 0, durationSec = 1.5, gain = 0.8, instrument = 'acoustic_grand_piano') {
  try {
    const ctx = getCtx()
    // non-blocking warmup
    if (!_sfCache.has(instrument)) { ensureSoundfontInstrument(instrument) }
    const inst = _sfCache.get(instrument)
    if (inst && inst.play) {
      const start = Math.max(ctx.currentTime, when)
      const node = inst.play(midi, start, { duration: Math.max(0.05, durationSec), gain })
      return node // has .stop()
    }
  } catch {}
  return null
}

export function stopSfNode(node) {
  try { if (node && node.stop) node.stop(0) } catch {}
}

export function midiToFreq(midi) {
  const m = Math.max(0, Math.min(127, Number(midi)||60))
  return 440 * Math.pow(2, (m - 69) / 12)
}
