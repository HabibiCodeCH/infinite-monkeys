// Fills the story with a paragraph so there is something to look at. Run with
// `node seed.js` while the server is stopped, then start the server.
//
// It backdates the words so all three states are on screen at once: most of the
// paragraph already set, the tail still inside its window, and one word just changed.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, write } from './db.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const WINDOW_MS = 10 * 60 * 1000 // must match WINDOW_MIN_MS / WINDOW_MAX_MS in server.js

// Deliberately uneven. A story with infinitely many authors drifts, contradicts itself
// and repairs the wrong sentence, so the seed should look like it has been through that.
const PARAGRAPH = `the gorillas learned to read on a wednesday in boston and nobody
  thought to write it down until shakespeare arrived carrying nothing but a wet umbrella
  and a list of every word he had already used twice . the librarians disagreed about
  almost everything , but they agreed that the gorillas should be given better chairs .
  one of them , the tall one who never spoke , had been copying out the same paragraph
  for eleven years and had improved it exactly once . nobody could remember which word
  had changed . the argument moved outdoors , where it rained , and the paper went soft
  in every hand . a child asked whether the story was true and three adults
  answered at the same time and none of them agreed . later the tall gorilla wrote a
  single word on the wall near the door and went to sleep . in the morning somebody had
  crossed it out and written a worse one , and that is the version everybody remembers .
  the umbrella was never returned . shakespeare , who had grown tired of being quoted ,
  went home and took up gardening instead , and the paragraph carried on without him ,
  which he later admitted was the point .`

const dictionary = new Set(
  readFileSync(join(ROOT, 'data/dictionary.txt'), 'utf8').split('\n').filter(Boolean),
)
const PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])

const tokens = PARAGRAPH.trim().split(/\s+/)
const rejected = tokens.filter((t) => !dictionary.has(t) && !PUNCTUATION.has(t))
if (rejected.length) throw new Error(`not in the dictionary: ${rejected.join(', ')}`)

const now = Date.now()
const SET_BEFORE = tokens.length - 12 // everything before this is already permanent

// The editable tail is placed right at its deadlines: 10s, 22s, 34s and so on. Words set
// one at a time every 12 seconds, and since the flash lasts 10 of those 12, there is
// almost always one flashing. Roughly two and a half minutes of things happening.
const secondsLeft = (i) => 10 + (i - SET_BEFORE) * 12

const words = tokens.map((text, i) => {
  const createdAt =
    i < SET_BEFORE ? now - 60 * 60 * 1000 : now - (WINDOW_MS - secondsLeft(i) * 1000)
  return {
    id: randomUUID(),
    text,
    version: 1,
    createdAt,
    changedAt: createdAt,
    setsAt: createdAt + WINDOW_MS,
  }
})

// One word changed five seconds ago, so it shows in its cooldown colour.
const justChanged = words[words.length - 4]
justChanged.changedAt = now - 5_000
justChanged.version = 2

const db = open()
write(db, () => {
  // A seed replaces the story rather than adding to it, marks and cooldowns included.
  db.exec('DELETE FROM words')
  db.exec('DELETE FROM marks')
  db.exec('DELETE FROM cooldowns')
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'started_at',
    now - 60 * 60 * 1000,
  )
  const insert = db.prepare(
    `INSERT INTO words (id, position, text, version, created_at, changed_at, sets_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  words.forEach((w, i) => {
    insert.run(w.id, i, w.text, w.version, w.createdAt, w.changedAt, w.setsAt)
  })
})

const set = words.filter((w) => now >= w.setsAt).length
console.log(`${words.length} words: ${set} set, ${words.length - set} still editable`)
console.log(`"${justChanged.text}" is in its own cooldown`)
