#!/usr/bin/env bun
// Step 5: grades the runs against a pooled oracle and writes the comparison report.
// The oracle reads only the snapshot of the candidate files: the files that either tool returned
// in the grading pass, plus the file-name candidates. It never scans the whole repository.
//
// Output: data/grades.jsonl, report/compare.md
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {parseArgs} from 'node:util'
import {readJsonl} from './lib/jsonl.mjs'
import {code, fmtBytes, fmtMs, groupBy, mdTable, median, pct, quantile} from './lib/stats.mjs'
import {globMatcher, scopeMatcher, explicitGlob} from './lib/glob.mjs'
import {escapeRegex} from './lib/query.mjs'
import {toJsRegex} from './lib/translate.mjs'
import {fileNameCandidates} from './lib/candidates.mjs'
import {loadUniverse} from './lib/universe.mjs'

const HERE = import.meta.dir
const {values: opts} = parseArgs({
  options: {
    corpus: {type: 'string', default: join(HERE, 'data/corpus.jsonl')},
    runs: {type: 'string', default: join(HERE, 'data/runs.jsonl')},
    out: {type: 'string', default: join(HERE, 'report/compare.md')},
  },
})

const corpus = new Map((await readJsonl(opts.corpus)).map(e => [e.qid, e]))
const runs = await readJsonl(opts.runs)
const meta = existsSync(join(HERE, 'data/run-meta.json')) ? JSON.parse(readFileSync(join(HERE, 'data/run-meta.json'), 'utf8')) : {}
const SNAP = join(HERE, 'data/snapshot')
const snapIndex = existsSync(join(SNAP, 'index.json')) ? JSON.parse(readFileSync(join(SNAP, 'index.json'), 'utf8')) : {}
const drifted = new Set(meta.drifted ?? [])
const universeList = await loadUniverse()
const universe = new Set(universeList)

const textCache = new Map()
function fileText(f) {
  if (textCache.has(f)) return textCache.get(f)
  const h = snapIndex[f]
  const t = h ? readFileSync(join(SNAP, h + '.txt'), 'utf8') : null
  textCache.set(f, t)
  return t
}

const byQ = groupBy(runs.filter(r => r.qid), 'qid')
const key = h => `${h.file}:${h.line}`
const answer = (rs, tool, pass) => rs.find(r => r.tool === tool && r.pass === pass)

// --- truth per kind
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function lineOf(starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function matcherOf(e) {
  if (e.mode === 'literal') {
    return {source: escapeRegex(e.q), flags: 'gm' + (e.caseRule === 'insensitive' ? 'i' : '')}
  }
  // The grader uses the case rule of the original tool; an inline flag in the pattern wins.
  const q = e.origin === 'ijproxy' ? e.ijproxy.args.q : e.q
  return toJsRegex(q, e.caseRule)
}

function textTruth(e, files) {
  const m = matcherOf(e)
  if (!m) return null
  const re = new RegExp(m.source, m.flags)
  const truth = new Set()
  const unreadable = []
  for (const f of files) {
    const t = fileText(f)
    if (t == null) {
      unreadable.push(f)
      continue
    }
    const starts = lineStarts(t)
    re.lastIndex = 0
    let x
    let guard = 0
    while ((x = re.exec(t)) && guard++ < 100000) {
      truth.add(`${f}:${lineOf(starts, x.index)}`)
      if (x[0].length === 0) re.lastIndex++
    }
  }
  return {truth, unreadable}
}

const DECL_KEYWORDS = '(?:class|interface|object|enum|record|struct|trait|fun|def|fn|val|var|const|let|type|typealias|func|function|module|impl|macro_rules!)'
function declLines(text, name, java = true) {
  const lines = text.split('\n')
  const out = []
  const kw = new RegExp(`\\b${DECL_KEYWORDS}\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?${escapeRegex(name)}\\b(?!\\.\\w)`)
  const javaMethod = new RegExp(`^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native|override|open|internal|suspend|@\\w+(?:\\([^)]*\\))?)\\s+)*[\\w<>\\[\\],.?][\\w<>\\[\\],.? ]*\\s+${escapeRegex(name)}\\s*\\(`)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.includes(name)) continue
    if (kw.test(l) || (java && javaMethod.test(l) && !/\b(return|new|throw)\b/.test(l) && !/;\s*$/.test(l))) out.push(i + 1)
  }
  return out
}

