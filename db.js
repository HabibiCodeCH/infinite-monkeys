// The store. SQLite through node:sqlite, so still no dependencies.
//
// Three things it provides:
//
//   1. A replace is one conditional UPDATE. The version, the lock and the deadline are
//      all in the WHERE clause, so the check and the write cannot be separated.
//   2. Cooldowns and highlight dedupe outlive a restart. Which browser highlighted which
//      word is what makes a highlight count mean anything.
//   3. Two processes can serve the same story. BEGIN IMMEDIATE gives one writer at a
//      time; WAL lets readers carry on meanwhile.

import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS words (
    id         TEXT    PRIMARY KEY,
    position   INTEGER NOT NULL UNIQUE,
    text       TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    changed_at INTEGER NOT NULL,
    sets_at    INTEGER NOT NULL,
    highlights INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS words_by_position ON words (position);

  -- Every key in the two tables below is an HMAC of a cookie id, never the id itself,
  -- so nothing here is readable as a person. Rows are swept once they expire.
  --
  -- 'turn' is writing, 'mark' is highlighting.
  CREATE TABLE IF NOT EXISTS cooldowns (
    key  TEXT    NOT NULL,
    kind TEXT    NOT NULL,
    at   INTEGER NOT NULL,
    PRIMARY KEY (key, kind)
  );

  -- Which words a browser has already highlighted, so one person cannot vote twice.
  CREATE TABLE IF NOT EXISTS marks (
    key     TEXT NOT NULL,
    word_id TEXT NOT NULL,
    PRIMARY KEY (key, word_id)
  );
`

export function open(path = process.env.DB_PATH ?? join(ROOT, 'data/story.db')) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000') // wait rather than fail when another writer holds it
  db.exec(SCHEMA)

  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('started_at')) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('started_at', String(Date.now()))
  }

  return db
}

/**
 * The per-install key that cookie ids are hashed with before they are stored.
 *
 * Prefer HASH_SECRET in the environment. Kept in the database only as a fallback, and
 * that is weaker: anyone holding the file could then test a guess against the stored
 * digests. Somewhere else entirely is the right home for it.
 */
export function secretOf(db) {
  if (process.env.HASH_SECRET) return process.env.HASH_SECRET
  const row = db.prepare("SELECT value FROM meta WHERE key = 'secret'").get()
  if (row) return row.value
  const secret = randomBytes(32).toString('hex')
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('secret', secret)
  return secret
}

/** Drops cooldown rows that can no longer affect anything. */
export function sweep(db, olderThanMs = 60 * 60 * 1000) {
  return db.prepare('DELETE FROM cooldowns WHERE at < ?').run(Date.now() - olderThanMs).changes
}

/** Runs fn inside a write transaction. One writer at a time, across processes. */
export function write(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
