// Infinite Monkey — prototype server. No dependencies, run with `node server.js`.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHmac } from 'node:crypto'
import { open, write, secretOf, sweep } from './db.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.PORT ?? 4000)
// Behind a reverse proxy set HOST=127.0.0.1, or the port stays reachable from outside it.
const HOST = process.env.HOST ?? '0.0.0.0'

// ---------------------------------------------------------------- rules

// Overridable so tests and demos can run the clock fast. The defaults are the real rules.
const ms = (name, fallback) => Number(process.env[name] ?? fallback)

// Churn is the whole game. Monkeys only get to Shakespeare if each word is attempted
// many times before it freezes, so the cooldown and the lock are kept short on purpose.
const TURN_COOLDOWN_MS = ms('TURN_COOLDOWN_MS', 15 * 1000) // one turn per person
// Same figure as the turn cooldown on purpose. Two different rules with two similar
// numbers was impossible to explain: one number covers both.
const WORD_LOCK_MS = ms('WORD_LOCK_MS', 15 * 1000) // a word changes at most this often
const TARGET_EDITABLE = 40 // aim for this many changeable words at any moment
// A flat 10 minutes. The rate-based sizing below still runs, but with the floor and the
// ceiling equal it can only ever land on 10 minutes. Widen these two to bring it back.
const WINDOW_MIN_MS = ms('WINDOW_MIN_MS', 10 * 60 * 1000)
const WINDOW_MAX_MS = ms('WINDOW_MAX_MS', 10 * 60 * 1000)
const RATE_LOOKBACK_MS = 30 * 60 * 1000 // short, so the window tracks the crowd it has now
const RATE_MIN_ELAPSED_MIN = 2 // stops an opening burst collapsing the window

// A word in its last moments flashes, and saving it at the buzzer buys it more time.
const ENDING_MS = ms('ENDING_MS', 10 * 1000)
const EXTENSION_MS = ms('EXTENSION_MS', 30 * 1000)

// Highlights are free and never touch your writing turn. They only land on set words, so
// this is a reading layer over the frozen part of the story, not a vote on the live part.
const HIGHLIGHT_COOLDOWN_MS = ms('HIGHLIGHT_COOLDOWN_MS', 3 * 1000)
const HIGHLIGHT_MAX_WORDS = 60

const PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])

// ---------------------------------------------------------------- dictionary

const dictionary = new Set(
  readFileSync(join(ROOT, 'data/dictionary.txt'), 'utf8').split('\n').filter(Boolean),
)

/** Returns the token to store, or an error string. Everything is stored lowercase. */
function validateToken(raw) {
  const token = String(raw ?? '').trim().toLowerCase()
  if (!token) return { error: 'Type a word.' }
  if (PUNCTUATION.has(token)) return { token }
  if (/[0-9]/.test(token)) return { error: 'No digits. Spell numbers out.' }
  if (/\s/.test(token)) return { error: 'One word at a time.' }
  if (!/^[a-z]+$/.test(token)) return { error: 'Letters only, or one of . , ; : ! ?' }
  if (!dictionary.has(token)) return { error: `"${token}" is not in the dictionary.` }
  return { token }
}

// ---------------------------------------------------------------- state

const db = open()

