import React, { useEffect, useMemo, useRef, useState } from 'react'
import panzoom from 'panzoom'

export default function Circles({ selfId, users, pairs, timesBySocket = {}, onRequestChat }) {
  const viewportRef = useRef(null)
  const worldRef = useRef(null)
  const panzoomRef = useRef(null)
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

  function hashToColor(key) {
    const h = hashString(key) % 360
    const s = 75
    const l = 55
    return `hsl(${h} ${s}% ${l}%)`
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
    <div className="w-full h-full">
      <h1 className="fixed top-4 left-1/2 -translate-x-1/2 text-5xl font-bold text-center z-10 pointer-events-none">RoTView</h1>
      <div
        ref={viewportRef}
        className="fixed inset-0 overflow-hidden"
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
                    const color = hashToColor(key)
                    const pos = place(key)
                    const t = timesMemo.pairTotal.get(key) || 0
                    return (
                      <div
                        key={key}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-20 h-20 rounded-full pair-glow"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, backgroundColor: color, '--glowColor': color }}
                        title={`In chat`}
                      >
                        <div className="w-full h-full grid place-items-center text-xs text-black/80 font-mono">{msToHMS(t)}</div>
                      </div>
                    )
                  })}
                  {others.filter(u => !pairedUserIds.has(u.id)).map((u) => {
                    const color = hashToColor(u.id)
                    const pos = place(u.id)
                    const t = timesMemo.single.get(u.id) || 0
                    return (
                      <button
                        key={u.id}
                        onClick={() => onRequestChat(u.id)}
                        className="absolute -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full shadow hover:scale-105 transition"
                        style={{ left: `${pos.x}px`, top: `${pos.y}px`, backgroundColor: color, boxShadow: `0 0 12px ${color}` }}
                        title="Start chat"
                        aria-label="Start chat"
                      >
                        <div className="w-full h-full grid place-items-center text-[10px] text-black/80 font-mono">{msToHMS(t)}</div>
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


