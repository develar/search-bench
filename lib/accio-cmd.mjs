// Splits a Bash command into simple commands, finds each accio invocation and parses its argv.
// Also parses the text answer of accio: the header line of each query and the hits below it.

const SEPARATORS = new Set([';', '&&', '||', '|', '\n', '&'])

// Tokenizes a shell command. Returns tokens; a separator is a token {op}.
// Supports single quotes, double quotes, backslash escapes, $'...' and comments. Not a full shell.
export function tokenize(command) {
  const tokens = []
  let cur = null
  const push = () => {
    if (cur !== null) tokens.push(cur)
    cur = null
  }
  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]
    if (c === '\\' && i + 1 < n) {
      if (command[i + 1] === '\n') {
        i += 2
        continue
      }
      cur = (cur ?? '') + command[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? n : end
      cur = (cur ?? '') + command.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (c === '$' && command[i + 1] === "'") {
      let j = i + 2
      let s = ''
      while (j < n && command[j] !== "'") {
        if (command[j] === '\\' && j + 1 < n) {
          const e = command[j + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e
          j += 2
        }
        else {
          s += command[j++]
        }
      }
      cur = (cur ?? '') + s
      i = j + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(command[j + 1])) {
          s += command[j + 1]
          j += 2
        }
        else {
          s += command[j++]
        }
      }
      cur = (cur ?? '') + s
      i = j + 1
      continue
    }
    if (c === '#' && cur === null) {
      while (i < n && command[i] !== '\n') i++
      continue
    }
    if (c === ' ' || c === '\t') {
      push()
      i++
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      tokens.push({op: two})
      i += 2
      continue
    }
    if (c === '>' || c === '<') {
      // Redirection: `2>&1`, `>/dev/null`, `2> file`. Drop it and its target.
      const fd = cur !== null && /^\d$/.test(cur) ? cur : null
      if (fd !== null) cur = null
      push()
      let j = i + 1
      if (command[j] === '>' || command[j] === '&') j++
      while (j < n && /[0-9-]/.test(command[j])) j++
      const attached = j < n && command[j] !== ' '
      tokens.push({redirect: true, attached})
      i = j
      continue
    }
    if (SEPARATORS.has(c) || c === '(' || c === ')') {
      push()
      tokens.push({op: c})
      i++
      continue
    }
    cur = (cur ?? '') + c
    i++
  }
  push()
  // Drop the target of each redirection.
  const out = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    if (t && t.redirect) {
      const next = tokens[k + 1]
      if (typeof next === 'string') k++
      continue
    }
    out.push(t)
  }
  return out
}

// Returns the simple commands: [{argv, sepBefore, sepAfter}].
export function simpleCommands(command) {
  const tokens = tokenize(command)
  const cmds = []
  let argv = []
  let sepBefore = null
  for (const t of tokens) {
    if (typeof t === 'string') {
      argv.push(t)
      continue
    }
    if (argv.length) cmds.push({argv, sepBefore, sepAfter: t.op})
    else if (cmds.length && !cmds.at(-1).sepAfter) cmds.at(-1).sepAfter = t.op
    argv = []
    sepBefore = t.op
  }
  if (argv.length) cmds.push({argv, sepBefore, sepAfter: null})
  return cmds
}

const VALUE_FLAGS = new Set([
  '--mode', '--project', '--ref', '--scope', '--limit', '-A', '--after', '-B', '--before', '--content',
  '-r', '--replace', '--format', '--kind', '--at', '--seeds', '--file', '--depth', '--days', '--direction',
])
const OPTIONAL_VALUE_FLAGS = new Set(['--source-lines', '-C', '--context'])
const SUBCOMMANDS = new Set([
  'index', 'symbol', 'locate', 'files', 'references', 'implementations', 'trace', 'impact', 'tests', 'context',
  'unused', 'modules', 'stats', 'setup', 'log', 'dump', 'parse', 'help',
])

function isAccioProgram(word) {
  const base = word.split('/').at(-1)
  return base === 'accio' || base === 'accio.cmd'
}

// Parses the argv after the program name.
export function parseAccioArgv(args) {
  const res = {sub: null, queries: [], flags: {}, scope: [], unknown: []}
  let i = 0
  // Global flags may precede the subcommand.
  while (i < args.length && args[i].startsWith('-')) {
    const f = args[i]
    if (f.includes('=')) {
      const [k, v] = f.split(/=(.*)/s)
      res.flags[k] = v
      i++
    }
    else if (VALUE_FLAGS.has(f)) {
      res.flags[f] = args[i + 1]
      i += 2
    }
    else {
      res.flags[f] = true
      i++
    }
  }
  if (i < args.length && SUBCOMMANDS.has(args[i])) res.sub = args[i++]
  for (; i < args.length; i++) {
    let a = args[i]
    if (a === '--') {
      res.queries.push(...args.slice(i + 1))
      break
    }
    if (a.startsWith('--') && a.includes('=')) {
      const [k, v] = a.split(/=(.*)/s)
      if (k === '--scope') res.scope.push(v)
      else res.flags[k] = v
      continue
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      if (a === '--scope') {
        res.scope.push(args[++i])
        continue
      }
      if (VALUE_FLAGS.has(a)) {
        res.flags[a] = args[++i]
        continue
      }
      if (OPTIONAL_VALUE_FLAGS.has(a)) {
        const next = args[i + 1]
        if (next !== undefined && /^(\d+|all)$/.test(next)) {
          res.flags[a] = next
          i++
        }
        else {
          res.flags[a] = true
        }
        continue
      }
      // `-C3` style
      const m = /^(-[ABC])(\d+)$/.exec(a)
      if (m) {
        res.flags[m[1]] = m[2]
        continue
      }
      res.flags[a] = true
      continue
    }
    res.queries.push(a)
  }
  return res
}

