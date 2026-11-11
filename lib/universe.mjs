// The file universe of the checkout: the tracked files and the untracked files that are not ignored.
import {existsSync, readFileSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'

export const REPO = process.env.BENCH_REPO ?? join(homedir(), 'projects/idea-1')
const CACHE = join(import.meta.dir, '../data/universe.txt')

export async function loadUniverse({refresh = false} = {}) {
  if (!refresh && existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < 6 * 3600 * 1000) {
    return readFileSync(CACHE, 'utf8').split('\n').filter(Boolean)
  }
  const run = async args => {
    const p = Bun.spawn(['git', '-C', REPO, ...args], {stdout: 'pipe', stderr: 'pipe', env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}})
    const out = await new Response(p.stdout).text()
    await p.exited
    return out.split('\n').filter(Boolean)
  }
  const files = [...new Set([...(await run(['ls-files'])), ...(await run(['ls-files', '--others', '--exclude-standard']))])].sort()
  await Bun.write(CACHE, files.join('\n') + '\n')
  return files
}

export async function gitHead() {
  const p = Bun.spawn(['git', '-C', REPO, 'rev-parse', 'HEAD'], {stdout: 'pipe'})
  return (await new Response(p.stdout).text()).trim()
}

export function readRepoFile(rel) {
  try {
    return readFileSync(join(REPO, rel), 'utf8')
  }
  catch {
    return null
  }
}
