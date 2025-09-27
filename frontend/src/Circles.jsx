import React, { useEffect, useMemo, useRef, useState } from 'react'
import panzoom from 'panzoom'
import StaticBackground from './StaticBackground.jsx'

export default function Circles({ selfId, users, pairs, timesBySocket = {}, pairRot = {}, onRequestChat }) {
  const viewportRef = useRef(null)
  const worldRef = useRef(null)
  const panzoomRef = useRef(null)
  const hoverAudioRef = useRef(null)
  const hoverCountRef = useRef(0)
  const ambientAudioRef = useRef(null)
  const ambientTimerRef = useRef(null)
  const worldWidth = 5000
  const worldHeight = 3500
  const others = users.filter(u => u.id !== selfId)
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
      const index = findCellIndex(h)
      const cx = index % cols
      const cy = Math.floor(index / cols)
      const jx = ((Math.floor(h / 997) % 1000) / 1000) * 0.6 + 0.2 // 0.2..0.8
      const jy = ((Math.floor(h / 787) % 1000) / 1000) * 0.6 + 0.2 // 0.2..0.8
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
    return () => instance.dispose()
  }, [])

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
    if (positions.length === 0) return
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
      <StaticBackground opacity={0.06} fps={20} />
      {/* Title removed per request */}
      <div
        ref={viewportRef}
        className="fixed inset-0 overflow-hidden z-[1]"
      >
        <div
          ref={worldRef}
          className="relative touch-pan-y touch-pan-x select-none"
          style={{ width: worldWidth + 'px', height: worldHeight + 'px' }}
        >
            {(() => {
              const place = makeClusterPlacer()
              return (
                <>
                  {pairs.map(({ a, b }) => {
                    const key = [a, b].sort().join('|')
                    const { color, lightness } = hashToGray(key)
                    const pos = place(key)
                    const t = timesMemo.pairTotal.get(key) || 0
                    const textColor = grayTextFor(lightness)
                    const rot = pairRot[key]
                    const tint = rot === 'blue' ? '#2da3ff' : rot === 'red' ? '#ff2d2d' : null
                    return (
                      <div
                        key={key}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-20 h-20 rounded-full pair-glow"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, backgroundColor: tint || color, '--glowColor': tint || color }}
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
                    const textColor = grayTextFor(lightness)
                    return (
                      <button
                        key={u.id}
                        onClick={() => onRequestChat(u.id)}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full shadow hover:scale-105 transition"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, backgroundColor: color, boxShadow: `0 0 12px ${color}` }}
                        title="Start chat"
                        aria-label="Start chat"
                        onMouseEnter={onHoverStart}
                        onMouseLeave={onHoverEnd}
                      >
                        <img src="/circle.gif" alt="" className="absolute inset-0 w-full h-full object-cover rounded-full pointer-events-none" style={{ opacity: 0.25 }} />
                        <div className="w-full h-full grid place-items-center text-[10px] font-mono" style={{ color: textColor }}>{msToHMS(t)}</div>
                      </button>
                    )
                  })}
                </>
              )
            })()}
            {others.filter(u => !pairedUserIds.has(u.id)).length === 0 && pairs.length === 0 && (
              <p className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-gray-400">No other users yet. Open another tab.</p>
            )}
        </div>
      </div>
    </div>
  )
}


