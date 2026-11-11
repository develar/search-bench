// Translates a historical search call into a corpus entry with a form for each tool.
// The translation keeps the meaning of the original tool (see the plan, step 3).
import {explicitGlob} from './glob.mjs'
import {escapeRegex, hasUpper, isFullIdentifier} from './query.mjs'

export const DEFAULT_LIMIT = {
  ijproxy: {text: 1000, regex: 1000, file: 1000, symbol: 50},
  accio: {text: 50, regex: 50, file: 50, symbol: 20, references: 50, semantic: 15, context: 15},
}

const IJ_TOOL = {text: 'search_text', regex: 'search_regex', file: 'search_file', symbol: 'search_symbol'}

// Java-only regex syntax that the Rust regex crate rejects.
export function rustUnsupported(q) {
  if (/\(\?<?[=!]/.test(q)) return 'lookaround'
  if (/\\[1-9]|\\k</.test(q)) return 'backreference'
  if (/\(\?>/.test(q)) return 'atomic group'
  if (/[*+?}]\+/.test(q.replace(/\\./g, ''))) return 'possessive quantifier'
  if (/\\Q|\\E|\\p\{java|\\h|\\G|\\Z/.test(q)) return 'Java escape'
  return null
}

// JS RegExp source for the grader, from a Java or Rust pattern. Returns {source, flags} or null.
export function toJsRegex(q, caseRule) {
  let src = q
  let flags = 'gm'
  let insensitive = caseRule === 'insensitive'
  // Leading inline flags: (?i), (?-i), (?im), (?s).
  const lead = /^\(\?([a-z]*)(?:-([a-z]*))?\)/.exec(src)
  if (lead) {
    if (lead[1].includes('i')) insensitive = true
    if (lead[2]?.includes('i')) insensitive = false
    if (lead[1].includes('s')) flags += 's'
    src = src.slice(lead[0].length)
  }
  if (/\(\?[a-z-]+[):]/.test(src)) return null // inline flags elsewhere
  if (/\\Q|\\E|\\p\{java|\\h|\\G|\\Z|\\A|\\z|\(\?>|\(\?P</.test(src)) return null
  src = src.replace(/[*+?}]\+/g, m => m[0]) // possessive -> greedy: same matches for a line test
  if (insensitive) flags += 'i'
  try {
    new RegExp(src, flags + 'u')
    return {source: src, flags: flags + 'u'}
  }
  catch {
    try {
      new RegExp(src, flags)
      return {source: src, flags}
    }
    catch {
      return null
    }
  }
}

function charClassGlob(sub) {
  return sub.replace(/[A-Za-z]/g, c => `[${c.toUpperCase()}${c.toLowerCase()}]`)
}

// An accio scope, relative to the cwd of the call, to an explicit repo-relative glob.
function accioScopeToGlob(s, prefix) {
  let neg = ''
  if (s.startsWith('!')) {
    neg = '!'
    s = s.slice(1)
  }
  s = s.replace(/^\.\//, '')
  const isGlob = /[*?[{]/.test(s)
  if (prefix && !s.startsWith('**')) s = prefix + s
  if (!isGlob) {
    const last = s.replace(/\/$/, '').split('/').at(-1)
    if (s.endsWith('/') || !last.includes('.')) return neg + s.replace(/\/?$/, '/**')
    return neg + s // a file
  }
  return neg + explicitGlob(s)
}

function ijScopes(c) {
  const p = c.args?.paths
  const list = Array.isArray(p) ? p : p ? [p] : []
  return list.filter(s => s && s.trim()).map(explicitGlob)
}

function accioArgv(kind, q, scopes, limit, {regex = false, insensitive = false} = {}) {
  const sub = {text: 'locate', regex: 'locate', semantic: 'locate', file: 'files', symbol: 'symbol', references: 'references', context: 'context'}[kind]
  const argv = [sub, q]
  if (regex) argv.push('--mode', 'regex')
  if (kind === 'semantic') argv.push('--mode', 'semantic')
  if (insensitive) argv.push('-i')
  for (const s of scopes) argv.push('--scope', s)
  if (limit != null) argv.push('--limit', String(limit))
  return argv
}

// Returns an entry or {skip: reason}.
export function translate(c, {repoRelativeCwd = ''} = {}) {
  const origin = c.tool
  const kind = c.kind
  const q = c.args?.q ?? ''
  if (!q) return {skip: 'empty query'}

  if (origin === 'ijproxy') {
    if (c.args?.include_external) return {skip: 'include_external'}
    if (c.args?.includeExcluded) return {skip: 'includeExcluded'}
    const scopes = ijScopes(c)
    const limit = c.args?.limit ?? DEFAULT_LIMIT.ijproxy[kind]
    const base = {origin, kind, q, scopes, limit, ijproxy: {tool: IJ_TOOL[kind], args: {...c.args}}}
    if (kind === 'text') {
      const upper = hasUpper(q)
      return {
        ...base, mode: 'literal', caseRule: 'sensitive', modeChanged: !upper,
        accio: upper ? accioArgv('text', q, scopes, limit) : accioArgv('regex', '(?-i)' + escapeRegex(q), scopes, limit, {regex: true}),
      }
    }
    if (kind === 'regex') {
      const why = rustUnsupported(q)
      const insensitive = /^\(\?[a-z]*i/.test(q)
      const pattern = hasUpper(q) || insensitive ? q : '(?-i)' + q
      return {
        ...base, mode: 'regex', caseRule: 'sensitive', modeChanged: false,
        accio: why ? null : accioArgv('regex', pattern, scopes, limit, {regex: true}),
        unsupported: why ? {accio: why} : undefined,
      }
    }
    if (kind === 'file') {
      const glob = explicitGlob(q)
      return {...base, q: glob, mode: 'glob', caseRule: 'sensitive', ijproxy: {tool: 'search_file', args: {...c.args, q: glob}}, accio: accioArgv('file', glob, scopes, limit)}
    }
    if (kind === 'symbol') {
      if (!isFullIdentifier(q)) return {skip: 'symbol fragment'}
      return {...base, mode: 'symbol', caseRule: 'sensitive', accio: accioArgv('symbol', q, scopes, limit)}
    }
    return {skip: 'kind'}
  }

  // accio origin
  const flags = c.args?.flags ?? {}
  if (flags['--project'] || flags['--ref']) return {skip: 'other project or revision'}
  if (flags['--no-tests']) return {skip: '--no-tests has no IDE form'}
  if (flags['--content'] || flags['-r'] || flags['--replace']) return {skip: 'content filter or replace'}
  const prefix = repoRelativeCwd ? repoRelativeCwd.replace(/\/?$/, '/') : ''
  const scopes = (c.args?.scope ?? []).filter(Boolean).map(s => accioScopeToGlob(s, prefix))
  if (prefix && scopes.length === 0) scopes.push(prefix + '**')
  const limit = flags['--limit'] != null && !flags['--files'] ? Number(flags['--limit']) : DEFAULT_LIMIT.accio[kind]
  const base = {origin, kind, q, scopes, limit}
  const forcedI = !!(flags['-i'] || flags['--ignore-case'])

  if (kind === 'text' || kind === 'regex') {
    const insensitive = forcedI || !hasUpper(q)
    const caseRule = insensitive ? 'insensitive' : 'sensitive'
    const accio = accioArgv(kind, q, scopes, limit, {regex: kind === 'regex', insensitive: forcedI})
    if (kind === 'text') {
      return {
        ...base, mode: 'literal', caseRule, modeChanged: insensitive, accio,
        ijproxy: insensitive
          ? {tool: 'search_regex', args: {q: '(?i)' + escapeRegex(q), paths: scopes, limit}}
          : {tool: 'search_text', args: {q, paths: scopes, limit}},
      }
    }
    return {
      ...base, mode: 'regex', caseRule, modeChanged: false, accio,
      ijproxy: {tool: 'search_regex', args: {q: insensitive && !/^\(\?[a-z]*i/.test(q) ? '(?i)' + q : q, paths: scopes, limit}},
    }
  }
  if (kind === 'file') {
    const isGlob = /[*?[{]/.test(q)
    const ideGlob = isGlob ? explicitGlob(q) : `**/*${charClassGlob(q)}*`
    return {
      ...base, mode: isGlob ? 'glob' : 'substring', caseRule: isGlob && !forcedI ? 'sensitive' : 'insensitive',
      accio: accioArgv('file', q, scopes, limit, {insensitive: forcedI}),
      ijproxy: {tool: 'search_file', args: {q: ideGlob, paths: scopes, limit}},
    }
  }
  if (kind === 'symbol') {
    if (!isFullIdentifier(q)) return {skip: 'symbol not an identifier'}
    return {
      ...base, mode: 'symbol', caseRule: 'sensitive', accio: accioArgv('symbol', q, scopes, limit),
      ijproxy: q.includes('.') ? null : {tool: 'search_symbol', args: {q, paths: scopes, limit}},
      unsupported: q.includes('.') ? {ijproxy: 'Class.member'} : undefined,
    }
  }
  if (kind === 'references' || kind === 'semantic' || kind === 'context') {
    return {...base, mode: kind, caseRule: 'sensitive', accio: accioArgv(kind, q, scopes, limit), ijproxy: null}
  }
  return {skip: 'kind'}
}
