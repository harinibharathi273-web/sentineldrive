import { useEffect, useState } from 'react'
import { api } from '../api'
import { useLive } from '../hooks/useLive'
import { CONTACT_KEY, readContact } from '../components/Overlays'
import { toast } from '../components/bits'
import { money } from '../lib/format'
import { estimatePreview } from '../lib/estimate'

const RATE_FIELDS = [
  ['authority', 'Issuing authority on work orders', 'text', 'e.g. Greater Chennai Corporation, Zone 9'],
  ['material_name', 'Patching material', 'text'],
  ['material_rate_per_tonne', 'Material rate (₹ per tonne)', 'number'],
  ['material_density_t_per_m3', 'Compacted density (tonnes per m³)', 'number'],
  ['wastage_pct', 'Wastage allowance (%)', 'number'],
  ['tack_coat_rate_per_m2', 'Tack coat (₹ per m²)', 'number'],
  ['edge_cutting_rate_per_m', 'Edge cutting (₹ per metre)', 'number'],
  ['labour_per_patch', 'Labour (₹ per patch)', 'number'],
  ['traffic_management_per_patch', 'Barricading (₹ per patch)', 'number'],
  ['gst_pct', 'GST (%)', 'number'],
  ['source_note', 'Rate source shown on work orders', 'text', 'e.g. GCC Schedule of Rates 2025–26, item 4.12'],
]

export default function Settings() {
  const { health } = useLive()
  const [card, setCard] = useState(null)
  const [saving, setSaving] = useState(false)
  const [prefs, setPrefs] = useState(null)
  const [contact, setContact] = useState(() => readContact() || { name: '', phone: '' })

  useEffect(() => {
    api.rateCard().then((r) => setCard(r.rate_card)).catch(() => {})
    api.prefs().then(setPrefs).catch(() => {})
  }, [])

  const saveCard = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const r = await api.saveRateCard(card)
      setCard(r.rate_card)
      const { updated } = await api.recalculate()
      toast(`Rates saved. ${updated} open site${updated === 1 ? '' : 's'} re-priced.`)
    } catch (err) {
      toast(err.message)
    } finally {
      setSaving(false)
    }
  }

  const saveContact = (e) => {
    e.preventDefault()
    try {
      localStorage.setItem(CONTACT_KEY, JSON.stringify(contact))
      toast('Emergency contact saved on this device')
    } catch {
      toast('Could not save on this device (private browsing?)')
    }
  }

  const savePrefs = async (patch) => {
    const next = await api.savePrefs({ ...prefs, ...patch })
    setPrefs(next)
    toast('Saved')
  }

  return (
    <div className="stack" style={{ maxWidth: 920 }}>
      <form className="panel" onSubmit={saveCard}>
        <div className="section">
          <div className="section-head">
            <h2>Repair rate card</h2>
            <p className="small">
              Used to price every work order. Replace the defaults with your corporation’s current Schedule of Rates. Saving
              re-prices all open sites; repaired and closed sites keep the price they were issued with.
            </p>
          </div>
          {card ? (
            <>
              <div className="settings-grid">
                {RATE_FIELDS.map(([k, label, type, ph]) => (
                  <div className="field" key={k} style={type === 'text' ? { gridColumn: '1 / -1' } : undefined}>
                    <label htmlFor={k}>{label}</label>
                    <input
                      id={k}
                      type={type}
                      step="any"
                      min={type === 'number' ? 0 : undefined}
                      placeholder={ph}
                      value={card[k] ?? ''}
                      onChange={(e) => setCard({ ...card, [k]: type === 'number' ? e.target.value : e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <p className="muted small">
                Example: a single 60 × 40 cm pothole, 50 mm deep, would cost {money(estimatePreview(card))} including GST.
              </p>
              <div>
                <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save rates'}</button>
              </div>
            </>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </div>
      </form>

      <section className="panel">
        <form className="section" onSubmit={saveContact}>
          <div className="section-head">
            <h2>Emergency contact</h2>
            <p className="small">After a confirmed crash, the driver can text this person their location in one tap. Stored only on this device.</p>
          </div>
          <div className="settings-grid">
            <div className="field">
              <label htmlFor="cname">Name</label>
              <input id="cname" type="text" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cphone">Mobile number</label>
              <input id="cphone" type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} placeholder="+91 98xxxxxxxx" />
            </div>
          </div>
          <div>
            <button className="btn btn-primary">Save contact</button>
          </div>
        </form>
        {prefs && (
          <div className="section">
            <div className="section-head">
              <h2>Driving side</h2>
              <p className="small">Used in the spoken instruction when an emergency vehicle is heard.</p>
            </div>
            <div className="seg" style={{ width: 'fit-content' }}>
              <button className={prefs.traffic_side === 'left' ? 'on' : ''} onClick={() => savePrefs({ traffic_side: 'left' })}>Drive on the left (India, UK)</button>
              <button className={prefs.traffic_side === 'right' ? 'on' : ''} onClick={() => savePrefs({ traffic_side: 'right' })}>Drive on the right</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section">
          <div className="section-head">
            <h2>System</h2>
          </div>
          <dl className="dl">
            <dt>Pothole detection</dt>
            <dd>
              {health?.detector?.label || '—'}
              {health?.detector?.tier === 'classical' && (
                <div className="note warn" style={{ marginTop: 6 }}>
                  The trained model is not installed. On the server run <code>python scripts/get_model.py</code> and restart the
                  backend for reliable detection.
                </div>
              )}
            </dd>
            <dt>Addresses</dt>
            <dd>{health?.geocoder === 'off' ? 'Turned off (coordinates only)' : 'OpenStreetMap Nominatim (needs internet on the server)'}</dd>
            <dt>Municipal API</dt>
            <dd>
              <code>GET /api/b2g/work-orders</code> with header <code>X-API-Key</code> returns open work orders as JSON for a
              corporation’s own systems. Set the key with <code>SENTINEL_API_KEY</code>.
            </dd>
            <dt>Data export</dt>
            <dd><a href="/api/potholes/export.csv">Download all sites as CSV</a></dd>
          </dl>
        </div>
      </section>
    </div>
  )
}