function symbolTruth(e, files) {
  const parts = e.q.split('.')
  const name = parts.at(-1)
  const cls = parts.length > 1 ? parts[0] : null
  const decls = new Map()
  for (const f of files) {
    const t = fileText(f)
    if (t == null) continue
    if (cls && !new RegExp(`\\b(class|interface|object|enum|struct|trait|impl)\\s+${escapeRegex(cls)}\\b`).test(t)) continue
    const d = declLines(t, name, f.endsWith('.java'))
    if (d.length) decls.set(f, d)
  }
  return decls
}

function symbolHitTrue(h, decls) {
  const d = decls.get(h.file)
  if (!d || h.line == null) return false
  const end = h.endLine ?? h.line + 40
  // The IDE gives the start of the declaration (KDoc, annotations); accio the line of the name.
  return d.some(x => x >= h.line && x <= Math.min(end, h.line + 40))
}

// --- grading
const grades = []
for (const [qid, rs] of byQ) {
  const e = corpus.get(qid)
  if (!e) continue
  const g = {qid, kind: e.kind, origin: e.origin, q: e.q, scopes: e.scopes, limit: e.limit, modeChanged: !!e.modeChanged, hard: e.hard, tools: {}}
  const inScope = scopeMatcher(e.scopes ?? [])
  const grade = {ijproxy: answer(rs, 'ijproxy', 'grade'), accio: answer(rs, 'accio', 'grade')}
  const asked = {ijproxy: answer(rs, 'ijproxy', 'asked'), accio: answer(rs, 'accio', 'asked')}

  // Speed from the timed runs.
  for (const tool of ['ijproxy', 'accio']) {
    const timed = rs.filter(r => r.tool === tool && r.pass === 'timed')
    if (!timed.length) continue
    g.tools[tool] = {
      ms: median(timed.map(r => r.ms)),
      msMax: Math.max(...timed.map(r => r.ms)),
      bytes: median(timed.map(r => r.bytes)),
      timeouts: timed.filter(r => r.outcome === 'timeout').length,
      refresh: timed.some(r => r.refresh),
      outcome: grade[tool]?.outcome ?? null,
      error: grade[tool]?.error ?? null,
    }
  }
  if (e.unsupported) g.unsupported = e.unsupported
  const files = new Set()
  for (const tool of ['ijproxy', 'accio']) for (const h of grade[tool]?.hits ?? []) if (h.file) files.add(h.file)

  if (e.kind === 'text' || e.kind === 'regex') {
    const cand = new Set([...files, ...fileNameCandidates(e, universeList)])
    const scoped = [...cand].filter(f => inScope(f) && universe.has(f))
    const t = textTruth(e, scoped)
    if (!t) g.ungraded = 'pattern does not convert to JS'
    else {
      g.truth = t.truth.size
      g.drifted = scoped.some(f => drifted.has(f))
      g.unreadable = t.unreadable.length
      for (const tool of ['ijproxy', 'accio']) {
        if (!g.tools[tool]) continue
        const score = ans => {
          if (!ans || ans.outcome === 'error' || ans.outcome === 'unsupported') return null
          const hs = (ans.hits ?? []).filter(h => h.file)
          const outU = hs.filter(h => !universe.has(h.file)).length
          const outS = hs.filter(h => universe.has(h.file) && !inScope(h.file)).length
          const graded = hs.filter(h => universe.has(h.file) && inScope(h.file) && !t.unreadable.includes(h.file))
          const keys = new Set(graded.map(key))
          const tp = [...keys].filter(k => t.truth.has(k)).length
          return {hits: hs.length, outOfUniverse: outU, outOfScope: outS, precision: keys.size ? tp / keys.size : null, tp, keys}
        }
        const sg = score(grade[tool])
        const sa = score(asked[tool])
        const T = t.truth.size
        g.tools[tool].grade = sg && {hits: sg.hits, precision: sg.precision, recall: T ? sg.tp / T : null, outOfUniverse: sg.outOfUniverse, outOfScope: sg.outOfScope}
        g.tools[tool].asked = sa && {hits: sa.hits, precision: sa.precision, recall: T ? sa.tp / Math.min(T, e.limit) : null}
        if (sg) {
          const claimsComplete = grade[tool].complete === true && grade[tool].outcome !== 'timeout'
          const missed = [...t.truth].filter(k => !sg.keys.has(k))
          g.tools[tool].falseComplete = claimsComplete && missed.length > 0 && sg.hits < 500
          g.tools[tool].missed = missed.slice(0, 5)
          g.tools[tool].missedCount = missed.length
        }
      }
    }
  }
  else if (e.kind === 'file') {
    const test = e.mode === 'substring'
      ? (sub => f => f.toLowerCase().includes(sub))(e.q.toLowerCase())
      : (m => (e.caseRule === 'insensitive' ? f => m(f.toLowerCase()) : m))(globMatcher(explicitGlob(e.caseRule === 'insensitive' ? e.q.toLowerCase() : e.q)))
    const truth = new Set(universeList.filter(f => inScope(f) && test(f)))
    g.truth = truth.size
    for (const tool of ['ijproxy', 'accio']) {
      if (!g.tools[tool]) continue
      const score = (ans, cap) => {
        if (!ans || ans.outcome === 'error' || ans.outcome === 'unsupported') return null
        const hs = [...new Set((ans.hits ?? []).map(h => h.file).filter(Boolean))]
        const dirs = hs.filter(f => f.endsWith('/'))
        const fs = hs.filter(f => !f.endsWith('/'))
        const outU = fs.filter(f => !universe.has(f)).length
        const tp = fs.filter(f => truth.has(f)).length
        const inU = fs.length - outU
        return {hits: hs.length, dirs: dirs.length, outOfUniverse: outU, precision: inU ? tp / inU : null, recall: truth.size ? tp / Math.min(truth.size, cap) : null, tp, set: new Set(fs)}
      }
      const sg = score(grade[tool], Infinity)
      const sa = score(asked[tool], e.limit)
      g.tools[tool].grade = sg && {hits: sg.hits, precision: sg.precision, recall: sg.recall, dirs: sg.dirs, outOfUniverse: sg.outOfUniverse}
      g.tools[tool].asked = sa && {hits: sa.hits, precision: sa.precision, recall: sa.recall}
      if (sg) {
        const missed = [...truth].filter(f => !sg.set.has(f))
        g.tools[tool].falseComplete = grade[tool].complete === true && grade[tool].outcome !== 'timeout' && missed.length > 0 && sg.hits < 500
        g.tools[tool].missed = missed.slice(0, 5)
        g.tools[tool].missedCount = missed.length
      }
    }
  }
  else if (e.kind === 'symbol') {
    const cand = new Set([...files, ...fileNameCandidates(e, universeList)])
    const decls = symbolTruth(e, [...cand].filter(f => universe.has(f)))
    const allDecls = [...decls].flatMap(([f, d]) => d.map(x => `${f}:${x}`))
    g.truth = allDecls.length
    for (const tool of ['ijproxy', 'accio']) {
      if (!g.tools[tool]) continue
      const score = ans => {
        if (!ans || ans.outcome === 'error' || ans.outcome === 'unsupported') return null
        const hs = (ans.hits ?? []).filter(h => h.file)
        const flags = hs.map(h => symbolHitTrue(h, decls))
        const covered = new Set()
        for (const h of hs) for (const d of decls.get(h.file) ?? []) if (h.line != null && d >= h.line && d <= Math.min(h.endLine ?? h.line + 40, h.line + 40)) covered.add(`${h.file}:${d}`)
        return {
          hits: hs.length, top1: flags[0] ?? false, top5: flags.slice(0, 5).some(Boolean),
          precision: hs.length ? flags.filter(Boolean).length / hs.length : null,
          recall: allDecls.length ? covered.size / allDecls.length : null,
        }
      }
      g.tools[tool].grade = score(grade[tool])
      g.tools[tool].asked = score(asked[tool])
    }
  }

  // Follow-up hit: the answer holds a file that the agent read or edited after the original search.
  if (e.expectedFiles?.length) {
    g.expected = e.expectedFiles.length
    for (const tool of ['ijproxy', 'accio']) {
      if (!g.tools[tool]) continue
      const fl = ans => (ans?.hits ? e.expectedFiles.some(f => ans.hits.some(h => h.file === f)) : null)
      g.tools[tool].followupAsked = fl(asked[tool])
      g.tools[tool].followupGrade = fl(grade[tool])
    }
  }
  grades.push(g)
}
await Bun.write(join(HERE, 'data/grades.jsonl'), grades.map(g => JSON.stringify(g)).join('\n') + '\n')

