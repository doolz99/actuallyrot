import React, { useEffect, useMemo, useRef, useState } from 'react'
import TVFloatChat from './TVFloatChat.jsx'

export default function TV({ socket, onExit, onEnterTV, onLeaveTV, onSetDnd }) {
  const [dnd, setDnd] = useState(false)
  const [apiReady, setApiReady] = useState(false)
  const [room, setRoom] = useState(null) // { videoId, baseIndex, baseTs, playbackRate, isPlaying }
  const playerRef = useRef(null)
  const [isMuted, setIsMuted] = useState(true)
  const PLAYLIST_ID = 'PLqI4z8Cwl_TD1siZWi93dzjs1p_r2MPP9'
  const [videoSize, setVideoSize] = useState({ width: 1280, height: 720, left: 0, top: 0 })

  // Load YouTube IFrame API once
  useEffect(() => {
    if (window.YT && window.YT.Player) { setApiReady(true); return }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    document.head.appendChild(s)
    const onReady = () => setApiReady(true)
    window.onYouTubeIframeAPIReady = onReady
    return () => { try { if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = null } catch {} }
  }, [])

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

  // Initialize player once API ready
  useEffect(() => {
    if (!apiReady || playerRef.current) return
    playerRef.current = new window.YT.Player('tv-player', {
      width: '1280', height: '720',
      playerVars: { controls: 0, fs: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3, playsinline: 1, autoplay: 1 },
      events: { onReady, onStateChange, onError }
    })
  }, [apiReady])

  function onReady() {
    try {
      const p = playerRef.current
      p.mute(); setIsMuted(true)
      // Bootstrap: if server has no playlist order yet, we provide it by cueing playlist shuffled
      if (!room || !room.videoId) {
        // Seed playlist order: shuffle + load playlist
        try { p.setShuffle(true) } catch {}
        try { p.cuePlaylist({ list: PLAYLIST_ID }) } catch {}
        setTimeout(() => { try { p.playVideo() } catch {} }, 100)
        setTimeout(() => {
          try {
            const order = p.getPlaylist?.() || []
            if (Array.isArray(order) && order.length) socket?.emit('tv_playlist', { order })
          } catch {}
        }, 1500)
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
      <button
        className="absolute top-3 left-3 z-50 text-xs text-zinc-400 hover:text-white"
        onClick={onExit}
      >Back</button>
      <button
        className="absolute bottom-3 left-3 z-20 px-3 py-1 rounded bg-white/10 backdrop-blur text-white text-xs hover:bg-white/20"
        onClick={() => setDnd(v => !v)}
      >{dnd ? 'DND: ON (no chats)' : 'DND: OFF (allow chats)'}</button>
      <div className="w-full h-full relative">
        {/* Video area centered with letterboxing */}
        <div className="absolute bg-black" style={{ width: videoSize.width + 'px', height: videoSize.height + 'px', left: videoSize.left + 'px', top: videoSize.top + 'px' }}>
          <div id="tv-player" className="bg-black" style={{ width: '100%', height: '100%' }} />
          {/* Click blocker to keep visual-only */}
          <div className="absolute inset-0 z-20" style={{ pointerEvents: 'auto' }} />
          {/* Enable sound button */}
          {isMuted && (
            <button
              className="absolute bottom-3 right-3 z-30 px-3 py-1 rounded bg-white/10 backdrop-blur text-white text-xs hover:bg-white/20"
              onClick={() => {
                try {
                  const p = playerRef.current
                  if (!p) return
                  p.unMute?.()
                  p.setVolume?.(100)
                  // some browsers require a play() call after unmuting
                  try { p.playVideo?.() } catch {}
                  setIsMuted(false)
                } catch {}
              }}
            >Enable sound</button>
          )}
          {/* Transient float chat overlay matching video area */}
          <div className="absolute inset-0 z-30" style={{ pointerEvents: 'none' }}>
            <TVFloatChat socket={socket} width={videoSize.width} height={videoSize.height} />
          </div>
        </div>
      </div>
    </div>
  )
}


