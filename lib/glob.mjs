// Globs with the IDE semantics: `**` crosses directories, `*` and `?` stay in one segment, `[...]` is a class.
// A pattern without `/` means `**/pattern`; a trailing `/` means `dir/**`.

const cache = new Map()

export function explicitGlob(p) {
  let neg = ''
  if (p.startsWith('!')) {
    neg = '!'
    p = p.slice(1)
  }
  p = p.replace(/^\.\//, '')
  if (p.endsWith('/')) p += '**'
  else if (!p.includes('/')) p = '**/' + p
  return neg + p
}

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        }
        else {
          re += '.*'
          i += 1
        }
      }
      else {
        re += '[^/]*'
      }
    }
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end === -1) re += '\\['
      else {
        let cls = glob.slice(i + 1, end)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += '[' + cls.replace(/\\/g, '\\\\') + ']'
        i = end
      }
    }
    else if (c === '{') {
      const end = glob.indexOf('}', i + 1)
      if (end === -1) re += '\\{'
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'
        i = end
      }
    }
    else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

export function globMatcher(glob) {
  let m = cache.get(glob)
  if (!m) {
    const re = globToRegExp(glob)
    // A plain path without glob characters also matches everything below it.
    const plain = !/[*?[{]/.test(glob)
    m = plain ? path => re.test(path) || path.startsWith(glob.replace(/^\*\*\//, '') + '/') : path => re.test(path)
    cache.set(glob, m)
  }
  return m
}

// Scope test with includes and `!` excludes, all in explicit form.
export function scopeMatcher(scopes) {
  const inc = scopes.filter(s => !s.startsWith('!')).map(globMatcher)
  const exc = scopes.filter(s => s.startsWith('!')).map(s => globMatcher(s.slice(1)))
  return path => (inc.length === 0 || inc.some(m => m(path))) && !exc.some(m => m(path))
}