// --- report
const md = []
const h = s => md.push('', s, '')
const avg = v => {
  const x = v.filter(y => y != null)
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null
}
const p = v => (v == null ? '–' : `${(100 * v).toFixed(0)}%`)
const share = (v, f) => {
  const x = v.filter(y => y != null)
  return x.length ? pct(x.filter(f).length, x.length) : '–'
}
const tl = (g, tool) => g.tools[tool]

md.push('# Search comparison: JetBrains MCP (ij-proxy) vs accio')
md.push('')
md.push(`Queries graded: ${grades.length}. Checkout \`${meta.repo}\` at \`${meta.head?.slice(0, 12)}\`, ${meta.dirtyFiles} changed files. ${meta.accioVersion}. ${meta.proxyInstructions ?? ''}`)
const loads = runs.filter(r => r.pass === 'done').map(r => r.load)
md.push(`Run ${meta.startedAt} to ${meta.finishedAt ?? '(not finished)'}. Load average p50 ${median(loads)?.toFixed(1) ?? '–'}, max ${loads.length ? Math.max(...loads).toFixed(1) : '–'}. Drifted snapshot files: ${meta.drifted?.length ?? '–'}.`)
if (median(loads) > 8) md.push('', `> **The machine was loaded during the run (load average p50 ${median(loads).toFixed(0)}). The speed numbers are not reliable. Run again on a quiet machine.**`)

