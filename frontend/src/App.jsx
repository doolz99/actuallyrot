import React, { useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'
import Circles from './Circles.jsx'
import Chat from './Chat.jsx'
import Gate from './Gate.jsx'
import TV from './TV.jsx'
import Sequencer from './Sequencer.jsx'
import { playJoinSound, playPairSound, playSendSound, playReceiveSound, playConnectSound, playDisconnectSound } from './audio'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export default function App() {
  const socket = useMemo(() => io(BACKEND_URL, { autoConnect: true }), [])

  const [view, setView] = useState('lobby') // 'lobby' | 'chat' | 'tv' | 'sequencer'
  // One-time gate per session
  const [showGate, setShowGate] = useState(() => {
    try { return sessionStorage.getItem('rv_seen_gate') ? false : true } catch { return true }
  })
  const [users, setUsers] = useState([]) // array of { id }
  const [selfId, setSelfId] = useState(null)
  const [partnerId, setPartnerId] = useState(null)
  const [messages, setMessages] = useState([])
  const [pairs, setPairs] = useState([]) // array of { a, b }
  const [partnerDraft, setPartnerDraft] = useState('')
  const [memories, setMemories] = useState([]) // all past messages beyond the last visible
  const [timesSnapshot, setTimesSnapshot] = useState({ nowMs: 0, perSocket: {} })
  const [pairRot, setPairRot] = useState({}) // key "a|b" -> 'red'|'blue'|'none'
  const [tvIds, setTvIds] = useState([])
  const [adminIds, setAdminIds] = useState([])
  const [seqIds, setSeqIds] = useState([])
  const [pinups, setPinups] = useState([])
  const [hasData, setHasData] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [epoch, setEpoch] = useState(0)

  // Helpers to dedupe incoming state (defensive against backend races)
  const dedupeUsers = (list) => {
    try {
      const seen = new Set()
      const out = []
      for (const u of Array.isArray(list) ? list : []) {
        if (!u || !u.id) continue
        if (seen.has(u.id)) continue
        seen.add(u.id)
        out.push({ id: u.id })
      }
      return out
    } catch { return [] }
  }
  const dedupePairs = (list) => {
    try {
      const seen = new Set()
      const out = []
      for (const p of Array.isArray(list) ? list : []) {
        if (!p || !p.a || !p.b) continue
        const key = [p.a, p.b].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ a: p.a, b: p.b })
      }
      return out
    } catch { return [] }
  }

  // Stable per-device id (ephemeral in incognito)
  const deviceId = useMemo(() => {
    try {
      const key = 'rv_device_id'
      let id = localStorage.getItem(key)
      if (!id) {
        id = 'd_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
        localStorage.setItem(key, id)
      }
      return id
    } catch {
      return 'd_' + Math.random().toString(36).slice(2)
    }
  }, [])

  useEffect(() => {
    function onConnect() {
      setSelfId(socket.id)
      try { playConnectSound() } catch {}
      // Identify device once connected
      socket.emit('identify', { deviceId })
      // expose socket for admin toggle helper
      try { window.__socket = socket } catch {}
      // re-identify as admin if toggled previously on this browser
      try { if (localStorage.getItem('dooly_admin') === '1') socket.emit('identify_admin', { isAdmin: true }) } catch {}
    }

    function onUsers(list) {
      setUsers(dedupeUsers(list))
      setHasData(true)
    }

    function onPairs(list) {
      setPairs(dedupePairs(list))
      setHasData(true)
    }

    function onUserJoined(user) {
      setUsers(prev => {
        const list = Array.isArray(prev) ? prev : []
        const exists = list.some(u => u && u.id === user?.id)
        const next = exists ? list : dedupeUsers([...list, user])
        if (!exists) { try { playJoinSound() } catch {} }
        return next
      })
    }

    function onUserLeft(user) {
      setUsers(prev => (prev || []).filter(u => u.id !== user.id))
    }

    function onMatchStarted({ partnerId }) {
      setPartnerId(partnerId)
      setMessages([])
      setPartnerDraft('')
      setView('chat')
    }

    function onMessage(msg) {
      setMessages(prev => {
        const full = [...prev, { from: msg.from, text: msg.text, timestamp: msg.timestamp }]
        const evicted = full.length > 2 ? full.slice(0, full.length - 2) : []
        if (evicted.length) {
          setMemories(m => [...m, ...evicted])
        }
        return full.slice(-2)
      })
      try { if (msg.from !== selfId) playReceiveSound() } catch {}
      if (msg.from !== selfId) setPartnerDraft('')
    }

    function onPartnerLeft() {
      setPartnerId(null)
      setView('lobby')
      try { playDisconnectSound() } catch {}
    }

    socket.on('connect', onConnect)
    // If already connected before handlers bound (refresh race), run onConnect immediately
    if (socket.connected) {
      try { onConnect() } catch {}
    } else {
      // Fallback: attempt identify shortly after mount regardless of connect event ordering
      setTimeout(() => { try { socket.emit('identify', { deviceId }) } catch {} }, 500)
    }
    socket.on('users', onUsers)
    // Request fresh snapshots after identify to avoid blank UI on refresh
    const req = () => {
      try {
        socket.emit('tv_request_state')
        socket.emit('identify', { deviceId })
      } catch {}
    }
    const t = setTimeout(req, 250)
    socket.on('pairs', onPairs)
    socket.on('user_joined', onUserJoined)
    socket.on('user_left', onUserLeft)
    socket.on('match_started', onMatchStarted)
    socket.on('message', onMessage)
    socket.on('partner_left', onPartnerLeft)
    socket.on('typing', ({ from, text }) => {
      if (from !== selfId) setPartnerDraft(text || '')
    })
    socket.on('pair_started', ({ a, b }) => setPairs(prev => {
      const key = [a, b].sort().join('|')
      if (prev.some(p => [p.a, p.b].sort().join('|') === key)) return prev
      try { playPairSound() } catch {}
      return [...prev, { a, b }]
    }))
    socket.on('pair_ended', ({ a, b }) => setPairs(prev => prev.filter(p => [p.a, p.b].sort().join('|') !== [a, b].sort().join('|'))))
    socket.on('admin_active', ({ active }) => {
      try { window.__adminActive = !!active } catch {}
    })
    socket.on('admin_update', ({ ids }) => {
      setAdminIds(Array.isArray(ids) ? ids : [])
    })
    socket.on('pinups', ({ list }) => {
      setPinups(Array.isArray(list) ? list : [])
    })
    socket.on('pinups_update', ({ entry }) => {
      setPinups(prev => [...prev.slice(-199), entry])
    })

    socket.on('chat_blocked', ({ targetId }) => {
      try {
        const a = new Audio('/tv_focus.mp3')
        a.volume = 1
        a.play().catch(() => {})
      } catch {}
    })

    socket.on('times_snapshot', (snap) => {
      if (!snap || typeof snap !== 'object') return
      setTimesSnapshot({ nowMs: Number(snap.nowMs) || Date.now(), perSocket: snap.perSocket || {} })
      setHasData(true)
    })
    socket.on('pair_rot_state', (snap) => {
      if (!snap || typeof snap !== 'object') return
      setPairRot(snap.rot || {})
    })
    socket.on('seq_snapshot', (snap) => {
      if (!snap || typeof snap !== 'object') return
      setSeqIds(Array.isArray(snap.ids) ? snap.ids : [])
    })
    socket.on('tv_snapshot', (snap) => {
      if (!snap || typeof snap !== 'object') return
      setTvIds(Array.isArray(snap.ids) ? snap.ids : [])
    })

    return () => {
      socket.off('connect', onConnect)
      socket.off('users', onUsers)
      socket.off('pairs', onPairs)
      socket.off('user_joined', onUserJoined)
      socket.off('user_left', onUserLeft)
      socket.off('match_started', onMatchStarted)
      socket.off('message', onMessage)
      socket.off('partner_left', onPartnerLeft)
      socket.off('typing')
      socket.off('pair_started')
      socket.off('pair_ended')
      socket.off('admin_active')
      socket.off('admin_update')
      socket.off('pinups')
      socket.off('pinups_update')
      socket.off('chat_blocked')
      socket.off('pair_rot_state')
      socket.off('seq_snapshot')
      socket.off('tv_snapshot')
      socket.off('times_snapshot')
      clearTimeout(t)
      socket.disconnect()
    }
  }, [socket, deviceId])
  function handleRotState(type) {
    try { socket.emit('rotting_state', { type }) } catch {}
  }

  // Visible-only heartbeat every second (start immediately on mount to avoid blank until first connect)
  useEffect(() => {
    let timer = null
    function beat() {
      try {
        socket.emit('heartbeat', { now: Date.now(), visible: document.visibilityState === 'visible' })
      } catch {}
    }
    beat()
    timer = setInterval(beat, 1000)
    const onVis = () => beat()
    const onInput = () => beat()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    window.addEventListener('pageshow', onVis)
    window.addEventListener('pointerdown', onInput)
    window.addEventListener('keydown', onInput)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
      window.removeEventListener('pageshow', onVis)
      window.removeEventListener('pointerdown', onInput)
      window.removeEventListener('keydown', onInput)
    }
  }, [socket])

  // Detect stuck boot (no data after 2s) and offer a soft reinit
  useEffect(() => {
    setStuck(false)
    const t = setTimeout(() => { if (!hasData) setStuck(true) }, 2000)
    return () => clearTimeout(t)
  }, [hasData, epoch])

  function softReinit() {
    try { socket.connect() } catch {}
    try { socket.emit('identify', { deviceId }) } catch {}
    setEpoch(e => e + 1)
    setHasData(false)
    setStuck(false)
  }

  function handleRequestChat(targetId) {
    socket.emit('request_chat', { targetId })
  }

  function handleSetDnd(on) {
    try { socket.emit('dnd_state', { on: !!on }) } catch {}
  }

  function handleSendMessage(text) {
    const myMsg = { from: selfId, text, timestamp: Date.now() }
    setMessages(prev => {
      const full = [...prev, myMsg]
      const evicted = full.length > 2 ? full.slice(0, full.length - 2) : []
      if (evicted.length) {
        setMemories(m => [...m, ...evicted])
      }
      return full.slice(-2)
    })
    try { playSendSound() } catch {}
    socket.emit('message', { text })
  }

  function handleTyping(text) {
    socket.emit('typing', { text })
  }

  function handleExitChat() {
    socket.emit('leave_chat')
    try { playDisconnectSound() } catch {}
    setPartnerId(null)
    setPartnerDraft('')
    setView('lobby')
  }

  // Time helpers for overlays
  function effectiveMsFor(socketId) {
    if (!socketId) return 0
    const rec = timesSnapshot.perSocket[socketId]
    if (!rec) return 0
    const base = Number(rec.totalMs) || 0
    if (rec.isActive && timesSnapshot.nowMs) {
      const delta = Math.max(0, Date.now() - timesSnapshot.nowMs)
      const extra = Math.min(delta, 1500) // guard small drift; visual tick
      return base + extra
    }
    return base
  }

  function formatHMS(ms) {
    const totalSec = Math.floor(ms / 1000)
    const s = totalSec % 60
    const m = Math.floor(totalSec / 60) % 60
    const h = Math.floor(totalSec / 3600)
    const pad = (n) => String(n).padStart(2, '0')
    return `${h}:${pad(m)}:${pad(s)}`
  }

  return (
    <div className={`h-full bg-black text-white ${view === 'tv' ? 'overflow-hidden' : ''}`} key={epoch}>
      {showGate && (
        <Gate onDone={() => { try { sessionStorage.setItem('rv_seen_gate', '1') } catch {} setShowGate(false) }} />
      )}
      {!showGate && view === 'lobby' && (
        <Circles
          selfId={selfId}
          users={users}
          pairs={pairs}
          timesBySocket={timesSnapshot.perSocket}
          pairRot={pairRot}
          tvIds={tvIds}
          adminIds={adminIds}
          pinups={pinups}
          seqIds={seqIds}
          onRequestChat={handleRequestChat}
          onOpenTV={() => setView('tv')}
          onOpenSequencer={() => {
            try { socket.emit('seq_state', { inSeq: true }) } catch {}
            setView('sequencer')
          }}
        />
      )}
      {!showGate && view === 'chat' && (
        <Chat
          selfId={selfId}
          partnerId={partnerId}
          timesBySocket={timesSnapshot.perSocket}
          onRotState={handleRotState}
          messages={messages}
          partnerDraft={partnerDraft}
          onSendMessage={handleSendMessage}
          onTyping={handleTyping}
          onExit={handleExitChat}
          memories={memories}
          adminIds={adminIds}
        />
      )}
      {!showGate && view === 'tv' && (
        <TV socket={socket} adminIds={adminIds} onExit={() => setView('lobby')} onEnterTV={() => socket.emit('tv_state', { inTv: true })} onLeaveTV={() => socket.emit('tv_state', { inTv: false })} onSetDnd={handleSetDnd} />
      )}
      {!showGate && view === 'sequencer' && (
        <Sequencer socket={socket} onBack={() => { try { socket.emit('seq_state', { inSeq: false }) } catch {} setView('lobby') }} />
      )}
      {/* Self timer bottom overlay */}
      {!!selfId && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded bg-white/10 backdrop-blur text-white font-mono text-sm">
          {formatHMS(effectiveMsFor(selfId))}
        </div>
      )}
      {/* Partner timer top overlay in chat */}
      {view === 'chat' && !!partnerId && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded bg-white/10 backdrop-blur text-white font-mono text-sm">
          {formatHMS(effectiveMsFor(partnerId))}
        </div>
      )}
      {stuck && (
        <div className="fixed inset-0 z-[999] grid place-items-center pointer-events-none">
          <div className="pointer-events-auto px-4 py-2 rounded bg-white/10 border border-white/20 text-xs text-zinc-200">
            <div className="mb-2">Waking up…</div>
            <button onClick={softReinit} className="px-3 py-1 rounded bg-white/10 hover:bg-white/20">Retry</button>
          </div>
        </div>
      )}
    </div>
  )
}


