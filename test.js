// Rule tests. Run with `node --test test.js`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const running = []

/** Starts a server on its own port with its own story file, and returns a client for it. */
/** Pass an existing dbPath to attach a second process, or restart, on the same story. */
async function startServer(port, env = {}, dbPath = null) {
  const fresh = !dbPath
  const path = dbPath ?? join(ROOT, `data/story.test-${port}.db`)
  // WAL leaves -wal and -shm siblings, so every one has to go or a test inherits state.
  const files = [path, `${path}-wal`, `${path}-shm`]
  if (fresh) for (const f of files) rmSync(f, { force: true })

  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: path, ...env },
    stdio: 'ignore',
  })
  running.push({ child, files: fresh ? files : [] })

  const base = `http://localhost:${port}`
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${base}/api/story`)
      return {
        base,
        child,
        dbPath: path,
        story: () => fetch(`${base}/api/story`).then((r) => r.json()),
        // One cookie per person: that is the whole identity.
        person: (name) => async (body) => {
          const response = await fetch(`${base}/api/turn`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: `monkey=person-${name}`,
            },
            body: JSON.stringify(body),
          })
          return { status: response.status, data: await response.json() }
        },
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`server on ${port} did not start`)
}

// The main server runs with the word lock off, so version conflicts are reachable.
let main
before(async () => {
  main = await startServer(4111, { WORD_LOCK_MS: '0' })
})

after(() => {
  for (const { child, files } of running) {
    child.kill()
    for (const f of files) rmSync(f, { force: true })
  }
})

test('a request for a missing file 404s instead of killing the server', async () => {
  // The browser asks for /favicon.ico on every visit, so this path is not hypothetical.
  assert.equal((await fetch(`${main.base}/favicon.ico`)).status, 404)
  assert.equal((await fetch(`${main.base}/nope.js`)).status, 404)
  assert.equal((await fetch(`${main.base}/`)).status, 200, 'the server is still up')
})

test('the story is not reachable outside the public directory', async () => {
  const escape = await fetch(`${main.base}/../server.js`, { redirect: 'manual' })
  assert.ok(escape.status === 403 || escape.status === 404, `got ${escape.status}`)
  assert.equal((await fetch(`${main.base}/`)).status, 200, 'the server is still up')
})

test('only letters, so no urls, handles or digits get in', async () => {
  const a = main.person('a')
  assert.equal((await a({ text: 'asdfghjkl' })).status, 400, 'not a word')
  assert.equal((await a({ text: 'https://evil.com' })).status, 400, 'urls')
  assert.equal((await a({ text: '@handle' })).status, 400, 'handles')
  assert.equal((await a({ text: 'two words' })).status, 400, 'multiple words')
  assert.equal((await a({ text: 'monkey' })).status, 200)
})

test('proper nouns are allowed on purpose', async () => {
  assert.equal((await main.person('p')({ text: 'shakespeare' })).status, 200)
  assert.equal((await main.person('q')({ text: 'boston' })).status, 200)
})

test('no digits, so phone numbers and addresses are impossible', async () => {
  const b = main.person('b')
  assert.equal((await b({ text: '5551234' })).status, 400)
  assert.match((await b({ text: 'h4ck' })).data.error, /digits/)
})

test('a punctuation mark counts as a token', async () => {
  assert.equal((await main.person('c')({ text: '.' })).status, 200)
})

test('nobody ever types a capital', async () => {
  const { data } = await main.person('d')({ text: 'Banana' })
  assert.equal(data.words.at(-1).text, 'banana')
})

test('one turn per person per cooldown', async () => {
  const e = main.person('e')
  assert.equal((await e({ text: 'ripe' })).status, 200)
  const second = await e({ text: 'yellow' })
  assert.equal(second.status, 429)
  assert.ok(second.data.turn.readyAt > Date.now())
})

test('an office shares one connection but still writes as three people', async () => {
  // The address is not part of the cooldown, so three colleagues on one router get
  // three separate turns.
  const s = await startServer(4134, { WORD_LOCK_MS: '0' })
  const desk = (cookie, text) =>
    fetch(`${s.base}/api/turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `monkey=person-${cookie}`,
        // Same address for all three, to prove it plays no part.
        'X-Forwarded-For': '203.0.113.7',
      },
      body: JSON.stringify({ text }),
    }).then((r) => r.status)

  assert.equal(await desk('aaa', 'thunder'), 200)
  assert.equal(await desk('bbb', 'silence'), 200, 'the second colleague is not blocked')
  assert.equal(await desk('ccc', 'jungle'), 200, 'nor the third')

  // The cookie is still the identity, so one of them cannot take two turns at once.
  assert.equal(await desk('aaa', 'again'), 429, 'the first is on their own cooldown')
})

