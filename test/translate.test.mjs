import {expect, test} from 'bun:test'
import {explicitGlob, globMatcher, scopeMatcher} from '../lib/glob.mjs'
import {rustUnsupported, toJsRegex, translate} from '../lib/translate.mjs'

test('explicit globs', () => {
  expect(explicitGlob('Foo.kt')).toBe('**/Foo.kt')
  expect(explicitGlob('plugins/demo/')).toBe('plugins/demo/**')
  expect(explicitGlob('!**/test/**')).toBe('!**/test/**')
  expect(explicitGlob('*.kt')).toBe('**/*.kt')
})

test('glob matching', () => {
  expect(globMatcher('**/*.kt')('a/b/C.kt')).toBe(true)
  expect(globMatcher('**/*.kt')('C.kt')).toBe(true)
  expect(globMatcher('plugins/demo/**')('plugins/demo/x/Y.kt')).toBe(true)
  expect(globMatcher('plugins/demo/**')('plugins/demox/Y.kt')).toBe(false)
  expect(globMatcher('**/*[Ff][Oo]*')('a/xFOo.kt')).toBe(true)
  expect(globMatcher('src/*.kt')('src/a/b.kt')).toBe(false)
  expect(globMatcher('**/*.{kt,java}')('a/B.java')).toBe(true)
  const s = scopeMatcher(['plugins/**', '!**/test/**'])
  expect(s('plugins/a/src/X.kt')).toBe(true)
  expect(s('plugins/a/test/X.kt')).toBe(false)
  expect(s('community/X.kt')).toBe(false)
})

test('regex conversion', () => {
  expect(toJsRegex('(?i)foo|bar', 'sensitive')).toEqual({source: 'foo|bar', flags: 'gmiu'})
  expect(toJsRegex('a(?i)b', 'sensitive')).toBe(null)
  expect(rustUnsupported('foo(?=bar)')).toBe('lookaround')
  expect(rustUnsupported('a|b')).toBe(null)
})

test('IDE lowercase literal goes to accio as case-sensitive regex', () => {
  const e = translate({tool: 'ijproxy', kind: 'text', args: {q: 'foo.bar', paths: ['plugins/demo/'], limit: 20}})
  expect(e.accio).toEqual(['locate', '(?-i)foo\\.bar', '--mode', 'regex', '--scope', 'plugins/demo/**', '--limit', '20'])
  expect(e.modeChanged).toBe(true)
})

test('accio lowercase literal goes to the IDE as (?i) regex, scope from a cd prefix', () => {
  const e = translate({tool: 'accio', kind: 'text', args: {q: 'entries', scope: ['crates/'], flags: {}}}, {repoRelativeCwd: 'community/tools/vm'})
  expect(e.ijproxy).toEqual({tool: 'search_regex', args: {q: '(?i)entries', paths: ['community/tools/vm/crates/**'], limit: 50}})
  expect(e.caseRule).toBe('insensitive')
})

test('accio file substring', () => {
  const e = translate({tool: 'accio', kind: 'file', args: {q: 'classes.rs', scope: [], flags: {}}})
  expect(e.ijproxy.args.q).toBe('**/*[Cc][Ll][Aa][Ss][Ss][Ee][Ss].[Rr][Ss]*')
})
