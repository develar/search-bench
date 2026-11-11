#!/usr/bin/env bun
// Step 2: what and how the agents asked. Reads data/calls.jsonl, writes report/history.md.
//
// Usage: bun 2-history.mjs [--repo idea|all] [--seed 1]
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {readJsonl} from './lib/jsonl.mjs'
import {code, fmtBytes, fmtMs, groupBy, isoWeek, mdTable, median, pct, quantile, rng, sample} from './lib/stats.mjs'
import {limitOf, queryOf, regexFeatures, scopesOf} from './lib/query.mjs'

const HERE = import.meta.dir
const {values: opts} = parseArgs({
  options: {
    repo: {type: 'string', default: 'idea'},
    seed: {type: 'string', default: '1'},
    in: {type: 'string', default: join(HERE, 'data/calls.jsonl')},
    out: {type: 'string', default: join(HERE, 'report/history.md')},
  },
})

let calls = await readJsonl(opts.in)
if (opts.repo !== 'all') calls = calls.filter(c => c.repo === opts.repo)
const rand = rng(Number(opts.seed))
const key = c => `${c.tool} ${c.kind}`
const KIND_ORDER = ['text', 'regex', 'file', 'symbol', 'references', 'semantic', 'context', 'implementations', 'trace', 'impact', 'tests']
const sortKeys = keys => keys.sort((a, b) => {
  const [ta, ka] = a.split(' ')
  const [tb, kb] = b.split(' ')
  return ta === tb ? KIND_ORDER.indexOf(ka) - KIND_ORDER.indexOf(kb) : ta.localeCompare(tb)
})
const byKey = groupBy(calls, key)
const keys = sortKeys([...byKey.keys()])
const md = []
const h = s => md.push('', s, '')

md.push(`# Search history: ij-proxy and accio`)
md.push('')
md.push(`Source: \`${opts.in}\`, repo \`${opts.repo}\`. Calls: ${calls.length}. Sessions: ${new Set(calls.map(c => c.session)).size}.`)
const span = calls.map(c => c.tsStart).filter(Boolean).sort()
md.push(`Period: ${span[0]?.slice(0, 10)} to ${span.at(-1)?.slice(0, 10)}. Subagent calls: ${pct(calls.filter(c => c.sidechain).length, calls.length)}.`)

// --- volume
h('## Volume')
md.push(mdTable(['tool kind', 'calls', 'sessions', 'subagent'], keys.map(k => {
  const v = byKey.get(k)
  return [k, v.length, new Set(v.map(c => c.session)).size, pct(v.filter(c => c.sidechain).length, v.length)]
})))
h('### By week')
const weeks = [...groupBy(calls.filter(c => c.tsStart), c => isoWeek(c.tsStart)).entries()].sort((a, b) => a[0].localeCompare(b[0]))
md.push(mdTable(['week', 'ijproxy', 'accio'], weeks.map(([w, v]) => [w, v.filter(c => c.tool === 'ijproxy').length, v.filter(c => c.tool === 'accio').length])))
h('### By project')
const projects = [...groupBy(calls, 'project').entries()].sort((a, b) => b[1].length - a[1].length)
md.push(mdTable(['project', 'ijproxy', 'accio'], projects.slice(0, 15).map(([p, v]) => [p, v.filter(c => c.tool === 'ijproxy').length, v.filter(c => c.tool === 'accio').length])))

// --- arguments
h('## Arguments')
md.push(mdTable(['tool kind', 'scoped', 'scopes p50', 'with `!` exclude', 'limit set', 'limit p50', 'limit p90', 'top limits'], keys.map(k => {
  const v = byKey.get(k)
  const scoped = v.filter(c => scopesOf(c).length)
  const limits = v.map(limitOf).filter(x => x != null)
  const top = [...groupBy(limits, x => x).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4).map(([l, n]) => `${l}×${n.length}`).join(', ')
  return [k, pct(scoped.length, v.length), median(scoped.map(c => scopesOf(c).length)) ?? '–',
    pct(v.filter(c => scopesOf(c).some(s => s.startsWith('!'))).length, v.length),
    pct(limits.length, v.length), quantile(limits, 0.5) ?? '–', quantile(limits, 0.9) ?? '–', top]
})))

