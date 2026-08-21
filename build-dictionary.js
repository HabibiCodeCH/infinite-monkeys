// Builds data/dictionary.txt, the allowlist of everything a person is allowed to type.
// Run with `node build-dictionary.js`.
//
// The list is words_alpha as a whole: 370k English words including proper nouns, so
// "shakespeare", "boston" and "paris" are all writable. Nothing is filtered for taste.
// This is an experiment and the dictionary is not pretending to be a safety system.
//
// The only rules applied are structural, not judgements about words:
//
//   - letters only, which is what keeps out URLs, @handles and digits
//   - single letters are not words, apart from "a" and "i"

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const WORD_LIST = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt'

const response = await fetch(WORD_LIST)
if (!response.ok) throw new Error(`could not fetch ${WORD_LIST}: ${response.status}`)

const kept = []
let dropped = 0
for (const line of (await response.text()).split('\n')) {
  const word = line.trim().toLowerCase()
  if (!/^[a-z]+$/.test(word)) {
    dropped += 1
    continue
  }
  if (word.length === 1 && word !== 'a' && word !== 'i') {
    dropped += 1
    continue
  }
  kept.push(word)
}

const dictionary = [...new Set(kept)].sort()
writeFileSync(join(ROOT, 'data/dictionary.txt'), dictionary.join('\n') + '\n')

console.log(`kept    ${dictionary.length}`)
console.log(`dropped ${dropped} (not letters, or a bare letter)`)

// A smell test, so a broken build is obvious here rather than found by a player.
const present = new Set(dictionary)
const MUST_HAVE = 'the a i gorillas monkeys typewriters shakespeare boston paris walked women'
const MUST_NOT_HAVE = 'asdfgh'
const missing = MUST_HAVE.split(' ').filter((w) => !present.has(w))
const leaked = MUST_NOT_HAVE.split(' ').filter((w) => present.has(w))
if (missing.length) console.log(`MISSING: ${missing.join(', ')}`)
if (leaked.length) console.log(`LEAKED:  ${leaked.join(', ')}`)
if (!missing.length && !leaked.length) console.log('smell test passed')
