const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createGamesStore } = require('./gamesStore');

// Render (and most hosts) assign the port via env var — 3000 is just the local-dev default.
const PORT = process.env.PORT || 3000;
// When packaged with pkg, __dirname points inside a virtual snapshot — use the
// real exe's folder instead so public/ and games/ resolve to files on disk.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const GAMES_DIR = path.join(BASE_DIR, 'games');

// Postgres (via DATABASE_URL, e.g. Render's managed Postgres) when available — a hosted
// service's disk gets wiped on redeploy/restart, so saved games can't just live in games/
// the way they do for local/exe use. Falls back to that same games/ folder otherwise.
const gamesStore = createGamesStore({
  gamesDir: GAMES_DIR,
  templateSeedPath: path.join(GAMES_DIR, 'template.json'),
  databaseUrl: process.env.DATABASE_URL
});

// Constant-time-ish password comparison — a plain === leaks how many leading
// characters matched via response timing. Not bulletproof, but cheap insurance
// for a password that's otherwise just compared over HTTP.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // dummy compare so the miss still takes ~constant time
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Login rate limiting — a handful of wrong guesses is a typo, dozens per minute is a
// script. Keyed by IP, not trying to be clever about proxies/shared IPs for a party app.
const loginAttempts = new Map(); // ip -> { count, windowStart, lockedUntil }
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) { entry = { count: 0, windowStart: now, lockedUntil: 0 }; loginAttempts.set(ip, entry); }
  if (entry.lockedUntil > now) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  if (now - entry.windowStart > LOGIN_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
  return { allowed: true };
}
function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return;
  entry.count++;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
}
function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function safeGameName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name).replace(/[^a-zA-Z0-9_\-]/g, '');
  return base.length ? base : null;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Games can now include video/audio clips (each capped client-side at 25MB), so a
// save with several clips can be well past what plain images ever needed.
function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 300 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => cb(body));
}

// ---------------- Realtime buzzer rooms (multi-room) ----------------
// Anyone can create a room and set its player password on the spot — there's no
// site-wide host gate. Each room is fully independent: its own buzzer/DD state and
// its own set of connected clients.
// token -> { id, name, isHost, roomCode, expiresAt }
const sessions = new Map();
// roomCode -> room state (see createRoom)
const rooms = new Map();

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — long enough for one game night, not forever
const ROOM_MAX_IDLE_MS = 6 * 60 * 60 * 1000;       // absolute safety net
const ROOM_EMPTY_GRACE_MS = 15 * 60 * 1000;        // how long an empty room is kept around (reconnects)

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud
function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(password) {
  const code = generateRoomCode();
  const room = {
    code,
    password,
    clients: new Set(),
    lastActivity: Date.now(),
    buzz: {
      clueId: null,          // which clue is currently live, or null between clues
      open: false,           // true only while buzzing is currently accepted
      locked: false,         // true once a winner has buzzed for this clue attempt
      winner: null,            // { id, name } of the current buzz winner, or null
      excludedPlayers: new Set(), // playerIds locked out for the *current* clueId (wrong answers)
      arrivalLog: []          // ordered log of every valid buzz this clue, for the host panel
    },
    // Daily Double: no open buzzer — one designated player wagers, then answers.
    // The host picks maxWager (it already has the full game/score context); the server
    // just relays and enforces it, the same trust boundary the host already has over the room.
    dd: { active: false, clueId: null, playerId: null, playerName: null, maxWager: 0, wager: null },
    // Scoring lives here now (not just in the host's browser) so it survives the host
    // navigating away/reconnecting, and so each player can see their own score.
    // playerId -> { id, name, score }. Created when a player joins, kept even if they
    // disconnect (so a reconnect doesn't lose their score) — only removed by explicit
    // host action.
    teams: new Map(),
    // Tracks which game + which of its clues are already used, so the host reconnecting
    // (menu navigation, refresh, dropped connection) can resume exactly where they left off
    // instead of the board silently resetting.
    game: { name: null, usedClueIds: new Set() }
  };
  rooms.set(code, room);
  return room;
}

// A stable identity per player name (not a fresh random id every login) so a
// reconnect — or someone hitting /api/join twice from two tabs — doesn't let a
// just-excluded player dodge Daily Double/wrong-answer exclusion by "logging in again".
// Names collide case-insensitively within a room; fine for a casual party game.
function idForPlayer(name) {
  return 'player:' + name.trim().toLowerCase();
}

