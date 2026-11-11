#!/usr/bin/env bun
// Step 1: extracts every search call of ij-proxy and accio from the Claude Code session files.
// Output: data/calls.jsonl. A per-file cache in data/extract-cache/ makes a re-run incremental.
//
// Usage: bun 1-extract.mjs [--root ~/.claude/projects] [--file <one.jsonl>] [--no-cache]
import {mkdirSync, readdirSync, statSync, existsSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, basename, dirname} from 'node:path'
import {parseArgs} from 'node:util'
import {lines} from './lib/jsonl.mjs'
import {accioRefreshNote, findAccioInvocations, parseAccioHeaders, parseAccioTextHits} from './lib/accio-cmd.mjs'
import {checkoutRoot, repoOf, repoRelative} from './lib/paths.mjs'

const CACHE_VERSION = 8
const HERE = import.meta.dir
const {values: opts} = parseArgs({
  options: {
    root: {type: 'string', default: join(homedir(), '.claude/projects')},
    file: {type: 'string', multiple: true},
    'no-cache': {type: 'boolean', default: false},
    out: {type: 'string', default: join(HERE, 'data/calls.jsonl')},
  },
})

const IJ_TOOLS = {
  mcp__ijproxy__search_text: 'text',
  mcp__ijproxy__search_regex: 'regex',
  mcp__ijproxy__search_file: 'file',
  mcp__ijproxy__search_symbol: 'symbol',
}
const ACCIO_SEARCH = new Set(['locate', 'symbol', 'files', 'references', 'implementations', 'context', 'trace', 'impact', 'tests'])
const READ_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__ijproxy__read_file'])
const PIPE_FILTERS = new Set(['head', 'tail', 'grep', 'rg', 'sed', 'cut', 'wc', 'jq', 'sort', 'uniq', 'awk', 'cat', 'less', 'tr'])
const FOLLOWUP_WINDOW = 8

const excludeSessions = new Set()
const excludeFile = join(HERE, 'data/exclude-sessions.txt')
if (existsSync(excludeFile)) {
  for (const s of readFileSync(excludeFile, 'utf8').split('\n')) if (s.trim()) excludeSessions.add(s.trim())
}
const BENCH_DIR = HERE

