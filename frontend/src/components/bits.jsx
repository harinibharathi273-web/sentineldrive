import { useEffect, useState } from 'react'
import { capital, STATUS_LABEL } from '../lib/format'

export function Severity({ level }) {
  if (!level) return null
  return (
    <span className={`sev ${level}`}>
      <i aria-hidden="true" />
      {capital(level)}
    </span>
  )
}

export function Status({ status }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status] || capital(status)}</span>
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      {title && <h3>{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

let toastSet = null
export function toast(msg) {
  toastSet?.(msg)
}
export function Toaster() {
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    toastSet = setMsg
    return () => {
      toastSet = null
    }
  }, [])
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 3200)
    return () => clearTimeout(t)
  }, [msg])
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null
}

// Re-render every `ms` so relative times ("3 min ago") stay current.
export function useTick(ms = 30_000) {
  const [, set] = useState(0)
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}
