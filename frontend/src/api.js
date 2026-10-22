async function req(path, opts = {}) {
  const res = await fetch(path, opts)
  const isJson = (res.headers.get('content-type') || '').includes('json')
  const body = isJson ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = (isJson && (body.detail || body.message)) || `Request failed (${res.status})`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return body
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  health: () => req('/api/health'),
  stats: () => req('/api/stats'),
  potholes: () => req('/api/potholes'),
  pothole: (id) => req(`/api/potholes/${id}`),
  updatePothole: (id, body) => req(`/api/potholes/${id}`, json('PATCH', body)),
  deletePothole: (id) => req(`/api/potholes/${id}`, { method: 'DELETE' }),
  upload: (form) => req('/api/potholes/upload', { method: 'POST', body: form }),
  incidents: () => req('/api/incidents'),
  resolveIncident: (id) => req(`/api/incidents/${id}/resolve`, { method: 'POST' }),
  checks: () => req('/api/alertness-checks'),
  rateCard: () => req('/api/settings/rate-card'),
  saveRateCard: (v) => req('/api/settings/rate-card', json('PUT', v)),
  recalculate: () => req('/api/potholes/recalculate', { method: 'POST' }),
  prefs: () => req('/api/settings/preferences'),
  savePrefs: (v) => req('/api/settings/preferences', json('PUT', v)),
}

export const workOrderUrl = (id) => `/api/potholes/${id}/work-order.pdf`
