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
  console.warn('No config.json found (or invalid) — using default passwords. Copy config.json to set your own.');
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

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 50 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => cb(body));
}

// ---------------- Realtime buzzer session state ----------------
// token -> { name, isHost }
const sessions = new Map();
// live sockets: Set of { ws, token, name, isHost }
const clients = new Set();
// current buzz window for whatever clue the host has open
let buzzState = { open: false, clueId: null, openedAt: 0, queue: [] };

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
  const players = [...clients].filter(c => !c.isHost).map(c => c.name);
  broadcastHost({ type: 'lobby', players });
}

// ---------------- HTTP ----------------
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

      const token = crypto.randomUUID();
      sessions.set(token, { name, isHost: role === 'host' });
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

// ---------------- WebSocket (buzzing) ----------------
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
  const client = { ws, name: session.name, isHost: session.isHost };
  clients.add(client);

  // Sync new connection with current state
  sendTo(client, { type: 'state', open: buzzState.open, clueId: buzzState.clueId, queue: buzzState.queue });
  if (client.isHost) broadcastLobby(); else broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (client.isHost) {
      if (msg.type === 'open') {
        buzzState = { open: true, clueId: msg.clueId, openedAt: Date.now(), queue: [] };
        broadcastPlayers({ type: 'opened', clueId: buzzState.clueId });
        broadcastHost({ type: 'queue', queue: buzzState.queue });
      } else if (msg.type === 'close') {
        buzzState.open = false;
        broadcastPlayers({ type: 'closed' });
      } else if (msg.type === 'reset') {
        buzzState.queue = [];
        buzzState.open = true;
        buzzState.openedAt = Date.now();
        broadcastPlayers({ type: 'opened', clueId: buzzState.clueId });
        broadcastHost({ type: 'queue', queue: buzzState.queue });
      }
      return;
    }

    // Player messages
    if (msg.type === 'buzz') {
      if (!buzzState.open) return;
      if (buzzState.queue.some(q => q.name === client.name)) return;
      const ms = Date.now() - buzzState.openedAt;
      buzzState.queue.push({ name: client.name, ms });
      broadcastHost({ type: 'queue', queue: buzzState.queue });
      sendTo(client, { type: 'buzzed', place: buzzState.queue.length });
    }
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