test('cooldown is per person, not global', async () => {
  assert.equal((await main.person('f')({ text: 'jungle' })).status, 200)
  assert.equal((await main.person('g')({ text: 'quiet' })).status, 200)
})

test('a stale version loses, and losing does not consume your turn', async () => {
  const h = main.person('h')
  const target = (await main.story()).words[0]

  const stale = await h({ id: target.id, version: target.version + 99, text: 'desert' })
  assert.equal(stale.status, 409)
  assert.match(stale.data.error, /changed that word first/)

  // h never spent a turn, so h can still append.
  assert.equal((await h({ text: 'silent' })).status, 200)
})

test('a winning replace bumps the version and keeps the story the same length', async () => {
  const target = (await main.story()).words[0]
  const before = (await main.story()).words.length

  const won = await main.person('i')({ id: target.id, version: target.version, text: 'moon' })
  assert.equal(won.status, 200)

  const after = (await main.story()).words
  assert.equal(after.length, before, 'replacing never changes the length')
  assert.equal(after[0].text, 'moon')
  assert.equal(after[0].version, target.version + 1)
})

test('a missing word is reported, not created', async () => {
  const gone = await main.person('j')({ id: 'nope', version: 1, text: 'moon' })
  assert.equal(gone.status, 404)
})

test('the story only grows', async () => {
  const before = (await main.story()).words.length
  await main.person('k')({ text: 'grows' })
  assert.equal((await main.story()).words.length, before + 1)
})

test('every word gets a flat ten minutes', async () => {
  assert.equal((await main.story()).windowMs, 10 * 60 * 1000)
})

test('a word is open to forty rewrites before it sets', async () => {
  // Ten minutes of window divided by a fifteen second lock. Derived from the two values
  // rather than written down, so it cannot drift when either of them changes.
  // Its own server, because the main one runs with the lock switched off.
  const plain = await startServer(4135)
  const { windowMs, wordLockMs } = await plain.story()
  assert.equal(Math.floor(windowMs / wordLockMs), 40)
})

// The default is flat, so these two widen the clamps to keep the rate sizing covered.
const WIDE = { WINDOW_MIN_MS: '1000', WINDOW_MAX_MS: '3600000' }

test('with room to move, a busy story gets a shorter window than a quiet one', async () => {
  const quiet = await startServer(4112, WIDE)
  await quiet.person('a')({ text: 'alone' })

  const busy = await startServer(4115, WIDE)
  const words = ['alone', 'quiet', 'moon', 'stone', 'sand', 'forest', 'jungle', 'desert']
  await Promise.all(words.map((w, i) => busy.person(String.fromCharCode(97 + i))({ text: w })))

  const quietWindow = (await quiet.story()).windowMs
  const busyWindow = (await busy.story()).windowMs
  assert.ok(busyWindow < quietWindow, `busy ${busyWindow} should be under quiet ${quietWindow}`)
})

test('an empty story gets the ceiling window', async () => {
  const empty = await startServer(4116, WIDE)
  assert.equal((await empty.story()).windowMs, 3_600_000)
})