h('## Speed')
md.push('Median of 3 timed runs per query, after one warm-up, at the limit the agent asked for. Both tools run the way the agent runs them: accio as a process, the IDE through ij-proxy stdio.')
md.push('The IDE stops a search after 10 s and returns what it has: such a run is a timeout, and its time is censored at about 10 s.')
md.push('')
const speedRows = []
for (const [k, v] of groupBy(grades, g => `${g.kind}${g.modeChanged ? ' (mode changed)' : ''}`)) {
  const both = v.filter(g => tl(g, 'ijproxy') && tl(g, 'accio'))
  const ij = v.filter(g => tl(g, 'ijproxy')).map(g => tl(g, 'ijproxy').ms)
  const ac = v.filter(g => tl(g, 'accio')).map(g => tl(g, 'accio').ms)
  const ratio = both.map(g => tl(g, 'ijproxy').ms / tl(g, 'accio').ms)
  speedRows.push([k, v.length, fmtMs(median(ij)), fmtMs(quantile(ij, 0.9)), fmtMs(median(ac)), fmtMs(quantile(ac, 0.9)),
    ratio.length ? `${median(ratio).toFixed(2)}×` : '–', share(v.map(g => tl(g, 'ijproxy')), x => x.timeouts > 0), share(v.map(g => tl(g, 'accio')), x => x.timeouts > 0),
    share(v.map(g => tl(g, 'accio')), x => x.refresh)])
}
md.push(mdTable(['kind', 'queries', 'IDE p50', 'IDE p90', 'accio p50', 'accio p90', 'IDE / accio p50', 'IDE timeout', 'accio timeout', 'accio refresh'], speedRows))
md.push('')
md.push('"mode changed": the translation moved the query to the regex mode of the other tool to keep the case rule. Its speed is not the speed of the literal search.')
h('### Answer size')
md.push(mdTable(['kind', 'IDE p50 bytes', 'accio p50 bytes'], [...groupBy(grades, 'kind')].map(([k, v]) => [k, fmtBytes(median(v.map(g => tl(g, 'ijproxy')?.bytes))), fmtBytes(median(v.map(g => tl(g, 'accio')?.bytes)))])))
md.push('')
md.push('accio sends snippets, the IDE sends coordinates only. The agent reads the file after an IDE answer.')

