import React, { useEffect, useMemo, useRef, useState } from 'react'
import { playTvSendSound } from './audio'

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function hashString(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export default function TVFloatChat({ socket, width = 1280, height = 260 }) {
  const [messages, setMessages] = useState([]) // {id, text, ts}
  const [draft, setDraft] = useState('')
  const [seed, setSeed] = useState(() => Math.floor(Math.random()*1e9) >>> 0)
  const [previews, setPreviews] = useState(new Map()) // id -> { seed, text, ts }
  const containerRef = useRef(null)
  const [layout, setLayout] = useState([])
  const rafRef = useRef(0)

  // Wire socket
  useEffect(() => {
    if (!socket) return
    const onMsg = (m) => {
      // TTL scales with message length
      const chars = (m.text || '').length
      const ttl = Math.max(4, Math.min(12, 2 + 0.12 * chars))
      const death = Date.now() + ttl * 1000
      setMessages(prev => {
        const next = [...prev, { ...m, death }]
        // cap
        return next.slice(-40)
      })
    }
    const onPreview = (p) => {
      setPreviews(prev => {
        const next = new Map(prev)
        next.set(p.id, { seed: p.seed >>> 0, text: p.text || '', ts: Date.now() })
        return next
      })
    }
    socket.on('tv_message', onMsg)
    socket.on('tv_typing_preview', onPreview)
    socket.emit('join_room', { roomId: 'tv' })
    return () => { socket.off('tv_message', onMsg); socket.off('tv_typing_preview', onPreview) }
  }, [socket])

  // Cull expired
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      setMessages(prev => prev.filter(m => m.death > now))
      setPreviews(prev => {
        const next = new Map()
        for (const [k, v] of prev.entries()) {
          if (now - v.ts < 3000) next.set(k, v)
        }
        return next
      })
    }, 500)
    return () => clearInterval(t)
  }, [])

  // Deterministic layout: seed from message id+ts+text (computed per-frame)
  function computeLayout(messagesArg, previewsArg) {
    const boxes = [] // {x,y,w,h, id}
    const placed = []
    const pad = 6
    const areaW = width
    const areaH = height

    function measure(text) {
      // Rough measurement based on characters; we scale font inversely to length
      const chars = text.length
      const fontPx = Math.max(16, Math.min(32, 36 - 0.3 * chars))
      // Approx width: 0.58em per char
      const w = Math.min(areaW * 0.7, Math.max(140, chars * fontPx * 0.58))
      const lines = Math.min(2, Math.ceil(w / (areaW * 0.7)))
      const h = Math.ceil(fontPx * 1.2 * lines)
      return { w, h, fontPx }
    }

    function collides(nx, ny, nw, nh) {
      for (const b of placed) {
        if (nx < b.x + b.w && nx + nw > b.x && ny < b.y + b.h && ny + nh > b.y) return true
      }
      return false
    }

    const sorted = [...messagesArg].sort((a, b) => a.ts - b.ts)
    for (const m of sorted) {
      const s = (m.seed >>> 0) || hashString(String(m.id || '') + '|' + String(m.ts || 0) + '|' + (m.text || ''))
      const rnd = mulberry32(s)
      const { w, h, fontPx } = measure(m.text || '')
      let candidate = { x: 0, y: 0 }
      let found = false
      for (let i = 0; i < 24; i++) {
        const x = Math.floor(rnd() * (areaW - w - pad * 2)) + pad
        const y = Math.floor(rnd() * (areaH - h - pad * 2)) + pad
        if (!collides(x, y, w, h)) { candidate = { x, y }; found = true; break }
      }
      if (!found) {
        // simple repulsion: try nudging around a few times
        let x = Math.floor(rnd() * (areaW - w - pad * 2)) + pad
        let y = Math.floor(rnd() * (areaH - h - pad * 2)) + pad
        for (let k = 0; k < 10; k++) {
          for (const b of placed) {
            const dx = (x + w/2) - (b.x + b.w/2)
            const dy = (y + h/2) - (b.y + b.h/2)
            const overlapX = (w + b.w)/2 - Math.abs(dx)
            const overlapY = (h + b.h)/2 - Math.abs(dy)
            if (overlapX > 0 && overlapY > 0) {
              x += Math.sign(dx || (rnd()-0.5)) * overlapX
              y += Math.sign(dy || (rnd()-0.5)) * overlapY
              x = Math.max(pad, Math.min(areaW - w - pad, x))
              y = Math.max(pad, Math.min(areaH - h - pad, y))
            }
          }
        }
        candidate = { x, y }
      }
      placed.push({ x: candidate.x, y: candidate.y, w, h })
      boxes.push({ id: m.ts + ':' + m.id, x: candidate.x, y: candidate.y, w, h, fontPx, text: m.text })
    }
    // previews
    for (const [pid, pv] of previewsArg.entries()) {
      const rnd = mulberry32(pv.seed >>> 0)
      const { w, h, fontPx } = measure(pv.text || '')
      let candidate = { x: 0, y: 0 }
      let found = false
      for (let i = 0; i < 24; i++) {
        const x = Math.floor(rnd() * (areaW - w - pad * 2)) + pad
        const y = Math.floor(rnd() * (areaH - h - pad * 2)) + pad
        if (!collides(x, y, w, h)) { candidate = { x, y }; found = true; break }
      }
      if (!found) {
        let x = Math.floor(rnd() * (areaW - w - pad * 2)) + pad
        let y = Math.floor(rnd() * (areaH - h - pad * 2)) + pad
        for (let k = 0; k < 10; k++) {
          for (const b of placed) {
            const dx = (x + w/2) - (b.x + b.w/2)
            const dy = (y + h/2) - (b.y + b.h/2)
            const overlapX = (w + b.w)/2 - Math.abs(dx)
            const overlapY = (h + b.h)/2 - Math.abs(dy)
            if (overlapX > 0 && overlapY > 0) {
              x += Math.sign(dx || (rnd()-0.5)) * overlapX
              y += Math.sign(dy || (rnd()-0.5)) * overlapY
              x = Math.max(pad, Math.min(areaW - w - pad, x))
              y = Math.max(pad, Math.min(areaH - h - pad, y))
            }
          }
        }
        candidate = { x, y }
      }
      placed.push({ x: candidate.x, y: candidate.y, w, h })
      boxes.push({ id: 'p:' + pid, x: candidate.x, y: candidate.y, w, h, fontPx, text: pv.text, preview: true, mine: pid === (socket?.id || '') })
    }
    return boxes
  }

  // rAF-batched layout recompute
  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      setLayout(computeLayout(messages, previews))
      rafRef.current = 0
    })
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
  }, [messages, previews, width, height, socket])

  function send() {
    const t = draft.trim()
    if (!t) return
    socket?.emit('tv_message', { text: t, seed })
    setDraft('')
    setSeed((seed + 1) >>> 0)
    try { playTvSendSound() } catch {}
  }

  // hidden input capture
  const inputRef = useRef(null)
  useEffect(() => { inputRef.current?.focus?.() }, [])
  useEffect(() => {
    const onFocus = () => { try { inputRef.current?.focus?.() } catch {} }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [])
  // Global click-to-refocus (captures events even if overlays eat them)
  useEffect(() => {
    const refocus = () => { setTimeout(() => { try { inputRef.current?.focus?.() } catch {} }, 0) }
    window.addEventListener('pointerdown', refocus, true)
    return () => window.removeEventListener('pointerdown', refocus, true)
  }, [])
  // Immediate local echo of my preview; throttle network emits to ~10/s
  useEffect(() => {
    // Local optimistic update
    setPreviews(prev => {
      const next = new Map(prev)
      const myId = socket?.id || '__self__'
      next.set(myId, { seed: seed >>> 0, text: draft, ts: Date.now() })
      return next
    })
    // Network emit throttle at 100ms
    socket?.emit('tv_typing_preview', { seed, text: draft })
    const t = setInterval(() => { socket?.emit('tv_typing_preview', { seed, text: draft }) }, 100)
    return () => clearInterval(t)
  }, [draft, seed, socket])

  return (
    <div className="relative" style={{ width: width + 'px', height: height + 'px' }}>
      {/* Floaters layer - fully transparent background */}
      <div ref={containerRef} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
        {layout.map(b => (
          b.preview ? (
            <div key={b.id} className="absolute select-none" style={{ left: b.x + 'px', top: b.y + 'px', maxWidth: Math.floor(width*0.7) + 'px', fontFamily: 'Impact, sans-serif', fontSize: b.fontPx + 'px', lineHeight: 1.2, color: 'white', opacity: 0.8, textShadow: '0 0 8px rgba(255,80,80,0.45), 0 0 18px rgba(255,50,50,0.25)' }}>
              {b.text}
              {b.mine && (
                <span className="tv-caret" style={{ display: 'inline-block', width: '2px', height: '1em', background: 'white', marginLeft: '3px', verticalAlign: 'baseline' }} />
              )}
            </div>
          ) : (
            <div key={b.id} className="absolute select-none" style={{ left: b.x + 'px', top: b.y + 'px', maxWidth: Math.floor(width*0.7) + 'px', fontFamily: 'Impact, sans-serif', fontSize: b.fontPx + 'px', lineHeight: 1.2, color: 'white', textShadow: '0 0 10px rgba(255,80,80,0.6), 0 0 22px rgba(255,50,50,0.35)' }}>
              {b.text}
            </div>
          )
        ))}
      </div>
      {/* Hidden input; users type normally, caret not shown to others */}
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          if (e.key === 'Escape') { setDraft('') }
          if (e.key === 'Tab') { e.preventDefault(); setSeed((seed + 2654435761) >>> 0) }
        }}
        className="opacity-0 absolute pointer-events-none"
        style={{ width: '1px', height: '1px', left: 0, top: 0 }}
        aria-hidden="true"
      />
      {/* No clickable overlay; global pointerdown focuses input */}
    </div>
  )
}


