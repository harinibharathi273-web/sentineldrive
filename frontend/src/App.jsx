import { useCallback, useEffect, useState } from 'react'
import { Activity, Gauge, LayoutDashboard, Plus, Settings as SettingsIcon, TriangleAlert } from 'lucide-react'
import { LiveProvider, useLive } from './hooks/useLive'
import { SensorsProvider, useSensors } from './hooks/useSensors'
import { AlertnessOverlay, CrashOverlay, SirenBanner } from './components/Overlays'
import ReportDialog from './components/ReportDialog'
import SiteDrawer from './components/SiteDrawer'
import { Toaster } from './components/bits'
import Overview from './pages/Overview'
import Defects from './pages/Defects'
import Driver from './pages/Driver'
import Incidents from './pages/Incidents'
import Settings from './pages/Settings'

const PAGES = {
  overview: { title: 'Overview', sub: 'Road defects and safety events across your area', icon: LayoutDashboard, el: Overview },
  defects: { title: 'Road defects', sub: 'Every reported pothole site, from report to repair', icon: TriangleAlert, el: Defects },
  driver: { title: 'Driver monitor', sub: 'Live alertness from this device’s camera', icon: Gauge, el: Driver },
  incidents: { title: 'Incidents', sub: 'Crash detections and emergency vehicles', icon: Activity, el: Incidents },
  settings: { title: 'Settings', sub: 'Repair rates, emergency contact and system status', icon: SettingsIcon, el: Settings },
}

function useRoute() {
  const read = () => {
    const k = location.hash.replace(/^#\/?/, '').split('/')[0]
    return PAGES[k] ? k : 'overview'
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => setRoute(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

const STATE_TEXT = {
  off: 'Off', starting: 'Starting', loading: 'Loading model', live: 'Live', waiting: 'Waiting',
  blocked: 'Blocked', missing: 'Not found', unsupported: 'Unavailable', error: 'Error',
}
const dotClass = (s) => (s === 'live' ? 'live' : ['blocked', 'error', 'missing'].includes(s) ? 'bad' : ['off', 'unsupported'].includes(s) ? '' : 'warn')

function VehiclePanel() {
  const s = useSensors()
  const { connected } = useLive()
  const rows = [
    ['Camera', s.camera],
    ['Microphone', s.mic],
    ['Motion sensor', s.motion],
    ['Location', s.gps.state, s.gps.state === 'live' && s.gps.accuracy ? `±${Math.round(s.gps.accuracy)} m` : null],
  ]
  return (
    <div className="vehicle">
      <h3>This device</h3>
      <p>{s.running ? 'Monitoring the driver and the road.' : 'Use a phone on the dashboard for crash and siren detection.'}</p>
      {s.running && (
        <ul className="sensor-list">
          {rows.map(([k, v, extra]) => (
            <li key={k}>
              <span className={`dot ${dotClass(v)}`} />
              {k}
              <span className="state">{extra || STATE_TEXT[v] || v}</span>
            </li>
          ))}
        </ul>
      )}
      {s.running ? (
        <button className="btn btn-block" onClick={s.stop}>Stop monitoring</button>
      ) : (
        <button className="btn btn-primary btn-block" onClick={s.start}>Start monitoring</button>
      )}
      {s.error && <p style={{ color: '#f0a29c', marginTop: 8 }}>{s.error}</p>}
      <div className="conn">
        <span className={`dot ${connected ? 'live' : 'bad'}`} />
        {connected ? 'Connected to server' : 'Reconnecting to server…'}
      </div>
    </div>
  )
}

function Shell() {
  const route = useRoute()
  const { potholes, incidents, connected, loaded } = useLive()
  const sensors = useSensors()
  const [reporting, setReporting] = useState(false)
  const [siteId, setSiteId] = useState(null)
  const Page = PAGES[route].el
  const openSite = useCallback((id) => {
    setReporting(false)
    setSiteId(id)
  }, [])

  const openCount = potholes.filter((p) => ['reported', 'verified', 'scheduled'].includes(p.status)).length
  const activeIncidents = incidents.filter((i) => ['awaiting_driver', 'escalated'].includes(i.status)).length

  useEffect(() => {
    document.title = `${PAGES[route].title} – SentinelDrive`
    setSiteId(null)
  }, [route])

  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">SentinelDrive</div>
            <div className="brand-sub">Road safety operations</div>
          </div>
        </div>
        <div className="nav">
          {Object.entries(PAGES).map(([k, p]) => {
            const Icon = p.icon
            const count = k === 'defects' ? openCount : k === 'incidents' ? activeIncidents : null
            return (
              <a key={k} href={`#/${k}`} className={route === k ? 'active' : ''} aria-current={route === k ? 'page' : undefined}>
                <Icon size={18} />
                {p.title}
                {count ? <span className="count">{count}</span> : null}
              </a>
            )
          })}
        </div>
        <VehiclePanel />
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="titles">
            <h1>{PAGES[route].title}</h1>
            <p>{PAGES[route].sub}</p>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => setReporting(true)}>
              <Plus size={17} /> Report a pothole
            </button>
          </div>
        </header>
        <main className="content">
          {!connected && loaded && (
            <div className="note error" style={{ marginBottom: 16 }}>
              Cannot reach the SentinelDrive server. Check that the backend is running (see README), then this page reconnects by itself.
            </div>
          )}
          <Page openSite={openSite} openReport={() => setReporting(true)} />
        </main>
      </div>

      {reporting && <ReportDialog onClose={() => setReporting(false)} onOpenSite={openSite} />}
      {siteId && <SiteDrawer id={siteId} onClose={() => setSiteId(null)} />}
      {sensors.running && (
        <>
          <SirenBanner />
          <CrashOverlay />
          <AlertnessOverlay />
        </>
      )}
      <Toaster />
    </div>
  )
}

export default function App() {
  return (
    <LiveProvider>
      <SensorsProvider>
        <Shell />
      </SensorsProvider>
    </LiveProvider>
  )
}
