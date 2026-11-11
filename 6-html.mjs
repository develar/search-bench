// Renders the graded comparison as an HTML page and, with --pdf, as a PDF.
// Input: data/grades.jsonl, data/runs.jsonl, data/run-meta.json (steps 4 and 5).
// Output: report/compare.html (the page body, for the Artifact tool), report/compare-standalone.html (a full document to
// open in a browser), report/compare.pdf (--pdf, through headless Chrome).
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {basename, join} from 'node:path'
import {parseArgs} from 'node:util'
import {spawnSync} from 'node:child_process'
import {readJsonl} from './lib/jsonl.mjs'
import {fmtBytes, fmtMs, groupBy, median, quantile} from './lib/stats.mjs'

const HERE = import.meta.dir
const {values: opts} = parseArgs({options: {
  pdf: {type: 'boolean', default: false},
  out: {type: 'string', default: join(HERE, 'report/compare.html')},
  chrome: {type: 'string', default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'},
}})

const grades = await readJsonl(join(HERE, 'data/grades.jsonl'))
const runs = await readJsonl(join(HERE, 'data/runs.jsonl'))
const meta = JSON.parse(readFileSync(join(HERE, 'data/run-meta.json'), 'utf8'))

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c])
const tl = (g, tool) => g.tools[tool]
const avg = v => {
  const x = v.filter(y => y != null)
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null
}
const share = (v, f) => {
  const x = v.filter(y => y != null)
  return x.length ? x.filter(f).length / x.length : null
}
const pc = v => (v == null ? '–' : `${Math.round(100 * v)}%`)
const loads = runs.filter(r => r.pass === 'done').map(r => r.load)
const loadP50 = median(loads)
const loadMax = loads.length ? Math.max(...loads) : null
const KIND_LABEL = {text: 'Text', regex: 'Regex', file: 'File name', symbol: 'Symbol', references: 'References', semantic: 'Semantic', context: 'Context'}
const ORIGIN = {ijproxy: 'asked of JetBrains MCP', accio: 'asked of accio'}

// --- speed

const speedGroups = [...groupBy(grades, g => `${g.kind}${g.modeChanged ? '*' : ''}`)]
const speed = speedGroups.map(([k, v]) => {
  const ij = v.filter(g => tl(g, 'ijproxy')).map(g => tl(g, 'ijproxy'))
  const ac = v.filter(g => tl(g, 'accio')).map(g => tl(g, 'accio'))
  const both = v.filter(g => tl(g, 'ijproxy') && tl(g, 'accio'))
  return {
    key: k, kind: k.replace('*', ''), modeChanged: k.endsWith('*'), n: v.length, rows: v,
    ij50: median(ij.map(t => t.ms)), ij90: quantile(ij.map(t => t.ms), 0.9),
    ac50: median(ac.map(t => t.ms)), ac90: quantile(ac.map(t => t.ms), 0.9),
    ratio: both.length ? median(both.map(g => tl(g, 'ijproxy').ms / tl(g, 'accio').ms)) : null,
    ijTimeout: share(ij, t => t.timeouts > 0), acTimeout: share(ac, t => t.timeouts > 0),
    ijBytes: median(ij.map(t => t.bytes)), acBytes: median(ac.map(t => t.bytes)),
  }
})

