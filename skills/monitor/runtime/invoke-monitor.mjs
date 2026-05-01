#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { ensureMonitorBoardRunning as defaultEnsureBoardRunning } from './board-launcher.mjs'
import { resolveMonitorContext } from './context.mjs'
import { openMonitorSession } from './monitor-session.mjs'
import { readMonitorSessionState, writeMonitorSessionState } from './session-store.mjs'

const appendLegacyInstallWarning = (message, context) => {
  if (!context.hasLegacyInstall) {
    return message
  }

  return `${message} (legacy install @luobata/monitor detected; relink to monitor when convenient)`
}

const DEFAULT_COCO_SESSIONS_ENV = 'COCO_SESSIONS_ROOT'
const MONITOR_RUNTIME_LOG_FILE_NAME = 'monitor-runtime.log'
const DEFAULT_MONITOR_INVOKE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.MONITOR_INVOKE_TIMEOUT_MS ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 20_000
})()

const writeMonitorRuntimeLog = async (context, event, data = {}) => {
  if (!context?.bataWorkflowStateRoot) {
    return
  }

  const logDirectoryPath = resolve(context.bataWorkflowStateRoot, 'monitor-logs')
  const logFilePath = resolve(logDirectoryPath, MONITOR_RUNTIME_LOG_FILE_NAME)
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    data,
  }

  try {
    await mkdir(logDirectoryPath, { recursive: true })
    await appendFile(logFilePath, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // Logging should be best-effort and never break /monitor.
  }
}

const hasExplicitRootSessionId = (options) => typeof options?.rootSessionId === 'string' && options.rootSessionId.trim().length > 0

const readJsonFile = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
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

const parseIsoTimestampMs = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const readLatestEventTimestampMs = async (eventsFilePath) => {
  try {
    const raw = await readFile(eventsFilePath, 'utf8')
    let latestTimestampMs = null

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue
      }

      try {
        const event = JSON.parse(line)
        const timestampMs = parseIsoTimestampMs(event?.created_at)
        if (timestampMs !== null && (latestTimestampMs === null || timestampMs > latestTimestampMs)) {
          latestTimestampMs = timestampMs
        }
      } catch {
        // Ignore malformed JSONL rows and continue scanning.
      }
    }

    return latestTimestampMs
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const readLatestTraceTimestampMs = async (tracesFilePath) => {
  try {
    const raw = await readFile(tracesFilePath, 'utf8')
    let latestTimestampMs = null

    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue
      }

      try {
        const trace = JSON.parse(line)
        if (typeof trace?.startTime !== 'number') {
          continue
        }

        const duration = typeof trace.duration === 'number' ? Math.max(0, trace.duration) : 0
        const traceTimestampMs = Math.floor((trace.startTime + duration) / 1000)
        if (Number.isFinite(traceTimestampMs) && (latestTimestampMs === null || traceTimestampMs > latestTimestampMs)) {
          latestTimestampMs = traceTimestampMs
        }
      } catch {
        // Ignore malformed JSONL rows and continue scanning.
      }
    }

    return latestTimestampMs
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const resolveCocoSessionsRoot = (context) => {
  const configuredRoot = process.env[DEFAULT_COCO_SESSIONS_ENV]?.trim()
  if (configuredRoot) {
    return resolve(configuredRoot)
  }

  return process.platform === 'darwin'
    ? resolve(context.homeDir, 'Library', 'Caches', 'coco', 'sessions')
    : resolve(context.homeDir, '.cache', 'coco', 'sessions')
}

const inferLatestCocoSessionId = async (context) => {
  const cocoSessionsRoot = resolveCocoSessionsRoot(context)

  try {
    const entries = await readdir(cocoSessionsRoot, { withFileTypes: true })
    const workspaceRoot = resolve(context.cwd)
    const candidates = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const session = await readJsonFile(resolve(cocoSessionsRoot, entry.name, 'session.json'))
            const sessionWorkspaceRoot = typeof session?.metadata?.cwd === 'string' ? resolve(session.metadata.cwd) : null
            if (sessionWorkspaceRoot !== workspaceRoot) {
              return null
            }

            const updatedAtMs = parseIsoTimestampMs(session.updated_at ?? session.created_at ?? '')
            if (updatedAtMs === null) {
              return null
            }

            const sessionDirectoryPath = resolve(cocoSessionsRoot, entry.name)
            const latestEventTimestampMs = await readLatestEventTimestampMs(resolve(sessionDirectoryPath, 'events.jsonl'))
            const latestTraceTimestampMs = await readLatestTraceTimestampMs(resolve(sessionDirectoryPath, 'traces.jsonl'))
            const latestActivityMs = Math.max(
              updatedAtMs,
              latestEventTimestampMs ?? Number.NEGATIVE_INFINITY,
              latestTraceTimestampMs ?? Number.NEGATIVE_INFINITY,
            )

            return {
              id: typeof session.id === 'string' && session.id.length > 0 ? session.id : entry.name,
              updatedAtMs,
              latestActivityMs,
            }
          }),
      )
    ).filter((candidate) => candidate !== null)

    if (candidates.length === 0) {
      return null
    }

    return candidates.sort((left, right) => {
      if (right.latestActivityMs !== left.latestActivityMs) {
        return right.latestActivityMs - left.latestActivityMs
      }

      return right.updatedAtMs - left.updatedAtMs
    })[0].id
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const resolveOwnerActorId = ({ context, existingSession, result }) => {
  if (existingSession?.ownerActorId) {
    return existingSession.ownerActorId
  }

  if (result.kind === 'create') {
    return context.requesterActorId
  }

  return result.requesterActorId
}