test('every word carries its own frozen deadline and version', async () => {
  const { words } = await main.story()
  assert.ok(words.length > 0)
  for (const w of words) {
    assert.ok(w.setsAt > w.createdAt, 'setsAt must be after createdAt')
    assert.equal(typeof w.version, 'number')
  }
})

test('a word cannot change again straight after it changed', async () => {
  const locked = await startServer(4113) // default 20s lock
  const { data } = await locked.person('a')({ text: 'jungle' })
  const fresh = data.words.at(-1)

  const attempt = await locked.person('b')({ id: fresh.id, version: fresh.version, text: 'forest' })
  assert.equal(attempt.status, 409)
  assert.match(attempt.data.error, /just changed/)
})

test('saving a word at the buzzer buys it another thirty seconds', async () => {
  // A 12 second window, so a word is inside its last 10 seconds almost immediately.
  const brief = await startServer(4117, {
    WINDOW_MIN_MS: '12000',
    WINDOW_MAX_MS: '12000',
    WORD_LOCK_MS: '0',
  })
  const { data } = await brief.person('a')({ text: 'doomed' })
  const before = data.words.at(-1)

  await new Promise((r) => setTimeout(r, 3000)) // ~9s left, inside the ending window
  const saved = await brief.person('b')({ id: before.id, version: before.version, text: 'saved' })
  assert.equal(saved.status, 200)

  const after = saved.data.words.at(-1)
  assert.equal(after.setsAt, before.setsAt + 30_000, 'should have gained exactly 30s')
  assert.equal(after.text, 'saved')
})

test('a word edited well before its deadline gains nothing', async () => {
  const roomy = await startServer(4118, {
    WINDOW_MIN_MS: '600000',
    WINDOW_MAX_MS: '600000',
    WORD_LOCK_MS: '0',
  })
  const { data } = await roomy.person('a')({ text: 'early' })
  const before = data.words.at(-1)

  const edited = await roomy.person('b')({ id: before.id, version: before.version, text: 'later' })
  assert.equal(edited.status, 200)
  assert.equal(edited.data.words.at(-1).setsAt, before.setsAt, 'deadline should not move')
})

// ---------------------------------------------------------------- counting heads

test('a page load counts as a visit, a reload within the gap does not', async () => {
  const s = await startServer(4131)
  const load = (cookie) => fetch(`${s.base}/`, { headers: { Cookie: `monkey=${cookie}` } })

  assert.equal((await s.story()).visits, 0, 'an api poll is not a visit')

  await load('person-aaa')
  await load('person-aaa')
  await load('person-aaa')
  assert.equal((await s.story()).visits, 1, 'one browser reloading is still one visit')

  await load('person-bbb')
  assert.equal((await s.story()).visits, 2, 'a different browser is a second visit')
})

test('coming back after the gap counts again', async () => {
  const s = await startServer(4133, { VISIT_GAP_MS: '400' })
  const load = () => fetch(`${s.base}/`, { headers: { Cookie: 'monkey=person-aaa' } })

  await load()
  await load()
  assert.equal((await s.story()).visits, 1)

  await new Promise((r) => setTimeout(r, 600))
  await load()
  assert.equal((await s.story()).visits, 2)
})

test('the live count is per browser and expires', async () => {
  const s = await startServer(4132, { PRESENCE_MS: '700' })
  const poll = (cookie) =>
    fetch(`${s.base}/api/story`, { headers: { Cookie: `monkey=${cookie}` } }).then((r) => r.json())

  await poll('person-aaa')
  await poll('person-bbb')
  assert.equal((await poll('person-ccc')).live, 3)
  assert.equal((await poll('person-aaa')).live, 3, 'polling twice is still one reader')

  await new Promise((r) => setTimeout(r, 900))
  assert.equal((await poll('person-ddd')).live, 1, 'the other three went quiet')
})

// ---------------------------------------------------------------- the store
//
// These three exist because none of the tests above would notice if the conditional
// update went back to being a read followed by a write.

