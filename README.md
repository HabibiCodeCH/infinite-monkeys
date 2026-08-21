# infinite monkeys

A shared text that anyone can edit, one word at a time.

Each turn adds one word or one punctuation mark to the end, or replaces one that is
already there. A word stays changeable for ten minutes. After that it sets and can never
be changed again. There are no accounts, no votes and no scores.

## Running it

Node 22 or newer. No dependencies.

```
node build-dictionary.js   # once, downloads and builds the word list
node server.js             # http://localhost:4000
node --test test.js        # 36 tests
node seed.js               # fill the story with an example paragraph
```

## Rules

| | |
|---|---|
| Turn cooldown | 15 seconds per browser |
| A word can change | once every 15 seconds |
| Set window | 10 minutes from when a word is created |
| Flash | the last 10 seconds before setting |
| Buzzer extension | changing a word in those 10 seconds adds 30 seconds |
| Highlighting | set words only, one point per browser per word |

All timings are environment variables (`TURN_COOLDOWN_MS`, `WORD_LOCK_MS`,
`WINDOW_MIN_MS`, `WINDOW_MAX_MS`, `ENDING_MS`, `EXTENSION_MS`, `HIGHLIGHT_COOLDOWN_MS`,
`PRESENCE_MS`, `VISIT_GAP_MS`), which is how the tests run the clock fast.

## Files

| | |
|---|---|
| `server.js` | HTTP server, the rules, the API |
| `db.js` | SQLite schema and the write transaction helper |
| `build-dictionary.js` | builds `data/dictionary.txt` |
| `seed.js` | writes an example story into the database |
| `test.js` | 36 tests, run with `node --test` |
| `public/` | the page, its stylesheet and two client scripts |

## Storage

SQLite through `node:sqlite`, in `data/story.db`. Four tables: `words`, `meta`,
`cooldowns` and `marks`.

Each word row holds its text, a version number, when it was created, when it last changed
and when it sets. The deadline is frozen when the word is created rather than recomputed,
so a countdown does not move while it is on screen.

A replace is a single conditional `UPDATE`. The version, the deadline and the lock are all
in the `WHERE` clause, so there is no gap between checking and writing:

```sql
UPDATE words
   SET text = :text, version = version + 1, changed_at = :now,
       sets_at = CASE WHEN sets_at - :now <= :ending
                      THEN sets_at + :extension ELSE sets_at END
 WHERE id = :id AND version = :version AND sets_at > :now
   AND changed_at <= :lockedBefore AND text <> :text
```

One row changed means the caller won. Anything else means they lost, and their turn is not
spent. Writes run inside `BEGIN IMMEDIATE` and the database is in WAL mode, so more than
one process can serve the same file.

## Identity

A random id in a cookie, put through `createHmac` with a per-install secret before it
reaches the database. It spaces out turns and stops one browser highlighting the same word
twice.

The address a request came from is never read. `HASH_SECRET` sets the secret; without it
one is generated and stored in the database.

## Dictionary

`build-dictionary.js` downloads `words_alpha` and keeps every entry that is letters only,
dropping single letters other than `a` and `i`. That is 370,081 words including proper
nouns. It is not filtered for content.

The server accepts a word only if it is in that list, or is one of `.` `,` `;` `:` `!` `?`.
Everything is stored lowercase; capitals are applied when rendering.

## Counters

`authors online` counts the distinct browsers that polled `/api/story` in the last 12
seconds, held in memory. `visits` is one integer in `meta`, incremented on a page load by a
browser that has not loaded one in the previous 30 minutes.

## API

| | |
|---|---|
| `GET /api/story` | the whole story, the timings, and the caller's turn state |
| `POST /api/turn` | `{text}` to append, `{id, version, text}` to replace |
| `POST /api/highlight` | `{startId, endId}`, set words only |

## Licence

MIT.