// Slow periodic sweep — this app doesn't see enough traffic to need anything fancier,
// just enough to keep memory from growing unbounded on a long-running deployment.
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
  for (const [code, room] of rooms) {
    const idleTooLong = now - room.lastActivity > ROOM_MAX_IDLE_MS;
    const emptyTooLong = room.clients.size === 0 && now - room.lastActivity > ROOM_EMPTY_GRACE_MS;
    if (idleTooLong || emptyTooLong) rooms.delete(code);
  }
}, 5 * 60 * 1000).unref();

function sendTo(client, obj) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
}
function broadcastHost(room, obj) {
  room.clients.forEach(c => { if (c.isHost) sendTo(c, obj); });
}
function broadcastPlayers(room, obj) {
  room.clients.forEach(c => { if (!c.isHost) sendTo(c, obj); });
}
function broadcastLobby(room) {
  const players = [...room.clients].filter(c => !c.isHost).map(c => ({ id: c.id, name: c.name }));
  broadcastHost(room, { type: 'lobby', players });
}
function broadcastArrivalLog(room) {
  // entries is the full history for this clue (including already-judged-wrong buzzes);
  // winner/excludedPlayers tell the host which entry, if any, is actually pending judgment.
  broadcastHost(room, {
    type: 'buzz_log',
    entries: room.buzz.arrivalLog,
    winner: room.buzz.winner,
    excludedPlayers: [...room.buzz.excludedPlayers]
  });
}
// Exclusion is per-player, so "buzzer is open" can't be one identical broadcast —
// each player needs to be told whether *they specifically* are excluded this clue.
function broadcastBuzzerOpen(room) {
  room.clients.forEach(c => {
    if (!c.isHost) sendTo(c, { type: 'buzzer_open', excluded: room.buzz.excludedPlayers.has(c.id) });
  });
}

// Every connected player is their own scoreboard entry — created the moment they join,
// kept (with their score) even if they disconnect, so a reconnect doesn't wipe it out.
function ensurePlayerTeam(room, client) {
  if (!room.teams.has(client.id)) {
    room.teams.set(client.id, { id: client.id, name: client.name, score: 0 });
  }
}
function broadcastTeamsState(room) {
  broadcastHost(room, { type: 'teams_state', teams: [...room.teams.values()] });
}
// Players only ever see their own score, never anyone else's — same role-gating
// principle as the buzzer (a player's client is never handed data it shouldn't have).
function sendOwnScore(room, client) {
  const team = room.teams.get(client.id);
  sendTo(client, { type: 'your_score', score: team ? team.score : 0 });
}
function broadcastAllOwnScores(room) {
  room.clients.forEach(c => { if (!c.isHost) sendOwnScore(room, c); });
}

function hostAdjustScore(room, playerId, amount) {
  const team = room.teams.get(playerId);
  if (!team) return;
  const delta = Math.floor(Number(amount));
  if (!Number.isFinite(delta)) return;
  team.score += delta;
  broadcastTeamsState(room);
  broadcastAllOwnScores(room);
}

function hostRemoveTeam(room, playerId) {
  room.teams.delete(playerId);
  broadcastTeamsState(room);
}

// Records which game the host is playing and resets used-clue tracking only when it's
// actually a *different* game — re-selecting the same in-progress game is a resume, not a restart.
function hostSelectGame(room, name) {
  if (room.game.name !== name) {
    room.game.name = name;
    room.game.usedClueIds = new Set();
  }
  sendGameState(room);
}
function sendGameState(room) {
  broadcastHost(room, { type: 'game_state', name: room.game.name, usedClueIds: [...room.game.usedClueIds] });
}

// Closes the room entirely — every connected client (host included) is notified and
// disconnected, and the room stops existing. Distinct from hostCloseClue, which just
// finishes one clue.
function closeRoomEntirely(room) {
  room.clients.forEach(c => {
    sendTo(c, { type: 'room_closed' });
    try { c.ws.close(); } catch (e) {}
  });
  rooms.delete(room.code);
}

function broadcastDdState(room) {
  broadcastHost(room, {
    type: 'dd_state',
    active: room.dd.active,
    playerId: room.dd.playerId,
    playerName: room.dd.playerName,
    maxWager: room.dd.maxWager,
    wager: room.dd.wager
  });
}

