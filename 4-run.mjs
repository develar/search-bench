#!/usr/bin/env bun
// Step 4: runs the corpus live on both tools, on the same checkout.
// Output: data/runs.jsonl (appended per query), data/run-meta.json, data/snapshot/.
//
// Usage: bun 4-run.mjs [--max 5] [--kinds text,regex] [--resume] [--reps 3] [--qid q001,q002]
import {mkdirSync, existsSync, readFileSync, appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {loadavg} from 'node:os'
import {readJsonl} from './lib/jsonl.mjs'
import {McpStdio} from './lib/mcp-stdio.mjs'
import {REPO, gitHead, loadUniverse, readRepoFile} from './lib/universe.mjs'
import {fileNameCandidates} from './lib/candidates.mjs'
import {accioRefreshNote, parseAccioHeaders} from './lib/accio-cmd.mjs'

const HERE = import.meta.dir
const {values: opts} = parseArgs({
  options: {
    corpus: {type: 'string', default: join(HERE, 'data/corpus.jsonl')},
    out: {type: 'string', default: join(HERE, 'data/runs.jsonl')},
    max: {type: 'string'},
    kinds: {type: 'string'},
    qid: {type: 'string'},
    resume: {type: 'boolean', default: false},
    reps: {type: 'string', default: '3'},
    timeout: {type: 'string', default: '60000'},
    'grade-limit': {type: 'string', default: '500'},
    accio: {type: 'string', default: 'accio'},
    proxy: {type: 'string', default: join(REPO, 'community/build/mcp-servers/ij-proxy/dist/ij-mcp-proxy.mjs')},
  },
})
const REPS = Number(opts.reps)
const TIMEOUT = Number(opts.timeout)
const GRADE_LIMIT = Number(opts['grade-limit'])
const SNAP = join(HERE, 'data/snapshot')
mkdirSync(SNAP, {recursive: true})

let corpus = await readJsonl(opts.corpus)
if (opts.kinds) {
  const k = new Set(opts.kinds.split(','))
  corpus = corpus.filter(e => k.has(e.kind))
}
if (opts.qid) {
  const q = new Set(opts.qid.split(','))
  corpus = corpus.filter(e => q.has(e.qid))
}
const done = new Set()
if (opts.resume && existsSync(opts.out)) {
  for (const r of await readJsonl(opts.out)) if (r.pass === 'done') done.add(r.qid)
}
corpus = corpus.filter(e => !done.has(e.qid))
if (opts.max) corpus = corpus.slice(0, Number(opts.max))

// --- snapshot of the files the oracle reads
const snapIndexFile = join(SNAP, 'index.json')
const snapIndex = existsSync(snapIndexFile) ? JSON.parse(readFileSync(snapIndexFile, 'utf8')) : {}
function snapshot(file) {
  if (snapIndex[file] !== undefined) return
  const text = readRepoFile(file)
  if (text == null || text.length > 4 * 1024 * 1024) {
    snapIndex[file] = null
    return
  }
  const hash = Bun.hash(text).toString(16)
  snapIndex[file] = hash
  const path = join(SNAP, hash + '.txt')
  if (!existsSync(path)) Bun.write(path, text)
}

// --- the tools
function ijArgs(e, limit) {
  const a = {...e.ijproxy.args}
  delete a.projectPath
  delete a.project_path
  a.limit = limit
  return a
}

function ijOutcome(r) {
  if (r.timeoutClient) return {outcome: 'timeout', hits: [], complete: false, error: 'client timeout'}
  let data = r.structured
  if (!data) {
    try {
      data = JSON.parse(r.text)
    }
    catch {
      data = null
    }
  }
  if (r.isError || !data || typeof data !== 'object') {
    const unsupported = /PatternSyntax|regex|Unclosed|Illegal|dangling/i.test(r.text)
    return {outcome: unsupported ? 'unsupported' : 'error', hits: [], complete: null, error: r.text.slice(0, 400)}
  }
  const items = data.items ?? []
  const hits = items.map(i => ({file: i.filePath, line: i.startLine ?? null, endLine: i.endLine ?? null, name: i.name ?? undefined}))
  const timeout = data.partialResultReason && /timed out/i.test(data.partialResultReason)
  return {outcome: timeout ? 'timeout' : data.more ? 'cut' : 'ok', hits, complete: !data.more, reason: data.partialResultReason}
}

async function runIj(mcp, e, limit) {
  const t0 = performance.now()
  try {
    const r = await mcp.call(e.ijproxy.tool, ijArgs(e, limit), TIMEOUT)
    return {ms: r.ms, bytes: Buffer.byteLength(r.text), ...ijOutcome(r)}
  }
  catch (err) {
    if (err.timeout) return {ms: performance.now() - t0, bytes: 0, ...ijOutcome({timeoutClient: true})}
    throw err
  }
}

function accioArgv(e, {limit, json}) {
  const argv = [...e.accio]
  const li = argv.indexOf('--limit')
  if (li >= 0) argv.splice(li, 2)
  argv.push('--limit', String(limit))
  if (json) argv.push('--format', 'json')
  return argv
}

function accioJsonHits(e, data) {
  const obj = Array.isArray(data) ? data[0] : data
  if (!obj) return {hits: [], complete: null}
  const raw = obj.hits ?? []
  const hits = raw.map(h => (typeof h === 'string'
    ? {file: h, line: null}
    : {file: h.file, line: h.line ?? null, endLine: h.end_line ?? h.in?.end ?? null, name: h.name, kind: h.kind, resolved: h.resolved}))
  return {hits, complete: obj.complete ?? null, quality: obj.quality ?? null, note: obj.note ?? null}
}

async function runAccio(e, {limit, json}) {
  const argv = accioArgv(e, {limit, json})
  const t0 = performance.now()
  const p = Bun.spawn([opts.accio, ...argv], {cwd: REPO, stdout: 'pipe', stderr: 'pipe', env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}})
  const timer = setTimeout(() => p.kill(), TIMEOUT)
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  clearTimeout(timer)
  const ms = performance.now() - t0
  const text = stdout + (stderr ? '\n' + stderr : '')
  const refresh = accioRefreshNote(text)
  const base = {ms, bytes: Buffer.byteLength(stdout), refresh, exit: code}
  if (p.signalCode || ms >= TIMEOUT) return {...base, outcome: 'timeout', hits: [], complete: false, error: 'client timeout'}
  if (code !== 0 && !stdout.trim()) {
    const unsupported = /regex parse error|look-around|backreference|unrecognized escape|repetition operator/i.test(text)
    return {...base, outcome: unsupported ? 'unsupported' : 'error', hits: [], complete: null, error: text.slice(0, 400)}
  }
  if (json) {
    let data
    try {
      data = JSON.parse(stdout)
    }
    catch {
      return {...base, outcome: 'error', hits: [], complete: null, error: 'bad json: ' + stdout.slice(0, 200)}
    }
    const r = accioJsonHits(e, data)
    return {...base, ...r, outcome: r.complete === false ? 'cut' : 'ok'}
  }
  const [h] = parseAccioHeaders(text)
  return {...base, outcome: h ? (h.complete === false ? 'cut' : 'ok') : 'unparsed', complete: h?.complete ?? null, quality: h?.quality ?? null, count: h?.count ?? null, hits: undefined}
}