// Finds accio invocations in a Bash command.
export function findAccioInvocations(command) {
  const out = []
  const cmds = simpleCommands(command)
  let cwd = null
  for (let k = 0; k < cmds.length; k++) {
    const {argv, sepAfter} = cmds[k]
    let start = 0
    while (start < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start])) start++
    // `env X=1 accio`, `time accio`, `command accio`
    while (start < argv.length && ['env', 'time', 'command', 'exec', 'nice'].includes(argv[start])) {
      start++
      while (start < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start])) start++
    }
    const prog = argv[start]
    if (prog === 'cd' && argv[start + 1]) cwd = argv[start + 1]
    if (!prog || !isAccioProgram(prog)) continue
    const parsed = parseAccioArgv(argv.slice(start + 1))
    out.push({...parsed, cwd, piped: sepAfter === '|', argv: argv.slice(start)})
  }
  return {invocations: out, simpleCount: cmds.length}
}

// --- answer parsing ---

// Header examples:
//   locate "q": 90 hits [exact; partial]
//   locate "q" --files: 80 file(s), 177 hits [partial]
//   symbol Foo: 0 hits, match=none [exact; complete]
//   references Foo: 74 hits [structural; partial]
//   files: 0 file(s) [exact; complete]
const HEADER_RE = /^(symbol|locate|files|references|implementations|trace|impact|tests|context|unused)\b(.*?): (\d+) (hits?|file\(s\)|declarations?|callers?|callees?|tests?|results?|[a-z()]+)\b([^\[\n]*)\[([a-z]+)(?:; ([a-z]+))?\]\s*$/gm

// The header of accio before mid-October 2026 held its own time:
//   locate "q": 12 hit(s), candidates=3 scanned=40 quality=exact completeness=complete (12.3ms)
//   symbol Foo: 2 hit(s), match=exact, tier=library, quality=exact, completeness=complete (4ms)
//   locate "q" --files: 3 file(s), 9 hit(s), candidates=N scanned=N completeness=complete (1.2s)
const OLD_HEADER_RE = /^(symbol|locate|files|references|implementations|trace|impact|tests|context|unused)\b(.*?): (?:(\d+) file\(s\), )?(\d+) (hit\(s\)|file\(s\)|node\(s\)|[a-z]+\(s\))(.*?)completeness=(\w+),?\s*\((\d+(?:\.\d+)?)(ms|s)\)\s*$/gm

export function parseAccioHeaders(text) {
  const headers = []
  for (const m of text.matchAll(OLD_HEADER_RE)) {
    const [, sub, rest, files, count, unit, mid, completeness, t, tu] = m
    const filesFirst = files != null
    headers.push({
      sub,
      query: rest.trim(),
      count: Number(filesFirst ? files : count),
      unit: filesFirst ? 'file(s)' : unit,
      tail: mid,
      quality: /quality=(\w+)/.exec(mid)?.[1] ?? null,
      complete: completeness === 'complete' ? true : completeness === 'partial' ? false : null,
      selfMs: Number(t) * (tu === 's' ? 1000 : 1),
      index: m.index,
    })
  }
  for (const m of text.matchAll(HEADER_RE)) {
    const [, sub, rest, count, unit, tail, a, b] = m
    const qualities = new Set(['exact', 'structural', 'heuristic', 'unknown'])
    const quality = qualities.has(a) ? a : null
    const completeness = b ?? (qualities.has(a) ? null : a)
    headers.push({
      sub,
      query: rest.trim(),
      count: Number(count),
      unit,
      tail: tail.trim(),
      quality,
      complete: completeness === 'complete' ? true : completeness === 'partial' ? false : null,
      index: m.index,
    })
  }
  return headers.sort((a, b) => a.index - b.index)
}

export function accioRefreshNote(text) {
  return /index built by another accio version|rebuild (is running|was requested)|refresh lands|building the index|index is building/.test(text)
}

// Parses hits from a text answer of `locate`, `references`, `symbol`.
// A file line is a path without leading spaces; a hit line is `  N: text` (or `  N  text` for context).
// The output is a tree: an unindented `dir/` line is a prefix, an indented name below it is a file in it.
export function parseAccioTextHits(text) {
  const hits = []
  let file = null
  let prefix = ''
  const PATH = /^([\w.@+\-/]+)(?::(\d+)(?:-\d+)?)?(?:\s|$)/
  for (const line of text.split('\n')) {
    if (!line) continue
    const indent = /^ */.exec(line)[0].length
    const body = line.slice(indent)
    if (/^(note|ranked by|locate|symbol|files|references)\b/.test(body)) continue
    const h = /^(\d+):/.exec(body)
    if (h && indent > 0) {
      if (file) hits.push({file, line: Number(h[1])})
      continue
    }
    if (/^\d+\s/.test(body) || body === '--') continue
    const m = PATH.exec(body)
    if (!m) continue
    if (indent === 0) {
      if (m[1].endsWith('/')) {
        prefix = m[1]
        file = null
        continue
      }
      prefix = ''
      file = m[1]
    }
    else {
      if (m[1].endsWith('/')) continue
      file = prefix + m[1]
    }
    if (!/\.|\/|^[A-Z][\w-]*$/.test(m[1])) continue
    if (m[2]) hits.push({file, line: Number(m[2])})
    else if (/^\s*$/.test(body.slice(m[0].length)) || / \d+ hits?$/.test(body)) hits.push({file, line: null})
  }
  return hits
}
