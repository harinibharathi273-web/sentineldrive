import { useMemo, useState } from 'react'
import { Car, Check, Siren, TriangleAlert } from 'lucide-react'
import { useLive } from '../hooks/useLive'
import MapView from '../components/MapView'
import { DailyBars } from '../components/Charts'
import { Empty, Severity, useTick } from '../components/bits'
import { compactMoney, money, place, STATUS_LABEL, when } from '../lib/format'

const OPEN = ['reported', 'verified', 'scheduled']

export default function Overview({ openSite, openReport }) {
  useTick()
  const { potholes, incidents, stats } = useLive()
  const [selected, setSelected] = useState(null)
  const open = useMemo(
    () => potholes.filter((p) => OPEN.includes(p.status)).sort((a, b) => b.priority - a.priority),
    [potholes],
  )
  const crashes = incidents.filter((i) => i.kind === 'crash')
  const p = stats?.potholes
  const inc = stats?.incidents_30d

  const activity = useMemo(() => {
    const items = []
    for (const s of potholes) {
      for (const h of s.history) items.push({ ts: h.ts, icon: h.status === 'repaired' ? Check : TriangleAlert, text: `${s.id} ${STATUS_LABEL[h.status].toLowerCase()}`, sub: place(s), id: s.id })
    }
    for (const i of incidents) {
      if (i.kind === 'crash') items.push({ ts: i.created_at, icon: Car, text: i.verified ? 'Crash detected' : 'Impact checked, not a crash', sub: i.reason })
      if (i.kind === 'siren') items.push({ ts: i.created_at, icon: Siren, text: 'Emergency vehicle heard', sub: i.guidance })
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 8)
  }, [potholes, incidents])

  return (
    <>
      <section className="kpis" aria-label="Summary">
        <div className="kpi">
          <div className="label">Open sites</div>
          <div className="value">{p?.open ?? '—'}</div>
          <div className="sub">{p ? `${p.open_potholes} potholes in total` : ' '}</div>
        </div>
        <div className="kpi">
          <div className="label">High severity</div>
          <div className="value" style={{ color: p?.open_by_severity.high ? 'var(--high)' : undefined }}>{p?.open_by_severity.high ?? '—'}</div>
          <div className="sub">{p ? `${p.open_by_severity.medium} medium, ${p.open_by_severity.low} low` : ' '}</div>
        </div>
        <div className="kpi">
          <div className="label">Estimated repair cost</div>
          <div className="value">{p ? compactMoney(p.open_estimate) : '—'}</div>
          <div className="sub">Open sites, incl. GST</div>
        </div>
        <div className="kpi">
          <div className="label">Repaired</div>
          <div className="value">{p?.by_status.repaired ?? '—'}</div>
          <div className="sub">{p ? `${p.by_status.scheduled} scheduled now` : ' '}</div>
        </div>
        <div className="kpi">
          <div className="label">Crashes, last 30 days</div>
          <div className="value">{inc?.crashes_verified ?? '—'}</div>
          <div className="sub">{inc ? `${inc.crashes_suppressed} false alarms filtered` : ' '}</div>
        </div>
      </section>

      <div className="grid-2">
        <div className="stack">
          <MapView
            sites={potholes}
            crashes={crashes}
            selectedId={selected}
            onSelect={(id) => {
              setSelected(id)
              openSite(id)
            }}
            emptyText={
              <>
                <strong>No locations yet</strong>
                <p className="muted small">Reports with GPS appear here.</p>
              </>
            }
          />
          <section className="panel">
            <div className="panel-head">
              <h2>Reported and repaired</h2>
              <div className="aside legend">
                <span><i style={{ background: 'var(--series-1)' }} />Reported</span>
                <span><i style={{ background: 'var(--series-2)' }} />Repaired</span>
              </div>
            </div>
            <div className="panel-body">{stats ? <DailyBars data={stats.daily} /> : <div style={{ height: 170 }} />}</div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Repair queue</h2>
              <span className="aside">Highest priority first</span>
            </div>
            {open.length === 0 ? (
              <Empty title="Nothing waiting for repair" action={<button className="btn btn-primary" onClick={openReport}>Report a pothole</button>}>
                Upload a road photo or dashcam clip to start.
              </Empty>
            ) : (
              <ul className="queue">
                {open.slice(0, 7).map((s) => (
                  <li key={s.id}>
                    <button onClick={() => openSite(s.id)} onMouseEnter={() => setSelected(s.id)}>
                      <span className={`prio ${s.severity}`} title="Priority score">{s.priority}</span>
                      <span style={{ minWidth: 0 }}>
                        <div className="where">{place(s)}</div>
                        <div className="meta">
                          {s.id}, {s.count} pothole{s.count === 1 ? '' : 's'}, {when(s.created_at)}
                        </div>
                      </span>
                      <span>
                        <div className="amount">{money(s.estimate?.total)}</div>
                        <div style={{ textAlign: 'right' }}><Severity level={s.severity} /></div>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {open.length > 7 && (
              <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)' }}>
                <a href="#/defects">See all {open.length} open sites</a>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Recent activity</h2>
            </div>
            {activity.length === 0 ? (
              <Empty>Reports, repairs, crashes and sirens will be listed here as they happen.</Empty>
            ) : (
              <ul className="feed">
                {activity.map((a, i) => {
                  const Icon = a.icon
                  return (
                    <li key={i}>
                      <Icon size={16} />
                      <div style={{ minWidth: 0 }}>
                        <div>{a.id ? <a href="#/defects" onClick={(e) => { e.preventDefault(); openSite(a.id) }}>{a.text}</a> : a.text}</div>
                        <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.sub}</div>
                      </div>
                      <time>{when(a.ts)}</time>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
