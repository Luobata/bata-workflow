import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REQUESTER_ACTOR_ID = 'lead'
const DEFAULT_BOARD_HOST = '127.0.0.1'
const DEFAULT_BOARD_PORT = 5173
const DEFAULT_STATE_ROOT_SEGMENTS = ['.bata-workflow', 'state']

const isDefaultRootActorId = (actorId) =>
  actorId === DEFAULT_REQUESTER_ACTOR_ID || actorId.startsWith(`${DEFAULT_REQUESTER_ACTOR_ID}-`)

const deriveWorkspaceHashSessionId = (cwd) => {
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 12)
  return `workspace-${hash}`
}

const resolveLiveCocoSessionId = () => {
  const sessionId = process.env.COCO_SESSION_ID?.trim()
  return sessionId ? sessionId : null
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

const resolveBooleanOption = (options, key, fallback) => {
  if (hasOwn(options, key) && options[key] !== undefined) {
    return Boolean(options[key])
  }

  return fallback
}

const resolveBoardPort = (value) => {
  const parsed = Number.parseInt(String(value ?? DEFAULT_BOARD_PORT), 10)

  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
    return parsed
  }

  return DEFAULT_BOARD_PORT
}

const resolveHarnessStateRoot = (cwd, options) => {
  const candidate = options.stateRoot ?? process.env.BATA_WORKFLOW_STATE_ROOT ?? process.env.MONITOR_STATE_ROOT
  return candidate ? resolve(cwd, candidate) : resolve(cwd, ...DEFAULT_STATE_ROOT_SEGMENTS)
}

const findBoardRepoRoot = (startPath) => {
  let current = resolve(startPath)

  while (true) {
    if (existsSync(resolve(current, 'apps', 'monitor-board', 'package.json'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      return null
    }

    current = parent
  }
}

const findBoardRepoRootFromSkillSource = () => {
  try {
    return findBoardRepoRoot(dirname(realpathSync(fileURLToPath(import.meta.url))))
  } catch {
    return null
  }
}

export function getSessionStateFileName(rootSessionId) {
  return `${encodeURIComponent(rootSessionId)}.json`
}

export function resolveMonitorContext(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd())
  const homeDir = resolve(options.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? cwd)
  const bataWorkflowStateRoot = resolveHarnessStateRoot(cwd, options)
  const stateRoot = resolve(bataWorkflowStateRoot, 'monitor-sessions')
  const boardRepoRoot = findBoardRepoRoot(cwd) ?? findBoardRepoRootFromSkillSource()
  const boardHost = options.boardHost ?? DEFAULT_BOARD_HOST
  const boardPort = resolveBoardPort(options.boardPort)
  const boardRuntimeStatePath = boardRepoRoot
    ? resolve(bataWorkflowStateRoot, 'monitor-board', 'runtime.json')
    : null

  mkdirSync(stateRoot, { recursive: true })

  const rootSessionId = options.rootSessionId ?? resolveLiveCocoSessionId() ?? deriveWorkspaceHashSessionId(cwd)
  const requesterActorId = options.requesterActorId ?? process.env.COCO_ACTOR_ID ?? DEFAULT_REQUESTER_ACTOR_ID
  const isRootActor = resolveBooleanOption(options, 'isRootActor', isDefaultRootActorId(requesterActorId))
  const stateFilePath = resolve(stateRoot, getSessionStateFileName(rootSessionId))
  const legacyInstallPath = resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor')

  return {
    cwd,
    homeDir,
    bataWorkflowStateRoot,
    stateRoot,
    stateFilePath,
    rootSessionId,
    requesterActorId,
    isRootActor,
    boardRepoRoot,
    boardHost,
    boardPort,
    boardRuntimeStatePath,
    legacyInstallPath,
    hasLegacyInstall: existsSync(legacyInstallPath),
  }
}
