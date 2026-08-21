// Infinite Monkey — client.

const storyEl = document.getElementById('story')
const composerEl = document.getElementById('composer')
const inputEl = document.getElementById('input')
const ruleEl = document.getElementById('rule')
const statusEl = document.getElementById('status')
const tipEl = document.getElementById('tip')
const markEl = document.getElementById('mark')
const liveEl = document.getElementById('live-count')
const visitEl = document.getElementById('visit-count')

const PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])
const SENTENCE_END = new Set(['.', '!', '?'])

let state = { words: [], turn: { readyAt: 0, ready: true }, windowMs: 0 }
let clockSkew = 0 // server now minus client now
let editing = null // id of the word being replaced
let message = null // { text, wrong }, cleared on the next successful turn

const now = () => Date.now() + clockSkew

// ---------------------------------------------------------------- rendering

/** Capitalisation is applied here, so nobody ever has to type a capital. */
function display(word, index, words) {
  const previous = words[index - 1]
  const opensSentence = index === 0 || (previous && SENTENCE_END.has(previous.text))
  let text = word.text === 'i' ? 'I' : word.text
  if (opensSentence) text = text[0].toUpperCase() + text.slice(1)
  return text
}

/** Black once set, magenta while it waits out its own cooldown, grey otherwise.
 *  Read from setsAt rather than the server's isSet, which is only as fresh as the
 *  last poll and would leave a word flashing seconds after its deadline passed. */
function stateOf(word) {
  if (now() >= word.setsAt) return 'set'
  return now() < word.lockedUntil ? 'held' : 'open'
}

/** A word about to set flashes, so its last chance is visible without reading a clock. */
function isEnding(word) {
  const left = word.setsAt - now()
  return left > 0 && left <= (state.endingMs ?? 0)
}

const onCooldown = () => now() < state.turn.readyAt

function countdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s left`
  return `${s}s left`
}

/** The bare clock that sits in the input while you wait. */
function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`
}

// Spans are kept and reused, never rebuilt. Replacing an element restarts its CSS
// animation, so a poll would interrupt the flash on any word that was mid-blink.
let wordEls = []
// The space before each word is its own span rather than a bare text node, so a
// highlight can be painted across it and the band does not break at every space.
let gaps = []
let tailGap = null

function resetStory() {
  storyEl.replaceChildren()
  wordEls = []
  gaps = []
  tailGap = null
}

const stillPrefers = matchMedia('(prefers-reduced-motion: reduce)')

/** Holds the line you are writing on at the middle of the screen, so the story grows
 *  upward past you instead of sliding down the page as it gets longer. */
function centreComposer(smooth) {
  composerEl.scrollIntoView({
    block: 'center',
    behavior: smooth && !stillPrefers.matches ? 'smooth' : 'auto',
  })
}

let lastShape = null // only re-centre when the words actually changed

function render() {
  if (editing) return // never redraw underneath an open editor

  // The story is append-only, so the spans we already have should still line up. If they
  // do not, or one was pulled out to be edited, starting over is the safe move.
  const drifted =
    state.words.length < wordEls.length ||
    wordEls.some((el, i) => el.dataset.id !== state.words[i]?.id || !el.isConnected)
  if (drifted) resetStory()

  // New nodes go before the trailing gap, so the composer stays at the end.
  const place = (node) => (tailGap ? storyEl.insertBefore(node, tailGap) : storyEl.append(node))

  state.words.forEach((word, i) => {
    if (!wordEls[i]) {
      if (i > 0) {
        gaps[i] = document.createElement('span')
        gaps[i].className = 'gap'
        place(gaps[i])
      }
      const el = document.createElement('span')
      el.className = 'word'
      el.dataset.id = word.id
      wordEls[i] = el
      place(el)
    }
    // Punctuation hugs the word before it, and that can change when a word is replaced.
    // An empty gap is also no line-break opportunity, which is what we want there.
    if (i > 0) gaps[i].textContent = PUNCTUATION.has(word.text) ? '' : ' '

    const text = display(word, i, state.words)
    if (wordEls[i].textContent !== text) wordEls[i].textContent = text
  })

  // Keeps the composer sitting one space after the last word instead of hard against it.
  if (state.words.length && !tailGap) {
    tailGap = document.createTextNode(' ')
    storyEl.append(tailGap)
  }

  // Re-centre only when the text moved. Doing it every poll would fight anyone who
  // scrolled up to read the older part of the story.
  const shape = state.words.map((w) => w.id + w.text).join('|')
  if (shape !== lastShape) {
    centreComposer(lastShape !== null)
    lastShape = shape
  }

  paint()
  updateStatus()
}