h('## Quality: text and regex')
md.push('Truth: every line in the candidate files that matches the query, by the case rule of the original tool. Candidate files: the files of both answers at limit 500, plus file-name candidates, in scope.')
md.push('Recall is pooled: a line that neither tool found is not in the truth. "as asked" recall is capped by the limit of the agent: min(truth, limit).')
md.push('')
const qRows = []
for (const [k, v] of groupBy(grades.filter(g => g.kind === 'text' || g.kind === 'regex'), g => `${g.kind} from ${g.origin}`)) {
  const gr = v.filter(g => !g.ungraded)
  const m = (tool, pass, f) => p(avg(gr.map(g => tl(g, tool)?.[pass]?.[f])))
  qRows.push([k, v.length, gr.length, m('ijproxy', 'grade', 'precision'), m('accio', 'grade', 'precision'), m('ijproxy', 'asked', 'recall'), m('accio', 'asked', 'recall'),
    m('ijproxy', 'grade', 'recall'), m('accio', 'grade', 'recall'), share(gr.map(g => tl(g, 'ijproxy')), x => x.falseComplete), share(gr.map(g => tl(g, 'accio')), x => x.falseComplete)])
}
md.push(mdTable(['kind, origin', 'queries', 'graded', 'IDE precision', 'accio precision', 'IDE recall as asked', 'accio recall as asked', 'IDE recall @500', 'accio recall @500', 'IDE false complete', 'accio false complete'], qRows))
md.push('')
md.push('"false complete": the tool said the answer is complete, but it missed a line of the truth (timeouts left out).')

h('## Quality: file search')
md.push('Truth: the files of `git ls-files` plus the untracked files that are not ignored, that match the glob (or the substring) in scope. This truth is exact.')
md.push('')
md.push(mdTable(['origin', 'queries', 'IDE precision', 'accio precision', 'IDE recall as asked', 'accio recall as asked', 'IDE recall @500', 'accio recall @500', 'IDE out of universe', 'accio directories'],
  [...groupBy(grades.filter(g => g.kind === 'file'), 'origin')].map(([o, v]) => {
    const m = (tool, pass, f) => p(avg(v.map(g => tl(g, tool)?.[pass]?.[f])))
    return [o, v.length, m('ijproxy', 'grade', 'precision'), m('accio', 'grade', 'precision'), m('ijproxy', 'asked', 'recall'), m('accio', 'asked', 'recall'), m('ijproxy', 'grade', 'recall'), m('accio', 'grade', 'recall'),
      share(v.map(g => tl(g, 'ijproxy')?.grade), x => x.outOfUniverse > 0), share(v.map(g => tl(g, 'accio')?.grade), x => x.dirs > 0)]
  })))

h('## Quality: symbol search')
md.push('Truth: declarations of the exact name (a declaration keyword or a Java method header before the name) in the candidate files.')
md.push('A hit is true when a declaration line is within 40 lines after the start of the hit: the IDE gives the start of the declaration with its KDoc and annotations.')
md.push('')
md.push(mdTable(['origin', 'queries', 'IDE top-1', 'accio top-1', 'IDE top-5', 'accio top-5', 'IDE precision', 'accio precision', 'IDE recall @500', 'accio recall @500'],
  [...groupBy(grades.filter(g => g.kind === 'symbol'), 'origin')].map(([o, v]) => {
    const s = (tool, f) => share(v.map(g => tl(g, tool)?.asked).filter(x => x && g0(x)), x => x[f])
    const g0 = () => true
    const m = (tool, pass, f) => p(avg(v.map(g => tl(g, tool)?.[pass]?.[f])))
    return [o, v.length, s('ijproxy', 'top1'), s('accio', 'top1'), s('ijproxy', 'top5'), s('accio', 'top5'), m('ijproxy', 'asked', 'precision'), m('accio', 'asked', 'precision'), m('ijproxy', 'grade', 'recall'), m('accio', 'grade', 'recall')]
  })))
md.push('')
md.push('The IDE matches identifier fragments: it also returns `FooTest` for `Foo`. Its precision counts them as false.')

