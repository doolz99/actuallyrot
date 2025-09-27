import React, { useEffect, useRef } from 'react'

export default function StaticBackground({ opacity = 0.08, fps = 24 }) {
  const canvasRef = useRef(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.floor(window.innerWidth / 2))
      const h = Math.max(1, Math.floor(window.innerHeight / 2))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = window.innerWidth + 'px'
      canvas.style.height = window.innerHeight + 'px'
      ctx.imageSmoothingEnabled = false
    }

    function drawNoise() {
      const { width, height } = canvas
      if (!width || !height) return
      const imgData = ctx.createImageData(width, height)
      const data = imgData.data
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
        data[i + 3] = 255
      }
      ctx.putImageData(imgData, 0, 0)
    }

    function start() {
      stop()
      resize()
      intervalRef.current = setInterval(() => {
        if (document.visibilityState !== 'visible') return
        drawNoise()
      }, Math.max(16, Math.floor(1000 / fps)))
    }

    function stop() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const onVis = () => {
      if (document.visibilityState === 'visible') start()
    }

    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVis)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', resize)
    }
  }, [fps])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      style={{ opacity }}
    />
  )
}


