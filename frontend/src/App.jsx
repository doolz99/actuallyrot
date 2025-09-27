import React, { useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'
import Circles from './Circles.jsx'
import Chat from './Chat.jsx'
import { playJoinSound, playPairSound, playSendSound, playReceiveSound, playConnectSound, playDisconnectSound } from './audio'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export default function App() {
  const socket = useMemo(() => io(BACKEND_URL, { autoConnect: true }), [])

  const [view, setView] = useState('lobby') // 'lobby' | 'chat'
  const [users, setUsers] = useState([]) // array of { id }
  const [selfId, setSelfId] = useState(null)
  const [partnerId, setPartnerId] = useState(null)
  const [messages, setMessages] = useState([])
  const [pairs, setPairs] = useState([]) // array of { a, b }
  const [partnerDraft, setPartnerDraft] = useState('')
  const [memories, setMemories] = useState([]) // all past messages beyond the last visible
  const [timesSnapshot, setTimesSnapshot] = useState({ nowMs: 0, perSocket: {} })

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
    }

    function onUsers(list) {
      setUsers(list)
    }

    function onPairs(list) {
      setPairs(list)
    }

    function onUserJoined(user) {
      setUsers(prev => [...prev, user])
      try { playJoinSound() } catch {}
    }

    function onUserLeft(user) {
      setUsers(prev => prev.filter(u => u.id !== user.id))
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
    socket.on('users', onUsers)
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

    socket.on('times_snapshot', (snap) => {
      if (!snap || typeof snap !== 'object') return
      setTimesSnapshot({ nowMs: Number(snap.nowMs) || Date.now(), perSocket: snap.perSocket || {} })
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
      socket.off('times_snapshot')
      socket.disconnect()
    }
  }, [socket, deviceId])

  // Visible-only heartbeat every second
  useEffect(() => {
    let timer = null
    function beat() {
      try {
        socket.emit('heartbeat', { now: Date.now(), visible: document.visibilityState === 'visible' })
      } catch {}
    }
    timer = setInterval(beat, 1000)
    const onVis = () => beat()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onVis)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onVis)
    }
  }, [socket])

  function handleRequestChat(targetId) {
    socket.emit('request_chat', { targetId })
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
    <div className="h-full bg-black text-white">
      {view === 'lobby' && (
        <Circles
          selfId={selfId}
          users={users}
          pairs={pairs}
          timesBySocket={timesSnapshot.perSocket}
          onRequestChat={handleRequestChat}
        />
      )}
      {view === 'chat' && (
        <Chat
          selfId={selfId}
          partnerId={partnerId}
          messages={messages}
          partnerDraft={partnerDraft}
          onSendMessage={handleSendMessage}
          onTyping={handleTyping}
          onExit={handleExitChat}
          memories={memories}
        />
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
    </div>
  )
}


