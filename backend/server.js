const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const timesyncServer = require('timesync/server');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors({ origin: '*'}));
// Timesync endpoint for NTP-like client clock sync
app.use('/timesync', timesyncServer.requestHandler);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-memory user store: socketId -> { id: string, partnerId: string | null }
const users = new Map();
// In-memory pairs store: pairKey (sorted "a|b") -> { a: string, b: string }
const pairs = new Map();
// Users currently in TV view: Set of socketIds
const tvUsers = new Set();
// Pair rot state: pairKey -> { state: 'red'|'blue'|'none', updatedAtMs: number }
const pairRotState = new Map();
const ROT_TTL_MS = 7000;
// Users who are not accepting chats (Do Not Disturb while on TV or otherwise)
const dndUsers = new Set();
// Admin sockets
const adminSockets = new Set();
// Pin-up board (in-memory, persisted to disk)
let pinups = [];
const PINUPS_PATH = path.join(__dirname, 'pinups.json');
try {
  if (fs.existsSync(PINUPS_PATH)) {
    const data = JSON.parse(fs.readFileSync(PINUPS_PATH, 'utf8'))
    if (Array.isArray(data)) pinups = data
  }
} catch {}
function savePinups() {
  try { fs.writeFileSync(PINUPS_PATH, JSON.stringify(pinups.slice(-200), null, 2), 'utf8') } catch {}
}

// ---- TV GLOBAL CLOCK (server-authoritative) ----
// Authoritative playlist order (array of YouTube videoIds)
let tvPlaylistOrder = null;
// Video durations map (videoId -> seconds)
const tvDurations = new Map();
// Base index into playlist and base timestamp (ms) when current video started
let tvBaseIndex = 0;
let tvBaseTs = 0;
// Playback properties
let tvPlaybackRate = 1;
let tvPaused = false;

// --- Device time tracking ---
// deviceId -> { totalMs: number, lastCountedSec?: number, lastBeatMs?: number }
const deviceTimes = new Map();
// socketId -> deviceId
const socketToDevice = new Map();
// socketId -> { visible: boolean, lastHeartbeatMs: number, inactiveStreak: number, activeStreak: number, isActive: boolean }
const socketActivity = new Map();

const DATA_PATH = path.join(__dirname, 'times.json');

function loadTimesFromDisk() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      Object.entries(parsed || {}).forEach(([deviceId, value]) => {
        const totalMs = typeof value.totalMs === 'number' ? value.totalMs : 0;
        const lastCountedSec = typeof value.lastCountedSec === 'number'
          ? value.lastCountedSec
          : (typeof value.lastTickSec === 'number' ? value.lastTickSec : undefined);
        const lastBeatMs = typeof value.lastBeatMs === 'number' ? value.lastBeatMs : undefined;
        deviceTimes.set(deviceId, { totalMs, lastCountedSec, lastBeatMs });
      });
    }
  } catch (err) {
    console.error('Failed to load times.json:', err);
  }
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj = {};
      deviceTimes.forEach((v, k) => {
        obj[k] = {
          totalMs: v.totalMs,
          lastCountedSec: v.lastCountedSec,
          lastBeatMs: v.lastBeatMs,
        };
      });
      fs.writeFileSync(DATA_PATH, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to write times.json:', err);
    }
  }, 500);
}

function ensureDevice(deviceId) {
  if (!deviceTimes.has(deviceId)) {
    deviceTimes.set(deviceId, { totalMs: 0, lastCountedSec: undefined, lastBeatMs: undefined });
  }
  return deviceTimes.get(deviceId);
}

loadTimesFromDisk();

app.get('/', (_req, res) => {
  res.send('Chat backend is running');
});

