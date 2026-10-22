import { useState } from 'react'
import { Car, Siren } from 'lucide-react'
import { useLive } from '../hooks/useLive'
import { useSensors } from '../hooks/useSensors'
import MapView from '../components/MapView'
import { Empty, useTick } from '../components/bits'
import { coords, dateTime, when } from '../lib/format'

const CRASH_STATUS = {
  awaiting_driver: 'Waiting for driver',
  escalated: 'Escalated',
  driver_ok: 'Driver OK',
  resolved: 'Resolved',
  suppressed: 'Not a crash',
}

function Signal({ label, s, unit, fmt = (v) => v }) {
  return (
    <div className={`signal ${s.agree ? 'agree' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{s.available === false || s.value == null ? 'Not available' : `${fmt(s.value)} ${unit}`}</div>
      <div className="k">{s.agree ? 'Confirms impact' : `Needs ${s.threshold} ${unit}`}</div>
    </div>
  )
}

function CrashRow({ c }) {
  const [open, setOpen] = useState(false)
  return (
    <li style={{ display: 'block', padding: 0 }}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', gap: 10, width: '100%', padding: '12px 18px', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
      >
        <Car size={17} color={c.verified ? 'var(--high)' : 'var(--muted)'} />
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{c.verified ? 'Crash detected' : 'Impact, not a crash'}</strong>
            <span className={`status crash-${c.status}`}>{CRASH_STATUS[c.status] || c.status}</span>
          </div>
          <div className="muted small">{c.reason}</div>
        </div>
        <time className="muted small">{when(c.created_at)}</time>
      </button>
      {open && (
        <div style={{ padding: '0 18px 16px 50px', display: 'grid', gap: 12 }}>
          <div className="signals">
            <Signal label="Impact force" s={c.signals.g_force} unit="g" />
            <Signal label="Speed drop (GPS)" s={c.signals.speed_drop} unit="km/h" />
            <Signal label="Impact sound" s={c.signals.sound} unit="dB jump" />
          </div>
          <dl className="dl">
            <dt>Location</dt>
            <dd>{c.address?.label || (c.lat != null ? coords(c.lat, c.lng) : 'Not recorded (no GPS fix)')}</dd>
            {c.driver_state && (
              <>
                <dt>Driver before impact</dt>
                <dd>Alertness score {c.driver_state.score} ({c.driver_state.tier})</dd>
              </>
            )}
            <dt>Timeline</dt>
            <dd>{c.timeline.map((t) => `${new Date(t.ts).toLocaleTimeString()} ${t.event}`).join('; ')}</dd>
          </dl>
        </div>
      )}
    </li>
  )
}

export default function Incidents() {
  useTick()
  const { incidents, loaded } = useLive()
  const sensors = useSensors()
  const [kind, setKind] = useState('all')
  const crashes = incidents.filter((i) => i.kind === 'crash')
  const sirens = incidents.filter((i) => i.kind === 'siren')
  const list = incidents.filter((i) => kind === 'all' || i.kind === kind)

  return (
    <div className="grid-2">
      <section className="panel">
        <div className="panel-head">
          <div className="seg">
            <button className={kind === 'all' ? 'on' : ''} onClick={() => setKind('all')}>All<span className="n">{incidents.length}</span></button>
            <button className={kind === 'crash' ? 'on' : ''} onClick={() => setKind('crash')}>Crashes<span className="n">{crashes.length}</span></button>
            <button className={kind === 'siren' ? 'on' : ''} onClick={() => setKind('siren')}>Emergency vehicles<span className="n">{sirens.length}</span></button>
          </div>
        </div>
        {list.length === 0 ? (
          loaded && (
            <Empty title="No incidents recorded">
              Crash and siren detection run on a phone mounted in the vehicle with monitoring started.
              {sensors.running && sensors.motion !== 'live' ? ' This device has no motion sensor, so crashes cannot be detected here.' : ''}
            </Empty>
          )
        ) : (
          <ul className="feed">
            {list.map((i) =>
              i.kind === 'crash' ? (
                <CrashRow key={i.id} c={i} />
              ) : (
                <li key={i.id}>
                  <Siren size={17} />
                  <div>
                    <strong>Emergency vehicle {i.status === 'active' ? 'nearby now' : 'heard'}</strong>
                    <div className="muted small">
                      Siren pattern: {i.pattern || 'unknown'}, {Math.round(i.freq_min || 0)}–{Math.round(i.freq_max || 0)} Hz
                      {i.duration_s ? `, ${i.duration_s} s` : ''}. Driver told: “{i.guidance}”
                    </div>
                  </div>
                  <time>{dateTime(i.created_at)}</time>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
      <div className="stack">
        <MapView sites={[]} crashes={crashes} emptyText="Crash locations appear here when the phone had a GPS fix." />
        <section className="panel">
          <div className="section">
            <div className="section-head">
              <h3>How a crash is confirmed</h3>
              <p className="small">
                A phone bump is not a crash. An impact of 8 g or more counts on its own. Between 4 and 8 g, it also needs a sudden
                speed drop of 20 km/h or more from GPS, or a loud impact sound 20 dB above the cabin noise. The driver then has 20
                seconds to tap “I’m OK” before it is escalated.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
