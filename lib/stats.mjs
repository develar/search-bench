export function quantile(values, q) {
  const v = values.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo] + (v[hi] - v[lo]) * (pos - lo)
}

export const median = v => quantile(v, 0.5)

export function groupBy(items, key) {
  const m = new Map()
  for (const it of items) {
    const k = typeof key === 'function' ? key(it) : it[key]
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(it)
  }
  return m
}

export function pct(part, total) {
  if (!total) return '–'
  return `${((100 * part) / total).toFixed(1)}%`
}

export function fmtMs(ms) {
  if (ms == null) return '–'
  if (ms >= 10000) return `${(ms / 1000).toFixed(0)} s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms)} ms`
}

export function fmtBytes(b) {
  if (b == null) return '–'
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${Math.round(b)} B`
}

export function mdTable(headers, rows) {
  const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n')
}

export function code(s, max = 160) {
  let t = String(s ?? '')
  if (t.length > max) t = t.slice(0, max) + '…'
  return '`' + t.replace(/`/g, 'ˋ').replace(/\|/g, '\\|') + '`'
}

// Seeded random numbers (mulberry32).
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sample(items, n, rand) {
  const a = items.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

export function isoWeek(ts) {
  const d = new Date(ts)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