h('## Follow-up hit')
md.push('Share of the answers that hold a file the agent read or edited after the original search.')
md.push('Two biases: the agent read what the original tool showed, which favours the origin; and accio snippets often replace a Read, which works against accio.')
md.push('')
md.push(mdTable(['kind, origin', 'queries', 'IDE as asked', 'accio as asked', 'IDE @500', 'accio @500'],
  [...groupBy(grades.filter(g => g.expected), g => `${g.kind} from ${g.origin}`)].map(([k, v]) => [k, v.length,
    share(v.map(g => tl(g, 'ijproxy')?.followupAsked), x => x), share(v.map(g => tl(g, 'accio')?.followupAsked), x => x),
    share(v.map(g => tl(g, 'ijproxy')?.followupGrade), x => x), share(v.map(g => tl(g, 'accio')?.followupGrade), x => x)])))

h('## The largest quality gaps')
const gap = g => (tl(g, 'ijproxy')?.grade?.recall ?? null) != null && (tl(g, 'accio')?.grade?.recall ?? null) != null ? tl(g, 'ijproxy').grade.recall - tl(g, 'accio').grade.recall : null
const gaps = grades.filter(g => gap(g) != null && gap(g) !== 0)
const show = g => {
  const a = tl(g, 'ijproxy')
  const b = tl(g, 'accio')
  const lines = [`- \`${g.qid}\` ${g.kind} from ${g.origin} ${code(g.q, 100)}${g.scopes?.length ? ` in ${code(g.scopes.join(' '), 70)}` : ''}: truth ${g.truth},` +
    ` IDE ${a.grade.hits} hits recall ${p(a.grade.recall)} (${a.outcome}), accio ${b.grade.hits} hits recall ${p(b.grade.recall)} (${b.outcome})`]
  for (const [name, t] of [['IDE', a], ['accio', b]]) if (t.missed?.length) lines.push(`  - ${name} missed ${t.missedCount}: ${t.missed.slice(0, 3).map(x => code(x, 90)).join(', ')}`)
  return lines.join('\n')
}
md.push('### accio found more')
md.push('')
for (const g of gaps.filter(g => gap(g) < 0).sort((x, y) => gap(x) - gap(y)).slice(0, 20)) md.push(show(g))
md.push('', '### The IDE found more', '')
for (const g of gaps.filter(g => gap(g) > 0).sort((x, y) => gap(y) - gap(x)).slice(0, 20)) md.push(show(g))

h('## Misses by directory')
md.push('The first two path segments of the lines (or files) that one tool missed and the other found, in the grading pass.')
md.push('')
const missDirs = {ijproxy: new Map(), accio: new Map()}
for (const g of grades) for (const tool of ['ijproxy', 'accio']) for (const m of tl(g, tool)?.missed ?? []) {
  const d = m.split('/').slice(0, 2).join('/')
  missDirs[tool].set(d, (missDirs[tool].get(d) ?? 0) + 1)
}
const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, 12)
md.push(mdTable(['IDE missed in', 'count'], top(missDirs.ijproxy)))
md.push('')
md.push(mdTable(['accio missed in', 'count'], top(missDirs.accio)))

h('## Errors and dialect gaps')
for (const g of grades) {
  for (const tool of ['ijproxy', 'accio']) {
    const t = tl(g, tool)
    if (t && (t.outcome === 'error' || t.outcome === 'unsupported')) md.push(`- \`${g.qid}\` ${tool} ${t.outcome}: ${code(g.q, 80)} → ${code(t.error, 200)}`)
  }
  if (g.unsupported) md.push(`- \`${g.qid}\` not run: ${JSON.stringify(g.unsupported)} ${code(g.q, 80)}`)
  if (g.ungraded) md.push(`- \`${g.qid}\` ungraded: ${g.ungraded} ${code(g.q, 80)}`)
}

h('## Left out')
md.push('- Lines that neither tool found: pooling cannot see them.')
md.push('- `--no-tests` accio queries, `include_external` and `includeExcluded` IDE queries: they have no form in the other tool.')
md.push('- Output flags of accio (`--files`, `-C`, `--source-lines`): the run compares the search, not the presentation.')
md.push('- Rider (`dotnet/`): Rider did not run, so ij-proxy ran in single-IDE mode.')

await Bun.write(opts.out, md.join('\n') + '\n')
console.log(`${grades.length} graded -> ${opts.out}`)