const runWithTimeout = async (promise, timeoutMs, timeoutLabel) => {
  const effectiveTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_MONITOR_INVOKE_TIMEOUT_MS

  return await Promise.race([
    promise,
    new Promise((_, reject) => {
      globalThis.setTimeout(() => {
        reject(new Error(`${timeoutLabel} timed out after ${effectiveTimeoutMs}ms`))
      }, effectiveTimeoutMs)
    }),
  ])
}

export async function invokeMonitor(options = {}) {
  const provisionalContext = resolveMonitorContext(options)
  const ensureBoardRunning = options.ensureBoardRunning ?? defaultEnsureBoardRunning
  const invokeStartedAt = Date.now()
  await writeMonitorRuntimeLog(provisionalContext, 'invoke.start', {
    cwd: provisionalContext.cwd,
    rootSessionId: provisionalContext.rootSessionId,
  })

  const explicitCocoSessionId = process.env.COCO_SESSION_ID?.trim() || null
  const inferredRootSessionId = explicitCocoSessionId || hasExplicitRootSessionId(options)
    ? null
    : await runWithTimeout(inferLatestCocoSessionId(provisionalContext), options.inferRootTimeoutMs, 'monitor root session inference')
  const context = inferredRootSessionId
    ? resolveMonitorContext({ ...options, rootSessionId: inferredRootSessionId })
    : provisionalContext
  const existingSession = await readMonitorSessionState(context.stateFilePath)
  const cocoSessionId = explicitCocoSessionId ?? existingSession?.cocoSessionId ?? inferredRootSessionId ?? null
  await writeMonitorRuntimeLog(context, 'invoke.session_resolved', {
    explicitCocoSessionId,
    inferredRootSessionId,
    rootSessionId: context.rootSessionId,
    cocoSessionId,
  })

  const result = openMonitorSession({
    rootSessionId: context.rootSessionId,
    requesterActorId: context.requesterActorId,
    isRootActor: context.isRootActor,
    existingMonitorSessionId: existingSession?.monitorSessionId ?? null,
  })
  const now = new Date().toISOString()
  const persistedSession = {
    rootSessionId: result.rootSessionId,
    monitorSessionId: result.monitorSessionId,
    ownerActorId: resolveOwnerActorId({ context, existingSession, result }),
    lastAttachedActorId: result.requesterActorId,
    status: 'active',
    createdAt: existingSession?.createdAt ?? now,
    updatedAt: now,
    workspaceRoot: context.cwd,
    cocoSessionId,
  }

  await writeMonitorSessionState(context.stateFilePath, persistedSession)
  await writeMonitorRuntimeLog(context, 'invoke.session_persisted', {
    stateFilePath: context.stateFilePath,
    monitorSessionId: persistedSession.monitorSessionId,
    ownerActorId: persistedSession.ownerActorId,
    requesterActorId: persistedSession.lastAttachedActorId,
  })

  let board
  const boardLaunchStartedAt = Date.now()
  try {
    board = await runWithTimeout(
      ensureBoardRunning({
        repoRoot: context.boardRepoRoot,
        stateRoot: context.bataWorkflowStateRoot,
        runtimeStatePath: context.boardRuntimeStatePath,
        monitorSessionId: result.monitorSessionId,
        rootSessionId: result.rootSessionId,
        host: context.boardHost,
        preferredPort: context.boardPort,
      }),
      options.boardStartTimeoutMs,
      'monitor-board startup',
    )
  } catch (error) {
    board = {
      status: 'failed',
      url: null,
      port: context.boardPort,
      pid: null,
      message: `monitor-board launch failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  await writeMonitorRuntimeLog(context, 'invoke.board_result', {
    durationMs: Date.now() - boardLaunchStartedAt,
    boardStatus: board?.status ?? 'failed',
    boardUrl: board?.url ?? null,
    boardPort: board?.port ?? null,
    boardMessage: board?.message ?? null,
  })

  await writeMonitorRuntimeLog(context, 'invoke.finish', {
    durationMs: Date.now() - invokeStartedAt,
    kind: result.kind,
    monitorSessionId: result.monitorSessionId,
    rootSessionId: result.rootSessionId,
  })

  return {
    kind: result.kind,
    monitorSessionId: result.monitorSessionId,
    rootSessionId: result.rootSessionId,
    requesterActorId: result.requesterActorId,
    isRootActor: result.isRootActor,
    message: appendLegacyInstallWarning(result.message, context),
    board,
  }
}

function parseCliArgs(argv) {
  const options = {}
  let output = 'json'

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--cwd') {
      const next = argv[index + 1]
      if (!next) {
        throw new Error('--cwd requires a value')
      }
      options.cwd = resolve(next)
      index += 1
      continue
    }

    if (arg.startsWith('--cwd=')) {
      options.cwd = resolve(arg.slice('--cwd='.length))
      continue
    }

    if (arg === '--output') {
      const next = argv[index + 1]
      if (!next) {
        throw new Error('--output requires a value')
      }
      output = next
      index += 1
      continue
    }

    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length)
      continue
    }

    throw new Error(`Unsupported argument: ${arg}`)
  }

  if (output !== 'json' && output !== 'text') {
    throw new Error(`Unsupported output format: ${output}`)
  }

  return { options, output }
}

async function runCli(argv = process.argv.slice(2)) {
  const { options, output } = parseCliArgs(argv)
  const result = await invokeMonitor(options)

  if (output === 'text') {
    process.stdout.write(`${result.message}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectExecution()) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