// --- preflight
const meta = {startedAt: new Date().toISOString(), repo: REPO, head: await gitHead()}
meta.dirtyFiles = (await spawnText(['git', '-C', REPO, 'status', '--porcelain', '--untracked-files=no'], 60000)).split('\n').filter(Boolean).length
// `accio stats` can wait for an index build; give it 20 s.
async function spawnText(cmd, ms) {
  const p = Bun.spawn(cmd, {cwd: REPO, stdout: 'pipe', stderr: 'pipe'})
  const timer = setTimeout(() => p.kill(), ms)
  const out = await new Response(p.stdout).text()
  await p.exited
  clearTimeout(timer)
  return p.signalCode ? `killed after ${ms} ms` : out
}
meta.accioStats = (await spawnText([opts.accio, 'stats', '--no-build'], 20000)).slice(0, 4000)
meta.loadAvgStart = loadavg()
meta.accioVersion = Bun.spawnSync([opts.accio, '--version']).stdout.toString().trim()
const mcp = new McpStdio({command: ['bun', opts.proxy], cwd: REPO})
const init = await mcp.initialize()
meta.proxy = init.serverInfo
meta.proxyInstructions = init.instructions
const ps = await mcp.call('get_project_status', {}, 30000)
meta.projectStatus = ps.text
const psData = JSON.parse(ps.text || '{}')
if (psData.isDumb || psData.scanningInProgress || psData.ready === false) {
  console.error('the IDE indexes or scans now:', ps.text)
  process.exit(2)
}
const probe = await mcp.call('search_file', {q: 'AGENTS.md', limit: 1}, 30000)
if (probe.isError) {
  console.error('the IDE does not answer for this project:', probe.text.slice(0, 300))
  process.exit(2)
}
await Bun.write(join(HERE, 'data/run-meta.json'), JSON.stringify(meta, null, 2))
console.log(`HEAD ${meta.head.slice(0, 10)}, dirty ${meta.dirtyFiles}, ${meta.accioVersion}, ${init.instructions}`)
console.log(`queries ${corpus.length}, reps ${REPS}`)

