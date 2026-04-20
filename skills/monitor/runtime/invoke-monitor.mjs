#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveMonitorContext } from './context.mjs'
import { openMonitorSession } from './monitor-session.mjs'
import { readMonitorSessionState, writeMonitorSessionState } from './session-store.mjs'

const appendLegacyInstallWarning = (message, context) => {
  if (!context.hasLegacyInstall) {
    return message
  }

  return `${message} (legacy install @luobata/monitor detected; relink to monitor when convenient)`
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
  const context = resolveMonitorContext(options)
  const existingSession = await readMonitorSessionState(context.stateFilePath)
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
  }

  await writeMonitorSessionState(context.stateFilePath, persistedSession)

  return {
    kind: result.kind,
    monitorSessionId: result.monitorSessionId,
    rootSessionId: result.rootSessionId,
    requesterActorId: result.requesterActorId,
    isRootActor: result.isRootActor,
    message: appendLegacyInstallWarning(result.message, context),
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
