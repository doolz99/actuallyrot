import React, { useEffect, useMemo, useRef, useState } from 'react'
import TVFloatChat from './TVFloatChat.jsx'

export default function TV({ socket, adminIds = [], onExit, onEnterTV, onLeaveTV, onSetDnd }) {
  const [dnd, setDnd] = useState(false)
  const [apiReady, setApiReady] = useState(false)
  const [room, setRoom] = useState(null) // { videoId, baseIndex, baseTs, playbackRate, isPlaying }
  const playerRef = useRef(null)
  const webrtcVideoRef = useRef(null)
  // WebRTC endpoint from env or ?whep=
  const WHEP_URL = useMemo(() => {
    try {
      const env = import.meta.env.VITE_WHEP_URL
      if (env) return String(env)
      const sp = new URLSearchParams(window.location.search)
      const q = sp.get('whep') || sp.get('webrtc')
      return q ? String(q) : ''
    } catch { return '' }
  }, [])
  const isWebRtcMode = !!WHEP_URL
  const [useWebRtc, setUseWebRtc] = useState(!!WHEP_URL)
  const [isMuted, setIsMuted] = useState(true)
  const [volume, setVolume] = useState(() => {
    try { const v = Number(localStorage.getItem('tv_volume')); return isFinite(v) ? Math.max(0, Math.min(100, v)) : 100 } catch { return 100 }
  })
  const whepPcRef = useRef(null)
  const [whepActive, setWhepActive] = useState(false)
  const PLAYLIST_ID = 'PLqI4z8Cwl_TD1siZWi93dzjs1p_r2MPP9'
  const [videoSize, setVideoSize] = useState({ width: 1280, height: 720, left: 0, top: 0 })
  const [flash, setFlash] = useState(false)
  const flashTimerRef = useRef(0)
  const shutterRef = useRef(null)
  const capStreamRef = useRef(null)
  const capVideoRef = useRef(null)
  const capCanvasRef = useRef(null)
  const [captureReady, setCaptureReady] = useState(false)
  const [captureWarn, setCaptureWarn] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const bootStartRef = useRef(Date.now())
  const lastStateRef = useRef(Date.now())
  const [stalled, setStalled] = useState(false)
  const [adminUrl, setAdminUrl] = useState('')
  const [adminOpen, setAdminOpen] = useState(false)
  const helperRef = useRef(null)
  const [queueBusy, setQueueBusy] = useState(false)
  const [viewCounts, setViewCounts] = useState({ watching: 0, altTabbed: 0 })
  const [uiHidden, setUiHidden] = useState(false)
  const [liveDesired, setLiveDesired] = useState(!!import.meta.env.VITE_WHEP_URL)

  // Keep both layers mounted; we toggle visibility to avoid DOM race conditions

  // Load YouTube IFrame API once (skip while using WebRTC)
  useEffect(() => {
    if (useWebRtc) return
    if (window.YT && window.YT.Player) { setApiReady(true); return }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    document.head.appendChild(s)
    const onReady = () => setApiReady(true)
    window.onYouTubeIframeAPIReady = onReady
    return () => { try { if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = null } catch {} }
  }, [useWebRtc])

  // Load timesync client if missing
  useEffect(() => {
    if (window.timesync?.create) return
    const s = document.createElement('script')
    s.src = 'https://unpkg.com/timesync/dist/timesync.min.js'
    s.async = true
    document.head.appendChild(s)
    return () => {}
  }, [])

  // Compute 16:9 fit inside viewport (no cropping, letterboxing when needed)
  useEffect(() => {
    function recalc() {
      const vw = window.innerWidth || 1280
      const vh = window.innerHeight || 720
      const aspect = 16 / 9
      let width = vw
      let height = Math.floor(vw / aspect)
      if (height > vh) {
        height = vh
        width = Math.floor(vh * aspect)
      }
      const left = Math.floor((vw - width) / 2)
      const top = Math.floor((vh - height) / 2)
      setVideoSize({ width, height, left, top })
    }
    recalc()
    window.addEventListener('resize', recalc)
    return () => window.removeEventListener('resize', recalc)
  }, [])

  // WebRTC WHEP subscribe (viewer) when enabled
  useEffect(() => {
    if (!useWebRtc) return
    if (whepPcRef.current) { setWhepActive(true); return () => {} }
    let closed = false
    async function start() {
      try {
        const video = webrtcVideoRef.current
        if (!video) return
        const ice = []
        try {
          const turl = import.meta.env.VITE_TURN_URL
          const tuser = import.meta.env.VITE_TURN_USER
          const tpass = import.meta.env.VITE_TURN_PASS
          if (turl && tuser && tpass) ice.push({ urls: [turl], username: tuser, credential: tpass })
        } catch {}
        const pc = new RTCPeerConnection({ iceServers: ice })
        whepPcRef.current = pc
        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.addTransceiver('audio', { direction: 'recvonly' })
        pc.ontrack = (ev) => {
          if (closed) return
          try { video.srcObject = ev.streams[0] } catch {}
          try { video.play().catch(() => {}) } catch {}
          try { const vs = ev.streams?.[0]; const [track] = vs?.getVideoTracks?.() || []; if (track) track.onended = () => { setUseWebRtc(false) } } catch {}
        }
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState
          if (st === 'failed' || st === 'disconnected' || st === 'closed') {
            setUseWebRtc(false)
          }
        }
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const res = await fetch(WHEP_URL, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp })
        if (!res.ok) throw new Error('WHEP failed ' + res.status)
        const sdp = await res.text()
        await pc.setRemoteDescription({ type: 'answer', sdp })
        setWhepActive(true)
      } catch {
        setWhepActive(false)
        setUseWebRtc(false)
      }
    }
    start()
    return () => {
      closed = true
      try { whepPcRef.current?.close?.() } catch {}
      setWhepActive(false)
    }
  }, [useWebRtc, WHEP_URL])

  // Cleanup PC when disabling WebRTC
  useEffect(() => {
    if (!useWebRtc && whepPcRef.current) {
      try { whepPcRef.current.close() } catch {}
      whepPcRef.current = null
      setWhepActive(false)
    }
  }, [useWebRtc])

  // Auto-retry without flicker: probe WHEP in background and switch only after tracks arrive
  useEffect(() => {
    if (!isWebRtcMode) return
    if (useWebRtc) return
    let cancelled = false
    let timer = 0
    async function probeOnce() {
      if (cancelled) return
      if (whepPcRef.current) return
      try {
        const video = webrtcVideoRef.current
        if (!video) return
        const ice = []
        try {
          const turl = import.meta.env.VITE_TURN_URL
          const tuser = import.meta.env.VITE_TURN_USER
          const tpass = import.meta.env.VITE_TURN_PASS
          if (turl && tuser && tpass) ice.push({ urls: [turl], username: tuser, credential: tpass })
        } catch {}
        const pc = new RTCPeerConnection({ iceServers: ice })
        let gotTrack = false
        whepPcRef.current = pc
        pc.addTransceiver('video', { direction: 'recvonly' })
        pc.addTransceiver('audio', { direction: 'recvonly' })
        pc.ontrack = (ev) => {
          if (cancelled) return
          gotTrack = true
          try { video.srcObject = ev.streams[0] } catch {}
          try { video.play().catch(() => {}) } catch {}
          setWhepActive(true)
          setUseWebRtc(true)
        }
        pc.onconnectionstatechange = () => {
          const st = pc.connectionState
          if ((st === 'failed' || st === 'disconnected' || st === 'closed') && !gotTrack) {
            try { pc.close() } catch {}
            if (whepPcRef.current === pc) whepPcRef.current = null
          }
        }
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const res = await fetch(WHEP_URL, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp })
        if (!res.ok) throw new Error('probe failed ' + res.status)
        const sdp = await res.text()
        await pc.setRemoteDescription({ type: 'answer', sdp })
      } catch {
        // ignore; will retry
      }
    }
    function loop() {
      if (cancelled) return
      probeOnce()
      timer = window.setTimeout(loop, 8000)
    }
    loop()
    return () => { cancelled = true; try { clearTimeout(timer) } catch {} }
  }, [useWebRtc, isWebRtcMode, WHEP_URL])

  // Paparazzi flash on Right Alt and UI toggle Ctrl+H
  useEffect(() => {
    async function onKey(e) {
      if (e.ctrlKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault()
        setUiHidden(v => !v)
        return
      }
      if (e.code === 'AltRight') {
        e.preventDefault()
        try { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) } catch {}
        try {
          if (captureReady && capVideoRef.current) {
            setCapturing(true)
            let uiNodes = []
            let prevDisplayMap = null
            try {
              // Hard-hide UI synchronously to avoid being captured
              uiNodes = Array.from(document.querySelectorAll('.tv-ui'))
              prevDisplayMap = new Map(uiNodes.map(n => [n, n.style.display]))
              uiNodes.forEach(n => { try { n.style.display = 'none' } catch {} })
              // allow layout to apply hidden UI state before grabbing
              await new Promise(r => requestAnimationFrame(() => r()))
              // ensure a couple of frames render without UI
              await waitNextVideoFrame(capVideoRef.current, 2)
              let dataUrl = null
              for (let i = 0; i < 3 && !dataUrl; i++) {
                dataUrl = grabSnapshot()
                if (!dataUrl) { await new Promise(r => setTimeout(r, 150)); await waitNextVideoFrame(capVideoRef.current, 1) }
              }
              if (dataUrl) {
                const vid = room?.videoId || playerRef.current?.getVideoData?.()?.video_id
                socket?.emit('tv_pinup_add', { imageUrl: dataUrl, videoId: vid || '', ts: Date.now(), authorId: socket?.id })
                try { triggerDownload(dataUrl, `rotview_${Date.now()}.jpg`) } catch {}
              } else {
                setCaptureWarn(true)
                setTimeout(() => setCaptureWarn(false), 1200)
                // fallback to thumbnail
                const vid = room?.videoId || playerRef.current?.getVideoData?.()?.video_id
                if (vid) {
                  const imageUrl = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`
                  socket?.emit('tv_pinup_add', { imageUrl, videoId: vid, ts: Date.now(), authorId: socket?.id })
                }
              }
            } catch {}
            // trigger locally and broadcast to others after capture, so overlays don't get into the frame
            setFlash(true)
            try { socket?.emit('tv_flash') } catch {}
            try { const a = shutterRef.current; if (a) { a.currentTime = 0; a.play().catch(() => {}) } } catch {}
            flashTimerRef.current = setTimeout(() => setFlash(false), 120)
            // restore UI slightly after flash, then clear capturing
            setTimeout(() => {
              try { uiNodes.forEach(n => { try { n.style.display = (prevDisplayMap?.get(n)) || '' } catch {} }) } catch {}
              setCapturing(false)
            }, 220)
          } else {
            const vid = room?.videoId || playerRef.current?.getVideoData?.()?.video_id
            if (vid) {
              const imageUrl = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`
              socket?.emit('tv_pinup_add', { imageUrl, videoId: vid, ts: Date.now(), authorId: socket?.id })
            }
          }
        } catch {}
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      try { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) } catch {}
    }
  }, [captureReady, room?.videoId, socket])
  // Enable tab capture (user gesture required)
  async function enableCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'never' }, audio: false })
      capStreamRef.current = stream
      if (!capVideoRef.current) {
        const v = document.createElement('video')
        v.muted = true
        v.playsInline = true
        capVideoRef.current = v
      }
      const v = capVideoRef.current
      v.srcObject = stream
      await v.play().catch(() => {})
      await new Promise(resolve => {
        const check = () => {
          if (v.videoWidth && v.videoHeight) { resolve() } else { setTimeout(check, 100) }
        }
        check()
      })
      if (!capCanvasRef.current) capCanvasRef.current = document.createElement('canvas')
      setCaptureReady(true)
    } catch (err) {
      setCaptureReady(false)
    }
  }

  function waitNextVideoFrame(video, count = 1) {
    return new Promise(resolve => {
      if (!video) return resolve()
      let remaining = Math.max(1, count)
      const done = () => { remaining--; if (remaining <= 0) resolve(); else step() }
      const step = () => {
        try {
          if (video.requestVideoFrameCallback) {
            video.requestVideoFrameCallback(() => done())
          } else {
            setTimeout(done, 66)
          }
        } catch {
          setTimeout(done, 66)
        }
      }
      step()
    })
  }

  function parsePlaylistId(urlOrId) {
    try {
      if (!urlOrId) return ''
      const s = String(urlOrId)
      const m1 = s.match(/[?&]list=([a-zA-Z0-9_-]+)/)
      if (m1) return m1[1]
      if (/^[a-zA-Z0-9_-]+$/.test(s)) return s
      return ''
    } catch { return '' }
  }

  async function fetchPlaylistOrder(playlistId) {
    return new Promise(resolve => {
      try {
        const container = document.getElementById('tv-helper')
        if (!container || !window.YT || !window.YT.Player) return resolve([])
        const helperId = 'yt_helper_' + Math.random().toString(36).slice(2)
        const div = document.createElement('div')
        div.id = helperId
        container.appendChild(div)
        const helper = new window.YT.Player(helperId, {
          width: '0', height: '0',
          playerVars: { playsinline: 1 },
          events: {
            onReady: () => {
              try { helper.setShuffle(true) } catch {}
              try { helper.cuePlaylist({ list: playlistId }) } catch {}
              setTimeout(() => {
                try {
                  const ids = helper.getPlaylist?.() || []
                  resolve(Array.isArray(ids) ? ids : [])
                } catch { resolve([]) }
                try { helper.destroy?.() } catch {}
                try { container.removeChild(div) } catch {}
              }, 1500)
            }
          }
        })
      } catch { resolve([]) }
    })
  }

  function grabSnapshot() {
    try {
      const video = capVideoRef.current
      const canvas = capCanvasRef.current
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null
      // Compute crop from the exact tv-player bounding rect
      const host = document.getElementById('tv-player')
      if (!host) return null
      const rect = host.getBoundingClientRect()
      const vw = video.videoWidth, vh = video.videoHeight
      const scaleX = vw / (window.innerWidth || vw)
      const scaleY = vh / (window.innerHeight || vh)
      let sx = Math.floor(rect.left * scaleX)
      let sy = Math.floor(rect.top * scaleY)
      let sw = Math.floor(rect.width * scaleX)
      let sh = Math.floor(rect.height * scaleY)
      // Clamp to bounds
      sx = Math.max(0, Math.min(sx, vw - 1))
      sy = Math.max(0, Math.min(sy, vh - 1))
      sw = Math.max(1, Math.min(sw, vw - sx))
      sh = Math.max(1, Math.min(sh, vh - sy))
      const targetW = 480
      const targetH = Math.round(targetW * (sh / Math.max(1, sw)))
      canvas.width = targetW
      canvas.height = targetH
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#000'; ctx.fillRect(0,0,targetW,targetH)
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, targetW, targetH)
      return canvas.toDataURL('image/jpeg', 0.75)
    } catch {
      return null
    }
  }

  function triggerDownload(dataUrl, filename) {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { document.body.removeChild(a) }, 0)
  }


  // Receive server events
  useEffect(() => {
    if (!socket) return
    const onLive = ({ on }) => { try { const flag = !!on; setLiveDesired(flag); setUseWebRtc(flag); } catch {} }
    const onFlash = () => {
      try { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) } catch {}
      setFlash(true)
      try { const a = shutterRef.current; if (a) { a.currentTime = 0; a.play().catch(() => {}) } } catch {}
      flashTimerRef.current = setTimeout(() => setFlash(false), 120)
    }
    socket.on('tv_flash', onFlash)
    socket.on('tv_live', onLive)
    const lastNonZero = { current: { w: 0, a: 0 } }
    const onCounts = (c) => {
      try {
        const w = Number(c?.watching) || 0
        const a = Number(c?.altTabbed) || 0
        if (w === 0 && a === 0 && (lastNonZero.current.w + lastNonZero.current.a) > 0) {
          // ignore single zero tick
          return
        }
        if (w + a > 0) lastNonZero.current = { w, a }
        setViewCounts({ watching: w, altTabbed: a })
      } catch {}
    }
    socket.on('tv_view_counts', onCounts)
    // ensure we're in the tv room to receive
    try { socket.emit('join_room', { roomId: 'tv' }) } catch {}
    return () => { socket.off('tv_flash', onFlash); socket.off('tv_view_counts', onCounts); socket.off('tv_live', onLive); try { socket.emit('leave_room', { roomId: 'tv' }) } catch {} }
  }, [socket])

  // Re-join TV room and restate TV presence on reconnect to reduce flicker
  useEffect(() => {
    if (!socket) return
    const onConn = () => {
      try { socket.emit('join_room', { roomId: 'tv' }) } catch {}
      try { socket.emit('tv_state', { inTv: true }) } catch {}
      try { socket.emit('tv_request_state') } catch {}
    }
    socket.on('connect', onConn)
    return () => { socket.off('connect', onConn) }
  }, [socket])

  // preload camera shutter audio
  useEffect(() => {
    try {
      const a = new Audio('/camera.mp3')
      a.preload = 'auto'
      a.volume = 0.9
      shutterRef.current = a
    } catch {}
    return () => { try { shutterRef.current = null } catch {} }
  }, [])

  // timesync offset
  const [offsetMs, setOffsetMs] = useState(0)
  useEffect(() => {
    let ts = null
    try { ts = window.timesync?.create?.({ server: '/timesync', interval: 10000 }) } catch {}
    if (!ts) return
    const update = () => { try { setOffsetMs(ts.now() - Date.now()) } catch {} }
    ts.on('sync', update)
    update()
    return () => { try { ts.off('sync', update) } catch {} }
  }, [])

  const serverNow = useMemo(() => (clientBaseTs) => {
    const now = Date.now() + offsetMs
    if (!clientBaseTs) return 0
    const delta = Math.max(0, now - clientBaseTs)
    return delta / 1000
  }, [offsetMs])
  useEffect(() => {
    try { onEnterTV?.() } catch {}
    return () => { try { onLeaveTV?.() } catch {} }
  }, [onEnterTV, onLeaveTV])
  useEffect(() => {
    try { onSetDnd?.(dnd) } catch {}
  }, [dnd, onSetDnd])

  // Socket wiring for room timeline
  useEffect(() => {
    if (!socket) return
    const onRoom = (s) => setRoom(s)
    socket.emit('join_room', { roomId: 'tv' })
    socket.on('tv_room_state', onRoom)
    socket.emit('tv_request_state')
    const reqTimer = setInterval(() => { try { socket.emit('tv_request_state') } catch {} }, 15000)
    return () => {
      socket.off('tv_room_state', onRoom)
      socket.emit('leave_room', { roomId: 'tv' })
      clearInterval(reqTimer)
    }
  }, [socket])

  // Initialize/restore YouTube player once API ready (only when not in WebRTC)
  useEffect(() => {
    if (useWebRtc) return
    if (!apiReady || playerRef.current) return
    playerRef.current = new window.YT.Player('tv-player', {
      width: '1280', height: '720',
      playerVars: { controls: 0, fs: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1, autoplay: 1 },
      events: { onReady, onStateChange, onError }
    })
  }, [apiReady, useWebRtc])

  // If YouTube is active and enters an unexpected unstarted/blank state, force reload
  useEffect(() => {
    if (useWebRtc) return
    const p = playerRef.current
    if (!p) return
    const t = setInterval(() => {
      try {
        const st = p.getPlayerState?.()
        // -1: unstarted, 5: cued but not playing; kick it
        if (st === -1 || st === 5) {
          p.playVideo?.()
        }
      } catch {}
    }, 5000)
    return () => clearInterval(t)
  }, [useWebRtc])

  // Watchdog: if no state/playing within a few seconds after refresh, ask server and retry play
  useEffect(() => {
    const start = Date.now()
    const check = setInterval(() => {
      const p = playerRef.current
      const elapsed = Date.now() - start
      try {
        const st = p?.getPlayerState?.()
        if (st === window.YT?.PlayerState?.PLAYING || st === window.YT?.PlayerState?.BUFFERING) {
          setStalled(false)
          clearInterval(check)
          return
        }
      } catch {}
      if (elapsed > 5000) {
        setStalled(true)
        try {
          socket?.emit?.('tv_request_state')
          if (p) {
            // force a tiny re-init attempt
            p.playVideo?.()
          }
        } catch {}
      }
    }, 750)
    return () => clearInterval(check)
  }, [socket])

  function onReady() {
    try {
      const p = playerRef.current
      p.mute(); setIsMuted(true)
      // Bootstrap: if server has no playlist order yet, we provide it by cueing playlist shuffled
      if (!room || !room.videoId) {
        // Seed playlist order: shuffle + load playlist
        try { p.setShuffle(true) } catch {}
        try { p.cuePlaylist({ list: PLAYLIST_ID }) } catch {}
        setTimeout(() => { try { p.playVideo() } catch {} }, 200)
        setTimeout(() => {
          try {
            const order = p.getPlaylist?.() || []
            if (Array.isArray(order) && order.length) socket?.emit('tv_playlist', { order })
          } catch {}
        }, 2000)
      }
    } catch {}
  }

  function onStateChange(ev) {
    const p = playerRef.current
    if (!p) return
    try {
      if (ev.data === window.YT.PlayerState.PLAYING) {
        const vid = p.getVideoData()?.video_id
        const dur = Number(p.getDuration?.())
        if (vid && isFinite(dur) && dur > 0) socket?.emit('tv_duration', { videoId: vid, duration: dur })
        // Ask for fresh state to align
        socket?.emit('tv_request_state')
      } else if (ev.data === window.YT.PlayerState.ENDED) {
        const vid = p.getVideoData()?.video_id
        socket?.emit('tv_ended', { videoId: vid })
      }
    } catch {}
  }
  function onError() {
    try {
      const vid = playerRef.current?.getVideoData?.()?.video_id
      if (vid) socket?.emit('tv_ended', { videoId: vid })
    } catch {}
  }

  // Apply server state to player (followers)
  useEffect(() => {
    const p = playerRef.current
    const s = room
    if (!p || !s || !s.videoId) return
    try {
      const cur = p.getVideoData()?.video_id
      if (cur !== s.videoId) {
        p.loadVideoById(s.videoId)
      }
      const target = serverNow(s.baseTs)
      const now = p.getCurrentTime()
      if (Math.abs(target - now) > 0.25) p.seekTo(target, true)
      if (s.isPlaying) p.playVideo(); else p.pauseVideo()
      if (p.getPlaybackRate() !== s.playbackRate) p.setPlaybackRate(s.playbackRate)
    } catch {}
  }, [room, serverNow])

  // Continuous drift correction and state enforcement (tight loop)
  useEffect(() => {
    const p = playerRef.current
    if (!p || !room) return
    const tick = () => {
      try {
        const cur = p.getVideoData()?.video_id
        if (cur !== room.videoId) {
          p.loadVideoById(room.videoId)
          setTimeout(() => { try {
            const target = serverNow(room.baseTs)
            p.seekTo(target, true)
            if (room.isPlaying) p.playVideo(); else p.pauseVideo()
          } catch {} }, 50)
          return
        }
        const target = serverNow(room.baseTs)
        const now = p.getCurrentTime()
        if (Math.abs(target - now) > 0.15) p.seekTo(target, true)
        const want = room.isPlaying
        const st = p.getPlayerState?.()
        const isPlaying = st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.BUFFERING
        if (want && !isPlaying) p.playVideo()
        if (!want && isPlaying) p.pauseVideo()
        if (p.getPlaybackRate?.() !== room.playbackRate) p.setPlaybackRate(room.playbackRate)
      } catch {}
    }
    const t = setInterval(tick, 250)
    tick()
    return () => clearInterval(t)
  }, [room, serverNow])

  return (
    <div className="w-full h-full bg-black text-white relative">
      {/* Flash overlay on top of everything */}
      <div className={flash ? 'fixed inset-0 z-[9999] pointer-events-none bg-white opacity-100' : 'fixed inset-0 z-[9999] pointer-events-none bg-white opacity-0'} style={{ transition: 'opacity 120ms ease-out' }} />
      {!capturing && (
        <button
          className="tv-ui absolute top-3 left-3 z-50 text-xs text-zinc-400 hover:text-white"
          onClick={onExit}
        >Back</button>
      )}
      {/* Admin inline controls removed in favor of slide-out panel */}
      {/* Hidden helper container for playlist introspection */}
      <div id="tv-helper" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} />
      {!capturing && !uiHidden && adminIds.includes(socket?.id) && !captureReady && (
        <button
          className="tv-ui absolute top-3 right-3 z-50 text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20"
          onClick={enableCapture}
        >Enable capture</button>
      )}
      {!capturing && !uiHidden && captureReady && (
        <div className="tv-ui absolute top-3 right-3 z-50 text-[10px] px-2 py-1 rounded bg-green-600/30 border border-green-400/60">
          Capture ON
        </div>
      )}
      {captureWarn && (
        <div className="tv-ui absolute top-8 right-3 z-50 text-[10px] px-2 py-1 rounded bg-yellow-600/30 border border-yellow-400/60">
          No frames yet
        </div>
      )}
      {/* Admin panel toggle */}
      {!capturing && !uiHidden && adminIds.includes(socket?.id) && (
        <button
          className="tv-ui absolute top-3 right-24 z-50 text-xs px-3 py-1 rounded bg-white/10 hover:bg-white/20"
          onClick={() => setAdminOpen(v => !v)}
        >{adminOpen ? 'Close' : 'Admin'}</button>
      )}
      {/* Slide-out admin panel */}
      {adminIds.includes(socket?.id) && !uiHidden && (
        <div className={`tv-ui fixed top-0 right-0 h-full w-80 z-50 bg-black/80 border-l border-white/15 transition-transform duration-200 ${adminOpen ? 'translate-x-0' : 'translate-x-full'}`}
             onKeyDown={(e) => { if (e.key === 'Escape') setAdminOpen(false) }}>
          <div className="p-3 space-y-2 text-[11px] relative">
            <button
              className="absolute top-2 right-2 px-2 py-1 rounded bg-white/10 hover:bg-white/20"
              onClick={() => setAdminOpen(false)}
              aria-label="Close admin panel"
            >×</button>
            <div className="font-mono text-zinc-300">YouTube controls</div>
            <input autoFocus={adminOpen} value={adminUrl} onChange={e => setAdminUrl(e.target.value)} placeholder="YouTube URL or ID"
              className="w-full px-2 py-1 rounded bg-white/10 border border-white/20 outline-none" />
            <div className="flex gap-2">
              <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={() => {
                try {
                  const idMatch = String(adminUrl||'').match(/[a-zA-Z0-9_-]{11}/)
                  const vid = idMatch ? idMatch[0] : ''
                  if (vid) socket?.emit('tv_admin_set_video', { videoId: vid })
                } catch {}
              }}>Set video</button>
              <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={() => { try { socket?.emit('tv_admin_skip') } catch {} }}>Skip</button>
            </div>
            <div className="flex gap-2">
              <button disabled={queueBusy} className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 disabled:opacity-50" onClick={async () => {
                try {
                  const pl = parsePlaylistId(adminUrl)
                  if (!pl) return
                  setQueueBusy(true)
                  const ids = await fetchPlaylistOrder(pl)
                  if (ids && ids.length) socket?.emit('tv_admin_queue', { videoIds: ids })
                } catch {} finally { setQueueBusy(false) }
              }}>Queue playlist</button>
              <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={() => { try { socket?.emit('tv_admin_clear_queue') } catch {} }}>Clear queue</button>
            </div>
            <div className="flex items-center gap-2">
              <label className="opacity-70">Live</label>
              <button className={`px-2 py-1 rounded ${liveDesired ? 'bg-green-600/40' : 'bg-white/10'} hover:bg-white/20`} onClick={() => {
                const next = !liveDesired; setLiveDesired(next);
                try { socket?.emit('tv_admin_live', { on: next }) } catch {}
                if (next) setUseWebRtc(true); else setUseWebRtc(false)
              }}>{liveDesired ? 'On' : 'Off'}</button>
            </div>
            <div className="text-xs text-zinc-400">Esc closes panel</div>
          </div>
        </div>
      )}
      {!capturing && !uiHidden && (
        <button
          className="tv-ui absolute bottom-3 left-3 z-20 px-3 py-1 rounded bg-white/10 backdrop-blur text-white text-xs hover:bg-white/20"
          onClick={() => setDnd(v => !v)}
        >{dnd ? 'DND: ON (no chats)' : 'DND: OFF (allow chats)'}</button>
      )}
      {!capturing && !uiHidden && (
        <div className="tv-ui absolute bottom-3 left-40 z-20 text-[11px] px-2 py-1 rounded bg-white/10 border border-white/15 select-none">
          Ctrl+H to hide UI
        </div>
      )}
      {/* Viewer counts near time counter (bottom center, to the right) */}
      {!uiHidden && (
      <div className="tv-ui fixed z-20 text-[11px] px-2 py-1 rounded bg-white/10 border border-white/15 flex items-center gap-2"
           style={{ bottom: '12px', left: 'calc(50% + 90px)' }}>
        <span className="text-green-400 font-mono">{viewCounts.watching}</span>
        <span className="text-red-400 font-mono">{viewCounts.altTabbed}</span>
      </div>
      )}
      <div className="w-full h-full relative">
        {/* Video area centered with letterboxing */}
        <div className="absolute bg-black" style={{ width: videoSize.width + 'px', height: videoSize.height + 'px', left: videoSize.left + 'px', top: videoSize.top + 'px' }}>
          {/* We keep both elements mounted to avoid React removing/adding during rapid switches */}
          <div className="absolute inset-0" style={{ opacity: useWebRtc ? 1 : 0, pointerEvents: useWebRtc ? 'auto' : 'none' }}>
            <video ref={webrtcVideoRef} id="webrtc-player" className="bg-black" style={{ width: '100%', height: '100%' }} playsInline autoPlay muted />
          </div>
          <div className="absolute inset-0" style={{ opacity: useWebRtc ? 0 : 1, pointerEvents: useWebRtc ? 'none' : 'auto' }}>
            <div id="tv-player" className="bg-black" style={{ width: '100%', height: '100%' }} />
          </div>
          {/* Click blocker to keep visual-only */}
          {!capturing && (
            <div className="absolute inset-0 z-20" style={{ pointerEvents: 'auto' }} />
          )}
          {/* Enable sound button */}
          {!capturing && !uiHidden && isMuted && (
            <button
              className="tv-ui absolute bottom-3 right-3 z-30 px-3 py-1 rounded bg-white/10 backdrop-blur text-white text-xs hover:bg-white/20"
              onClick={() => {
                try {
                  if (useWebRtc) {
                    const v = webrtcVideoRef.current
                    if (!v) return
                    v.muted = false
                    v.volume = Math.max(0, Math.min(1, volume / 100))
                    try { v.play() } catch {}
                  } else {
                    const p = playerRef.current
                    if (!p) return
                    p.unMute?.()
                    p.setVolume?.(volume)
                    try { p.playVideo?.() } catch {}
                  }
                  setIsMuted(false)
                } catch {}
              }}
            >Enable sound</button>
          )}
          {!capturing && !uiHidden && !isMuted && (
            <div className="tv-ui absolute bottom-3 right-3 z-30 flex items-center gap-2 px-2 py-1 rounded bg-white/10 backdrop-blur text-white text-xs">
              <span>Vol</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={volume}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setVolume(v)
                  try { localStorage.setItem('tv_volume', String(v)) } catch {}
                  try {
                    if (useWebRtc) {
                      const el = webrtcVideoRef.current
                      if (el) el.volume = Math.max(0, Math.min(1, v / 100))
                    } else {
                      playerRef.current?.setVolume?.(v)
                    }
                  } catch {}
                }}
              />
            </div>
          )}
          {/* Transient float chat overlay matching video area */}
          {!capturing && (
            <div className="tv-ui absolute inset-0 z-30" style={{ pointerEvents: 'none' }}>
              <TVFloatChat socket={socket} adminIds={adminIds} width={videoSize.width} height={videoSize.height} disableRefocus={adminOpen} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