// A strip chart per kind: one dot per query and tool on a log time axis, the median as a bar.
function latencyChart() {
  const W = 760, left = 132, right = 24, plotW = W - left - right
  const lo = Math.log10(5), hi = Math.log10(12000)
  const x = ms => left + ((Math.log10(Math.min(Math.max(ms, 5), 12000)) - lo) / (hi - lo)) * plotW
  const rowH = 18, groupGap = 14, top = 28
  const ticks = [10, 30, 100, 300, 1000, 3000, 10000]
  let y = top
  const parts = []
  for (const s of speed) {
    const label = `${KIND_LABEL[s.kind]}${s.modeChanged ? ' *' : ''}`
    const gy = y
    parts.push(`<text x="0" y="${gy + rowH + 4}" class="c-kind">${esc(label)}</text>`)
    parts.push(`<text x="${left - 10}" y="${gy + rowH / 2 + 4}" class="c-tool" text-anchor="end">IDE</text>`)
    parts.push(`<text x="${left - 10}" y="${gy + rowH * 1.5 + 4}" class="c-tool" text-anchor="end">accio</text>`)
    for (const [i, tool] of ['ijproxy', 'accio'].entries()) {
      const cy = gy + rowH * i + rowH / 2
      parts.push(`<line x1="${left}" x2="${W - right}" y1="${cy}" y2="${cy}" class="c-lane"/>`)
      s.rows.forEach((g, j) => {
        const t = tl(g, tool)
        if (!t) return
        const jitter = (((j * 7919) % 11) - 5) * 0.9
        const cls = t.timeouts > 0 ? `c-dot c-${tool} c-timeout` : `c-dot c-${tool}`
        parts.push(`<circle cx="${x(t.ms).toFixed(1)}" cy="${(cy + jitter).toFixed(1)}" r="3.2" class="${cls}"><title>${esc(g.qid)} ${esc(fmtMs(t.ms))}${t.timeouts > 0 ? ' timeout' : ''}</title></circle>`)
      })
      const m = tool === 'ijproxy' ? s.ij50 : s.ac50
      if (m != null) parts.push(`<line x1="${x(m)}" x2="${x(m)}" y1="${cy - 7}" y2="${cy + 7}" class="c-median c-m-${tool}"/>`)
    }
    y += rowH * 2 + groupGap
  }
  const H = y + 6
  const grid = ticks.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 8}" y2="${H - groupGap}" class="c-grid"/><text x="${x(t)}" y="${top - 12}" class="c-tick" text-anchor="middle">${esc(fmtMs(t))}</text>`).join('')
  const cap = `<line x1="${x(10000)}" x2="${x(10000)}" y1="${top - 8}" y2="${H - groupGap}" class="c-cap"/>`
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Latency of each query, IDE and accio, on a log scale">${grid}${cap}${parts.join('')}</svg>`
}

// --- quality

const meter = (v, tool) => v == null
  ? '<span class="na">–</span>'
  : `<span class="meter m-${tool}"><span style="width:${Math.max(0, Math.min(100, 100 * v)).toFixed(1)}%"></span></span><span class="num">${pc(v)}</span>`

