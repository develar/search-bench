// Analyzes the stage timing of accio (tmp-search-bench/run.mjs output).
// Usage: bun scratch/analyze-timing.mjs <results.jsonl> [K=64]
import {readFileSync} from 'node:fs'
import {median, quantile, mdTable, fmtMs, pct, groupBy} from '../lib/stats.mjs'

const [file, kArg] = process.argv.slice(2)
const K = Number(kArg ?? 64)
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const meta = rows.find(r => r.id === 'meta')
const qs = rows.filter(r => r.id !== 'meta')
const ms = ns => ns / 1e6

const per = qs.map(q => {
  const run = q.runs.slice().sort((a, b) => a.ms - b.ms)[Math.floor(q.runs.length / 2)]
  const cand = run.stages.filter(s => s.stage === 'candidates')
  const scan = run.stages.filter(s => s.stage === 'scan')
  const groups = cand.flatMap(c => c.groups)
  const whole = groups.reduce((s, g) => s + g.whole_ns, 0)
  const part = groups.reduce((s, g) => s + g.part_ns, 0)
  const candWall = cand.reduce((s, c) => s + c.wall_ns, 0)
  const scanWall = scan.reduce((s, c) => s + c.wall_ns, 0)
  const fresh = run.timing.map(l => /freshness check ([\d.]+)(µs|ms|s)/.exec(l)).filter(Boolean).map(m => Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'ms' ? 1 : 0.001))[0] ?? null
  // Early stop: the CPU of the groups after the first group whose `after` (summed over shards) is <= K.
  let saveStop = 0
  for (const c of cand) {
    const i = c.groups.findIndex(g => g.after <= K)
    if (i >= 0) for (const g of c.groups.slice(i + 1)) saveStop += g.whole_ns + g.part_ns + g.intersect_ns
  }
  // Rarest first: when the group with the smallest df has df <= K, every other group is skipped.
  let saveRare = 0
  for (const c of cand) {
    if (c.groups.length < 2) continue
    const rare = c.groups.reduce((a, b) => (b.df < a.df ? b : a))
    if (rare.df <= K) for (const g of c.groups) if (g !== rare) saveRare += g.whole_ns + g.part_ns + g.intersect_ns
  }
  return {
    id: q.id, kind: q.kind, origin: q.origin, argv: q.argv, ms: run.ms, exit: run.exit, signal: run.signal,
    candidates: run.answer?.candidates ?? null, scanned: run.answer?.scanned ?? null, total: run.answer?.total ?? null,
    candWall: ms(candWall), scanWall: ms(scanWall), wholeCpu: ms(whole), partCpu: ms(part), parts: groups.reduce((s, g) => s + g.part, 0),
    bytes: scan.reduce((s, c) => s + c.bytes, 0), readCpu: ms(scan.reduce((s, c) => s + c.read_ns, 0)), fresh,
    other: run.ms - ms(candWall) - ms(scanWall), saveStop: ms(saveStop), saveRare: ms(saveRare),
    groups: cand.map(c => c.groups.map(g => `${g.fragments.join('|')} df=${g.df} after=${g.after} ${(ms(g.whole_ns + g.part_ns)).toFixed(0)}ms`).join(' → ')).join(' ;; '),
  }
})

const out = []
out.push(`# accio stage timing`, '', `Queries ${per.length}. ${meta?.version}. Index step ${fmtMs(meta?.indexMs)}. Load at start ${meta?.load?.map(x => x.toFixed(1)).join(' ')}. K = ${K}.`, '')
const sum = (v, f) => v.reduce((s, x) => s + (x[f] ?? 0), 0)
out.push(mdTable(['kind', 'n', 'p50', 'p90', 'p99', 'max', 'cand wall p50', 'cand wall p90', 'scan wall p50', 'scan wall p90', 'other p50', 'Part CPU share of lookups'],
  [...groupBy(per, 'kind')].map(([k, v]) => [k, v.length, fmtMs(median(v.map(x => x.ms))), fmtMs(quantile(v.map(x => x.ms), 0.9)), fmtMs(quantile(v.map(x => x.ms), 0.99)), fmtMs(Math.max(...v.map(x => x.ms))),
    fmtMs(median(v.map(x => x.candWall))), fmtMs(quantile(v.map(x => x.candWall), 0.9)), fmtMs(median(v.map(x => x.scanWall))), fmtMs(quantile(v.map(x => x.scanWall), 0.9)),
    fmtMs(median(v.map(x => x.other))), pct(sum(v, 'partCpu'), sum(v, 'partCpu') + sum(v, 'wholeCpu'))])))
out.push('', `Wall time split over all queries: candidates ${fmtMs(sum(per, 'candWall'))}, scan ${fmtMs(sum(per, 'scanWall'))}, the rest (process start, freshness, notes, output) ${fmtMs(sum(per, 'other'))}, total ${fmtMs(sum(per, 'ms'))}.`)
out.push(`Lookup CPU: Whole ${fmtMs(sum(per, 'wholeCpu'))}, Part ${fmtMs(sum(per, 'partCpu'))} (${sum(per, 'parts')} Part lookups over shards). Read CPU ${fmtMs(sum(per, 'readCpu'))}, bytes read ${(sum(per, 'bytes') / 1e9).toFixed(2)} GB.`)
out.push(`Lookup CPU that the planner would skip: stop at <= ${K} candidates ${fmtMs(sum(per, 'saveStop'))}, rarest group first ${fmtMs(sum(per, 'saveRare'))}.`)
out.push(`Freshness check p50 ${fmtMs(median(per.map(x => x.fresh)))}, p90 ${fmtMs(quantile(per.map(x => x.fresh), 0.9))}. Failed or killed runs: ${per.filter(x => x.exit !== 0 || x.signal).length}.`)
out.push('', '## The 25 slowest', '')
for (const x of per.sort((a, b) => b.ms - a.ms).slice(0, 25)) {
  out.push(`- ${x.id} ${x.kind}/${x.origin} ${fmtMs(x.ms)}: cand ${fmtMs(x.candWall)} (Part CPU ${fmtMs(x.partCpu)}, Whole CPU ${fmtMs(x.wholeCpu)}), scan ${fmtMs(x.scanWall)} ${x.scanned}/${x.candidates} files ${(x.bytes / 1e6).toFixed(0)} MB, rest ${fmtMs(x.other)}, hits ${x.total} \`${JSON.stringify(x.argv).slice(0, 140)}\``)
  out.push(`  - ${x.groups.slice(0, 400)}`)
}
console.log(out.join('\n'))
