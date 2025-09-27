import React, { useRef, useState, useEffect, useMemo } from 'react'
import StaticBackground from './StaticBackground.jsx'
import { hashString } from './color'

export default function Chat({ selfId, partnerId, timesBySocket = {}, onRotState, messages, partnerDraft, onSendMessage, onTyping, onExit, memories = [] }) {
  const [text, setText] = useState('')
  const bottomRef = useRef(null)
  const stageRef = useRef(null)
  const firstMsgRef = useRef(null)
  const [memory, setMemory] = useState([])   // array of drifting messages
  const [fly, setFly] = useState(null) // removed feature retained no-op
  function grayForKey(key) {
    const h = hashString(String(key)) >>> 0
    const lightness = 28 + (h % 55) // 28..82
    return { color: `hsl(0 0% ${lightness}%)`, lightness }
  }
  function grayTextFor(lightness, shift = 20) {
    const shifted = lightness < 50 ? lightness + shift : lightness - shift
    const clamp = Math.max(0, Math.min(100, shifted))
    return `hsl(0 0% ${clamp}%)`
  }
  const partnerGray = useMemo(() => grayForKey(partnerId || ''), [partnerId])
  const partnerTextColor = useMemo(() => grayTextFor(partnerGray.lightness), [partnerGray.lightness])

  // Ambient audio that ramps in when both are present, tab visible, and idle for 3s
  const ambientRef = useRef(null)
  const ambientTimerRef = useRef(null)
  const idleTimerRef = useRef(null)
  const [lastActivityTs, setLastActivityTs] = useState(Date.now())
  const [ambientLevel, setAmbientLevel] = useState(0)
  // One-shot overlay sound after 20s of ramp
  const overlayRef = useRef(null)
  const overlayPlayedRef = useRef(false)
  const rampIdleMsRef = useRef(0)
  // Partner-away ambient (different track) after 5s of partner being inactive
  const awayRef = useRef(null)
  const awayLevelRef = useRef(0)
  const [awayLevel, setAwayLevel] = useState(0)
  // One-shot overlay for partner-away after 20s of away ramp
  const awayOverlayRef = useRef(null)
  const awayOverlayPlayedRef = useRef(false)
  const awayInactiveMsRef = useRef(0)

  function markActivity() {
    setLastActivityTs(Date.now())
  }

  function fontSizeFor(messageText) {
    const len = (messageText || '').length
    // Scale down as length increases; tuned for desktop and wraps
    // Returns px size between 22 and 88
    const max = 88
    const min = 22
    const size = max - Math.max(0, len - 12) * 2.2 // quicker falloff after 12 chars
    return Math.max(min, Math.min(max, size))
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, partnerDraft])

  // Removed last-message fade feature by no-op

  // Periodically show a drifting memory from either user
  useEffect(() => {
    if (!memories.length) return
    let timeouts = []
    function scheduleOne() {
      const delay = 12000 + Math.random() * 12000 // 12–24s
      const t = setTimeout(() => {
        const pick = memories[Math.floor(Math.random() * memories.length)]
        const duration = 11000 + Math.random() * 7000 // 11–18s
        const y = Math.floor(50 + Math.random() * 400)
        const id = `${pick.timestamp}-${Math.random().toString(36).slice(2)}`
        setMemory(arr => [...arr, { ...pick, id, duration, y, color: pick.from === selfId ? '#ffffff' : partnerTextColor }])
        scheduleOne()
      }, delay)
      timeouts.push(t)
    }
    // Launch a single scheduler for slower frequency
    scheduleOne()
    return () => { timeouts.forEach(clearTimeout) }
  }, [memories, partnerTextColor, selfId])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onExit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onExit])

  // Mark activity on new messages or partner typing changes
  useEffect(() => {
    setLastActivityTs(Date.now())
  }, [messages, partnerDraft])

  // Setup ambient audio element once (same track as circles)
  useEffect(() => {
    try {
      const a = new Audio('/ambient.mp3')
      a.loop = true
      a.preload = 'auto'
      a.volume = 0
      ambientRef.current = a
    } catch {}
    return () => {
      try { ambientRef.current?.pause?.() } catch {}
      ambientRef.current = null
    }
  }, [])

  // Setup overlay one-shot audio
  useEffect(() => {
    try {
      const o = new Audio('/overlay.mp3')
      o.loop = false
      o.preload = 'auto'
      o.volume = 1
      overlayRef.current = o
    } catch {}
    return () => {
      try { overlayRef.current?.pause?.() } catch {}
      overlayRef.current = null
    }
  }, [])

  // Setup away ambient audio (ramps while partner is away)
  useEffect(() => {
    try {
      const a = new Audio('/away.mp3')
      a.loop = true
      a.preload = 'auto'
      a.volume = 0
      awayRef.current = a
    } catch {}
    return () => {
      try { awayRef.current?.pause?.() } catch {}
      awayRef.current = null
    }
  }, [])

  // Setup away overlay one-shot audio
  useEffect(() => {
    try {
      const o = new Audio('/away_overlay.mp3')
      o.loop = false
      o.preload = 'auto'
      o.volume = 1
      awayOverlayRef.current = o
    } catch {}
    return () => {
      try { awayOverlayRef.current?.pause?.() } catch {}
      awayOverlayRef.current = null
    }
  }, [])

  // Ensure we can start audio after first interaction (mobile autoplay)
  useEffect(() => {
    const resume = () => {
      const a = ambientRef.current
      if (!a) return
      a.play().catch(() => {})
      window.removeEventListener('pointerdown', resume)
    }
    window.addEventListener('pointerdown', resume)
    return () => window.removeEventListener('pointerdown', resume)
  }, [])

  // Drive ramp based on presence and idle state; latch at max until activity
  useEffect(() => {
    const tickMs = 250
    const rampSecondsToFull = 60 // reach full volume after ~60s of qualifying idle

    function bothActiveVisible() {
      const me = timesBySocket?.[selfId]
      const partner = timesBySocket?.[partnerId]
      return !!(me && partner && me.isActive && partner.isActive && document.visibilityState === 'visible')
    }

    function partnerInactive() {
      const partner = timesBySocket?.[partnerId]
      return !(partner && partner.isActive)
    }

    function eligibleIdle() {
      return Date.now() - lastActivityTs >= 6000
    }

    function step() {
      const a = ambientRef.current
      if (!a) return
      if (bothActiveVisible() && eligibleIdle()) {
        // accumulate ramp idle ms
        rampIdleMsRef.current += tickMs
        // trigger overlay after 20s once
        if (rampIdleMsRef.current >= 20000 && !overlayPlayedRef.current) {
          const ov = overlayRef.current
          if (ov) {
            ov.currentTime = 0
            ov.play().catch(() => {})
          }
          overlayPlayedRef.current = true
        }
        if (ambientLevel >= 0.999) {
          // latch at full
          if (a.volume !== 1) a.volume = 1
          if (a.paused) a.play().catch(() => {})
          if (ambientLevel !== 1) setAmbientLevel(1)
        } else {
          const stepVol = (1 / rampSecondsToFull) * (tickMs / 1000)
          const next = Math.min(1, (a.volume || 0) + stepVol)
          a.volume = next
          setAmbientLevel(next)
          if (a.paused) a.play().catch(() => {})
        }
      } else {
        // abrupt stop and reset
        if (!a.paused) { try { a.pause() } catch {} }
        if (a.volume !== 0) a.volume = 0
        if (ambientLevel !== 0) setAmbientLevel(0)
        // reset overlay/ramp trackers
        rampIdleMsRef.current = 0
        overlayPlayedRef.current = false
        const ov = overlayRef.current
        if (ov) { try { ov.pause() } catch {}; try { ov.currentTime = 0 } catch {} }
      }

      // Partner-away ambient logic
      const away = awayRef.current
      if (away) {
        if (partnerInactive()) {
          awayInactiveMsRef.current += tickMs
          if (awayInactiveMsRef.current >= 5000) {
            // Ramp up away track, cut last 10s by resetting before tail
            const dur = isFinite(away.duration) && away.duration > 0 ? away.duration : 0
            const cutoff = dur > 10 ? dur - 10 : 0
            if (cutoff && away.currentTime >= cutoff) {
              try { away.currentTime = 0 } catch {}
            }
            const step = (1 / 20) * (tickMs / 1000) // reach full ~20s while away
            const next = Math.min(1, (away.volume || 0) + step)
            away.volume = next
            setAwayLevel(next)
            if (away.paused) away.play().catch(() => {})

            // trigger away overlay after 20s of away ramp once
            if (awayInactiveMsRef.current >= 25000 && !awayOverlayPlayedRef.current) {
              const ov = awayOverlayRef.current
              if (ov) {
                ov.currentTime = 0
                ov.play().catch(() => {})
              }
              awayOverlayPlayedRef.current = true
            }
          }
        } else {
          awayInactiveMsRef.current = 0
          if (!away.paused) { try { away.pause() } catch {} }
          away.volume = 0
          setAwayLevel(0)
          try { away.currentTime = 0 } catch {}
          // reset away overlay trigger
          awayOverlayPlayedRef.current = false
          const aov = awayOverlayRef.current
          if (aov) { try { aov.pause() } catch {}; try { aov.currentTime = 0 } catch {} }
        }
      }
    }

    if (ambientTimerRef.current) clearInterval(ambientTimerRef.current)
    ambientTimerRef.current = setInterval(step, tickMs)
    return () => {
      if (ambientTimerRef.current) {
        clearInterval(ambientTimerRef.current)
        ambientTimerRef.current = null
      }
    }
  }, [timesBySocket, selfId, partnerId, lastActivityTs, ambientLevel])

  // Emit rotting state to backend (500ms throttle via interval tick)
  useEffect(() => {
    if (!onRotState) return
    const tick = setInterval(() => {
      let type = 'none'
      if (awayLevel > 0) type = 'blue'
      else if (ambientLevel > 0) type = 'red'
      onRotState(type)
    }, 500)
    return () => clearInterval(tick)
  }, [onRotState, ambientLevel, awayLevel])

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onSendMessage(trimmed)
    setText('')
    onTyping?.('')
    markActivity()
  }

  function handleChange(e) {
    const v = e.target.value
    setText(v)
    onTyping?.(v)
    markActivity()
  }

  const staticOpacity = useMemo(() => {
    // Combine simultaneous-idle static with partner-away static (take max)
    const sim = 0.12 + ambientLevel * 0.8
    const away = 0.12 + awayLevel * 0.8
    return Math.max(sim, away)
  }, [ambientLevel, awayLevel])
  const rotOpacity = useMemo(() => Math.max(ambientLevel, awayLevel), [ambientLevel, awayLevel])

  return (
    <div className="w-full h-full flex flex-col bg-black relative">
      <StaticBackground opacity={staticOpacity} fps={20} />
      <div className="absolute top-3 left-4 text-xs text-zinc-400">Esc to lobby</div>
      <div className="flex-1 grid place-items-center">
        <div className="w-full max-w-3xl px-6 text-center">
          <div ref={stageRef} className="relative min-h-[60vh] flex flex-col items-center justify-center gap-4 font-impact">
            {/* ROT overlay: red for simultaneous idle, blue for partner-away. We mix by opacity; if away dominates, blue will show stronger. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center" style={{ opacity: rotOpacity }}>
              <div className="font-impact" style={{ fontSize: '22vw', lineHeight: 1 }}>
                <span className="absolute inset-0 text-red-600" style={{ textShadow: '0 0 18px rgba(255,0,0,0.75), 0 0 48px rgba(255,0,0,0.4)', opacity: ambientLevel }}>
                  ROT
                </span>
                <span className="relative text-blue-500" style={{ textShadow: '0 0 18px rgba(0,128,255,0.75), 0 0 48px rgba(0,128,255,0.4)', opacity: awayLevel }}>
                  ROT
                </span>
              </div>
            </div>
            {messages.map((m, idx) => (
              <div ref={idx === 0 ? firstMsgRef : null} data-ts={m.timestamp} key={idx} className="leading-tight" style={{ fontSize: fontSizeFor(m.text) + 'px', color: m.from === selfId ? '#ffffff' : partnerTextColor }} title={new Date(m.timestamp).toLocaleTimeString()}>
                {m.text}
              </div>
            ))}
            {/* removed fly/evicted overlays */}
            <form onSubmit={handleSubmit} className="w-full flex justify-center">
              <div className="relative w-full font-impact">
                <input
                  className="w-full bg-transparent text-white outline-none text-center font-impact"
                  style={{ fontSize: fontSizeFor(text) + 'px', caretColor: 'transparent' }}
                  autoFocus
                  aria-label="Chat input"
                  value={text}
                  onChange={handleChange}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      handleSubmit(e)
                    }
                  }}
                />
                {!text && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    {(() => {
                      const fs = fontSizeFor(text)
                      const cw = Math.max(2, Math.round(fs * 0.06))
                      return (
                        <span className="blink-caret" style={{ display:'inline-block', width: cw + 'px', height: fs + 'px', background:'#ffffff', borderRadius:'2px' }} />
                      )
                    })()}
                  </div>
                )}
              </div>
            </form>
            {!!partnerDraft && (
              <div className="mt-2 italic font-impact" style={{ fontSize: fontSizeFor(partnerDraft) + 'px', color: partnerTextColor }}>
                {partnerDraft}
              </div>
            )}
            <div ref={bottomRef} />
            {/* Drifting memory overlay */}
            {Array.isArray(memory) ? memory.map((m) => (
              <div
                key={m.id}
                className="pointer-events-none absolute left-0 top-0 w-full"
                style={{ animation: `memory-drift ${m.duration}ms linear forwards` }}
              >
                <div className="absolute" style={{ top: m.y + 'px', left: '100%' }}>
                  <div className="whitespace-nowrap font-impact" style={{ color: m.color, opacity: 0.4, fontSize: fontSizeFor(m.text) + 'px' }}>
                    {m.text}
                  </div>
                </div>
              </div>
            )) : (memory && (
              <div
                key={memory.timestamp}
                className="pointer-events-none absolute left-0 top-0 w-full"
                style={{ animation: `memory-drift ${memory.duration}ms linear forwards` }}
              >
                <div className="absolute" style={{ top: memory.y + 'px', left: '100%' }}>
                  <div className="whitespace-nowrap font-impact" style={{ color: memory.color, opacity: 0.4, fontSize: fontSizeFor(memory.text) + 'px' }}>
                    {memory.text}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}


