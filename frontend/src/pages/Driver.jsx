import { useEffect, useRef, useState } from 'react'
import { Camera, RefreshCw } from 'lucide-react'
import { api } from '../api'
import { useLive } from '../hooks/useLive'
import { useSensors } from '../hooks/useSensors'
import { EYES } from '../lib/fatigue'
import { ScoreLine } from '../components/Charts'
import { Empty } from '../components/bits'
import { dateTime } from '../lib/format'

const STATE = {
  normal: ['normal', 'Alert'],
  elevated: ['elevated', 'Showing signs of tiredness'],
  critical: ['critical', 'Drowsy: alertness check will start'],
}

const OUTCOME = {
  answered: 'Answered correctly',
  recovered: 'No answer; alarm until alert',
}

function CameraView() {
  const s = useSensors()
  const video = useRef(null)
  const canvas = useRef(null)

  useEffect(() => {
    if (video.current && s.stream && video.current.srcObject !== s.stream) video.current.srcObject = s.stream
  }, [s.stream])

  // Draw the tracked eye outline and nose-chin line so the driver can see
  // what the system is measuring.
  useEffect(() => {
    let raf
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const lm = s.landmarksRef.current
      if (!c) return
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== w) c.width = w
      if (c.height !== h) c.height = h
      const ctx = c.getContext('2d')
      ctx.clearRect(0, 0, w, h)
      if (!lm) return
      // object-fit: cover mapping from 4:3 video
      const vw = video.current?.videoWidth || 640
      const vh = video.current?.videoHeight || 480
      const scale = Math.max(w / vw, h / vh)
      const ox = (w - vw * scale) / 2
      const oy = (h - vh * scale) / 2
      const P = (i) => [lm[i].x * vw * scale + ox, lm[i].y * vh * scale + oy]
      const closed = s.summary?.ear != null && s.summary.ear < s.summary.earThreshold
      ctx.lineWidth = 2
      ctx.strokeStyle = closed ? '#e5534b' : '#f2c230'
      for (const eye of [EYES.left, EYES.right]) {
        const [p1, p2, p3, p4, p5, p6] = eye.map(P)
        ctx.beginPath()
        ctx.moveTo(...p1)
        ctx.lineTo(...p2)
        ctx.lineTo(...p3)
        ctx.lineTo(...p4)
        ctx.lineTo(...p5)
        ctx.lineTo(...p6)
        ctx.closePath()
        ctx.stroke()
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(...P(168))
      ctx.lineTo(...P(1))
      ctx.lineTo(...P(152))
      ctx.stroke()
      ctx.setLineDash([])
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [s.landmarksRef, s.summary])

  const msg = {
    off: (
      <>
        <Camera size={28} />
        <strong>The camera is off</strong>
        <span>Place this device so it faces the driver, then start monitoring. Video stays on this device; only scores are sent.</span>
        <button className="btn btn-primary" onClick={s.start}>Start monitoring</button>
      </>
    ),
    starting: 'Waiting for camera permission…',
    loading: 'Loading the face model…',
    blocked: 'Camera access is blocked. Allow it in the browser’s site settings, then stop and start monitoring.',
    missing: 'No camera was found on this device.',
    error: 'The camera could not be started.',
  }[s.camera]

  const sum = s.summary
  return (
    <div className="cam">
      {s.stream && <video ref={video} autoPlay muted playsInline />}
      {s.stream && <canvas ref={canvas} />}
      {s.camera !== 'live' && (
        <div className="cam-msg">
          <div>{msg}</div>
        </div>
      )}
      {s.camera === 'live' && (
        <div className="badge">
          <span className={`dot ${sum?.face ? 'live' : 'warn'}`} />
          {sum?.face ? 'Face tracked' : 'No face in view'}
        </div>
      )}
      {s.camera === 'live' && sum && !sum.calibrated && sum.face && (
        <div className="calib" role="status">
          Calibrating to your eyes. Look at the road ahead normally for a few seconds.
          <div className="bar"><span style={{ width: `${Math.round(sum.progress * 100)}%` }} /></div>
        </div>
      )}
    </div>
  )
}

export default function Driver() {
  const s = useSensors()
  const { talkbackEvent } = useLive()
  const [checks, setChecks] = useState([])
  useEffect(() => {
    api.checks().then(setChecks).catch(() => {})
  }, [talkbackEvent])

  const sum = s.summary
  const live = s.camera === 'live' && sum?.calibrated
  const [cls, label] = live ? STATE[sum.tier] : ['', s.camera === 'live' ? 'Calibrating…' : 'Not monitoring']

  return (
    <div className="driver-grid">
      <div className="stack">
        <CameraView />
        <section className="panel">
          <div className="panel-head">
            <h2>Alertness, last 3 minutes</h2>
            <span className="aside">Shaded: tired (5+) and drowsy (8+)</span>
          </div>
          <div className="panel-body">
            {s.history.length > 1 ? <ScoreLine points={s.history} /> : <p className="muted">The chart fills in once monitoring is calibrated.</p>}
          </div>
        </section>
      </div>

      <div className="stack">
        <section className="panel">
          <div className="section readout">
            <div className="score-block">
              <div className="score-num">
                {live ? sum.score.toFixed(1) : '–'}
                <small> /10</small>
              </div>
              <div>
                <div className="score-scale" aria-hidden="true">
                  {live && <div className="needle" style={{ left: `${sum.score * 10}%` }} />}
                </div>
                <div className="score-ticks"><span>0</span><span>5</span><span>8</span><span>10</span></div>
                <div className={`state-line ${cls}`}>{label}</div>
              </div>
            </div>
            <div className="metrics">
              <div>
                <div className="k">Eyes closed (PERCLOS)</div>
                <div className="v">{live ? `${(sum.perclos * 100).toFixed(1)}%` : '–'}</div>
                <div className="d">of the last minute</div>
              </div>
              <div>
                <div className="k">Blink rate</div>
                <div className="v">{live ? `${sum.blinkRate}/min` : '–'}</div>
                <div className="d">typical when alert: 10–20</div>
              </div>
              <div>
                <div className="k">Microsleeps</div>
                <div className="v">{live ? sum.microsleeps : '–'}</div>
                <div className="d">eyes shut over 1.5 s, this session</div>
              </div>
              <div>
                <div className="k">Head dropping</div>
                <div className="v">{live ? (sum.droopMs > 0 ? `${(sum.droopMs / 1000).toFixed(1)} s` : 'No') : '–'}</div>
                <div className="d">head tipped forward now</div>
              </div>
            </div>
            {live && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="muted small">
                  Eye openness {sum.ear?.toFixed(2)} (closed below {sum.earThreshold?.toFixed(2)}, set for this driver)
                </span>
                <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={s.recalibrate}>
                  <RefreshCw size={14} /> Recalibrate
                </button>
              </div>
            )}
          </div>
          <div className="section">
            <div className="section-head">
              <h3>How alerts work</h3>
              <p className="small">
                At 8 or above, the driver is asked a quick sum out loud and answers by voice. A wrong answer repeats the question;
                no answer within 8 seconds sounds a loud alarm until the driver is alert again.
              </p>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Alertness checks</h2>
          </div>
          {checks.length === 0 ? (
            <Empty>No checks yet. They are logged here with what the driver said.</Empty>
          ) : (
            <ul className="feed">
              {checks.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <span className={`dot ${c.correct ? 'live' : 'bad'}`} style={{ marginTop: 7 }} />
                  <div>
                    <div>{c.question} <span className="muted">({(OUTCOME[c.outcome] || c.outcome).toLowerCase()})</span></div>
                    <div className="muted small">
                      {c.attempts.length ? `Heard: ${c.attempts.map((a) => `“${a.heard || a.parsed}”`).join(', ')}` : 'Nothing heard'}
                      {`, ${(c.response_ms / 1000).toFixed(1)} s`}
                    </div>
                  </div>
                  <time>{dateTime(c.created_at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
