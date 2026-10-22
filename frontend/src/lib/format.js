const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })

export function money(v, currency = 'INR') {
  if (v == null) return '—'
  if (currency === 'INR') return inr.format(v)
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v)
}

export function compactMoney(v, currency = 'INR') {
  if (v == null) return '—'
  if (currency === 'INR') {
    if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
    if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`
  }
  return money(v, currency)
}

export function when(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const diff = (Date.now() - ts) / 1000
  if (diff < 45) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86400 && new Date().getDate() === d.getDate()) return `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function dateTime(ts) {
  return ts ? new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
}

export const coords = (lat, lng) => (lat == null ? null : `${lat.toFixed(5)}, ${lng.toFixed(5)}`)

export const place = (site) =>
  site?.address?.label || (site?.lat != null ? coords(site.lat, site.lng) : 'Location not recorded')

export const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '')

export const STATUS_LABEL = {
  reported: 'Reported',
  verified: 'Verified',
  scheduled: 'Repair scheduled',
  repaired: 'Repaired',
  rejected: 'Not a pothole',
}