// Sends whatever the room's current state is to one client — used both right after
// login and on reconnect, so a client's UI is never stale about what's going on.
function sendRoomState(room, client) {
  if (room.dd.active) {
    if (client.isHost) {
      broadcastDdState(room);
    } else if (client.id === room.dd.playerId) {
      sendTo(client, room.dd.wager === null ? { type: 'wager_prompt', maxWager: room.dd.maxWager } : { type: 'wager_locked' });
    } else {
      sendTo(client, { type: 'dd_in_progress', playerName: room.dd.playerName });
    }
  } else if (!room.buzz.clueId) {
    sendTo(client, { type: 'buzzer_idle' });
  } else if (room.buzz.locked && room.buzz.winner) {
    sendTo(client, { type: 'buzzer_locked', winnerId: room.buzz.winner.id, winnerName: room.buzz.winner.name });
  } else if (room.buzz.open) {
    sendTo(client, { type: 'buzzer_open', excluded: client.isHost ? undefined : room.buzz.excludedPlayers.has(client.id) });
  } else {
    sendTo(client, { type: 'buzzer_idle' });
  }
  if (client.isHost) {
    broadcastArrivalLog(room);
    broadcastTeamsState(room);
    sendGameState(room);
  } else {
    sendOwnScore(room, client);
  }
}

function hostOpenClue(room, clueId) {
  room.dd.active = false;
  room.buzz.clueId = clueId;
  room.buzz.open = true;
  room.buzz.locked = false;
  room.buzz.winner = null;
  room.buzz.excludedPlayers = new Set();
  room.buzz.arrivalLog = [];
  broadcastBuzzerOpen(room);
  broadcastArrivalLog(room);
}

// Daily Double: no open buzzer for everyone — one designated player wagers, then answers.
function hostOpenDailyDouble(room, clueId, playerId, maxWager) {
  const target = [...room.clients].find(c => !c.isHost && c.id === playerId);
  if (!target) return;
  room.buzz.clueId = clueId;
  room.buzz.open = false;
  room.buzz.locked = false;
  room.buzz.winner = null;
  room.buzz.excludedPlayers = new Set();
  room.buzz.arrivalLog = [];
  room.dd.active = true;
  room.dd.clueId = clueId;
  room.dd.playerId = target.id;
  room.dd.playerName = target.name;
  room.dd.maxWager = Math.max(0, Math.floor(Number(maxWager)) || 0);
  room.dd.wager = null;
  sendTo(target, { type: 'wager_prompt', maxWager: room.dd.maxWager });
  room.clients.forEach(c => {
    if (!c.isHost && c.id !== target.id) sendTo(c, { type: 'dd_in_progress', playerName: room.dd.playerName });
  });
  broadcastDdState(room);
}

function handlePlayerWager(room, client, amount) {
  if (!room.dd.active || client.id !== room.dd.playerId || room.dd.wager !== null) return;
  const wager = Math.max(0, Math.floor(Number(amount)) || 0);
  room.dd.wager = Math.min(wager, room.dd.maxWager);
  sendTo(client, { type: 'wager_locked' });
  broadcastDdState(room);
}

// Wrong answer: exclude just that player for this clue and reopen — NOT a full
// reset, so anyone else who already got it wrong earlier on this same clue stays excluded.
function hostMarkWrong(room) {
  if (!room.buzz.winner) return;
  room.buzz.excludedPlayers.add(room.buzz.winner.id);
  room.buzz.winner = null;
  room.buzz.locked = false;
  room.buzz.open = true;
  broadcastPlayers(room, { type: 'buzzer_reset', excludedPlayers: [...room.buzz.excludedPlayers] });
  broadcastBuzzerOpen(room);
  broadcastArrivalLog(room);
}

// Manual escape hatch: clear all exclusions/log on the current clue and reopen fresh
// (e.g. the host fat-fingered a judgment). Distinct from hostMarkWrong's targeted reopen.
function hostReopenAll(room) {
  if (!room.buzz.clueId) return;
  room.buzz.open = true;
  room.buzz.locked = false;
  room.buzz.winner = null;
  room.buzz.excludedPlayers = new Set();
  room.buzz.arrivalLog = [];
  broadcastPlayers(room, { type: 'buzzer_reset', excludedPlayers: [] });
  broadcastBuzzerOpen(room);
  broadcastArrivalLog(room);
}

