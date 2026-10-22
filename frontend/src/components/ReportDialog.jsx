import { useEffect, useRef, useState } from 'react'
import { Camera, Check, LocateFixed, MapPin, Upload, X } from 'lucide-react'
import { api } from '../api'
import { redactImageBlob, redactVideoFrames } from '../lib/redact'
import { coords, money } from '../lib/format'
import { useSensors } from '../hooks/useSensors'
import { Severity } from './bits'

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i
const STEPS = ['Blurring faces and number plates on this device', 'Uploading', 'Finding potholes', 'Estimating size and repair cost']

export default function ReportDialog({ onClose, onOpenSite }) {
  const sensors = useSensors()
  const input = useRef(null)
  const camInput = useRef(null)
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [over, setOver] = useState(false)
  const [loc, setLoc] = useState(() => {
    const p = sensors.getPosition()
    return p ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy, source: 'device' } : null
  })
  const [locBusy, setLocBusy] = useState(false)
  const [note, setNote] = useState('')
  const [step, setStep] = useState(-1)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const pick = (f) => {
    if (!f) return
    setFile(f)
    setResult(null)
    setError(null)
    setPreview(f.type.startsWith('image/') ? URL.createObjectURL(f) : null)
  }

  const locate = () => {
    if (!('geolocation' in navigator)) return setError('This browser cannot share its location.')
    setLocBusy(true)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, source: 'device' })
        setLocBusy(false)
      },
      (e) => {
        setLocBusy(false)
        setError(e.code === 1 ? 'Location permission was denied. You can still upload and set the location on the map later.' : 'Could not get a location fix. You can set it on the map later.')
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  // Fill in the location straight away when the browser already allows it.
  useEffect(() => {
    if (loc || !navigator.permissions?.query) return
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((p) => p.state === 'granted' && locate())
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setError(null)
    setResult(null)
    try {
      setStep(0)
      const isVideo = file.type.startsWith('video/') || VIDEO.test(file.name)
      const fd = new FormData()
      let report
      if (isVideo) {
        const r = await redactVideoFrames(file)
        report = r.report
        r.frames.forEach((b, i) => fd.append(i === 0 ? 'file' : 'frames', new File([b], `frame-${i}.jpg`, { type: 'image/jpeg' })))
      } else {
        const r = await redactImageBlob(file)
        report = r.report
        fd.append('file', new File([r.blob], 'photo.jpg', { type: 'image/jpeg' }))
      }
      fd.append('redaction', JSON.stringify(report))
      if (loc) {
        fd.append('lat', String(loc.lat))
        fd.append('lng', String(loc.lng))
        if (loc.accuracy) fd.append('accuracy_m', String(Math.round(loc.accuracy)))
        fd.append('gps_source', loc.source)
      }
      if (note.trim()) fd.append('note', note.trim())
      setStep(1)
      const t = setTimeout(() => setStep(2), 500)
      const t2 = setTimeout(() => setStep(3), 1400)
      const res = await api.upload(fd)
      clearTimeout(t)
      clearTimeout(t2)
      setStep(4)
      setResult({ ...res, privacy: report })
    } catch (e) {
      setStep(-1)
      setError(e.message || String(e))
    }
  }

  const busy = step >= 0 && step < 4
  const site = result?.site

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [busy, onClose])

  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="dialog-head">
          <h2 id="report-title">Report a pothole</h2>
          <button className="btn btn-ghost btn-sm x" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="dialog-body">
          {!result && (
            <>
              <div
                className={`drop ${over ? 'over' : ''}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(false)
                  pick(e.dataTransfer.files?.[0])
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
              >
                {preview ? (
                  <img src={preview} alt="" style={{ maxHeight: 220, maxWidth: '100%', borderRadius: 6 }} />
                ) : file ? (
                  <strong>{file.name}</strong>
                ) : (
                  <>
                    <Upload size={24} color="var(--muted)" />
                    <strong>Drop a photo or dashcam clip here</strong>
                    <span className="muted small">Photo of the road surface or a short MP4 clip. Daylight works best.</span>
                    <span style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); camInput.current?.click() }}>
                        <Camera size={15} /> Take photo
                      </button>
                      <button type="button" className="btn btn-sm" onClick={(e) => { e.stopPropagation(); input.current?.click() }}>
                        Choose file
                      </button>
                    </span>
                  </>
                )}
              </div>
              <input
                ref={input}
                type="file"
                accept="image/*,video/*"
                hidden
                onChange={(e) => pick(e.target.files?.[0])}
              />
              <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files?.[0])} />

              <div className="field">
                <label>Location</label>
                {loc ? (
                  <div className="note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <MapPin size={16} />
                    <span>
                      {coords(loc.lat, loc.lng)}
                      {loc.accuracy ? <span className="muted"> (±{Math.round(loc.accuracy)} m)</span> : null}
                    </span>
                    <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setLoc(null)}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn" onClick={locate} disabled={locBusy}>
                      <LocateFixed size={16} /> {locBusy ? 'Getting location…' : 'Use my current location'}
                    </button>
                    <span className="hint muted small">Otherwise the photo's own GPS tag is used, or you can place it on the map later.</span>
                  </div>
                )}
              </div>

              <div className="field">
                <label htmlFor="note">Note for the inspector (optional)</label>
                <input id="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Left lane, near the bus stop" maxLength={200} />
              </div>

              {busy && (
                <div className="progress" aria-live="polite">
                  <ol>
                    {STEPS.map((s, i) => (
                      <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>
                        {s}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {error && <div className="note error">{error}</div>}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={submit} disabled={!file || busy}>
                  <Upload size={16} /> {busy ? 'Analysing…' : 'Analyse and report'}
                </button>
              </div>
              <p className="muted small">Faces and number plates are blurred in your browser before anything is uploaded.</p>
            </>
          )}

          {result && !site && (
            <>
              <div className="note warn">
                <strong>No potholes found.</strong> {result.frames_checked > 1 ? `Checked ${result.frames_checked} frames. ` : ''}
                Try a closer photo of the road surface in daylight, taken from about 2 to 10 metres away.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => { setResult(null); setStep(-1) }}>Try another photo</button>
                <button className="btn btn-primary" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {site && (
            <>
              <div className="photo">
                <img src={site.evidence[site.evidence.length - 1].annotated} alt={`Detected potholes at ${site.id}`} />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Check size={20} color="var(--ok)" />
                <div>
                  <strong>
                    {result.action === 'merged'
                      ? `Added to existing site ${site.id} (${result.merged_distance_m} m away)`
                      : `${site.count} pothole${site.count === 1 ? '' : 's'} reported as ${site.id}`}
                  </strong>
                  <div className="muted small">
                    Estimated repair {money(site.estimate.total)} incl. GST.{' '}
                    {result.privacy.regions > 0 ? `${result.privacy.faces} face(s) and ${result.privacy.plates} plate(s) blurred.` : 'No faces or plates needed blurring.'}
                  </div>
                </div>
                <span style={{ marginLeft: 'auto' }}>
                  <Severity level={site.severity} />
                </span>
              </div>
              {site.lat == null && <div className="note warn">No location was recorded. Open the site and place it on the map so a crew can find it.</div>}
              {result.detector.tier === 'classical' && (
                <div className="note warn">The trained detection model is not installed, so a basic image method was used. Run scripts/get_model.py on the server for reliable results.</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => { setFile(null); setPreview(null); setResult(null); setStep(-1); setNote('') }}>
                  Report another
                </button>
                <button className="btn btn-primary" onClick={() => onOpenSite(site.id)}>
                  Open site
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
