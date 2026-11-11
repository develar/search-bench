// Stage timing of accio over replayed agent queries. Usage: bun run.mjs <accio binary> <repo> <out.jsonl> [reps]
import {appendFileSync, readFileSync} from 'node:fs'
import {loadavg} from 'node:os'
const [binsArg, repo, out, repsArg] = process.argv.slice(2)
const bins = binsArg.split(',')
const bin = bins[0]
const reps = Number(repsArg ?? 3)
const queries = readFileSync(new URL('queries.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const env = {...process.env, ACCIO_TIMING: '1'}
const run = (argv, b = bin) => {
  const t0 = performance.now()
  const p = Bun.spawnSync([b, ...argv], {cwd: repo, env, timeout: 180000})
  const ms = performance.now() - t0
  const stderr = p.stderr.toString()
  const stages = stderr.split('\n').filter(l => l.startsWith('timing-json: ')).map(l => JSON.parse(l.slice(13)))
  const timing = stderr.split('\n').filter(l => l.startsWith('timing: ') || l.startsWith('freshness: ')).map(l => l.slice(0, 200))
  let answer = null
  try { const j = JSON.parse(p.stdout.toString()); const o = Array.isArray(j) ? j[0] : j; answer = {total: o.total, complete: o.complete, candidates: o.candidates, scanned: o.scanned, hits: o.hits?.length, note: (o.note ?? '').slice(0, 200)} } catch {}
  return {ms, exit: p.exitCode, signal: p.signalCode ?? null, answer, stages, timing, err: answer ? undefined : stderr.slice(-300)}
}
const t0 = performance.now()
const idx = Bun.spawnSync([bin, 'index'], {cwd: repo, env})
console.error(`index ${((performance.now() - t0) / 1000).toFixed(1)} s, exit ${idx.exitCode}: ${idx.stderr.toString().split('\n').filter(l => !l.startsWith('timing')).slice(-3).join(' | ')}`)
appendFileSync(out, JSON.stringify({id: 'meta', indexMs: performance.now() - t0, load: loadavg(), version: Bun.spawnSync([bin, '--version']).stdout.toString().trim()}) + '\n')
let i = 0
for (const q of queries) {
  const argv = [...q.argv, '--format', 'json']
  // Every binary in turn per rep, the first of the turn alternating: the same load for each binary.
  const runsOf = bins.map(() => [])
  for (let r = 0; r <= reps; r++) {
    const order = bins.map((_, k) => k)
    if ((r + i) % 2) order.reverse()
    for (const k of order) runsOf[k].push(run(argv, bins[k]))
  }
  const runs = runsOf[0]
  appendFileSync(out, JSON.stringify({...q, load: loadavg()[0], warm: runs[0], runs: runs.slice(1), others: runsOf.slice(1).map(v => ({warm: v[0], runs: v.slice(1)}))}) + '\n')
  const med = runs.slice(1).map(x => x.ms).sort((a, b) => a - b)[Math.floor(reps / 2)]
  if (++i % 10 === 0 || med > 3000) console.error(`${q.id} ${q.kind} ${med.toFixed(0)} ms cand ${runs[1].answer?.candidates} scanned ${runs[1].answer?.scanned} load ${loadavg()[0].toFixed(1)} ${JSON.stringify(q.argv).slice(0, 100)}`)
}
console.error(`done ${i} queries in ${((performance.now() - t0) / 1000).toFixed(0)} s`)