// Correct answer, or host just closing out the clue — buzzing goes idle until the next clue.
function hostCloseClue(room) {
  if (room.buzz.clueId) {
    room.game.usedClueIds.add(room.buzz.clueId);
    sendGameState(room);
  }
  room.buzz.clueId = null;
  room.buzz.open = false;
  room.buzz.locked = false;
  room.buzz.winner = null;
  room.buzz.excludedPlayers = new Set();
  room.buzz.arrivalLog = [];
  room.dd.active = false;
  room.dd.clueId = null;
  room.dd.playerId = null;
  room.dd.playerName = null;
  room.dd.wager = null;
  broadcastPlayers(room, { type: 'buzzer_idle' });
  broadcastArrivalLog(room);
}

function handlePlayerBuzz(room, client) {
  const ms = Date.now();
  if (!room.buzz.open || room.buzz.locked) {
    sendTo(client, { type: 'buzz_ack', status: 'not_open' });
    return;
  }
  if (room.buzz.excludedPlayers.has(client.id)) {
    sendTo(client, { type: 'buzz_ack', status: 'excluded' });
    return;
  }
  // First valid buzz wins — Node's single-threaded event loop processes incoming
  // WS messages one at a time, so there's no race condition to guard against here.
  room.buzz.locked = true;
  room.buzz.winner = { id: client.id, name: client.name };
  room.buzz.arrivalLog.push({ id: client.id, name: client.name, ms, late: false });
  sendTo(client, { type: 'buzz_ack', status: 'winner' });
  broadcastPlayers(room, { type: 'buzzer_locked', winnerId: client.id, winnerName: client.name });
  broadcastArrivalLog(room);
}

const server = http.createServer((req, res) => {
  const reqPath = req.url.split('?')[0];

  // Create a room: anyone can host — they just pick the password players will use to join.
  if (reqPath === '/api/rooms' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const limit = checkLoginRateLimit(`create:${ip}`);
    if (!limit.allowed) {
      res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
      return sendJson(res, 429, { error: 'Too many rooms created — try again in a few minutes.' });
    }

    return readBody(req, (body) => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const password = typeof payload.password === 'string' ? payload.password.slice(0, 100) : '';
      if (!password) return sendJson(res, 400, { error: 'Set a password for players to join with' });

      const room = createRoom(password);
      const token = crypto.randomUUID();
      sessions.set(token, { id: 'host', name: 'Host', isHost: true, roomCode: room.code, expiresAt: Date.now() + SESSION_TTL_MS });
      sendJson(res, 200, { token, name: 'Host', isHost: true, roomCode: room.code });
    });
  }

  // Join a room as a player.
  if (reqPath.startsWith('/api/rooms/') && reqPath.endsWith('/join') && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const limit = checkLoginRateLimit(`join:${ip}`);
    if (!limit.allowed) {
      res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
      return sendJson(res, 429, { error: 'Too many attempts — try again in a few minutes.' });
    }

    const roomCode = decodeURIComponent(reqPath.slice('/api/rooms/'.length, -'/join'.length)).toUpperCase();
    const room = rooms.get(roomCode);

    return readBody(req, (body) => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      if (!room) return sendJson(res, 404, { error: 'Game not found — check the room code' });

      const password = typeof payload.password === 'string' ? payload.password : '';
      if (!safeEqual(password, room.password)) {
        recordLoginFailure(`join:${ip}`);
        return sendJson(res, 401, { error: 'Incorrect password' });
      }

      const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 24) : '';
      if (!name) return sendJson(res, 400, { error: 'Enter a name' });

      recordLoginSuccess(`join:${ip}`);
      const token = crypto.randomUUID();
      sessions.set(token, { id: idForPlayer(name), name, isHost: false, roomCode: room.code, expiresAt: Date.now() + SESSION_TTL_MS });
      sendJson(res, 200, { token, name, isHost: false, roomCode: room.code });
    });
  }

  // List saved games
  if (reqPath === '/api/games' && req.method === 'GET') {
    return gamesStore.listGames()
      .then(names => sendJson(res, 200, names))
      .catch(() => sendJson(res, 500, { error: 'Failed to list games' }));
  }

  // Load a specific game
  if (reqPath.startsWith('/api/games/') && req.method === 'GET') {
    const name = safeGameName(decodeURIComponent(reqPath.slice('/api/games/'.length)));
    if (!name) return sendJson(res, 400, { error: 'Invalid game name' });
    return gamesStore.loadGame(name)
      .then(game => {
        if (!game) return sendJson(res, 404, { error: 'Game not found' });
        sendJson(res, 200, game);
      })
      .catch(() => sendJson(res, 500, { error: 'Failed to read game' }));
  }

  // Save (create or overwrite) a game
  if (reqPath === '/api/games' && req.method === 'POST') {
    return readBody(req, (body) => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const name = safeGameName(payload.name);
      if (!name) return sendJson(res, 400, { error: 'Invalid game name' });
      if (!payload.game || !Array.isArray(payload.game.categories)) {
        return sendJson(res, 400, { error: 'Invalid game data' });
      }
      gamesStore.saveGame(name, payload.game)
        .then(() => sendJson(res, 200, { ok: true, name }))
        .catch(() => sendJson(res, 500, { error: 'Failed to save game' }));
    });
  }

  // Delete a game
  if (reqPath.startsWith('/api/games/') && req.method === 'DELETE') {
    const name = safeGameName(decodeURIComponent(reqPath.slice('/api/games/'.length)));
    if (!name || name === 'template') return sendJson(res, 400, { error: 'Cannot delete this game' });
    gamesStore.deleteGame(name)
      .then(deleted => {
        if (!deleted) return sendJson(res, 404, { error: 'Game not found' });
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 500, { error: 'Failed to delete game' }));
    return;
  }

  // Static files
  let filePath = path.join(PUBLIC_DIR, reqPath === '/' ? '/index.html' : reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

// ---------------- WebSocket (buzzer) ----------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const token = url.searchParams.get('token');
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) { socket.destroy(); return; }
  const room = rooms.get(session.roomCode);
  if (!room) { socket.destroy(); return; } // room expired/closed since login
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, session, room);
  });
});

