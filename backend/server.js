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

// Static uploads for SFX assets
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }) } catch {}
app.use('/uploads', express.static(UPLOAD_DIR))

// In-memory user store: socketId -> { id: string, partnerId: string | null }
const users = new Map();
// In-memory pairs store: pairKey (sorted "a|b") -> { a: string, b: string }
const pairs = new Map();
// Users currently in TV view: Set of socketIds
const tvUsers = new Set();
// Users currently on Sequencer page: Set of socketIds
const seqUsers = new Set();
// ---- Collaborative Sequencer: in-memory songs ----
// song = { id, tempo, bars, stepsPerBar, lanes, grid, notes, playing, baseBar, baseTsMs, rev }
const songs = new Map();
function ensureSong(songId = 'default') {
  if (!songs.has(songId)) {
    const bars = 4;
    const stepsPerBar = 16;
    const lanes = ['KICK', 'SNARE', 'HAT', 'CLAP'];
    const total = bars * stepsPerBar;
    const grid = Array.from({ length: lanes.length }, () => Array.from({ length: total }, () => false));
    const notes = []; // piano roll notes: { id, startStep, lengthSteps, pitch, velocity }
    songs.set(songId, {
      id: songId,
      tempo: 120,
      bars,
      stepsPerBar,
      lanes,
      grid,
      notes,
      patterns: [{ id: 'p1', name: 'Pattern 1', bars: 4, notes: [] }],
      activePatternId: 'p1',
      clips: [], // arrangement clips: { id, track, startStep, lengthSteps }
      sfx: [],   // sfx events: { id, track, startStep, lengthSteps, url, gain, pan, offsetMs }
      playing: false,
      baseBar: 0,
      baseTsMs: Date.now(),
      rev: 1,
    });
  }
  return songs.get(songId);
}
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
// Admin queue of explicit next videos (videoIds). When non-empty, these take precedence.
let tvQueue = [];
// Live mode (admin toggles WebRTC activation signal for clients)
let tvLive = false;

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
  // Send current Sequencer users snapshot
  socket.emit('seq_snapshot', { ids: Array.from(seqUsers) });
  // Send default song snapshot for convenience
  try {
    const s = ensureSong('default');
    socket.emit('seq_song', { song: s, rev: s.rev });
    socket.emit('seq_transport', { songId: s.id, playing: s.playing, baseBar: s.baseBar, baseTsMs: s.baseTsMs, tempo: s.tempo });
  } catch {}
  // Send current live flag
  socket.emit('tv_live', { on: tvLive });

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

  // Sequencer state (user enters/exits Sequencer view)
  socket.on('seq_state', ({ inSeq }) => {
    try {
      if (inSeq) seqUsers.add(socket.id); else seqUsers.delete(socket.id);
      io.emit('seq_snapshot', { ids: Array.from(seqUsers) });
    } catch {}
  });

  // Sequencer: join a song room and receive snapshot
  socket.on('seq_join', ({ songId }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      const song = ensureSong(id);
      socket.join(`seq:${id}`);
      io.to(socket.id).emit('seq_song', { song, rev: song.rev });
      io.to(socket.id).emit('seq_transport', { songId: song.id, playing: song.playing, baseBar: song.baseBar, baseTsMs: song.baseTsMs, tempo: song.tempo });
    } catch {}
  });

  // Sequencer: apply ops
  socket.on('seq_ops', ({ songId, parentRev, ops }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      const song = ensureSong(id);
      if (!Array.isArray(ops)) return;
      // Be tolerant of parentRev mismatches to avoid dropping edits from other tabs
      // (we still send the latest snapshot below for clients to converge).
      let changed = false;
      let structural = false;
      for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.type === 'toggle_step') {
          const lane = Math.max(0, Math.min(song.lanes.length - 1, Number(op.lane)));
          const step = Math.max(0, Math.min(song.bars * song.stepsPerBar - 1, Number(op.step)));
          if (Number.isFinite(lane) && Number.isFinite(step)) {
            song.grid[lane][step] = !song.grid[lane][step];
            changed = true;
          }
        } else if (op.type === 'set_tempo') {
          const t = Number(op.tempo);
          if (isFinite(t) && t >= 40 && t <= 240) { song.tempo = Math.round(t); changed = true; }
        } else if (op.type === 'note_add') {
          const ns = {
            id: typeof op.id === 'string' ? op.id : Date.now().toString(36) + Math.random().toString(36).slice(2),
            startStep: Math.max(0, Math.min(song.bars * song.stepsPerBar, Number(op.startStep) || 0)),
            lengthSteps: Math.max(1, Math.min(song.stepsPerBar * song.bars, Number(op.lengthSteps) || 1)),
            pitch: Math.max(21, Math.min(108, Number(op.pitch) || 60)),
            velocity: Math.max(0.05, Math.min(1, Number(op.velocity) || 0.8)),
            synth: typeof op.synth === 'string' ? op.synth : 'Triangle',
          };
          const pid = typeof op.patternId === 'string' ? op.patternId : song.activePatternId;
          const pat = Array.isArray(song.patterns) ? song.patterns.find(p => p.id === pid) : null;
          if (pat) { pat.notes.push(ns); changed = true; structural = true; } else { song.notes.push(ns); changed = true; }
        } else if (op.type === 'note_delete') {
          const idstr = String(op.id || '');
          let affected = false;
          if (Array.isArray(song.patterns)) {
            for (const p of song.patterns) {
              const beforeP = p.notes.length;
              p.notes = p.notes.filter(n => n.id !== idstr);
              if (p.notes.length !== beforeP) { affected = true; structural = true; }
            }
          }
          const before = song.notes.length;
          song.notes = song.notes.filter(n => n.id !== idstr);
          if (song.notes.length !== before) affected = true;
          if (affected) changed = true;
        } else if (op.type === 'note_update') {
          const idstr = String(op.id || '');
          let n = song.notes.find(x => x.id === idstr);
          if (!n && Array.isArray(song.patterns)) {
            for (const p of song.patterns) { const hit = p.notes.find(x => x.id === idstr); if (hit) { n = hit; break; } }
          }
          if (n) {
            const total = song.bars * song.stepsPerBar;
            if (op.startStep !== undefined) n.startStep = Math.max(0, Math.min(total, Number(op.startStep) || 0));
            if (op.lengthSteps !== undefined) n.lengthSteps = Math.max(1, Math.min(total - n.startStep, Number(op.lengthSteps) || 1));
            if (op.pitch !== undefined) n.pitch = Math.max(21, Math.min(108, Number(op.pitch) || 60));
            if (op.velocity !== undefined) n.velocity = Math.max(0.05, Math.min(1, Number(op.velocity) || 0.8));
            if (op.synth !== undefined && typeof op.synth === 'string') n.synth = op.synth;
            changed = true; structural = true;
          }
        } else if (op.type === 'pattern_add') {
          const id = typeof op.id === 'string' ? op.id : ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2));
          const name = typeof op.name === 'string' ? op.name : 'Pattern';
          const barsP = Math.max(1, Math.min(256, Number(op.bars) || 4));
          if (!song.patterns) song.patterns = [];
          song.patterns.push({ id, name, bars: barsP, notes: [] }); song.activePatternId = id; changed = true; structural = true;
        } else if (op.type === 'pattern_update') {
          const pid = String(op.id||'');
          const p = Array.isArray(song.patterns) ? song.patterns.find(x=>x.id===pid) : null;
          if (p) {
            if (typeof op.name === 'string') p.name = op.name;
            if (op.bars !== undefined) p.bars = Math.max(1, Math.min(256, Number(op.bars)||p.bars));
            changed = true; structural = true;
          }
        } else if (op.type === 'pattern_delete') {
          const pid = String(op.id||'');
          if (Array.isArray(song.patterns)) {
            const before = song.patterns.length;
            song.patterns = song.patterns.filter(p=>p.id!==pid);
            if (before !== song.patterns.length) { changed = true; structural = true; if (song.activePatternId === pid) song.activePatternId = song.patterns[0]?.id || null }
          }
        } else if (op.type === 'pattern_select') {
          const pid = String(op.id||'');
          if (Array.isArray(song.patterns) && song.patterns.find(p=>p.id===pid)) { song.activePatternId = pid; changed = true; }
        } else if (op.type === 'clip_add') {
          const total = song.bars * song.stepsPerBar;
          const c = {
            id: typeof op.id === 'string' ? op.id : Date.now().toString(36) + Math.random().toString(36).slice(2),
            track: Math.max(0, Math.min(3, Number(op.track) || 0)),
            startStep: Math.max(0, Math.min(total, Number(op.startStep) || 0)),
            lengthSteps: Math.max(1, Math.min(total, Number(op.lengthSteps) || song.stepsPerBar * 4)),
            patternId: typeof op.patternId === 'string' ? op.patternId : (song.activePatternId || 'p1')
          };
          song.clips.push(c); changed = true; structural = true;
        } else if (op.type === 'clip_update') {
          const idstr = String(op.id || '');
          const c = song.clips.find(x => x.id === idstr);
          if (c) {
            const total = song.bars * song.stepsPerBar;
            if (op.track !== undefined) c.track = Math.max(0, Math.min(3, Number(op.track)));
            if (op.startStep !== undefined) c.startStep = Math.max(0, Math.min(total, Number(op.startStep) || 0));
            if (op.lengthSteps !== undefined) c.lengthSteps = Math.max(1, Math.min(total - c.startStep, Number(op.lengthSteps) || 1));
            if (op.patternId !== undefined && typeof op.patternId === 'string') c.patternId = op.patternId;
            changed = true; structural = true;
          }
        } else if (op.type === 'clip_delete') {
          const idstr = String(op.id || '');
          const before = song.clips.length;
          song.clips = song.clips.filter(c => c.id !== idstr);
          if (song.clips.length !== before) { changed = true; structural = true; }
        } else if (op.type === 'sfx_add') {
          const total = song.bars * song.stepsPerBar;
          const s = {
            id: typeof op.id === 'string' ? op.id : Date.now().toString(36) + Math.random().toString(36).slice(2),
            track: Math.max(0, Math.min(3, Number(op.track) || 0)),
            startStep: Math.max(0, Math.min(total, Number(op.startStep) || 0)),
            lengthSteps: Math.max(1, Math.min(total, Number(op.lengthSteps) || 1)),
            url: typeof op.url === 'string' ? op.url : '',
            gain: (typeof op.gain === 'number' && isFinite(op.gain)) ? Math.max(0, Math.min(1, op.gain)) : 1,
            pan: (typeof op.pan === 'number' && isFinite(op.pan)) ? Math.max(-1, Math.min(1, op.pan)) : 0,
            offsetMs: (typeof op.offsetMs === 'number' && isFinite(op.offsetMs)) ? Math.max(0, op.offsetMs) : 0,
          };
          song.sfx.push(s); changed = true; structural = true;
        } else if (op.type === 'sfx_update') {
          const idstr = String(op.id || '');
          const s = song.sfx.find(x => x.id === idstr);
          if (s) {
            const total = song.bars * song.stepsPerBar;
            if (op.track !== undefined) s.track = Math.max(0, Math.min(3, Number(op.track)));
            if (op.startStep !== undefined) s.startStep = Math.max(0, Math.min(total, Number(op.startStep) || 0));
            if (op.lengthSteps !== undefined) s.lengthSteps = Math.max(1, Math.min(total - s.startStep, Number(op.lengthSteps) || 1));
            if (op.url !== undefined && typeof op.url === 'string') s.url = op.url;
            if (op.gain !== undefined && isFinite(Number(op.gain))) s.gain = Math.max(0, Math.min(1, Number(op.gain)));
            if (op.pan !== undefined && isFinite(Number(op.pan))) s.pan = Math.max(-1, Math.min(1, Number(op.pan)));
            if (op.offsetMs !== undefined && isFinite(Number(op.offsetMs))) s.offsetMs = Math.max(0, Number(op.offsetMs));
            changed = true; structural = true;
          }
        } else if (op.type === 'sfx_delete') {
          const idstr = String(op.id || '');
          const before = song.sfx.length;
          song.sfx = song.sfx.filter(c => c.id !== idstr);
          if (song.sfx.length !== before) { changed = true; structural = true; }
        } else if (op.type === 'set_bars') {
          const nb = Math.max(1, Math.min(1000, Number(op.bars) || song.bars));
          if (nb !== song.bars) {
            const totalOld = song.bars * song.stepsPerBar;
            const totalNew = nb * song.stepsPerBar;
            // resize grid
            song.grid = song.grid.map(row => {
              const copy = row.slice(0, totalNew);
              while (copy.length < totalNew) copy.push(false);
              return copy;
            });
            // clamp notes within new length
            song.notes = song.notes.map(n => ({
              ...n,
              startStep: Math.max(0, Math.min(totalNew - 1, n.startStep)),
              lengthSteps: Math.max(1, Math.min(totalNew - n.startStep, n.lengthSteps))
            }));
            // clamp clips and sfx within new length
            song.clips = (song.clips || []).map(c => ({
              ...c,
              startStep: Math.max(0, Math.min(totalNew - 1, c.startStep)),
              lengthSteps: Math.max(1, Math.min(totalNew - c.startStep, c.lengthSteps))
            }));
            song.sfx = (song.sfx || []).map(s => ({
              ...s,
              startStep: Math.max(0, Math.min(totalNew - 1, s.startStep)),
              lengthSteps: Math.max(1, Math.min(totalNew - s.startStep, s.lengthSteps))
            }));
            song.bars = nb; changed = true;
            structural = true;
          }
        }
      }
      if (changed) {
        song.rev += 1;
        io.to(`seq:${id}`).emit('seq_apply', { ops, rev: song.rev });
        // For structural changes like bars, also send a fresh snapshot to guarantee UI updates
        const hasBars = Array.isArray(ops) && ops.some(o => o && o.type === 'set_bars')
        if (hasBars || structural) {
          io.to(`seq:${id}`).emit('seq_song', { song, rev: song.rev });
        }
      }
    } catch {}
  });

  // Sequencer: collaborative page cursor (volatile)
  socket.on('seq_cursor', ({ songId, cursor }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      if (!cursor || typeof cursor !== 'object') return;
      const nx = Number(cursor.nx);
      const ny = Number(cursor.ny);
      const sect = typeof cursor.sect === 'string' ? cursor.sect : undefined;
      const sx = Number(cursor.sx);
      const sy = Number(cursor.sy);
      const payload = {
        from: socket.id,
        ts: Date.now(),
        nx: isFinite(nx) ? Math.max(0, Math.min(1, nx)) : undefined,
        ny: isFinite(ny) ? Math.max(0, Math.min(1, ny)) : undefined,
        sect,
        sx: isFinite(sx) ? Math.max(0, Math.min(1, sx)) : undefined,
        sy: isFinite(sy) ? Math.max(0, Math.min(1, sy)) : undefined,
        track: (typeof cursor.track === 'number' && isFinite(cursor.track)) ? Math.round(Math.max(0, Math.min(3, Number(cursor.track)))) : undefined,
        ty: (typeof cursor.ty === 'number' && isFinite(cursor.ty)) ? Math.max(0, Math.min(1, Number(cursor.ty))) : undefined,
      };
      socket.to(`seq:${id}`).volatile.emit('seq_cursor', payload);
    } catch {}
  });

  // SFX upload: client sends base64 data URL or raw base64; server saves and returns URL
  socket.on('sfx_upload', async ({ songId, name, dataBase64 }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      ensureSong(id);
      let raw = String(dataBase64 || '');
      const m = raw.match(/^data:[^;]+;base64,(.*)$/);
      if (m) raw = m[1];
      if (!raw) return;
      const buf = Buffer.from(raw, 'base64');
      const safeName = String(name || 'sfx').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
      const ext = (safeName.includes('.') ? safeName.split('.').pop() : 'dat');
      const filename = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}.${ext}`;
      const outPath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(outPath, buf);
      const url = `/uploads/${filename}`;
      io.to(socket.id).emit('sfx_uploaded', { name: safeName, url });
    } catch {}
  });

  // Sequencer: transport control
  socket.on('seq_transport', ({ songId, playing, positionBars, tempo }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      const song = ensureSong(id);
      const now = Date.now();
      if (typeof tempo === 'number' && tempo >= 40 && tempo <= 240) song.tempo = Math.round(tempo);
      if (typeof playing === 'boolean') song.playing = playing;
      if (typeof positionBars === 'number' && isFinite(positionBars)) song.baseBar = Math.max(0, positionBars);
      song.baseTsMs = now;
      io.to(`seq:${id}`).emit('seq_transport', { songId: song.id, playing: song.playing, baseBar: song.baseBar, baseTsMs: song.baseTsMs, tempo: song.tempo });
    } catch {}
  });

  // Sequencer: typing preview (volatile, room-scoped)
  socket.on('seq_typing_preview', ({ songId, text, nx, ny }) => {
    try {
      const id = typeof songId === 'string' && songId.trim() ? songId.trim() : 'default';
      const t = typeof text === 'string' ? text.slice(0, 140) : '';
      const x = Number(nx), y = Number(ny);
      const payload = {
        id: socket.id,
        text: t,
        nx: isFinite(x) ? Math.max(0, Math.min(1, x)) : undefined,
        ny: isFinite(y) ? Math.max(0, Math.min(1, y)) : undefined,
        ts: Date.now(),
      };
      socket.to(`seq:${id}`).volatile.emit('seq_typing_preview', payload);
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
      advanceTv(Date.now());
    } catch {}
  });

  // ---- Admin TV controls ----
  socket.on('tv_admin_set_video', ({ videoId }) => {
    try {
      if (!adminSockets.has(socket.id)) return;
      const vid = normalizeVideoId(videoId);
      if (!vid) return;
      setCurrentVideo(vid, Date.now());
      const state = computeTvRoomState();
      if (state) io.to('tv').emit('tv_room_state', state);
    } catch {}
  });

  // Admin toggles live mode (WebRTC desired)
  socket.on('tv_admin_live', ({ on }) => {
    try {
      if (!adminSockets.has(socket.id)) return;
      tvLive = !!on;
      io.to('tv').emit('tv_live', { on: tvLive });
    } catch {}
  });

  socket.on('tv_admin_skip', () => {
    try {
      if (!adminSockets.has(socket.id)) return;
      advanceTv(Date.now());
      const state = computeTvRoomState();
      if (state) io.to('tv').emit('tv_room_state', state);
    } catch {}
  });

  socket.on('tv_admin_queue', ({ videoIds }) => {
    try {
      if (!adminSockets.has(socket.id)) return;
      const list = Array.isArray(videoIds) ? videoIds : [];
      for (const raw of list) {
        const vid = normalizeVideoId(raw);
        if (!vid) continue;
        if (!tvQueue.includes(vid)) tvQueue.push(vid);
      }
    } catch {}
  });

  socket.on('tv_admin_clear_queue', () => {
    try {
      if (!adminSockets.has(socket.id)) return;
      tvQueue = [];
      // Switch immediately back to default next item
      if (tvPlaylistOrder && tvPlaylistOrder.length > 0) {
        tvBaseIndex = (tvBaseIndex + 1) % tvPlaylistOrder.length;
        tvBaseTs = Date.now();
        const state = computeTvRoomState();
        if (state) io.to('tv').emit('tv_room_state', state);
      }
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
    if (seqUsers.delete(socket.id)) {
      io.emit('seq_snapshot', { ids: Array.from(seqUsers) });
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
  // TV view counts once per tick
  try {
    let watching = 0, altTabbed = 0;
    for (const id of tvUsers) {
      const a = socketActivity.get(id) || { visible: false, isActive: false };
      if (a.visible && a.isActive) watching++; else altTabbed++;
    }
    io.to('tv').emit('tv_view_counts', { watching, altTabbed });
  } catch {}
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

// Helpers for admin controls and end-of-video advance
function normalizeVideoId(input) {
  try {
    if (!input || typeof input !== 'string') return null;
    const m = input.match(/[a-zA-Z0-9_-]{11}/);
    return m ? m[0] : null;
  } catch { return null }
}

function setCurrentVideo(videoId, nowMs) {
  try {
    if (!tvPlaylistOrder) tvPlaylistOrder = [];
    const idx = tvPlaylistOrder.indexOf(videoId);
    if (idx === -1) {
      // Prepend and keep unique
      tvPlaylistOrder = [videoId, ...tvPlaylistOrder.filter(v => v !== videoId)];
      tvBaseIndex = 0;
    } else {
      tvBaseIndex = idx;
    }
    tvBaseTs = nowMs;
    tvPaused = false;
  } catch {}
}

function advanceTv(nowMs) {
  try {
    // If queue has items, play from queue first
    if (tvQueue && tvQueue.length > 0) {
      const next = tvQueue.shift();
      setCurrentVideo(next, nowMs);
      return;
    }
    if (!tvPlaylistOrder || tvPlaylistOrder.length === 0) return;
    tvBaseIndex = (tvBaseIndex + 1) % tvPlaylistOrder.length;
    tvBaseTs = nowMs;
  } catch {}
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


