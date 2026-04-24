import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { GoalInput, RoleDefinition, RunReport, TeamSlotTmuxBinding } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import type { CocoAdapter } from './coco-adapter.js'
import type { FailurePolicyConfig } from './failure-policy.js'
import type { TeamCompositionRegistry } from '../team/team-composition-loader.js'
import { persistRunReport } from './state-store.js'
import { getRunReportPath } from './state-store.js'
import { queueExists } from './task-store.js'
import { runGoal } from '../orchestrator/run-goal.js'
import { createHarnessRepoPaths } from './repo-paths.js'

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

const DEFAULT_MONITOR_STATE_ROOT_RELATIVE_PATH = ['.harness', 'state'] as const

type MonitorBoardRuntimeState = {
  pid?: number
  activeRootSessionIds?: unknown
}

export type MonitorSessionCleanupResult = {
  rootSessionId: string
  sessionStatePath: string
  boardRuntimeStatePath: string
  sessionStateRemoved: boolean
  boardAction: 'none' | 'released' | 'stopped' | 'stale-state-cleared'
  remainingActiveRootSessionIds: string[]
}

type TmuxManagerModule = {
  checkTmuxHealth(): Promise<{ available: boolean }>
  createSplitLayout(
    layout: {
      type: 'horizontal' | 'vertical' | 'grid'
      panes: Array<{ name: string; cwd: string }>
    },
    options?: {
      newWindow?: boolean
      sessionName?: string
      windowName?: string
      timeout?: number
    }
  ): Promise<{
    sessionName: string
    workerPaneIds: string[]
    mode: TeamSlotTmuxBinding['mode']
  }>
  getPaneInfo(paneId: string): Promise<{ paneIndex: number; title?: string } | null>
  sanitizeName(name: string): string
}

export function resolveTmuxManagerFallbackSpecifiers(moduleUrl: string = import.meta.url): string[] {
  const { repoRoot } = createHarnessRepoPaths(moduleUrl)
  return [
    pathToFileURL(resolve(repoRoot, 'packages', 'tmux-manager', 'dist', 'index.js')).href,
    pathToFileURL(resolve(repoRoot, 'packages', 'tmux-manager', 'src', 'index.ts')).href
  ]
}

export async function loadTmuxManagerModule(params?: {
  importPackage?: (specifier: string) => Promise<TmuxManagerModule>
  importFallback?: (specifier: string) => Promise<TmuxManagerModule>
  moduleUrl?: string
}): Promise<TmuxManagerModule> {
  const importPackage = params?.importPackage ?? (async (specifier: string) => await import(specifier) as TmuxManagerModule)
  const importFallback = params?.importFallback ?? (async (specifier: string) => await import(specifier) as TmuxManagerModule)
  const packageName = '@luobata/tmux-manager'
  const fallbackSpecifiers = resolveTmuxManagerFallbackSpecifiers(params?.moduleUrl)

  try {
    return await importPackage(packageName)
  } catch (primaryError) {
    let lastFallbackError: unknown = primaryError
    for (const fallbackSpecifier of fallbackSpecifiers) {
      try {
        return await importFallback(fallbackSpecifier)
      } catch (fallbackError) {
        lastFallbackError = fallbackError
      }
    }

    throw lastFallbackError instanceof Error ? lastFallbackError : new Error(String(lastFallbackError))
  }
}

function buildTeamTmuxLayoutType(teamSize: number): 'horizontal' | 'grid' {
  return teamSize <= 2 ? 'horizontal' : 'grid'
}

function buildSanitizedTmuxName(name: string, sanitizeName: (value: string) => string, fallback: string): string {
  const sanitized = sanitizeName(name).trim()
  return sanitized || fallback
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deriveWorkspaceHashSessionId(workspaceRoot: string): string {
  const hash = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12)
  return `workspace-${hash}`
}

function resolveLiveCocoSessionId(): string | null {
  const sessionId = process.env.COCO_SESSION_ID?.trim()
  return sessionId ? sessionId : null
}

function getRootSessionIdForWorkspace(workspaceRoot: string): string {
  return resolveLiveCocoSessionId() ?? deriveWorkspaceHashSessionId(resolve(workspaceRoot))
}

