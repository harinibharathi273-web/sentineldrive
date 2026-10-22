// node tests/test_signals.mjs
import assert from 'node:assert/strict'
import { EYES, eyeEAR, earFromLandmarks, headPitchRatio, FatigueTracker, combineFatigue, tierForScore } from '../src/lib/fatigue.js'
import { analyzeSpectrum, classifySiren, LevelTracker, rmsDbfs } from '../src/lib/siren.js'

let failed = 0
const test = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}\n     ${e.message}`)
  }
}

// ---------- synthetic face ----------
// Eye corners on y=0.45; lids open by `gap`; nose and chin positions set by pitch.
function face({ gap = 0.03, noseDy = 0.12, chinDy = 0.32 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }))
  const eye = ([p1, p2, p3, p4, p5, p6], x0) => {
    lm[p1] = { x: x0, y: 0.45 }
    lm[p4] = { x: x0 + 0.1, y: 0.45 }
    lm[p2] = { x: x0 + 0.033, y: 0.45 - gap / 2 }
    lm[p3] = { x: x0 + 0.066, y: 0.45 - gap / 2 }
    lm[p6] = { x: x0 + 0.033, y: 0.45 + gap / 2 }
    lm[p5] = { x: x0 + 0.066, y: 0.45 + gap / 2 }
  }
  eye(EYES.left, 0.3)
  eye(EYES.right, 0.6)
  lm[1] = { x: 0.5, y: 0.45 + noseDy }
  lm[152] = { x: 0.5, y: 0.45 + chinDy }
  return lm
}

test('EAR pairs the right lid points', () => {
  assert.ok(Math.abs(eyeEAR(face({ gap: 0.03 }), EYES.left) - 0.3) < 1e-9)
  assert.ok(earFromLandmarks(face({ gap: 0.005 })) < 0.06)
})

test('head pitch ratio rises when the head tips forward', () => {
  // Orthographic model: looking down 30° moves the nose down and chin up.
  const upright = headPitchRatio(face({ noseDy: 0.04 * 3, chinDy: 0.32 }))
  const down = headPitchRatio(face({ noseDy: 0.155, chinDy: 0.277 }))
  const up = headPitchRatio(face({ noseDy: 0.065, chinDy: 0.277 }))
  assert.ok(down > upright * 1.4, `down ${down} upright ${upright}`)
  assert.ok(up < upright)
})

function run(tracker, from, to, frame, fps = 30) {
  for (let t = from; t < to; t += 1000 / fps) tracker.push({ t, ear: earFromLandmarks(frame(t)), pitch: headPitchRatio(frame(t)) })
}

test('calibrates to the driver in 5 s', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 3000, () => face())
  assert.equal(tr.summary(3000).calibrated, false)
  run(tr, 3000, 5200, () => face())
  const s = tr.summary(5200)
  assert.ok(s.calibrated)
  assert.ok(Math.abs(s.earThreshold - 0.3 * 0.72) < 0.01)
  assert.equal(s.tier, 'normal')
})

test('narrow-eyed driver is not flagged (threshold is personal)', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 30000, () => face({ gap: 0.018 })) // EAR 0.18 — the old fixed 0.18 threshold would call this "closed"
  assert.equal(tr.summary(30000).score, 0)
})

test('blinks are counted, not treated as drowsiness', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 30000, (t) => (t > 6000 && t % 3000 < 150 ? face({ gap: 0.004 }) : face()))
  const s = tr.summary(30000)
  assert.ok(s.blinkRate >= 15 && s.blinkRate <= 25, `blink rate ${s.blinkRate}`)
  assert.ok(s.score < 2, `score ${s.score}`)
  assert.equal(s.microsleeps, 0)
})

test('a 4 s eye closure is a microsleep and goes critical', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 10000, () => face())
  run(tr, 10000, 14000, () => face({ gap: 0.004 }))
  const s = tr.summary(14000)
  assert.equal(s.microsleeps, 1)
  assert.equal(s.tier, 'critical', JSON.stringify(s))
})

test('sustained head droop raises the score', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 10000, () => face())
  run(tr, 10000, 14000, () => face({ noseDy: 0.155, chinDy: 0.277 }))
  const s = tr.summary(14000)
  assert.ok(s.droopMs >= 3500)
  assert.ok(s.score >= 5, `score ${s.score}`)
})

test('missing face does not count as closed eyes', () => {
  const tr = new FatigueTracker()
  run(tr, 0, 10000, () => face())
  for (let t = 10000; t < 20000; t += 33) tr.push({ t, ear: null, pitch: null })
  const s = tr.summary(20000)
  assert.equal(s.face, false)
  assert.ok(s.score < 1)
})

test('score tiers', () => {
  assert.equal(tierForScore(4.9), 'normal')
  assert.equal(tierForScore(5), 'elevated')
  assert.equal(tierForScore(8), 'critical')
  assert.equal(combineFatigue({ perclos: 0.2 }).score, 5)
})

// ---------- siren ----------
const SR = 48000
const FFT = 2048
const BIN = SR / FFT
function spectrum(toneHz, { level = -40, rnd = Math.random } = {}) {
  const s = new Float32Array(FFT / 2)
  for (let i = 0; i < s.length; i++) s[i] = -95 + rnd() * 6
  if (toneHz) {
    const b = toneHz / BIN
    for (let i = Math.floor(b) - 2; i <= Math.ceil(b) + 2; i++) s[i] = Math.max(s[i], level - 9 * Math.abs(i - b) ** 2)
  }
  return s
}
function seq(fn, ms = 4500, step = 60) {
  const h = []
  for (let t = 0; t <= ms; t += step) {
    const hz = fn(t)
    h.push({ t, ...analyzeSpectrum(spectrum(hz), SR, FFT) })
  }
  return h
}

test('spectrum peak frequency is accurate', () => {
  const a = analyzeSpectrum(spectrum(1012), SR, FFT)
  assert.ok(Math.abs(a.dominantHz - 1012) < 6, a.dominantHz)
  assert.ok(a.tonal)
  assert.equal(analyzeSpectrum(spectrum(null), SR, FFT).tonal, false)
})

test('wail siren detected', () => {
  const r = classifySiren(seq((t) => 950 + 400 * Math.sin((2 * Math.PI * t) / 3000)))
  assert.ok(r.siren, JSON.stringify(r))
  assert.equal(r.pattern, 'wail')
})

test('yelp siren detected', () => {
  const r = classifySiren(seq((t) => 950 + 400 * Math.sin((2 * Math.PI * t) / 230)))
  assert.ok(r.siren, JSON.stringify(r))
})

test('hi-lo siren detected', () => {
  const r = classifySiren(seq((t) => (Math.floor(t / 600) % 2 ? 1100 : 750)))
  assert.ok(r.siren, JSON.stringify(r))
  assert.equal(r.pattern, 'hi-lo')
})

test('steady horn rejected', () => {
  assert.equal(classifySiren(seq(() => 620)).siren, false)
})

test('broadband traffic noise rejected', () => {
  assert.equal(classifySiren(seq(() => null)).siren, false)
})

test('a one-second blip is not a siren', () => {
  const h = seq((t) => 950 + 400 * Math.sin((2 * Math.PI * t) / 600), 1000)
  assert.equal(classifySiren(h).siren, false)
})

// ---------- impact sound ----------
test('loud bang produces a large jump over cabin level', () => {
  const lt = new LevelTracker()
  for (let t = 0; t < 5000; t += 50) lt.push(t, -45 + Math.sin(t) * 2)
  lt.push(5000, -8)
  const s = lt.snapshot(5100)
  assert.ok(s.jump_db > 30, JSON.stringify(s))
  assert.ok(Math.abs(rmsDbfs(new Float32Array(100).fill(0.5)) - -6.02) < 0.01)
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
