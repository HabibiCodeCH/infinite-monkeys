// The welcome demo. Entirely local: it never touches the story or the server.
//
// It reuses the real .word classes rather than mimicking them, so whatever the story
// looks like, this looks like too. The only lie is the clock.
//
// Stepped by hand rather than on a timer. The captions take real seconds to read, and an
// autoplaying version either raced ahead of the reader or sat there for a minute.

const dialog = document.getElementById('welcome')
const lineEl = document.getElementById('demo-line')
const markEl = document.getElementById('demo-mark')
const wordEl = document.getElementById('demo-word')
const formEl = document.getElementById('demo-form')
const inputEl = document.getElementById('demo-input')
const captionEl = document.getElementById('demo-caption')
const stepEl = document.getElementById('demo-step')
const nextEl = document.getElementById('demo-next')
const goEl = document.getElementById('welcome-go')
const explainEl = document.getElementById('explain')

const SEEN = 'monkeys.welcomed'

/** Private windows and blocked site data both throw, so never let storage break the page. */
const remember = (key, value) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* nothing to do about it */
  }
}
const recall = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// Each step sets the classes the real story would set, then says what that means.
const STEPS = [
  {
    classes: 'word held',
    caption:
      'Magenta: the word has just been added or changed. For 15 seconds nobody can ' +
      'touch it.',
  },
  {
    classes: 'word open',
    editable: true,
    caption:
      'Grey: the word is live. It can be edited for 10 minutes. Try to change it.',
  },
  {
    classes: 'word open ending',
    counting: true,
    caption:
      'Ten seconds before setting, the word flashes. Change it now and it earns another ' +
      'thirty seconds.',
  },
  {
    classes: 'word',
    caption: 'Black: set. Nobody can ever change it again. There is no undo.',
  },
  {
    classes: 'word',
    highlightable: true,
    caption:
      'If you enjoy a passage of the story, select and highlight it. Try it above.',
  },
  {
    classes: 'word',
    caption: "That's it, you're ready to add your words to the story.",
  },
]

let at = -1
let ticker = null
let flash = null

function stopTicker() {
  clearInterval(ticker)
  ticker = null
}

function stopFlash() {
  clearTimeout(flash)
  flash = null
}

function show(index) {
  stopTicker()
  stopFlash()
  closeEditor()
  clearHighlights()
  at = index
  const step = STEPS[index]
  lineEl.classList.toggle('demo-selectable', Boolean(step.highlightable))

  wordEl.className = step.classes
  if (step.marks) wordEl.dataset.marks = step.marks
  else delete wordEl.dataset.marks

  // On the changeable step the word itself becomes the thing you touch, which is the
  // actual gesture the site is built around.
  wordEl.classList.toggle('demo-editable', Boolean(step.editable))

  // The flashing step counts down on its own, so it looks alive while you read it.
  if (step.counting) {
    let left = 9
    wordEl.dataset.left = left
    ticker = setInterval(() => {
      left = left > 1 ? left - 1 : 9
      wordEl.dataset.left = left
    }, 1000)
  } else {
    delete wordEl.dataset.left
  }

  captionEl.textContent = step.caption
  stepEl.textContent = `${index + 1} of ${STEPS.length}`
  nextEl.hidden = index >= STEPS.length - 1
}

function play(word) {
  wordEl.hidden = false
  wordEl.textContent = word
  // The word is in the sentence now, so the box asking for one has done its job.
  formEl.hidden = true
  show(0)
}

// ---------------------------------------------------------------- editing the demo word

let editor = null

function closeEditor() {
  if (!editor) return
  editor.remove()
  editor = null
  wordEl.hidden = false
}

