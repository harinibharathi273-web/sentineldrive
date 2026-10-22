// Speech and alarm helpers for the spoken alertness check.

const WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7,
  eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
}

// Last number said in a transcript: "uh it's seven" -> 7, "twenty three" -> 23.
// Homophones ("to", "for") only count when nothing better was heard.
export function parseSpokenNumber(text) {
  if (!text) return null
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean)
  const strong = []
  const weak = []
  let tens = null
  const flush = () => {
    if (tens !== null) strong.push(tens)
    tens = null
  }
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      flush()
      strong.push(parseInt(t, 10))
      continue
    }
    if (!(t in WORDS)) continue
    const n = WORDS[t]
    if (['to', 'too', 'for', 'ate', 'oh'].includes(t)) {
      weak.push(n)
      continue
    }
    if (n >= 20 && n % 10 === 0) {
      flush()
      tens = n
    } else if (tens !== null && n < 10) {
      strong.push(tens + n)
      tens = null
    } else {
      flush()
      strong.push(n)
    }
  }
  flush()
  if (strong.length) return strong[strong.length - 1]
  return weak.length ? weak[weak.length - 1] : null
}

export function speak(text, { onEnd, rate = 1 } = {}) {
  if (!('speechSynthesis' in window)) {
    onEnd?.()
    return
  }
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-IN'
  u.rate = rate
  let done = false
  const finish = () => {
    if (!done) {
      done = true
      onEnd?.()
    }
  }
  u.onend = finish
  u.onerror = finish
  setTimeout(finish, 6000) // some browsers never fire onend
  window.speechSynthesis.speak(u)
}

let ctx = null
export function audioContext() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext
    if (!C) return null
    ctx = new C()
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

export function tone(freq, dur = 0.2, vol = 0.35, type = 'square', at = 0) {
  const c = audioContext()
  if (!c) return
  const t = c.currentTime + at
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.value = freq
  g.gain.setValueAtTime(vol, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(c.destination)
  o.start(t)
  o.stop(t + dur + 0.05)
}

let alarmTimer = 0
export function startAlarm() {
  if (alarmTimer) return
  const cycle = () => {
    tone(2000, 0.18, 0.5)
    tone(3200, 0.18, 0.5, 'square', 0.22)
  }
  cycle()
  alarmTimer = setInterval(cycle, 600)
}
export function stopAlarm() {
  clearInterval(alarmTimer)
  alarmTimer = 0
}
