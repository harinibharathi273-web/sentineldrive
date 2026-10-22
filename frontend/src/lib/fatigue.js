// Driver alertness from MediaPipe face landmarks. Pure functions + a small
// state machine; no browser APIs, so it is unit-tested in Node.
//
// Signals
//   EAR (eye aspect ratio)  — how open the eyes are. Closed when it falls below
//                             a threshold calibrated to THIS driver's open eyes.
//   PERCLOS                 — share of the last 60 s with eyes closed.
//   Head droop              — nose-to-eyes vs nose-to-chin ratio. It grows as
//                             the head tips forward (chin to chest), compared
//                             against the driver's own upright baseline.
//   Blink rate, microsleeps — closures of <0.5 s and of >1.5 s.

// MediaPipe Face Mesh indices in the classic 6-point EAR order
// [p1 corner, p2 upper, p3 upper, p4 corner, p5 lower, p6 lower];
// vertical pairs are p2–p6 and p3–p5.
export const EYES = {
  left: [33, 160, 158, 133, 153, 144],
  right: [362, 385, 387, 263, 373, 380],
}
const NOSE_TIP = 1
const CHIN = 152
const EYE_CORNERS = [33, 133, 362, 263]

export const PERCLOS_WINDOW_MS = 60_000
export const CALIBRATION_MS = 5_000
export const BLINK_MAX_MS = 500
export const MICROSLEEP_MS = 1_500
export const DROOP_SUSTAIN_MS = 1_500

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d

function quantile(arr, q) {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  const i = clamp(Math.round(q * (s.length - 1)), 0, s.length - 1)
  return s[i]
}

export function eyeEAR(lm, [p1, p2, p3, p4, p5, p6]) {
  const h = dist(lm[p1], lm[p4])
  if (h < 1e-6) return 0
  return (dist(lm[p2], lm[p6]) + dist(lm[p3], lm[p5])) / (2 * h)
}

export function earFromLandmarks(lm) {
  return (eyeEAR(lm, EYES.left) + eyeEAR(lm, EYES.right)) / 2
}

// Rises when the head tips forward: the nose tip (which sticks out towards the
// camera) drops relative to the eyes while the chin tucks in.
export function headPitchRatio(lm) {
  const eyeY = EYE_CORNERS.reduce((s, i) => s + lm[i].y, 0) / EYE_CORNERS.length
  const noseY = lm[NOSE_TIP].y
  const chinY = lm[CHIN].y
  return (noseY - eyeY) / Math.max(1e-6, chinY - noseY)
}

export function tierForScore(s) {
  return s >= 8 ? 'critical' : s >= 5 ? 'elevated' : 'normal'
}

// PERCLOS 0.08 → 2, 0.20 → 5, 0.32 → 8, 0.40+ → 10.
export function perclosToScore(p) {
  return Math.min(10, p * 25)
}

export function combineFatigue({ perclos, closedStreakMs = 0, droopMs = 0 }) {
  const eyeScore = perclosToScore(perclos)
  const closureBonus = closedStreakMs > MICROSLEEP_MS ? Math.min(8, ((closedStreakMs - MICROSLEEP_MS) / 1000) * 3) : 0
  const nodScore = droopMs >= DROOP_SUSTAIN_MS ? Math.min(8, 3 + ((droopMs - DROOP_SUSTAIN_MS) / 1000) * 2) : 0
  const score = Math.min(10, Math.max(eyeScore + closureBonus, nodScore))
  return { score: round(score), eyeScore: round(eyeScore), closureBonus: round(closureBonus), nodScore: round(nodScore), tier: tierForScore(score) }
}

export class FatigueTracker {
  constructor({ calibrationMs = CALIBRATION_MS, windowMs = PERCLOS_WINDOW_MS } = {}) {
    this.calibrationMs = calibrationMs
    this.windowMs = windowMs
    this.reset()
  }

