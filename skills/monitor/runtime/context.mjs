import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_REQUESTER_ACTOR_ID = 'lead'

const isDefaultRootActorId = (actorId) =>
  actorId === DEFAULT_REQUESTER_ACTOR_ID || actorId.startsWith(`${DEFAULT_REQUESTER_ACTOR_ID}-`)

const deriveWorkspaceHashSessionId = (cwd) => {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12)
  return `workspace-${hash}`
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const resolveBooleanOption = (options, key, fallback) => {
  if (hasOwn(options, key) && options[key] !== undefined) {
    return Boolean(options[key])
  }

  return fallback
}

export function getSessionStateFileName(rootSessionId) {
  return `${encodeURIComponent(rootSessionId)}.json`
}

export function resolveMonitorContext(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const homeDir = resolve(options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? cwd)
  const stateRoot = resolve(cwd, '.harness', 'state', 'monitor-sessions')

  mkdirSync(stateRoot, { recursive: true })

  const rootSessionId = options.rootSessionId ?? process.env.COCO_SESSION_ID ?? deriveWorkspaceHashSessionId(cwd)
  const requesterActorId = options.requesterActorId ?? process.env.COCO_ACTOR_ID ?? DEFAULT_REQUESTER_ACTOR_ID
  const isRootActor = resolveBooleanOption(options, 'isRootActor', isDefaultRootActorId(requesterActorId))
  const stateFilePath = resolve(stateRoot, getSessionStateFileName(rootSessionId))
  const legacyInstallPath = resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor')

  return {
    cwd,
    homeDir,
    stateRoot,
    stateFilePath,
    rootSessionId,
    requesterActorId,
    isRootActor,
    legacyInstallPath,
    hasLegacyInstall: existsSync(legacyInstallPath),
  }
}
