import { execFileSync } from 'node:child_process'

import type { TaskArtifactChange, TaskArtifacts } from '../domain/types.js'

type SnapshotEntry = {
  path: string
  type: 'added' | 'modified' | 'deleted'
  additions: number | null
  deletions: number | null
}

export type TaskArtifactSnapshot = {
  root: string | null
  changes: Map<string, SnapshotEntry>
  dirty: boolean
  note: string | null
}

function parseGitStatusType(code: string): SnapshotEntry['type'] {
  if (code.includes('D')) {
    return 'deleted'
  }
  if (code.includes('A') || code === '??') {
    return 'added'
  }
  return 'modified'
}

function parseNumstat(stdout: string): Map<string, Pick<SnapshotEntry, 'additions' | 'deletions'>> {
  const stats = new Map<string, Pick<SnapshotEntry, 'additions' | 'deletions'>>()

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const [additionsRaw, deletionsRaw, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t').trim()
    if (!path) {
      continue
    }
    stats.set(path, {
      additions: additionsRaw === '-' ? null : Number.parseInt(additionsRaw ?? '', 10),
      deletions: deletionsRaw === '-' ? null : Number.parseInt(deletionsRaw ?? '', 10)
    })
  }

  return stats
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

export function captureTaskArtifactSnapshot(rootDir: string = process.cwd()): TaskArtifactSnapshot {
  try {
    const root = runGit(['rev-parse', '--show-toplevel'], rootDir).trim()
    const statusOutput = runGit(['status', '--porcelain=v1', '--untracked-files=all'], root)
    const diffOutput = runGit(['diff', '--numstat', '--relative', 'HEAD'], root)
    const diffStats = parseNumstat(diffOutput)
    const changes = new Map<string, SnapshotEntry>()

    for (const rawLine of statusOutput.split(/\r?\n/)) {
      const line = rawLine.trimEnd()
      if (!line) {
        continue
      }

      const statusCode = line.slice(0, 2)
      const path = line.slice(3).trim()
      if (!path) {
        continue
      }

      const stats = diffStats.get(path) ?? { additions: null, deletions: null }
      changes.set(path, {
        path,
        type: parseGitStatusType(statusCode),
        additions: Number.isFinite(stats.additions as number) ? stats.additions : null,
        deletions: Number.isFinite(stats.deletions as number) ? stats.deletions : null
      })
    }

    return {
      root,
      changes,
      dirty: changes.size > 0,
      note: null
    }
  } catch {
    return {
      root: null,
      changes: new Map(),
      dirty: false,
      note: 'No git workspace detected'
    }
  }
}

function toDeltaChange(before: SnapshotEntry | undefined, after: SnapshotEntry): TaskArtifactChange | null {
  if (!before) {
    return {
      path: after.path,
      type: after.type,
      additions: after.additions,
      deletions: after.deletions
    }
  }

  if (
    before.type === after.type
    && before.additions === after.additions
    && before.deletions === after.deletions
  ) {
    return null
  }

  return {
    path: after.path,
    type: after.type,
    additions: after.additions == null || before.additions == null ? after.additions : Math.max(0, after.additions - before.additions),
    deletions: after.deletions == null || before.deletions == null ? after.deletions : Math.max(0, after.deletions - before.deletions)
  }
}

function sortArtifactChanges(changes: TaskArtifactChange[]): TaskArtifactChange[] {
  const rank = (change: TaskArtifactChange): number => {
    if (/\.(ts|tsx|js|jsx|go|rs|py|java|kt|swift|m)$/i.test(change.path)) {
      return 0
    }
    if (/\.(test|spec)\./i.test(change.path)) {
      return 1
    }
    if (/\.(md|json|ya?ml)$/i.test(change.path)) {
      return 2
    }
    return 3
  }

  return [...changes].sort((left, right) => {
    const rankDiff = rank(left) - rank(right)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return left.path.localeCompare(right.path, 'zh-Hans-CN')
  })
}

export function buildTaskArtifacts(
  taskId: string,
  before: TaskArtifactSnapshot,
  after: TaskArtifactSnapshot
): TaskArtifacts {
  const notes: string[] = []
  if (before.note) {
    notes.push(before.note)
  }

  if (before.dirty) {
    notes.push('Artifact snapshot is approximate because the workspace was already dirty before this task ran')
  }

  const changes = Array.from(after.changes.values())
    .map((entry) => toDeltaChange(before.changes.get(entry.path), entry))
    .filter((entry): entry is TaskArtifactChange => entry !== null)
  const sortedChanges = sortArtifactChanges(changes)

  if (sortedChanges.length === 0 && notes.length === 0) {
    notes.push('No recorded artifacts')
  }

  return {
    taskId,
    changes: sortedChanges,
    generatedFiles: sortedChanges.filter((change) => change.type === 'added').map((change) => change.path),
    notes
  }
}
