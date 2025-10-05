import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { colorForKey } from './color'
import { playSf, ensureSoundfontInstrument, sfLoaded, stopSfNode, ensureSoundfontInstrumentForContext, midiToFreq } from './audio'

export default function Sequencer({ socket, onBack }) {
  const BACKEND_URL = (import.meta.env && import.meta.env.VITE_BACKEND_URL) ? String(import.meta.env.VITE_BACKEND_URL) : 'http://localhost:3001'
  const [song, setSong] = useState(null)
  const songRef = useRef(null)
  useEffect(() => { songRef.current = song }, [song])
  const [rev, setRev] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [tempo, setTempo] = useState(120)
  const [baseBar, setBaseBar] = useState(0)
  const [baseTsMs, setBaseTsMs] = useState(Date.now())
  const [songId, setSongId] = useState('default')
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
  const patMarkerPxRef = useRef(0)
  const arrMarkerPxRef = useRef(0)
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
  const [mode, setMode] = useState('arrangement') // default to arrangement
  const [linkClipToPattern, setLinkClipToPattern] = useState(true)
  const [independentPattern, setIndependentPattern] = useState(false)
  const [localPatternId, setLocalPatternId] = useState(null)
  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  // Pattern-from-loop preview
  const [loopMakeOn, setLoopMakeOn] = useState(false)
  const [loopMakeTrack, setLoopMakeTrack] = useState(0)
  const lastArrTrackRef = useRef(0)
  const loopTrackRef = useRef(null)
  // Arrangement loop state (shared via song)
  const [loopOn, setLoopOn] = useState(false)
  const [loopStartStep, setLoopStartStep] = useState(0)
  const [loopEndStep, setLoopEndStep] = useState(0)
  // Independent loop is implied by Independent mode; local state retained for loop values only
  const [localLoopOn, setLocalLoopOn] = useState(false)
  const [localLoopStartStep, setLocalLoopStartStep] = useState(0)
  const [localLoopEndStep, setLocalLoopEndStep] = useState(0)
  useEffect(() => {
    if (independentPattern) {
      setLocalLoopOn(!!loopOn)
      setLocalLoopStartStep(loopStartStep)
      setLocalLoopEndStep(loopEndStep)
    } else {
      setLocalLoopOn(false)
    }
  }, [independentPattern, loopOn, loopStartStep, loopEndStep])
  const loopDragRef = useRef({ active: false, start: 0 })
  const scrollSyncRef = useRef(false)
  const ARR_SCALE = 0.4
  const stepWPattern = STEP_UNIT * zoomX
  const stepWArr = STEP_UNIT * zoomX * ARR_SCALE
  const [arrSnap, setArrSnap] = useState('1/8') // '1' | '1/2' | '1/4' | '1/8'
  const [autoResizeClips, setAutoResizeClips] = useState(false)
  const placeRef = useRef({ active: false, track: 0, startStep: 0, lengthSteps: 0, dragging: false, startX: 0, startY: 0, valid: true })
  const [ghost, setGhost] = useState({ on: false, left: 0, top: 0, width: 0, bad: false })
  const [metronomeOn, setMetronomeOn] = useState(false)
  const [countInOn, setCountInOn] = useState(false)
  const countInRef = useRef({ active: false, endStep: 0 })
  // Save/Load (simple REST to backend)
  const [songSaveId, setSongSaveId] = useState('default')
  const [songsList, setSongsList] = useState([])
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    try {
      const v = localStorage.getItem('isAdmin')
      const on = v === '1'
      setIsAdmin(on)
      try { socket?.emit?.('identify_admin', { isAdmin: on }) } catch {}
    } catch {}
  }, [socket])
  useEffect(() => {
    try {
      localStorage.setItem('isAdmin', isAdmin ? '1' : '0')
      try { socket?.emit?.('identify_admin', { isAdmin }) } catch {}
    } catch {}
  }, [isAdmin, socket])
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.altKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault(); e.stopPropagation();
        setIsAdmin(prev => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  async function saveSongSnapshot(id) {
    try {
      if (!id || !song) return
      await fetch(`${BACKEND_URL.replace(/\/$/, '')}/songs/${encodeURIComponent(id)}` , {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song })
      })
      // refresh list so it appears immediately
      listSongs()
    } catch {}
  }
  async function loadSongSnapshot(id) {
    try {
      if (!id) return
      setSongSaveId(id)
      // Switch everyone to this song id; server will emit seq_song snapshot
      try { socket?.emit?.('seq_switch_song', { id }) } catch {}
    } catch {}
  }
  async function listSongs() {
    try {
      const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/songs`)
      const data = await res.json().catch(()=>null)
      if (data && Array.isArray(data.ids)) setSongsList(data.ids)
    } catch {}
  }
  function newSharedSong() {
    try {
      let def = 'song-' + Date.now().toString(36)
      const id = prompt('New song id', def)
      if (!id) return
      setSongSaveId(id)
      try { socket?.emit?.('seq_switch_song', { id }) } catch {}
    } catch {}
  }
  async function exportSongMp3() {
    try {
      const ctx = audioCtxRef.current
      const master = masterRef.current
      if (!ctx || !master || !song) return
      try { await ctx.resume?.() } catch {}
      const dest = ctx.createMediaStreamDestination()
      try { master.connect(dest) } catch {}
      const typeMp3 = (typeof window !== 'undefined' && window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported('audio/mpeg'))
      const mime = typeMp3 ? 'audio/mpeg' : (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm')
      const rec = new MediaRecorder(dest.stream, { mimeType: mime })
      const chunks = []
      rec.ondataavailable = (e) => { if (e && e.data && e.data.size > 0) chunks.push(e.data) }
      const prevPlaying = playing
      const prevBase = baseBar
      const prevTs = baseTsMs
      const totalSec = Math.max(1, (Number(song.bars)||4) * 4 * (60 / Math.max(40, Math.min(240, Number(tempo)||120)))) + 0.6
      rec.start()
      // If not already playing, play from start for export duration
      if (!prevPlaying) {
        try {
          setBaseBar(0); setBaseTsMs(Date.now()); schedRef.current.nextStep = 0
          setPlaying(true); ensureAudio(); ctx.resume?.(); scheduleWindow?.(true)
        } catch {}
      }
      await new Promise(r => setTimeout(r, Math.ceil(totalSec * 1000)))
      try { setPlaying(false) } catch {}
      await new Promise(resolve => { rec.onstop = () => resolve(); rec.stop() })
      try { master.disconnect(dest) } catch {}
      // Blob export; if MP3 not supported, send to backend to convert
      const blob = new Blob(chunks, { type: mime })
      if (typeMp3) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${String(song.id||'song')}.mp3`
        document.body.appendChild(a)
        a.click()
        setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url) } catch {} }, 1500)
      } else {
        const reader = new FileReader()
        reader.onloadend = async () => {
          try {
            const b64 = String(reader.result||'')
            const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/convert/mp3`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: b64 }) })
            if (!res.ok) throw new Error('convert_failed')
            const blobMp3 = await res.blob()
            const url = URL.createObjectURL(blobMp3)
            const a = document.createElement('a')
            a.href = url
            a.download = `${String(song.id||'song')}.mp3`
            document.body.appendChild(a)
            a.click()
            setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url) } catch {} }, 1500)
          } catch {}
        }
        reader.readAsDataURL(blob)
      }
      // Restore previous transport if it was playing
      if (prevPlaying) {
        try { setBaseBar(prevBase); setBaseTsMs(prevTs); setPlaying(true); scheduleWindow?.(true) } catch {}
      }
    } catch {}
  }

  async function exportSongOffline() {
    try {
      if (!song) return
      const stepsPerBar = Number(song.stepsPerBar)||16
      const bars = Number(song.bars)||4
      const bpm = Math.max(40, Math.min(240, Number(tempo)||120))
      const secondsPerStep = (60 / bpm) * 4 / stepsPerBar
      const pats = Array.isArray(song.patterns) ? song.patterns : []
      const clips = Array.isArray(song.clips) ? song.clips : []
      const arr = []
      let lastEndStep = 0
      for (const c of clips) {
        const pat = pats.find(p=>p.id===c.patternId)
        if (!pat) continue
        const clipStart = Math.max(0, Number(c.startStep||0))
        const clipLen = Math.max(1, Number(c.lengthSteps|| (stepsPerBar*4)))
        const clipEnd = clipStart + clipLen
        const patBars = Math.max(1, Number(pat.bars||4))
        const patSteps = patBars * stepsPerBar
        if (patSteps <= 0) continue
        for (const n of (pat.notes||[])) {
          const nStartLocal = Math.max(0, Number(n.startStep||0))
          const nLen = Math.max(1, Number(n.lengthSteps||1))
          // Find the first repeat k such that occStart >= clipStart - patSteps
          let k = Math.floor((clipStart - (clipStart + nStartLocal)) / patSteps)
          if (!isFinite(k)) k = 0
          // Loop through repeats while start < clipEnd
          for (; ; k++) {
            const occStart = clipStart + k*patSteps + nStartLocal
            if (occStart >= clipEnd) break
            const occEnd = occStart + nLen
            if (occEnd <= clipStart) continue
            const trimmedStart = Math.max(occStart, clipStart)
            const trimmedEnd = Math.min(occEnd, clipEnd)
            const trimmedLen = Math.max(1, Math.round(trimmedEnd - trimmedStart))
            arr.push({
              startStepAbs: trimmedStart,
              lengthSteps: trimmedLen,
              velocity: Number(n.velocity||0.8),
              pitch: Number(n.pitch||60),
              synth: String(n.synth||'Triangle')
            })
            if (trimmedEnd > lastEndStep) lastEndStep = trimmedEnd
          }
        }
      }
      // Fallback to top-level notes if any
      for (const n of (song.notes||[])) {
        const ss = Number(n.startStep||0)
        const ll = Math.max(1, Number(n.lengthSteps||1))
        arr.push({ startStepAbs: ss, lengthSteps: ll, velocity: Number(n.velocity||0.8), pitch: Number(n.pitch||60), synth: String(n.synth||'Triangle') })
        if ((ss + ll) > lastEndStep) lastEndStep = ss + ll
      }
      // Determine total duration by last event, with small tail
      const baseSteps = bars * stepsPerBar
      const endSteps = Math.max(baseSteps, Math.ceil(lastEndStep))
      const durationSec = endSteps * secondsPerStep + 1.0
      const sampleRate = 44100
      const offline = new OfflineAudioContext(2, Math.ceil(durationSec * sampleRate), sampleRate)
      const master = offline.createGain(); master.gain.setValueAtTime(1, 0); master.connect(offline.destination)
      // Group SF instrument instances per name
      const sfInstCache = new Map()
      async function getSf(name) {
        if (sfInstCache.has(name)) return sfInstCache.get(name)
        const inst = await ensureSoundfontInstrumentForContext(offline, name)
        sfInstCache.set(name, inst)
        return inst
      }
      for (const ev of arr) {
        const start = Math.max(0, ev.startStepAbs * secondsPerStep)
        const dur = Math.max(0.05, ev.lengthSteps * secondsPerStep)
        const end = start + dur
        const vel = Math.max(0.01, Math.min(1, ev.velocity))
        if (ev.synth && ev.synth.startsWith && ev.synth.startsWith('SF:')) {
          const name = ev.synth.slice(3)
          const inst = await getSf(name)
          if (inst && inst.play) inst.play(ev.pitch, start, { duration: dur + 0.05, gain: vel })
        } else if (['PianoSF','StringsSF','BassSF','EPianoSF','ChoirSF'].includes(ev.synth)) {
          const map = { PianoSF:'acoustic_grand_piano', StringsSF:'string_ensemble_1', BassSF:'acoustic_bass', EPianoSF:'electric_piano_1', ChoirSF:'choir_aahs' }
          const inst = await getSf(map[ev.synth]||'acoustic_grand_piano')
          if (inst && inst.play) inst.play(ev.pitch, start, { duration: dur + 0.05, gain: vel })
        } else {
          // Basic oscillator approximation for built-in synths
          const o = offline.createOscillator()
          const g = offline.createGain()
          o.type = 'triangle'
          o.frequency.setValueAtTime(midiToFreq(ev.pitch), start)
          // ADSR: quick attack, sustain, short release at end
          g.gain.setValueAtTime(0.00001, start)
          g.gain.linearRampToValueAtTime(vel * 0.5, start + 0.01)
          g.gain.setValueAtTime(vel * 0.5, Math.max(start + 0.01, end - 0.02))
          g.gain.linearRampToValueAtTime(0.00001, end)
          o.connect(g).connect(master)
          o.start(start)
          o.stop(end + 0.02)
        }
      }
      const buf = await offline.startRendering()
      // WAV encode
      function audioBufferToWav(abuf) {
        const numOfChan = abuf.numberOfChannels
        const length = abuf.length * numOfChan * 2 + 44
        const buffer = new ArrayBuffer(length)
        const view = new DataView(buffer)
        const channels = []
        let offset = 0
        let pos = 0
        function setUint16(data) { view.setUint16(pos, data, true); pos += 2 }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4 }
        // RIFF/WAVE header
        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157)
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan)
        setUint32(abuf.sampleRate); setUint32(abuf.sampleRate * 2 * numOfChan)
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4)
        for (let i = 0; i < numOfChan; i++) channels.push(abuf.getChannelData(i))
        while (pos < length) { // interleave channels
          for (let i = 0; i < numOfChan; i++) {
            let sample = Math.max(-1, Math.min(1, channels[i][offset]))
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
            view.setInt16(pos, sample, true); pos += 2
          }
          offset++
        }
        return new Blob([buffer], { type: 'audio/wav' })
      }
      const wavBlob = audioBufferToWav(buf)
      // Convert to MP3 via backend
      const reader = new FileReader()
      reader.onloadend = async () => {
        try {
          const b64 = String(reader.result||'')
          const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/convert/mp3`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: b64 }) })
          if (!res.ok) throw new Error('convert_failed')
          const blobMp3 = await res.blob()
          const url = URL.createObjectURL(blobMp3)
          const a = document.createElement('a')
          a.href = url
          a.download = `${String(song.id||'song')}.mp3`
          document.body.appendChild(a)
          a.click()
          setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url) } catch {} }, 1500)
        } catch {}
      }
      reader.readAsDataURL(wavBlob)
    } catch {}
  }
  function deleteSong(id) {
    try {
      const target = id || songSaveId
      if (!target) return
      if (!confirm(`Delete song "${target}"?`)) return
      // Requires admin on server; no-op if not admin
      socket?.emit?.('seq_delete_song', { id: target })
      // Optimistically remove from local list
      setSongsList(prev => Array.isArray(prev) ? prev.filter(x => x !== target) : prev)
      // Refresh list after a short delay
      setTimeout(()=> listSongs(), 200)
    } catch {}
  }
  const stepWRef = useRef(STEP_UNIT)
  const [placeLenSteps, setPlaceLenSteps] = useState(4)
  const SYNTHS = ['Triangle','Square','Saw','Sine','Pluck','Bass','Bell','SuperSaw','Organ','EPiano','WarmPad','PWM','Sub','Choir','PianoSF','StringsSF','BassSF','EPianoSF','ChoirSF']
  const [synth, setSynth] = useState('Triangle')
  const SF_INSTR_MAP = {
    PianoSF: 'acoustic_grand_piano',
    StringsSF: 'string_ensemble_1',
    BassSF: 'acoustic_bass',
    EPianoSF: 'electric_piano_1',
    ChoirSF: 'choir_aahs'
  }
  function SfInstrumentList({ query, onPick }) {
    const q = String(query||'').toLowerCase().trim()
    // Core GM melodic names (subset for brevity; supports search of any name via CDN)
    const groups = [
      { name:'Pianos', items:['acoustic_grand_piano','bright_acoustic_piano','electric_grand_piano','honkytonk_piano','electric_piano_1','electric_piano_2'] },
      { name:'Organs', items:['drawbar_organ','percussive_organ','rock_organ'] },
      { name:'Guitars', items:['acoustic_guitar_nylon','acoustic_guitar_steel','electric_guitar_jazz','electric_guitar_clean','electric_guitar_muted'] },
      { name:'Basses', items:['acoustic_bass','electric_bass_finger','electric_bass_pick','fretless_bass','slap_bass_1'] },
      { name:'Strings', items:['violin','viola','cello','contrabass','tremolo_strings','pizzicato_strings','string_ensemble_1','string_ensemble_2'] },
      { name:'Brass', items:['trumpet','trombone','tuba','french_horn','brass_section'] },
      { name:'Reeds/Winds', items:['soprano_sax','alto_sax','tenor_sax','baritone_sax','oboe','english_horn','bassoon','clarinet','flute','recorder'] },
      { name:'Synth Leads', items:['lead_1_square','lead_2_sawtooth','lead_3_calliope','lead_4_chiff','lead_5_charang','lead_6_voice','lead_7_fifths','lead_8_bass__lead'] },
      { name:'Synth Pads', items:['pad_1_new_age','pad_2_warm','pad_3_polysynth','pad_4_choir','pad_5_bowed','pad_6_metallic','pad_7_halo','pad_8_sweep'] },
      { name:'Synth FX', items:['fx_1_rain','fx_2_soundtrack','fx_3_crystal','fx_4_atmosphere','fx_5_brightness','fx_6_goblins','fx_7_echoes','fx_8_scifi'] }
    ]
    return (
      <div className="flex flex-col gap-2">
        {groups.map(g => {
          const items = g.items.filter(n => !q || n.includes(q))
          if (!items.length) return null
          return (
            <div key={g.name}>
              <div className="text-xs uppercase tracking-wide text-white/60 px-1 py-1">{g.name}</div>
              <div className="grid grid-cols-2 gap-1">
                {items.map(name => (
                  <button key={name} className="text-left px-2 py-1 rounded bg-white/5 hover:bg-white/15 text-white/90" onClick={()=> onPick(name)}>
                    {name.replaceAll('_',' ')}
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    )
  }
  function isSfSynth(name) {
    const s = String(name||'')
    return !!SF_INSTR_MAP[s] || s.startsWith('SF:')
  }
  function sfInstrFromSynthName(name) {
    const s = String(name||'')
    if (s.startsWith('SF:')) return s.slice(3)
    return SF_INSTR_MAP[s]
  }
  const [sfPaletteOpen, setSfPaletteOpen] = useState(false)
  const [sfQuery, setSfQuery] = useState('')
  // Instrument mode (play with computer keyboard)
  const [instOn, setInstOn] = useState(false)
  const [instOct, setInstOct] = useState(0)
  const [instVel, setInstVel] = useState(8) // 1..9
  const heldKeysRef = useRef(new Set())
  // Compose (step-time) mode
  const [composeOn, setComposeOn] = useState(false)
  const [composeStep, setComposeStep] = useState(0)
  const [composeClipId, setComposeClipId] = useState(null)
  const composeDownRef = useRef(new Map()) // key -> {tsMs, midi, vel, osc, g}
  const [composeGhostTick, setComposeGhostTick] = useState(0)
  const chordActiveKeysRef = useRef(new Set())
  const chordStartStepRef = useRef(0)
  const chordMaxStepsRef = useRef(0)
  const heldOscsRef = useRef(new Map())
  const chordStartTsRef = useRef(0)
  const composeCaretRef = useRef(null)
  const composeGhostRefsRef = useRef({})
  const composePrevPlayedRef = useRef(new Set())
  const composeVoicesRef = useRef(new Map())
  const caretStepFloatPrevRef = useRef(NaN)
  const composeLiveStepRef = useRef(0)
  // Pending arrangement clip updates to guard against server echo reordering
  const pendingClipUpdatesRef = useRef(new Map()) // id -> { startStep?, track?, lengthSteps?, ts }
  function wrapPitchToVisible(p) {
    let x = Number(p)||60
    while (x > PITCH_MAX) x -= 12
    while (x < PITCH_MIN) x += 12
    return Math.max(PITCH_MIN, Math.min(PITCH_MAX, x))
  }
  // (removed duplicate compose state)
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
    'PianoSF': 'linear-gradient(to bottom, rgba(248,250,252,0.95), rgba(248,250,252,0.7))',
    'StringsSF': 'linear-gradient(to bottom, rgba(248,113,113,0.95), rgba(248,113,113,0.7))',
    'BassSF': 'linear-gradient(to bottom, rgba(191,219,254,0.95), rgba(191,219,254,0.7))',
    'EPianoSF': 'linear-gradient(to bottom, rgba(165,180,252,0.95), rgba(165,180,252,0.7))',
    'ChoirSF': 'linear-gradient(to bottom, rgba(196,181,253,0.95), rgba(196,181,253,0.7))'
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
    Choir: 'rgba(20,184,166,0.55)',
    'PianoSF': 'rgba(248,250,252,0.55)',
    'StringsSF': 'rgba(248,113,113,0.55)',
    'BassSF': 'rgba(191,219,254,0.55)',
    'EPianoSF': 'rgba(165,180,252,0.55)',
    'ChoirSF': 'rgba(196,181,253,0.55)'
  }

  // Dynamic colors for any SF:<instrument> chosen from More… palette
  function sfHue(name) {
    let h = 0; const s = String(name||'sf')
    for (let i=0;i<s.length;i++) { h = ((h<<5)-h) + s.charCodeAt(i); h|=0 }
    return Math.abs(h % 360)
  }
  function sfGradientFor(instName) {
    const h = sfHue(instName)
    const top = `hsl(${h} 70% 62% / 0.95)`
    const bot = `hsl(${h} 70% 48% / 0.70)`
    return `linear-gradient(to bottom, ${top}, ${bot})`
  }
  function sfPreviewFor(instName) {
    const h = sfHue(instName)
    return `hsl(${h} 70% 55% / 0.55)`
  }

  // Kill circles melody if any
  useEffect(() => { try { window.__stopCirclesMelody?.() } catch {} }, [])

  // Socket wiring
  useEffect(() => {
    if (!socket) return
    const onSong = ({ song, rev }) => {
      // Preserve any locally pending clip fields; merge server song with local pending values
      const merged = (() => {
        try {
          const pend = pendingClipUpdatesRef.current
          if (!pend || !(pend instanceof Map) || !Array.isArray(song?.clips)) return song
          const list = song.clips.map(c => {
            const p = pend.get(c.id)
            if (!p) return c
            return {
              ...c,
              startStep: (p.startStep !== undefined ? p.startStep : c.startStep),
              track: (p.track !== undefined ? p.track : c.track),
              lengthSteps: (p.lengthSteps !== undefined ? p.lengthSteps : c.lengthSteps)
            }
          })
          return { ...song, clips: list }
        } catch { return song }
      })()
      // If we have pending fields and the merged song equals our local current, clear acks
      try {
        const pend = pendingClipUpdatesRef.current
        if (pend && pend.size) {
          const cur = songRef.current
          if (cur && Array.isArray(cur.clips)) {
            for (const [id, rec] of Array.from(pend.entries())) {
              const sv = (merged?.clips||[]).find(c => c.id === id)
              if (!sv) continue
              const ackStart = rec.startStep === undefined || sv.startStep === rec.startStep
              const ackTrack = rec.track === undefined || sv.track === rec.track
              const ackLen = rec.lengthSteps === undefined || sv.lengthSteps === rec.lengthSteps
              if (ackStart && ackTrack && ackLen) pend.delete(id)
            }
          }
        }
      } catch {}
      setSong(merged); setRev(rev); setTempo(song.tempo)
      if (!independentPattern) {
        if (typeof song.loopOn === 'boolean') setLoopOn(!!song.loopOn)
        if (Number.isFinite(song.loopStartStep)) setLoopStartStep(Number(song.loopStartStep)||0)
        if (Number.isFinite(song.loopEndStep)) setLoopEndStep(Number(song.loopEndStep)||0)
      }
    }
    const onCursor = ({ from, nx, ny, sect, sx, sy, track, ty, ts, clear }) => {
      try {
        if (!from || from === socket.id) return
        if (clear) {
          setRemoteCursors(prev => { const next = { ...prev }; delete next[from]; return next })
          return
        }
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
              // If we have a pending local update, only accept server values that
              // acknowledge the same value; otherwise ignore to prevent snap-back.
              const pend = pendingClipUpdatesRef.current.get(id)
              const nowTs = Date.now()
              const TTL = 5000
              function applyOrAck(field, serverVal, clampFn) {
                if (!pend || pend[field] === undefined) {
                  u[field] = clampFn(serverVal)
                  return
                }
                const want = clampFn(pend[field])
                const got = clampFn(serverVal)
                if (got === want) {
                  // ack: accept and clear this pending field
                  u[field] = got
                  const np = { ...pend }
                  delete np[field]
                  if (!('startStep' in np) && !('track' in np) && !('lengthSteps' in np)) pendingClipUpdatesRef.current.delete(id)
                  else { np.ts = nowTs; pendingClipUpdatesRef.current.set(id, np) }
                } else if (nowTs - (pend.ts||0) > TTL) {
                  // stale: drop pending and accept server
                  u[field] = got
                  pendingClipUpdatesRef.current.delete(id)
                } else {
                  // keep local; ignore server for this field
                }
              }
              if (op.track !== undefined) applyOrAck('track', Number(op.track), (v)=> Math.max(0, Math.min(3, Number(v))))
              if (op.startStep !== undefined) applyOrAck('startStep', Number(op.startStep)||0, (v)=> Math.max(0, Number(v)||0))
              if (op.lengthSteps !== undefined) applyOrAck('lengthSteps', Number(op.lengthSteps)||1, (v)=> Math.max(1, Number(v)||1))
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
          } else if (op.type === 'set_loop') {
            const on = !!op.on
            const spb = next.stepsPerBar || 16
            const total = (next.bars||4) * spb
            let a = Math.max(0, Math.min(total, Number(op.startStep)||0))
            let b = Math.max(0, Math.min(total, Number(op.endStep)||0))
            if (b < a) { const t=a; a=b; b=t }
            next = { ...next, loopOn: on, loopStartStep: a, loopEndStep: b }
            if (!independentPattern) { setLoopOn(on); setLoopStartStep(a); setLoopEndStep(b) }
          }
        }
        return next
      })
    }
    const onTransport = ({ playing, baseBar, baseTsMs, tempo, from }) => {
      // Ignore partner transport when in Independent mode
      if (independentPattern && from && socket && from !== socket.id) return
      const pb = Number(baseBar)||0; const pts = Number(baseTsMs)||Date.now()
      setPlaying(!!playing); setBaseBar(pb); setBaseTsMs(pts); if (tempo) setTempo(tempo)
      try { schedRef.current.nextStep = Math.floor(pb * (song?.stepsPerBar || 16)) } catch {}
    }
    socket.on('seq_song', onSong)
    socket.on('seq_apply', onApply)
    socket.on('seq_transport', onTransport)
    socket.on('seq_cursor', onCursor)
    socket.on('seq_typing_preview', onTypingPreview)
    socket.on('seq_active_song', ({ id }) => { if (typeof id === 'string' && id) { setSongId(id); setSongSaveId(id) } })
    socket.on('songs_changed', () => { listSongs() })
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
    return () => { socket.off('seq_song', onSong); socket.off('seq_apply', onApply); socket.off('seq_transport', onTransport); socket.off('sfx_uploaded'); socket.off('seq_cursor', onCursor); socket.off('seq_typing_preview', onTypingPreview); socket.off('seq_active_song'); socket.off('songs_changed') }
  }, [socket, independentPattern])
  // Emit a cursor clear when leaving the sequencer (component unmount)
  useEffect(() => {
    return () => { try { socket?.emit?.('seq_cursor', { songId, cursor: { clear: true } }) } catch {} }
  }, [socket, songId])

  // Periodically prune stale remote cursors (e.g., partner closed tab)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now(); const TTL = 6500
      setRemoteCursors(prev => {
        let changed = false; const next = { ...prev }
        for (const [id, c] of Object.entries(prev || {})) {
          const ts = Number(c && c.ts)
          if (!isFinite(ts) || (now - ts) > TTL) { delete next[id]; changed = true }
        }
        return changed ? next : prev
      })
    }, 3000)
    return () => clearInterval(timer)
  }, [])
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
    const spb = song.stepsPerBar
    const total = song.bars
    const raw = currentBarsRaw()
    const effOn = independentPattern ? localLoopOn : loopOn
    const effStart = independentPattern ? localLoopStartStep : loopStartStep
    const effEnd = independentPattern ? localLoopEndStep : loopEndStep
    if (effOn && effEnd > effStart) {
      const startBars = effStart / spb
      const endBars = effEnd / spb
      const len = Math.max(1 / spb, endBars - startBars)
      const rel = raw - startBars
      const relMod = ((rel % len) + len) % len
      return startBars + relMod
    }
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
    // Route to soundfont if SF synth selected
    if (isSfSynth(synthName)) {
      // apply small lead to counteract instrument latency
      const inst = sfInstrFromSynthName(synthName) || 'acoustic_grand_piano'
      const startAt = Math.max(ctx.currentTime, time - 0.008)
      try { playSf(pitch, startAt, durationSec, Math.max(0.05, Math.min(1, velocity||0.8)), inst) } catch {}
      return
    }
    // small lead for oscillator synths as well
    time = Math.max(ctx.currentTime, time - 0.004)
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
    // loop-aware reference bar position
    let refBars = ((nowBarsRaw % totalBars) + totalBars) % totalBars
    const effOn = independentPattern ? localLoopOn : loopOn
    const effStart = independentPattern ? localLoopStartStep : loopStartStep
    const effEnd = independentPattern ? localLoopEndStep : loopEndStep
    if (effOn && effEnd > effStart) {
      const spb = song.stepsPerBar
      const startBars = effStart / spb
      const endBars = effEnd / spb
      const lenBars = Math.max(1 / spb, endBars - startBars)
      const rel = nowBarsRaw - startBars
      const relMod = ((rel % lenBars) + lenBars) % lenBars
      refBars = startBars + relMod
    }
    const nowStep = Math.floor(refBars * song.stepsPerBar)
    if (!Number.isFinite(schedRef.current.nextStep)) {
      schedRef.current.nextStep = nowStep
    } else {
      const drift = schedRef.current.nextStep - nowStep
      const aheadSoft = song.stepsPerBar * 4
      if (drift < -song.stepsPerBar || drift > aheadSoft) {
        schedRef.current.nextStep = nowStep
      }
    }
    const endTime = ctx.currentTime + lookahead
    let first = true
    while (true) {
      const step = schedRef.current.nextStep
      const spb = song.stepsPerBar
      const totalSteps = song.bars * spb
      // Compute forward delta in steps relative to current step
      let deltaSteps
      const effOn2 = independentPattern ? localLoopOn : loopOn
      const effStart2 = independentPattern ? localLoopStartStep : loopStartStep
      const effEnd2 = independentPattern ? localLoopEndStep : loopEndStep
      if (effOn2 && effEnd2 > effStart2) {
        const loopLenSteps = Math.max(1, effEnd2 - effStart2)
        const stepNorm = ((step - effStart2) % loopLenSteps + loopLenSteps) % loopLenSteps
        const nowNorm = ((nowStep - effStart2) % loopLenSteps + loopLenSteps) % loopLenSteps
        deltaSteps = stepNorm - nowNorm
        if (deltaSteps < 0) deltaSteps += loopLenSteps
      } else {
        deltaSteps = step - nowStep
        deltaSteps = ((deltaSteps % totalSteps) + totalSteps) % totalSteps
      }
      let when = ctx.currentTime + deltaSteps * secondsPerStep(tempo, spb)
      if (forceStart && first) when = Math.max(ctx.currentTime + 0.02, when)
      if (when > endTime) break
      // protect against scheduling in the past due to jitter
      if (when < ctx.currentTime - 0.002) { schedRef.current.nextStep = step + 1; first = false; continue }
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
      const inCountIn = false
      // For loop scheduling, map step to loop-relative modulo when active
      const effOn3 = independentPattern ? localLoopOn : loopOn
      const effStart3 = independentPattern ? localLoopStartStep : loopStartStep
      const effEnd3 = independentPattern ? localLoopEndStep : loopEndStep
      const stepMod = (effOn3 && effEnd3 > effStart3) ? ((step - effStart3) % (effEnd3 - effStart3) + (effEnd3 - effStart3)) % (effEnd3 - effStart3) + effStart3 : (step % total)
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
      let next = step + 1
      if (effOn3 && effEnd3 > effStart3 && next >= effEnd3) next = effStart3
      schedRef.current.nextStep = next
      first = false
    }
  }

  // Single rAF loop for playhead + scheduling
  useEffect(() => {
    function frame() {
      try {
        // schedule audio
        if (playing) scheduleWindow()
        // move markers with smooth sub-step motion
        const spb = Math.max(1, song.stepsPerBar || 16)
        const logicalStepsFloat = currentBarsVis() * spb
        const globalStep = logicalStepsFloat // keep fractional for smoothness
        let patStepFloat = globalStep
        try {
          const firstSel = Array.from(selectedClipIds || [])[0]
          const selClip = (song.clips || []).find(c => c.id === firstSel)
          const barsEff = (activePattern && activePattern.bars) ? activePattern.bars : (patternBars || 4)
          const patSteps = Math.max(1, Math.round(barsEff) * spb)
          if (selClip && patSteps > 0) {
            const anchor = ((selClip.startStep % patSteps) + patSteps) % patSteps
            const rel = globalStep - anchor
            patStepFloat = ((rel % patSteps) + patSteps) % patSteps
          } else if (patSteps > 0) {
            patStepFloat = ((globalStep % patSteps) + patSteps) % patSteps
          }
        } catch {}
        const targetPatPx = patStepFloat * stepWPattern
        const targetArrPx = globalStep * stepWArr
        // simple exponential smoothing to reduce jitter
        const alpha = 0.35
        patMarkerPxRef.current = patMarkerPxRef.current + (targetPatPx - patMarkerPxRef.current) * alpha
        arrMarkerPxRef.current = arrMarkerPxRef.current + (targetArrPx - arrMarkerPxRef.current) * alpha
        const pxPattern = patMarkerPxRef.current
        const pxArr = arrMarkerPxRef.current
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
        // Smooth compose caret during holds (map absolute caret to pattern-local X)
        if (composeOn && composeCaretRef.current) {
          const spaceHeld = !!composeDownRef.current.get('Space')
          const compClip = (song?.clips||[]).find(c => c.id === composeClipId)
          const patIdForCaret = compClip?.patternId || activePatternId
          const patForCaret = (song?.patterns||[]).find(p=>p.id===patIdForCaret) || activePattern
          const patStepsForCaret = Math.max(1, (patForCaret?.bars||patternBars||4)*spb)
          const anchorForCaret = compClip ? (((compClip.startStep % patStepsForCaret) + patStepsForCaret) % patStepsForCaret) : 0
          function absToLocalX(absStep) {
            const local = ((absStep - anchorForCaret) % patStepsForCaret + patStepsForCaret) % patStepsForCaret
            return Math.round(local*STEP_UNIT*zoomX)
          }
          if ((chordActiveKeysRef.current.size>0 || spaceHeld) && chordStartTsRef.current) {
            const stepProg = (performance.now() - chordStartTsRef.current) / (60000/tempo*4/spb)
            const caretAbs = chordStartStepRef.current + Math.max(0, stepProg)
            composeCaretRef.current.style.left = absToLocalX(caretAbs)+'px'
            composeLiveStepRef.current = caretAbs
          } else {
            composeCaretRef.current.style.left = absToLocalX(composeStep)+'px'
          }
        }
        // Compose preview playback of placed notes while caret advances (transport stopped)
        if (composeOn && !playing) {
          const spaceHeld = !!composeDownRef.current.get('Space')
          const holding = (chordActiveKeysRef.current.size>0 || spaceHeld) && chordStartTsRef.current
          if (holding) {
            const caretStepFloat = chordStartStepRef.current + Math.max(0, (performance.now() - chordStartTsRef.current) / (60000/tempo*4/spb))
            const prev = composePrevPlayedRef.current
            const stepStart = Math.floor(caretStepFloatPrevRef.current || caretStepFloat)
            const stepEnd = Math.floor(caretStepFloat)
            if (!Number.isFinite(caretStepFloatPrevRef.current)) caretStepFloatPrevRef.current = caretStepFloat
            if (stepEnd >= stepStart) {
              const totalSteps = song.bars * spb
              const stepRange = []
              for (let s = stepStart; s <= stepEnd; s++) stepRange.push(s)
              const notesPlay = []
              const patternsById = new Map((song.patterns||[]).map(p=>[p.id,p]))
              for (const c of (song.clips||[])) {
                const pat = patternsById.get(c.patternId)
                if (!pat) continue
                const patSteps = Math.max(1, (pat.bars||1)*spb)
                for (const ns of (pat.notes||[])) {
                  // iterate pattern repeats within the clip window
                  const baseLocal = ((ns.startStep % patSteps) + patSteps) % patSteps
                  // find first k such that absStart >= clip.startStep
                  const firstK = Math.ceil((c.startStep - (c.startStep + baseLocal)) / patSteps)
                  const lastK = Math.floor(((c.startStep + c.lengthSteps - 1) - (c.startStep + baseLocal)) / patSteps)
                  for (let k = firstK; k <= lastK; k++) {
                    const absStart = c.startStep + baseLocal + k*patSteps
                    // trigger if the caret crossed the integer step of this note's absolute start
                    if (stepRange.includes(Math.floor(absStart))) {
                      const key = `${c.id}:${ns.id}:${absStart}`
                      if (!prev.has(key)) {
                        prev.add(key)
                        notesPlay.push({ pitch: ns.pitch, velocity: ns.velocity||0.8, lengthSteps: ns.lengthSteps||1, synth: ns.synth||'Triangle' })
                      }
                    }
                  }
                }
              }
              // play collected notes now
              for (const it of notesPlay) {
                const durSec = (it.lengthSteps/spb) * secondsPerBar(tempo)
                playNote(audioCtxRef.current?.currentTime || 0, it.pitch, it.velocity, durSec, it.synth)
              }
            }
            caretStepFloatPrevRef.current = caretStepFloat
          } else {
            // reset preview tracking and stop any preview voices
            composePrevPlayedRef.current.clear()
            for (const [m,o] of Array.from(composeVoicesRef.current.entries())) { try { o.g?.gain?.exponentialRampToValueAtTime(0.0001, (audioCtxRef.current?.currentTime||0)+0.02); o.osc?.stop?.((audioCtxRef.current?.currentTime||0)+0.04) } catch {} }
            composeVoicesRef.current.clear()
            caretStepFloatPrevRef.current = NaN
          }
        }
        // Smooth ghost width updates without re-render
        if (composeOn && composeDownRef.current && composeGhostRefsRef.current) {
          const spb2 = Math.max(1, song.stepsPerBar || 16)
          const msPerStep2 = (60000/tempo)*4/spb2
          const now2 = performance.now()
          for (const [k, rec] of Array.from(composeDownRef.current.entries())) {
            if (k === 'Space') continue
            const el = composeGhostRefsRef.current[k]
            if (!el || !rec || !rec.tsMs) continue
            const heldStepsFloat = Math.max(0, (now2 - rec.tsMs) / msPerStep2)
            el.style.width = Math.max(1, Math.round(heldStepsFloat*STEP_UNIT*zoomX)) + 'px'
          }
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

  // Reset playhead markers precisely on play/seek to avoid initial offset
  useEffect(() => {
    try {
      if (!song) return
      const spb = Math.max(1, song.stepsPerBar || 16)
      const globalStep = Math.max(0, currentBarsVis() * spb)
      // arrangement marker
      arrMarkerPxRef.current = globalStep * (STEP_UNIT * zoomX * ARR_SCALE)
      // pattern marker anchored to selected or compose clip
      const firstSel = Array.from(selectedClipIds || [])[0]
      const sel = (song.clips || []).find(c => c.id === firstSel) || (song.clips || []).find(c => c.id === composeClipId) || null
      const barsEff = (activePattern && activePattern.bars) ? activePattern.bars : (patternBars || 4)
      const patSteps = Math.max(1, Math.round(barsEff) * spb)
      let patStepFloat = ((globalStep % patSteps) + patSteps) % patSteps
      if (sel) {
        const anchor = ((sel.startStep % patSteps) + patSteps) % patSteps
        const rel = globalStep - anchor
        patStepFloat = ((rel % patSteps) + patSteps) % patSteps
      }
      patMarkerPxRef.current = patStepFloat * (STEP_UNIT * zoomX)
      // apply immediately
      if (gridMarkerRef.current) gridMarkerRef.current.style.transform = `translateX(${patMarkerPxRef.current}px)`
      if (arrMarkerRef.current) arrMarkerRef.current.style.transform = `translateX(${arrMarkerPxRef.current}px)`
      if (arrRulerMarkerRef.current) arrRulerMarkerRef.current.style.transform = `translateX(${arrMarkerPxRef.current}px)`
    } catch {}
  }, [playing, baseBar, baseTsMs, song, zoomX, selectedClipIds, composeClipId])

  // Warm up common soundfont instruments in background (non-blocking)
  useEffect(() => { (async ()=>{ try {
    await Promise.all([
      ensureSoundfontInstrument('acoustic_grand_piano'),
      ensureSoundfontInstrument('string_ensemble_1'),
      ensureSoundfontInstrument('electric_piano_1'),
      ensureSoundfontInstrument('choir_aahs'),
      ensureSoundfontInstrument('acoustic_bass')
    ])
  } catch {} })() }, [])

  // Proactively warm instruments used in the song and current selection
  useEffect(() => {
    try {
      const needed = new Set()
      if (isSfSynth(synth)) needed.add(sfInstrFromSynthName(synth))
      const pats = Array.isArray(song?.patterns) ? song.patterns : []
      for (const p of pats) {
        for (const n of (p?.notes||[])) {
          if (isSfSynth(n.synth)) needed.add(sfInstrFromSynthName(n.synth))
        }
      }
      for (const n of (song?.notes||[])) {
        if (isSfSynth(n.synth)) needed.add(sfInstrFromSynthName(n.synth))
      }
      for (const name of Array.from(needed)) { try { ensureSoundfontInstrument(name) } catch {} }
    } catch {}
  }, [song, synth])

  // Instrument + Compose key handlers
  useEffect(() => {
    function midiForKey(code) {
      // QWERTY layout mapping (two rows). Base octave = C4 (60) + 12*instOct
      // Z-row (lower octave): Z S X D C V G B H N J M -> C, C#, D, D#, E, F, F#, G, G#, A, A#, B (offset 0..11)
      // Q-row (upper octave): Q 2 W 3 E R 5 T 6 Y 7 U -> C, C#, D, D#, E, F, F#, G, G#, A, A#, B (+12)
      const base = 60 + instOct*12
      const offsets = {
        KeyZ:0, KeyS:1, KeyX:2, KeyD:3, KeyC:4, KeyV:5, KeyG:6, KeyB:7, KeyH:8, KeyN:9, KeyJ:10, KeyM:11,
        KeyQ:12, Digit2:13, KeyW:14, Digit3:15, KeyE:16, KeyR:17, Digit5:18, KeyT:19, Digit6:20, KeyY:21, Digit7:22, KeyU:23
      }
      if (offsets[code] !== undefined) return base + offsets[code]
      return null
    }
    function noteOn(midi) {
      try {
        ensureAudio(); const ctx = audioCtxRef.current; const master = masterRef.current
        if (!ctx || !master) return
        const v = Math.max(0.05, Math.min(1, instVel/10))
        if (isSfSynth(synth)) {
          try { ensureSoundfontInstrument(sfInstrFromSynthName(synth) || 'acoustic_grand_piano') } catch {}
          // soundfont preview
          const node = playSf(midi, ctx.currentTime, 2.0, v, sfInstrFromSynthName(synth) || 'acoustic_grand_piano')
          heldOscs.set(midi, { sf: node })
          heldOscsRef.current.set(midi, { sf: node })
        } else {
          const freq = 440 * Math.pow(2, (midi - 69) / 12)
          const osc = ctx.createOscillator(); const g = ctx.createGain()
          osc.type = (synth||'Triangle').toLowerCase(); osc.frequency.setValueAtTime(freq, ctx.currentTime)
          g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.005)
          osc.connect(g); g.connect(master)
          osc.start();
          // store in refs to ensure visibility from all handlers
          heldOscs.set(midi, { osc, g })
          heldOscsRef.current.set(midi, { osc, g })
        }
      } catch {}
    }
    function noteOff(midi) {
      try {
        const ctx = audioCtxRef.current;
        const o = heldOscs.get(midi) || heldOscsRef.current.get(midi)
        if (!o || !ctx) return
        if (o.sf) {
          stopSfNode(o.sf)
        } else if (o.g && o.osc) {
          o.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05)
          o.osc.stop(ctx.currentTime + 0.08)
        }
        heldOscs.delete(midi); heldOscsRef.current.delete(midi)
      } catch {}
    }
    const heldOscs = new Map()
    function onDown(e) {
      const tag = (e.target&&e.target.tagName)||''; if (tag==='INPUT'||tag==='TEXTAREA') return
      if (e.code==='KeyI') { e.preventDefault(); ensureAudio(); setInstOn(v=>!v); return }
      if (e.code==='KeyR') { e.preventDefault();
        setComposeOn(v => {
          const next = !v
          if (next) {
            const spb = song?.stepsPerBar || 16
            const start = Math.max(0, Math.floor(currentBarsVis() * spb))
            setComposeStep(start)
            chordStartStepRef.current = start
            chordStartTsRef.current = 0
            // Prefer selected clip if any
            let clip = null
            const selId = (selectedClipIds && selectedClipIds.size>0) ? Array.from(selectedClipIds)[0] : null
            if (selId) clip = (song?.clips||[]).find(c => c.id === selId) || null
            // Else pick clip under caret step, choosing nearest track to lastArrTrackRef
            if (!clip) {
              const clipsAtStep = (song?.clips||[]).filter(c => start>=c.startStep && start < (c.startStep+c.lengthSteps))
              if (clipsAtStep.length) {
                const prefTrack = Number.isFinite(lastArrTrackRef.current) ? lastArrTrackRef.current : 0
                clip = clipsAtStep.reduce((a,b)=> (Math.abs((a?.track??0)-prefTrack) <= Math.abs((b?.track??0)-prefTrack) ? a : b))
              }
            }
            if (!clip) {
              const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
              const trackPref = Number.isFinite(lastArrTrackRef.current) ? lastArrTrackRef.current : 0
              clip = { id, track: Math.max(0, Math.min(ARR_TRACKS-1, trackPref)), startStep: start, lengthSteps: Math.max(spb/2, 4), patternId: (song?.activePatternId||'p1') }
              setSong(prev => prev ? { ...prev, clips: [...(prev.clips||[]), clip] } : prev)
              try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'clip_add', ...clip }] }) } catch {}
            }
            setComposeClipId(clip.id)
            // force a small rerender to ensure ghosts show on first keydown
            setComposeGhostTick(t=>t+1)
          } else {
            composeDownRef.current.clear()
          }
          return next
        })
        return }
      if (composeOn) {
        const now = performance.now()
        if (e.code==='Space') { e.preventDefault();
          if (chordActiveKeysRef.current.size === 0 && !composeDownRef.current.has('Space')) {
            chordStartStepRef.current = Math.round((composeLiveStepRef.current||composeStep))
            chordStartTsRef.current = now
            setComposeGhostTick(t=>t+1)
          }
          composeDownRef.current.set('Space', { tsMs: now });
          return }
        const midi = midiForKey(e.code)
        if (midi!==null && !composeDownRef.current.has(e.code)) {
          // compute absolute start step at the moment this key is pressed
          const spb = song?.stepsPerBar || 16
          const msPerBeat = 60000/tempo; const msPerBar = msPerBeat*4; const msPerStep = msPerBar/spb
          const spaceHeld = !!composeDownRef.current.get('Space')
          let startStepAbs
          if ((chordActiveKeysRef.current.size === 0 && !spaceHeld) || !chordStartTsRef.current) {
            // first key (and no space anchor): anchor at current caret (no elapsed yet)
            startStepAbs = Math.round((composeLiveStepRef.current||composeStep))
          } else {
            const elapsedSteps = Math.max(0, Math.floor((now - chordStartTsRef.current) / msPerStep))
            startStepAbs = (chordStartStepRef.current||composeStep) + elapsedSteps
          }
          composeDownRef.current.set(e.code, { tsMs: now, midi, vel: Math.max(0.05, Math.min(1, instVel/10)), startStepAbs })
          if (instOn && !heldKeysRef.current.has(e.code)) { heldKeysRef.current.add(e.code); noteOn(midi) }
          // chord start tracking
          chordActiveKeysRef.current.add(e.code)
          // anchor caret on first key only if Space is not serving as anchor
          if (chordActiveKeysRef.current.size === 1 && !composeDownRef.current.get('Space')) {
            chordStartStepRef.current = Math.round((composeLiveStepRef.current||composeStep))
            chordStartTsRef.current = now
          }
          setComposeGhostTick(t=>t+1)
          e.preventDefault(); return
        }
      }
      // Instrument playback only when Instrument mode is ON
      if (!instOn) return
      if (typingOn) return
      // prevent transport space in inst mode
      if (e.code==='Space') { e.preventDefault(); return }
      if (e.code=== 'Comma') { e.preventDefault(); setInstOct(o=>Math.max(-3, o-1)); return }
      if (e.code=== 'Period') { e.preventDefault(); setInstOct(o=>Math.min(3, o+1)); return }
      if (/^Digit[1-9]$/.test(e.code)) { e.preventDefault(); setInstVel(Number(e.code.slice(5))); return }
      const midi = midiForKey(e.code)
      if (midi!==null && !heldKeysRef.current.has(e.code)) { heldKeysRef.current.add(e.code); noteOn(midi) }
    }
    function onUp(e) {
      if (composeOn) {
        const spb = song?.stepsPerBar || 16
        const now = performance.now()
        if (e.code==='Space') {
          const rec = composeDownRef.current.get('Space'); composeDownRef.current.delete('Space')
          // Prefer the live rAF-updated position for exact final caret
          let caretAtRelease = Math.floor(composeLiveStepRef.current || (chordStartStepRef.current||composeStep))
          setComposeStep(caretAtRelease)
          // Also pin yellow transport caret to this position for visual consistency
          const barsAtRelease = (caretAtRelease / (song?.stepsPerBar || 16))
          setBaseBar(barsAtRelease)
          setBaseTsMs(Date.now())
          schedRef.current.nextStep = Math.floor(barsAtRelease * (song?.stepsPerBar || 16))
          chordStartStepRef.current = caretAtRelease
          chordStartTsRef.current = 0
          setComposeGhostTick(t=>t+1)
          e.preventDefault(); return
        }
        const m = midiForKey(e.code)
        const rec = composeDownRef.current.get(e.code)
        if (m!==null && rec) {
          composeDownRef.current.delete(e.code)
          // Stop live preview if Instrument is on
          if (instOn && heldKeysRef.current.has(e.code)) { heldKeysRef.current.delete(e.code); noteOff(m) }
          const msPerBeat = 60000/tempo; const msPerBar = msPerBeat*4; const msPerStep = msPerBar/spb
          let steps = Math.max(1, Math.round((now - rec.tsMs)/msPerStep))
          chordActiveKeysRef.current.delete(e.code)
          chordMaxStepsRef.current = Math.max(chordMaxStepsRef.current||0, steps)
          const clip = (song?.clips||[]).find(c=>c.id===composeClipId)
          if (clip) {
            const patId = clip.patternId || activePatternId
            const pat = (song?.patterns||[]).find(p=>p.id===patId) || activePattern
            const patSteps = Math.max(1, (pat?.bars||patternBars||4)*spb)
            const anchor = ((clip.startStep % patSteps) + patSteps) % patSteps
            const absStart = Number.isFinite(rec.startStepAbs) ? rec.startStepAbs : chordStartStepRef.current
            // place within the clip window, not modulo pattern: clamp to clip length
            const withinAbs = Math.max(0, absStart - clip.startStep)
            const localStart = (((clip.startStep + withinAbs) - anchor) % patSteps + patSteps) % patSteps
            let ops = []
            // extend pattern if needed
            const needed = localStart + steps
            if (needed > patSteps) {
              const newBars = Math.max(pat?.bars||1, Math.ceil(needed / spb))
              ops.push({ type:'pattern_update', id: patId, bars: newBars })
              setSong(prev => prev ? { ...prev, patterns: (prev.patterns||[]).map(p=> p.id===patId?{...p, bars:newBars}:p) } : prev)
            }
            // extend clip if needed
            const withinChord = (chordStartStepRef.current - clip.startStep)
            const needClipLen = withinChord + steps
            if (needClipLen > clip.lengthSteps) {
              ops.push({ type:'clip_update', id: clip.id, lengthSteps: needClipLen })
              setSong(prev => prev ? { ...prev, clips: (prev.clips||[]).map(c=> c.id===clip.id?{...c, lengthSteps: needClipLen}:c) } : prev)
            }
            // commit note
            const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
            ops.push({ type:'note_add', id, pitch: wrapPitchToVisible(m), startStep: localStart, lengthSteps: steps, velocity: rec.vel||0.8, synth, patternId: patId })
            try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
            // When last key releases, advance pointer only if Space is NOT held
            if (chordActiveKeysRef.current.size === 0) {
              const adv = chordMaxStepsRef.current || steps
              chordMaxStepsRef.current = 0
              if (!composeDownRef.current.get('Space')) {
                setComposeStep(chordStartStepRef.current + adv)
                chordStartStepRef.current = composeStep + adv
                chordStartTsRef.current = 0
              }
              // If Space is held, do not change anchors; caret continues smoothly
            }
            setComposeGhostTick(t=>t+1)
          }
          e.preventDefault(); return
        }
      }
      if (!instOn) return
      const midi = midiForKey(e.code)
      if (midi!==null) { heldKeysRef.current.delete(e.code); noteOff(midi) }
      if (e.code==='Escape') { setInstOn(false); setComposeOn(false) }
    }
    function onGlobalBlur() {
      for (const k of Array.from(heldKeysRef.current)) {
        const m = midiForKey(k); if (m!==null) { heldKeysRef.current.delete(k); noteOff(m) }
      }
      // hard stop any remaining oscs
      try {
        const ctx = audioCtxRef.current
        for (const [m, o] of Array.from(heldOscsRef.current.entries())) {
          if (!o || !ctx) continue
          o.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.02)
          o.osc.stop(ctx.currentTime + 0.04)
          heldOscsRef.current.delete(m)
        }
      } catch {}
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onGlobalBlur)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); window.removeEventListener('blur', onGlobalBlur) }
  }, [instOn, instOct, instVel, synth, typingOn, composeOn, song])

  // Keyboard + group operations
  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.isComposing) return
      if ((typingOn || composeOn) && e.code === 'Space') { e.preventDefault(); return }
      if (e.code === 'KeyL') {
        e.preventDefault()
        if (independentPattern) {
          setLocalLoopOn(v => {
            const next = !v
            if (next && song) {
              const spb = song.stepsPerBar
              const pos = Math.floor(currentBarsVis() * spb)
              setLocalLoopStartStep(pos)
              setLocalLoopEndStep(Math.min(pos + spb*2, song.bars*spb))
            }
            return next
          })
        } else {
          const spb = song.stepsPerBar
          const pos = Math.floor(currentBarsVis() * spb)
          const on = !loopOn
          const start = on ? pos : loopStartStep
          const end = on ? Math.min(pos + spb*2, song.bars*spb) : loopEndStep
          setLoopOn(on); setLoopStartStep(start); setLoopEndStep(end)
          try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on, startStep: start, endStep: end }] }) } catch {}
        }
        return
      }
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
  }, [playing, selectedId, selectedIds, rev, songId, song, typingOn, composeOn])

  // Helper to get effective loop values (respects Independent mode)
  const effLoopOn = independentPattern ? localLoopOn : loopOn
  const effLoopStart = independentPattern ? localLoopStartStep : loopStartStep
  const effLoopEnd = independentPattern ? localLoopEndStep : loopEndStep

  // Global key for pattern-from-loop (P = toggle preview, Enter = create, Esc = cancel)
  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return
      if (e.code === 'KeyP') {
        e.preventDefault()
        if (!song) return
        if (!(effLoopOn && effLoopEnd > effLoopStart)) return
        // Choose track: selected clip -> its track; else last hovered; else 0
        let t = 0
        const firstSel = Array.from(selectedClipIds || [])[0]
        const selClip = (song.clips||[]).find(c=>c.id===firstSel)
        if (selClip) t = selClip.track
        else if (Number.isFinite(loopTrackRef.current)) t = Math.max(0, Math.min(ARR_TRACKS-1, Number(loopTrackRef.current)))
        else if (Number.isFinite(lastArrTrackRef.current)) t = Math.max(0, Math.min(ARR_TRACKS-1, Number(lastArrTrackRef.current)))
        setLoopMakeTrack(t)
        setLoopMakeOn(true)
        return
      }
      if (!loopMakeOn) return
      if (e.code === 'Escape') { e.preventDefault(); setLoopMakeOn(false); return }
      if (e.code === 'Enter') {
        e.preventDefault()
        if (!song) return
        if (!(effLoopOn && effLoopEnd > effLoopStart)) { setLoopMakeOn(false); return }
        const spb = song.stepsPerBar
        const start = Math.max(0, Math.min(song.bars*spb-1, effLoopStart))
        const end = Math.max(start+1, Math.min(song.bars*spb, effLoopEnd))
        const len = end - start
        // Prevent overlap on chosen track
        const bad = (song.clips||[]).some(c => c.track===loopMakeTrack && !(end <= c.startStep || start >= (c.startStep + c.lengthSteps)))
        if (bad) return
        const bars = Math.max(1, Math.round(len / spb))
        const pid = 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2)
        const ops = [
          { type:'pattern_add', id: pid, name: 'Pattern '+((song.patterns||[]).length+1), bars },
          { type:'clip_add', id: Date.now().toString(36)+Math.random().toString(36).slice(2), track: loopMakeTrack, startStep: start, lengthSteps: len, patternId: pid },
        ]
        // Focus pattern
        if (!independentPattern) ops.push({ type:'pattern_select', id: pid })
        setLoopMakeOn(false)
        try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
        if (independentPattern) setLocalPatternId(pid)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [song, effLoopOn, effLoopStart, effLoopEnd, loopMakeOn, loopMakeTrack, rev, independentPattern, selectedClipIds])

  function handlePlay() {
    ensureAudio(); try { audioCtxRef.current?.resume?.() } catch {}
    const nowBars = currentBarsRaw()
    setPlaying(true); setBaseBar(nowBars); setBaseTsMs(Date.now())
    if (countInOn) { countInRef.current = { active: true, endStep: Math.floor((nowBars + 1) * (song?.stepsPerBar || 16)) } } else { countInRef.current.active = false }
    try { scheduleWindow(true) } catch {}
    try { socket?.emit?.('seq_transport', { songId, playing: true, positionBars: nowBars, tempo, shared: !independentPattern }) } catch {}
  }
  function handleStop() {
    setPlaying(false)
    countInRef.current.active = false
    try { socket?.emit?.('seq_transport', { songId, playing: false, positionBars: currentBarsRaw(), tempo, shared: !independentPattern }) } catch {}
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
        const color = (typeof n.synth === 'string' && n.synth.startsWith('SF:')) ? sfPreviewFor(n.synth.slice(3)) : ((PREVIEW_COLOR && PREVIEW_COLOR[n.synth]) || 'rgba(255,255,255,0.45)')
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

  const activePatternId = independentPattern ? (localPatternId || song?.activePatternId || (song?.patterns && song.patterns[0]?.id) || 'p1') : (song?.activePatternId || (song?.patterns && song.patterns[0]?.id) || 'p1')
  const activePattern = (song?.patterns || []).find(p => p.id === activePatternId)
  const notesForEditor = activePattern ? (activePattern.notes || []) : (song.notes || [])
  const patternBarsEff = activePattern ? activePattern.bars : (patternBars || 4)
  const patternSteps = Math.max(1, patternBarsEff) * song.stepsPerBar
  const arrSteps = song.bars * song.stepsPerBar
  
  return (
    <div ref={rootRef} className="w-full h-full bg-black text-white relative" onContextMenu={(e)=>{ e.preventDefault(); e.stopPropagation(); }}>
      <div className="absolute top-3 left-3 z-50 flex items-center gap-2">
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={onBack}>Back</button>
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={handlePlay}>Play</button>
        <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20 text-xs" onClick={handleStop}>Stop</button>
        <div className="px-2 py-1 text-xs bg-white/5 rounded">Tempo {tempo}</div>
        <div className="flex items-center gap-1 text-xs">
          <label className="ml-2 flex items-center gap-1 cursor-pointer select-none">
            <input type="checkbox" checked={linkClipToPattern} onChange={(e)=> setLinkClipToPattern(e.target.checked)} />
            <span>Link clip selection → pattern</span>
          </label>
          <div className={instOn?"px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 text-xs":"px-2 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-300 text-xs"} title="I: toggle • ,/. octave • 1-9 velocity • Esc: exit">
            {instOn ? `Instrument ON (${synth}) • Oct ${instOct>=0?`+${instOct}`:instOct} • Vel ${instVel}` : 'Press I: Instrument mode'}
          </div>
          {/* Compose HUD */}
          <div className={composeOn?"px-2 py-0.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-200 text-xs":"px-2 py-0.5 rounded bg-white/5 border border-white/10 text-zinc-300 text-xs"} title="R: toggle compose • Space: rest • Esc: exit">
            {composeOn ? `Compose ON • Step ${composeStep}` : 'R: Compose'}
          </div>
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
                    onChange={(e)=>{ const id = e.target.value; if (independentPattern) { setLocalPatternId(id) } else { try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_select', id }] }) } catch {} } }}>
              {(song.patterns||[{id:'p1',name:'Pattern 1'}]).map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
            </select>
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input type="checkbox" checked={independentPattern} onChange={(e)=> { const on = e.target.checked; setIndependentPattern(on); if (on) { setLocalPatternId(activePatternId); setLocalLoopOn(!!loopOn); setLocalLoopStartStep(loopStartStep); setLocalLoopEndStep(loopEndStep) } }} />
              <span>Independent</span>
            </label>
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
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={()=> setSfPaletteOpen(v=>!v)}>More…</button>
            {sfPaletteOpen && createPortal(
              <div className="fixed top-16 right-4 z-[1000] w-[360px] max-h-[70vh] overflow-auto rounded border border-white/10 bg-black/90 p-2 shadow-lg" onMouseDown={(e)=> e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                  <input className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-white" placeholder="Search instruments…" value={sfQuery} onChange={(e)=> setSfQuery(e.target.value)} />
                  <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={()=> setSfPaletteOpen(false)}>Close</button>
                </div>
                <SfInstrumentList query={sfQuery} onPick={(inst)=> { setSynth('SF:'+inst); setSfPaletteOpen(false); try { ensureSoundfontInstrument(inst) } catch {} }} />
              </div>, document.body)
            }
          </div>
          <div className="flex items-center gap-1">
            <span>Song</span>
            <input className="w-36 bg-black/40 border border-white/10 rounded px-2 py-0.5 text-white" placeholder="id" value={songSaveId} onChange={(e)=> setSongSaveId(e.target.value)} />
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={()=> saveSongSnapshot(songSaveId)}>Save</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={()=> loadSongSnapshot(songSaveId)}>Open</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={()=> listSongs()}>List</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={newSharedSong}>New</button>
            {isAdmin && (
              <button className="px-2 py-0.5 rounded bg-red-600/70 hover:bg-red-600/80" onClick={()=> deleteSong(songSaveId)}>Delete</button>
            )}
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={exportSongMp3}>Record Export</button>
            <button className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20" onClick={exportSongOffline}>Offline Export</button>
            {songsList && songsList.length>0 && (
              <select className="bg-black/40 border border-white/10 rounded px-1 py-0.5 text-white" value={songSaveId} onChange={(e)=> { setSongSaveId(e.target.value) }}>
                {songsList.map(id => (<option key={id} value={id}>{id}</option>))}
              </select>
            )}
          </div>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={metronomeOn} onChange={(e)=> setMetronomeOn(e.target.checked)} /> Metronome</label>
          <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={countInOn} onChange={(e)=> setCountInOn(e.target.checked)} /> Count‑in</label>
          <div className="flex items-center gap-2">
            <span>Zoom H</span>
            <input type="range" min="0.5" max="2" step="0.1" value={zoomX} onChange={(e)=> setZoomX(Number(e.target.value))} />
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
            e.preventDefault(); e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const sc = rulerScrollRef.current?.scrollLeft || 0
              // account for 0.5px background offset and device pixel rounding
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor((sc + x - 0.5) / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
            if (e.altKey) {
              loopDragRef.current = { active: true, start: step }
              if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(step); setLocalLoopEndStep(step) }
              else {
                setLoopOn(true); setLoopStartStep(step); setLoopEndStep(step)
                try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: step, endStep: step }] }) } catch {}
              }
              return
            }
            // Click to set compose caret on the pattern timeline as well
            if (!e.altKey) {
              const spaceHeld = !!composeDownRef.current.get('Space')
              if (spaceHeld) {
                chordStartStepRef.current = step
                chordStartTsRef.current = performance.now()
                composeLiveStepRef.current = step
              } else {
                setComposeStep(step)
                chordStartStepRef.current = step
                chordStartTsRef.current = 0
                composeLiveStepRef.current = step
              }
              caretStepFloatPrevRef.current = NaN
              setComposeGhostTick(t=>t+1)
            }
            // Preserve existing transport scrubbing with Shift
            const bars = step / song.stepsPerBar
            const shouldPlay = e.shiftKey || playing
            setBaseBar(bars); setBaseTsMs(Date.now()); schedRef.current.nextStep = Math.floor(bars * song.stepsPerBar)
            if (shouldPlay) { setPlaying(true); ensureAudio(); try { audioCtxRef.current?.resume?.() } catch {}; scheduleWindow(true) } else { setPlaying(false) }
            dragRef.current = { active: true, shift: shouldPlay }
            }}
            onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const sc = rulerScrollRef.current?.scrollLeft || 0
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor((sc + x - 0.5) / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
            if (loopDragRef.current.active || e.altKey) {
              const a = Math.min(loopDragRef.current.start, step)
              const b = Math.max(loopDragRef.current.start, step)
              if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
              else {
                setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b)
                try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {}
              }
              return
            }
            if (!dragRef.current.active) return
            const bars = step / song.stepsPerBar
            setBaseBar(bars); setBaseTsMs(Date.now())
            }}
            onMouseUp={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
              const x = (e.clientX - rect.left)
              const sc = rulerScrollRef.current?.scrollLeft || 0
              const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor((sc + x - 0.5) / (stepWArr))))
              const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
            if (loopDragRef.current.active) {
              const a = Math.min(loopDragRef.current.start, step)
              const b = Math.max(loopDragRef.current.start, step)
              if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
              else {
                setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b)
                try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {}
              }
              loopDragRef.current.active = false
              return
            }
            // Also set compose caret/live position here for reliability (incl step 0)
            if (!e.altKey) {
              const spaceHeld = !!composeDownRef.current.get('Space')
              if (spaceHeld) {
                chordStartStepRef.current = step
                chordStartTsRef.current = performance.now()
                composeLiveStepRef.current = step
              } else {
                setComposeStep(step)
                chordStartStepRef.current = step
                chordStartTsRef.current = 0
                composeLiveStepRef.current = step
              }
              caretStepFloatPrevRef.current = NaN
              setComposeGhostTick(t=>t+1)
            }
            const bars = step / song.stepsPerBar
            try { socket?.emit?.('seq_transport', { songId, playing: dragRef.current.shift, positionBars: bars, tempo, shared: !independentPattern }) } catch {}
            dragRef.current.active = false
            }}
            onMouseLeave={() => { dragRef.current.active = false }}
          >
            {/* loop overlay hidden on pattern ruler per request */}
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
              // allow marquee selection in both modes
              // Start marquee only when holding Shift; plain click will place notes
              if (e.button !== 0) return
              if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
                if (!e.shiftKey) return
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
                return
              }
              // Plain left click: live preview + drag to position, commit on release
              e.preventDefault(); e.stopPropagation()
              const host = e.currentTarget.getBoundingClientRect()
              const startX = e.clientX - host.left
              const startY = e.clientY - host.top
              let step = Math.max(0, Math.floor(startX / (STEP_UNIT*zoomX)))
              let row = Math.max(0, Math.min(PITCH_COUNT - 1, Math.floor(startY / (ROW_UNIT*zoomY))))
              let pitch = PITCH_MAX - row
              const patId = activePatternId
              const ghostEl = document.createElement('div')
              Object.assign(ghostEl.style, { position:'absolute', left: Math.round(step*STEP_UNIT*zoomX)+'px', top: Math.round(row*ROW_UNIT*zoomY)+'px', width: Math.max(1, Math.round(placeLenSteps*STEP_UNIT*zoomX))+'px', height:'14px', background:'rgba(125,211,252,0.35)', border:'1px solid rgba(186,230,253,0.6)', borderRadius:'3px', pointerEvents:'none', zIndex: 10 })
              e.currentTarget.appendChild(ghostEl)
              // start preview (oscillator or soundfont depending on synth)
              if (!heldKeysRef.current.has('MOUSE_NOTE')) {
                heldKeysRef.current.add('MOUSE_NOTE')
                try {
                  ensureAudio(); const ctx = audioCtxRef.current; const master = masterRef.current
                  const v = Math.max(0.05, Math.min(1, instVel/10))
                  if (isSfSynth(synth)) {
                    const node = playSf(pitch, ctx.currentTime, 2.0, v, sfInstrFromSynthName(synth) || 'acoustic_grand_piano')
                    heldOscsRef.current.set('MOUSE_NOTE', { sf: node })
                  } else {
                    const osc = ctx.createOscillator(); const g = ctx.createGain()
                    osc.type = (synth||'Triangle').toLowerCase(); osc.frequency.setValueAtTime(440*Math.pow(2,(pitch-69)/12), ctx.currentTime)
                    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.005)
                    osc.connect(g); g.connect(master); osc.start();
                    heldOscsRef.current.set('MOUSE_NOTE', { osc, g })
                  }
                } catch {}
              }
              const onMove = (ev) => {
                const xm = ev.clientX - host.left
                const ym = ev.clientY - host.top
                const stepNew = Math.max(0, Math.floor(xm / (STEP_UNIT*zoomX)))
                const rowNew = Math.max(0, Math.min(PITCH_COUNT - 1, Math.floor(ym / (ROW_UNIT*zoomY))))
                if (stepNew !== step) { step = stepNew; ghostEl.style.left = Math.round(step*STEP_UNIT*zoomX)+'px' }
                if (rowNew !== row) {
                  row = rowNew; pitch = PITCH_MAX - row; ghostEl.style.top = Math.round(row*ROW_UNIT*zoomY)+'px'
                }
                // always retune preview to current pitch during drag (oscillator only)
                try { const ctx = audioCtxRef.current; const o = heldOscsRef.current.get('MOUSE_NOTE'); if (o && o.osc) o.osc.frequency.setValueAtTime(440*Math.pow(2,(pitch-69)/12), ctx.currentTime) } catch {}
                // for soundfont, re-trigger when pitch changes
                try {
                  const ctx = audioCtxRef.current; const o = heldOscsRef.current.get('MOUSE_NOTE')
                  if (o && o.sf && typeof o.midi === 'number' && o.midi !== pitch) {
                    stopSfNode(o.sf)
                    const v2 = Math.max(0.05, Math.min(1, instVel/10))
                    const instName = sfInstrFromSynthName(synth) || 'acoustic_grand_piano'
                    const node2 = playSf(pitch, ctx?.currentTime || 0, 2.0, v2, instName)
                    heldOscsRef.current.set('MOUSE_NOTE', { sf: node2, midi: pitch })
                  } else if (o && o.sf && o.midi === undefined) {
                    // initialize midi tracking if missing
                    o.midi = pitch
                    heldOscsRef.current.set('MOUSE_NOTE', o)
                  }
                } catch {}
              }
              const onUp = (ev) => {
                window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                try { ghostEl.remove() } catch {}
                if (heldKeysRef.current.has('MOUSE_NOTE')) {
                  heldKeysRef.current.delete('MOUSE_NOTE')
                  try { const ctx = audioCtxRef.current; const o = heldOscsRef.current.get('MOUSE_NOTE'); if (o) { if (o.sf) { stopSfNode(o.sf) } else if (o.g && o.osc && ctx) { o.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05); o.osc.stop(ctx.currentTime + 0.08) } } heldOscsRef.current.delete('MOUSE_NOTE') } catch {}
                }
                suppressClickRef.current = true
                const id = Date.now().toString(36)+Math.random().toString(36).slice(2)
                const ops = [{ type:'note_add', id, pitch, startStep: step, lengthSteps: placeLenSteps, velocity: Math.max(0.05, Math.min(1, instVel/10)), synth, patternId: patId }]
                try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
              }
              window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
            }}
            onClick={(e) => {
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
                const y = e.clientY - rect2.top
                const deltaRows = Math.round((y - base.startY) / (ROW_UNIT*zoomY))
                const newGroupMin = clamp(base.groupMinStart + deltaSteps, 0, patternSteps - Math.max(1, base.groupMaxEnd - base.groupMinStart))
                const appliedDelta = newGroupMin - base.groupMinStart
                // Ensure drag preview exists (oscillator or soundfont)
                if (!heldKeysRef.current.has('DRAG_NOTE')) {
                  heldKeysRef.current.add('DRAG_NOTE')
                  try {
                    ensureAudio(); try { audioCtxRef.current?.resume?.() } catch {}
                    const ctx = audioCtxRef.current; const master = masterRef.current
                    if (ctx && master) {
                      const primaryId = (base.groupIds && base.groupIds.length) ? base.groupIds[0] : base.id
                      const origPitch = base.pitchById[primaryId]
                      const primaryNote = (notesForEditor||[]).find(x => x.id === primaryId)
                      const dragSynthName = (primaryNote && primaryNote.synth) ? primaryNote.synth : (synth||'Triangle')
                      const startPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, (origPitch||60)))
                      const v = Math.max(0.05, Math.min(1, instVel/10))
                      if (isSfSynth(dragSynthName)) {
                        const node = playSf(startPitch, ctx.currentTime, 2.0, v, sfInstrFromSynthName(dragSynthName) || 'acoustic_grand_piano')
                        heldOscsRef.current.set('DRAG_NOTE', { sf: node, midi: startPitch })
                      } else {
                        const osc = ctx.createOscillator(); const g = ctx.createGain()
                        osc.type = String(dragSynthName||'Triangle').toLowerCase()
                        osc.frequency.setValueAtTime(440*Math.pow(2,(startPitch-69)/12), ctx.currentTime)
                        g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.linearRampToValueAtTime(v, ctx.currentTime + 0.005)
                        osc.connect(g); g.connect(master); osc.start()
                        heldOscsRef.current.set('DRAG_NOTE', { osc, g })
                      }
                    }
                  } catch {}
                }
                // Retune drag preview
                try { const ctx = audioCtxRef.current; const o = heldOscsRef.current.get('DRAG_NOTE'); if (o && ctx) {
                  const primaryId = (base.groupIds && base.groupIds.length) ? base.groupIds[0] : base.id
                  const origPitch = base.pitchById[primaryId]
                  const newPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, (origPitch||60) - deltaRows))
                  // oscillator: live retune; soundfont: re-trigger if pitch changed
                  if (o.osc) {
                    const primaryNote = (notesForEditor||[]).find(x => x.id === primaryId)
                    if (primaryNote && primaryNote.synth) { try { o.osc.type = String(primaryNote.synth).toLowerCase() } catch {} }
                    o.osc.frequency.setValueAtTime(440*Math.pow(2,(newPitch-69)/12), ctx.currentTime)
                  } else if (o.sf) {
                    if (o.midi !== newPitch) {
                      try { stopSfNode(o.sf) } catch {}
                      const v = Math.max(0.05, Math.min(1, instVel/10))
                      const instName = sfInstrFromSynthName((notesForEditor||[]).find(x=>x.id===primaryId)?.synth || synth) || 'acoustic_grand_piano'
                      const node = playSf(newPitch, ctx.currentTime, 2.0, v, instName)
                      heldOscsRef.current.set('DRAG_NOTE', { sf: node, midi: newPitch })
                    }
                  }
                } } catch {}
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
              // Prevent grid click from adding a new note after a drag
              suppressClickRef.current = true
              noteDragRef.current.active = false
              // stop drag preview
              if (heldKeysRef.current.has('DRAG_NOTE')) {
                heldKeysRef.current.delete('DRAG_NOTE')
                try { const ctx = audioCtxRef.current; const o = heldOscsRef.current.get('DRAG_NOTE'); if (o) { if (o.sf) { stopSfNode(o.sf) } else if (o.g && o.osc && ctx) { o.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05); o.osc.stop(ctx.currentTime + 0.08) } } heldOscsRef.current.delete('DRAG_NOTE') } catch {}
              }
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
            {/* Compose caret and ghosts */}
            {composeOn && (
              <>
                <div ref={composeCaretRef} className="absolute top-0 h-full" style={{ left: Math.round(composeStep*STEP_UNIT*zoomX)+'px' }}>
                  <div className="w-[1px] h-full bg-sky-300/80" />
                </div>
                {/* Ghost notes for currently held keys */}
                {Array.from(composeDownRef.current.entries()).filter(([k,v])=>k!=='Space').map(([k,v])=>{
                  const spb = song.stepsPerBar
                  const patSteps = Math.max(1, (activePattern?.bars||patternBars||4)*spb)
                  const clip = (song.clips||[]).find(c=>c.id===composeClipId)
                  if (!clip) return null
                  const anchor = ((clip.startStep % patSteps)+patSteps)%patSteps
                  const absStart = (v && Number.isFinite(v.startStepAbs)) ? v.startStepAbs : chordStartStepRef.current
                  const localStart = ((absStart - anchor)+patSteps)%patSteps
                  const now = performance.now()
                  const msPerBeat = 60000/tempo; const msPerBar = msPerBeat*4; const msPerStep = msPerBar/spb
                  const heldStepsFloat = Math.max(0, (now - (v?.tsMs||now))/msPerStep)
                  const heldSteps = Math.max(1, Math.round(heldStepsFloat))
                  const x = Math.round(localStart*STEP_UNIT*zoomX)
                  const w = Math.max(1, Math.round(heldStepsFloat*STEP_UNIT*zoomX))
                  const midi = wrapPitchToVisible(v?.midi||60)
                  const row = (PITCH_MAX - midi)
                  const y = Math.round(row*ROW_UNIT*zoomY)
                  return <div ref={el => { if (el) composeGhostRefsRef.current[k] = el; else delete composeGhostRefsRef.current[k] }} key={'ghost_'+k} className="absolute rounded bg-sky-400/30 border border-sky-300/50 pointer-events-none" style={{ left:x, top:y, width:w, height:14 }} />
                })}
              </>
            )}
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
                           background: (typeof n.synth === 'string' && n.synth.startsWith('SF:')) ? sfGradientFor(n.synth.slice(3)) : (SYNTH_COLOR[(n && n.synth) ? n.synth : (typeof n.synth === 'string' ? n.synth : 'Triangle')] || SYNTH_COLOR.Triangle),
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
                    e.preventDefault(); e.stopPropagation()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const x = (e.clientX - rect.left)
                    const sc = arrRulerScrollRef.current?.scrollLeft || 0
                    const rawStepFloat = Math.max(0, Math.min(arrSteps-1, (sc + x) / stepWArr))
                    const rawStep = Math.floor(rawStepFloat)
                    const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                     if (e.altKey) {
                       loopDragRef.current = { active: true, start: step }
                       if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(step); setLocalLoopEndStep(step) }
                       else {
                         setLoopOn(true); setLoopStartStep(step); setLoopEndStep(step)
                         try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: step, endStep: step }] }) } catch {}
                       }
                       return
                     }
                    // Click to set compose caret start (respect Space-anchored motion)
                    const spaceHeld = !!composeDownRef.current.get('Space')
                    if (spaceHeld) {
                      chordStartStepRef.current = step
                      chordStartTsRef.current = performance.now()
                      composeLiveStepRef.current = step
                    } else {
                      setComposeStep(step)
                      chordStartStepRef.current = step
                      chordStartTsRef.current = 0
                      composeLiveStepRef.current = step
                    }
                    setComposeGhostTick(t=>t+1)
                  // Also move yellow caret (transport position) locally
                  const barsLoc = step / song.stepsPerBar
                  setBaseBar(barsLoc)
                  setBaseTsMs(Date.now())
                  schedRef.current.nextStep = Math.floor(barsLoc * song.stepsPerBar)
                   }}
                   onMouseMove={(e)=>{
                     const rect = e.currentTarget.getBoundingClientRect()
                     const x = (e.clientX - rect.left)
                     const rawStep = Math.max(0, Math.min(arrSteps-1, Math.floor(x / (stepWArr))))
                     const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                     if (loopDragRef.current.active || e.altKey) {
                       const a = Math.min(loopDragRef.current.start || step, step)
                       const b = Math.max(loopDragRef.current.start || step, step)
                       if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
                       else {
                         setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b)
                         try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {}
                       }
                     }
                   }}
                  onMouseUp={(e)=>{
                   const rect = e.currentTarget.getBoundingClientRect()
                   const x = (e.clientX - rect.left)
                   const sc = arrRulerScrollRef.current?.scrollLeft || 0
                   const rawStep = Math.max(0, Math.min(arrSteps-1, Math.round((sc + x) / (stepWArr))))
                   const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                    if (loopDragRef.current.active) {
                       const a = Math.min(loopDragRef.current.start, step)
                       const b = Math.max(loopDragRef.current.start, step)
                       if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
                       else {
                         setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b)
                         try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {}
                       }
                       loopDragRef.current.active = false
                       return
                    }
                    // If not looping, set compose caret here as well (more reliable than mousedown alone)
                    if (!e.altKey) {
                      const spaceHeld = !!composeDownRef.current.get('Space')
                      if (spaceHeld) {
                        chordStartStepRef.current = step
                        chordStartTsRef.current = performance.now()
                        composeLiveStepRef.current = step
                      } else {
                        setComposeStep(step)
                        chordStartStepRef.current = step
                        chordStartTsRef.current = 0
                        composeLiveStepRef.current = step
                      }
                      // reset preview tracker to avoid stale step gaps
                      caretStepFloatPrevRef.current = NaN
                      setComposeGhostTick(t=>t+1)
                      // And ensure yellow caret reflects the clicked position
                      const barsLoc2 = step / song.stepsPerBar
                      setBaseBar(barsLoc2)
                      setBaseTsMs(Date.now())
                      schedRef.current.nextStep = Math.floor(barsLoc2 * song.stepsPerBar)
                    }
                   }}
              >
                {(independentPattern ? localLoopOn : loopOn) && ((independentPattern ? localLoopEndStep : loopEndStep) > (independentPattern ? localLoopStartStep : loopStartStep)) && (
                  <div className="absolute top-0 h-full pointer-events-none" style={{ left: Math.round((independentPattern ? localLoopStartStep : loopStartStep)*stepWArr)+'px', width: Math.max(1, Math.round(((independentPattern ? localLoopEndStep : loopEndStep)-(independentPattern ? localLoopStartStep : loopStartStep))*stepWArr))+'px', background: 'rgba(34,197,94,0.18)', outline: '1px solid rgba(34,197,94,0.7)', zIndex: 5 }} />
                )}
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
                lastArrTrackRef.current = track
                const ty = (yAbs - track * ARR_TRACK_H) / ARR_TRACK_H
                if (sx>=0 && sx<=1 && sy>=0 && sy<=1) emitCursor({ sect: 'arr_grid', sx, sy, track, ty }, true)
              }}
              onMouseDown={(e)=>{
                if (mode !== 'arrangement') return
                if (e.button !== 0) return
                const host = (arrGridRef.current ? arrGridRef.current.getBoundingClientRect() : e.currentTarget.firstChild.getBoundingClientRect())
                const trackIdx = Math.max(0, Math.min(ARR_TRACKS-1, Math.floor((e.clientY - host.top) / ARR_TRACK_H)))
                const x = (e.clientX - host.left)
                const rawStep = Math.max(0, Math.min(arrSteps-1, Math.round(x / (stepWArr))))
                const step = Math.max(0, Math.min(arrSteps-1, snapStepArr(rawStep)))
                // Update compose caret and clip targeting when clicking grid
                if (composeOn) {
                  const clipsAtStep = (song?.clips||[]).filter(c => step>=c.startStep && step < (c.startStep+c.lengthSteps))
                  let target = clipsAtStep.find(c => c.track === trackIdx) || clipsAtStep[0] || null
                  if (target) {
                    setComposeClipId(target.id)
                  }
                  const spaceHeld = !!composeDownRef.current.get('Space')
                  if (spaceHeld) {
                    chordStartStepRef.current = step
                    chordStartTsRef.current = performance.now()
                    composeLiveStepRef.current = step
                  } else {
                    setComposeStep(step)
                    chordStartStepRef.current = step
                    chordStartTsRef.current = 0
                    composeLiveStepRef.current = step
                  }
                  caretStepFloatPrevRef.current = NaN
                  setComposeGhostTick(t=>t+1)
                }
                // ALT: start loop drag directly on the track lane; also capture track for pattern-from-loop
                if (e.altKey) {
                  loopTrackRef.current = trackIdx
                  if (loopMakeOn) setLoopMakeTrack(trackIdx)
                  loopDragRef.current = { active: true, start: step }
                  if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(step); setLocalLoopEndStep(step) }
                  else { setLoopOn(true); setLoopStartStep(step); setLoopEndStep(step); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: step, endStep: step }] }) } catch {} }
                  const onMove = (ev) => {
                    const xm = Math.max(0, Math.min(arrSteps-1, Math.floor((ev.clientX - host.left) / stepWArr)))
                    const st = Math.max(0, Math.min(arrSteps-1, snapStepArr(xm)))
                    // track under mouse as you drag
                    const yAbsM = Math.max(0, Math.min(host.height - 1, ev.clientY - host.top))
                    const trM = Math.max(0, Math.min(ARR_TRACKS - 1, Math.floor(yAbsM / ARR_TRACK_H)))
                    loopTrackRef.current = trM
                    if (loopMakeOn) setLoopMakeTrack(trM)
                    const a = Math.min(loopDragRef.current.start || st, st)
                    const b = Math.max(loopDragRef.current.start || st, st)
                    if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
                    else { setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {} }
                  }
                  const onUp = (ev) => {
                    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                    const xm = Math.max(0, Math.min(arrSteps-1, Math.floor((ev.clientX - host.left) / stepWArr)))
                    const stp = Math.max(0, Math.min(arrSteps-1, snapStepArr(xm)))
                    const a = Math.min(loopDragRef.current.start, stp)
                    const b = Math.max(loopDragRef.current.start, stp)
                    if (independentPattern) { setLocalLoopOn(true); setLocalLoopStartStep(a); setLocalLoopEndStep(b) }
                    else { setLoopOn(true); setLoopStartStep(a); setLoopEndStep(b); try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops: [{ type: 'set_loop', on: true, startStep: a, endStep: b }] }) } catch {} }
                    // finalize chosen track for P preview if active
                    if (loopMakeOn && Number.isFinite(loopTrackRef.current)) setLoopMakeTrack(Math.max(0, Math.min(ARR_TRACKS-1, Number(loopTrackRef.current))))
                    loopDragRef.current.active = false
                  }
                  window.addEventListener('mousemove', onMove)
                  window.addEventListener('mouseup', onUp)
                  return
                }
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
                {(independentPattern ? localLoopOn : loopOn) && ((independentPattern ? localLoopEndStep : loopEndStep) > (independentPattern ? localLoopStartStep : loopStartStep)) && (
                  <div className="absolute top-0 h-full pointer-events-none" style={{ left: Math.round((independentPattern ? localLoopStartStep : loopStartStep)*stepWArr)+'px', width: Math.max(1, Math.round(((independentPattern ? localLoopEndStep : loopEndStep)-(independentPattern ? localLoopStartStep : loopStartStep))*stepWArr))+'px', background: 'rgba(34,197,94,0.10)', outline: '1px solid rgba(34,197,94,0.5)', zIndex: 3 }} />
                )}
                {/* grid */}
                <div className="absolute inset-0"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.12) 0, rgba(255,255,255,0.12) 1px, transparent 1px, transparent ${Math.round(song.stepsPerBar*stepWArr)}px),
                                      repeating-linear-gradient(to right, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${Math.round(stepWArr)}px),
                                      repeating-linear-gradient(to bottom, rgba(255,255,255,0.05) 0, rgba(255,255,255,0.05) 1px, transparent 1px, transparent ${ARR_TRACK_H}px)`,
                    backgroundPosition: '0.5px 0.5px, 0.5px 0.5px, 0.5px 0.5px'
                  }} />
                {/* pattern-from-loop preview overlay on chosen track */}
                {loopMakeOn && effLoopOn && (effLoopEnd > effLoopStart) && (
                  (() => {
                    const left = Math.round(effLoopStart * stepWArr)
                    const width = Math.max(1, Math.round((effLoopEnd - effLoopStart) * stepWArr))
                    const top = loopMakeTrack * ARR_TRACK_H
                    const bad = (song.clips||[]).some(c => c.track===loopMakeTrack && !(effLoopEnd <= c.startStep || effLoopStart >= (c.startStep + c.lengthSteps)))
                    return (
                      <div className={bad?"absolute rounded border border-red-400/80 bg-red-500/20 pointer-events-none":"absolute rounded border border-blue-300/80 bg-blue-400/20 pointer-events-none"}
                           style={{ left:left+'px', top: top+'px', width: width+'px', height: (ARR_TRACK_H-2)+'px', zIndex: 6 }} />
                    )
                  })()
                )}
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
                    <div key={c.id} className="absolute rounded border"
                      style={{ left:x, top:y+4, width:w, height:ARR_TRACK_H-8, backgroundImage: bg?`url(${bg})`:'none', backgroundSize: `${pat?Math.round((pat.bars*song.stepsPerBar)*stepWArr):Math.round(patternSteps*stepWArr)}px ${ARR_TRACK_H-8}px`, backgroundRepeat:'repeat-x', backgroundPosition: `0px 0px`,
                               backgroundColor: selectedClipIds.has(c.id) ? 'rgba(59,130,246,0.75)' : 'rgba(59,130,246,0.6)', borderColor: selectedClipIds.has(c.id) ? 'rgba(147,197,253,0.9)' : 'rgba(147,197,253,0.5)' }}
                      data-prev={previewVersion}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return
                        e.preventDefault(); e.stopPropagation()
                        // selection handling (Ctrl to multi-select, otherwise single)
                        setSelectedClipIds(prev => {
                          const next = new Set(prev)
                          if (e.ctrlKey || e.metaKey) { if (next.has(c.id)) next.delete(c.id); else next.add(c.id) }
                          else { next.clear(); next.add(c.id) }
                          return next
                        })
                        // Auto-select this clip's pattern if linking is enabled
                        if (linkClipToPattern && c.patternId && c.patternId !== activePatternId) {
                          if (independentPattern) { setLocalPatternId(c.patternId) }
                          else { try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops:[{ type:'pattern_select', id: c.patternId }] }) } catch {} }
                        }
                        // If compose is ON, switch compose target to this clip for note placement
                        if (composeOn) {
                          setComposeClipId(c.id)
                          // Re-anchor compose to this clip's start if Space is held
                          if (composeDownRef.current.get('Space')) {
                            chordStartStepRef.current = c.startStep
                            chordStartTsRef.current = performance.now()
                          }
                          setComposeGhostTick(t=>t+1)
                        }
                        const host = e.currentTarget.parentElement.getBoundingClientRect()
                        const startX = e.clientX - host.left
                        const startY = e.clientY - host.top
                        const startStep = c.startStep
                        const startLen = c.lengthSteps
                        const startTrack = c.track
                        const distLeft = Math.max(0, startX - x)
                        const distRight = Math.max(0, (x + w) - startX)
                        const edgeThreshold = Math.min(10, Math.floor(w / 3))
                        let isResizeLeft = distLeft <= edgeThreshold
                        let isResizeRight = !isResizeLeft && (distRight <= edgeThreshold)
                        const isResize = isResizeLeft || isResizeRight
                        const initialSelection = (e.ctrlKey || e.metaKey) ? new Set(selectedClipIds).add(c.id) : (selectedClipIds.size ? new Set(selectedClipIds) : new Set([c.id]))
                        const items = (song?.clips||[]).filter(q => initialSelection.has(q.id))
                        const baseById = new Map(items.map(item => [item.id, { startStep: item.startStep, track: item.track, lengthSteps: item.lengthSteps }]))
                        const onMove = (ev) => {
                          const xm = ev.clientX - host.left
                          const ym = ev.clientY - host.top
                          const deltaSteps = snapStepArr(Math.floor((xm - startX) / stepWArr))
                          const deltaTracksRaw = Math.round((ym - startY) / ARR_TRACK_H)
                          const deltaTracks = ev.shiftKey ? 0 : deltaTracksRaw
                          if (isResize && items.length === 1) {
                            setSong(prev => {
                              if (!prev) return prev
                              const others = (prev.clips||[]).filter(q => q.track === startTrack && q.id !== c.id)
                              if (isResizeRight) {
                                // cap to next clip start on same track
                                let maxLen = arrSteps - startStep
                                for (const o of others) {
                                  const oStart = o.startStep
                                  if (oStart > startStep) maxLen = Math.min(maxLen, oStart - startStep)
                                }
                                const newLen = clamp(startLen + deltaSteps, 1, Math.max(1, maxLen))
                                return { ...prev, clips: (prev.clips||[]).map(q => q.id===c.id?{...q, lengthSteps:newLen}:q) }
                              } else {
                                // left edge: move start earlier/later and adjust length opposite
                                // find previous clip end to avoid overlap
                                let minStart = 0
                                for (const o of others) {
                                  const oEnd = o.startStep + o.lengthSteps
                                  if (oEnd <= startStep) minStart = Math.max(minStart, oEnd)
                                }
                                let candidateStart = clamp(startStep + deltaSteps, minStart, startStep + startLen - 1)
                                // keep within grid bounds
                                candidateStart = clamp(candidateStart, 0, Math.max(0, startStep + startLen - 1))
                                const newLen = clamp(startLen + (startStep - candidateStart), 1, startLen + (startStep - minStart))
                                const newStart = clamp(candidateStart, minStart, startStep + startLen - 1)
                                return { ...prev, clips: (prev.clips||[]).map(q => q.id===c.id?{...q, startStep:newStart, lengthSteps:newLen}:q) }
                              }
                            })
                          } else {
                            setSong(prev => {
                              if (!prev) return prev
                              const nonSelected = (prev.clips||[]).filter(z => !initialSelection.has(z.id))
                              function overlapsAny(track, start, len, selfId) {
                                const end = start + len
                                for (const z of nonSelected) {
                                  if (z.track !== track) continue
                                  const ze = z.startStep + z.lengthSteps
                                  if (start < ze && end > z.startStep) return true
                                }
                                return false
                              }
                              return { ...prev, clips: (prev.clips||[]).map(q => {
                                if (!initialSelection.has(q.id)) return q
                                const base = baseById.get(q.id) || { startStep: q.startStep, track: q.track }
                                let nextStart = clamp(base.startStep + deltaSteps, 0, arrSteps - q.lengthSteps)
                                let nextTrack = clamp(base.track + deltaTracks, 0, ARR_TRACKS - 1)
                                if (overlapsAny(nextTrack, nextStart, q.lengthSteps, q.id)) {
                                  nextStart = base.startStep
                                  nextTrack = base.track
                                }
                                return { ...q, startStep: nextStart, track: nextTrack }
                              }) }
                            })
                          }
                        }
                        const onUp = (ev) => {
                          window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
                          const current = (songRef.current?.clips||[]).filter(q => initialSelection.has(q.id))
                          const ops = []
                          for (const it of current) {
                            const base = baseById.get(it.id)
                            if (!base) continue
                            if (isResize && items.length === 1) {
                              if (isResizeRight) {
                                if (it.lengthSteps !== base.lengthSteps) ops.push({ type:'clip_update', id: it.id, lengthSteps: it.lengthSteps })
                              } else if (isResizeLeft) {
                                if (it.startStep !== base.startStep || it.lengthSteps !== base.lengthSteps) ops.push({ type:'clip_update', id: it.id, startStep: it.startStep, lengthSteps: it.lengthSteps })
                              }
                            } else {
                              if (it.startStep !== base.startStep) ops.push({ type:'clip_update', id: it.id, startStep: it.startStep })
                              if (it.track !== base.track) ops.push({ type:'clip_update', id: it.id, track: it.track })
                            }
                          }
                          if (ops.length) {
                            // Record pending updates so echoes don't revert local state
                            const ts = Date.now()
                            for (const o of ops) {
                              const prev = pendingClipUpdatesRef.current.get(o.id) || {}
                              const rec = { ...prev, ts }
                              if (o.startStep !== undefined) rec.startStep = o.startStep
                              if (o.track !== undefined) rec.track = o.track
                              if (o.lengthSteps !== undefined) rec.lengthSteps = o.lengthSteps
                              pendingClipUpdatesRef.current.set(o.id, rec)
                            }
                            try { socket?.emit?.('seq_ops', { songId, parentRev: rev, ops }) } catch {}
                            // also optimistically apply to local state immediately to avoid flicker
                            setSong(prev => prev ? { ...prev, clips: (prev.clips||[]).map(q => {
                              const upd = ops.find(o => o.id === q.id)
                              if (!upd) return q
                              return {
                                ...q,
                                startStep: (upd.startStep !== undefined ? upd.startStep : q.startStep),
                                track: (upd.track !== undefined ? upd.track : q.track),
                                lengthSteps: (upd.lengthSteps !== undefined ? upd.lengthSteps : q.lengthSteps)
                              }
                            }) } : prev)
                          }
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
            const cur = remoteCursors[id]
            if (cur && typeof cur.sect === 'string' && isFinite(cur.sx) && isFinite(cur.sy)) {
              let target = null
              if (cur.sect === 'pattern_grid') target = gridRef.current
              else if (cur.sect === 'arr_grid') target = arrGridRef.current
              if (target) {
                const rect = target.getBoundingClientRect()
                const x = rect.left + cur.sx * rect.width
                let y
                if (cur.sect === 'arr_grid' && typeof cur.track === 'number' && isFinite(cur.track) && typeof cur.ty === 'number' && isFinite(cur.ty)) {
                  const t = Math.max(0, Math.min(ARR_TRACKS - 1, Math.round(cur.track)))
                  y = rect.top + (t * ARR_TRACK_H) + cur.ty * ARR_TRACK_H
                } else {
                  y = rect.top + cur.sy * rect.height
                }
                return (
                  <div key={`rt_${id}`} className="absolute select-none" style={{ left: `${x}px`, top: `${y}px`, transform: 'translate(8px, -50%)' }}>
                    <span className="font-medium" style={{ color: col, textShadow: '0 0 6px rgba(0,0,0,0.65)' }}>{r.text}</span>
                  </div>
                )
              }
            }
            // Fallback to page-normalized position from typing event
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


