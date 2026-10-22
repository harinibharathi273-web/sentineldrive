import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { FatigueTracker, earFromLandmarks, headPitchRatio } from '../lib/fatigue'
import { analyzeSpectrum, classifySiren, LevelTracker, rmsDbfs } from '../lib/siren'
import { audioContext } from '../lib/speech'
import { useLive } from './useLive'

const SensorsContext = createContext(null)

const REPORT_G = 2.5 // dynamic g that is worth sending for verification
const CRASH_DEBOUNCE_MS = 10_000

// Everything that reads the driver's device: camera (alertness), microphone
// (sirens, impact sound), accelerometer (impacts) and GPS. Nothing starts until
// the driver presses "Start monitoring", because browsers only allow camera,
// microphone, motion and audio playback after a user action.
export function SensorsProvider({ children }) {
  const { send } = useLive()
  const sendRef = useRef(send)
  sendRef.current = send

  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [camera, setCamera] = useState('off') // off | starting | loading | live | blocked | missing | error
  const [mic, setMic] = useState('off')
  const [motion, setMotion] = useState('off') // off | live | blocked | unsupported | waiting
  const [gps, setGps] = useState({ state: 'off' })
  const [stream, setStream] = useState(null)
  const [summary, setSummary] = useState(null)
  const [history, setHistory] = useState([]) // [{t, score}] last 3 min
  const [sirenLive, setSirenLive] = useState(null)
  const [lastG, setLastG] = useState(null)
  const [error, setError] = useState(null)

  const r = useRef({}).current // mutable runtime bag
  const landmarksRef = useRef(null)

  const stop = useCallback(() => {
    r.stopped = true
    cancelAnimationFrame(r.raf)
    ;[r.reportTimer, r.audioTimer, r.levelTimer].forEach(clearInterval)
    r.landmarker?.close?.()
    r.camStream?.getTracks().forEach((t) => t.stop())
    r.micStream?.getTracks().forEach((t) => t.stop())
    if (r.onMotion) window.removeEventListener('devicemotion', r.onMotion)
    if (r.watchId != null) navigator.geolocation.clearWatch(r.watchId)
    r.wakeLock?.release?.().catch(() => {})
    Object.assign(r, { landmarker: null, camStream: null, micStream: null, onMotion: null, watchId: null, wakeLock: null })
    if (r.sirenOn) sendRef.current({ type: 'siren_clear' })
    r.sirenOn = false
    setStream(null)
    setRunning(false)
    setCamera('off')
    setMic('off')
    setMotion('off')
    setGps({ state: 'off' })
    setSummary(null)
    setSirenLive(null)
    landmarksRef.current = null
  }, [r])

  // ---------------- camera + alertness ----------------
  const startCamera = useCallback(async () => {
    setCamera('starting')
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      if (r.stopped) return s.getTracks().forEach((t) => t.stop())
      r.camStream = s
      setStream(s)
      const video = document.createElement('video')
      video.srcObject = s
      video.muted = true
      video.playsInline = true
      await video.play()
      r.video = video
      setCamera('loading')
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const fileset = await FilesetResolver.forVisionTasks('/wasm')
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
      })
      let lmk
      try {
        lmk = await FaceLandmarker.createFromOptions(fileset, opts('GPU'))
      } catch {
        lmk = await FaceLandmarker.createFromOptions(fileset, opts('CPU'))
      }
      if (r.stopped) return lmk.close()
      r.landmarker = lmk
      r.tracker = new FatigueTracker()
      setCamera('live')

      let lastVideoTime = -1
      const loop = () => {
        if (r.stopped || !r.landmarker) return
        r.raf = requestAnimationFrame(loop)
        if (video.readyState < 2 || video.currentTime === lastVideoTime) return
        lastVideoTime = video.currentTime
        const now = Date.now()
        const res = r.landmarker.detectForVideo(video, performance.now())
        const lm = res.faceLandmarks?.[0]
        if (lm) {
          landmarksRef.current = lm
          r.tracker.push({ t: now, ear: earFromLandmarks(lm), pitch: headPitchRatio(lm) })
        } else {
          landmarksRef.current = null
          r.tracker.push({ t: now, ear: null, pitch: null })
        }
      }
      r.raf = requestAnimationFrame(loop)

      r.reportTimer = setInterval(() => {
        const now = Date.now()
        const s = r.tracker.summary(now)
        setSummary(s)
        if (s.calibrated) setHistory((h) => [...h.filter((p) => now - p.t < 180_000), { t: now, score: s.score }])
        // Report only while a face is visible; when it is not, the server
        // marks the driver feed inactive rather than guessing.
        if (s.face && s.calibrated) {
          sendRef.current({
            type: 'fatigue',
            score: s.score,
            perclos: s.perclos,
            face: true,
            calibrated: true,
            blink_rate: s.blinkRate,
            eyes_closed_ms: s.eyesClosedMs,
            droop_ms: s.droopMs,
            microsleeps: s.microsleeps,
          })
        }
      }, 1000)
    } catch (e) {
      setCamera(e?.name === 'NotAllowedError' ? 'blocked' : e?.name === 'NotFoundError' ? 'missing' : 'error')
      if (!['NotAllowedError', 'NotFoundError'].includes(e?.name)) setError(`Camera: ${e?.message || e}`)
    }
  }, [r])

  const recalibrate = useCallback(() => {
    r.tracker?.reset()
    setHistory([])
  }, [r])

  // ---------------- microphone: siren + loudness ----------------
  const startMic = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      if (r.stopped) return s.getTracks().forEach((t) => t.stop())
      r.micStream = s
      const ctx = audioContext()
      const src = ctx.createMediaStreamSource(s)
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      an.smoothingTimeConstant = 0.2
      src.connect(an)
      const freq = new Float32Array(an.frequencyBinCount)
      const time = new Float32Array(an.fftSize)
      r.level = new LevelTracker()
      r.sirenHist = []
      r.sirenOn = false
      r.sirenLastSent = 0
      r.sirenLastSeen = 0
      setMic('live')

      r.levelTimer = setInterval(() => {
        an.getFloatTimeDomainData(time)
        r.level.push(Date.now(), rmsDbfs(time))
      }, 50)

      r.audioTimer = setInterval(() => {
        const now = Date.now()
        an.getFloatFrequencyData(freq)
        r.sirenHist.push({ t: now, ...analyzeSpectrum(freq, ctx.sampleRate, an.fftSize) })
        while (r.sirenHist.length && now - r.sirenHist[0].t > 5000) r.sirenHist.shift()
        const c = classifySiren(r.sirenHist, now)
        if (c.siren) {
          r.sirenLastSeen = now
          setSirenLive(c)
          if (!r.sirenOn || now - r.sirenLastSent > 1500) {
            const last = r.sirenHist[r.sirenHist.length - 1]
            sendRef.current({
              type: 'siren_detected',
              freq_hz: Math.round(last.dominantHz),
              score: c.score,
              pattern: c.pattern,
              gps: r.gps ? { lat: r.gps.lat, lng: r.gps.lng } : null,
            })
            r.sirenOn = true
            r.sirenLastSent = now
          }
        } else if (r.sirenOn && now - r.sirenLastSeen > 3000) {
          r.sirenOn = false
          setSirenLive(null)
          sendRef.current({ type: 'siren_clear' })
        }
      }, 60)
    } catch (e) {
      setMic(e?.name === 'NotAllowedError' ? 'blocked' : e?.name === 'NotFoundError' ? 'missing' : 'error')
    }
  }, [r])

  // ---------------- accelerometer ----------------
  const startMotion = useCallback(async () => {
    if (!('DeviceMotionEvent' in window)) return setMotion('unsupported')
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return setMotion('blocked')
      } catch {
        return setMotion('blocked')
      }
    }
    setMotion('waiting')
    let peak = 0
    let peakAt = 0
    let lastShown = 0
    r.lastCrash = 0
    r.onMotion = (e) => {
      const a = e.acceleration
      let g
      if (a && a.x != null) g = Math.hypot(a.x, a.y, a.z) / 9.81
      else if (e.accelerationIncludingGravity?.x != null) {
        const b = e.accelerationIncludingGravity
        g = Math.abs(Math.hypot(b.x, b.y, b.z) - 9.81) / 9.81
      } else return
      const now = Date.now()
      if (now - lastShown > 400) {
        lastShown = now
        setLastG(g)
        setMotion('live')
      }
      if (now - peakAt > 600) peak = 0
      if (g > peak) {
        peak = g
        peakAt = now
      }
      if (peak >= REPORT_G && now - r.lastCrash > CRASH_DEBOUNCE_MS) {
        r.lastCrash = now
        const impactG = peak
        // Wait a moment so the impact sound and the post-impact speed are in.
        setTimeout(() => {
          const t = Date.now()
          const speedNow = r.gps?.speed_kmh ?? null
          const before = (r.speeds || []).filter((s) => t - s.t >= 1500 && t - s.t <= 8000)
          const speedPrior = before.length ? Math.max(...before.map((s) => s.v)) : null
          const sum = r.tracker?.summary(t)
          sendRef.current({
            type: 'crash_candidate',
            g: Math.round(impactG * 100) / 100,
            ts: now,
            gps: r.gps
              ? { lat: r.gps.lat, lng: r.gps.lng, accuracy_m: r.gps.accuracy, speed_kmh: speedNow, speed_prior_kmh: speedPrior }
              : null,
            audio: r.level ? r.level.snapshot(t) : null,
            driver: sum?.calibrated ? { score: sum.score, tier: sum.tier } : null,
          })
        }, 700)
      }
    }
    window.addEventListener('devicemotion', r.onMotion)
    // Desktops expose the API but never fire it; say so after a few seconds.
    setTimeout(() => setMotion((m) => (m === 'waiting' ? 'unsupported' : m)), 4000)
  }, [r])

  // ---------------- GPS ----------------
  const startGps = useCallback(() => {
    if (!('geolocation' in navigator)) return setGps({ state: 'unsupported' })
    setGps({ state: 'starting' })
    r.speeds = []
    r.watchId = navigator.geolocation.watchPosition(
      (p) => {
        const t = Date.now()
        const v = p.coords.speed != null ? p.coords.speed * 3.6 : null
        r.gps = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, speed_kmh: v }
        if (v != null) {
          r.speeds.push({ t, v })
          r.speeds = r.speeds.filter((s) => t - s.t < 15_000)
        }
        setGps({ state: 'live', ...r.gps })
      },
      (err) => setGps({ state: err.code === 1 ? 'blocked' : 'error' }),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    )
  }, [r])

  const start = useCallback(async () => {
    setError(null)
    if (!window.isSecureContext) {
      setError('Sensors need a secure connection. Open the HTTPS address shown when you start the frontend (see README).')
      return
    }
    r.stopped = false
    setRunning(true)
    setStartedAt(Date.now() - 5000)
    audioContext() // unlock audio playback inside this click
    if ('speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
    try {
      r.wakeLock = await navigator.wakeLock?.request('screen')
    } catch {
      /* optional */
    }
    startMotion() // must run first: iOS needs the click gesture for its prompt
    startGps()
    await Promise.all([startCamera(), startMic()])
  }, [r, startCamera, startMic, startMotion, startGps])

  useEffect(() => () => stop(), [stop])

  const getPosition = useCallback(() => r.gps || null, [r])

  const value = {
    running, startedAt, start, stop, recalibrate, camera, mic, motion, gps, stream, summary, history, sirenLive, lastG,
    error, landmarksRef, getPosition,
  }
  return <SensorsContext.Provider value={value}>{children}</SensorsContext.Provider>
}

export const useSensors = () => useContext(SensorsContext)
