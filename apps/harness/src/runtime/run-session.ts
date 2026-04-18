import { existsSync } from 'node:fs'

import type { GoalInput, RoleDefinition, RunReport } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import type { CocoAdapter } from './coco-adapter.js'
import type { FailurePolicyConfig } from './failure-policy.js'
import type { TeamCompositionRegistry } from '../team/team-composition-loader.js'
import { persistRunReport } from './state-store.js'
import { getRunReportPath } from './state-store.js'
import { queueExists } from './task-store.js'
import { runGoal } from '../orchestrator/run-goal.js'

export type RunSessionStatus = 'idle' | 'running' | 'completed' | 'failed'

export type RunSession = {
  runDirectory: string
  start(): Promise<void>
  waitForCompletion(): Promise<RunReport>
  startAndWait(): Promise<RunReport>
  getStatus(): RunSessionStatus
  getError(): Error | null
  getReport(): RunReport | null
}

const RUN_SESSION_START_TIMEOUT_MS = 5000

export function createRunSession(params: {
  workspaceRoot: string
  stateRoot: string
  runDirectory: string
  input: GoalInput
  adapter: CocoAdapter
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  failurePolicyConfig: FailurePolicyConfig
  teamCompositionRegistry: TeamCompositionRegistry
  maxConcurrency?: number
}): RunSession {
  const {
    workspaceRoot,
    stateRoot,
    runDirectory,
    input,
    adapter,
    roleRegistry,
    modelConfig,
    failurePolicyConfig,
    teamCompositionRegistry,
    maxConcurrency = 2
  } = params

  let status: RunSessionStatus = 'idle'
  let error: Error | null = null
  let report: RunReport | null = null
  let runPromise: Promise<RunReport> | null = null
  const reportPath = getRunReportPath(runDirectory)

  const ensureStarted = (): Promise<RunReport> => {
    if (runPromise) {
      return runPromise
    }

    status = 'running'
    runPromise = runGoal({
      workspaceRoot,
      input,
      adapter,
      roleRegistry,
      modelConfig,
      failurePolicyConfig,
      teamCompositionRegistry,
      runDirectory,
      maxConcurrency
    })
      .then((nextReport) => {
        report = nextReport
        persistRunReport(stateRoot, nextReport, runDirectory)
        status = 'completed'
        return nextReport
      })
      .catch((caughtError: unknown) => {
        error = caughtError instanceof Error ? caughtError : new Error(String(caughtError))
        status = 'failed'
        throw error
      })

    return runPromise
  }

  return {
    runDirectory,
    async start(): Promise<void> {
      ensureStarted().catch(() => undefined)
      const startedAt = Date.now()

      while (true) {
        if (status === 'failed') {
          throw error ?? new Error('run session 启动失败')
        }

        if (queueExists(runDirectory) || existsSync(reportPath) || status === 'completed') {
          return
        }

        if (Date.now() - startedAt >= RUN_SESSION_START_TIMEOUT_MS) {
          throw new Error(`run session 启动超时: ${runDirectory}`)
        }

        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
    waitForCompletion(): Promise<RunReport> {
      return ensureStarted()
    },
    startAndWait(): Promise<RunReport> {
      return ensureStarted()
    },
    getStatus(): RunSessionStatus {
      return status
    },
    getError(): Error | null {
      return error
    },
    getReport(): RunReport | null {
      return report
    }
  }
}
