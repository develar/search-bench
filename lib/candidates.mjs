// File-name candidates: files the oracle reads although no tool returned them.
import {scopeMatcher} from './glob.mjs'

const MAX = 20

function stem(path) {
  const base = path.split('/').at(-1)
  const dot = base.indexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

let stemIndex = null
function index(universe) {
  if (stemIndex) return stemIndex
  stemIndex = new Map()
  for (const f of universe) {
    const s = stem(f)
    if (!stemIndex.has(s)) stemIndex.set(s, [])
    stemIndex.get(s).push(f)
  }
  return stemIndex
}

export function fileNameCandidates(entry, universe) {
  const inScope = scopeMatcher(entry.scopes ?? [])
  let names = []
  if (entry.kind === 'symbol') names = [entry.q.split('.')[0]]
  else if (entry.kind === 'text' && /^[A-Za-z_]\w{3,}$/.test(entry.q)) names = [entry.q]
  else if (entry.kind === 'regex') {
    // Identifiers of an alternation: `FooBar|BazQux`.
    names = entry.q.replace(/^\(\?[a-z-]+\)/, '').split('|').filter(s => /^[A-Z]\w{3,}$/.test(s))
  }
  const out = []
  const idx = index(universe)
  for (const n of names) {
    for (const f of idx.get(n) ?? []) {
      if (inScope(f)) out.push(f)
      if (out.length >= MAX) return out
    }
  }
  return out
}
