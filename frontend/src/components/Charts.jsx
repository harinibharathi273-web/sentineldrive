import { useRef, useState } from 'react'

function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(600)
  const set = (el) => {
    if (!el || ref.current === el) return
    ref.current = el
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)))
    ro.observe(el)
  }
  return [set, w]
}

// Grouped daily bars: reported vs repaired sites.
export function DailyBars({ data }) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState(null)
  const H = 170
  const pad = { l: 28, r: 6, t: 8, b: 22 }
  const max = Math.max(2, ...data.flatMap((d) => [d.reported, d.repaired]))
  const step = Math.ceil(max / 4)
  const top = step * 4
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const slot = iw / data.length
  const bw = Math.max(3, Math.min(14, (slot - 6) / 2 - 1))
  const y = (v) => pad.t + ih - (v / top) * ih
  const bar = (x, v, fill) => {
    const h = Math.max(0, (v / top) * ih)
    if (h <= 0) return null
    const r = Math.min(3, h)
    const yy = pad.t + ih - h
    return <path d={`M${x},${pad.t + ih} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${pad.t + ih} Z`} fill={fill} />
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg className="chart" width={W} height={H} role="img" aria-label="Pothole sites reported and repaired per day, last 14 days">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(i * step)} y2={y(i * step)} />
            <text x={pad.l - 6} y={y(i * step) + 4} textAnchor="end">{i * step}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.l + i * slot + slot / 2 - bw - 1
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill={hover === i ? 'rgba(0,0,0,0.035)' : 'transparent'} />
              {bar(x0, d.reported, 'var(--series-1)')}
              {bar(x0 + bw + 2, d.repaired, 'var(--series-2)')}
              {(i % 2 === 1 || data.length <= 7) && (
                <text x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle">{d.day}</text>
              )}
            </g>
          )
        })}
        <line className="axis" x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} />
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: pad.l + hover * slot + slot / 2, top: pad.t + 10 }}>
          {data[hover].day}: {data[hover].reported} reported, {data[hover].repaired} repaired
        </div>
      )}
    </div>
  )
}

// Alertness score over the last few minutes, with the alert zones shaded.
export function ScoreLine({ points, windowMs = 180_000 }) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState(null)
  const H = 150
  const pad = { l: 24, r: 8, t: 6, b: 20 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const now = points.length ? points[points.length - 1].t : Date.now()
  const x = (t) => pad.l + iw - ((now - t) / windowMs) * iw
  const y = (v) => pad.t + ih - (v / 10) * ih
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')
  const onMove = (e) => {
    if (!points.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = now - ((pad.l + iw - (e.clientX - rect.left)) / iw) * windowMs
    let best = points[0]
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    setHover(best)
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg className="chart" width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Alertness score, last three minutes">
        <rect x={pad.l} y={y(10)} width={iw} height={y(8) - y(10)} fill="#fbeceb" />
        <rect x={pad.l} y={y(8)} width={iw} height={y(5) - y(8)} fill="#fdf3e2" />
        {[0, 5, 8, 10].map((v) => (
          <g key={v}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">{v}</text>
          </g>
        ))}
        <text x={pad.l} y={H - 4}>3 min ago</text>
        <text x={W - pad.r} y={H - 4} textAnchor="end">now</text>
        {d && <path d={d} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {hover && (
          <>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={pad.t} y2={pad.t + ih} stroke="var(--line-strong)" />
            <circle cx={x(hover.t)} cy={y(hover.score)} r="4.5" fill="var(--series-1)" stroke="#fff" strokeWidth="2" />
          </>
        )}
      </svg>
      {hover && (
        <div className="tip" style={{ left: x(hover.t), top: y(hover.score) }}>
          {hover.score.toFixed(1)} at {new Date(hover.t).toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}
