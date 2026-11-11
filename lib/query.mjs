// Query helpers shared by the history report, the corpus and the grader.

export function queryOf(c) {
  return c.tool === 'ijproxy' ? c.args?.q ?? '' : c.args?.q ?? ''
}

export function scopesOf(c) {
  if (c.tool === 'ijproxy') return Array.isArray(c.args?.paths) ? c.args.paths : c.args?.paths ? [c.args.paths] : []
  return c.args?.scope ?? []
}

export function limitOf(c) {
  if (c.tool === 'ijproxy') return c.args?.limit ?? null
  const l = c.args?.flags?.['--limit']
  return l == null ? null : Number(l)
}

// Features of a regex source. Java and Rust share most of them; lookaround and backreferences are Java only.
export function regexFeatures(q) {
  return {
    inlineCase: /\(\?[a-z]*i[a-z]*[):]/.test(q),
    alternation: /(^|[^\\])\|/.test(q),
    wordBoundary: /\\b/.test(q),
    lookaround: /\(\?<?[=!]/.test(q),
    backref: /\\[1-9]|\\k</.test(q),
    dotStar: /\.\*/.test(q),
    anchors: /(^\^|[^\\]\$$)/.test(q),
    multiline: /\\n|\(\?[a-z]*s/.test(q),
    metaFree: !/[\\^$.|?*+()[\]{}]/.test(q),
  }
}

export function hasUpper(q) {
  return /[A-Z]/.test(q.replace(/\\[A-Za-z]/g, '').replace(/\(\?[a-z-]+\)/g, ''))
}

export function escapeRegex(s) {
  return s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

// An identifier or `Class.member`: a query that both symbol searches read the same way.
export function isFullIdentifier(q) {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(q)
}