test('exactly one of twenty simultaneous replaces wins', async () => {
  const s = await startServer(4126, { WORD_LOCK_MS: '0', TURN_COOLDOWN_MS: '0' })
  await s.person('a')({ text: 'contested' })
  const target = (await s.story()).words[0]

  // Real words, because `word1` would be rejected for having a digit long before it
  // ever reached the conditional update, and the race would go untested.
  const tries = `thunder silence gorillas paper stone forest jungle desert moon quiet
    umbrella chairs rain morning window garden ladder harbour whisper anchor`.split(/\s+/)

  // All twenty send the same version, so nineteen must be turned away.
  const results = await Promise.all(
    tries.map((text, i) =>
      s.person(`racer-${i}`)({ id: target.id, version: target.version, text }),
    ),
  )
  const won = results.filter((r) => r.status === 200)

  assert.equal(won.length, 1, `${won.length} writers won, should be exactly 1`)
  assert.ok(
    results.filter((r) => r.status === 409).length === 19,
    'the other nineteen should all be told they lost',
  )

  const after = (await s.story()).words
  assert.equal(after.length, 1, 'a race must not duplicate the word')
  assert.equal(after[0].version, target.version + 1, 'the version moves by exactly one')
})

test('two processes on one story do not both win the same word', async () => {
  const one = await startServer(4127, { WORD_LOCK_MS: '0', TURN_COOLDOWN_MS: '0' })
  const two = await startServer(4128, { WORD_LOCK_MS: '0', TURN_COOLDOWN_MS: '0' }, one.dbPath)

  await one.person('a')({ text: 'shared' })
  const target = (await two.story()).words[0]
  assert.ok(target, 'the second process should see the first process write')

  const results = await Promise.all([
    one.person('x')({ id: target.id, version: target.version, text: 'thunder' }),
    two.person('y')({ id: target.id, version: target.version, text: 'silence' }),
  ])
  assert.equal(results.filter((r) => r.status === 200).length, 1, 'only one process wins')

  const [a, b] = await Promise.all([one.story(), two.story()])
  assert.deepEqual(
    a.words.map((w) => [w.text, w.version]),
    b.words.map((w) => [w.text, w.version]),
    'both processes must agree on the story',
  )
})

test('who highlighted what survives a restart', async () => {
  const first = await frozenStory(4129)
  const { words } = await first.story()
  assert.equal((await first.mark('keen', '10.4.0.1', words[0].id, words[2].id)).status, 200)

  first.child.kill()
  await new Promise((r) => setTimeout(r, 300))
  const second = await startServer(4130, { HIGHLIGHT_COOLDOWN_MS: '0' }, first.dbPath)
  const again = await fetch(`${second.base}/api/highlight`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'monkey=person-keen',
      'X-Forwarded-For': '10.4.0.1', // same person, so the dedupe must recognise them
    },
    body: JSON.stringify({ startId: words[0].id, endId: words[2].id }),
  }).then(async (r) => ({ status: r.status, data: await r.json() }))
  assert.equal(again.status, 409, 'the restart must not hand out a second vote')
  assert.match(again.data.error, /already highlighted/)
  assert.deepEqual(
    (await second.story()).words.slice(0, 3).map((w) => w.highlights),
    [1, 1, 1],
    'the counts must survive too',
  )
})

// ---------------------------------------------------------------- highlighting

