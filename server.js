const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = 3000;
// When packaged with pkg, __dirname points inside a virtual snapshot — use the
// real exe's folder instead so public/ and games/ resolve to files on disk.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const GAMES_DIR = path.join(BASE_DIR, 'games');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');

if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

let config = { playerPassword: 'jeopardy', hostPassword: 'hostpass' };
try {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch (e) {
  console.warn('No config.json found (or invalid) — using default passwords. Create config.json to set your own.');
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

// ---------------- Realtime buzzer room ----------------
// Single-room model — this app is one host running one game at a time.
// token -> { id, name, isHost }
const sessions = new Map();
// live sockets: Set of { ws, id, name, isHost }
const clients = new Set();

// Server-authoritative buzz state. Never trust a client's own timing/identity —
// arrival order and "who buzzed" are both decided here, from the server's own
// message-arrival order (Node's event loop serializes this for us) and the
// identity tied to the client's authenticated session, not anything the client sends.
const room = {
  clueId: null,          // which clue is currently live, or null between clues
  open: false,           // true only while buzzing is currently accepted
  locked: false,         // true once a winner has buzzed for this clue attempt
  winner: null,           // { id, name } of the current buzz winner, or null
  excludedPlayers: new Set(), // playerIds locked out for the *current* clueId (wrong answers)
  arrivalLog: []          // ordered log of every valid buzz this clue, for the host panel
};

function sendTo(client, obj) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
}
function broadcastHost(obj) {
  clients.forEach(c => { if (c.isHost) sendTo(c, obj); });
}
function broadcastPlayers(obj) {
  clients.forEach(c => { if (!c.isHost) sendTo(c, obj); });
}
function broadcastLobby() {
  const players = [...clients].filter(c => !c.isHost).map(c => ({ id: c.id, name: c.name }));
  broadcastHost({ type: 'lobby', players });
}
function broadcastArrivalLog() {
  // entries is the full history for this clue (including already-judged-wrong buzzes);
  // winner/excludedPlayers tell the host which entry, if any, is actually pending judgment.
  broadcastHost({
    type: 'buzz_log',
    entries: room.arrivalLog,
    winner: room.winner,
    excludedPlayers: [...room.excludedPlayers]
  });
}
// Exclusion is per-player, so "buzzer is open" can't be one identical broadcast —
// each player needs to be told whether *they specifically* are excluded this clue.
function broadcastBuzzerOpen() {
  clients.forEach(c => {
    if (!c.isHost) sendTo(c, { type: 'buzzer_open', excluded: room.excludedPlayers.has(c.id) });
  });
}

// Sends whatever the room's current state is to one client — used both right after
// login and on reconnect, so a client's UI is never stale about what's going on.
function sendRoomState(client) {
  if (!room.clueId) {
    sendTo(client, { type: 'buzzer_idle' });
  } else if (room.locked && room.winner) {
    sendTo(client, { type: 'buzzer_locked', winnerId: room.winner.id, winnerName: room.winner.name });
  } else if (room.open) {
    sendTo(client, { type: 'buzzer_open', excluded: client.isHost ? undefined : room.excludedPlayers.has(client.id) });
  } else {
    sendTo(client, { type: 'buzzer_idle' });
  }
  if (client.isHost) {
    broadcastArrivalLog();
  }
}

function hostOpenClue(clueId) {
  room.clueId = clueId;
  room.open = true;
  room.locked = false;
  room.winner = null;
  room.excludedPlayers = new Set();
  room.arrivalLog = [];
  broadcastBuzzerOpen();
  broadcastArrivalLog();
}

// Wrong answer: exclude just that player for this clue and reopen — NOT a full
// reset, so anyone else who already got it wrong earlier on this same clue stays excluded.
function hostMarkWrong() {
  if (!room.winner) return;
  room.excludedPlayers.add(room.winner.id);
  room.winner = null;
  room.locked = false;
  room.open = true;
  broadcastPlayers({ type: 'buzzer_reset', excludedPlayers: [...room.excludedPlayers] });
  broadcastBuzzerOpen();
  broadcastArrivalLog();
}

// Manual escape hatch: clear all exclusions/log on the current clue and reopen fresh
// (e.g. the host fat-fingered a judgment). Distinct from hostMarkWrong's targeted reopen.
function hostReopenAll() {
  if (!room.clueId) return;
  room.open = true;
  room.locked = false;
  room.winner = null;
  room.excludedPlayers = new Set();
  room.arrivalLog = [];
  broadcastPlayers({ type: 'buzzer_reset', excludedPlayers: [] });
  broadcastBuzzerOpen();
  broadcastArrivalLog();
}

// Correct answer, or host just closing out the clue — buzzing goes idle until the next clue.
function hostCloseClue() {
  room.clueId = null;
  room.open = false;
  room.locked = false;
  room.winner = null;
  room.excludedPlayers = new Set();
  room.arrivalLog = [];
  broadcastPlayers({ type: 'buzzer_idle' });
  broadcastArrivalLog();
}

function handlePlayerBuzz(client) {
  const ms = Date.now();
  if (!room.open || room.locked) {
    sendTo(client, { type: 'buzz_ack', status: 'not_open' });
    return;
  }
  if (room.excludedPlayers.has(client.id)) {
    sendTo(client, { type: 'buzz_ack', status: 'excluded' });
    return;
  }
  // First valid buzz wins — Node's single-threaded event loop processes incoming
  // WS messages one at a time, so there's no race condition to guard against here.
  room.locked = true;
  room.winner = { id: client.id, name: client.name };
  room.arrivalLog.push({ id: client.id, name: client.name, ms, late: false });
  sendTo(client, { type: 'buzz_ack', status: 'winner' });
  broadcastPlayers({ type: 'buzzer_locked', winnerId: client.id, winnerName: client.name });
  broadcastArrivalLog();
}

const server = http.createServer((req, res) => {
  const reqPath = req.url.split('?')[0];

  // Login: issue a session token for either a player or the host
  if (reqPath === '/api/login' && req.method === 'POST') {
    return readBody(req, (body) => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const role = payload.role === 'host' ? 'host' : 'player';
      const password = typeof payload.password === 'string' ? payload.password : '';
      const expected = role === 'host' ? config.hostPassword : config.playerPassword;
      if (password !== expected) return sendJson(res, 401, { error: 'Incorrect password' });

      const name = role === 'host'
        ? 'Host'
        : (typeof payload.name === 'string' ? payload.name.trim().slice(0, 24) : '');
      if (role === 'player' && !name) return sendJson(res, 400, { error: 'Enter a name' });

      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      sessions.set(token, { id, name, isHost: role === 'host' });
      sendJson(res, 200, { token, name, isHost: role === 'host' });
    });
  }

  // List saved games
  if (reqPath === '/api/games' && req.method === 'GET') {
    const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
    return sendJson(res, 200, files.map(f => f.replace(/\.json$/, '')));
  }

  // Load a specific game
  if (reqPath.startsWith('/api/games/') && req.method === 'GET') {
    const name = safeGameName(decodeURIComponent(reqPath.slice('/api/games/'.length)));
    if (!name) return sendJson(res, 400, { error: 'Invalid game name' });
    const filePath = path.join(GAMES_DIR, name + '.json');
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'Game not found' });
    return fs.readFile(filePath, (err, data) => {
      if (err) return sendJson(res, 500, { error: 'Failed to read game' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
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
      const filePath = path.join(GAMES_DIR, name + '.json');
      fs.writeFile(filePath, JSON.stringify(payload.game, null, 2), (err) => {
        if (err) return sendJson(res, 500, { error: 'Failed to save game' });
        sendJson(res, 200, { ok: true, name });
      });
    });
  }

  // Delete a game
  if (reqPath.startsWith('/api/games/') && req.method === 'DELETE') {
    const name = safeGameName(decodeURIComponent(reqPath.slice('/api/games/'.length)));
    if (!name || name === 'template') return sendJson(res, 400, { error: 'Cannot delete this game' });
    const filePath = path.join(GAMES_DIR, name + '.json');
    fs.unlink(filePath, (err) => {
      if (err) return sendJson(res, 404, { error: 'Game not found' });
      sendJson(res, 200, { ok: true });
    });
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
  if (!session) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, session);
  });
});

wss.on('connection', (ws, req, session) => {
  const client = { ws, id: session.id, name: session.name, isHost: session.isHost };
  clients.add(client);

  // Reconnect handling: whatever's currently happening, tell this client right away
  // so it's never showing stale UI (e.g. a buzzer that looks open when it's actually locked).
  sendRoomState(client);
  broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (client.isHost) {
      if (msg.type === 'host_open' && typeof msg.clueId === 'string') hostOpenClue(msg.clueId);
      else if (msg.type === 'host_judge' && msg.result === 'wrong') hostMarkWrong();
      else if (msg.type === 'host_judge' && msg.result === 'correct') hostCloseClue();
      else if (msg.type === 'host_reopen_all') hostReopenAll();
      else if (msg.type === 'host_close') hostCloseClue();
      return;
    }

    if (msg.type === 'buzz') handlePlayerBuzz(client);
  });

  ws.on('close', () => {
    clients.delete(client);
    broadcastLobby();
  });
});

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