wordEl.addEventListener('click', () => {
  if (!STEPS[at]?.editable || editor) return

  editor = document.createElement('input')
  editor.type = 'text'
  editor.className = 'demo-input demo-swap'
  editor.spellcheck = false
  editor.setAttribute('autocapitalize', 'off')
  editor.value = wordEl.textContent.trim().toLowerCase()
  wordEl.after(editor)
  wordEl.hidden = true
  editor.focus()
  editor.select()

  // Changing a word really does send it back to magenta, so the demo does the same. It
  // is the one place the loop is visible: change, lock, open again.
  const commit = () => {
    const word = editor.value.trim().toLowerCase()
    if (word) wordEl.textContent = word
    closeEditor()

    wordEl.className = 'word held'
    captionEl.textContent =
      'You changed it, so it locks. Magenta again for 15 seconds, and nobody can touch ' +
      'it in the meantime.'

    stopFlash()
    flash = setTimeout(() => {
      wordEl.className = 'word open demo-editable'
      captionEl.textContent =
        'And back to grey. Anyone can change it again, you included, for as long as it ' +
        'stays grey.'
    }, 2200)
  }

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
    if (e.key === 'Escape') closeEditor()
  })
  editor.addEventListener('blur', closeEditor)
})

formEl.addEventListener('submit', (event) => {
  event.preventDefault()
  const word = inputEl.value.trim().toLowerCase()
  if (!word) return
  inputEl.value = ''
  play(word)
})

nextEl.addEventListener('click', () => {
  if (at < STEPS.length - 1) show(at + 1)
})

// ---------------------------------------------------------------- highlighting the demo

/** Every word span the selection touches, even partly. Same rule as the real page. */
function selectedWords() {
  const selection = getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return []
  const range = selection.getRangeAt(0)
  if (!lineEl.contains(range.commonAncestorContainer)) return []
  return [...lineEl.querySelectorAll('.word')].filter(
    (el) => !el.hidden && range.intersectsNode(el),
  )
}

// The words are captured when the selection settles, not when the button is tapped,
// because iOS clears the selection before the click arrives.
let pending = []

function hideMark() {
  markEl.hidden = true
  pending = []
}

function offerMark() {
  if (!STEPS[at]?.highlightable) return hideMark()
  const words = selectedWords()
  if (!words.length) return hideMark()

  pending = words
  const box = getSelection().getRangeAt(0).getBoundingClientRect()
  markEl.hidden = false
  markEl.style.left = `${box.left + box.width / 2}px`
  markEl.style.top = `${box.top}px`
}

// A phone never fires mouseup for a text selection, and the drag handles take a few
// seconds to settle, so wait for them. Mouse users get it at once on release.
let settling = null
document.addEventListener('selectionchange', () => {
  clearTimeout(settling)
  const selection = getSelection()
  if (!selection || selection.isCollapsed) return
  settling = setTimeout(offerMark, 250)
})

lineEl.addEventListener('mouseup', () => setTimeout(offerMark, 0))

markEl.addEventListener('click', () => {
  const words = pending
  hideMark()
  if (!words.length) return

  for (const el of words) {
    const marks = Math.min(4, Number(el.dataset.marks ?? 0) + 1)
    el.classList.add('kept')
    el.dataset.marks = marks
  }

  // Fill a gap only when the words on both sides are kept, so a run reads as one band.
  for (const gap of lineEl.querySelectorAll('.dgap')) {
    const before = gap.previousElementSibling
    const after = gap.nextElementSibling
    const shared = Math.min(
      Number(before?.dataset.marks ?? 0),
      after?.hidden ? 0 : Number(after?.dataset.marks ?? 0),
    )
    gap.classList.toggle('kept', shared > 0)
    if (shared) gap.dataset.marks = shared
    else delete gap.dataset.marks
  }

  getSelection()?.removeAllRanges()
  captionEl.textContent =
    'The more a passage gets highlighted, the more its colour deepens.'
})

/** Clears every highlight, so the step starts clean each time you reach it. */
function clearHighlights() {
  hideMark()
  for (const el of lineEl.querySelectorAll('.kept')) {
    el.classList.remove('kept')
    delete el.dataset.marks
  }
}

function open() {
  dialog.showModal()
  inputEl.focus()
}

function close() {
  stopTicker()
  dialog.close()
  remember(SEEN, '1')
}

goEl.addEventListener('click', close)
explainEl.addEventListener('click', open)
dialog.addEventListener('close', () => {
  stopTicker()
  remember(SEEN, '1')
})

if (!recall(SEEN)) open()
