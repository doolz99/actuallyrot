import React, { useEffect, useMemo, useRef, useState } from 'react'
import panzoom from 'panzoom'
import StaticBackground from './StaticBackground.jsx'

export default function Circles({ selfId, users, pairs, timesBySocket = {}, pairRot = {}, tvIds = [], adminIds = [], pinups = [], onRequestChat, onOpenTV }) {
  const viewportRef = useRef(null)
  const worldRef = useRef(null)
  const panzoomRef = useRef(null)
  const hoverAudioRef = useRef(null)
  const hoverCountRef = useRef(0)
  const ambientAudioRef = useRef(null)
  const ambientTimerRef = useRef(null)
  const worldWidth = 5000
  const worldHeight = 3500
  const isLocalAdmin = () => { try { return localStorage.getItem('dooly_admin') === '1' } catch { return false } }
  const isAdminId = (id) => adminIds.includes(id) || (id === selfId && isLocalAdmin())
  // simple animation ticker for tendrils
  const [animT, setAnimT] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      setAnimT(t => (t + 0.016) % 10000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // sizing helpers
  const TV_DIAMETER = 400
  const MAX_DIAMETER = Math.round((2/3) * TV_DIAMETER) // ~267
  const BASE_DIAMETER = 64
  const ADMIN_BASE_DIAMETER = 128
  const HOURS_TO_MAX = 50
  function hoursFromMs(ms) { return Math.max(0, (ms || 0) / 3600000) }
  function lerp(a, b, f) { return a + (b - a) * f }
  function clamp01(x) { return Math.max(0, Math.min(1, x)) }
  const others = users.filter(u => u.id !== selfId)
  // TV hover/static
  const tvHoverRef = useRef(false)
  const [tvHover, setTvHover] = useState(false)
  const tvCanvasRef = useRef(null)
  const tvTimerRef = useRef(null)
  const tvAudioRef = useRef(null)
  const tvHoverCountRef = useRef(0)
  // Build a set of userIds that are currently paired
  const pairedUserIds = new Set()
  pairs.forEach(({ a, b }) => {
    pairedUserIds.add(a)
    pairedUserIds.add(b)
  })

  function hashString(str) {
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i)
      hash = hash | 0
    }
    return Math.abs(hash)
  }

  function hashToGray(key) {
    const h = hashString(key) >>> 0
    const lightness = 28 + (h % 55) // 28..82
    return { color: `hsl(0 0% ${lightness}%)`, lightness }
  }

  function grayTextFor(lightness) {
    const shifted = lightness < 50 ? lightness + 20 : lightness - 20
    const clamp = Math.max(0, Math.min(100, shifted))
    return `hsl(0 0% ${clamp}%)`
  }

  // Build a wavy SVG path between two points
  function buildWavePath(x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    // perpendicular
    const nx = -uy
    const ny = ux
    const steps = Math.max(16, Math.floor(len / 40))
    const waves = Math.max(2, Math.floor(len / 180))
    const amp = Math.min(24, Math.max(8, len * 0.06))
    const q = (v) => Math.round(v) // snap to integer px to reduce shimmer
    let d = `M ${q(x1)} ${q(y1)}`
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const bx = x1 + dx * t
      const by = y1 + dy * t
      const offset = Math.sin(t * waves * Math.PI * 2) * amp
      const px = bx + nx * offset
      const py = by + ny * offset
      d += ` L ${q(px)} ${q(py)}`
    }
    return d
  }

  function makeClusterPlacer() {
    // Cluster near center within a bounded region, unique cell per entity
    const clusterWidth = 1500
    const clusterHeight = 1000
    const left = (worldWidth - clusterWidth) / 2
    const top = (worldHeight - clusterHeight) / 2
    const cols = 24
    const rows = 16
    const total = cols * rows
    const cellW = clusterWidth / cols
    const cellH = clusterHeight / rows
    const used = new Set()

    // TV geometry (avoid spawning inside)
    const tvX = worldWidth / 2
    const tvY = worldHeight / 2
    const tvRadius = 200 // matches 400px TV diameter
    const tvClearance = 100 // keep circles at least 100px away from TV edge

    function inTv(x, y) {
      const dx = x - tvX
      const dy = y - tvY
      // Exclude any point within the TV radius plus the clearance buffer
      return (dx * dx + dy * dy) <= Math.pow(tvRadius + tvClearance, 2)
    }

    function findCellIndex(seed) {
      let idx = seed % total
      for (let step = 0; step < total; step++) {
        const probe = (idx + step) % total
        if (!used.has(probe)) {
          used.add(probe)
          return probe
        }
      }
      return 0
    }

    function place(key) {
      const h = hashString(key)
      let baseIndex = h % total
      // probe for a free cell that is not inside the TV circle
      for (let step = 0; step < total; step++) {
        const probe = (baseIndex + step) % total
        if (used.has(probe)) continue
        const cx = probe % cols
        const cy = Math.floor(probe / cols)
        const jx = ((Math.floor(h / 997) % 1000) / 1000) * 0.6 + 0.2 // 0.2..0.8
        const jy = ((Math.floor(h / 787) % 1000) / 1000) * 0.6 + 0.2 // 0.2..0.8
        const x = left + (cx + jx) * cellW
        const y = top + (cy + jy) * cellH
        if (!inTv(x, y)) {
          used.add(probe)
          return { x, y }
        }
      }
      // fallback: first free, even if inside (should be rare)
      const index = findCellIndex(h)
      const cx = index % cols
      const cy = Math.floor(index / cols)
      const jx = ((Math.floor(h / 997) % 1000) / 1000) * 0.6 + 0.2
      const jy = ((Math.floor(h / 787) % 1000) / 1000) * 0.6 + 0.2
      const x = left + (cx + jx) * cellW
      const y = top + (cy + jy) * cellH
      return { x, y }
    }

    return place
  }

  useEffect(() => {
    if (!worldRef.current) return
    const instance = panzoom(worldRef.current, {
      maxZoom: 3,
      minZoom: 0.3,
      smoothScroll: false,
      bounds: false,
      zoomDoubleClickSpeed: 1,
    })
    panzoomRef.current = instance
    // Center viewport on the TV circle when entering the circles page
    const centerOnTV = () => {
      try {
        if (!viewportRef.current) return
        const { clientWidth, clientHeight } = viewportRef.current
        const tvX = worldWidth / 2
        const tvY = worldHeight / 2
        const scale = instance.getTransform().scale
        const targetX = clientWidth / 2 - tvX * scale
        const targetY = clientHeight / 2 - tvY * scale
        instance.moveTo(targetX, targetY)
      } catch {}
    }
    centerOnTV()
    // Ensure after layout/transform settles
    try { requestAnimationFrame(centerOnTV) } catch {}
    return () => instance.dispose()
  }, [])

  // Draw strong TV static when hovering the TV tile
  function startTVStatic() {
    tvHoverRef.current = true
    setTvHover(true)
    const canvas = tvCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.clientWidth || 1
      const h = canvas.clientHeight || 1
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.imageSmoothingEnabled = false
    }
    resize()
    if (tvTimerRef.current) clearInterval(tvTimerRef.current)
    tvTimerRef.current = setInterval(() => {
      if (!tvHoverRef.current) return
      const { width, height } = canvas
      const img = ctx.createImageData(width, height)
      const data = img.data
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255
        data[i] = v
        data[i+1] = v
        data[i+2] = v
        data[i+3] = 255
      }
      ctx.putImageData(img, 0, 0)
    }, 40) // ~25 FPS
    const onResize = () => resize()
    window.addEventListener('resize', onResize)
    canvas._cleanup = () => {
      window.removeEventListener('resize', onResize)
      if (tvTimerRef.current) { clearInterval(tvTimerRef.current); tvTimerRef.current = null }
    }

    // Start TV hover audio if available and user has interacted (singleton)
    try {
      if (!tvAudioRef.current) {
        const a = new Audio('/tv_hover.mp3')
        a.loop = true
        a.volume = 0.45
        tvAudioRef.current = a
      }
      if (tvAudioRef.current.paused) {
        tvAudioRef.current.currentTime = 0
        tvAudioRef.current.play().catch(() => {})
      }
    } catch {}
  }

  function stopTVStatic() {
    tvHoverRef.current = false
    setTvHover(false)
    if (tvTimerRef.current) { clearInterval(tvTimerRef.current); tvTimerRef.current = null }
    const canvas = tvCanvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d', { alpha: true })
      // Clear to solid black so screen is dark when not hovered
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      // Stop TV hover audio singleton
      if (tvAudioRef.current) { try { tvAudioRef.current.pause() } catch {}; try { tvAudioRef.current.currentTime = 0 } catch {} }
    }
  }

  function handleOpenTV() {
    // Ensure hover static/audio stop before navigating
    try { stopTVStatic() } catch {}
    onOpenTV?.()
  }

  // Stop the legacy hover sound
  function stopHoverAudio() {
    hoverCountRef.current = 0
    const a = hoverAudioRef.current
    if (a) { try { a.pause() } catch {}; try { a.currentTime = 0 } catch {} }
  }

  // Composite handlers for TV-connected circle hover
  function handleInTvEnter() {
    stopHoverAudio()
    startTVStatic()
  }

  function handleInTvLeave() {
    stopHoverAudio()
    stopTVStatic()
  }

  // Shared hover audio (loops while hovering any circle)
  useEffect(() => {
    try {
      const a = new Audio('/hover.mp3')
      a.loop = true
      a.preload = 'auto'
      a.volume = 1
      hoverAudioRef.current = a
    } catch {}
    return () => {
      try { hoverAudioRef.current?.pause?.() } catch {}
      hoverAudioRef.current = null
    }
  }, [])

  // Ambient audio that slowly ramps volume the longer you're on the circles page
  useEffect(() => {
    try {
      const a = new Audio('/ambient.mp3')
      a.loop = true
      a.preload = 'auto'
      a.volume = 0
      ambientAudioRef.current = a
      const tryPlay = () => {
        a.play().catch(() => {})
      }
      if (document.visibilityState === 'visible') {
        if (a.readyState >= 1) tryPlay()
        else a.addEventListener('loadedmetadata', tryPlay, { once: true })
      }
      const resumeOnInteract = () => {
        tryPlay()
        window.removeEventListener('pointerdown', resumeOnInteract)
      }
      window.addEventListener('pointerdown', resumeOnInteract)

      const rampSeconds = 120
      ambientTimerRef.current = setInterval(() => {
        if (document.visibilityState !== 'visible') return
        const audio = ambientAudioRef.current
        if (!audio) return
        const step = 1 / rampSeconds
        const next = Math.min(1, (audio.volume || 0) + step)
        try { audio.volume = next } catch {}
      }, 1000)

      const onVis = () => {
        if (document.visibilityState === 'visible') tryPlay()
        else { try { a.pause() } catch {} }
      }
      document.addEventListener('visibilitychange', onVis)

      return () => {
        document.removeEventListener('visibilitychange', onVis)
        window.removeEventListener('pointerdown', resumeOnInteract)
        if (ambientTimerRef.current) {
          clearInterval(ambientTimerRef.current)
          ambientTimerRef.current = null
        }
        try { ambientAudioRef.current?.pause?.() } catch {}
        ambientAudioRef.current = null
      }
    } catch {
      return () => {}
    }
  }, [])

  function onHoverStart() {
    hoverCountRef.current += 1
    const a = hoverAudioRef.current
    if (a && a.paused) {
      a.currentTime = 0
      a.play().catch(() => {})
    }
  }

  function onHoverEnd() {
    hoverCountRef.current = Math.max(0, hoverCountRef.current - 1)
    if (hoverCountRef.current === 0) {
      const a = hoverAudioRef.current
      if (a) {
        try { a.pause() } catch {}
        try { a.currentTime = 0 } catch {}
      }
    }
  }

  // Center viewport on the cluster whenever participants change
  useEffect(() => {
    const instance = panzoomRef.current
    if (!instance || !viewportRef.current) return
    // Compute centroid of all visible entities
    const place = makeClusterPlacer()
    const positions = []
    pairs.forEach(({ a, b }) => {
      const key = [a, b].sort().join('|')
      positions.push(place(key))
    })
    others.filter(u => !pairedUserIds.has(u.id)).forEach(u => {
      positions.push(place(u.id))
    })
    if (positions.length === 0) {
      // No users yet: center on TV to avoid empty black view
      try {
        const { clientWidth, clientHeight } = viewportRef.current
        const tvX = worldWidth / 2
        const tvY = worldHeight / 2
        const scale = instance.getTransform().scale
        const targetX = clientWidth / 2 - tvX * scale
        const targetY = clientHeight / 2 - tvY * scale
        instance.moveTo(targetX, targetY)
      } catch {}
      return
    }
    const cx = positions.reduce((s,p)=>s+p.x,0) / positions.length
    const cy = positions.reduce((s,p)=>s+p.y,0) / positions.length
    const { clientWidth, clientHeight } = viewportRef.current
    const current = instance.getTransform()
    const scale = current.scale
    const targetX = clientWidth/2 - cx * scale
    const targetY = clientHeight/2 - cy * scale
    instance.moveTo(targetX, targetY)
  }, [users, pairs])

  // Local ticking clock (client-side) to display HH:MM:SS smoothly
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  function msToHMS(ms) {
    const totalSec = Math.floor(ms / 1000)
    const s = totalSec % 60
    const m = Math.floor(totalSec / 60) % 60
    const h = Math.floor(totalSec / 3600) // can exceed 99
    const pad = (n) => String(n).padStart(2, '0')
    return `${h}:${pad(m)}:${pad(s)}`
  }

  function effectiveMsForSocket(socketId) {
    const rec = timesBySocket[socketId]
    if (!rec) return 0
    const base = Number(rec.totalMs) || 0
    // We let seconds tick visually on client if isActive
    if (rec.isActive) {
      const extra = (nowMs % 1000) >= 0 ? Math.floor((nowMs - nowMs % 1000) % 1000) : 0
      // Add exactly one second per tick boundary we cross. To keep it simple visually, add 0..999ms based on current second progress.
      const progressMs = nowMs % 1000
      return base + progressMs
    }
    return base
  }

  const timesMemo = useMemo(() => {
    // Build a mapping for quick access
    const single = new Map()
    others.forEach(u => {
      single.set(u.id, effectiveMsForSocket(u.id))
    })
    const pairTotal = new Map()
    pairs.forEach(({ a, b }) => {
      const ta = effectiveMsForSocket(a)
      const tb = effectiveMsForSocket(b)
      pairTotal.set([a, b].sort().join('|'), ta + tb)
    })
    return { single, pairTotal }
  }, [others, pairs, timesBySocket, nowMs])

  return (
    <div className="w-full h-full relative">
      {/* Local admin logout button */}
      {isLocalAdmin() && (
        <button
          className="fixed top-2 left-2 z-50 px-2 py-1 text-[10px] rounded bg-white/10 hover:bg-white/20 text-white"
          onClick={() => {
            try { localStorage.removeItem('dooly_admin') } catch {}
            try { window.__socket?.emit?.('identify_admin', { isAdmin: false }) } catch {}
            try { window.__adminActive = false } catch {}
          }}
        >Logout admin</button>
      )}
      <StaticBackground opacity={0.06} fps={20} />
      {/* TV button is rendered inside the world (pans/zooms) */}
      <div
        ref={viewportRef}
        className="fixed inset-0 overflow-hidden z-[1]"
      >
        <div
          ref={worldRef}
          className="relative touch-pan-y touch-pan-x select-none"
          style={{ width: worldWidth + 'px', height: worldHeight + 'px' }}
        >
          {/* Pin-up board placed well below the TV; small thumbnails (zoom to view details) */}
          {pinups && pinups.length > 0 && (
            <div className="absolute" style={{ left: (worldWidth/2 - 180) + 'px', top: (worldHeight/2 + 520) + 'px', width: '360px' }}>
              <div className="p-2 bg-black/50 rounded border border-zinc-700 w-[160px] h-[120px] flex items-center justify-center">
                {(() => { const p = pinups[pinups.length - 1]; return p ? (
                  <img key={p.id} src={p.imageUrl} alt="pin" className="max-w-full max-h-full object-contain" />
                ) : null })()}
              </div>
            </div>
          )}
          {/* Admin dot as part of the map (pans/zooms with the world) */}
          {!(typeof window !== 'undefined' && window.__adminActive) && (
          <button
            onClick={() => {
              try {
                const pass = prompt('Enter admin passphrase:')
                if (!pass) return
                const target = 'dooly42'
                let ok = pass.length === target.length
                for (let i = 0; i < target.length; i++) {
                  const a = pass.charCodeAt(i) || 0
                  const b = target.charCodeAt(i)
                  ok = ok && (a === b)
                }
                if (ok) {
                  localStorage.setItem('dooly_admin', '1')
                  try { window.__socket?.emit?.('identify_admin', { isAdmin: true }) } catch {}
                  alert('Admin mode enabled')
                } else {
                  alert('Nope')
                }
              } catch {}
            }}
            className="absolute z-40"
            aria-label="Admin"
            title="Admin"
            style={{ left: '20px', top: '20px', width: '16px', height: '16px', background: '#ff2d2d', borderRadius: '50%', boxShadow: '0 0 8px rgba(255,45,45,0.8)' }}
          />)}
            {/* Umbilical cords from TV to users currently on TV (rendered before TV to sit behind) */}
            <svg className="absolute inset-0 pointer-events-none" width={worldWidth} height={worldHeight} viewBox={`0 0 ${worldWidth} ${worldHeight}`}
              style={{ left: 0, top: 0 }}>
              {tvIds.map((uid) => {
                const p = makeClusterPlacer()
                const u = users.find(x => x.id === uid)
                if (!u || uid === selfId) return null
                const pos = p(u.id)
                const tvX = worldWidth/2
                const tvY = worldHeight/2
                const d = buildWavePath(tvX, tvY, pos.x, pos.y)
                return (
                  <path key={`cord-${uid}`} d={d} fill="none" stroke={tvHover ? "url(#cordStatic)" : "#000"} strokeWidth="8" strokeLinecap="round" opacity={tvHover ? 1 : 0.9} vectorEffect="non-scaling-stroke" shapeRendering="geometricPrecision" />
                )
              })}
              <defs>
                <filter id="noiseFilter">
                  <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" stitchTiles="stitch" />
                </filter>
                <pattern id="cordStatic" patternUnits="userSpaceOnUse" width="20" height="20">
                  <rect width="20" height="20" filter="url(#noiseFilter)"/>
                </pattern>
              </defs>
            </svg>

            {/* Center-ish TV tile, stable position */}
            <button
              onClick={handleOpenTV}
              className="absolute -translate-x-1/2 -translate-y-1/2 group hover:scale-[1.02] transition"
              style={{ left: (worldWidth/2) + 'px', top: (worldHeight/2) + 'px', width: '400px', height: '400px' }}
              aria-label="Open TV"
              title="Open TV"
              onMouseEnter={startTVStatic}
              onMouseLeave={stopTVStatic}
            >
              <div className="relative w-full h-full">
                <div className="absolute inset-0 rounded-full bg-black overflow-hidden shadow">
                  <canvas ref={tvCanvasRef} className="w-full h-full block" />
                </div>
              </div>
            </button>
            {(() => {
              const place = makeClusterPlacer()
              return (
                <>
                  {/* (Removed flat cords; using SVG wave above) */}
                  {pairs.map(({ a, b }) => {
                    const key = [a, b].sort().join('|')
                    const { color, lightness } = hashToGray(key)
                    const pos = place(key)
                    const t = timesMemo.pairTotal.get(key) || 0
                    const h = hoursFromMs(t)
                    const f = clamp01(h / HOURS_TO_MAX)
                    const sizePair = Math.round(lerp(80, MAX_DIAMETER, f))
                    const textColor = grayTextFor(lightness)
                    const rot = pairRot[key]
                    const tint = rot === 'blue' ? '#2da3ff' : rot === 'red' ? '#ff2d2d' : null
                    return (
                      <div
                        key={key}
                        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full pair-glow"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: sizePair + 'px', height: sizePair + 'px', backgroundColor: tint || color, '--glowColor': tint || color }}
                        title={`In chat`}
                        onMouseEnter={onHoverStart}
                        onMouseLeave={onHoverEnd}
                      >
                        <img src="/circle.gif" alt="" className="absolute inset-0 w-full h-full object-cover rounded-full pointer-events-none" style={{ opacity: 0.25 }} />
                        <div className="w-full h-full grid place-items-center text-xs font-mono" style={{ color: textColor }}>{msToHMS(t)}</div>
                      </div>
                    )
                  })}
                  {others.filter(u => !pairedUserIds.has(u.id)).map((u) => {
                    const { color, lightness } = hashToGray(u.id)
                    const pos = place(u.id)
                    const t = timesMemo.single.get(u.id) || 0
                    const h = hoursFromMs(t)
                    const f = clamp01(h / HOURS_TO_MAX)
                    const textColor = grayTextFor(lightness)
                    const inTV = tvIds.includes(u.id)
                    const isAdmin = isAdminId(u.id)
                    const base = isAdmin ? ADMIN_BASE_DIAMETER : BASE_DIAMETER
                    const size = Math.round(lerp(base, MAX_DIAMETER, f))
                    // Tendrils start at 2h for normal users; admins start immediately
                    const tendrilProgress = isAdmin ? f : clamp01((h - 2) / Math.max(1, (HOURS_TO_MAX - 2)))
                    const maxCount = 20
                    const baseCount = isAdmin ? 6 : 0
                    const tendrilCount = Math.max(0, Math.round(baseCount + tendrilProgress * (maxCount - baseCount)))
                    const lengthScale = 1 + 0.5 * tendrilProgress
                    return (
                      <button
                        key={u.id}
                        onClick={() => onRequestChat(u.id)}
                        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow hover:scale-105 transition"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: size + 'px', height: size + 'px', backgroundColor: isAdmin ? '#ff2d2d' : color, boxShadow: isAdmin ? '0 0 18px rgba(255,45,45,0.8)' : `0 0 12px ${color}`, overflow: 'visible' }}
                        title={inTV ? 'TV connected' : 'Start chat'}
                        aria-label={inTV ? 'TV connected' : 'Start chat'}
                        onMouseEnter={inTV ? handleInTvEnter : onHoverStart}
                        onMouseLeave={inTV ? handleInTvLeave : onHoverEnd}
                      >
                        {tendrilCount > 0 && (
                          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" style={{ overflow: 'visible', zIndex: 0 }}>
                            <defs>
                              <radialGradient id="tendrilsGrad" cx="50%" cy="50%" r="50%">
                                <stop offset="0%" stopColor={isAdmin ? 'rgba(255,45,45,0.95)' : 'rgba(255,255,255,0.5)'} />
                                <stop offset="100%" stopColor={isAdmin ? 'rgba(255,45,45,0.15)' : 'rgba(255,255,255,0.05)'} />
                              </radialGradient>
                            </defs>
                            {(() => {
                              const t = animT;
                              const N = tendrilCount; // equal directions
                              const r1 = 28 * lengthScale, r2 = 60 * lengthScale, r3 = 95 * lengthScale;
                              const paths = [];
                              for (let i = 0; i < N; i++) {
                                const ang = (i / N) * Math.PI * 2;
                                const pang = ang + Math.PI / 2; // perpendicular for wiggle
                                const w1 = Math.sin(t + i * 0.9) * 4;
                                const w2 = Math.sin(t * 0.8 + i * 1.1) * 6;
                                const w3 = Math.sin(t * 0.6 + i * 1.3) * 8;
                                const x1 = 50 + Math.cos(ang) * r1 + Math.cos(pang) * w1;
                                const y1 = 50 + Math.sin(ang) * r1 + Math.sin(pang) * w1;
                                const x2 = 50 + Math.cos(ang) * r2 + Math.cos(pang) * w2;
                                const y2 = 50 + Math.sin(ang) * r2 + Math.sin(pang) * w2;
                                const x3 = 50 + Math.cos(ang) * r3 + Math.cos(pang) * w3;
                                const y3 = 50 + Math.sin(ang) * r3 + Math.sin(pang) * w3;
                                paths.push(
                                  <path key={i} d={`M50,50 C ${x1},${y1} ${x2},${y2} ${x3},${y3}`} stroke="url(#tendrilsGrad)" strokeWidth="2" fill="none" />
                                );
                              }
                              return paths;
                            })()}
                          </svg>
                        )}
                        <img src="/circle.gif" alt="" className="absolute inset-0 w-full h-full object-cover rounded-full pointer-events-none" style={{ opacity: isAdmin ? 0.35 : 0.25, zIndex: 1 }} />
                        <div className="w-full h-full grid place-items-center text-[10px] font-mono" style={{ color: isAdmin ? '#fff' : textColor }}>{msToHMS(t)}</div>
                      </button>
                    )
                  })}
                  {/* Self circle when not in a pair (guard until selfId is known) */}
                  {selfId && !pairedUserIds.has(selfId) && (() => {
                    const place = makeClusterPlacer()
                    const pos = place(selfId)
                    const h = hoursFromMs(effectiveMsForSocket(selfId))
                    const f = clamp01(h / HOURS_TO_MAX)
                    const isAdmin = isAdminId(selfId)
                    const base = isAdmin ? ADMIN_BASE_DIAMETER : BASE_DIAMETER
                    const size = Math.round(lerp(base, MAX_DIAMETER, f))
                    const tendrilProgress = isAdmin ? f : clamp01((h - 2) / Math.max(1, (HOURS_TO_MAX - 2)))
                    const maxCount = 20
                    const baseCount = isAdmin ? 6 : 0
                    const tendrilCount = Math.max(0, Math.round(baseCount + tendrilProgress * (maxCount - baseCount)))
                    const lengthScale = 1 + 0.5 * tendrilProgress
                    const color = isAdmin ? '#ff2d2d' : hashToGray(selfId).color
                    const textColor = '#fff'
                    const t = effectiveMsForSocket(selfId)
                    return (
                      <div
                        key={'self'}
                        className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: size + 'px', height: size + 'px', backgroundColor: color, boxShadow: isAdmin ? '0 0 18px rgba(255,45,45,0.8)' : `0 0 12px ${color}`, overflow: 'visible' }}
                        title={'You'}
                      >
                        {tendrilCount > 0 && (
                          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" style={{ overflow: 'visible', zIndex: 0 }}>
                            <defs>
                              <radialGradient id="tendrilsGradSelf" cx="50%" cy="50%" r="50%">
                                <stop offset="0%" stopColor={isAdmin ? 'rgba(255,45,45,0.95)' : 'rgba(255,255,255,0.5)'} />
                                <stop offset="100%" stopColor={isAdmin ? 'rgba(255,45,45,0.15)' : 'rgba(255,255,255,0.05)'} />
                              </radialGradient>
                            </defs>
                            {(() => {
                              const tnow = animT
                              const N = tendrilCount
                              const r1 = 28 * lengthScale, r2 = 60 * lengthScale, r3 = 95 * lengthScale
                              const paths = []
                              for (let i = 0; i < N; i++) {
                                const ang = (i / N) * Math.PI * 2
                                const pang = ang + Math.PI / 2
                                const w1 = Math.sin(tnow + i * 0.9) * 4
                                const w2 = Math.sin(tnow * 0.8 + i * 1.1) * 6
                                const w3 = Math.sin(tnow * 0.6 + i * 1.3) * 8
                                const x1 = 50 + Math.cos(ang) * r1 + Math.cos(pang) * w1
                                const y1 = 50 + Math.sin(ang) * r1 + Math.sin(pang) * w1
                                const x2 = 50 + Math.cos(ang) * r2 + Math.cos(pang) * w2
                                const y2 = 50 + Math.sin(ang) * r2 + Math.sin(pang) * w2
                                const x3 = 50 + Math.cos(ang) * r3 + Math.cos(pang) * w3
                                const y3 = 50 + Math.sin(ang) * r3 + Math.sin(pang) * w3
                                paths.push(<path key={i} d={`M50,50 C ${x1},${y1} ${x2},${y2} ${x3},${y3}`} stroke="url(#tendrilsGradSelf)" strokeWidth="2" fill="none" />)
                              }
                              return paths
                            })()}
                          </svg>
                        )}
                        <img src="/circle.gif" alt="" className="absolute inset-0 w-full h-full object-cover rounded-full pointer-events-none" style={{ opacity: isAdmin ? 0.35 : 0.25, zIndex: 1 }} />
                        <div className="w-full h-full grid place-items-center text-[10px] font-mono" style={{ color: textColor }}>{msToHMS(t)}</div>
                      </div>
                    )
                  })()}
                </>
              )
            })()}
            {/* Removed empty-state text */}
        </div>
      </div>
    </div>
  )
}