io.on('connection', (socket) => {
  // On connect, send non-user state snapshots; defer user registration until identify
  // Send existing active pairs
  socket.emit('pairs', Array.from(pairs.values()));
  // Send current admin sockets snapshot
  socket.emit('admin_update', { ids: Array.from(adminSockets) });
  // Send pinups
  socket.emit('pinups', { list: pinups });
  // Send current TV users snapshot
  socket.emit('tv_snapshot', { ids: Array.from(tvUsers) });

  // Device identification
  socket.on('identify', ({ deviceId }) => {
    if (!deviceId || typeof deviceId !== 'string') return;
    socketToDevice.set(socket.id, deviceId);
    ensureDevice(deviceId);

    // Deduplicate by device: disconnect older sockets from same device
    try {
      for (const [otherId, dev] of socketToDevice.entries()) {
        if (dev === deviceId && otherId !== socket.id) {
          const other = io.sockets.sockets.get(otherId);
          try { other?.disconnect(true); } catch {}
        }
      }
    } catch {}

    // Register user only after identify to avoid ghost circles
    if (!users.has(socket.id)) {
      users.set(socket.id, { id: socket.id, partnerId: null });
    }
    // Send users list (exclude self)
    try {
      const existingUsers = Array.from(users.values()).filter(u => u.id !== socket.id);
      socket.emit('users', existingUsers);
    } catch {}
    // Notify others about the new user
    try { socket.broadcast.emit('user_joined', { id: socket.id }); } catch {}
  });

  socket.on('request_chat', ({ targetId }) => {
    const requester = users.get(socket.id);
    const target = users.get(targetId);

    if (!requester || !target) return;
    if (requester.partnerId || target.partnerId) return; // one is busy

    // Respect DND: target is not accepting chats
    if (dndUsers.has(target.id)) {
      io.to(requester.id).emit('chat_blocked', { targetId: target.id });
      return;
    }

    requester.partnerId = target.id;
    target.partnerId = requester.id;

    io.to(requester.id).emit('match_started', { partnerId: target.id });
    io.to(target.id).emit('match_started', { partnerId: requester.id });

    // Track and broadcast the active pair to everyone (for lobby display)
    const a = requester.id;
    const b = target.id;
    const key = [a, b].sort().join('|');
    pairs.set(key, { a, b });
    io.emit('pair_started', { a, b });
  });

  socket.on('message', ({ text }) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    io.to(me.partnerId).emit('message', {
      from: me.id,
      text,
      timestamp: Date.now()
    });
    // Treat chat activity as presence
    const rec = socketActivity.get(socket.id);
    if (rec) rec.lastHeartbeatMs = Date.now();
  });

  // Heartbeat: count at most 1s per real second when heartbeats are continuous and visible
  socket.on('heartbeat', ({ now, visible }) => {
    try {
      const deviceId = socketToDevice.get(socket.id);
      if (!deviceId) return;
      const nowMs = typeof now === 'number' ? now : Date.now();
      const sec = Math.floor(nowMs / 1000);
      const rec = ensureDevice(deviceId);
      const recent = typeof rec.lastBeatMs === 'number' ? (nowMs - rec.lastBeatMs) < 2500 : false;
      if (typeof rec.lastCountedSec !== 'number') {
        rec.lastCountedSec = sec;
      }
      if (visible && recent && sec > rec.lastCountedSec) {
        // Increment; apply rotting multiplier if applicable
        let deltaSec = sec - rec.lastCountedSec;
        // Cap single-step to avoid large catches (should normally be 1)
        if (deltaSec > 3) deltaSec = 1;

        let multiplier = 1;
        // If in a pair and pair is red-rotting, apply 4x
        const me = users.get(socket.id);
        if (me && me.partnerId) {
          const key = [me.id, me.partnerId].sort().join('|');
          const rot = pairRotState.get(key);
          if (rot && rot.state === 'red' && (nowMs - rot.updatedAtMs) <= ROT_TTL_MS) {
            multiplier = 4;
          }
        }

        rec.totalMs += deltaSec * 1000 * multiplier;
        rec.lastCountedSec = sec;
        schedulePersist();
      } else if (!visible && recent && sec > rec.lastCountedSec) {
        // Decrement while hidden
        let deltaSec = sec - rec.lastCountedSec;
        if (deltaSec > 3) deltaSec = 1;
        rec.totalMs = Math.max(0, rec.totalMs - deltaSec * 1000);
        rec.lastCountedSec = sec;
        schedulePersist();
      } else if (sec > rec.lastCountedSec && !recent) {
        // If there was a long gap, advance the marker without adding time
        rec.lastCountedSec = sec;
      }
      rec.lastBeatMs = nowMs;
      const act = socketActivity.get(socket.id) || { visible: !!visible, lastHeartbeatMs: nowMs, inactiveStreak: 0, activeStreak: 0, isActive: true };
      act.visible = !!visible;
      act.lastHeartbeatMs = nowMs;
      socketActivity.set(socket.id, act);
    } catch (err) {
      // ignore
    }
  });

  // TV state (user enters/exits TV view)
  socket.on('tv_state', ({ inTv }) => {
    try {
      if (inTv) tvUsers.add(socket.id); else tvUsers.delete(socket.id);
      io.emit('tv_snapshot', { ids: Array.from(tvUsers) });
    } catch {}
  });

  // Do Not Disturb toggle (prevent chat pairing attempts)
  socket.on('dnd_state', ({ on }) => {
    try {
      if (on) dndUsers.add(socket.id); else dndUsers.delete(socket.id);
    } catch {}
  });

  // Admin identification (client-side gated for now)
  socket.on('identify_admin', ({ isAdmin }) => {
    try {
      if (isAdmin) adminSockets.add(socket.id); else adminSockets.delete(socket.id);
      io.emit('admin_active', { active: adminSockets.size > 0 });
      io.emit('admin_update', { ids: Array.from(adminSockets) });
    } catch {}
  });

  // TV paparazzi flash broadcast
  socket.on('tv_flash', () => {
    try { io.to('tv').emit('tv_flash', { at: Date.now() }); } catch {}
  });

  // Pinup add
  socket.on('tv_pinup_add', ({ imageUrl, videoId, ts, authorId }) => {
    try {
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        imageUrl: String(imageUrl || ''),
        videoId: String(videoId || ''),
        ts: typeof ts === 'number' ? ts : Date.now(),
        authorId: String(authorId || socket.id),
      }
      pinups.push(entry)
      pinups = pinups.slice(-200)
      savePinups()
      io.emit('pinups_update', { entry })
    } catch {}
  });

  // --- TV room membership ---
  socket.on('join_room', ({ roomId }) => {
    try {
      if (roomId === 'tv') socket.join('tv');
      if (roomId === 'tv') {
        const state = computeTvRoomState();
        if (state) io.to(socket.id).emit('tv_room_state', state);
      }
    } catch {}
  });
  socket.on('leave_room', ({ roomId }) => {
    try {
      if (roomId === 'tv') socket.leave('tv');
    } catch {}
  });

  // Followers request current TV state
  socket.on('tv_request_state', () => {
    try {
      const state = computeTvRoomState();
      if (state) socket.emit('tv_room_state', state);
    } catch {}
  });

  // Bootstrap: first ready client reports playlist order (shuffled by client)
  socket.on('tv_playlist', ({ order }) => {
    try {
      if (!Array.isArray(order) || order.length === 0) return;
      if (!tvPlaylistOrder || tvPlaylistOrder.length === 0) {
        tvPlaylistOrder = order.slice();
        tvBaseIndex = 0;
        tvBaseTs = Date.now();
        tvPlaybackRate = 1;
        tvPaused = false;
        const state = computeTvRoomState();
        if (state) io.to('tv').emit('tv_room_state', state);
      }
    } catch {}
  });

  // Clients report known duration for current video when available
  socket.on('tv_duration', ({ videoId, duration }) => {
    try {
      if (typeof videoId !== 'string') return;
      const d = Number(duration);
      if (!isFinite(d) || d <= 0) return;
      tvDurations.set(videoId, d);
    } catch {}
  });

  // A client detected that current video ended (safety advance)
  socket.on('tv_ended', ({ videoId }) => {
    try {
      if (!tvPlaylistOrder || tvPlaylistOrder.length === 0) return;
      const currentId = tvPlaylistOrder[tvBaseIndex];
      if (videoId && videoId !== currentId) return;
      tvBaseIndex = (tvBaseIndex + 1) % tvPlaylistOrder.length;
      tvBaseTs = Date.now();
      const state = computeTvRoomState();
      if (state) io.to('tv').emit('tv_room_state', state);
    } catch {}
  });

  // Rotting state reporting from clients
  socket.on('rotting_state', ({ type }) => {
    try {
      const me = users.get(socket.id);
      if (!me || !me.partnerId) return;
      const a = me.id; const b = me.partnerId;
      const key = [a, b].sort().join('|');
      let next = 'none';
      if (type === 'blue' || type === 'red') next = type;
      // Set directly to the latest reported state; periodic TTL cleanup will clear stale values
      pairRotState.set(key, { state: next, updatedAtMs: Date.now() });
    } catch {}
  });

  // --- TV transient chat: relay only, no storage ---
  socket.on('tv_message', ({ text, seed }) => {
    try {
      if (typeof text !== 'string' || !text.trim()) return;
      const payload = { id: socket.id, text: String(text).slice(0, 500), ts: Date.now(), seed: Number(seed) || 0 };
      io.to('tv').emit('tv_message', payload);
    } catch {}
  });

  socket.on('tv_typing_preview', ({ seed, text }) => {
    try {
      const s = Number(seed) || 0;
      const t = typeof text === 'string' ? text.slice(0, 500) : '';
      const payload = { id: socket.id, seed: s, text: t, ts: Date.now() };
      io.to('tv').volatile.emit('tv_typing_preview', payload);
    } catch {}
  });

  socket.on('typing', ({ text }) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    io.to(me.partnerId).emit('typing', { from: me.id, text, timestamp: Date.now() });
    // Treat typing as presence
    const rec = socketActivity.get(socket.id);
    if (rec) rec.lastHeartbeatMs = Date.now();
  });

  socket.on('leave_chat', () => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const partner = users.get(me.partnerId);
    if (partner) {
      partner.partnerId = null;
      io.to(partner.id).emit('partner_left');
      const a = me.id; const b = partner.id;
      const key = [a, b].sort().join('|');
      if (pairs.has(key)) {
        pairs.delete(key);
        io.emit('pair_ended', { a, b });
      }
    }
    me.partnerId = null;
  });

  socket.on('disconnect', () => {
    const me = users.get(socket.id);
    if (me && me.partnerId) {
      const partner = users.get(me.partnerId);
      if (partner) {
        partner.partnerId = null;
        io.to(partner.id).emit('partner_left');
      }

      // Remove and broadcast pair ended
      const a = me.id;
      const b = me.partnerId;
      const key = [a, b].sort().join('|');
      if (pairs.has(key)) {
        pairs.delete(key);
        io.emit('pair_ended', { a, b });
      }
    }

    if (users.has(socket.id)) {
      users.delete(socket.id);
      socket.broadcast.emit('user_left', { id: socket.id });
    }
    socketToDevice.delete(socket.id);
    socketActivity.delete(socket.id);
    if (tvUsers.delete(socket.id)) {
      io.emit('tv_snapshot', { ids: Array.from(tvUsers) });
    }
    dndUsers.delete(socket.id);
    adminSockets.delete(socket.id);
    io.emit('admin_active', { active: adminSockets.size > 0 });
    io.emit('admin_update', { ids: Array.from(adminSockets) });
  });
});