wss.on('connection', (ws, req, session, room) => {
  const client = { ws, id: session.id, name: session.name, isHost: session.isHost };
  room.clients.add(client);
  room.lastActivity = Date.now();
  if (!client.isHost) ensurePlayerTeam(room, client);

  // Reconnect handling: whatever's currently happening, tell this client right away
  // so it's never showing stale UI (e.g. a buzzer that looks open when it's actually locked).
  sendRoomState(room, client);
  broadcastLobby(room);
  if (!client.isHost) broadcastTeamsState(room);

  ws.on('message', (raw) => {
    room.lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (client.isHost) {
      if (msg.type === 'host_open' && typeof msg.clueId === 'string') hostOpenClue(room, msg.clueId);
      else if (msg.type === 'host_open_dd' && typeof msg.clueId === 'string' && typeof msg.playerId === 'string') {
        hostOpenDailyDouble(room, msg.clueId, msg.playerId, msg.maxWager);
      }
      else if (msg.type === 'host_judge' && msg.result === 'wrong') hostMarkWrong(room);
      else if (msg.type === 'host_judge' && msg.result === 'correct') hostCloseClue(room);
      else if (msg.type === 'host_reopen_all') hostReopenAll(room);
      else if (msg.type === 'host_close') hostCloseClue(room);
      else if (msg.type === 'host_select_game' && typeof msg.name === 'string') hostSelectGame(room, msg.name);
      else if (msg.type === 'host_adjust_score' && typeof msg.playerId === 'string') hostAdjustScore(room, msg.playerId, msg.amount);
      else if (msg.type === 'host_remove_team' && typeof msg.playerId === 'string') hostRemoveTeam(room, msg.playerId);
      else if (msg.type === 'host_close_room') closeRoomEntirely(room);
      return;
    }

    if (msg.type === 'buzz') handlePlayerBuzz(room, client);
    else if (msg.type === 'wager_submit') handlePlayerWager(room, client, msg.amount);
  });

  ws.on('close', () => {
    room.clients.delete(client);
    room.lastActivity = Date.now();
    broadcastLobby(room);
  });
});

gamesStore.init()
  .then(() => {
    console.log(`Games storage: ${gamesStore.backend}${gamesStore.backend === 'postgres' ? ' (DATABASE_URL)' : ` (${GAMES_DIR})`}`);
    server.listen(PORT, () => {
      const url = `http://localhost:${PORT}`;
      console.log(`Jeopardy board running at ${url}`);

      // When double-clicked as a packaged exe, open the browser automatically
      if (process.pkg) {
        const { exec } = require('child_process');
        const openCmd = process.platform === 'win32' ? `start "" "${url}"`
          : process.platform === 'darwin' ? `open "${url}"`
          : `xdg-open "${url}"`;
        exec(openCmd);
      }
    });
  })
  .catch(err => {
    console.error('Failed to initialize games storage:', err);
    process.exit(1);
  });
