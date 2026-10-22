import { useMemo, useState } from 'react'
import { Download, List, Map as MapIcon } from 'lucide-react'
import { useLive } from '../hooks/useLive'
import MapView from '../components/MapView'
import { Empty, Severity, Status, useTick } from '../components/bits'
import { money, place, when } from '../lib/format'

const FILTERS = [
  ['open', 'Open', (s) => ['reported', 'verified', 'scheduled'].includes(s)],
  ['reported', 'New', (s) => s === 'reported'],
  ['scheduled', 'Scheduled', (s) => s === 'scheduled'],
  ['repaired', 'Repaired', (s) => s === 'repaired'],
  ['all', 'All', () => true],
]
const SORTS = {
  priority: (a, b) => b.priority - a.priority,
  newest: (a, b) => b.created_at - a.created_at,
  cost: (a, b) => (b.estimate?.total || 0) - (a.estimate?.total || 0),
}

export default function Defects({ openSite, openReport }) {
  useTick()
  const { potholes, loaded } = useLive()
  const [filter, setFilter] = useState('open')
  const [sev, setSev] = useState('any')
  const [sort, setSort] = useState('priority')
  const [view, setView] = useState('list')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x[0] === filter)[2]
    const needle = q.trim().toLowerCase()
    return potholes
      .filter((p) => f(p.status) && (sev === 'any' || p.severity === sev))
      .filter((p) => !needle || `${p.id} ${place(p)} ${p.jurisdiction?.ward || ''}`.toLowerCase().includes(needle))
      .sort(SORTS[sort])
  }, [potholes, filter, sev, sort, q])

  const counts = Object.fromEntries(FILTERS.map(([k, , f]) => [k, potholes.filter((p) => f(p.status)).length]))
  const total = rows.reduce((s, r) => s + (r.estimate?.total || 0), 0)

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Status">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)} role="tab" aria-selected={filter === k}>
              {label}
              <span className="n">{counts[k]}</span>
            </button>
          ))}
        </div>
        <select value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity">
          <option value="any">Any severity</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="priority">Highest priority</option>
          <option value="newest">Newest</option>
          <option value="cost">Highest cost</option>
        </select>
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search street, ward or ID" style={{ width: 200 }} />
        <span className="spacer" />
        <div className="seg" aria-label="View">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}><List size={15} /> List</button>
          <button className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}><MapIcon size={15} /> Map</button>
        </div>
      </div>

      {view === 'map' ? (
        <MapView sites={rows} onSelect={openSite} className="tall" emptyText="None of these sites has a location yet." />
      ) : (
        <section className="panel">
          {rows.length === 0 ? (
            loaded && (
              <Empty
                title={potholes.length ? 'No sites match these filters' : 'No potholes reported yet'}
                action={!potholes.length && <button className="btn btn-primary" onClick={openReport}>Report a pothole</button>}
              >
                {potholes.length ? 'Try another status or severity.' : 'Upload a road photo or a dashcam clip and the potholes in it are found, sized and costed.'}
              </Empty>
            )
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="hide-sm">Photo</th>
                    <th>Location</th>
                    <th>Severity</th>
                    <th className="r">Priority</th>
                    <th className="r hide-sm">Potholes</th>
                    <th className="r">Estimate</th>
                    <th>Status</th>
                    <th className="hide-sm">Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} onClick={() => openSite(s.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openSite(s.id)}>
                      <td className="hide-sm"><img className="thumb" src={s.evidence[s.evidence.length - 1].annotated} alt="" loading="lazy" /></td>
                      <td style={{ maxWidth: 320 }}>
                        <div className="cell-main" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{place(s)}</div>
                        <div className="cell-sub">
                          {s.id}
                          {s.jurisdiction?.ward ? `, ${s.jurisdiction.ward}` : ''}
                          {s.reports > 1 ? `, ${s.reports} reports` : ''}
                        </div>
                      </td>
                      <td><Severity level={s.severity} /></td>
                      <td className="r">{s.priority}</td>
                      <td className="r hide-sm">{s.count}</td>
                      <td className="r">{money(s.estimate?.total)}</td>
                      <td><Status status={s.status} /></td>
                      <td className="hide-sm cell-sub">{when(s.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > 0 && (
            <div style={{ padding: '10px 14px', display: 'flex', fontSize: 13, color: 'var(--muted)' }}>
              {rows.length} site{rows.length === 1 ? '' : 's'}
              <span style={{ marginLeft: 'auto' }}>Total estimate {money(total)}</span>
              <a href="/api/potholes/export.csv" style={{ marginLeft: 16, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <Download size={14} /> Export CSV
              </a>
            </div>
          )}
        </section>
      )}
    </>
  )
}