function textQuality() {
  const rows = [...groupBy(grades.filter(g => g.kind === 'text' || g.kind === 'regex'), g => `${g.kind}|${g.origin}`)].map(([k, v]) => {
    const [kind, origin] = k.split('|')
    const gr = v.filter(g => !g.ungraded)
    const m = (tool, pass, f) => avg(gr.map(g => tl(g, tool)?.[pass]?.[f]))
    return `<tr><th scope="row">${KIND_LABEL[kind]}<span class="sub">${ORIGIN[origin]} · ${gr.length}</span></th>
      <td>${meter(m('ijproxy', 'grade', 'recall'), 'ijproxy')}</td><td>${meter(m('accio', 'grade', 'recall'), 'accio')}</td>
      <td class="r">${pc(m('ijproxy', 'grade', 'precision'))}</td><td class="r">${pc(m('accio', 'grade', 'precision'))}</td>
      <td class="r ${share(gr.map(g => tl(g, 'ijproxy')), x => x.falseComplete) ? 'bad' : ''}">${pc(share(gr.map(g => tl(g, 'ijproxy')), x => x.falseComplete))}</td>
      <td class="r ${share(gr.map(g => tl(g, 'accio')), x => x.falseComplete) ? 'bad' : ''}">${pc(share(gr.map(g => tl(g, 'accio')), x => x.falseComplete))}</td></tr>`
  })
  return `<div class="tw"><table class="q"><thead><tr><th></th><th>IDE recall</th><th>accio recall</th><th class="r">IDE precision</th><th class="r">accio precision</th><th class="r">IDE false complete</th><th class="r">accio false complete</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

function fileQuality() {
  const rows = [...groupBy(grades.filter(g => g.kind === 'file'), 'origin')].map(([o, v]) => {
    const m = (tool, pass, f) => avg(v.map(g => tl(g, tool)?.[pass]?.[f]))
    return `<tr><th scope="row">File name<span class="sub">${ORIGIN[o]} · ${v.length}</span></th>
      <td>${meter(m('ijproxy', 'grade', 'recall'), 'ijproxy')}</td><td>${meter(m('accio', 'grade', 'recall'), 'accio')}</td>
      <td class="r">${pc(m('ijproxy', 'grade', 'precision'))}</td><td class="r">${pc(m('accio', 'grade', 'precision'))}</td></tr>`
  })
  return `<div class="tw"><table class="q"><thead><tr><th></th><th>IDE recall</th><th>accio recall</th><th class="r">IDE precision</th><th class="r">accio precision</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

function symbolQuality() {
  const rows = [...groupBy(grades.filter(g => g.kind === 'symbol'), 'origin')].map(([o, v]) => {
    const s = (tool, f) => share(v.map(g => tl(g, tool)?.asked), x => x[f])
    const m = (tool, pass, f) => avg(v.map(g => tl(g, tool)?.[pass]?.[f]))
    return `<tr><th scope="row">Symbol<span class="sub">${ORIGIN[o]} · ${v.length}</span></th>
      <td>${meter(s('ijproxy', 'top1'), 'ijproxy')}</td><td>${meter(s('accio', 'top1'), 'accio')}</td>
      <td class="r">${pc(m('ijproxy', 'asked', 'precision'))}</td><td class="r">${pc(m('accio', 'asked', 'precision'))}</td>
      <td class="r">${pc(m('ijproxy', 'grade', 'recall'))}</td><td class="r">${pc(m('accio', 'grade', 'recall'))}</td></tr>`
  })
  return `<div class="tw"><table class="q"><thead><tr><th></th><th>IDE top-1</th><th>accio top-1</th><th class="r">IDE precision</th><th class="r">accio precision</th><th class="r">IDE recall</th><th class="r">accio recall</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

function followups() {
  const rows = [...groupBy(grades.filter(g => g.expected), g => `${g.kind}|${g.origin}`)].map(([k, v]) => {
    const [kind, origin] = k.split('|')
    const f = tool => share(v.map(g => tl(g, tool)?.followupGrade), x => x)
    return `<tr><th scope="row">${KIND_LABEL[kind]}<span class="sub">${ORIGIN[origin]} · ${v.length}</span></th><td class="r">${pc(f('ijproxy'))}</td><td class="r">${pc(f('accio'))}</td></tr>`
  })
  return `<div class="tw"><table class="q narrow"><thead><tr><th></th><th class="r">IDE</th><th class="r">accio</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
}

// --- gaps

const gap = g => {
  const a = tl(g, 'ijproxy')?.grade?.recall, b = tl(g, 'accio')?.grade?.recall
  return a != null && b != null ? a - b : null
}
const gaps = grades.filter(g => gap(g) != null && gap(g) !== 0)
function gapList(list) {
  return `<ul class="gaps">${list.map(g => {
    const a = tl(g, 'ijproxy'), b = tl(g, 'accio')
    const scope = g.scopes?.length ? `<span class="scope">in ${esc(g.scopes.join(' ').slice(0, 90))}</span>` : ''
    const out = t => (t.outcome === 'timeout' ? ' <span class="pill warn">timeout</span>' : t.outcome === 'cut' ? ' <span class="pill">cut</span>' : '')
    return `<li><div class="gq"><span class="qid">${esc(g.qid)}</span><span class="kind">${esc(KIND_LABEL[g.kind])}</span><code>${esc(g.q.length > 110 ? g.q.slice(0, 110) + '…' : g.q)}</code>${scope}</div>
      <div class="gn"><span>truth <b>${g.truth}</b></span><span class="t-ijproxy">IDE ${a.grade.hits} hits, recall <b>${pc(a.grade.recall)}</b>${out(a)}</span><span class="t-accio">accio ${b.grade.hits} hits, recall <b>${pc(b.grade.recall)}</b>${out(b)}</span></div></li>`
  }).join('')}</ul>`
}
const accioMore = gaps.filter(g => gap(g) < 0).sort((x, y) => gap(x) - gap(y)).slice(0, 10)
const ideMore = gaps.filter(g => gap(g) > 0).sort((x, y) => gap(y) - gap(x)).slice(0, 10)

// --- headline numbers

const sp = k => speed.find(s => s.key === k)
const textRecall = tool => avg(grades.filter(g => (g.kind === 'text' || g.kind === 'regex') && !g.ungraded).map(g => tl(g, tool)?.grade?.recall))
const ijTimeouts = share(grades.map(g => tl(g, 'ijproxy')), t => t.timeouts > 0)
const acTimeouts = share(grades.map(g => tl(g, 'accio')), t => t.timeouts > 0)
const symPrec = tool => avg(grades.filter(g => g.kind === 'symbol').map(g => tl(g, tool)?.asked?.precision))
const counts = Object.fromEntries([...groupBy(grades, 'kind')].map(([k, v]) => [k, v.length]))
const date = (meta.startedAt ?? '').slice(0, 10)
const loaded = loadP50 != null && loadP50 > 8

const body = `<title>accio vs JetBrains MCP search</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&display=swap">
<style>
/* Layout: one reading column; the charts and tables may run wider inside their own scroll boxes. */
:root {
  --bg: #f7f8fa; --surface: #ffffff; --ink: #161a22; --muted: #5b6372; --rule: #dde1e8;
  --ide: #6a4fd6; --ide-soft: #e7e2fb; --accio: #0d8a77; --accio-soft: #d5efe9;
  --warn: #b5541c; --warn-soft: #fbe7da;
  --f-display: "IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif;
  --f-body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #12151b; --surface: #1a1e26; --ink: #e6e9ef; --muted: #9aa3b2; --rule: #2c323d;
  --ide: #a593ff; --ide-soft: #2c2650; --accio: #3cc7ae; --accio-soft: #133a34;
  --warn: #f0925a; --warn-soft: #3d2416; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #12151b; --surface: #1a1e26; --ink: #e6e9ef; --muted: #9aa3b2; --rule: #2c323d;
  --ide: #a593ff; --ide-soft: #2c2650; --accio: #3cc7ae; --accio-soft: #133a34;
  --warn: #f0925a; --warn-soft: #3d2416; color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--f-body); margin: 0 }
.page { max-width: 880px; margin: 0 auto; padding-block: 40px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 40px }
header { display: grid; gap: 12px }
.eyebrow { font: 500 12px/1 var(--f-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted) }
h1 { font: 600 clamp(30px, 5vw, 44px)/1.08 var(--f-display); margin: 0; text-wrap: balance; letter-spacing: -.01em }
h1 .vs { color: var(--muted); font-weight: 500 }
h1 .t-ide { color: var(--ide) } h1 .t-accio { color: var(--accio) }
h2 { font: 600 24px/1.2 var(--f-display); margin: 0; text-wrap: balance }
h3 { font: 600 16px/1.3 var(--f-body); margin: 0 }
p { margin: 0; max-width: 68ch }
.lede { font-size: 17px; color: var(--ink) }
.facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font: 13px/1.4 var(--f-mono); color: var(--muted) }
.facts b { color: var(--ink); font-weight: 500 }
section { display: grid; gap: 16px; min-width: 0 }
.note { font-size: 13.5px; color: var(--muted) }
.callout { border: 1px solid var(--warn); background: var(--warn-soft); padding: 12px 14px; border-radius: 6px; font-size: 14px }
.find { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px }
.find > div { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 14px; display: grid; gap: 6px; align-content: start; min-width: 0 }
.find .big { font: 600 28px/1 var(--f-display); font-variant-numeric: tabular-nums }
.find .big small { font: 500 14px var(--f-body); color: var(--muted) }
.find p { font-size: 13.5px; color: var(--muted) }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--muted); align-items: center }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px }
.sw.ide { background: var(--ide) } .sw.accio { background: var(--accio) }
.sw.to { background: transparent; border: 1.5px solid var(--warn) }
.tw { overflow-x: auto; min-width: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px }
.chart-box { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 12px 8px 4px }
.chart { width: 100%; min-width: 620px; height: auto; display: block; font-family: var(--f-body) }
.c-kind { fill: var(--ink); font-size: 12.5px; font-weight: 600 }
.c-tool { fill: var(--muted); font-size: 11px; font-family: var(--f-mono) }
.c-tick { fill: var(--muted); font-size: 10.5px; font-family: var(--f-mono) }
.c-grid { stroke: var(--rule); stroke-width: 1 }
.c-cap { stroke: var(--warn); stroke-width: 1; stroke-dasharray: 3 3; fill: none }
.c-lane { stroke: var(--rule); stroke-width: 1; stroke-dasharray: 1 3 }
.c-dot { stroke: none; opacity: .72 }
.c-ijproxy { fill: var(--ide) } .c-accio { fill: var(--accio) }
.c-timeout { fill: none; stroke: var(--warn); stroke-width: 1.5; opacity: 1 }
.c-median { stroke-width: 2.5; stroke-linecap: round }
.c-m-ijproxy { stroke: var(--ide) } .c-m-accio { stroke: var(--accio) }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums }
th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: middle; white-space: nowrap }
tbody tr:last-child > * { border-bottom: 0 }
thead th { font: 500 11.5px/1.2 var(--f-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--muted) }
tbody th { font-weight: 600 }
.sub { display: block; font: 400 12px/1.3 var(--f-body); color: var(--muted) }
.r { text-align: right }
td.bad { color: var(--warn); font-weight: 600 }
.na { color: var(--muted) }
.meter { display: inline-block; width: 84px; height: 7px; border-radius: 4px; vertical-align: middle; margin-right: 8px; overflow: hidden }
.meter > span { display: block; height: 100% }
.m-ijproxy { background: var(--ide-soft) } .m-ijproxy > span { background: var(--ide) }
.m-accio { background: var(--accio-soft) } .m-accio > span { background: var(--accio) }
.num { display: inline-block; min-width: 3ch; text-align: right }
table.narrow { width: auto; min-width: 100% }
.speed td.ratio { font-weight: 600 }
.gaps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px }
.gaps li { padding: 12px 14px; border-bottom: 1px solid var(--rule); display: grid; gap: 6px; min-width: 0 }
.gaps li:last-child { border-bottom: 0 }
.gq { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; min-width: 0 }
.gq code { font: 13px/1.45 var(--f-mono); overflow-wrap: anywhere; min-width: 0 }
.qid { font: 500 12px var(--f-mono); color: var(--muted) }
.kind { font: 500 11px/1 var(--f-mono); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border: 1px solid var(--rule); border-radius: 3px; padding: 3px 5px }
.scope { font: 12px var(--f-mono); color: var(--muted); overflow-wrap: anywhere }
.gn { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums }
.gn b { color: var(--ink) }
.t-ijproxy b { color: var(--ide) } .t-accio b { color: var(--accio) }
.pill { font: 500 11px/1 var(--f-mono); border-radius: 10px; padding: 2px 7px; background: var(--rule); color: var(--ink) }
.pill.warn { background: var(--warn-soft); color: var(--warn) }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px }
.two > div { display: grid; gap: 10px; align-content: start; min-width: 0 }
ul.plain { margin: 0; padding-left: 20px; display: grid; gap: 6px; max-width: 72ch }
code { font-family: var(--f-mono); font-size: .9em }
footer { font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 16px }
@media print {
  body { background: #fff; font-size: 11pt }
  .page { max-width: none; padding: 0; gap: 26px }
  .find > div, .gaps li, tr, .chart-box { break-inside: avoid }
  h2, h3 { break-after: avoid }
  .chart { min-width: 0 }
  .tw, .chart-box { overflow: visible }
  th, td { padding: 6px 8px }
  thead th { white-space: normal; font-size: 9.5px }
  .meter { width: 56px }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important } }
</style>
<div class="page">
<header>
  <div class="eyebrow">Search benchmark · ${esc(basename(meta.repo ?? ''))} · ${esc(date)}</div>
  <h1><span class="t-accio">accio</span> <span class="vs">vs</span> <span class="t-ide">JetBrains&nbsp;MCP</span> search</h1>
  <p class="lede">${grades.length} searches that coding agents really ran in this monorepo, replayed against both tools on the same checkout. Each answer is graded against the lines and files that truly match.</p>
  <div class="facts"><span>checkout <b>${esc(meta.head?.slice(0, 10))}</b></span><span><b>${esc(meta.accioVersion)}</b></span><span><b>${esc((meta.proxyInstructions ?? '').replace('Connected IDEs: ', '').replace(/\.$/, ''))}</b> via ij-proxy</span><span>files changed during the run <b>${meta.drifted?.length ?? '–'}</b></span><span>load average p50 <b>${loadP50?.toFixed(0) ?? '–'}</b>, max <b>${loadMax?.toFixed(0) ?? '–'}</b></span></div>
</header>

${loaded ? `<div class="callout">The machine was loaded during the run (load average p50 ${loadP50.toFixed(0)}). Both tools ran interleaved under the same load, so the comparison holds, but the absolute times are higher than on a quiet machine.</div>` : ''}

<section aria-labelledby="s-find">
  <h2 id="s-find">What the run shows</h2>
  <div class="find">
    <div><span class="eyebrow">Text and regex recall</span><span class="big">${pc(textRecall('accio'))} <small>vs ${pc(textRecall('ijproxy'))}</small></span><p>accio found every matching line in the pool. The IDE missed lines, mostly where it stopped at its 10 s limit.</p></div>
    <div><span class="eyebrow">Timeouts</span><span class="big">${pc(acTimeouts)} <small>vs ${pc(ijTimeouts)}</small></span><p>The IDE stopped ${pc(ijTimeouts)} of its searches at 10 s and returned what it had. accio had none.</p></div>
    <div><span class="eyebrow">File search, p50</span><span class="big">${fmtMs(sp('file')?.ac50)} <small>vs ${fmtMs(sp('file')?.ij50)}</small></span><p>The largest speed gap: about ${Math.round(sp('file')?.ratio ?? 0)}× per query.</p></div>
    <div><span class="eyebrow">Symbol precision</span><span class="big">${pc(symPrec('accio'))} <small>vs ${pc(symPrec('ijproxy'))}</small></span><p>The IDE matches parts of a name, so it also returns <code>FooTest</code> for <code>Foo</code>.</p></div>
  </div>
  <p class="note">The first number is accio, the second is the IDE. "The largest gaps" below lists the queries where one tool found more.</p>
</section>

<section aria-labelledby="s-speed">
  <h2 id="s-speed">Speed</h2>
  <p>Each dot is one query: the median of 3 timed runs after one warm-up, at the limit the agent asked for. accio runs as a new process, the way an agent runs it. The IDE runs through the ij-proxy stdio server. The bar on each lane is the median.</p>
  <div class="legend"><span><span class="sw ide"></span>JetBrains MCP</span><span><span class="sw accio"></span>accio</span><span><span class="sw to"></span>stopped at the 10 s limit of the IDE</span><span>* the query moved to regex mode to keep the case rule of the other tool</span></div>
  <div class="chart-box">${latencyChart()}</div>
  <div class="tw"><table class="speed"><thead><tr><th>Kind</th><th class="r">Queries</th><th class="r">IDE p50</th><th class="r">IDE p90</th><th class="r">accio p50</th><th class="r">accio p90</th><th class="r">IDE / accio</th><th class="r">IDE timeouts</th><th class="r">IDE answer</th><th class="r">accio answer</th></tr></thead><tbody>
  ${speed.map(s => `<tr><th scope="row">${KIND_LABEL[s.kind]}${s.modeChanged ? ' *' : ''}</th><td class="r">${s.n}</td><td class="r">${fmtMs(s.ij50)}</td><td class="r">${fmtMs(s.ij90)}</td><td class="r">${fmtMs(s.ac50)}</td><td class="r">${fmtMs(s.ac90)}</td><td class="r ratio">${s.ratio == null ? '–' : s.ratio.toFixed(1) + '×'}</td><td class="r ${s.ijTimeout ? 'bad' : ''}">${s.ijTimeout == null ? '–' : pc(s.ijTimeout)}</td><td class="r">${fmtBytes(s.ijBytes)}</td><td class="r">${fmtBytes(s.acBytes)}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="note">The answer columns give the median size of the answer. accio sends the lines around each hit; the IDE sends coordinates only, and the agent then reads the file. References, semantic and context queries have no IDE form.</p>
</section>

<section aria-labelledby="s-quality">
  <h2 id="s-quality">Answer quality</h2>
  <p>The truth for a query is every line or file that really matches it, by the case rule of the tool the agent first asked. The grader reads only the candidate files: the files of both answers at limit 500, plus files whose name holds the query. So recall is pooled: a line that neither tool found is not in the truth.</p>
  <div class="legend"><span><span class="sw ide"></span>JetBrains MCP</span><span><span class="sw accio"></span>accio</span><span>Each row counts the queries of one origin: the tool the agent asked in the session.</span></div>
  <h3>Text and regex search</h3>
  ${textQuality()}
  <p class="note">"False complete": the tool said the answer is complete, but it missed a line of the truth. Runs that hit the 10 s limit are left out of this column.</p>
  <h3>File name search</h3>
  ${fileQuality()}
  <p class="note">The truth for file search is exact: every tracked or untracked, not ignored file that matches the glob in scope.</p>
  <h3>Symbol search</h3>
  ${symbolQuality()}
  <p class="note">Top-1: the first hit is a declaration of the name. A declaration is a declaration keyword or a Java method header before the name.</p>
</section>

<section aria-labelledby="s-gaps">
  <h2 id="s-gaps">The largest gaps</h2>
  <div class="two">
    <div><h3>accio found more</h3>${gapList(accioMore)}</div>
    <div><h3>The IDE found more</h3>${gapList(ideMore)}</div>
  </div>
</section>

<section aria-labelledby="s-follow">
  <h2 id="s-follow">Files the agent opened next</h2>
  <p>The share of answers that contain a file the agent read or edited within 8 tool calls after the original search. Two biases work here. The agent read what the original tool showed, which favours the origin. accio shows the lines around a hit, which often replaces a read, and that works against accio.</p>
  ${followups()}
</section>

<section aria-labelledby="s-method">
  <h2 id="s-method">How the run works</h2>
  <ul class="plain">
    <li>The queries come from ${esc(String(grades.length))} calls of the Claude Code session files: ${Object.entries(counts).map(([k, n]) => `${n} ${KIND_LABEL[k].toLowerCase()}`).join(', ')}. The sample over-weights zero-hit calls and retries, because those are the hard cases.</li>
    <li>Each query is translated to the other tool with the same meaning: the case rule, the glob form of the scope, and the limit.</li>
    <li>The two tools run interleaved per query, and the first tool alternates, so both see the same load.</li>
    <li>The grader stores a copy of each file it reads. A file that changed during the run marks its queries.</li>
  </ul>
  <h3>Left out</h3>
  <ul class="plain">
    <li>Lines that neither tool found: pooling cannot see them.</li>
    <li>accio <code>--no-tests</code> and IDE <code>include_external</code> queries: they have no form in the other tool.</li>
    <li>Output flags of accio (<code>--files</code>, <code>-C</code>, <code>--source-lines</code>): the run compares the search, not the presentation.</li>
    <li>Rider (<code>dotnet/</code>): Rider did not run, so ij-proxy ran with one IDE.</li>
  </ul>
</section>

<footer>Generated by search-bench <code>6-html.mjs</code> from the run of ${esc((meta.startedAt ?? '').replace('T', ' ').slice(0, 16))} UTC.</footer>
</div>
`

writeFileSync(opts.out, body)
console.log(`html -> ${opts.out}`)

// A full document for a browser and for Chrome: the page body is written for the artifact skeleton, which adds the
// doctype and head.
const standalone = opts.out.replace(/\.html$/, '-standalone.html')
writeFileSync(standalone, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>@page { size: A4; margin: 14mm 13mm }</style></head><body>${body}</body></html>`)
console.log(`standalone -> ${standalone}`)

if (opts.pdf) {
  const pdf = opts.out.replace(/\.html$/, '.pdf')
  if (!existsSync(opts.chrome)) throw new Error(`no Chrome at ${opts.chrome}; pass --chrome`)
  // Headless Chrome prints in the light scheme, so the page needs no theme switch for print.
  const r = spawnSync(opts.chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${pdf}`, `file://${standalone}`], {encoding: 'utf8'})
  if (r.status !== 0 || !existsSync(pdf)) throw new Error(`Chrome failed: ${r.stderr?.slice(-600)}`)
  console.log(`pdf -> ${pdf}`)
}