function walk(dir, out = []) {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

function resultText(block) {
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(x => (x.type === 'text' ? x.text : '')).join('')
  return ''
}

function accioKind(sub, flags) {
  if (sub === 'locate') {
    const mode = flags['--mode']
    return mode === 'regex' ? 'regex' : mode === 'semantic' ? 'semantic' : 'text'
  }
  if (sub === 'symbol') return 'symbol'
  if (sub === 'files') return 'file'
  return sub
}

function followupFile(use) {
  const i = use.input ?? {}
  return i.file_path ?? i.path ?? i.notebook_path ?? null
}

async function extractFile(path) {
  const seq = [] // every tool_use in file order: {id, name, input, ts, msgId, cwd, sidechain, session}
  const results = new Map()
  const searchIds = new Set()
  const accioIds = new Set()
  for await (const line of lines(path)) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue
    let r
    try {
      r = JSON.parse(line)
    }
    catch {
      continue
    }
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        const isIj = b.name in IJ_TOOLS
        const isAccio = b.name === 'Bash' && typeof b.input?.command === 'string' && b.input.command.includes('accio')
        const use = {
          id: b.id,
          name: b.name,
          ts: r.timestamp ?? null,
          msgId: r.message?.id ?? null,
          cwd: r.cwd ?? null,
          sidechain: !!r.isSidechain,
          session: r.sessionId ?? null,
          file: READ_TOOLS.has(b.name) ? followupFile(b) : null,
        }
        if (isIj || isAccio) {
          use.input = b.input
          if (isIj) searchIds.add(b.id)
          else accioIds.add(b.id)
        }
        seq.push(use)
      }
      else if (b.type === 'tool_result' && (searchIds.has(b.tool_use_id) || accioIds.has(b.tool_use_id))) {
        const prev = results.get(b.tool_use_id)
        if (prev && prev.ts && !r.timestamp) continue
        const tur = r.toolUseResult
        results.set(b.tool_use_id, {
          ts: r.timestamp ?? null,
          isError: !!b.is_error,
          text: resultText(b),
          stdout: tur && typeof tur === 'object' ? tur.stdout : undefined,
          stderr: tur && typeof tur === 'object' ? tur.stderr : undefined,
          background: !!(tur && typeof tur === 'object' && (tur.backgroundTaskId || tur.timedOutAfterMs)),
          structured: r.mcpMeta?.structuredContent ?? null,
          permissionReason: r.permissionDecision?.reasonType ?? null,
        })
      }
    }
  }

  // Dedup tool_uses by id inside the file: keep the first that has a timestamp.
  const byId = new Map()
  const uses = []
  for (const u of seq) {
    const prev = byId.get(u.id)
    if (prev) {
      // A streamed record can come first with an empty input.
      if (!prev.input && u.input) prev.input = u.input
      if (!prev.file && u.file) prev.file = u.file
      if (!prev.ts && u.ts) prev.ts = u.ts
      if (!prev.msgId && u.msgId) prev.msgId = u.msgId
      continue
    }
    byId.set(u.id, u)
    uses.push(u)
  }
  const batch = new Map()
  for (const u of uses) if (u.msgId) batch.set(u.msgId, (batch.get(u.msgId) ?? 0) + 1)

  const calls = []
  for (let k = 0; k < uses.length; k++) {
    const u = uses[k]
    if (!searchIds.has(u.id) && !accioIds.has(u.id)) continue
    if (!u.input) continue
    const res = results.get(u.id)
    // Follow-ups: later tool uses outside this batch.
    const later = []
    for (let j = k + 1; j < uses.length && later.length < FOLLOWUP_WINDOW; j++) {
      if (u.msgId && uses[j].msgId === u.msgId) continue
      later.push(uses[j])
    }
    const followups = [...new Set(later.map(x => repoRelative(x.file, u.cwd)).filter(Boolean))]
    const nextUse = later[0]
    const next = nextUse
      ? {
          name: nextUse.name,
          search: searchIds.has(nextUse.id) || accioIds.has(nextUse.id),
          gapMs: nextUse.ts && res?.ts ? Date.parse(nextUse.ts) - Date.parse(res.ts) : null,
        }
      : null
    const base = {
      id: u.id,
      session: u.session ?? basename(path, '.jsonl'),
      sessionFile: path,
      project: projectOf(path),
      repo: repoOf(u.cwd),
      cwd: u.cwd,
      sidechain: u.sidechain || path.includes('/subagents/'),
      tsStart: u.ts,
      tsEnd: res?.ts ?? null,
      batchSize: batch.get(u.msgId) ?? 1,
      permissionReason: res?.permissionReason ?? null,
      followups,
      next,
    }
    const rawLatency = u.ts && res?.ts ? Date.parse(res.ts) - Date.parse(u.ts) : null

    if (searchIds.has(u.id)) {
      calls.push({...base, ...ijRecord(u, res), latencyMs: rawLatency})
    }
    else {
      calls.push(...accioRecords(u, res, base, rawLatency))
    }
  }
  return calls
}

function projectOf(path) {
  const rel = path.slice(opts.root.length + 1)
  return rel.split('/')[0]
}

function ijRecord(u, res) {
  const kind = IJ_TOOLS[u.name]
  const rec = {tool: 'ijproxy', kind, callId: u.id, args: u.input, raw: null}
  if (!res) return {...rec, outcome: 'missing'}
  rec.resultBytes = Buffer.byteLength(res.text ?? '')
  let data = res.structured
  if (!data) {
    try {
      data = JSON.parse(res.text)
    }
    catch {
      data = null
    }
  }
  // The IDE answers `{}` when nothing matched.
  if (!res.isError && data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) data = {items: []}
  if (res.isError || !data || !Array.isArray(data.items)) {
    return {...rec, outcome: 'error', error: (res.text ?? '').slice(0, 300), hits: 0}
  }
  const items = data.items
  rec.hits = items.length
  rec.files = [...new Set(items.map(i => i.filePath))].length
  rec.topFiles = [...new Set(items.map(i => i.filePath))].slice(0, 10)
  rec.complete = !data.more
  rec.partialReason = data.partialResultReason ?? null
  rec.outcome = data.partialResultReason && /timed out/i.test(data.partialResultReason)
    ? 'timeout'
    : data.more ? 'cut' : 'ok'
  return rec
}

