// Storage for saved games. Two backends behind the same async interface:
//   - Postgres, when DATABASE_URL is set (e.g. Render's managed Postgres) — needed
//     because Render's free web-service disk is wiped on every redeploy/restart.
//   - Local JSON files in games/, when there's no DATABASE_URL — keeps `node server.js`
//     working with zero setup for local dev/hosting off a machine you control.
const fs = require('fs');
const path = require('path');

function createFileStore(gamesDir) {
  if (!fs.existsSync(gamesDir)) fs.mkdirSync(gamesDir, { recursive: true });

  return {
    backend: 'file',
    async init() {},
    async listGames() {
      return fs.readdirSync(gamesDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    },
    async loadGame(name) {
      const filePath = path.join(gamesDir, name + '.json');
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
    async saveGame(name, data) {
      fs.writeFileSync(path.join(gamesDir, name + '.json'), JSON.stringify(data, null, 2));
    },
    async deleteGame(name) {
      const filePath = path.join(gamesDir, name + '.json');
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    }
  };
}

function createPostgresStore(databaseUrl, templateSeedPath) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false } // Render's managed Postgres requires SSL
  });

  return {
    backend: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS games (
          name TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // Seed the template game on first run so a fresh database isn't empty.
      const { rows } = await pool.query('SELECT 1 FROM games WHERE name = $1', ['template']);
      if (rows.length === 0 && fs.existsSync(templateSeedPath)) {
        const template = JSON.parse(fs.readFileSync(templateSeedPath, 'utf8'));
        await pool.query(
          'INSERT INTO games (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
          ['template', template]
        );
      }
    },
    async listGames() {
      const { rows } = await pool.query('SELECT name FROM games ORDER BY name');
      return rows.map(r => r.name);
    },
    async loadGame(name) {
      const { rows } = await pool.query('SELECT data FROM games WHERE name = $1', [name]);
      return rows.length ? rows[0].data : null;
    },
    async saveGame(name, data) {
      await pool.query(
        `INSERT INTO games (name, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET data = $2, updated_at = now()`,
        [name, data]
      );
    },
    async deleteGame(name) {
      const result = await pool.query('DELETE FROM games WHERE name = $1', [name]);
      return result.rowCount > 0;
    }
  };
}

function createGamesStore({ gamesDir, templateSeedPath, databaseUrl }) {
  return databaseUrl
    ? createPostgresStore(databaseUrl, templateSeedPath)
    : createFileStore(gamesDir);
}

module.exports = { createGamesStore };