const q = {
  words: db.prepare('SELECT * FROM words ORDER BY position'),
  word: db.prepare('SELECT * FROM words WHERE id = ?'),
  nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM words'),
  recentCount: db.prepare('SELECT COUNT(*) AS n FROM words WHERE created_at >= ?'),
  startedAt: db.prepare("SELECT value FROM meta WHERE key = 'started_at'"),

  insertWord: db.prepare(
    `INSERT INTO words (id, position, text, version, created_at, changed_at, sets_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ),

  // The whole guard lives in the WHERE clause. There is no gap between deciding and
  // writing, so this stays correct under any number of processes or awaits.
  tryReplace: db.prepare(
    `UPDATE words
        SET text       = :text,
            version    = version + 1,
            changed_at = :now,
            sets_at    = CASE WHEN sets_at - :now <= :ending
                              THEN sets_at + :extension ELSE sets_at END
      WHERE id         = :id
        AND version    = :version
        AND sets_at    > :now
        AND changed_at <= :lockedBefore
        AND text       <> :text`,
  ),

  cooldown: db.prepare('SELECT at FROM cooldowns WHERE kind = ? AND key = ?'),
  touchCooldown: db.prepare('INSERT OR REPLACE INTO cooldowns (key, kind, at) VALUES (?, ?, ?)'),

  markedAlready: db.prepare('SELECT 1 FROM marks WHERE word_id = ? AND key = ? LIMIT 1'),

  visits: db.prepare("SELECT value FROM meta WHERE key = 'visits'"),
  countVisit: db.prepare(
    `INSERT INTO meta (key, value) VALUES ('visits', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
  ),
  addMark: db.prepare('INSERT OR IGNORE INTO marks (key, word_id) VALUES (?, ?)'),
  bumpHighlight: db.prepare('UPDATE words SET highlights = highlights + 1 WHERE id = ?'),
}

const STARTED_AT = Number(q.startedAt.get().value)

// Nothing that identifies a person reaches the database in readable form.
const SECRET = secretOf(db)
const anonymise = (raw) => createHmac('sha256', SECRET).update(raw).digest('base64url').slice(0, 22)

/** Rows come back snake_case. Everything above this line speaks camelCase. */
const fromRow = (r) => ({
  id: r.id,
  text: r.text,
  version: Number(r.version),
  createdAt: Number(r.created_at),
  changedAt: Number(r.changed_at),
  setsAt: Number(r.sets_at),
  highlights: Number(r.highlights),
})

const allWords = () => q.words.all().map(fromRow)

// ---------------------------------------------------------------- the set window

/**
 * How long a new word stays changeable. Busy story, short window; quiet story, long
 * one. Sized so roughly TARGET_EDITABLE words are changeable at once.
 *
 * A word's own deadline is frozen when it is created, so its countdown never jumps.
 */
function currentWindowMs(now = Date.now()) {
  const since = now - RATE_LOOKBACK_MS
  const recent = Number(q.recentCount.get(since).n)
  const elapsedMin = Math.max(RATE_MIN_ELAPSED_MIN, (now - Math.max(STARTED_AT, since)) / 60_000)
  const perMinute = recent / elapsedMin
  const windowMs = perMinute > 0 ? (TARGET_EDITABLE / perMinute) * 60_000 : WINDOW_MAX_MS
  return Math.round(Math.min(WINDOW_MAX_MS, Math.max(WINDOW_MIN_MS, windowMs)))
}

// ---------------------------------------------------------------- turns

/** Last time this browser did `kind`, or 0. */
function lastAction(browser, kind) {
  return Number(q.cooldown.get(kind, browser)?.at ?? 0)
}

function turnState(browser, now = Date.now()) {
  const last = lastAction(browser, 'turn')
  return { readyAt: last + TURN_COOLDOWN_MS, ready: now - last >= TURN_COOLDOWN_MS }
}

function recordTurn(browser, now = Date.now()) {
  q.touchCooldown.run(browser, 'turn', now)
}

// ---------------------------------------------------------------- who is here

const PRESENCE_MS = ms('PRESENCE_MS', 12 * 1000) // clients poll every 2.5s, so a few misses
const VISIT_GAP_MS = ms('VISIT_GAP_MS', 30 * 60 * 1000) // come back later, count again

// Last time each browser was seen. Deliberately in memory: presence is a live fact, and
// it should be forgotten the moment the process is.
const seen = new Map()

function markPresent(browser, now = Date.now()) {
  seen.set(browser, now)
  for (const [key, at] of seen) if (now - at > PRESENCE_MS) seen.delete(key)
}

const liveCount = () => seen.size

/**
 * A visit is a page load by a browser that has not loaded one in the last half hour.
 * The marker rides in the cooldowns table, which the sweep already clears, so this
 * leaves no permanent row per person. The total itself is a single integer.
 */
function countVisit(browser) {
  write(db, () => {
    const now = Date.now()
    const last = lastAction(browser, 'visit')
    if (now - last < VISIT_GAP_MS) return
    q.countVisit.run()
    q.touchCooldown.run(browser, 'visit', now)
  })
}

const totalVisits = () => Number(q.visits.get()?.value ?? 0)

// ---------------------------------------------------------------- view

function viewWord(w, now) {
  return {
    id: w.id,
    text: w.text,
    version: w.version,
    createdAt: w.createdAt,
    setsAt: w.setsAt,
    isSet: now >= w.setsAt,
    lockedUntil: w.changedAt + WORD_LOCK_MS,
    highlights: w.highlights ?? 0,
  }
}

function viewStory(browser, words = allWords()) {
  const now = Date.now()
  return {
    now,
    windowMs: currentWindowMs(now),
    endingMs: ENDING_MS, // the client flashes a word for this long before it sets
    turnCooldownMs: TURN_COOLDOWN_MS, // so the footer states the real interval
    wordLockMs: WORD_LOCK_MS,
    words: words.map((w) => viewWord(w, now)),
    turn: turnState(browser, now),
    live: liveCount(),
    visits: totalVisits(),
  }
}

// ---------------------------------------------------------------- actions

function append(text, browser) {
  const { token, error } = validateToken(text)
  if (error) return { status: 400, body: { error } }

  return write(db, () => {
    const now = Date.now()
    const turn = turnState(browser, now)
    if (!turn.ready) return { status: 429, body: { error: 'Still on cooldown.', turn } }

    const position = Number(q.nextPosition.get().next)
    q.insertWord.run(randomUUID(), position, token, now, now, now + currentWindowMs(now))
    recordTurn(browser, now)
    return { status: 200, body: viewStory(browser) }
  })
}

/**
 * One conditional UPDATE decides this. Version, deadline and lock are all in the WHERE
 * clause, so nothing can change between the check and the write, and losing costs the
 * caller nothing because the turn is only recorded when the update reports a row.
 */
function replace(id, version, text, browser) {
  const { token, error } = validateToken(text)
  if (error) return { status: 400, body: { error } }

  return write(db, () => {
    const now = Date.now()
    const turn = turnState(browser, now)
    if (!turn.ready) return { status: 429, body: { error: 'Still on cooldown.', turn } }

    const { changes } = q.tryReplace.run({
      text: token,
      now,
      ending: ENDING_MS,
      // Caught at the buzzer. Adding to what is left, rather than resetting to a flat
      // 30s, means a rescue at 9s left buys more than a rescue at 1s left.
      extension: EXTENSION_MS,
      id,
      version,
      lockedBefore: now - WORD_LOCK_MS,
    })

    if (changes === 1) {
      recordTurn(browser, now)
      return { status: 200, body: viewStory(browser) }
    }

    // The decision was already made above. This read only works out what to say.
    return whyReplaceFailed(id, version, token, now)
  })
}

function whyReplaceFailed(id, version, token, now) {
  const row = q.word.get(id)
  if (!row) return { status: 404, body: { error: 'That word is gone.' } }
  const word = fromRow(row)

  const lost = (error) => ({ status: 409, body: { error } })
  if (now >= word.setsAt) return lost('That word is set now.')
  if (now - word.changedAt < WORD_LOCK_MS) {
    const wait = Math.ceil((word.changedAt + WORD_LOCK_MS - now) / 1000)
    return lost(`That word just changed. Try again in ${wait}s.`)
  }
  if (word.version !== version) return lost('Someone changed that word first.')
  if (word.text === token) return { status: 400, body: { error: 'That is the same word.' } }
  return lost('That word could not be changed.')
}

/**
 * Marks a run of set words as worth keeping. Every word in the range gains a point, so
 * two people picking overlapping sentences reinforce the part they agreed on rather than
 * filing two records that never meet.
 */
function highlight(startId, endId, browser) {
  return write(db, () => {
    const now = Date.now()

    if (now - lastAction(browser, 'mark') < HIGHLIGHT_COOLDOWN_MS) {
      return { status: 429, body: { error: 'Slow down a moment.' } }
    }

    const words = allWords()
    const from = words.findIndex((w) => w.id === startId)
    const to = words.findIndex((w) => w.id === endId)
    if (from === -1 || to === -1) return { status: 404, body: { error: 'No such words.' } }

    const [first, end] = from <= to ? [from, to] : [to, from]
    const range = words.slice(first, end + 1)
    if (range.length > HIGHLIGHT_MAX_WORDS) {
      return { status: 400, body: { error: `Highlight ${HIGHLIGHT_MAX_WORDS} words at most.` } }
    }
    if (range.some((w) => now < w.setsAt)) {
      return { status: 409, body: { error: 'Only set words can be highlighted.' } }
    }

    // One point per browser per word, however many times they drag over it.
    const fresh = range.filter((w) => !q.markedAlready.get(w.id, browser))
    if (!fresh.length) return { status: 409, body: { error: 'You already highlighted that.' } }

    for (const word of fresh) {
      q.bumpHighlight.run(word.id)
      q.addMark.run(browser, word.id)
    }
    q.touchCooldown.run(browser, 'mark', now)

    return { status: 200, body: viewStory(browser) }
  })
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function readCookie(req, name) {
  const match = (req.headers.cookie ?? '').match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * Turns a request into one opaque key for the browser. It is an HMAC, so the cookie value
 * never reaches the database, and the cookie itself is a random id with nothing attached
 * to it. There is no account.
 *
 * The address a request came from is deliberately not part of this. Keying on it makes
 * everyone behind one router a single writer. Limiting by address belongs upstream, where
 * it is visible without this having to store anything about it.
 */
function identify(req, res) {
  let id = readCookie(req, 'monkey')
  const returning = Boolean(id) && /^[\w-]{8,64}$/.test(id)
  if (!returning) {
    id = randomUUID()
    res.setHeader('Set-Cookie', `monkey=${id}; Path=/; Max-Age=31536000; SameSite=Lax`)
  }
  return { browser: anonymise(`c:${id}`), returning }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
    if (chunks.reduce((n, c) => n + c.length, 0) > 4096) throw new Error('too big')
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const { browser, returning } = identify(req, res)

  try {
    if (url.pathname === '/api/story' && req.method === 'GET') {
      // The poll is the proof someone is here, but only once they are carrying the
      // cookie we gave them. Otherwise every crawler and curl is a separate reader.
      if (returning) markPresent(browser)
      return json(res, 200, viewStory(browser))
    }

    if (url.pathname === '/api/highlight' && req.method === 'POST') {
      const body = await readBody(req)
      const result = highlight(body.startId, body.endId, browser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/api/turn' && req.method === 'POST') {
      const body = await readBody(req)
      const result = body.id
        ? replace(body.id, body.version, body.text, browser)
        : append(body.text, browser)
      return json(res, result.status, result.body)
    }

    if (url.pathname === '/') countVisit(browser)

    const file = url.pathname === '/' ? '/index.html' : url.pathname
    const path = join(ROOT, 'public', file)
    if (!path.startsWith(join(ROOT, 'public'))) return json(res, 403, { error: 'no' })

    // Read before writing the header, or a missing file leaves us unable to send a 404.
    let body
    try {
      body = readFileSync(path)
    } catch {
      return json(res, 404, { error: 'Not found' })
    }
    // The page itself must never be cached: it carries the story's metadata. Everything
    // it pulls in can be, and should be, or one arrival costs six trips to this process
    // instead of one. Five minutes is short enough that a fix still lands quickly.
    const ext = extname(path)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'text/plain',
      'Cache-Control': ext === '.html' ? 'no-cache, must-revalidate' : 'public, max-age=300',
    })
    res.end(body)
  } catch (err) {
    console.error(err)
    if (res.headersSent) return res.destroy()
    json(res, 500, { error: String(err.message ?? err) })
  }
})

// One bad request should never take the story down. Failing to start is different: that
// has to be loud and non-zero, or a dead server looks like a clean exit.
process.on('uncaughtException', (err) => console.error('uncaught', err))

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Stop the other server, or set PORT.`
      : err,
  )
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`Infinite Monkey  http://localhost:${PORT}`)
  console.log(`${dictionary.size} words in the dictionary`)
  console.log(`${allWords().length} words in the story`)

  // Expired cooldowns are dead weight and the only per-visitor rows that need not persist.
  const clear = () => sweep(db)
  clear()
  setInterval(clear, 10 * 60 * 1000).unref()
})
