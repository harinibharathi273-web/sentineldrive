import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const LiveContext = createContext(null)

// One WebSocket for the whole app plus the shared data it keeps fresh:
// pothole sites, incidents and headline stats.
export function LiveProvider({ children }) {
  const [connected, setConnected] = useState(false)
  const [driver, setDriver] = useState({ active: false })
  const [talkback, setTalkback] = useState(null)
  const [talkbackEvent, setTalkbackEvent] = useState(null) // last retry/done event
  const [siren, setSiren] = useState(null)
  const [potholes, setPotholes] = useState([])
  const [incidents, setIncidents] = useState([])
  const [stats, setStats] = useState(null)
  const [health, setHealth] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const wsRef = useRef(null)
  const statsTimer = useRef(0)

  const refreshStats = useCallback(() => {
    clearTimeout(statsTimer.current)
    statsTimer.current = setTimeout(() => api.stats().then(setStats).catch(() => {}), 300)
  }, [])

  const refreshAll = useCallback(async () => {
    try {
      const [p, i, s, h] = await Promise.all([api.potholes(), api.incidents(), api.stats(), api.health()])
      setPotholes(p)
      setIncidents(i)
      setStats(s)
      setHealth(h)
    } catch {
      /* backend offline; the connection banner says so */
    } finally {
      setLoaded(true)
    }
  }, [])

  const upsertPothole = useCallback((rec) => {
    setPotholes((list) => {
      const i = list.findIndex((p) => p.id === rec.id)
      if (i === -1) return [rec, ...list]
      const next = [...list]
      next[i] = rec
      return next
    })
  }, [])

  const upsertIncident = useCallback((rec) => {
    setIncidents((list) => {
      const i = list.findIndex((p) => p.id === rec.id)
      if (i === -1) return [rec, ...list]
      const next = [...list]
      next[i] = rec
      return next
    })
  }, [])

  useEffect(() => {
    let stopped = false
    let retry = 0
    let timer = 0

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        retry = 0
        setConnected(true)
        refreshAll()
      }
      ws.onclose = () => {
        setConnected(false)
        if (wsRef.current === ws) wsRef.current = null
        if (!stopped) timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++))
      }
      ws.onmessage = (ev) => {
        let m
        try {
          m = JSON.parse(ev.data)
        } catch {
          return
        }
        switch (m.type) {
          case 'hello':
            setDriver(m.driver || { active: false })
            setTalkback(m.talkback)
            setSiren(m.siren)
            break
          case 'driver':
            setDriver(m.driver)
            break
          case 'talkback':
            setTalkback(m.talkback)
            break
          case 'talkback_retry':
            setTalkback(m.talkback)
            setTalkbackEvent({ kind: 'retry', heard: m.heard, at: Date.now() })
            break
          case 'talkback_done':
            setTalkback(null)
            setTalkbackEvent({ kind: 'done', result: m.result, at: Date.now() })
            refreshStats()
            break
          case 'siren':
            setSiren(m.siren.status === 'active' ? m.siren : null)
            upsertIncident(m.siren)
            refreshStats()
            break
          case 'incident':
            upsertIncident(m.incident)
            refreshStats()
            break
          case 'pothole':
            if (m.action === 'deleted') setPotholes((l) => l.filter((p) => p.id !== m.id))
            else upsertPothole(m.pothole)
            refreshStats()
            break
          case 'refresh':
            refreshAll()
            break
          default:
        }
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      wsRef.current?.close()
    }
  }, [refreshAll, refreshStats, upsertIncident, upsertPothole])

  const send = useCallback((obj) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
      return true
    }
    return false
  }, [])

  const value = {
    connected, send, driver, talkback, talkbackEvent, siren, potholes, incidents, stats, health, loaded,
    refreshAll, upsertPothole, upsertIncident,
  }
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export const useLive = () => useContext(LiveContext)