const universe = await loadUniverse()
const write = rec => appendFileSync(opts.out, JSON.stringify(rec) + '\n')

let qi = 0
for (const e of corpus) {
  qi++
  const both = e.ijproxy && e.accio
  const tStart = performance.now()
  const summary = {}
  // Timed passes at the limit the agent asked for: one warm-up, then REPS.
  for (let rep = 0; rep <= REPS; rep++) {
    const order = (rep + qi) % 2 === 0 ? ['ijproxy', 'accio'] : ['accio', 'ijproxy']
    for (const tool of order) {
      if (!e[tool]) continue
      const r = tool === 'ijproxy' ? await runIj(mcp, e, e.limit) : await runAccio(e, {limit: e.limit, json: false})
      const pass = rep === 0 ? 'warmup' : 'timed'
      const keepHits = tool === 'ijproxy' && rep === 1
      write({qid: e.qid, tool, pass, rep, ...r, hits: keepHits ? r.hits : undefined, nHits: r.hits?.length ?? r.count ?? null})
      if (pass === 'timed') (summary[tool] ??= []).push(r.ms)
      if (keepHits) write({qid: e.qid, tool, pass: 'asked', ...r})
    }
  }
  // The "as asked" hits of accio: one untimed JSON run at the original limit.
  if (e.accio) write({qid: e.qid, tool: 'accio', pass: 'asked', ...(await runAccio(e, {limit: e.limit, json: true}))})
  // The grading pass: limit 500, untimed.
  const grade = {}
  if (e.ijproxy) write({qid: e.qid, tool: 'ijproxy', pass: 'grade', ...(grade.ijproxy = await runIj(mcp, e, GRADE_LIMIT))})
  if (e.accio) write({qid: e.qid, tool: 'accio', pass: 'grade', ...(grade.accio = await runAccio(e, {limit: GRADE_LIMIT, json: true}))})
  // Snapshot the files the grader reads.
  if (e.kind !== 'file') {
    const files = new Set(fileNameCandidates(e, universe))
    for (const g of Object.values(grade)) for (const h of g.hits ?? []) if (h.file) files.add(h.file)
    for (const f of files) snapshot(f)
  }
  write({qid: e.qid, pass: 'done', ms: performance.now() - tStart, load: loadavg()[0]})
  const med = v => (v ? v.sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(0) : '–')
  console.log(`${e.qid} load ${loadavg()[0].toFixed(0).padStart(3)} ${e.kind.padEnd(10)} ${e.origin.padEnd(7)} ij ${med(summary.ijproxy).padStart(6)} ms ${String(grade.ijproxy?.outcome ?? '–').padEnd(11)} accio ${med(summary.accio).padStart(6)} ms ${String(grade.accio?.outcome ?? '–').padEnd(11)} ${JSON.stringify(e.q).slice(0, 60)}`)
  if (qi % 10 === 0) await Bun.write(snapIndexFile, JSON.stringify(snapIndex))
}
await Bun.write(snapIndexFile, JSON.stringify(snapIndex))

// Drift: hash the snapshot files again.
const drifted = []
for (const [file, hash] of Object.entries(snapIndex)) {
  if (!hash) continue
  const now = readRepoFile(file)
  if (now == null || Bun.hash(now).toString(16) !== hash) drifted.push(file)
}
meta.finishedAt = new Date().toISOString()
meta.headAtEnd = await gitHead()
meta.drifted = drifted
await Bun.write(join(HERE, 'data/run-meta.json'), JSON.stringify(meta, null, 2))
console.log(`done; drifted files ${drifted.length}; HEAD at end ${meta.headAtEnd.slice(0, 10)}`)
mcp.close()
