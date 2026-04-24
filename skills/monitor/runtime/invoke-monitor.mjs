#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
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

            const updatedAtMs = Date.parse(session.updated_at ?? session.created_at ?? '')
            if (Number.isNaN(updatedAtMs)) {
              return null
            }

            return {
              id: typeof session.id === 'string' && session.id.length > 0 ? session.id : entry.name,
              updatedAtMs,
            }
          }),
      )
    ).filter((candidate) => candidate !== null)

    if (candidates.length === 0) {
      return null
    }

    return candidates.sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0].id
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

export async function invokeMonitor(options = {}) {
  const provisionalContext = resolveMonitorContext(options)
  const ensureBoardRunning = options.ensureBoardRunning ?? defaultEnsureBoardRunning
  const explicitCocoSessionId = process.env.COCO_SESSION_ID?.trim() || null
  const inferredRootSessionId = explicitCocoSessionId || hasExplicitRootSessionId(options)
    ? null
    : await inferLatestCocoSessionId(provisionalContext)
  const context = inferredRootSessionId
    ? resolveMonitorContext({ ...options, rootSessionId: inferredRootSessionId })
    : provisionalContext
  const existingSession = await readMonitorSessionState(context.stateFilePath)
  const cocoSessionId = explicitCocoSessionId ?? existingSession?.cocoSessionId ?? inferredRootSessionId ?? null
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

  let board
  try {
    board = await ensureBoardRunning({
      repoRoot: context.boardRepoRoot,
      stateRoot: context.harnessStateRoot,
      runtimeStatePath: context.boardRuntimeStatePath,
      monitorSessionId: result.monitorSessionId,
      rootSessionId: result.rootSessionId,
      host: context.boardHost,
      preferredPort: context.boardPort,
    })
  } catch (error) {
    board = {
      status: 'failed',
      url: null,
      port: context.boardPort,
      pid: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }

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