h('### Regex features')
const regexCalls = calls.filter(c => c.kind === 'regex')
const feats = ['inlineCase', 'alternation', 'wordBoundary', 'lookaround', 'backref', 'dotStar', 'anchors', 'multiline', 'metaFree']
md.push(mdTable(['tool', 'calls', ...feats], [...groupBy(regexCalls, 'tool').entries()].map(([t, v]) => {
  const f = v.map(c => regexFeatures(queryOf(c)))
  return [t, v.length, ...feats.map(n => pct(f.filter(x => x[n]).length, v.length))]
})))
md.push('')
md.push('`metaFree` is a regex search without a regex metacharacter: a literal search in the regex tool.')
md.push('`lookaround` and `backref` work in the IDE (Java regex) only; accio (Rust regex) rejects them.')

h('### Text queries')
const textCalls = calls.filter(c => c.kind === 'text')
md.push(mdTable(['tool', 'calls', 'has space', 'has uppercase', 'all lowercase', 'length p50', 'length p90'], [...groupBy(textCalls, 'tool').entries()].map(([t, v]) => {
  const q = v.map(queryOf)
  return [t, v.length, pct(q.filter(s => s.includes(' ')).length, v.length), pct(q.filter(s => /[A-Z]/.test(s)).length, v.length),
    pct(q.filter(s => /[a-z]/.test(s) && !/[A-Z]/.test(s)).length, v.length), median(q.map(s => s.length)), quantile(q.map(s => s.length), 0.9)]
})))

h('### accio flags')
const ac = calls.filter(c => c.tool === 'accio')
const flagCount = new Map()
for (const c of ac) for (const f of Object.keys(c.args?.flags ?? {})) flagCount.set(f, (flagCount.get(f) ?? 0) + 1)
md.push(mdTable(['flag', 'calls', 'share'], [...flagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => [code(f), n, pct(n, ac.length)])))
md.push('')
md.push(`Piped into a filter (\`| head\` and so on): ${pct(ac.filter(c => c.piped).length, ac.length)}. ` +
  `Several queries or invocations in one Bash call: ${pct(ac.filter(c => c.multi).length, ac.length)}. ` +
  `Answer with an index refresh note: ${pct(ac.filter(c => c.refresh).length, ac.length)}.`)
const ij = calls.filter(c => c.tool === 'ijproxy')
md.push('')
md.push(`ij-proxy: \`include_external\` set in ${pct(ij.filter(c => c.args?.include_external).length, ij.filter(c => c.kind === 'symbol').length)} of the symbol calls; ` +
  `\`includeExcluded\` in ${pct(ij.filter(c => c.args?.includeExcluded).length, ij.filter(c => c.kind === 'file').length)} of the file calls.`)

// --- outcomes
h('## Outcomes')
md.push(mdTable(['tool kind', 'calls', 'zero hits', 'cut', 'IDE 10 s timeout', 'error', 'unparsed', 'followed by a read'], keys.map(k => {
  const v = byKey.get(k)
  const zero = v.filter(c => c.hits === 0)
  return [k, v.length, pct(zero.length, v.length), pct(v.filter(c => c.outcome === 'cut').length, v.length),
    pct(v.filter(c => c.outcome === 'timeout').length, v.length), pct(v.filter(c => c.outcome === 'error').length, v.length),
    pct(v.filter(c => c.outcome === 'unparsed' || c.outcome === 'missing').length, v.length),
    pct(v.filter(c => c.followups?.length).length, v.length)]
})))
md.push('')
md.push('"followed by a read": the agent read or edited a file in the next 8 tool calls.')
md.push('accio snippets often replace a Read. So a low share for accio does not mean a bad answer.')

