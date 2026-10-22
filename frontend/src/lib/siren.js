// Emergency-siren and impact-sound detection from live microphone data.
// Pure functions (no Web Audio here) so they are unit-tested in Node.
//
// A siren is a loud, narrow-band tone between ~500 and 1800 Hz whose pitch
// keeps moving: a slow rise-and-fall (wail), a fast warble (yelp) or two
// alternating notes (hi-lo). Traffic noise is broad-band; a horn is tonal but
// holds one pitch; neither passes both tests.

export const BAND_LO_HZ = 500
export const BAND_HI_HZ = 1800
export const MIN_PEAK_DB = -70 // AnalyserNode dB scale (minDecibels -100 .. maxDecibels -30)
export const MIN_PROMINENCE_DB = 15 // peak above the band's median level
export const WINDOW_MS = 4000
export const MIN_SPAN_MS = 2500
export const MIN_TONAL_RATIO = 0.55
export const MIN_SWEEP_HZ = 150

// freqDb: Float32Array from AnalyserNode.getFloatFrequencyData (dB per bin).
export function analyzeSpectrum(freqDb, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize
  const lo = Math.max(1, Math.floor(BAND_LO_HZ / binHz))
  const hi = Math.min(freqDb.length - 2, Math.ceil(BAND_HI_HZ / binHz))
  let peak = -Infinity
  let peakBin = lo
  const band = []
  for (let b = lo; b <= hi; b++) {
    const v = Number.isFinite(freqDb[b]) ? freqDb[b] : -140
    band.push(v)
    if (v > peak) {
      peak = v
      peakBin = b
    }
  }
  band.sort((a, b) => a - b)
  const median = band[Math.floor(band.length / 2)]
  // Parabolic interpolation for sub-bin accuracy.
  const a = freqDb[peakBin - 1]
  const c = freqDb[peakBin + 1]
  const denom = a - 2 * peak + c
  const offset = Number.isFinite(denom) && denom !== 0 ? (0.5 * (a - c)) / denom : 0
  const dominantHz = (peakBin + Math.max(-0.5, Math.min(0.5, offset))) * binHz
  return {
    dominantHz,
    peakDb: peak,
    prominenceDb: peak - median,
    tonal: peak >= MIN_PEAK_DB && peak - median >= MIN_PROMINENCE_DB,
  }
}

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// history: [{ t, dominantHz, tonal }], oldest first.
export function classifySiren(history, now = history.length ? history[history.length - 1].t : 0) {
  const win = history.filter((f) => now - f.t <= WINDOW_MS)
  const none = { siren: false, score: 0, pattern: null, sweepHz: 0, tonalRatio: 0 }
  if (win.length < 15 || win[win.length - 1].t - win[0].t < MIN_SPAN_MS) return none

  const tonal = win.filter((f) => f.tonal)
  const tonalRatio = tonal.length / win.length
  if (tonalRatio < MIN_TONAL_RATIO) return { ...none, tonalRatio }

  const freqs = tonal.map((f) => f.dominantHz).sort((a, b) => a - b)
  const p10 = freqs[Math.floor(freqs.length * 0.1)]
  const p90 = freqs[Math.floor(freqs.length * 0.9)]
  const sweepHz = p90 - p10
  if (sweepHz < MIN_SWEEP_HZ) return { ...none, tonalRatio, sweepHz }

  // Pitch must go up AND down (count direction reversals with hysteresis).
  const seq = tonal.map((f) => f.dominantHz)
  let dir = 0
  let anchor = seq[0]
  let reversals = 0
  for (const f of seq) {
    if (f > anchor + 60) {
      if (dir === -1) reversals++
      dir = 1
      anchor = f
    } else if (f < anchor - 60) {
      if (dir === 1) reversals++
      dir = -1
      anchor = f
    } else if ((dir === 1 && f > anchor) || (dir === -1 && f < anchor)) {
      anchor = f
    }
  }
  if (reversals < 1) return { ...none, tonalRatio, sweepHz }

  const steps = []
  for (let i = 1; i < seq.length; i++) steps.push(Math.abs(seq[i] - seq[i - 1]))
  const medStep = median(steps)
  const bigSteps = steps.filter((s) => s > sweepHz * 0.6).length / steps.length
  const pattern = bigSteps > 0.08 && medStep < 40 ? 'hi-lo' : medStep < 60 ? 'wail' : 'yelp'

  const score = Math.min(1, 0.5 * tonalRatio + 0.5 * Math.min(1, sweepHz / 500))
  return { siren: true, score: Math.round(score * 100) / 100, pattern, sweepHz: Math.round(sweepHz), tonalRatio, reversals }
}

// ---- impact sound ----------------------------------------------------------

export function rmsDbfs(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -120
}

// Rolling cabin loudness. `jump()` = loudest level in the last `recentMs`
// minus the median of the seconds before it; a crash is a sudden, large jump.
export class LevelTracker {
  constructor({ keepMs = 6000, recentMs = 700 } = {}) {
    this.keepMs = keepMs
    this.recentMs = recentMs
    this.levels = []
  }

  push(t, db) {
    this.levels.push({ t, db })
    while (this.levels.length && this.levels[0].t < t - this.keepMs) this.levels.shift()
  }

  snapshot(now) {
    const recent = this.levels.filter((l) => l.t >= now - this.recentMs)
    const before = this.levels.filter((l) => l.t < now - this.recentMs)
    if (!recent.length || before.length < 5) return { peak_dbfs: null, jump_db: null }
    const peak = Math.max(...recent.map((l) => l.db))
    const base = median(before.map((l) => l.db))
    return { peak_dbfs: Math.round(peak * 10) / 10, jump_db: Math.round((peak - base) * 10) / 10 }
  }
}
