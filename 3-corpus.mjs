#!/usr/bin/env bun
// Step 3: picks a stratified sample of historical queries and translates each one for the other tool.
// Output: data/corpus.jsonl (plain JSONL, edit it by hand if needed) and data/corpus-skips.json.
//
// Usage: bun 3-corpus.mjs [--seed 7] [--per-origin 20] [--accio-only 10]
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {readJsonl} from './lib/jsonl.mjs'
import {groupBy, rng, sample} from './lib/stats.mjs'
import {checkoutRoot} from './lib/paths.mjs'
import {translate} from './lib/translate.mjs'
import {loadUniverse} from './lib/universe.mjs'

const HERE = import.meta.dir
const {values: opts} = parseArgs({
  options: {
    seed: {type: 'string', default: '7'},
    'per-origin': {type: 'string', default: '20'},
    'accio-only': {type: 'string', default: '10'},
    in: {type: 'string', default: join(HERE, 'data/calls.jsonl')},
    out: {type: 'string', default: join(HERE, 'data/corpus.jsonl')},
  },
})
const rand = rng(Number(opts.seed))
const perOrigin = Number(opts['per-origin'])
const accioOnly = Number(opts['accio-only'])

const universe = new Set(await loadUniverse())
const calls = (await readJsonl(opts.in)).filter(c => c.repo === 'idea')

// The cwd of an accio call relative to its checkout: `cd community/tools/vm && accio ...`.
function relCwd(c) {
  let cwd = c.cwd
  const cd = c.args?.cwd
  if (cd) cwd = cd.startsWith('/') ? cd : cd.startsWith('~') ? cd.replace(/^~/, process.env.HOME) : `${cwd}/${cd}`
  if (!cwd) return ''
  const root = checkoutRoot(cwd)
  if (!root) return null
  const rel = cwd.slice(root.length + 1).replace(/\/+$/, '')
  return rel.split('/').filter(s => s && s !== '.').join('/')
}

const skips = new Map()
const skip = r => skips.set(r, (skips.get(r) ?? 0) + 1)
const entries = new Map()
for (const c of calls) {
  if (c.tool === 'accio' && c.args?.cwd && /\$|`/.test(c.args.cwd)) {
    skip('cwd from a variable')
    continue
  }
  const rc = c.tool === 'accio' ? relCwd(c) : ''
  if (rc === null) {
    skip('cwd outside a checkout')
    continue
  }
  if (rc.startsWith('..')) {
    skip('cwd outside the repo')
    continue
  }
  const e = translate(c, {repoRelativeCwd: rc})
  if (e.skip) {
    skip(e.skip)
    continue
  }
  const key = [e.kind, e.mode, e.caseRule, e.q, [...e.scopes].sort().join(','), e.origin].join('\u0000')
  const hard = c.hits === 0 || c.outcome === 'timeout' || c.outcome === 'error' || !!c.next?.search
  const expectedFiles = (c.followups ?? []).filter(f => universe.has(f))
  const prev = entries.get(key)
  if (prev) {
    prev.seen++
    prev.hard ||= hard
    for (const f of expectedFiles) if (!prev.expectedFiles.includes(f)) prev.expectedFiles.push(f)
    continue
  }
  entries.set(key, {
    ...e, hard, expectedFiles, seen: 1,
    source: {id: c.id, session: c.session, ts: c.tsStart, hits: c.hits ?? null, hitsAtLeast: c.hitsAtLeast ?? null, outcome: c.outcome},
  })
}

const pool = [...entries.values()]
const picked = []
const byKindOrigin = groupBy(pool, e => `${e.kind} ${e.origin}`)
for (const kind of ['text', 'regex', 'file', 'symbol']) {
  for (const origin of ['ijproxy', 'accio']) {
    const v = byKindOrigin.get(`${kind} ${origin}`) ?? []
    // Prefer runnable entries: both forms present, or a known dialect gap.
    const runnable = v.filter(e => e.ijproxy && (e.accio || e.unsupported))
    const hard = sample(runnable.filter(e => e.hard), Math.ceil(perOrigin / 2), rand)
    const easy = sample(runnable.filter(e => !e.hard), perOrigin - hard.length, rand)
    picked.push(...hard, ...easy)
  }
}
for (const kind of ['references', 'semantic', 'context']) {
  const v = (byKindOrigin.get(`${kind} accio`) ?? []).filter(e => e.expectedFiles.length)
  picked.push(...sample(v, accioOnly, rand))
}

const out = picked.map((e, i) => ({qid: `q${String(i + 1).padStart(3, '0')}`, ...e}))
await Bun.write(opts.out, out.map(e => JSON.stringify(e)).join('\n') + '\n')
await Bun.write(join(HERE, 'data/corpus-skips.json'), JSON.stringify(Object.fromEntries(skips), null, 2))

const summary = groupBy(out, e => `${e.kind} ${e.origin}`)
console.log(`pool ${pool.length} unique queries, picked ${out.length} -> ${opts.out}`)
for (const [k, v] of summary) {
  console.log(`  ${k.padEnd(20)} ${String(v.length).padStart(3)}  hard ${v.filter(e => e.hard).length}  modeChanged ${v.filter(e => e.modeChanged).length}  unsupported ${v.filter(e => e.unsupported).length}  with expected files ${v.filter(e => e.expectedFiles.length).length}`)
}
console.log('skips', Object.fromEntries([...skips].sort((a, b) => b[1] - a[1])))
