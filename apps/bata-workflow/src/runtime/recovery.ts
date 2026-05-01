import { dirname } from 'node:path'

import type { RunReport, WorkerPoolConfig } from '../domain/types.js'
import type { CocoAdapter } from './coco-adapter.js'
import { queueExists } from './task-store.js'
import { runAssignmentsWithRuntime } from './team-runtime.js'
import { buildRunSummary, loadTaskQueue } from './task-queue.js'

function buildReportFromQueue(runDirectory: string): RunReport {
  const queue = loadTaskQueue(runDirectory)
  const runtime = queue.getRuntimeSnapshot()
  const results = queue.listResults()

  return {
    goal: queue.goal,
    plan: queue.plan,
    assignments: queue.listAssignments(),
    batches: runtime.batches,
    runtime,
    results,
    summary: buildRunSummary({ runtime, results })
  }
}

function resolveRunDirectory(params: { runDirectory?: string; reportPath?: string }): string {
  if (params.runDirectory) {
    return params.runDirectory
  }

  if (params.reportPath) {
    return dirname(params.reportPath)
  }

  throw new Error('未提供 runDirectory，也无法从 reportPath 推导恢复目录')
}

export async function resumeRun(params: {
  adapter: CocoAdapter
  workspaceRoot?: string
  runDirectory?: string
  reportPath?: string
  workerPool?: WorkerPoolConfig
}): Promise<RunReport> {
  const { adapter, workerPool, workspaceRoot } = params
  const runDirectory = resolveRunDirectory(params)

  if (!queueExists(runDirectory)) {
    throw new Error(`未找到可恢复的队列状态: ${runDirectory}`)
  }

  await runAssignmentsWithRuntime({
    workspaceRoot,
    runDirectory,
    adapter,
    workerPool,
    resume: true
  })

  return buildReportFromQueue(runDirectory)
}
