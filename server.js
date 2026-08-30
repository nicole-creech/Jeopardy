const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(__dirname, 'games');

if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR);

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

const server = http.createServer((req, res) => {
  const reqPath = req.url.split('?')[0];

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

server.listen(PORT, () => {
  console.log(`Jeopardy board running at http://localhost:${PORT}`);
});
