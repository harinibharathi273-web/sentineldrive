import { useEffect, useState } from 'react'
import { ExternalLink, FileText, MapPin, Trash2, X } from 'lucide-react'
import { api, workOrderUrl } from '../api'
import { useLive } from '../hooks/useLive'
import { coords, dateTime, money, place, STATUS_LABEL } from '../lib/format'
import MapView from './MapView'
import { Severity, Status, toast } from './bits'

const NEXT = {
  reported: [['verified', 'Mark verified'], ['rejected', 'Not a pothole']],
  verified: [['scheduled', 'Schedule repair'], ['rejected', 'Not a pothole']],
  scheduled: [['repaired', 'Mark repaired']],
  repaired: [['reported', 'Reopen']],
  rejected: [['reported', 'Reopen']],
}

const SOURCE = { device: 'Phone GPS', 'photo-exif': 'Photo GPS tag', 'set-on-map': 'Placed on map', none: 'Not recorded' }

export default function SiteDrawer({ id, onClose }) {
  const { potholes, upsertPothole, health } = useLive()
  const site = potholes.find((p) => p.id === id)
  const [photo, setPhoto] = useState(0)
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPhoto(site ? site.evidence.length - 1 : 0)
    setPicking(false)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])

  if (!site) return null
  const ev = site.evidence[Math.min(photo, site.evidence.length - 1)]
  const est = site.estimate

  const update = async (body, msg) => {
    setBusy(true)
    try {
      const rec = await api.updatePothole(site.id, body)
      upsertPothole(rec)
      if (msg) toast(msg)
      setNote('')
    } catch (e) {
      toast(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete ${site.id} and its photos? This cannot be undone.`)) return
    await api.deletePothole(site.id)
    toast(`${site.id} deleted`)
    onClose()
  }

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="site-title">
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
              <h2 id="site-title">{site.id}</h2>
              <Status status={site.status} />
            </div>
            <p className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{place(site)}</p>
          </div>
          <button className="btn btn-ghost btn-sm x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          <div>
            <div className="photo">
              <img src={ev.annotated} alt={`Annotated photo of ${site.id}`} />
            </div>
            {site.evidence.length > 1 && (
              <div className="photo-strip" aria-label="Reports">
                {site.evidence.map((e, i) => (
                  <button key={e.ts} className={i === photo ? 'on' : ''} onClick={() => setPhoto(i)} aria-label={`Report ${i + 1}`}>
                    <img src={e.annotated} alt="" />
                  </button>
                ))}
              </div>
            )}
            <p className="muted small" style={{ marginTop: 6 }}>
              Report {Math.min(photo, site.evidence.length - 1) + 1} of {site.evidence.length}, {dateTime(ev.ts)}
              {ev.note ? `. "${ev.note}"` : ''}
            </p>
          </div>

          <div className="facts">
            <div><div className="k">Severity</div><div className="v"><Severity level={site.severity} /></div></div>
            <div><div className="k">Priority</div><div className="v">{site.priority} / 100</div></div>
            <div><div className="k">Potholes</div><div className="v">{site.count}</div></div>
            <div><div className="k">Total area</div><div className="v">{site.area_m2.toFixed(2)} m²</div></div>
            <div><div className="k">Deepest</div><div className="v">{Math.round(site.depth_max_m * 1000)} mm</div></div>
            <div><div className="k">Fill volume</div><div className="v">{(site.volume_m3 * 1000).toFixed(0)} L</div></div>
          </div>

          <section>
            <h3 style={{ marginBottom: 8 }}>Location</h3>
            {site.lat == null || picking ? (
              <>
                {!picking && <div className="note warn" style={{ marginBottom: 8 }}>No location was recorded with this report. Place it on the map so the repair crew can find it.</div>}
                <MapView
                  sites={site.lat != null ? [site] : []}
                  selectedId={site.id}
                  pickMode
                  onPick={async (p) => {
                    await update(p, 'Location saved')
                    setPicking(false)
                  }}
                />
                {picking && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setPicking(false)}>Cancel</button>}
              </>
            ) : (
              <dl className="dl">
                <dt>Address</dt>
                <dd>{site.address?.display_name || <span className="muted">{health?.geocoder === 'off' ? 'Address lookup is turned off on the server' : 'Not found yet (the server needs internet access to look up addresses)'}</span>}</dd>
                {site.jurisdiction?.authority && (
                  <>
                    <dt>Civic body</dt>
                    <dd>{site.jurisdiction.authority}{site.jurisdiction.ward ? `, ${site.jurisdiction.ward}` : ''}</dd>
                  </>
                )}
                <dt>Coordinates</dt>
                <dd>
                  {coords(site.lat, site.lng)}{' '}
                  <a href={`https://www.google.com/maps?q=${site.lat},${site.lng}`} target="_blank" rel="noreferrer">
                    Maps <ExternalLink size={12} />
                  </a>
                </dd>
                <dt>Source</dt>
                <dd>
                  {SOURCE[site.gps_source] || site.gps_source}
                  {site.gps_accuracy_m ? `, ±${Math.round(site.gps_accuracy_m)} m` : ''}{' '}
                  <button className="btn btn-ghost btn-sm" onClick={() => setPicking(true)}>
                    <MapPin size={14} /> Move
                  </button>
                </dd>
              </dl>
            )}
          </section>

          {est && (
            <section>
              <h3 style={{ marginBottom: 6 }}>Repair estimate</h3>
              <table className="boq">
                <tbody>
                  {est.lines.map((l) => (
                    <tr key={l.item}>
                      <td>
                        {l.item}
                        <div className="q">{l.qty} {l.unit} × {money(l.rate)}</div>
                      </td>
                      <td className="r">{money(l.amount)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>GST {est.gst_pct}%</td>
                    <td className="r">{money(est.gst)}</td>
                  </tr>
                  <tr className="total">
                    <td>Total</td>
                    <td className="r">{money(est.total)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small" style={{ marginTop: 6 }}>{est.rate_card_note} Sizes are camera estimates; confirm on site.</p>
            </section>
          )}

          <section>
            <h3 style={{ marginBottom: 10 }}>History</h3>
            <ul className="timeline">
              {site.history.map((h, i) => (
                <li key={i}>
                  <strong>{STATUS_LABEL[h.status]}</strong> <span className="muted small">{dateTime(h.ts)}</span>
                  {h.note && <div className="muted">{h.note}</div>}
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" style={{ flex: 1 }} />
              <button className="btn" disabled={!note.trim() || busy} onClick={() => update({ note }, 'Note added')}>Add</button>
            </div>
          </section>

          <p className="muted small">
            Detected by {site.detector?.label?.toLowerCase()}, highest confidence {Math.round(site.confidence * 100)}%.{' '}
            {site.measurement_method}
          </p>
        </div>

        <div className="drawer-foot">
          {NEXT[site.status].map(([s, label], i) => (
            <button
              key={s}
              className={`btn ${i === 0 && s !== 'reported' ? 'btn-primary' : ''}`}
              disabled={busy}
              onClick={() => update({ status: s, note: note || undefined }, `${site.id}: ${STATUS_LABEL[s]}`)}
            >
              {label}
            </button>
          ))}
          <a className="btn" href={workOrderUrl(site.id)} target="_blank" rel="noreferrer">
            <FileText size={16} /> Work order PDF
          </a>
          <button className="btn btn-ghost btn-danger" style={{ marginLeft: 'auto' }} onClick={remove} aria-label="Delete site">
            <Trash2 size={16} />
          </button>
        </div>
      </aside>
    </>
  )
}