function accioRecords(u, res, base, rawLatency) {
  const command = u.input.command
  const {invocations, simpleCount} = findAccioInvocations(command)
  const searches = invocations.filter(i => ACCIO_SEARCH.has(i.sub))
  if (searches.length === 0) return []
  const out = []
  const text = res ? [res.stdout ?? res.text ?? '', res.stderr ?? ''].join('\n') : ''
  const headers = res ? parseAccioHeaders(text) : []
  const refresh = res ? accioRefreshNote(text) : false
  // Pair each (invocation, query) with the next header of the same subcommand.
  let h = 0
  const pairs = []
  for (const inv of searches) {
    const queries = inv.sub === 'files' && inv.queries.length === 0 ? [''] : inv.queries.length ? inv.queries : ['']
    for (const q of queries) {
      let header = null
      while (h < headers.length && headers[h].sub !== inv.sub) h++
      if (h < headers.length) header = headers[h++]
      pairs.push({inv, q, header})
    }
  }
  const otherCmds = simpleCommands(command).filter(c => !isAccio(c) && !isTrivial(c))
  const timeable = pairs.length === 1 && otherCmds.length === 0 && !res?.background && !/moved to the background/.test(text)
  const multi = pairs.length > 1

  for (let p = 0; p < pairs.length; p++) {
    const {inv, q, header} = pairs[p]
    const rec = {
      ...base,
      id: pairs.length > 1 ? `${u.id}#${p}` : u.id,
      callId: u.id,
      tool: 'accio',
      kind: accioKind(inv.sub, inv.flags),
      sub: inv.sub,
      args: {q, scope: inv.scope, flags: inv.flags, cwd: inv.cwd},
      raw: command.length > 2000 ? command.slice(0, 2000) : command,
      piped: inv.piped,
      multi,
      refresh,
      latencyMs: timeable ? rawLatency : null,
      rawLatencyMs: rawLatency,
    }
    if (!res) {
      out.push({...rec, outcome: 'missing'})
      continue
    }
    rec.resultBytes = Buffer.byteLength(text)
    if (!header) {
      out.push({...rec, outcome: res.isError ? 'error' : 'unparsed', error: res.isError ? text.slice(0, 300) : undefined})
      continue
    }
    rec.quality = header.quality
    rec.selfMs = header.selfMs ?? null
    rec.complete = header.complete
    rec.match = /match=(\w+)/.exec(header.tail)?.[1] ?? null
    if (header.complete === false) rec.hitsAtLeast = header.count
    else rec.hits = header.count
    rec.unit = header.unit
    // Hits shown in this segment.
    const end = p + 1 < pairs.length && pairs[p + 1].header ? pairs[p + 1].header.index : text.length
    const segment = text.slice(header.index, end)
    const shown = parseAccioTextHits(segment.split('\n').slice(1).join('\n'))
    rec.topFiles = [...new Set(shown.map(x => x.file))].slice(0, 10)
    rec.outcome = header.count === 0 ? 'ok' : header.complete === false ? 'cut' : 'ok'
    out.push(rec)
  }
  return out
}

import {simpleCommands} from './lib/accio-cmd.mjs'

function progOf(c) {
  let s = 0
  while (s < c.argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c.argv[s])) s++
  return c.argv[s] ?? ''
}
function isAccio(c) {
  const p = progOf(c).split('/').at(-1)
  return p === 'accio' || p === 'accio.cmd'
}
function isTrivial(c) {
  const p = progOf(c)
  if (p === 'cd' || p === 'true' || p === 'echo') return true
  return c.sepBefore === '|' && PIPE_FILTERS.has(p)
}

// --- main ---
const files = opts.file?.length ? opts.file : walk(opts.root)
const cacheDir = join(HERE, 'data/extract-cache')
mkdirSync(cacheDir, {recursive: true})
mkdirSync(dirname(opts.out), {recursive: true})

const all = new Map()
let parsed = 0
let cached = 0
const t0 = performance.now()
for (const f of files) {
  const st = statSync(f)
  const key = Bun.hash(f).toString(16)
  const cacheFile = join(cacheDir, key + '.json')
  let calls = null
  if (!opts['no-cache'] && existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    if (c.v === CACHE_VERSION && c.mtime === st.mtimeMs && c.size === st.size) {
      calls = c.calls
      cached++
    }
  }
  if (!calls) {
    calls = await extractFile(f)
    parsed++
    await Bun.write(cacheFile, JSON.stringify({v: CACHE_VERSION, path: f, mtime: st.mtimeMs, size: st.size, calls}))
  }
  for (const c of calls) {
    if (excludeSessions.has(c.session)) continue
    if (c.cwd && c.cwd.startsWith(BENCH_DIR)) continue
    const prev = all.get(c.id)
    // Resumed sessions copy history: keep the record with a result and a timestamp.
    if (prev && (prev.tsEnd || !c.tsEnd)) continue
    all.set(c.id, c)
  }
}
const out = [...all.values()].sort((a, b) => (a.tsStart ?? '').localeCompare(b.tsStart ?? ''))
await Bun.write(opts.out, out.map(r => JSON.stringify(r)).join('\n') + '\n')
const byTool = {}
for (const c of out) byTool[`${c.tool}:${c.kind}`] = (byTool[`${c.tool}:${c.kind}`] ?? 0) + 1
console.log(`files ${files.length} (parsed ${parsed}, cached ${cached}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
console.log(`calls ${out.length} -> ${opts.out}`)
console.log(Object.entries(byTool).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k} ${v}`).join('\n'))