/** A story where every word is already set, so all of it can be highlighted. */
async function frozenStory(port) {
  const server = await startServer(port, {
    WINDOW_MIN_MS: '400',
    WINDOW_MAX_MS: '400',
    WORD_LOCK_MS: '0',
    TURN_COOLDOWN_MS: '0',
    HIGHLIGHT_COOLDOWN_MS: '0',
  })
  for (const w of ['paper', 'went', 'soft', 'in', 'every', 'hand']) {
    await server.person('a')({ text: w })
  }
  await new Promise((r) => setTimeout(r, 600))
  // The cookie has to be at least 8 characters or the server treats it as junk and
  // issues a fresh id, which would silently leave every test person unidentified.
  server.mark = (name, _unused, startId, endId) =>
    fetch(`${server.base}/api/highlight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `monkey=person-${name}`,
      },
      body: JSON.stringify({ startId, endId }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }))
  return server
}

const marks = (words) => words.map((w) => w.highlights)

test('highlighting a range gives every word in it a point', async () => {
  const s = await frozenStory(4119)
  const { words } = await s.story()
  assert.equal((await s.mark('reader', '10.1.0.1', words[1].id, words[3].id)).status, 200)
  assert.deepEqual(marks((await s.story()).words), [0, 1, 1, 1, 0, 0])
})

test('overlapping highlights add up on the words they share', async () => {
  const s = await frozenStory(4120)
  const { words } = await s.story()
  await s.mark('one', '10.1.0.1', words[0].id, words[3].id)
  await s.mark('two', '10.1.0.2', words[2].id, words[5].id)
  assert.deepEqual(
    marks((await s.story()).words),
    [1, 1, 2, 2, 1, 1],
    'the shared middle should be the darkest run',
  )
})

test('one person cannot highlight the same words twice', async () => {
  const s = await frozenStory(4121)
  const { words } = await s.story()
  await s.mark('keen', '10.1.0.1', words[0].id, words[2].id)

  const again = await s.mark('keen', '10.1.0.1', words[0].id, words[2].id)
  assert.equal(again.status, 409)
  assert.match(again.data.error, /already highlighted/)
  assert.deepEqual(marks((await s.story()).words).slice(0, 3), [1, 1, 1])
})

test('a partly overlapping second try only counts the new words', async () => {
  const s = await frozenStory(4122)
  const { words } = await s.story()
  await s.mark('keen', '10.1.0.1', words[0].id, words[2].id)
  assert.equal((await s.mark('keen', '10.1.0.1', words[1].id, words[4].id)).status, 200)
  assert.deepEqual(
    marks((await s.story()).words),
    [1, 1, 1, 1, 1, 0],
    'no word should reach 2 from one person',
  )
})

test('a backwards selection is read the same as a forwards one', async () => {
  const s = await frozenStory(4125)
  const { words } = await s.story()
  assert.equal((await s.mark('reader', '10.1.0.1', words[3].id, words[1].id)).status, 200)
  assert.deepEqual(marks((await s.story()).words), [0, 1, 1, 1, 0, 0])
})

test('words that are still editable cannot be highlighted', async () => {
  const s = await startServer(4123, { HIGHLIGHT_COOLDOWN_MS: '0', TURN_COOLDOWN_MS: '0' })
  await s.person('a')({ text: 'still' })
  await s.person('a')({ text: 'moving' })
  const { words } = await s.story()

  const attempt = await fetch(`${s.base}/api/highlight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'monkey=reader' },
    body: JSON.stringify({ startId: words[0].id, endId: words[1].id }),
  })
  assert.equal(attempt.status, 409)
  assert.match((await attempt.json()).error, /Only set words/)
})

test('a highlight never costs you a writing turn', async () => {
  const s = await frozenStory(4124)
  const { words } = await s.story()
  await s.mark('reader', '10.1.0.9', words[0].id, words[1].id)
  assert.equal((await s.person('reader')({ text: 'onward' })).status, 200)
})

test('a set word can never change again', async () => {
  // A one-second window means everything is permanent almost immediately.
  const brief = await startServer(4114, { WINDOW_MIN_MS: '1000', WINDOW_MAX_MS: '1000', WORD_LOCK_MS: '0' })
  const { data } = await brief.person('a')({ text: 'stone' })
  const word = data.words.at(-1)

  await new Promise((r) => setTimeout(r, 1200))
  assert.equal((await brief.story()).words[0].isSet, true)

  const attempt = await brief.person('b')({ id: word.id, version: word.version, text: 'sand' })
  assert.equal(attempt.status, 409)
  assert.match(attempt.data.error, /set now/)
})
