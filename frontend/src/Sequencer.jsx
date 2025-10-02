import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colorForKey } from './color'

export default function Sequencer({ socket, onBack }) {
  const BACKEND_URL = (import.meta.env && import.meta.env.VITE_BACKEND_URL) ? String(import.meta.env.VITE_BACKEND_URL) : 'http://localhost:3001'
  const [song, setSong] = useState(null)
  const [rev, setRev] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [tempo, setTempo] = useState(120)
  const [baseBar, setBaseBar] = useState(0)
  const [baseTsMs, setBaseTsMs] = useState(Date.now())
  const songId = 'default'
  // Audio + scheduler
  const audioCtxRef = useRef(null)
  const masterRef = useRef(null)
  const schedRef = useRef({ nextStep: 0 })
  // Timeline/ruler
  const STEP_UNIT = 22
  const ROW_UNIT = 16
  const RULER_H = 22
  const PIXEL_SHIFT = 0.5 // visual grid shift for crisp 1px lines
  // Piano roll pitch range (inclusive)
  const PITCH_MIN = 48 // C3
  const PITCH_MAX = 83 // B5
  const PITCH_COUNT = (PITCH_MAX - PITCH_MIN + 1)
  const PITCHES_DESC = useMemo(() => {
    const list = []
    for (let m = PITCH_MAX; m >= PITCH_MIN; m--) list.push(m)
    return list
  }, [])
  const [snap, setSnap] = useState(1) // steps; 1=1/16, 2=1/8, 4=1/4, 8=1/2 when 16 steps/bar
  const rulerRef = useRef(null)
  const rulerScrollRef = useRef(null)
  const arrScrollRef = useRef(null)
  const arrRulerRef = useRef(null)
  const arrRulerScrollRef = useRef(null)
  const arrRulerMarkerRef = useRef(null)
  const dragRef = useRef({ active: false, shift: false })
  const rulerMarkerRef = useRef(null)
  const gridMarkerRef = useRef(null)
  const arrMarkerRef = useRef(null)
  const rootRef = useRef(null)
  // Collaborative cursors: full-page normalized
  const [remoteCursors, setRemoteCursors] = useState({}) // id -> { nx, ny, ts }
  const lastCursorEmitRef = useRef(0)
  const lastSectionEmitTsRef = useRef(0)
  // Typing preview
  const [typingOn, setTypingOn] = useState(false)
  const [typingText, setTypingText] = useState('')
  const [selfPos, setSelfPos] = useState({ nx: 0.5, ny: 0.5 })
  const [remoteTyping, setRemoteTyping] = useState({}) // id -> { text, nx, ny, ts }
  const rafRef = useRef(0)
  const gridRef = useRef(null)
  const arrGridRef = useRef(null)
  const gridScrollRef = useRef(null)
  const noteDragRef = useRef({ active: false, id: null, mode: 'move', startX: 0, startStep: 0, startLen: 0 })
  const [selectedId, setSelectedId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const marqueeRef = useRef({ active: false, x0: 0, y0: 0, x1: 0, y1: 0 })
  const [marqueeBox, setMarqueeBox] = useState(null)
  const clipboardRef = useRef(null)
  const lastMouseStepRef = useRef(0)
  const suppressClickRef = useRef(false)
  const groupDupRef = useRef(null)
  // Arrangement basics (4 tracks)
  const ARR_TRACKS = 4
  const ARR_TRACK_H = 40
  const [clips, setClips] = useState([]) // {id, track, startStep, lengthSteps}
  const [sfxClips, setSfxClips] = useState([]) // {id, track, startStep, lengthSteps, url, gain, pan, offsetMs}
  const sfxBuffersRef = useRef(new Map())
  const lastSfxUrlRef = useRef('')
  const patternPreviewRef = useRef(new Map()) // key: patternId@scale -> dataUrl
  const [previewVersion, setPreviewVersion] = useState(0)
  const [sfxLib, setSfxLib] = useState([]) // [{name,url}]
  const [currentSfxUrl, setCurrentSfxUrl] = useState('')
  const [zoomX, setZoomX] = useState(1)
  const [zoomY, setZoomY] = useState(1)
  const [patternBars, setPatternBars] = useState(4)
  const [mode, setMode] = useState('pattern') // 'pattern' | 'arrangement'
  const scrollSyncRef = useRef(false)
  const ARR_SCALE = 0.4
  const stepWPattern = STEP_UNIT * zoomX
  const stepWArr = STEP_UNIT * zoomX * ARR_SCALE
  const [arrSnap, setArrSnap] = useState('1/2') // '1' | '1/2' | '1/4' | '1/8'
  const [autoResizeClips, setAutoResizeClips] = useState(false)
  const placeRef = useRef({ active: false, track: 0, startStep: 0, lengthSteps: 0, dragging: false, startX: 0, startY: 0, valid: true })
  const [ghost, setGhost] = useState({ on: false, left: 0, top: 0, width: 0, bad: false })
  const [metronomeOn, setMetronomeOn] = useState(false)
  const [countInOn, setCountInOn] = useState(false)
  const countInRef = useRef({ active: false, endStep: 0 })
  const stepWRef = useRef(STEP_UNIT)
  const [placeLenSteps, setPlaceLenSteps] = useState(4)
  const SYNTHS = ['Triangle','Square','Saw','Sine','Pluck','Bass','Bell','SuperSaw','Organ','EPiano','WarmPad','PWM','Sub','Choir']
  const [synth, setSynth] = useState('Triangle')
  const SYNTH_COLOR = {
    Triangle: 'linear-gradient(to bottom, rgba(255,213,74,0.95), rgba(255,213,74,0.7))',
    Square: 'linear-gradient(to bottom, rgba(74,222,128,0.95), rgba(74,222,128,0.7))',
    Saw: 'linear-gradient(to bottom, rgba(96,165,250,0.95), rgba(96,165,250,0.7))',
    Sine: 'linear-gradient(to bottom, rgba(248,250,252,0.95), rgba(248,250,252,0.7))',
    Pluck: 'linear-gradient(to bottom, rgba(161,98,7,0.95), rgba(161,98,7,0.7))',
    Bass: 'linear-gradient(to bottom, rgba(234,88,12,0.95), rgba(234,88,12,0.7))',
    Bell: 'linear-gradient(to bottom, rgba(168,85,247,0.95), rgba(168,85,247,0.7))',
    SuperSaw: 'linear-gradient(to bottom, rgba(239,68,68,0.95), rgba(239,68,68,0.7))',
    Organ: 'linear-gradient(to bottom, rgba(34,197,94,0.95), rgba(34,197,94,0.7))',
    EPiano: 'linear-gradient(to bottom, rgba(59,130,246,0.95), rgba(59,130,246,0.7))',
    WarmPad: 'linear-gradient(to bottom, rgba(99,102,241,0.95), rgba(99,102,241,0.7))',
    PWM: 'linear-gradient(to bottom, rgba(244,114,182,0.95), rgba(244,114,182,0.7))',
    Sub: 'linear-gradient(to bottom, rgba(250,204,21,0.95), rgba(250,204,21,0.7))',
    Choir: 'linear-gradient(to bottom, rgba(20,184,166,0.95), rgba(20,184,166,0.7))',
  }
  // Dim, uniform 2px-high preview colors per synth
  const PREVIEW_COLOR = {
    Triangle: 'rgba(255,213,74,0.55)',
    Square: 'rgba(74,222,128,0.55)',
    Saw: 'rgba(96,165,250,0.55)',
    Sine: 'rgba(248,250,252,0.55)',
    Pluck: 'rgba(161,98,7,0.55)',
    Bass: 'rgba(234,88,12,0.55)',
    Bell: 'rgba(168,85,247,0.55)',
    SuperSaw: 'rgba(239,68,68,0.55)',
    Organ: 'rgba(34,197,94,0.55)',
    EPiano: 'rgba(59,130,246,0.55)',
    WarmPad: 'rgba(99,102,241,0.55)',
    PWM: 'rgba(244,114,182,0.55)',
    Sub: 'rgba(250,204,21,0.55)',
    Choir: 'rgba(20,184,166,0.55)'
  }

  // Kill circles melody if any
  useEffect(() => { try { window.__stopCirclesMelody?.() } catch {} }, [])

  // Socket wiring
  useEffect(() => {
    if (!socket) return
    const onSong = ({ song, rev }) => { setSong(song); setRev(rev); setTempo(song.tempo) }
    const onCursor = ({ from, nx, ny, sect, sx, sy, track, ty, ts }) => {
      try {
        if (!from || from === socket.id) return
        const rec = {}
        if (isFinite(nx) && isFinite(ny)) { rec.nx = Math.max(0, Math.min(1, Number(nx))); rec.ny = Math.max(0, Math.min(1, Number(ny))) }
        if (typeof sect === 'string') rec.sect = sect
        if (isFinite(sx) && isFinite(sy)) { rec.sx = Math.max(0, Math.min(1, Number(sx))); rec.sy = Math.max(0, Math.min(1, Number(sy))) }
        if (typeof track === 'number' && isFinite(track)) rec.track = Math.max(0, Math.min(3, Math.round(track)))
        if (typeof ty === 'number' && isFinite(ty)) rec.ty = Math.max(0, Math.min(1, ty))
        rec.ts = Number(ts) || Date.now()
        setRemoteCursors(prev => ({ ...prev, [from]: rec }))
      } catch {}
    }
    const onTypingPreview = ({ id, text, nx, ny, ts }) => {
      try {
        if (!id || id === socket.id) return
        setRemoteTyping(prev => ({ ...prev, [id]: { text: String(text||'').slice(0,140), nx: Number(nx)||0, ny: Number(ny)||0, ts: Number(ts)||Date.now() } }))
      } catch {}
    }
    const onApply = ({ ops, rev }) => {
      setRev(rev)
      setSong(prev => {
        if (!prev || !Array.isArray(ops)) return prev
        let next = prev
        for (const op of ops) {
          if (op.type === 'toggle_step') {
            const lane = Math.max(0, Math.min(prev.lanes.length - 1, Number(op.lane)))
            const total = prev.bars * prev.stepsPerBar
            const step = Math.max(0, Math.min(total - 1, Number(op.step)))
            const gridCopy = next.grid.map((row, idx) => idx === lane ? row.slice() : row)
            gridCopy[lane][step] = !gridCopy[lane][step]
            next = { ...next, grid: gridCopy }
          } else if (op.type === 'set_tempo') {
            const t = Number(op.tempo); if (isFinite(t)) { next = { ...next, tempo: Math.round(t) }; setTempo(Math.round(t)) }
          } else if (op.type === 'note_add') {
            const pid = typeof op.patternId === 'string' ? op.patternId : next.activePatternId
            const pats = Array.isArray(next.patterns) ? next.patterns.map(p => ({ ...p, notes: (p.notes||[]).slice() })) : []
            const pidx = pats.findIndex(p => p.id === pid)
            if (pidx >= 0) {
              const id = String(op.id || Date.now().toString(36))
              if (!pats[pidx].notes.some(n => n.id === id)) pats[pidx].notes.push({ id, startStep: op.startStep, lengthSteps: op.lengthSteps, pitch: op.pitch, velocity: op.velocity, synth: op.synth || 'Triangle' })
              next = { ...next, patterns: pats }
            } else {
              const list = Array.isArray(next.notes) ? next.notes.slice() : []
              const id = String(op.id || Date.now().toString(36))
              if (!list.some(n => n.id === id)) list.push({ id, startStep: op.startStep, lengthSteps: op.lengthSteps, pitch: op.pitch, velocity: op.velocity, synth: op.synth || 'Triangle' })
              next = { ...next, notes: list }
            }
          } else if (op.type === 'note_delete') {
            const id = String(op.id || '')
            if (Array.isArray(next.patterns)) {
              const pats = next.patterns.map(p => ({ ...p, notes: (p.notes||[]).filter(n => n.id !== id) }))
              next = { ...next, patterns: pats }
            }
            const list = Array.isArray(next.notes) ? next.notes.filter(n => n.id !== id) : []
            next = { ...next, notes: list }
          } else if (op.type === 'note_update') {
            const id = String(op.id || '')
            if (Array.isArray(next.patterns)) {
              const pats = next.patterns.map(p => {
                const list = (p.notes||[]).slice()
                const idx = list.findIndex(n => n.id === id)
                if (idx >= 0) {
                  const updated = { ...list[idx] }
                  if (op.startStep !== undefined) updated.startStep = op.startStep
                  if (op.lengthSteps !== undefined) updated.lengthSteps = op.lengthSteps
                  if (op.pitch !== undefined) updated.pitch = op.pitch
                  if (op.velocity !== undefined) updated.velocity = op.velocity
                  if (typeof op.synth === 'string') updated.synth = op.synth
                  list[idx] = updated
                  return { ...p, notes: list }
                }
                return p
              })
              next = { ...next, patterns: pats }
            }
            const list2 = Array.isArray(next.notes) ? next.notes.slice() : []
            const idx2 = list2.findIndex(n => n.id === id)
            if (idx2 >= 0) {
              const u = { ...list2[idx2] }
              if (op.startStep !== undefined) u.startStep = op.startStep
              if (op.lengthSteps !== undefined) u.lengthSteps = op.lengthSteps
              if (op.pitch !== undefined) u.pitch = op.pitch
              if (op.velocity !== undefined) u.velocity = op.velocity
              if (typeof op.synth === 'string') u.synth = op.synth
              list2[idx2] = u
              next = { ...next, notes: list2 }
            }
          } else if (op.type === 'pattern_add') {
            const id = String(op.id || Date.now().toString(36))
            const name = typeof op.name === 'string' ? op.name : 'Pattern'
            const bars = Math.max(1, Math.min(256, Number(op.bars)||4))
            const pats = Array.isArray(next.patterns) ? next.patterns.slice() : []
            if (!pats.some(p=>p.id===id)) pats.push({ id, name, bars, notes: [] })
            next = { ...next, patterns: pats, activePatternId: id }
          } else if (op.type === 'pattern_update') {
            const id = String(op.id||'')
            const pats = Array.isArray(next.patterns) ? next.patterns.slice() : []
            const idx = pats.findIndex(p=>p.id===id)
            if (idx>=0) {
              const p = { ...pats[idx] }
              if (typeof op.name === 'string') p.name = op.name
              if (op.bars !== undefined) p.bars = Math.max(1, Math.min(256, Number(op.bars)||p.bars))
              pats[idx] = p
              next = { ...next, patterns: pats }
            }
          } else if (op.type === 'pattern_delete') {
            const id = String(op.id||'')
            const pats = Array.isArray(next.patterns) ? next.patterns.filter(p=>p.id!==id) : []
            next = { ...next, patterns: pats, activePatternId: (next.activePatternId===id ? (pats[0]?.id||null) : next.activePatternId) }
          } else if (op.type === 'pattern_select') {
            const id = String(op.id||'')
            next = { ...next, activePatternId: id }
          } else if (op.type === 'set_bars') {
            const nb = Math.max(1, Math.min(1000, Number(op.bars) || next.bars))
            next = { ...next, bars: nb }
          } else if (op.type === 'clip_add') {
            const list = Array.isArray(next.clips) ? next.clips.slice() : []
            const id = String(op.id || Date.now().toString(36))
            if (!list.some(c => c.id === id)) list.push({ id, track: Math.max(0, Math.min(3, Number(op.track)||0)), startStep: Math.max(0, Number(op.startStep)||0), lengthSteps: Math.max(1, Number(op.lengthSteps)|| (next.stepsPerBar*4)), patternId: typeof op.patternId==='string'?op.patternId: (next.activePatternId||'p1') })
            next = { ...next, clips: list }
          } else if (op.type === 'clip_update') {
            const id = String(op.id || '')
            const list = Array.isArray(next.clips) ? next.clips.slice() : []
            const idx = list.findIndex(c => c.id === id)
            if (idx >= 0) {
              const u = { ...list[idx] }
              if (op.track !== undefined) u.track = Math.max(0, Math.min(3, Number(op.track)))
              if (op.startStep !== undefined) u.startStep = Math.max(0, Number(op.startStep)||0)
              if (op.lengthSteps !== undefined) u.lengthSteps = Math.max(1, Number(op.lengthSteps)||1)
              list[idx] = u
            }
            next = { ...next, clips: list }
          } else if (op.type === 'clip_delete') {
            const id = String(op.id || '')
            const list = Array.isArray(next.clips) ? next.clips.filter(c => c.id !== id) : []
            next = { ...next, clips: list }
          } else if (op.type === 'sfx_add') {
            const list = Array.isArray(next.sfx) ? next.sfx.slice() : []
            const id = String(op.id || Date.now().toString(36))
            if (!list.some(s => s.id === id)) list.push({ id, track: Math.max(0, Math.min(3, Number(op.track)||0)), startStep: Math.max(0, Number(op.startStep)||0), lengthSteps: Math.max(1, Number(op.lengthSteps)||1), url: String(op.url||''), gain: Number.isFinite(Number(op.gain)) ? Math.max(0, Math.min(1, Number(op.gain))) : 1, pan: Number.isFinite(Number(op.pan)) ? Math.max(-1, Math.min(1, Number(op.pan))) : 0, offsetMs: Number.isFinite(Number(op.offsetMs)) ? Math.max(0, Number(op.offsetMs)) : 0 })
            next = { ...next, sfx: list }
          } else if (op.type === 'sfx_update') {
            const id = String(op.id || '')
            const list = Array.isArray(next.sfx) ? next.sfx.slice() : []
            const idx = list.findIndex(s => s.id === id)
            if (idx >= 0) {
              const u = { ...list[idx] }
              if (op.track !== undefined) u.track = Math.max(0, Math.min(3, Number(op.track)))
              if (op.startStep !== undefined) u.startStep = Math.max(0, Number(op.startStep)||0)
              if (op.lengthSteps !== undefined) u.lengthSteps = Math.max(1, Number(op.lengthSteps)||1)
              if (op.url !== undefined) u.url = String(op.url||'')
              if (op.gain !== undefined) u.gain = Math.max(0, Math.min(1, Number(op.gain)||0))
              if (op.pan !== undefined) u.pan = Math.max(-1, Math.min(1, Number(op.pan)||0))
              if (op.offsetMs !== undefined) u.offsetMs = Math.max(0, Number(op.offsetMs)||0)
              list[idx] = u
            }
            next = { ...next, sfx: list }
          } else if (op.type === 'sfx_delete') {
            const id = String(op.id || '')
            const list = Array.isArray(next.sfx) ? next.sfx.filter(s => s.id !== id) : []
            next = { ...next, sfx: list }
          }
        }
        return next
      })
    }
    const onTransport = ({ playing, baseBar, baseTsMs, tempo }) => {
      const pb = Number(baseBar)||0; const pts = Number(baseTsMs)||Date.now()
      setPlaying(!!playing); setBaseBar(pb); setBaseTsMs(pts); if (tempo) setTempo(tempo)
      try { schedRef.current.nextStep = Math.floor(pb * (song?.stepsPerBar || 16)) } catch {}
    }
    socket.on('seq_song', onSong)
    socket.on('seq_apply', onApply)
    socket.on('seq_transport', onTransport)
    socket.on('seq_cursor', onCursor)
    socket.on('seq_typing_preview', onTypingPreview)
    socket.on('sfx_uploaded', ({ name, url }) => {
      const abs = (typeof url === 'string' && /^https?:\/\//.test(url)) ? url : (BACKEND_URL.replace(/\/$/, '') + String(url || ''))
      setSfxLib(prev => {
        const exists = prev.some(x => x.url === abs)
        const next = exists ? prev : [...prev, { name: String(name||'sfx'), url: abs }]
        if (!currentSfxUrl && next.length) setCurrentSfxUrl(next[next.length-1].url)
        return next
      })
    })
    socket.emit('seq_join', { songId })
    return () => { socket.off('seq_song', onSong); socket.off('seq_apply', onApply); socket.off('seq_transport', onTransport); socket.off('sfx_uploaded'); socket.off('seq_cursor', onCursor); socket.off('seq_typing_preview', onTypingPreview) }
  }, [socket])
  // Emit cursor helpers (throttled ~25fps)
  function emitCursor(next, isSection = false) {
    try {
      const now = Date.now()
      if (!isSection) {
        // If a section-specific emit happened very recently, skip page-level emits to avoid jumps
        if (now - (lastSectionEmitTsRef.current || 0) < 120) return
      }
      if (now - (lastCursorEmitRef.current || 0) < 40) return
      lastCursorEmitRef.current = now
      if (isSection) lastSectionEmitTsRef.current = now
      socket?.emit?.('seq_cursor', { songId, cursor: next })
    } catch {}
  }

  // Typing handlers
  useEffect(() => {
    const onMove = (e) => {
      if (!typingOn) return
      const root = rootRef.current?.getBoundingClientRect()
      if (!root) return
      const nx = (e.clientX - root.left) / Math.max(1, root.width)
      const ny = (e.clientY - root.top) / Math.max(1, root.height)
      setSelfPos({ nx: Math.max(0, Math.min(1, nx)), ny: Math.max(0, Math.min(1, ny)) })
      try { socket?.emit?.('seq_typing_preview', { songId, text: typingText, nx, ny }) } catch {}
    }
    const onKey = (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const next = !typingOn
        setTypingOn(next)
        if (!next) {
          setTypingText('')
          try { socket?.emit?.('seq_typing_preview', { songId, text: '', nx: selfPos.nx, ny: selfPos.ny }) } catch {}
        }
        return
      }
      if (!typingOn) return
      if (e.key === 'Escape') {
        setTypingOn(false); setTypingText('')
        try { socket?.emit?.('seq_typing_preview', { songId, text: '', nx: selfPos.nx, ny: selfPos.ny }) } catch {}
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        setTypingText(prev => {
          const t = String(prev||'')
          const next = t.slice(0, Math.max(0, t.length - 1))
          try { socket?.emit?.('seq_typing_preview', { songId, text: next, nx: selfPos.nx, ny: selfPos.ny }) } catch {}
          return next
        })
        return
      }
      if (e.key.length === 1) {
        e.preventDefault()
        setTypingText(prev => {
          const next = (String(prev||'') + e.key).slice(0, 140)
          try { socket?.emit?.('seq_typing_preview', { songId, text: next, nx: selfPos.nx, ny: selfPos.ny }) } catch {}
          return next
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('keydown', onKey) }
  }, [typingOn, typingText, selfPos.nx, selfPos.ny, socket])

  // Stable color per id
  function colorForId(id) {
    let h = 0
    const s = String(id||'')
    for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0
    const hue = h % 360
    return `hsl(${hue},85%,60%)`
  }

  // Transport helpers
  function barsPerSecond(bpm) { return (bpm / 60) / 4 }
  function secondsPerBar(bpm) { return 1 / barsPerSecond(bpm) }
  function secondsPerStep(bpm, stepsPerBar) { return secondsPerBar(bpm) / stepsPerBar }
  function currentBarsRaw() {
    const now = Date.now()
    const elapsed = (now - baseTsMs) / 1000
    const bps = barsPerSecond(tempo)
    return playing ? baseBar + elapsed * bps : baseBar
  }
  function currentBarsVis() {
    if (!song) return 0
    const total = song.bars
    const raw = currentBarsRaw()
    // wrap into [0, total)
    return ((raw % total) + total) % total
  }

  function ensureAudio() {
    if (audioCtxRef.current) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const gain = ctx.createGain()
      gain.gain.value = 0.6
      gain.connect(ctx.destination)
      audioCtxRef.current = ctx
      masterRef.current = gain
    } catch {}
  }

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12) }
  function midiToName(m) {
    const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    const name = N[(m % 12 + 12) % 12]
    const octave = Math.floor(m / 12) - 1
    return `${name}${octave}`
  }
  function playNote(time, pitch, velocity, durationSec = 0.3, synthName = synth) {
    const ctx = audioCtxRef.current; const master = masterRef.current
    if (!ctx || !master) return
    const g = ctx.createGain()
    let destination = master
    let attack = 0.01
    let release = Math.min(0.25, Math.max(0.05, durationSec * 0.25))
    const peak = Math.max(0.05, Math.min(0.6, velocity || 0.8))
    const baseFreq = midiToFreq(pitch)

    // Optional filter for certain patches
    let filter = null
    if (synthName === 'Bass') {
      filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, time); filter.Q.value = 0.8
      g.connect(filter); filter.connect(master); destination = filter
    } else {
      g.connect(master)
    }

    // Helper to spawn and mix oscillators with per-osc gain
    const oscillators = []
    function spawn(type, freq, detune = 0, gainScale = 1) {
      const o = ctx.createOscillator()
      const og = ctx.createGain()
      og.gain.value = gainScale
      o.type = type
      o.frequency.setValueAtTime(freq, time)
      try { o.detune.setValueAtTime(detune, time) } catch {}
      o.connect(og); og.connect(g)
      oscillators.push(o)
    }

    // Patch definitions
    if (synthName === 'Triangle') {
      spawn('triangle', baseFreq, 0, 1)
    } else if (synthName === 'Square') {
      spawn('square', baseFreq, 0, 1)
    } else if (synthName === 'Saw') {
      spawn('sawtooth', baseFreq, 0, 1)
    } else if (synthName === 'Sine') {
      spawn('sine', baseFreq, 0, 1)
    } else if (synthName === 'Pluck') {
      attack = 0.005; release = Math.min(0.15, Math.max(0.08, durationSec * 0.3))
      spawn('sawtooth', baseFreq, 0, 1)
    } else if (synthName === 'Bass') {
      attack = 0.008; release = Math.min(0.2, Math.max(0.08, durationSec * 0.25))
      spawn('sawtooth', baseFreq * 0.5, 0, 1) // sub
      spawn('square', baseFreq, 0, 0.7)
    } else if (synthName === 'Bell') {
      attack = 0.005; release = Math.max(0.25, durationSec * 0.8)
      spawn('sine', baseFreq, 0, 1)
      spawn('sine', baseFreq * 2.01, 0, 0.4)
      spawn('sine', baseFreq * 3.0, 0, 0.25)
    } else if (synthName === 'SuperSaw') {
      const detunes = [-8, -4, 0, 4, 8]
      for (const d of detunes) spawn('sawtooth', baseFreq, d, 0.35)
    } else if (synthName === 'Organ') {
      // 3 drawbars: fundamental + 1.5x + 2x
      spawn('square', baseFreq, 0, 0.7)
      spawn('square', baseFreq * 1.5, 0, 0.35)
      spawn('square', baseFreq * 2, 0, 0.25)
      attack = 0.005; release = Math.min(0.2, durationSec * 0.3)
    } else if (synthName === 'EPiano') {
      // Simple FM-ish: carrier saw + soft sine overtone
      spawn('sine', baseFreq, 0, 0.8)
      spawn('triangle', baseFreq * 2, 0, 0.15)
      attack = 0.008; release = Math.max(0.25, durationSec * 0.5)
    } else if (synthName === 'WarmPad') {
      const detunes = [-6, -3, 0, 3, 6]
      for (const d of detunes) spawn('triangle', baseFreq, d, 0.4)
      attack = Math.max(0.03, durationSec * 0.1)
      release = Math.max(0.4, durationSec * 0.8)
    } else if (synthName === 'PWM') {
      // Simulate PWM by mixing two detuned squares
      spawn('square', baseFreq, -10, 0.6)
      spawn('square', baseFreq, 10, 0.6)
      attack = 0.01; release = Math.min(0.3, durationSec * 0.4)
    } else if (synthName === 'Sub') {
      spawn('sine', baseFreq * 0.5, 0, 1)
      attack = 0.01; release = Math.min(0.25, durationSec * 0.3)
    } else if (synthName === 'Choir') {
      // Soft sine/triangle stack with wide detune
      spawn('sine', baseFreq, -5, 0.7)
      spawn('sine', baseFreq, 5, 0.7)
      spawn('triangle', baseFreq * 2, 0, 0.2)
      attack = Math.max(0.05, durationSec * 0.15)
      release = Math.max(0.5, durationSec * 0.9)
    } else {
      spawn('triangle', baseFreq, 0, 1)
    }

    // Envelope
    const sustainTime = Math.max(attack, durationSec - release)
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(peak, time + attack)
    g.gain.setValueAtTime(peak, time + sustainTime)
    g.gain.exponentialRampToValueAtTime(0.0001, time + sustainTime + release)

    // Start/stop
    for (const o of oscillators) { o.start(time); o.stop(time + sustainTime + release + 0.01) }
  }

  async function ensureSfxBuffer(url) {
    if (!url) return null
    const cache = sfxBuffersRef.current
    if (cache.has(url)) return cache.get(url)
    const ctx = audioCtxRef.current
    if (!ctx) return null
    try {
      const res = await fetch(url)
      const arr = await res.arrayBuffer()
      const buf = await ctx.decodeAudioData(arr.slice(0))
      cache.set(url, buf)
      return buf
    } catch { return null }
  }

  function scheduleSfx(when, s) {
    const ctx = audioCtxRef.current; const master = masterRef.current
    if (!ctx || !master) return
    const buf = sfxBuffersRef.current.get(s.url)
    if (!buf) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    let node = src
    let g = null
    try {
      g = ctx.createGain(); g.gain.setValueAtTime(Math.max(0, Math.min(1, s.gain || 1)), when)
      node.connect(g); node = g
    } catch {}
    try {
      const p = ctx.createStereoPanner(); p.pan.setValueAtTime(Math.max(-1, Math.min(1, s.pan || 0)), when)
      node.connect(p); node = p
    } catch {}
    node.connect(master)
    const offsetSec = Math.max(0, (Number(s.offsetMs)||0) / 1000)
    try { src.start(when + offsetSec) } catch {}
  }

  function scheduleWindow(forceStart = false) {
    const ctx = audioCtxRef.current; if (!ctx || !song) return
    const lookahead = 0.25
    const nowBarsRaw = currentBarsRaw()
    const totalBars = song.bars
    const nowBars = ((nowBarsRaw % totalBars) + totalBars) % totalBars
    const nowStep = Math.floor(nowBars * song.stepsPerBar)
    if (Math.abs(schedRef.current.nextStep - nowStep) > song.stepsPerBar * song.bars) {
      schedRef.current.nextStep = nowStep
    }
    const endTime = ctx.currentTime + lookahead
    let first = true
    while (true) {
      const step = schedRef.current.nextStep
      const stepBars = (step / song.stepsPerBar) % totalBars
      const deltaBars = stepBars - nowBars
      let adj = deltaBars
      if (adj < -totalBars/2) adj += totalBars
      if (adj > totalBars/2) adj -= totalBars
      let when = ctx.currentTime + adj * secondsPerBar(tempo)
      if (forceStart && first) when = Math.max(ctx.currentTime + 0.02, when)
      if (when > endTime) break
      // ensure context is running (no await inside rAF loop)
      try { if (audioCtxRef.current && audioCtxRef.current.state !== 'running') audioCtxRef.current.resume().catch(()=>{}) } catch {}
      const total = song.bars * song.stepsPerBar
      // metronome (always schedule; mute notes during count-in)
      if (metronomeOn) {
        const beatStep = song.stepsPerBar / 4
        if (beatStep >= 1 && (step % Math.max(1, Math.floor(beatStep))) === 0) {
          const isBar = (step % song.stepsPerBar) === 0
          const f = isBar ? 1200 : 900
          const osc = ctx.createOscillator(); const g = ctx.createGain()
          osc.type = 'square'; osc.frequency.value = f
          g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(0.2, when + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.08)
          osc.connect(g); g.connect(masterRef.current); osc.start(when); osc.stop(when + 0.1)
        }
      }
      const inCountIn = countInRef.current.active && (step < countInRef.current.endStep)
      const stepMod = step % total
      const haveClips = Array.isArray(song.clips) && song.clips.length > 0
      if (haveClips) {
        for (const c of (song.clips || [])) {
          const clipStart = ((c.startStep % total) + total) % total
          const pat = (song.patterns||[]).find(p=>p.id===c.patternId) || activePattern
          const patBars = pat ? pat.bars : (patternBarsEff)
          const patSteps = Math.max(1, patBars) * song.stepsPerBar
          const clipLen = Math.max(1, Number(c.lengthSteps)|| patSteps)
          // Map global stepMod into clip local step
          let rel = stepMod - (clipStart % total)
          if (rel < 0) rel += total
          if (rel >= clipLen) continue
          // Schedule this clip's pattern notes relative to the clip
          const relMod = rel % patSteps
          const patNotes = pat ? (pat.notes||[]) : (song.notes||[])
          for (const n of patNotes) {
            const localStart = ((n.startStep % patSteps) + patSteps) % patSteps
            if (!inCountIn && localStart === relMod) {
              const remainingInClip = clipLen - rel
              const lengthSteps = Math.max(1, Math.min(remainingInClip, n.lengthSteps || 1))
              const durBars = lengthSteps / song.stepsPerBar
              const durSec = durBars * secondsPerBar(tempo)
              playNote(when, n.pitch || 60, n.velocity || 0.8, durSec, n.synth || 'Triangle')
            }
          }
        }
      } else {
        for (const n of (song.notes || [])) {
          const sIdx = ((n.startStep % total) + total) % total
          if (!inCountIn && sIdx === stepMod) {
            const lengthSteps = Math.max(1, n.lengthSteps || 1)
            const durBars = lengthSteps / song.stepsPerBar
            const durSec = durBars * secondsPerBar(tempo)
            playNote(when, n.pitch || 60, n.velocity || 0.8, durSec, n.synth || 'Triangle')
          }
        }
      }
      // SFX events
      for (const s of (song.sfx || [])) {
        const sIdx = ((s.startStep % total) + total) % total
        if (sIdx === stepMod && s.url) scheduleSfx(when, s)
      }
      schedRef.current.nextStep = step + 1
      first = false
    }
  }

  // Single rAF loop for playhead + scheduling
  useEffect(() => {
    function frame() {
      try {
        // schedule audio
        if (playing) scheduleWindow()
        // move markers
        const logicalSteps = (currentBarsVis() * song.stepsPerBar)
        const pxPattern = Math.round(logicalSteps * stepWPattern)
        const pxArr = Math.round(logicalSteps * stepWArr)
        if (rulerMarkerRef.current) {
          // Ruler is scaled to arrangement
          rulerMarkerRef.current.style.transform = `translateX(${pxArr}px)`
        }
        if (gridMarkerRef.current) {
          // Pattern grid marker uses unscaled step width
          gridMarkerRef.current.style.transform = `translateX(${pxPattern}px)`
          gridMarkerRef.current.style.opacity = (mode === 'pattern' || playing) ? '1' : '0'
        }
        if (arrMarkerRef.current) {
          arrMarkerRef.current.style.transform = `translateX(${pxArr}px)`
          arrMarkerRef.current.style.opacity = (mode === 'arrangement' || playing) ? '1' : '0'
        }
        if (arrRulerMarkerRef.current) {
          arrRulerMarkerRef.current.style.transform = `translateX(${pxArr}px)`
          arrRulerMarkerRef.current.style.opacity = (mode === 'arrangement' || playing) ? '1' : '0'
        }
      } catch {}
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, tempo, baseBar, baseTsMs, song, zoomX, mode])

  // Prime audio on first pointer interaction
  useEffect(() => {
    function prime() { try { ensureAudio(); audioCtxRef.current?.resume?.() } catch {}; window.removeEventListener('pointerdown', prime) }
    window.addEventListener('pointerdown', prime)
    return () => window.removeEventListener('pointerdown', prime)
  }, [])

  // Keyboard + group operations
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.isComposing) return
      if (typingOn && e.code === 'Space') { e.preventDefault(); return }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
        // Copy selected notes to clipboardRef
        const sel = Array.from(selectedIds || [])
        if (sel.length > 0 && song) {
            const notes = (notesForEditor||[]).filter(n => sel.includes(n.id))
          if (notes.length) {
            const minStep = Math.min(...notes.map(n => n.startStep))
            clipboardRef.current = notes.map(n => ({ ...n, startStep: n.startStep - minStep }))
          }
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
        // Paste at last mouse position (or current step 0)
        const items = clipboardRef.current
        if (items && items.length && song) {
          const base = Math.max(0, Math.min(song.bars*song.stepsPerBar-1, snapStep(lastMouseStepRef.current||0)))
          const ops = []
          const newIds = []
          for (const it of items) {
            const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
            newIds.push(id)
            ops.push({ type:'note_add', id, pitch: it.pitch, startStep: base + it.startStep, lengthSteps: it.lengthSteps, velocity: it.velocity, synth: it.synth })
          }
          // optimistic add
          setSong(prev => prev ? { ...prev, notes: [...(prev.notes||[]), ...ops.map(o=>({ id:o.id, pitch:o.pitch, startStep:o.startStep, lengthSteps:o.lengthSteps, velocity:o.velocity, synth:o.synth }))] } : prev)
          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
          setSelectedIds(new Set(newIds))
        }
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
        // Duplicate selection to the right by its own width
        const sel = Array.from(selectedIds || [])
        if (sel.length && song) {
            const notes = (notesForEditor||[]).filter(n => sel.includes(n.id))
          const width = Math.max(1, Math.max(...notes.map(n => n.startStep + n.lengthSteps)) - Math.min(...notes.map(n => n.startStep)))
          const ops = []
          const newIds = []
          for (const n of notes) {
            const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
            newIds.push(id)
            ops.push({ type:'note_add', id, pitch: n.pitch, startStep: n.startStep + width, lengthSteps: n.lengthSteps, velocity: n.velocity, synth: n.synth })
          }
          setSong(prev => prev ? { ...prev, notes: [...(prev.notes||[]), ...ops.map(o=>({ id:o.id, pitch:o.pitch, startStep:o.startStep, lengthSteps:o.lengthSteps, velocity:o.velocity, synth:o.synth }))] } : prev)
          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
          setSelectedIds(new Set(newIds))
        }
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        if (playing) handleStop(); else handlePlay()
      } else if ((e.code === 'Delete' || e.code === 'Backspace') && (selectedId || (selectedIds && selectedIds.size > 0))) {
        e.preventDefault()
        const ops = []
        if (selectedId) ops.push({ type:'note_delete', id: selectedId })
        if (selectedIds && selectedIds.size > 0) {
          for (const id of selectedIds) ops.push({ type:'note_delete', id })
        }
        if (ops.length) {
          setSong(prev => prev ? { ...prev, notes: (prev.notes||[]).filter(n => !ops.some(o => o.id === n.id)) } : prev)
          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
        }
        setSelectedId(null); setSelectedIds(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing, selectedId, selectedIds, rev, songId, song, typingOn])

  function handlePlay() {
    ensureAudio(); try { audioCtxRef.current?.resume?.() } catch {}
    const nowBars = currentBarsRaw()
    setPlaying(true); setBaseBar(nowBars); setBaseTsMs(Date.now())
    if (countInOn) { countInRef.current = { active: true, endStep: Math.floor((nowBars + 1) * (song?.stepsPerBar || 16)) } } else { countInRef.current.active = false }
    try { scheduleWindow(true) } catch {}
    try { socket?.emit?.('seq_transport', { songId, playing: true, positionBars: nowBars, tempo }) } catch {}
  }
  function handleStop() {
    setPlaying(false)
    countInRef.current.active = false
    try { socket?.emit?.('seq_transport', { songId, playing: false, positionBars: currentBarsRaw(), tempo }) } catch {}
  }

  // Add a note (optimistic), default length 4 steps
  function addNoteAt(pitch, step, lengthSteps = placeLenSteps, velocity = 0.8) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2)
    setSong(prev => {
      if (!prev) return prev
      const list = Array.isArray(prev.notes) ? prev.notes.slice() : []
      list.push({ id, pitch, startStep: step, lengthSteps, velocity, synth })
      return { ...prev, notes: list }
    })
    try {
      socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'note_add', id, pitch, startStep: step, lengthSteps, velocity, synth, patternId: activePatternId }] })
    } catch {}
  }

  // Note dragging helpers
  function updateNoteLocal(id, updater) {
    setSong(prev => {
      if (!prev) return prev
      const list = Array.isArray(prev.notes) ? prev.notes.slice() : []
      const idx = list.findIndex(n => n.id === id)
      if (idx < 0) return prev
      const updated = { ...list[idx] }
      updater(updated, prev)
      list[idx] = updated
      return { ...prev, notes: list }
    })
  }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }
  function pxToStep(px) { return Math.floor(px / STEP_UNIT) }
  function snapStep(step) { return Math.round(step / snap) * snap }
  // Ensure pattern previews hook is always called (avoid hook order issues)
  useEffect(() => {
    if (!song) return
    const pats = song.patterns || []
    const scale = (STEP_UNIT * zoomX * ARR_SCALE)
    let built = false
    for (const p of pats) {
      const key = `${p.id}@${scale.toFixed(4)}`
      const width = Math.max(1, Math.round((p.bars * song.stepsPerBar) * scale))
      const height = Math.max(6, ARR_TRACK_H - 8)
      const c = document.createElement('canvas')
      c.width = width; c.height = height
      const ctx = c.getContext('2d')
      ctx.clearRect(0,0,width,height)
      const h2 = 2
      // Dynamic pitch mapping based on pattern content
      let pmin = Infinity, pmax = -Infinity
      for (const n of (p.notes||[])) {
        const pi = Number(n.pitch)||60; if (pi < pmin) pmin = pi; if (pi > pmax) pmax = pi
      }
      if (!isFinite(pmin) || !isFinite(pmax)) { pmin = 48; pmax = 83 }
      if (pmax === pmin) pmax = pmin + 1
      const pitchRange = Math.max(1, (pmax - pmin + 1))
      for (const n of (p.notes||[])) {
        const x = Math.round(n.startStep * scale)
        const w = Math.max(1, Math.round(n.lengthSteps * scale))
        const color = (PREVIEW_COLOR && PREVIEW_COLOR[n.synth]) || 'rgba(255,255,255,0.45)'
        ctx.fillStyle = color
        const pitch = Math.max(pmin, Math.min(pmax, Number(n.pitch)||60))
        // Map highest pitch to top
        const rel = (pmax - pitch) / pitchRange
        const y = Math.max(0, Math.min(height - h2, Math.round(rel * (height - h2))))
        ctx.fillRect(x, y, w, h2)
      }
      try { patternPreviewRef.current.set(key, c.toDataURL()) } catch {}
      built = true
    }
    if (built) setPreviewVersion(v=>v+1)
  }, [song, zoomX])
  function arrSnapSteps() {
    const spb = song?.stepsPerBar || 16
    if (arrSnap === '1/8') return Math.max(1, Math.floor(spb / 8))
    if (arrSnap === '1/4') return Math.max(1, Math.floor(spb / 4))
    if (arrSnap === '1/2') return Math.max(1, Math.floor(spb / 2))
    return spb // '1' bar
  }
  function snapStepArr(step) { const s = arrSnapSteps(); return Math.round(step / s) * s }
  function hasOverlap(track, startStep, lengthSteps) {
    const end = startStep + lengthSteps
    for (const c of (song?.clips || [])) {
      if (Number(c.track) !== Number(track)) continue
      const ce = c.startStep + c.lengthSteps
      if (startStep < ce && end > c.startStep) return true
    }
    return false
  }

  if (!song) {
    return (
      <div className="w-full h-full bg-black text-white grid place-items-center">
        <div className="text-zinc-400">Loading sequencer…</div>
      </div>
    )
  }

  const activePatternId = song?.activePatternId || (song?.patterns && song.patterns[0]?.id) || 'p1'
  const activePattern = (song?.patterns || []).find(p => p.id === activePatternId)
  const notesForEditor = activePattern ? (activePattern.notes || []) : (song.notes || [])
  const patternBarsEff = activePattern ? activePattern.bars : (patternBars || 4)
  const patternSteps = Math.max(1, patternBarsEff) * song.stepsPerBar
  const arrSteps = song.bars * song.stepsPerBar
  
  return (
    <div ref={rootRef} className="w-full h-full bg-black text-white relative">
      <div className="absolute top-3 left-3 z-50 flex items-center gap-2">
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={onBack}>Back</button>
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={handlePlay}>Play</button>
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={handleStop}>Stop</button>
        <div className="px-2 py-1 text-xs bg-white/5 rounded">Tempo {tempo}</div>
        <div className="flex items-center gap-1 text-xs">
          <span>Mode</span>
          <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={mode} onChange={(e)=> setMode(e.target.value)}>
            <option value="pattern">Pattern</option>
            <option value="arrangement">Arrangement</option>
          </select>
        </div>
      </div>
      <div className="px-6 pt-16">
          <div className="flex items-center gap-3 text-xs text-zinc-400 mb-2">
          <div>Tempo {tempo}</div>
          <div>• {song.bars} bars • {song.stepsPerBar} steps/bar</div>
          <div className="flex items-center gap-1">
            <span>Snap</span>
            <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={snap} onChange={(e)=> setSnap(Number(e.target.value) || 1)}>
              <option value={1}>1/16</option>
              <option value={2}>1/8</option>
              <option value={4}>1/4</option>
              <option value={8}>1/2</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span>Pattern Bars</span>
            <input className="w-16 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" type="number" min="1" max="256" value={patternBarsEff}
              onChange={(e)=> {
                const nb = Math.max(1, Math.min(256, Number(e.target.value)||patternBarsEff))
                try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_update', id: activePatternId, bars: nb }] }) } catch {}
              }} />
          </div>
          <div className="flex items-center gap-1">
            <span>Pattern</span>
            <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={activePatternId}
                    onChange={(e)=>{ const id = e.target.value; try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_select', id }] }) } catch {} }}>
              {(song.patterns||[{id:'p1',name:'Pattern 1'}]).map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                    onClick={()=>{ const id='p'+Date.now().toString(36)+Math.random().toString(36).slice(2); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_add', id, name:'Pattern '+((song.patterns||[]).length+1), bars: 4 }] }) } catch {} }}>+ New</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                    onClick={()=>{ const name=prompt('Rename pattern', (activePattern?.name||'')); if(name){ try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_update', id: activePatternId, name }] }) } catch {} } }}>Rename</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20"
                    onClick={()=>{ if(confirm('Delete this pattern?')){ try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_delete', id: activePatternId }] }) } catch {} } }}>Delete</button>
          </div>
          <div className="flex items-center gap-1">
            <span>Synth</span>
            <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={synth} onChange={(e)=> setSynth(e.target.value)}>
              {SYNTHS.map(s => (<option key={s} value={s}>{s}</option>))}
            </select>
          </div>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={metronomeOn} onChange={(e)=> setMetronomeOn(e.target.checked)} /> Metronome</label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={countInOn} onChange={(e)=> setCountInOn(e.target.checked)} /> Count‑in</label>
          <div className="flex items-center gap-2">
            <span>Zoom H</span>
            <input type="range" min="0.5" max="2" step="0.1" value={zoomX} onChange={(e)=> setZoomX(Number(e.target.value))} />
            <span>V</span>
            <input type="range" min="0.5" max="2" step="0.1" value={zoomY} onChange={(e)=> setZoomY(Number(e.target.value))} />
          </div>
          <div className="opacity-70">Space: Play/Pause • Right‑click: Delete</div>
        </div>
        {/* Timeline ruler with bar numbers; click/drag to seek */}
          <div className="flex items-center mb-2">
          <div style={{ width: '60px' }} />
          <div ref={rulerScrollRef} className="overflow-auto" style={{ width: '100%' }} onScroll={(e)=>{
            try {
              if (scrollSyncRef.current) return; scrollSyncRef.current = true
              const barsScrolled = (e.currentTarget.scrollLeft) / (song.stepsPerBar * stepWPattern)
              if (gridScrollRef.current) gridScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
              if (arrScrollRef.current) arrScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWArr
            } finally { scrollSyncRef.current = false }
          }}>
          <div
            ref={rulerRef}
            className="relative select-none"
            style={{ height: `${RULER_H}px`, width: `${Math.round(arrSteps*stepWArr)}px`,
                     backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.14) 0, rgba(255,255,255,0.14) 1px, transparent 1px, transparent ${song.stepsPerBar*STEP_UNIT}px),
                                       repeating-linear-gradient(to right, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 1px, transparent 1px, transparent ${4*STEP_UNIT}px),
                                       repeating-linear-gradient(to right, rgba(255,255,255,0.04) 0, rgba(255,255,255,0.04) 1px, transparent 1px, transparent ${STEP_UNIT}px)`,
                     backgroundPosition: '0.5px 0px, 0.5px 0px, 0.5px 0px', backgroundRepeat: 'repeat' }}
            onMouseDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
            const bars = step / song.stepsPerBar
            const shouldPlay = e.shiftKey || playing
            // local transport update
            setBaseBar(bars)
            setBaseTsMs(Date.now())
            schedRef.current.nextStep = Math.floor(bars * song.stepsPerBar)
            if (shouldPlay) {
              setPlaying(true)
              ensureAudio(); try { audioCtxRef.current?.resume?.() } catch {}
              scheduleWindow(true)
            } else {
              setPlaying(false)
            }
            // Defer broadcast until mouse up to avoid spamming while scrubbing
            dragRef.current = { active: true, shift: shouldPlay }
            }}
            onMouseMove={(e) => {
            if (!dragRef.current.active) return
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStep(rawStep)))
            const bars = step / song.stepsPerBar
            setBaseBar(bars); setBaseTsMs(Date.now())
            }}
            onMouseUp={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStep(rawStep)))
            const bars = step / song.stepsPerBar
            try { socket?.emit?.('seq_transport', { songId, playing: dragRef.current.shift, positionBars: bars, tempo }) } catch {}
            dragRef.current.active = false
            }}
            onMouseLeave={() => { dragRef.current.active = false }}
          >
            {/* Current position marker */}
            <div ref={rulerMarkerRef} className="absolute top-0 h-full" style={{ transform: 'translateX(0px)', willChange: 'transform' }}>
              <div className="w-[1px] h-full bg-yellow-400" />
            </div>
            {/* Bar numbers */}
            {Array.from({ length: song.bars }).map((_, i) => (
              <div key={i} className="absolute text-[10px] text-zinc-400"
                   style={{ left: `${i*song.stepsPerBar*STEP_UNIT + 4}px`, top: '2px' }}>{i+1}</div>
            ))}
          </div>
          </div>
        </div>
        {/* Keybed + grid (multi-octave) */}
        <div className="flex items-start">
          <div className="select-none" style={{ width: '60px' }}>
            {PITCHES_DESC.map(m => {
              const k = midiToName(m)
              const isSharp = k.includes('#')
              return (
                <div key={m} className="flex items-center justify-end pr-2 text-[10px]" style={{ height: `${Math.round(ROW_UNIT*zoomY)}px`, background: isSharp?'#1b1b1b':'#111' }}>{k}</div>
              )
            })}
          </div>
          <div ref={gridScrollRef} className="overflow-auto" style={{ width: '100%', cursor: 'default' }} onScroll={(e)=>{
            try {
              if (scrollSyncRef.current) return; scrollSyncRef.current = true
              const barsScrolled = (e.currentTarget.scrollLeft) / (song.stepsPerBar * stepWPattern)
              if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
              if (arrScrollRef.current) arrScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWArr
            } finally { scrollSyncRef.current = false }
          }}
            onWheel={(e)=>{
              if (e.altKey) {
                e.preventDefault()
                const factor = e.deltaY > 0 ? 0.95 : 1.05
                setZoomX(z => Math.max(0.5, Math.min(2, Number((z * factor).toFixed(2)))))
              } else if (e.shiftKey) {
                // horizontal scroll
                e.preventDefault()
                try {
                  const by = e.deltaY
                  e.currentTarget.scrollLeft += by
                  if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = e.currentTarget.scrollLeft
                } catch {}
              }
            }}
            onMouseDown={(e)=>{
              if (e.button === 1 || (e.button === 0 && e.shiftKey === false && e.altKey === false && e.ctrlKey === false && e.metaKey === false && e.target === e.currentTarget)) {
                // middle mouse: start panning
                const startX = e.clientX; const startY = e.clientY
                const startSL = e.currentTarget.scrollLeft; const startST = e.currentTarget.scrollTop
                const onMove = (ev)=>{
                  e.currentTarget.scrollLeft = startSL - (ev.clientX - startX)
                  e.currentTarget.scrollTop = startST - (ev.clientY - startY)
                  if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = e.currentTarget.scrollLeft
                }
                const onUp = ()=>{ window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
                window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
              }
            }}
          >
          <div ref={gridRef}
            className="relative overflow-hidden"
            style={{ width: `${Math.round(patternSteps*stepWPattern)}px`, height: `${Math.round(PITCH_COUNT*ROW_UNIT*zoomY)}px`,
                     backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 1px, transparent 1px, transparent ${Math.round(STEP_UNIT*zoomX)}px),
                                      repeating-linear-gradient(to bottom, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${Math.round(ROW_UNIT*zoomY)}px),
                                      repeating-linear-gradient(to bottom, rgba(255,255,255,0.10) 0, rgba(255,255,255,0.10) 1px, transparent 1px, transparent ${Math.round(ROW_UNIT*zoomY)*12}px)`,
                     backgroundPosition: '0.5px 0px, 0px 0.5px, 0px 0.5px' }}
            onMouseDown={(e) => {
              if (mode === 'arrangement') return // pattern seek disabled in arrangement mode
              // Start marquee only when holding Shift; plain click will place notes
              if (e.button !== 0 || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
              e.preventDefault(); e.stopPropagation()
              const host = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - host.left)
              const y = e.clientY - host.top
              marqueeRef.current = { active: true, x0: x, y0: y, x1: x, y1: y }
              setMarqueeBox({ x, y, w: 0, h: 0 })
              const onMove = (ev) => {
                const xm = ev.clientX - host.left
                const ym = ev.clientY - host.top
                marqueeRef.current.x1 = xm; marqueeRef.current.y1 = ym
                const xMin = Math.min(marqueeRef.current.x0, xm)
                const yMin = Math.min(marqueeRef.current.y0, ym)
                const xMax = Math.max(marqueeRef.current.x0, xm)
                const yMax = Math.max(marqueeRef.current.y0, ym)
                setMarqueeBox({ x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin })
              }
              const onUp = () => {
                window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                const box = marqueeRef.current; marqueeRef.current.active = false
                setMarqueeBox(null); suppressClickRef.current = true
                if (!song) return
                const xMin = Math.min(box.x0, box.x1), xMax = Math.max(box.x0, box.x1)
                const yMin = Math.min(box.y0, box.y1), yMax = Math.max(box.y0, box.y1)
                const stepMin = Math.floor(xMin / (STEP_UNIT*zoomX))
                const stepMax = Math.floor(xMax / (STEP_UNIT*zoomX))
                const rowMin = Math.floor(yMin / (ROW_UNIT*zoomY))
                const rowMax = Math.floor(yMax / (ROW_UNIT*zoomY))
                const pitchMin = PITCH_MAX - rowMax
                const pitchMax = PITCH_MAX - rowMin
                const sel = new Set()
                for (const n of (notesForEditor||[])) {
                  const nx0 = n.startStep; const nx1 = n.startStep + n.lengthSteps
                  const ny = n.pitch
                  if (nx1 >= stepMin && nx0 <= stepMax && ny >= pitchMin && ny <= pitchMax) sel.add(n.id)
                }
                setSelectedIds(sel); setSelectedId(sel.size === 1 ? Array.from(sel)[0] : null)
              }
              window.addEventListener('mousemove', onMove, { passive:false }); window.addEventListener('mouseup', onUp)
            }}
            onClick={(e) => {
              if (mode === 'arrangement') return
              if (suppressClickRef.current) { suppressClickRef.current = false; return }
              const host = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - host.left)
              const y = e.clientY - host.top
              const step = Math.max(0, Math.min(patternSteps - 1, Math.floor(x / (stepWPattern))))
              lastMouseStepRef.current = step
              const row = Math.max(0, Math.min(PITCH_COUNT - 1, Math.floor(y / (ROW_UNIT*zoomY))))
              const pitch = PITCH_MAX - row
              addNoteAt(pitch, step)
            }}
            onMouseMove={(e) => {
              // section-aware cursor for pattern grid
              const rect0 = e.currentTarget.getBoundingClientRect()
              const sx = (e.clientX - rect0.left) / Math.max(1, rect0.width)
              const sy = (e.clientY - rect0.top) / Math.max(1, rect0.height)
              if (sx>=0 && sx<=1 && sy>=0 && sy<=1) emitCursor({ sect: 'pattern_grid', sx, sy }, true)
              if (marqueeRef.current.active) {
                const rect1 = e.currentTarget.getBoundingClientRect()
                const xm = e.clientX - rect1.left
                const ym = e.clientY - rect1.top
                marqueeRef.current.x1 = xm; marqueeRef.current.y1 = ym
                const xMin = Math.min(marqueeRef.current.x0, xm)
                const yMin = Math.min(marqueeRef.current.y0, ym)
                const xMax = Math.max(marqueeRef.current.x0, xm)
                const yMax = Math.max(marqueeRef.current.y0, ym)
                setMarqueeBox({ x: xMin, y: yMin, w: xMax - xMin, h: yMax - yMin })
                return
              }
              if (!noteDragRef.current.active) return
              const rect2 = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect2.left
              const deltaSteps = snapStep(pxToStep((x - noteDragRef.current.startX) / zoomX))
              if (noteDragRef.current.mode === 'move') {
                const base = noteDragRef.current
                const y = e.clientY - rect.top
                const deltaRows = Math.round((y - base.startY) / (ROW_UNIT*zoomY))
                const newGroupMin = clamp(base.groupMinStart + deltaSteps, 0, patternSteps - Math.max(1, base.groupMaxEnd - base.groupMinStart))
                const appliedDelta = newGroupMin - base.groupMinStart
                setSong(prev => {
                  if (!prev) return prev
                  if (prev.patterns && prev.activePatternId) {
                    const pats = prev.patterns.map(p => {
                      if (p.id !== prev.activePatternId) return p
                      const list = (p.notes||[]).slice()
                      for (let i=0;i<list.length;i++) {
                        const q = list[i]
                        if (base.groupIds && base.groupIds.includes(q.id)) {
                          const orig = base.startsById[q.id] ?? q.startStep
                          const origPitch = base.pitchById[q.id] ?? q.pitch
                          const nextPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, origPitch - deltaRows))
                          list[i] = { ...q, startStep: clamp(orig + appliedDelta, 0, patternSteps - q.lengthSteps), pitch: nextPitch, synth: q.synth ?? 'Triangle' }
                        }
                      }
                      return { ...p, notes: list }
                    })
                    return { ...prev, patterns: pats }
                  } else {
                    const list = (prev.notes||[]).slice()
                    for (let i=0;i<list.length;i++) {
                      const q = list[i]
                      if (base.groupIds && base.groupIds.includes(q.id)) {
                        const orig = base.startsById[q.id] ?? q.startStep
                        const origPitch = base.pitchById[q.id] ?? q.pitch
                        const nextPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, origPitch - deltaRows))
                        list[i] = { ...q, startStep: clamp(orig + appliedDelta, 0, patternSteps - q.lengthSteps), pitch: nextPitch, synth: q.synth ?? 'Triangle' }
                      }
                    }
                    return { ...prev, notes: list }
                  }
                })
              } else {
                const newLen = clamp(noteDragRef.current.startLen + deltaSteps, 1, patternSteps - noteDragRef.current.startStep)
                setSong(prev => {
                  if (!prev) return prev
                  if (prev.patterns && prev.activePatternId) {
                    const pats = prev.patterns.map(p => {
                      if (p.id !== prev.activePatternId) return p
                      const list = (p.notes||[]).slice()
                      const idx = list.findIndex(n => n.id === noteDragRef.current.id)
                      if (idx < 0) return p
                      list[idx] = { ...list[idx], lengthSteps: newLen, synth: list[idx].synth ?? 'Triangle' }
                      return { ...p, notes: list }
                    })
                    if (selectedId === noteDragRef.current.id) setPlaceLenSteps(newLen)
                    return { ...prev, patterns: pats }
                  } else {
                    const list = (prev.notes||[]).slice()
                    const idx = list.findIndex(n => n.id === noteDragRef.current.id)
                    if (idx < 0) return prev
                    list[idx] = { ...list[idx], lengthSteps: newLen, synth: list[idx].synth ?? 'Triangle' }
                    if (selectedId === noteDragRef.current.id) setPlaceLenSteps(newLen)
                    return { ...prev, notes: list }
                  }
                })
              }
            }}
            onMouseUp={(e) => {
              if (marqueeRef.current.active) {
                // handled by mouseup registered during start; but ensure we don't add a note
                suppressClickRef.current = true
                return
              }
              if (!noteDragRef.current.active) return
              const base = noteDragRef.current
              noteDragRef.current.active = false
              if (base.mode === 'move' && base.groupIds && base.groupIds.length > 0) {
                const ops = []
                for (const gid of base.groupIds) {
              const n = (notesForEditor || []).find(x => x.id === gid); if (!n) continue
                  ops.push({ type:'note_update', id: gid, startStep: n.startStep, lengthSteps: n.lengthSteps, pitch: n.pitch })
                }
                if (ops.length) try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
                return
              }
              const id = base.id
              const n = (notesForEditor || []).find(x => x.id === id)
              if (!n) return
              try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'note_update', id, startStep: n.startStep, lengthSteps: n.lengthSteps }] }) } catch {}
            }}
            onWheel={(e)=>{
              if (e.shiftKey || e.altKey) return; // handled by wrapper
              // default vertical scroll (let wrapper manage)
            }}
          >
            {/* Playhead over grid */}
            <div ref={gridMarkerRef} data-marker="1" className="absolute top-0 h-full" style={{ transform: 'translateX(0px)', willChange: 'transform' }}>
              <div className="w-[1px] h-full bg-yellow-400/80" />
            </div>
            {/* Marquee box */}
            {marqueeBox && (
              <div className="absolute border border-yellow-400/60 bg-yellow-400/10 pointer-events-none" style={{ left: Math.min(marqueeBox.x, marqueeBox.x+marqueeBox.w), top: Math.min(marqueeBox.y, marqueeBox.y+marqueeBox.h), width: Math.abs(marqueeBox.w), height: Math.abs(marqueeBox.h) }} />
            )}
            {(notesForEditor||[]).map(n => {
              const row = (PITCH_MAX - n.pitch); if (row<0||row>(PITCH_COUNT-1)) return null
              const x = Math.round(n.startStep*STEP_UNIT*zoomX); const w = Math.max(Math.round(STEP_UNIT*zoomX)-2, Math.round(n.lengthSteps*STEP_UNIT*zoomX)-2); const y=Math.round(row*ROW_UNIT*zoomY)
              const selected = selectedId === n.id
              return (
                <div
                  key={n.id}
                  data-note="1"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const alreadySelected = selectedIds && selectedIds.has(n.id)
                    if (e.shiftKey) {
                      // Shift is now marquee modifier; keep simple select on note click
                    } else if (!alreadySelected) {
                      setSelectedIds(new Set([n.id]))
                    }
                    setSelectedId(n.id)
                    if (e.button !== 0) { return }
                    const rect = e.currentTarget.parentElement.getBoundingClientRect()
                    const localX = e.clientX - rect.left
                    const noteLeft = n.startStep * STEP_UNIT * zoomX
                    const isResize = (localX - noteLeft) > (w - 8)
                    if (isResize) {
                      noteDragRef.current = { active: true, id: n.id, mode: 'resize', startX: localX, startStep: n.startStep, startLen: n.lengthSteps }
                    } else {
                      const groupIds = (alreadySelected ? Array.from(selectedIds) : [n.id])
                      const startsById = {}; const pitchById = {}
                      let groupMinStart = Infinity; let groupMaxEnd = -Infinity
                      let groupMinPitch = Infinity; let groupMaxPitch = -Infinity
                      for (const gid of groupIds) {
                        const gn = (notesForEditor||[]).find(x => x.id === gid)
                        if (!gn) continue
                        startsById[gid] = gn.startStep
                        pitchById[gid] = gn.pitch
                        groupMinStart = Math.min(groupMinStart, gn.startStep)
                        groupMaxEnd = Math.max(groupMaxEnd, gn.startStep + gn.lengthSteps)
                        groupMinPitch = Math.min(groupMinPitch, gn.pitch)
                        groupMaxPitch = Math.max(groupMaxPitch, gn.pitch)
                      }
                      const localY = e.clientY - rect.top
                      noteDragRef.current = { active: true, id: n.id, mode: 'move', startX: localX, startY: localY, startStep: n.startStep, startLen: n.lengthSteps, groupIds, startsById, pitchById, groupMinStart, groupMaxEnd, groupMinPitch, groupMaxPitch }
                    }
                  }}
                  onClick={(e) => {
                    // double-click: adopt this note's length and synth for placement
                    if (e.detail === 2) {
                      setPlaceLenSteps(Math.max(1, n.lengthSteps || 1))
                      if (n.synth) setSynth(n.synth)
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault(); e.stopPropagation()
                    setSelectedId(n.id)
                    if (!selectedIds.has(n.id)) setSelectedIds(new Set([n.id]))
                    noteDragRef.current.active = false
                    // optimistic remove locally
                    const ids = Array.from(selectedIds.size ? selectedIds : new Set([n.id]))
                    setSong(prev => prev ? { ...prev, notes: (prev.notes||[]).filter(x => !ids.includes(x.id)) } : prev)
                    try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: ids.map(id => ({ type:'note_delete', id })) }) } catch {}
                  }}
                  className="absolute rounded-[3px] cursor-pointer group"
                  style={{ left:x, top:y, width:w, height:14,
                           background: SYNTH_COLOR[(n && n.synth) ? n.synth : (typeof n.synth === 'string' ? n.synth : 'Triangle')] || SYNTH_COLOR.Triangle,
                           boxShadow: (selected || (selectedIds && selectedIds.has(n.id))) ? 'inset 0 0 0 2px rgba(255,255,255,0.9)' : 'inset 0 0 0 1px rgba(0,0,0,0.25)'}}
                >
                  {/* resize handle */}
                  <div className="absolute right-0 top-0 h-full w-[6px] bg-white/10 opacity-0 group-hover:opacity-100" />
                </div>
              )
            })}
          </div>
        </div>
        {/* close piano-roll flex wrapper */}
        </div>
        {/* Arrangement timeline (4 tracks) */}
        <div className="mt-6">
          <div className="mb-2 flex items-center gap-3 text-xs text-zinc-400">
            <div>Arrangement</div>
            <label className="flex items-center gap-1">
              <span>Length</span>
              <input className="w-16 bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" type="number" min="1" max="999" step="0.5"
                     value={Math.max(1, Math.round((song.bars * secondsPerBar(tempo)) / 60 * 10) / 10)}
                     onChange={(e)=>{
                       const mins = Math.max(1, Math.min(999, Number(e.target.value)||((song.bars*secondsPerBar(tempo))/60)))
                       const totalSec = mins * 60
                       const newBars = Math.max(1, Math.round(totalSec / secondsPerBar(tempo)))
                       setSong(prev => prev ? { ...prev, bars: newBars } : prev)
                       try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_bars', bars: newBars }] }) } catch {}
                     }} />
              <span>min</span>
            </label>
            <label className="flex items-center gap-1">
              <span>Snap</span>
              <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={arrSnap} onChange={(e)=> setArrSnap(e.target.value)}>
                <option value="1">Bar</option>
                <option value="1/2">1/2</option>
                <option value="1/4">1/4</option>
                <option value="1/8">1/8</option>
              </select>
            </label>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input type="checkbox" checked={autoResizeClips} onChange={(e)=> setAutoResizeClips(e.target.checked)} /> Auto‑resize clips to Pattern
            </label>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={() => {
              // add a 4-bar clip at playhead on track 0
              const raw = Math.max(0, Math.min(arrSteps-1, Math.floor(currentBarsVis() * song.stepsPerBar)))
              let step = snapStepArr(raw)
              const lengthSteps = autoResizeClips ? patternSteps : Math.max(patternSteps, arrSnapSteps())
              if (step + lengthSteps > arrSteps) step = Math.max(0, arrSteps - lengthSteps)
              if (hasOverlap(0, step, lengthSteps)) return
              const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
              const ops = [{ type:'clip_add', id, track: 0, startStep: step, lengthSteps, patternId: activePatternId }]
              setSong(prev => prev ? { ...prev, clips: [...(prev.clips||[]), { id, track:0, startStep:step, lengthSteps, patternId: activePatternId }] } : prev)
              try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
            }}>Add Pattern Clip</button>
            <label className="flex items-center gap-1">
              <span>SFX</span>
              <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={currentSfxUrl} onChange={(e)=> setCurrentSfxUrl(e.target.value)}>
                <option value="">(none)</option>
                {sfxLib.map(x => (<option key={x.url} value={x.url}>{x.name}</option>))}
              </select>
            </label>
            <label className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 cursor-pointer">
              Upload SFX
              <input type="file" accept="audio/*" className="hidden" onChange={async (e) => {
                const f = e.target.files && e.target.files[0]
                if (!f) return
                ensureAudio()
                try {
                  const arr = await f.arrayBuffer()
                  const b64 = btoa(String.fromCharCode(...new Uint8Array(arr)))
                  socket?.emit?.('sfx_upload', { songId, name: f.name, dataBase64: b64 })
                } catch {}
              }} />
            </label>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={() => {
              if (!currentSfxUrl) return
              const step = Math.max(0, Math.min(arrSteps-1, Math.floor(currentBarsVis() * song.stepsPerBar)))
              const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
              const ops = [{ type:'sfx_add', id, track: 1, startStep: step, lengthSteps: 1, url: currentSfxUrl, gain: 1, pan: 0, offsetMs: 0 }]
              setSong(prev => prev ? { ...prev, sfx: [...(prev.sfx||[]), { id, track:1, startStep:step, lengthSteps:1, url: currentSfxUrl, gain:1, pan:0, offsetMs:0 }] } : prev)
              try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
              ;(async () => { await ensureSfxBuffer(currentSfxUrl) })()
            }}>Add SFX At Playhead</button>
          </div>
          {/* Arrangement ruler */}
          <div className="flex items-center mb-2">
            <div style={{ width: '60px' }} />
            <div ref={arrRulerScrollRef} className="overflow-auto" style={{ width: '100%' }} onScroll={(e)=>{
              try {
                if (scrollSyncRef.current) return; scrollSyncRef.current = true
                const barsScrolled = (e.currentTarget.scrollLeft) / (song.stepsPerBar * stepWArr)
                if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
                if (gridScrollRef.current) gridScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
                if (arrScrollRef.current) arrScrollRef.current.scrollLeft = e.currentTarget.scrollLeft
              } finally { scrollSyncRef.current = false }
            }}>
              <div ref={arrRulerRef} className="relative select-none" style={{ height: `${RULER_H}px`, width: `${Math.round(arrSteps*stepWArr)}px`, backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px, transparent ${song.stepsPerBar*stepWArr}px), repeating-linear-gradient(to right, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${stepWArr}px)`, backgroundPosition: '0.5px 0px, 0.5px 0px', backgroundRepeat: 'repeat' }}
                   onMouseDown={(e)=>{
                     const rect = e.currentTarget.getBoundingClientRect()
                     const x = (e.clientX - rect.left)
                     const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
                     const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                     const bars = step / song.stepsPerBar
                     setBaseBar(bars); setBaseTsMs(Date.now()); schedRef.current.nextStep = Math.floor(bars*song.stepsPerBar)
                   }}
              >
                <div ref={arrRulerMarkerRef} className="absolute top-0 h-full" style={{ transform: 'translateX(0px)', willChange: 'transform', opacity: 0 }}>
                  <div className="w-[1px] h-full bg-yellow-400" />
                </div>
                {Array.from({ length: song.bars }).map((_, i) => (
                  <div key={i} className="absolute text-[10px] text-zinc-400" style={{ left: `${Math.round(i*song.stepsPerBar*stepWArr) + 4}px`, top: '2px' }}>{i+1}</div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-start">
            <div className="select-none" style={{ width: '60px' }}>
              {Array.from({ length: ARR_TRACKS }).map((_, i) => (
                <div key={i} className="flex items-center justify-end pr-2 text-[10px]" style={{ height: `${ARR_TRACK_H}px`, background: i%2===0?'#111':'#151515' }}>Track {i+1}</div>
              ))}
            </div>
            <div ref={arrScrollRef} className="overflow-auto" style={{ width: '100%' }} onScroll={(e)=>{
              try {
                if (scrollSyncRef.current) return; scrollSyncRef.current = true
                const barsScrolled = (e.currentTarget.scrollLeft) / (song.stepsPerBar * stepWArr)
                if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
                if (gridScrollRef.current) gridScrollRef.current.scrollLeft = barsScrolled * song.stepsPerBar * stepWPattern
              } finally { scrollSyncRef.current = false }
            }}
              onMouseMove={(e)=>{
                if (!arrGridRef.current) return
                const rect = arrGridRef.current.getBoundingClientRect()
                const sx = (e.clientX - rect.left) / Math.max(1, rect.width)
                const sy = (e.clientY - rect.top) / Math.max(1, rect.height)
                // derive track and relative y inside that track band
                const yAbs = Math.max(0, Math.min(rect.height - 1, e.clientY - rect.top))
                const track = Math.max(0, Math.min(ARR_TRACKS - 1, Math.floor(yAbs / ARR_TRACK_H)))
                const ty = (yAbs - track * ARR_TRACK_H) / ARR_TRACK_H
                if (sx>=0 && sx<=1 && sy>=0 && sy<=1) emitCursor({ sect: 'arr_grid', sx, sy, track, ty }, true)
              }}
              onMouseDown={(e)=>{
                if (mode !== 'arrangement') return
                const host = (arrGridRef.current ? arrGridRef.current.getBoundingClientRect() : e.currentTarget.firstChild.getBoundingClientRect())
                const trackIdx = Math.max(0, Math.min(ARR_TRACKS-1, Math.floor((e.clientY - host.top) / ARR_TRACK_H)))
                const x = (e.clientX - host.left)
                const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
                const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                // section-aware cursor for arrangement grid with track-local y
                const sx = (e.clientX - host.left) / Math.max(1, host.width)
                const sy = (e.clientY - host.top) / Math.max(1, host.height)
                const yAbs = Math.max(0, Math.min(host.height - 1, e.clientY - host.top))
                const track = Math.max(0, Math.min(ARR_TRACKS - 1, Math.floor(yAbs / ARR_TRACK_H)))
                const ty = (yAbs - track * ARR_TRACK_H) / ARR_TRACK_H
                if (sx>=0 && sx<=1 && sy>=0 && sy<=1) emitCursor({ sect: 'arr_grid', sx, sy, track, ty }, true)
                placeRef.current = { active: true, dragging: false, track: trackIdx, startStep: step, lengthSteps: 0, startX: e.clientX, startY: e.clientY, valid: true }
                setGhost({ on: true, left: Math.round(step*stepWArr), top: trackIdx*ARR_TRACK_H+6, width: Math.max(1, Math.round((autoResizeClips?patternSteps:arrSnapSteps())*stepWArr)), bad: hasOverlap(trackIdx, step, (autoResizeClips?patternSteps:arrSnapSteps())) })
                const onMove = (ev) => {
                  if (!placeRef.current.active) return
                  const moved = Math.hypot(ev.clientX - placeRef.current.startX, ev.clientY - placeRef.current.startY)
                  const threshold = 3
                  if (!placeRef.current.dragging && moved > threshold) placeRef.current.dragging = true
                  const xm = Math.max(0, Math.floor((ev.clientX - host.left) / stepWArr))
                  const endStepRaw = Math.max(step, xm)
                  const snapLenMin = autoResizeClips ? patternSteps : arrSnapSteps()
                  let len = placeRef.current.dragging ? Math.max(snapLenMin, snapStepArr(endStepRaw) - step) : snapLenMin
                  if (step + len > arrSteps) len = Math.max(snapLenMin, arrSteps - step)
                  const overlap = hasOverlap(trackIdx, step, len)
                  placeRef.current.lengthSteps = len; placeRef.current.valid = !overlap
                  // update arrangement section coords continuously
                  const sx = (ev.clientX - host.left) / Math.max(1, host.width)
                  const sy = (ev.clientY - host.top) / Math.max(1, host.height)
                  const yAbs2 = Math.max(0, Math.min(host.height - 1, ev.clientY - host.top))
                  const track2 = Math.max(0, Math.min(ARR_TRACKS - 1, Math.floor(yAbs2 / ARR_TRACK_H)))
                  const ty2 = (yAbs2 - track2 * ARR_TRACK_H) / ARR_TRACK_H
                  if (sx>=0 && sx<=1 && sy>=0 && sy<=1) emitCursor({ sect: 'arr_grid', sx, sy, track: track2, ty: ty2 }, true)
                  setGhost({ on: true, left: Math.round(step*stepWArr), top: trackIdx*ARR_TRACK_H+6, width: Math.max(1, Math.round(len*stepWArr)), bad: overlap })
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                  const st = placeRef.current; placeRef.current.active = false
                  setGhost({ on: false, left: 0, top: 0, width: 0, bad: false })
                  const snapLenMin = autoResizeClips ? patternSteps : arrSnapSteps()
                  const finalLen = st.dragging ? st.lengthSteps : snapLenMin
                  if (finalLen <= 0) return
                  if (st.startStep + finalLen > arrSteps) return
                  if (!st.valid) return
                  const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
                  const clip = { id, track: st.track, startStep: st.startStep, lengthSteps: finalLen }
                  setSong(prev => prev ? { ...prev, clips: [...(prev.clips||[]), clip] } : prev)
                  try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type:'clip_add', ...clip }] }) } catch {}
                }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
            >
            <div ref={arrGridRef} className="relative" style={{ width: `${Math.round(arrSteps*stepWArr)}px`, height: `${ARR_TRACKS*ARR_TRACK_H}px` }}>
                {/* grid */}
                <div className="absolute inset-0"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px, transparent ${Math.round(song.stepsPerBar*stepWArr)}px),
                                      repeating-linear-gradient(to right, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${Math.round(stepWArr)}px),
                                      repeating-linear-gradient(to bottom, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${ARR_TRACK_H}px)`,
                    backgroundPosition: '0.5px 0.5px, 0.5px 0.5px, 0.5px 0.5px'
                  }} />
                {/* Ghost clip */}
                {ghost.on && (
                  <div className={ghost.bad ? "absolute rounded border border-red-400/70 bg-red-500/20 pointer-events-none" : "absolute rounded border border-blue-300/70 bg-blue-400/20 pointer-events-none"}
                       style={{ left: ghost.left + 'px', top: ghost.top + 'px', width: ghost.width + 'px', height: (ARR_TRACK_H-12) + 'px' }} />
                )}
                {/* Arrangement playhead */}
                <div ref={arrMarkerRef} className="absolute top-0 h-full" style={{ transform: 'translateX(0px)', willChange: 'transform', opacity: 0 }}>
                  <div className="w-[1px] h-full bg-yellow-400/70" />
                </div>
                {/* clips */}
                {(song.clips||[]).map(c => {
                  const x = Math.round(c.startStep*stepWArr)
                  const w = Math.max(6, Math.round((c.lengthSteps)*stepWArr)-2)
                  const y = c.track * ARR_TRACK_H
                  const pat = (song.patterns||[]).find(p=>p.id===c.patternId) || activePattern
                  const key = pat ? `${pat.id}@${stepWArr.toFixed(4)}` : ''
                  const bg = key ? (patternPreviewRef.current.get(key) || '') : ''
                  return (
                    <div key={c.id} className="absolute rounded bg-blue-500/60 border border-blue-300/50"
                      style={{ left:x, top:y+4, width:w, height:ARR_TRACK_H-8, backgroundImage: bg?`url(${bg})`:'none', backgroundSize: `${pat?Math.round((pat.bars*song.stepsPerBar)*stepWArr):Math.round(patternSteps*stepWArr)}px ${ARR_TRACK_H-8}px`, backgroundRepeat:'repeat-x', backgroundPosition: `0px 0px` }}
                      data-prev={previewVersion}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return
                        e.preventDefault(); e.stopPropagation()
                        const host = e.currentTarget.parentElement.getBoundingClientRect()
                        const startX = e.clientX - host.left
                        const startStep = c.startStep
                        const startLen = c.lengthSteps
                        const isResize = (startX - x) > (w - 10)
                        const onMove = (ev) => {
                          const xm = ev.clientX - host.left
                          const delta = snapStep(pxToStep((xm - startX) / zoomX))
                          if (isResize) {
                            const newLen = clamp(startLen + delta, 1, arrSteps - startStep)
                            setSong(prev => prev ? { ...prev, clips: (prev.clips||[]).map(q => q.id===c.id?{...q, lengthSteps:newLen}:q) } : prev)
                          } else {
                            const newStart = clamp(startStep + delta, 0, arrSteps - startLen)
                            setSong(prev => prev ? { ...prev, clips: (prev.clips||[]).map(q => q.id===c.id?{...q, startStep:newStart}:q) } : prev)
                          }
                        }
                        const onUp = (ev) => {
                          window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                          const cur = (song?.clips||[]).find(q => q.id === c.id)
                          if (!cur) return
                          const op = isResize ? { type:'clip_update', id:c.id, lengthSteps: cur.lengthSteps } : { type:'clip_update', id:c.id, startStep: cur.startStep }
                          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [op] }) } catch {}
                        }
                        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
                      }}
                      onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); setSong(prev => prev ? { ...prev, clips: (prev.clips||[]).filter(q => q.id !== c.id) } : prev); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'clip_delete', id:c.id }] }) } catch {} }}
                    />
                  )
                })}
                {/* sfx */}
                {(song.sfx||[]).map(s => {
                  const x = Math.round(s.startStep*stepWArr)
                  const w = Math.max(4, Math.round((s.lengthSteps)*stepWArr)-2)
                  const y = s.track * ARR_TRACK_H
                  return (
                    <div key={s.id} className="absolute rounded bg-rose-500/60 border border-rose-300/50"
                      style={{ left:x, top:y+8, width:w, height:ARR_TRACK_H-16 }}
                      title={s.url}
                      onMouseDown={(e)=>{
                        if (e.button !== 0) return
                        e.preventDefault(); e.stopPropagation()
                        const host = e.currentTarget.parentElement.getBoundingClientRect()
                        const startX = e.clientX - host.left
                        const startStep = s.startStep
                        const onMove = (ev) => {
                          const xm = ev.clientX - host.left
                          const delta = snapStep(pxToStep((xm - startX) / zoomX))
                          const newStart = clamp(startStep + delta, 0, arrSteps - s.lengthSteps)
                          setSong(prev => prev ? { ...prev, sfx: (prev.sfx||[]).map(q => q.id===s.id?{...q, startStep:newStart}:q) } : prev)
                        }
                        const onUp = () => {
                          window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                          const cur = (song?.sfx||[]).find(q => q.id === s.id)
                          if (!cur) return
                          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'sfx_update', id:s.id, startStep: cur.startStep }] }) } catch {}
                        }
                        window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
                      }}
                      onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); setSong(prev => prev ? { ...prev, sfx: (prev.sfx||[]).filter(q => q.id !== s.id) } : prev); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'sfx_delete', id:s.id }] }) } catch {} }}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Remote cursors via portal to document.body to guarantee top-most */}
      {createPortal(
        <div className="pointer-events-none fixed inset-0 z-[2147483647]">
          {Object.entries(remoteCursors).map(([id, c]) => {
            if (!c) return null
            const col = colorForId(id)
            if (typeof c.sect === 'string' && isFinite(c.sx) && isFinite(c.sy)) {
              let target = null
              if (c.sect === 'pattern_grid') target = gridRef.current
              else if (c.sect === 'arr_grid') target = arrGridRef.current
              if (target) {
                const rect = target.getBoundingClientRect()
                const x = rect.left + c.sx * rect.width
                let y
                if (c.sect === 'arr_grid' && typeof c.track === 'number' && isFinite(c.track) && typeof c.ty === 'number' && isFinite(c.ty)) {
                  const t = Math.max(0, Math.min(ARR_TRACKS - 1, Math.round(c.track)))
                  y = rect.top + (t * ARR_TRACK_H) + c.ty * ARR_TRACK_H
                } else {
                  y = rect.top + c.sy * rect.height
                }
                return (
                  <div key={`rc_${id}`} className="absolute" style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -50%)' }}>
                    <div className="w-3 h-3 rounded-full" style={{ background: col, boxShadow: `0 0 8px ${col}` }} />
                  </div>
                )
              }
            }
            if (isFinite(c.nx) && isFinite(c.ny)) {
              const rr = rootRef.current ? rootRef.current.getBoundingClientRect() : null
              if (rr) {
                const x = rr.left + c.nx * rr.width
                const y = rr.top + c.ny * rr.height
                return (
                  <div key={`rc_${id}`} className="absolute" style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(-50%, -50%)' }}>
                    <div className="w-3 h-3 rounded-full" style={{ background: col, boxShadow: `0 0 8px ${col}` }} />
                  </div>
                )
              }
            }
            return null
          })}
          {/* Remote typing previews (text only, color per user) */}
          {Object.entries(remoteTyping).map(([id, r]) => {
            if (!r || !r.text) return null
            const col = colorForKey(id)
            const rr = rootRef.current ? rootRef.current.getBoundingClientRect() : null
            if (!rr) return null
            const x = rr.left + (r.nx||0)*rr.width
            const y = rr.top + (r.ny||0)*rr.height
            return (
              <div key={`rt_${id}`} className="absolute select-none" style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(8px, -50%)' }}>
                <span className="font-medium" style={{ color: col, textShadow: '0 0 6px rgba(0,0,0,0.65)' }}>{r.text}</span>
              </div>
            )
          })}
          {/* Self typing preview (local only) */}
          {typingOn && typingText && (() => {
            const rr = rootRef.current ? rootRef.current.getBoundingClientRect() : null
            if (!rr) return null
            const x = rr.left + selfPos.nx * rr.width
            const y = rr.top + selfPos.ny * rr.height
            const col = '#ffffff'
            return (
              <div className="absolute select-none" style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(8px, -50%)' }}>
                <span className="font-medium" style={{ color: col, textShadow: '0 0 6px rgba(0,0,0,0.65)' }}>{typingText}</span>
              </div>
            )
          })()}
        </div>, document.body)}
    </div>
  )
}