function getMonitorSessionStatePath(stateRoot: string, rootSessionId: string): string {
  return resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`)
}

function getMonitorBoardRuntimeStatePath(stateRoot: string): string {
  return resolve(stateRoot, 'monitor-board', 'runtime.json')
}

function normalizeActiveRootSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
}

async function readMonitorBoardRuntimeState(runtimeStatePath: string): Promise<MonitorBoardRuntimeState | null> {
  try {
    const raw = await readFile(runtimeStatePath, 'utf8')
    const parsed = JSON.parse(raw) as MonitorBoardRuntimeState
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempFilePath, filePath)
}

async function defaultCleanupMonitorBoardProcess(pid: number | null): Promise<void> {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGTERM')
      return
    } catch {}
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

export async function cleanupMonitorSessionForWorkspace(params: {
  workspaceRoot: string
  stateRoot?: string
  rootSessionId?: string
  cleanupMonitorBoardProcess?: (pid: number | null) => Promise<void>
}): Promise<MonitorSessionCleanupResult> {
  const workspaceRoot = resolve(params.workspaceRoot)
  const rootSessionId = params.rootSessionId ?? getRootSessionIdForWorkspace(workspaceRoot)
  const stateRoot = resolve(params.stateRoot ?? resolve(workspaceRoot, ...DEFAULT_MONITOR_STATE_ROOT_RELATIVE_PATH))
  const sessionStatePath = getMonitorSessionStatePath(stateRoot, rootSessionId)
  const boardRuntimeStatePath = getMonitorBoardRuntimeStatePath(stateRoot)
  const cleanupMonitorBoardProcess = params.cleanupMonitorBoardProcess ?? defaultCleanupMonitorBoardProcess
  const sessionStateExists = existsSync(sessionStatePath)

  if (sessionStateExists) {
    await rm(sessionStatePath, { force: true })
  }

  const runtimeState = await readMonitorBoardRuntimeState(boardRuntimeStatePath)
  if (!runtimeState) {
    return {
      rootSessionId,
      sessionStatePath,
      boardRuntimeStatePath,
      sessionStateRemoved: sessionStateExists,
      boardAction: 'none',
      remainingActiveRootSessionIds: [],
    }
  }

  const trackedRootSessionIds = normalizeActiveRootSessionIds(runtimeState.activeRootSessionIds)
  if (trackedRootSessionIds.length === 0) {
    return {
      rootSessionId,
      sessionStatePath,
      boardRuntimeStatePath,
      sessionStateRemoved: sessionStateExists,
      boardAction: 'none',
      remainingActiveRootSessionIds: [],
    }
  }

  const remainingActiveRootSessionIds = trackedRootSessionIds.filter((sessionId) => sessionId !== rootSessionId)

  if (trackedRootSessionIds.length > 0 && remainingActiveRootSessionIds.length > 0) {
    await writeJsonFileAtomic(boardRuntimeStatePath, {
      ...runtimeState,
      activeRootSessionIds: remainingActiveRootSessionIds,
    })

    return {
      rootSessionId,
      sessionStatePath,
      boardRuntimeStatePath,
      sessionStateRemoved: sessionStateExists,
      boardAction: 'released',
      remainingActiveRootSessionIds,
    }
  }

  const pid = typeof runtimeState.pid === 'number' && Number.isInteger(runtimeState.pid) ? runtimeState.pid : null
  await cleanupMonitorBoardProcess(pid)
  await rm(boardRuntimeStatePath, { force: true })

  return {
    rootSessionId,
    sessionStatePath,
    boardRuntimeStatePath,
    sessionStateRemoved: sessionStateExists,
    boardAction: pid ? 'stopped' : 'stale-state-cleared',
    remainingActiveRootSessionIds: [],
  }
}

export async function prepareTeamRunSpecWithTmuxBindings(params: {
  workspaceRoot: string
  runDirectory: string
  input: GoalInput
  loadTmuxManager?: () => Promise<TmuxManagerModule>
}): Promise<GoalInput> {
  const { workspaceRoot, runDirectory, input, loadTmuxManager = loadTmuxManagerModule } = params
  const teamRunSpec = input.teamRunSpec
  if (!teamRunSpec || teamRunSpec.slots.length === 0) {
    return input
  }

  try {
    const tmuxManager = await loadTmuxManager()
    const health = await tmuxManager.checkTmuxHealth()
    if (!health.available) {
      return input
    }

    const runLabel = basename(runDirectory)
    const sessionName = buildSanitizedTmuxName(`harness-${runLabel}`, tmuxManager.sanitizeName, 'harness-team')
    const windowName = buildSanitizedTmuxName(`${runLabel}-team`, tmuxManager.sanitizeName, 'team')
    const layout: {
      type: 'horizontal' | 'vertical' | 'grid'
      panes: Array<{ name: string; cwd: string }>
    } = {
      type: buildTeamTmuxLayoutType(teamRunSpec.teamSize),
      panes: [
        { name: 'leader', cwd: workspaceRoot },
        ...teamRunSpec.slots.map((slot) => ({
          name: `slot-${slot.slotId}`,
          cwd: workspaceRoot
        }))
      ]
    }

    const createdLayout = await tmuxManager.createSplitLayout(layout, {
      newWindow: true,
      sessionName,
      windowName
    })

    const slots = await Promise.all(teamRunSpec.slots.map(async (slot, index) => {
      const paneId = createdLayout.workerPaneIds[index]
      if (!paneId) {
        return slot
      }

      const paneInfo = await tmuxManager.getPaneInfo(paneId).catch(() => null)
      return {
        ...slot,
        tmux: {
          paneId,
          sessionName: createdLayout.sessionName,
          mode: createdLayout.mode,
          paneIndex: paneInfo?.paneIndex ?? null,
          title: paneInfo?.title?.trim() ? paneInfo.title : null
        }
      }
    }))

    return {
      ...input,
      teamRunSpec: {
        ...teamRunSpec,
        slots
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[harness] tmux bootstrap skipped: ${message}\n`)
    return input
  }
}

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
  prepareInput?: (params: { workspaceRoot: string; runDirectory: string; input: GoalInput }) => Promise<GoalInput>
  cleanupMonitorSession?: (params: { workspaceRoot: string; stateRoot: string; rootSessionId: string }) => Promise<unknown>
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
    maxConcurrency = 2,
    prepareInput = prepareTeamRunSpecWithTmuxBindings,
    cleanupMonitorSession = ({ workspaceRoot, stateRoot, rootSessionId }) => cleanupMonitorSessionForWorkspace({ workspaceRoot, stateRoot, rootSessionId })
  } = params

  let status: RunSessionStatus = 'idle'
  let error: Error | null = null
  let report: RunReport | null = null
  let runPromise: Promise<RunReport> | null = null
  let startupPromise: Promise<void> | null = null
  const reportPath = getRunReportPath(runDirectory)
  const rootSessionId = getRootSessionIdForWorkspace(workspaceRoot)
  let cleanupPromise: Promise<void> | null = null
  let startupTimedOut = false

  const runMonitorCleanup = async (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        try {
          await cleanupMonitorSession({ workspaceRoot, stateRoot, rootSessionId })
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          process.stderr.write(`[harness] monitor cleanup skipped: ${message}\n`)
        }
      })()
    }

    await cleanupPromise
  }

  const ensureStarted = (): Promise<RunReport> => {
    if (runPromise) {
      return runPromise
    }

    status = 'running'
    startupPromise = new Promise<void>((resolve, reject) => {
      runPromise = prepareInput({ workspaceRoot, runDirectory, input })
      .then((preparedInput) => {
        if (startupTimedOut) {
          throw error ?? new Error(`run session 启动超时: ${runDirectory}`)
        }

        resolve()
        return runGoal({
          workspaceRoot,
          input: preparedInput,
          adapter,
          roleRegistry,
          modelConfig,
          failurePolicyConfig,
          teamCompositionRegistry,
          runDirectory,
          maxConcurrency
        })
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
        reject(error)
        throw error
      })
      .finally(async () => {
        await runMonitorCleanup()
      })
    })
    void startupPromise.catch(() => undefined)

    return runPromise!
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
          startupTimedOut = true
          error = error ?? new Error(`run session 启动超时: ${runDirectory}`)
          status = 'failed'
          await runMonitorCleanup()
          throw error
        }

        await Promise.race([
          startupPromise?.catch(() => undefined) ?? Promise.resolve(),
          delay(10)
        ])
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