  reset() {
    this.startedAt = null
    this.calib = { ear: [], pitch: [] }
    this.baseEar = null
    this.basePitch = null
    this.samples = [] // {t, closed}
    this.closedSince = 0
    this.droopSince = 0
    this.blinks = [] // timestamps
    this.microsleeps = 0
    this.microsleepCounted = false
    this.lastFaceAt = 0
    this.last = null
  }

  get calibrated() {
    return this.baseEar !== null
  }

  get earThreshold() {
    return this.baseEar === null ? null : clamp(this.baseEar * 0.72, 0.1, 0.3)
  }

  get droopThreshold() {
    return this.basePitch === null ? null : this.basePitch + Math.max(0.15, this.basePitch * 0.35)
  }

  calibrationProgress(now) {
    if (this.calibrated) return 1
    if (this.startedAt === null) return 0
    return clamp((now - this.startedAt) / this.calibrationMs, 0, 0.99)
  }

  // Feed one analysed frame. `ear`/`pitch` may be null when no face is visible.
  push({ t, ear, pitch }) {
    if (ear == null || pitch == null) {
      // A missing face ends any closure streak but is not counted as "closed".
      this.closedSince = 0
      this.droopSince = 0
      return
    }
    this.lastFaceAt = t
    if (this.startedAt === null) this.startedAt = t

    if (!this.calibrated) {
      this.calib.ear.push(ear)
      this.calib.pitch.push(pitch)
      if (t - this.startedAt >= this.calibrationMs && this.calib.ear.length >= 20) {
        // 70th percentile ignores blinks during calibration.
        this.baseEar = quantile(this.calib.ear, 0.7)
        this.basePitch = quantile(this.calib.pitch, 0.5)
      }
      this.last = { ear, pitch, closed: false, droop: false }
      return
    }

    const closed = ear < this.earThreshold
    const droop = pitch > this.droopThreshold

    if (closed) {
      if (!this.closedSince) this.closedSince = t
      if (!this.microsleepCounted && t - this.closedSince >= MICROSLEEP_MS) {
        this.microsleeps += 1
        this.microsleepCounted = true
      }
    } else {
      if (this.closedSince) {
        const dur = t - this.closedSince
        if (dur >= 60 && dur <= BLINK_MAX_MS) this.blinks.push(t)
      }
      this.closedSince = 0
      this.microsleepCounted = false
    }
    if (droop) {
      if (!this.droopSince) this.droopSince = t
    } else {
      this.droopSince = 0
    }

    // Track slow drift (lighting, posture) only while clearly alert.
    if (!closed && !droop) {
      this.baseEar += (ear - this.baseEar) * 0.002
      this.basePitch += (pitch - this.basePitch) * 0.002
    }

    this.samples.push({ t, closed })
    const cutoff = t - this.windowMs
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift()
    while (this.blinks.length && this.blinks[0] < cutoff) this.blinks.shift()
    this.last = { ear, pitch, closed, droop }
  }

  summary(now) {
    const face = now - this.lastFaceAt < 1500
    if (!this.calibrated) {
      return { calibrated: false, progress: this.calibrationProgress(now), face, score: 0, tier: 'normal' }
    }
    const n = this.samples.length
    const perclos = n ? this.samples.filter((s) => s.closed).length / n : 0
    const closedStreakMs = this.closedSince ? now - this.closedSince : 0
    const droopMs = this.droopSince ? now - this.droopSince : 0
    const f = combineFatigue({ perclos, closedStreakMs, droopMs })
    const span = n ? Math.max(20_000, this.samples[n - 1].t - this.samples[0].t) : 20_000
    return {
      calibrated: true,
      progress: 1,
      face,
      ...f,
      perclos: round(perclos, 3),
      eyesClosedMs: closedStreakMs,
      droopMs,
      blinkRate: Math.round((this.blinks.length * 60_000) / span),
      microsleeps: this.microsleeps,
      ear: this.last ? round(this.last.ear, 3) : null,
      earThreshold: round(this.earThreshold, 3),
      pitch: this.last ? round(this.last.pitch, 3) : null,
      droopThreshold: round(this.droopThreshold, 3),
    }
  }
}
