import React, { useRef, useState, useEffect } from 'react'
import { colorForKey } from './color'

export default function Chat({ selfId, partnerId, messages, partnerDraft, onSendMessage, onTyping, onExit, memories = [] }) {
  const [text, setText] = useState('')
  const bottomRef = useRef(null)
  const stageRef = useRef(null)
  const firstMsgRef = useRef(null)
  const [memory, setMemory] = useState([])   // array of drifting messages
  const [fly, setFly] = useState(null) // removed feature retained no-op
  const partnerColor = colorForKey(partnerId || '')

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
        setMemory(arr => [...arr, { ...pick, id, duration, y, color: pick.from === selfId ? '#ffffff' : partnerColor }])
        scheduleOne()
      }, delay)
      timeouts.push(t)
    }
    // Launch a single scheduler for slower frequency
    scheduleOne()
    return () => { timeouts.forEach(clearTimeout) }
  }, [memories, partnerColor, selfId])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onExit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit])

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onSendMessage(trimmed)
    setText('')
    onTyping?.('')
  }

  function handleChange(e) {
    const v = e.target.value
    setText(v)
    onTyping?.(v)
  }

  return (
    <div className="w-full h-full flex flex-col bg-black">
      <div className="absolute top-3 left-4 text-xs text-zinc-400">Esc to lobby</div>
      <div className="flex-1 grid place-items-center">
        <div className="w-full max-w-3xl px-6 text-center">
          <div ref={stageRef} className="relative min-h-[60vh] flex flex-col items-center justify-center gap-4">
            {messages.map((m, idx) => (
              <div ref={idx === 0 ? firstMsgRef : null} data-ts={m.timestamp} key={idx} className="leading-tight" style={{ fontSize: fontSizeFor(m.text) + 'px', color: m.from === selfId ? '#ffffff' : partnerColor }} title={new Date(m.timestamp).toLocaleTimeString()}>
                {m.text}
              </div>
            ))}
            {/* removed fly/evicted overlays */}
            <form onSubmit={handleSubmit} className="w-full flex justify-center">
              <div className="relative w-full">
                <input
                  className="w-full bg-transparent text-white outline-none text-center"
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
              <div className="mt-2 italic" style={{ fontSize: fontSizeFor(partnerDraft) + 'px', color: partnerColor }}>
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
                  <div className="whitespace-nowrap" style={{ color: m.color, opacity: 0.4, fontSize: fontSizeFor(m.text) + 'px' }}>
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
                  <div className="whitespace-nowrap" style={{ color: memory.color, opacity: 0.4, fontSize: fontSizeFor(memory.text) + 'px' }}>
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


