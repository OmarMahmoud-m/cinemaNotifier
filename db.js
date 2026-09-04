const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'vox.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('date','movie')),
    cinema TEXT NOT NULL,
    movie TEXT NOT NULL,
    date TEXT,          -- only used when type = 'date'
    days_ahead INTEGER, -- only used when type = 'movie'
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Persisted "last known state" per GROUP of watches (e.g. every user
  -- watching "the-odyssey" at "mall-of-egypt" shares one row), so
  -- restarting the app doesn't forget what was already open, AND so we
  -- only scrape each unique cinema+movie combo once no matter how many
  -- users are watching it.
  CREATE TABLE IF NOT EXISTS watch_state (
    state_key TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

function getOrCreateUser(email) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return existing.id;
  const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
  return result.lastInsertRowid;
}

/**
 * Add a new watch for a user.
 * type: 'date'  -> requires { date: 'YYYYMMDD' }
 * type: 'movie' -> optional { daysAhead: 7 }
 */
function addWatch({ email, type, cinema, movie, date = null, daysAhead = null }) {
  const userId = getOrCreateUser(email);
  const result = db
    .prepare(
      `INSERT INTO watches (user_id, type, cinema, movie, date, days_ahead)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, type, cinema, movie, date, daysAhead);
  return result.lastInsertRowid;
}

function getAllWatches() {
  return db
    .prepare(
      `SELECT watches.*, users.email
       FROM watches
       JOIN users ON users.id = watches.user_id`
    )
    .all();
}

function getWatchState(stateKey) {
  const row = db.prepare('SELECT state_json FROM watch_state WHERE state_key = ?').get(stateKey);
  return row ? JSON.parse(row.state_json) : null;
}

function setWatchState(stateKey, stateObj) {
  db.prepare(
    `INSERT INTO watch_state (state_key, state_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')`
  ).run(stateKey, JSON.stringify(stateObj));
}

module.exports = { addWatch, getAllWatches, getWatchState, setWatchState, getOrCreateUser };