h('### Top errors')
const errors = calls.filter(c => c.outcome === 'error' && c.error)
const errGroups = [...groupBy(errors, c => `${c.tool}: ${c.error.replace(/\d+/g, 'N').replace(/[`'"].*?[`'"]/g, '…').slice(0, 110)}`).entries()]
  .sort((a, b) => b[1].length - a[1].length).slice(0, 12)
md.push(mdTable(['error', 'calls'], errGroups.map(([e, v]) => [code(e, 140), v.length])))

h('### accio answer quality')
const aq = ac.filter(c => c.quality || c.complete != null)
md.push(mdTable(['kind', 'calls', 'exact', 'structural', 'heuristic', 'complete', 'partial', 'match=similar/none'], [...groupBy(aq, 'kind').entries()].map(([k, v]) => [
  k, v.length, pct(v.filter(c => c.quality === 'exact').length, v.length), pct(v.filter(c => c.quality === 'structural').length, v.length),
  pct(v.filter(c => c.quality === 'heuristic').length, v.length), pct(v.filter(c => c.complete === true).length, v.length),
  pct(v.filter(c => c.complete === false).length, v.length), pct(v.filter(c => c.match === 'similar' || c.match === 'none').length, v.length),
])))

// --- retry chains
h('## Retry chains')
md.push('A chain is a run of searches in one session where each search is followed by another search, with no other tool call between them.')
const chains = []
for (const [, v] of groupBy(calls.filter(c => c.tsStart), 'sessionFile')) {
  v.sort((a, b) => a.tsStart.localeCompare(b.tsStart))
  // Collapse the records of one Bash call.
  const seen = new Set()
  const seq = v.filter(c => (seen.has(c.callId) ? false : seen.add(c.callId)))
  let cur = []
  for (const c of seq) {
    cur.push(c)
    if (!c.next?.search) {
      if (cur.length >= 2) chains.push(cur)
      cur = []
    }
  }
  if (cur.length >= 2) chains.push(cur)
}
const chainTool = ch => (ch.every(c => c.tool === 'ijproxy') ? 'ijproxy' : ch.every(c => c.tool === 'accio') ? 'accio' : 'mixed')
md.push('')
md.push(mdTable(['tool', 'chains', 'length p50', 'length p90', 'max', 'searches in chains'], [...groupBy(chains, chainTool).entries()].map(([t, v]) => [
  t, v.length, median(v.map(x => x.length)), quantile(v.map(x => x.length), 0.9), Math.max(...v.map(x => x.length)), v.reduce((s, x) => s + x.length, 0),
])))
const zeroThenSearch = calls.filter(c => c.hits === 0 && c.next?.search)
md.push('')
md.push(`A zero-hit answer followed at once by another search: ij-proxy ${pct(zeroThenSearch.filter(c => c.tool === 'ijproxy').length, calls.filter(c => c.tool === 'ijproxy' && c.hits === 0).length)}, ` +
  `accio ${pct(zeroThenSearch.filter(c => c.tool === 'accio').length, calls.filter(c => c.tool === 'accio' && c.hits === 0).length)} of the zero-hit answers.`)
h('### The longest chains')
for (const ch of chains.sort((a, b) => b.length - a.length).slice(0, 6)) {
  md.push(`- ${ch.length} searches, \`${ch[0].project}\` ${ch[0].tsStart?.slice(0, 16)}:`)
  for (const c of ch.slice(0, 10)) md.push(`  - ${c.tool} ${c.kind} ${code(queryOf(c), 90)} ${scopesOf(c).length ? code(scopesOf(c).join(' '), 60) : ''} → ${c.hits ?? (c.hitsAtLeast != null ? `≥${c.hitsAtLeast}` : c.outcome)}`)
  if (ch.length > 10) md.push(`  - … ${ch.length - 10} more`)
}

// --- latency
h('## Latency from the timestamps')
md.push('The time from the assistant record to the tool result. It includes harness work, so it is an upper bound.')
md.push('"clean": one tool call in the message, no classifier permission check. accio: one query per Bash call, no other command than `cd` or a filter.')
md.push('')
const latRow = (k, v) => {
  const all = v.filter(c => c.latencyMs != null && c.latencyMs >= 0)
  const clean = all.filter(c => c.batchSize === 1 && c.permissionReason !== 'classifier' && !c.refresh)
  return [k, all.length, fmtMs(median(all.map(c => c.latencyMs))), clean.length, fmtMs(median(clean.map(c => c.latencyMs))),
    fmtMs(quantile(clean.map(c => c.latencyMs), 0.9)), fmtMs(quantile(clean.map(c => c.latencyMs), 0.99))]
}
md.push(mdTable(['tool kind', 'timed', 'p50 all', 'clean', 'p50 clean', 'p90 clean', 'p99 clean'], keys.map(k => latRow(k, byKey.get(k)))))
h('### accio self time')
md.push('accio before mid-October 2026 printed its own time in the header: the work in accio, without the process start and the harness.')
md.push('')
const selfRows = [...groupBy(ac.filter(c => c.selfMs != null), 'kind').entries()].map(([k, v]) => [
  k, v.length, fmtMs(median(v.map(c => c.selfMs))), fmtMs(quantile(v.map(c => c.selfMs), 0.9)), fmtMs(quantile(v.map(c => c.selfMs), 0.99)),
  pct(v.filter(c => c.selfMs >= 10000).length, v.length),
])
md.push(mdTable(['kind', 'calls', 'p50', 'p90', 'p99', '≥ 10 s'], selfRows))
md.push('')
const refreshCalls = ac.filter(c => c.refresh && c.latencyMs != null)
md.push('')
md.push(`accio answers with an index refresh note: ${refreshCalls.length}, latency p50 ${fmtMs(median(refreshCalls.map(c => c.latencyMs)))}, p90 ${fmtMs(quantile(refreshCalls.map(c => c.latencyMs), 0.9))}.`)
const perm = groupBy(calls.filter(c => c.latencyMs != null), c => `${c.tool} ${c.permissionReason ?? 'none'}`)
md.push('')
md.push(mdTable(['tool, permission reason', 'calls', 'p50'], [...perm.entries()].sort().map(([k, v]) => [k, v.length, fmtMs(median(v.map(c => c.latencyMs)))])))

// --- size
h('## Answer size')
md.push('The bytes of the tool result that the agent reads. accio sends snippets; ij-proxy sends coordinates only, and the agent reads the file after it.')
md.push('')
md.push(mdTable(['tool kind', 'p50 bytes', 'p90 bytes', 'p50 bytes per hit'], keys.map(k => {
  const v = byKey.get(k).filter(c => c.resultBytes != null)
  const perHit = v.filter(c => (c.hits ?? c.hitsAtLeast) > 0).map(c => c.resultBytes / (c.hits ?? c.hitsAtLeast))
  return [k, fmtBytes(median(v.map(c => c.resultBytes))), fmtBytes(quantile(v.map(c => c.resultBytes), 0.9)), fmtBytes(median(perHit))]
})))

// --- samples
h('## What the agents asked: samples')
for (const k of keys) {
  const v = byKey.get(k)
  if (v.length < 3) continue
  md.push('', `### ${k}`, '')
  for (const c of sample(v, 15, rand)) {
    const scopes = scopesOf(c)
    const res = c.hits ?? (c.hitsAtLeast != null ? `≥${c.hitsAtLeast}` : c.outcome)
    md.push(`- ${code(queryOf(c), 120)}${scopes.length ? ` in ${code(scopes.join(' '), 80)}` : ''}${limitOf(c) ? ` limit ${limitOf(c)}` : ''} → ${res}`)
  }
}

await Bun.write(opts.out, md.join('\n') + '\n')
console.log(`${calls.length} calls -> ${opts.out}`)