/** Moves words between states every second. Only touches classes, never the nodes. */
function paint() {
  state.words.forEach((word, i) => {
    const el = wordEls[i]
    if (!el) return

    const status = stateOf(word)
    el.classList.toggle('held', status === 'held')
    el.classList.toggle('open', status === 'open')

    // The seconds remaining ride along as an attribute, which CSS prints above the word.
    const ending = status === 'open' && isEnding(word)
    el.classList.toggle('ending', ending)
    if (ending) el.dataset.left = Math.ceil((word.setsAt - now()) / 1000)
    else delete el.dataset.left

    // Deeper wash the more people kept it. Capped, or a popular line goes black.
    const marks = word.highlights ?? 0
    el.classList.toggle('kept', marks > 0)
    if (marks) el.dataset.marks = Math.min(marks, 4)
    else delete el.dataset.marks

    // Fill the space before this word only when the words on both sides are highlighted,
    // so a run reads as one continuous band and stops cleanly at its ends.
    const gap = gaps[i]
    if (i > 0 && gap) {
      const shared = Math.min(state.words[i - 1].highlights ?? 0, marks)
      gap.classList.toggle('kept', shared > 0)
      if (shared) gap.dataset.marks = Math.min(shared, 4)
      else delete gap.dataset.marks
    }
  })
}

function updateStatus() {
  const waiting = onCooldown()
  document.body.classList.toggle('cooldown', waiting)

  // The input stays where it is but goes inert. Your cooldown is announced by the banner
  // at the bottom of the screen instead, so it cannot be mistaken for a word's countdown.
  const wasWaiting = inputEl.disabled
  inputEl.disabled = waiting
  if (wasWaiting && !waiting) inputEl.focus()

  // One slot, two jobs: the rule when you are free, your countdown when you are not.
  const every = Math.round((state.turnCooldownMs ?? 15000) / 1000)
  ruleEl.classList.toggle('waiting', waiting)
  ruleEl.textContent = waiting
    ? `next turn in ${clock(state.turn.readyAt - now())}`
    : `a word or a punctuation mark every ${every} seconds`

  statusEl.classList.toggle('wrong', Boolean(message?.wrong))
  statusEl.textContent = message ? message.text : waiting ? '' : 'your turn'
}

// ---------------------------------------------------------------- turns

async function takeTurn(body) {
  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json()

  if (!response.ok) {
    // A lost race does not consume your turn, so just say what happened.
    message = { text: data.error, wrong: true }
    if (data.turn) state.turn = data.turn
    updateStatus()
    return false
  }

  message = null
  apply(data)
  return true
}

function apply(data) {
  clockSkew = data.now - Date.now()
  state = data
  if (typeof data.live === 'number') liveEl.textContent = data.live.toLocaleString()
  if (typeof data.visits === 'number') visitEl.textContent = data.visits.toLocaleString()
  render()
}

async function poll() {
  try {
    const response = await fetch('/api/story', { cache: 'no-store' })
    if (response.ok) apply(await response.json())
  } catch {
    /* keep showing the last good story */
  }
}

// ---------------------------------------------------------------- appending

// An offscreen span used to measure text. Counting characters and sizing in `ch` does not
// work in a proportional serif: `ch` is the width of a zero, so "wow" gets clipped and
// "ill" gets a hole after it. This measures the actual glyphs.
const ruler = document.createElement('span')
ruler.setAttribute('aria-hidden', 'true')
ruler.style.cssText =
  'position:absolute;top:-9999px;left:-9999px;white-space:pre;pointer-events:none'
document.body.append(ruler)

function measure(el, text) {
  const style = getComputedStyle(el)
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing']) {
    ruler.style[prop] = style[prop]
  }
  ruler.textContent = text
  return ruler.getBoundingClientRect().width
}

/** Sizes an input to its own text. `minText` is the smallest it should ever get. */
function sizeInput(el, minText = '') {
  const width = Math.max(measure(el, el.value), measure(el, minText))
  el.style.width = `${Math.ceil(width) + 2}px` // the 2 is the caret
}

inputEl.addEventListener('input', () => {
  inputEl.value = inputEl.value.toLowerCase()
  sizeInput(inputEl, 'wordier')
  if (message) {
    message = null
    updateStatus()
  }
})

composerEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = inputEl.value.trim()
  if (!text) return
  if (await takeTurn({ text })) {
    inputEl.value = ''
    sizeInput(inputEl, 'wordier')
  }
  inputEl.focus()
})

// ---------------------------------------------------------------- replacing

