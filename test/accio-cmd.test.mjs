import {expect, test} from 'bun:test'
import {findAccioInvocations, parseAccioHeaders, parseAccioTextHits, tokenize} from '../lib/accio-cmd.mjs'

test('plain locate with regex and scope', () => {
  const {invocations} = findAccioInvocations("accio locate 'a|b' --mode regex --scope plugins/demo/")
  expect(invocations).toHaveLength(1)
  const [i] = invocations
  expect(i.sub).toBe('locate')
  expect(i.queries).toEqual(['a|b'])
  expect(i.flags['--mode']).toBe('regex')
  expect(i.scope).toEqual(['plugins/demo/'])
  expect(i.piped).toBe(false)
})

test('cd, accio.cmd, pipe and redirect', () => {
  const {invocations, simpleCount} = findAccioInvocations(
    "cd /Users/x/idea-1 && ./community/tools/accio.cmd symbol Foo Bar --source-lines 2>&1 | head -150")
  expect(invocations).toHaveLength(1)
  const [i] = invocations
  expect(i.cwd).toBe('/Users/x/idea-1')
  expect(i.sub).toBe('symbol')
  expect(i.queries).toEqual(['Foo', 'Bar'])
  expect(i.flags['--source-lines']).toBe(true)
  expect(i.piped).toBe(true)
  expect(simpleCount).toBe(3)
})

test('optional value and several invocations', () => {
  const {invocations} = findAccioInvocations('accio references A; accio symbol B --source-lines 40; accio files "Service*"')
  expect(invocations.map(i => i.sub)).toEqual(['references', 'symbol', 'files'])
  expect(invocations[1].flags['--source-lines']).toBe('40')
  expect(invocations[2].queries).toEqual(['Service*'])
})

test('double quotes with escapes and scope=', () => {
  const {invocations} = findAccioInvocations('accio locate "say \\"hi\\"" --scope=\'*.kt\' --scope \'!**/gen/**\' -i')
  expect(invocations[0].queries).toEqual(['say "hi"'])
  expect(invocations[0].scope).toEqual(['*.kt', '!**/gen/**'])
  expect(invocations[0].flags['-i']).toBe(true)
})

test('not accio', () => {
  expect(findAccioInvocations("grep -r accio . | wc -l").invocations).toHaveLength(0)
  expect(tokenize("echo 'a b' c")).toEqual(['echo', 'a b', 'c'])
})

test('headers', () => {
  const text = `index built by another accio version; a rebuild is running
locate "air|System.load": 90 hits [exact; partial]
  note: cut by --limit 50
plugins/demo/native/src/lib.rs
  1: //! air-ide
  2  context
symbol Foo: 0 hits, match=none [exact; complete]
locate "ijproxy" --files: 80 file(s), 177 hits [partial]
files: 0 file(s) [exact; complete]
`
  const h = parseAccioHeaders(text)
  expect(h.map(x => [x.sub, x.count, x.quality, x.complete])).toEqual([
    ['locate', 90, 'exact', false],
    ['symbol', 0, 'exact', true],
    ['locate', 80, null, false],
    ['files', 0, 'exact', true],
  ])
  expect(parseAccioTextHits(text).filter(h => h.line)).toEqual([{file: "plugins/demo/native/src/lib.rs", line: 1}])
})

test('tree output of files and references', () => {
  const files = `plugins/demo/registry/
  AcpRegistryFetcher.kt
  AcpRegistryLifecycle.kt
plugins/other/Top.kt
`
  expect(parseAccioTextHits(files).map(h => h.file)).toEqual([
    'plugins/demo/registry/AcpRegistryFetcher.kt', 'plugins/demo/registry/AcpRegistryLifecycle.kt', 'plugins/other/Top.kt'])
  const refs = `plugins/demo/NativeFileCopy.kt
  25:type private val LOG = logger<NativeFileCopy>()   in LOG 25-25
  49:declaration class NativeFileCopy(
plugins/
  llm/a/IjProxy.kt:6 1 hit
`
  expect(parseAccioTextHits(refs).filter(h => h.line)).toEqual([
    {file: 'plugins/demo/NativeFileCopy.kt', line: 25}, {file: 'plugins/demo/NativeFileCopy.kt', line: 49}, {file: 'plugins/llm/a/IjProxy.kt', line: 6}])
})

test('old header with its own time', () => {
  const h = parseAccioHeaders(`locate "x": 12 hit(s), candidates=3 scanned=40 quality=exact completeness=partial (12.5ms)
symbol Foo: 2 hit(s), match=exact, tier=library, quality=exact, completeness=complete (1.2s)
locate "y" --files: 3 file(s), 9 hit(s), candidates=1 scanned=2 completeness=complete (4ms)
`)
  expect(h.map(x => [x.sub, x.count, x.quality, x.complete, x.selfMs])).toEqual([
    ['locate', 12, 'exact', false, 12.5], ['symbol', 2, 'exact', true, 1200], ['locate', 3, null, true, 4]])
})