// Broadcast per-socket time snapshot every second
setInterval(() => {
  const perSocket = {};
  const nowMs = Date.now();
  for (const [id, sock] of io.sockets.sockets) {
    const deviceId = socketToDevice.get(id);
    if (!deviceId) continue;
    const rec = deviceTimes.get(deviceId) || { totalMs: 0 };
    // Presence smoothing with grace/hysteresis
    const a = socketActivity.get(id) || { visible: false, lastHeartbeatMs: 0, inactiveStreak: 0, activeStreak: 0, isActive: false };
    const GRACE_MS = 6500; // allow up to 6.5s between beats
    const recentlyBeat = (nowMs - a.lastHeartbeatMs) < GRACE_MS;
    const shouldBeActive = !!(a.visible && recentlyBeat);
    if (shouldBeActive) {
      a.activeStreak += 1;
      a.inactiveStreak = 0;
      // flip active immediately on first active tick
      if (!a.isActive && a.activeStreak >= 1) a.isActive = true;
    } else {
      a.inactiveStreak += 1;
      a.activeStreak = 0;
      // require 3 consecutive inactive evaluations to flip to inactive
      if (a.isActive && a.inactiveStreak >= 3) a.isActive = false;
    }
    socketActivity.set(id, a);
    perSocket[id] = { totalMs: rec.totalMs, isActive: !!a.isActive };
  }
  io.emit('times_snapshot', { nowMs, perSocket });

  // Expire stale rot states and broadcast snapshot
  const rot = {};
  for (const [key, val] of pairRotState.entries()) {
    if (nowMs - val.updatedAtMs > ROT_TTL_MS) {
      pairRotState.delete(key);
    } else {
      rot[key] = val.state;
    }
  }
  io.emit('pair_rot_state', { rot });

  // --- TV global clock advance (server-authoritative) ---
  if (tvPlaylistOrder && tvPlaylistOrder.length > 0) {
    const nowMs = Date.now();
    const currentId = tvPlaylistOrder[tvBaseIndex];
    const dur = tvDurations.get(currentId);
    if (!tvPaused && typeof dur === 'number' && dur > 0) {
      const elapsed = (nowMs - tvBaseTs) * tvPlaybackRate;
      if (elapsed >= dur * 1000) {
        tvBaseIndex = (tvBaseIndex + 1) % tvPlaylistOrder.length;
        tvBaseTs = nowMs;
        const state = computeTvRoomState();
        if (state) io.to('tv').emit('tv_room_state', state);
      }
    }
    // Always broadcast current state once per tick so followers can converge
    const state = computeTvRoomState();
    if (state) io.to('tv').emit('tv_room_state', state);
  }
}, 1000);

function computeTvRoomState() {
  try {
    if (!tvPlaylistOrder || tvPlaylistOrder.length === 0) return null;
    const videoId = tvPlaylistOrder[tvBaseIndex];
    return {
      videoId,
      baseIndex: tvBaseIndex,
      baseTs: tvBaseTs,
      playbackRate: tvPlaybackRate,
      isPlaying: !tvPaused,
    };
  } catch {
    return null;
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


