const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors({ origin: '*'}));

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

// --- Device time tracking ---
// deviceId -> { totalMs: number, lastCountedSec?: number, lastBeatMs?: number }
const deviceTimes = new Map();
// socketId -> deviceId
const socketToDevice = new Map();
// socketId -> { visible: boolean, lastHeartbeatMs: number }
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
  const user = { id: socket.id, partnerId: null };
  users.set(socket.id, user);

  // Send existing users to the new client (exclude self)
  const existingUsers = Array.from(users.values()).filter(u => u.id !== socket.id);
  socket.emit('users', existingUsers);
  // Send existing active pairs
  socket.emit('pairs', Array.from(pairs.values()));

  // Notify others about the new user
  socket.broadcast.emit('user_joined', { id: user.id });

  // Device identification
  socket.on('identify', ({ deviceId }) => {
    if (!deviceId || typeof deviceId !== 'string') return;
    socketToDevice.set(socket.id, deviceId);
    ensureDevice(deviceId);
  });

  socket.on('request_chat', ({ targetId }) => {
    const requester = users.get(socket.id);
    const target = users.get(targetId);

    if (!requester || !target) return;
    if (requester.partnerId || target.partnerId) return; // one is busy

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
        // Only increment by 1s per wall-second boundary crossed, no catch-up across gaps
        rec.totalMs += 1000;
        rec.lastCountedSec = sec;
        schedulePersist();
      } else if (sec > rec.lastCountedSec && !recent) {
        // If there was a long gap, advance the marker without adding time
        rec.lastCountedSec = sec;
      }
      rec.lastBeatMs = nowMs;
      socketActivity.set(socket.id, { visible: !!visible, lastHeartbeatMs: nowMs });
    } catch (err) {
      // ignore
    }
  });

  socket.on('typing', ({ text }) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    io.to(me.partnerId).emit('typing', { from: me.id, text, timestamp: Date.now() });
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

    users.delete(socket.id);
    socket.broadcast.emit('user_left', { id: socket.id });
    socketToDevice.delete(socket.id);
    socketActivity.delete(socket.id);
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
    const act = socketActivity.get(id);
    const isActive = !!(act && act.visible && (nowMs - act.lastHeartbeatMs) < 2500);
    perSocket[id] = { totalMs: rec.totalMs, isActive };
  }
  io.emit('times_snapshot', { nowMs, perSocket });
}, 1000);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


