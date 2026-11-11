// Compares two stage timing runs of the same queries. Usage: bun scratch/compare-timing.mjs <before.jsonl> <after.jsonl>
import {readFileSync} from 'node:fs'
import {median, quantile, fmtMs, mdTable} from '../lib/stats.mjs'

const load = f => new Map(readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.id !== 'meta').map(r => [r.id, r]))
const [a, b] = process.argv.slice(2).map(load)
const med = q => q.runs.slice().sort((x, y) => x.ms - y.ms)[Math.floor(q.runs.length / 2)]
const rows = []
for (const [id, qa] of a) {
  const qb = b.get(id)
  if (!qb) continue
  const ra = med(qa), rb = med(qb)
  rows.push({id, kind: qa.kind, argv: qa.argv, msA: ra.ms, msB: rb.ms, candA: ra.answer?.candidates, candB: rb.answer?.candidates, scanA: ra.answer?.scanned, scanB: rb.answer?.scanned,
    totA: ra.answer?.total, totB: rb.answer?.total, compA: ra.answer?.complete, compB: rb.answer?.complete})
}
const sum = (f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0)
const out = []
out.push(`Queries ${rows.length}. Total time ${fmtMs(sum('msA'))} -> ${fmtMs(sum('msB'))}. Candidates ${sum('candA')} -> ${sum('candB')}. Files scanned ${sum('scanA')} -> ${sum('scanB')}.`)
out.push(mdTable(['kind', 'p50 before', 'p50 after', 'p90 before', 'p90 after', 'p99 before', 'p99 after', 'max before', 'max after'],
  ['regex', 'text'].map(k => {
    const v = rows.filter(r => r.kind === k)
    const q = (f, p) => fmtMs(quantile(v.map(r => r[f]), p))
    return [k, q('msA', 0.5), q('msB', 0.5), q('msA', 0.9), q('msB', 0.9), q('msA', 0.99), q('msB', 0.99), fmtMs(Math.max(...v.map(r => r.msA))), fmtMs(Math.max(...v.map(r => r.msB)))]
  })))
const changedCand = rows.filter(r => r.candA !== r.candB)
out.push('', `Candidates changed in ${changedCand.length} queries; more candidates after: ${changedCand.filter(r => r.candB > r.candA).length}.`)
// Correctness: a complete answer must keep its hit count.
const lost = rows.filter(r => r.compA && r.compB && r.totA !== r.totB)
const cutChanged = rows.filter(r => r.compA !== r.compB)
out.push(`Complete answers whose hit count changed: ${lost.length}. Answers whose completeness changed: ${cutChanged.length}.`)
for (const r of [...lost, ...cutChanged]) out.push(`- ${r.id} hits ${r.totA} (${r.compA}) -> ${r.totB} (${r.compB}) \`${JSON.stringify(r.argv).slice(0, 160)}\``)
out.push('', '## The largest changes of candidates', '')
for (const r of changedCand.sort((x, y) => (y.candA - y.candB) - (x.candA - x.candB)).slice(0, 15)) {
  out.push(`- ${r.id} ${r.kind}: candidates ${r.candA} -> ${r.candB}, scanned ${r.scanA} -> ${r.scanB}, ${fmtMs(r.msA)} -> ${fmtMs(r.msB)}, hits ${r.totA} -> ${r.totB} \`${JSON.stringify(r.argv).slice(0, 150)}\``)
}
console.log(out.join('\n'))