storyEl.addEventListener('click', (event) => {
  const el = event.target.closest('.word.open')
  if (!el || editing || onCooldown()) return

  const word = state.words.find((w) => w.id === el.dataset.id)
  if (!word) return

  editing = word.id
  hideTip()

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'word-input'
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  input.value = word.text
  el.replaceWith(input)
  sizeInput(input)
  input.focus()
  input.select()

  const stop = () => {
    editing = null
    render()
    inputEl.focus()
  }

  input.addEventListener('input', () => {
    input.value = input.value.toLowerCase()
    sizeInput(input)
  })

  input.addEventListener('blur', stop)

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return stop()
    if (e.key !== 'Enter') return
    e.preventDefault()
    const text = input.value.trim()
    if (!text || text === word.text) return stop()

    input.disabled = true
    const ok = await takeTurn({ id: word.id, version: word.version, text })
    editing = null
    if (!ok) await poll()
    render()
    inputEl.focus()
  })
})

// ---------------------------------------------------------------- highlighting

let pendingRange = null // [startId, endId] of the current selection, if it can be kept

/** Every word the selection touches, even partly. Simpler and more forgiving than
 *  working out which text node an edge landed in. */
function selectedWords() {
  const selection = getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return []
  const range = selection.getRangeAt(0)
  if (!storyEl.contains(range.commonAncestorContainer)) return []
  return state.words.filter((word, i) => wordEls[i] && range.intersectsNode(wordEls[i]))
}

function updateMark() {
  const words = selectedWords()
  const keepable = words.length > 0 && words.every((w) => stateOf(w) === 'set')

  if (!keepable) {
    markEl.hidden = true
    pendingRange = null
    return
  }

  pendingRange = [words[0].id, words[words.length - 1].id]
  const box = getSelection().getRangeAt(0).getBoundingClientRect()
  markEl.hidden = false
  markEl.style.left = `${box.left + box.width / 2}px`
  markEl.style.top = `${box.top}px`
}

// selectionchange rather than mouseup: a phone never fires mouseup for a text selection,
// and on iOS the selection is made and adjusted with drag handles over several seconds.
// The delay waits for the handles to settle before the button appears.
let settling = null
document.addEventListener('selectionchange', () => {
  clearTimeout(settling)
  const selection = getSelection()
  if (!selection || selection.isCollapsed) {
    markEl.hidden = true
    pendingRange = null
    return
  }
  settling = setTimeout(updateMark, 250)
})

// Mouse users get it immediately on release, without waiting out the delay above.
storyEl.addEventListener('mouseup', () => setTimeout(updateMark, 0))

// The range was captured when the selection settled, so it does not matter that tapping
// the button clears the selection on iOS before the click lands.
markEl.addEventListener('click', async () => {
  if (!pendingRange) return
  const [startId, endId] = pendingRange
  markEl.hidden = true

  const response = await fetch('/api/highlight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startId, endId }),
  })
  const data = await response.json()

  if (response.ok) {
    getSelection()?.removeAllRanges()
    apply(data)
  } else {
    message = { text: data.error, wrong: true }
    updateStatus()
  }
})

// ---------------------------------------------------------------- countdowns

storyEl.addEventListener('mouseover', (event) => {
  const el = event.target.closest('.word')
  if (!el) return
  const word = state.words.find((w) => w.id === el.dataset.id)
  if (!word) return

  const box = el.getBoundingClientRect()
  tipEl.hidden = false
  tipEl.style.left = `${box.left + box.width / 2}px`
  tipEl.style.top = `${box.top}px`
  const status = stateOf(word)
  const marks = word.highlights ?? 0
  tipEl.textContent =
    status === 'set'
      ? marks
        ? `highlighted ${marks} ${marks === 1 ? 'time' : 'times'}`
        : 'set'
      : status === 'held'
        ? 'just changed'
        : countdown(word.setsAt - now())
})

storyEl.addEventListener('mouseout', hideTip)
function hideTip() {
  tipEl.hidden = true
}

// ---------------------------------------------------------------- theme

const themeEl = document.getElementById('theme')
const themeLabelEl = document.getElementById('theme-label')
const prefersDark = matchMedia('(prefers-color-scheme: dark)')

/** What the page is showing right now: the reader's choice, or the system's. */
const currentTheme = () =>
  document.documentElement.dataset.theme || (prefersDark.matches ? 'dark' : 'light')

/** The button offers the other one, so it says where you are going, not where you are. */
function labelTheme() {
  themeLabelEl.textContent = currentTheme() === 'dark' ? 'light' : 'dark'
}

themeEl.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem('monkeys.theme', next)
  } catch {
    /* a private window just forgets on the next visit */
  }
  labelTheme()
})

// Follow the system while the reader has not chosen for themselves.
prefersDark.addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) labelTheme()
})

labelTheme()

// ---------------------------------------------------------------- loop

sizeInput(inputEl, 'wordier')
inputEl.focus()
addEventListener('resize', () => centreComposer(false))
poll()
setInterval(poll, 2500)
setInterval(() => {
  if (editing) return
  paint()
  updateStatus()
}, 1000)
