import React, { useEffect, useRef, useState } from 'react'

export default function Gate({ onDone, stillSrc = '/doors_still.png', gifSrc = '/doors.gif', gifMs = 3500, cullMs = 500, audioSrc = '/enter.mp3' }) {
  const [phase, setPhase] = useState('idle') // 'idle' | 'playing'
  const [logoVisible, setLogoVisible] = useState(false)
  const timerRef = useRef(null)
  const logoTimerRef = useRef(null)
  const audioRef = useRef(null)

  useEffect(() => {
    // Preload gif
    const img = new Image()
    img.src = gifSrc
    // Prep audio
    try {
      const a = new Audio()
      a.src = audioSrc
      a.preload = 'auto'
      a.crossOrigin = 'anonymous'
      audioRef.current = a
    } catch {}
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (logoTimerRef.current) {
        clearTimeout(logoTimerRef.current)
        logoTimerRef.current = null
      }
      try {
        audioRef.current?.pause?.()
      } catch {}
    }
  }, [gifSrc, audioSrc])

  function start() {
    if (phase !== 'idle') return
    setPhase('playing')
    const playMs = Math.max(0, gifMs - Math.max(0, cullMs))
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      onDone?.()
    }, playMs)

    // Show strobing logo and play audio for 3s
    setLogoVisible(true)
    logoTimerRef.current = setTimeout(() => {
      logoTimerRef.current = null
      setLogoVisible(false)
    }, 3000)

    try {
      const a = audioRef.current
      if (a) {
        const startAudio = () => {
          try {
            const d = a.duration
            if (isFinite(d) && d > 0) {
              a.playbackRate = Math.max(0.5, Math.min(16, d / 3))
            }
          } catch {}
          a.currentTime = 0
          a.volume = 1
          a.play().catch(() => {})
          setTimeout(() => {
            try { a.pause() } catch {}
          }, 3000)
        }
        if (a.readyState >= 1) startAudio()
        else a.addEventListener('loadedmetadata', startAudio, { once: true })
      }
    } catch {}
  }

  return (
    <div className="w-full h-full bg-black text-white">
      {/* Fullscreen layer */}
      <div className="fixed inset-0 overflow-hidden">
        {phase === 'idle' ? (
          <button
            onClick={start}
            className="relative outline-none block w-screen h-screen"
            aria-label="Click to enter"
          >
            <img src={stillSrc} alt="Enter" className="absolute inset-0 w-full h-full object-cover" />
          </button>
        ) : (
          <>
            <img src={gifSrc} alt="Entering" className="absolute inset-0 w-full h-full object-cover" />
            {logoVisible && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="font-impact text-white logo-strobe select-none" style={{ fontSize: '18vw', lineHeight: 1, textShadow: '0 0 16px rgba(255,255,255,0.8), 0 0 32px rgba(255,255,255,0.5)' }}>
                  RoTView
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}


