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


