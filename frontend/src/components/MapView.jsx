import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { place } from '../lib/format'

const SEV_COLOR = { high: '#b3261e', medium: '#9a5a00', low: '#3b6e3b' }
const INDIA = [21.5, 79]

// Pothole sites (and optionally crash locations) on an OpenStreetMap base map.
// `pickMode` turns a click into onPick({lat, lng}) for setting a location.
export default function MapView({ sites = [], crashes = [], selectedId, onSelect, pickMode = false, onPick, className = '', emptyText }) {
  const el = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const fitted = useRef(false)
  const cb = useRef({})
  cb.current = { onSelect, onPick, pickMode }

  useEffect(() => {
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(INDIA, 5)
       L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    layer.current = L.layerGroup().addTo(m)
    m.on('click', (e) => {
      if (cb.current.pickMode) cb.current.onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng })
    })
    map.current = m
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      m.remove()
    }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m) return
    m.getContainer().style.cursor = pickMode ? 'crosshair' : ''
  }, [pickMode])

  useEffect(() => {
    const m = map.current
    const g = layer.current
    if (!m || !g) return
    g.clearLayers()
    const pts = []
    for (const s of sites) {
      if (s.lat == null) continue
      const sel = s.id === selectedId
      const radius = 6 + Math.min(10, Math.sqrt(s.count || 1) * 3)
      const mk = L.circleMarker([s.lat, s.lng], {
        radius: sel ? radius + 3 : radius,
        color: sel ? '#1c2124' : '#ffffff',
        weight: sel ? 3 : 2,
        fillColor: s.status === 'repaired' ? '#8a938f' : SEV_COLOR[s.severity] || '#687175',
        fillOpacity: s.status === 'repaired' ? 0.6 : 0.92,
      })
      mk.bindTooltip(`<strong>${s.id}</strong><br>${place(s)}<br>${s.count} pothole${s.count === 1 ? '' : 's'}, ${s.severity} severity`, { direction: 'top', offset: [0, -6] })
      mk.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        cb.current.onSelect?.(s.id)
      })
      mk.addTo(g)
      pts.push([s.lat, s.lng])
    }
    for (const c of crashes) {
      if (c.lat == null) continue
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:16px;height:16px;transform:rotate(45deg);background:${c.verified ? '#1c2124' : '#9aa3a0'};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      })
      L.marker([c.lat, c.lng], { icon })
        .bindTooltip(`<strong>${c.verified ? 'Crash' : 'Impact (not a crash)'}</strong><br>${c.reason}`, { direction: 'top' })
        .addTo(g)
      pts.push([c.lat, c.lng])
    }
    if (pts.length && !fitted.current) {
      fitted.current = true
      if (pts.length === 1) m.setView(pts[0], 16)
      else m.fitBounds(pts, { padding: [40, 40], maxZoom: 16 })
    }
  }, [sites, crashes, selectedId])

  useEffect(() => {
    const s = sites.find((x) => x.id === selectedId)
    if (s?.lat != null && map.current) map.current.panTo([s.lat, s.lng], { animate: true })
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const located = sites.some((s) => s.lat != null) || crashes.some((c) => c.lat != null)
  return (
    <div className={`map ${className}`}>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {pickMode && <div className="map-hint">Click the map where the pothole is</div>}
      {!located && !pickMode && emptyText && (
        <div className="map-empty">
          <div>{emptyText}</div>
        </div>
      )}
      {located && (
        <div className="map-legend" aria-label="Legend">
          <span className="sev high"><i />High</span>
          <span className="sev medium"><i />Medium</span>
          <span className="sev low"><i />Low</span>
          <span className="sev" style={{ color: '#687175' }}><i style={{ background: '#8a938f' }} />Repaired</span>
        </div>
      )}
    </div>
  )
}
