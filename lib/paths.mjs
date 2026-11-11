import {homedir} from 'node:os'

const HOME = homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The roots of a checkout: a project dir, a Branch Deck lease, a Claude or Air worktree.
const ROOTS = [
  new RegExp(`^(.*/\\.claude/worktrees/[^/]+)(?:/|$)`),
  new RegExp(`^(.*/\\.air/worktrees/[^/]+/[^/]+)(?:/|$)`),
  new RegExp(`^(${HOME}/\\.branch-deck/pool/[^/]+/\\d+/[^/]+)(?:/|$)`),
  new RegExp(`^(${HOME}/\\.treehouse/[^/]+/\\d+/[^/]+)(?:/|$)`),
  new RegExp(`^(${HOME}/projects/[^/]+)(?:/|$)`),
  new RegExp(`^(${HOME}/IdeaProjects/[^/]+)(?:/|$)`),
]

export function checkoutRoot(path) {
  if (!path) return null
  for (const re of ROOTS) {
    const m = re.exec(path)
    if (m) return m[1]
  }
  return null
}

// The repository a checkout belongs to: `idea` for idea-1..5 and their leases and worktrees.
export function repoOf(path) {
  const root = checkoutRoot(path)
  if (!root) return 'other'
  if (/\/projects\/idea-\d+$/.test(root) || /\/(pool|\.treehouse)\/idea-1-[^/]+\/\d+\/idea-1$/.test(root) || /\/projects\/idea-\d+\/\.claude\/worktrees\//.test(root)) return 'idea'
  const wt = /\/projects\/([^/]+)\/\.claude\/worktrees\//.exec(root + '/')
  if (wt) return wt[1].replace(/-\d+$/, '')
  const lease = /\/(?:pool|\.treehouse)\/[^/]+\/\d+\/([^/]+)$/.exec(root)
  if (lease) return lease[1].replace(/-\d+$/, '')
  return root.split('/').at(-1).replace(/-\d+$/, '')
}

// A path relative to its checkout root; a relative path stays as it is.
export function repoRelative(path, cwd) {
  if (!path) return null
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  const root = checkoutRoot(path)
  if (root) return path.slice(root.length + 1)
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return null
}
