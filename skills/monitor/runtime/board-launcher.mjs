import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5173
const DEFAULT_PORT_SCAN_LIMIT = 25
const DEFAULT_GATEWAY_PORT = 8787
const DEFAULT_GATEWAY_PORT_SCAN_LIMIT = 25
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_IDENTITY_TIMEOUT_MS = 1_000

const toSocketUrl = (host, port) => `ws://${host}:${port}`

const toBoardUrl = (host, port, monitorSessionId, gatewayPort) => {
  const params = new URLSearchParams({
    monitorSessionId,
  })

  if (isValidPort(gatewayPort)) {
    params.set('socketUrl', toSocketUrl(host, gatewayPort))
  }

  return `http://${host}:${port}/?${params.toString()}`
}

const toBaseUrl = (host, port) => `http://${host}:${port}`
const toIdentityUrl = (host, port) => `${toBaseUrl(host, port)}/__monitor_board_identity`
const toRuntimeStatePath = (stateRoot) => resolve(stateRoot, 'monitor-board', 'runtime.json')

const isValidPort = (value) => Number.isInteger(value) && value > 0 && value <= 65_535

const resolveConfiguredPort = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return isValidPort(parsed) ? parsed : fallback
}

const normalizeActiveRootSessionIds = (value) => {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))]
}

const withTrackedRootSessionId = (runtimeState, rootSessionId) => {
  if (!rootSessionId) {
    return runtimeState
  }

  const activeRootSessionIds = normalizeActiveRootSessionIds(runtimeState?.activeRootSessionIds)
  if (activeRootSessionIds.includes(rootSessionId)) {
    return {
      ...runtimeState,
      activeRootSessionIds,
    }
  }

  return {
    ...runtimeState,
    activeRootSessionIds: [...activeRootSessionIds, rootSessionId],
  }
}

async function readRuntimeState(runtimeStatePath) {
  try {
    const raw = await readFile(runtimeStatePath, 'utf8')
    return JSON.parse(raw)
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

async function writeRuntimeState(runtimeStatePath, state) {
  await mkdir(dirname(runtimeStatePath), { recursive: true })

  const tempFilePath = `${runtimeStatePath}.${process.pid}.${Date.now()}.tmp`
  const payload = `${JSON.stringify(state, null, 2)}\n`

  await writeFile(tempFilePath, payload, 'utf8')
  await rename(tempFilePath, runtimeStatePath)
}

async function defaultIsPortReachable({ host, port, timeoutMs = 1_000 }) {
  return await new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port })

    const finish = (reachable) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(reachable)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

const normalizeMonitorBoardIdentity = (identity) => {
  if (!identity || identity.app !== 'monitor-board') {
    return null
  }

  return {
    app: identity.app,
    repoRoot: typeof identity.repoRoot === 'string' ? resolve(identity.repoRoot) : null,
    stateRoot: typeof identity.stateRoot === 'string' ? resolve(identity.stateRoot) : null,
    gatewayPort: isValidPort(identity.gatewayPort) ? identity.gatewayPort : null,
    pid: Number.isInteger(identity.pid) ? identity.pid : null,
  }
}

async function defaultGetMonitorBoardIdentity({ host, port, timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const identityResponse = await fetch(toIdentityUrl(host, port), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })

    if (!identityResponse.ok) {
      return null
    }

    const identity = await identityResponse.json().catch(() => null)
    return normalizeMonitorBoardIdentity(identity)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function defaultFindAvailablePort({
  host,
  preferredPort = DEFAULT_PORT,
  scanLimit = DEFAULT_PORT_SCAN_LIMIT,
  isPortReachable = defaultIsPortReachable,
}) {
  for (let offset = 0; offset < scanLimit; offset += 1) {
    const candidatePort = preferredPort + offset
    if (!isValidPort(candidatePort)) {
      break
    }

    if (!(await isPortReachable({ host, port: candidatePort, timeoutMs: 250 }))) {
      return candidatePort
    }
  }

  throw new Error(`failed to find an available monitor-board port near ${preferredPort}`)
}

async function defaultFindAvailableGatewayPort({
  host,
  preferredPort = DEFAULT_GATEWAY_PORT,
  scanLimit = DEFAULT_GATEWAY_PORT_SCAN_LIMIT,
  isPortReachable = defaultIsPortReachable,
}) {
  return defaultFindAvailablePort({
    host,
    preferredPort,
    scanLimit,
    isPortReachable,
  })
}

async function defaultIsMonitorBoard({ host, port, timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS, repoRoot, stateRoot }) {
  const identity = await defaultGetMonitorBoardIdentity({ host, port, timeoutMs })

  if (identity) {
    if (repoRoot && identity.repoRoot !== resolve(repoRoot)) {
      return false
    }

    if (stateRoot && identity.stateRoot !== resolve(stateRoot)) {
      return false
    }

    return true
  }

  try {
    if (repoRoot || stateRoot) {
      return false
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(toBaseUrl(host, port), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      })
      const body = await response.text()
      return /<title>\s*Monitor Board\s*<\/title>/i.test(body) || /\bMonitor Board\b/i.test(body)
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return false
  }
}

async function maybeCleanupIdleConflictingBoard({
  host,
  port,
  repoRoot,
  stateRoot,
  getMonitorBoardIdentity,
  cleanupProcess,
}) {
  const identity = await getMonitorBoardIdentity({ host, port, timeoutMs: DEFAULT_IDENTITY_TIMEOUT_MS })
  if (!identity || identity.repoRoot !== repoRoot || !identity.stateRoot || identity.stateRoot === stateRoot) {
    return false
  }

  const conflictingRuntimeStatePath = toRuntimeStatePath(identity.stateRoot)
  const conflictingRuntimeState = await readRuntimeState(conflictingRuntimeStatePath)
  const activeRootSessionIds = normalizeActiveRootSessionIds(conflictingRuntimeState?.activeRootSessionIds)

  if (conflictingRuntimeState && activeRootSessionIds.length > 0) {
    return false
  }

  await cleanupProcess({ child: null, pid: identity.pid })

  try {
    await rm(conflictingRuntimeStatePath, { force: true })
  } catch {}

  return true
}

async function defaultWaitForPort({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 150, isPortReachable }) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await isPortReachable({ host, port, timeoutMs: Math.min(intervalMs, 1_000) })) {
      return true
    }

    await delay(intervalMs)
  }

  return false
}

function defaultSpawnProcess({ repoRoot, host, port, gatewayPort, stateRoot }) {
  const { command, args } = createMonitorBoardLaunchSpec({ repoRoot, host, port })
  return spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(stateRoot ? { HARNESS_STATE_ROOT: String(stateRoot), MONITOR_STATE_ROOT: String(stateRoot) } : {}),
      MONITOR_GATEWAY_PORT: String(gatewayPort),
    },
  })
}

export function createMonitorBoardLaunchSpec({ repoRoot, host, port }) {
  const boardAppRoot = resolve(repoRoot, 'apps', 'monitor-board')

  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['--dir', boardAppRoot, 'exec', 'vite', '--host', host, '--port', String(port)],
  }
}

async function defaultCleanupProcess({ child, pid }) {
  if (Number.isInteger(pid) && pid > 0 && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGTERM')
      return
    } catch {}
  }

  if (typeof child?.kill === 'function') {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
}

async function checkMonitorBoardIdentity(isMonitorBoard, args) {
  try {
    return await isMonitorBoard(args)
  } catch {
    return false
  }
}

function formatChildExitMessage(code, signal) {
  if (Number.isInteger(code)) {
    return `monitor-board exited before becoming ready (code ${code})`
  }

  if (signal) {
    return `monitor-board exited before becoming ready (signal ${signal})`
  }

  return 'monitor-board exited before becoming ready'
}

async function waitForBoardStartup({ child, host, port, timeoutMs, waitForPort, isMonitorBoard, repoRoot, stateRoot }) {
  let detachChildListeners = () => {}

  const childFailure = new Promise((resolvePromise) => {
    if (!child || typeof child.once !== 'function' || typeof child.removeListener !== 'function') {
      return
    }

    const onError = (error) => resolvePromise({ kind: 'error', error })
    const onExit = (code, signal) => resolvePromise({ kind: 'exit', code, signal })

    child.once('error', onError)
    child.once('exit', onExit)
    detachChildListeners = () => {
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }
  })

  try {
    const readiness = await Promise.race([
      Promise.resolve(waitForPort({ host, port, timeoutMs })).then((ready) => (ready ? { kind: 'port-ready' } : { kind: 'timeout' })),
      childFailure,
    ])

    if (readiness.kind !== 'port-ready') {
      return readiness
    }

    const looksLikeMonitorBoard = await checkMonitorBoardIdentity(isMonitorBoard, {
      host,
      port,
      repoRoot,
      stateRoot,
      timeoutMs: Math.min(timeoutMs, DEFAULT_IDENTITY_TIMEOUT_MS),
    })

    return looksLikeMonitorBoard ? { kind: 'ready' } : { kind: 'identity-mismatch' }
  } finally {
    detachChildListeners()
  }
}

const toFailureResult = ({ port, message }) => ({
  status: 'failed',
  url: null,
  port,
  pid: null,
  message,
})

export async function ensureMonitorBoardRunning(options, deps = {}) {
  const repoRoot = options?.repoRoot ? resolve(options.repoRoot) : null
  const stateRoot = options?.stateRoot
    ? resolve(options.stateRoot)
    : options?.runtimeStatePath
      ? dirname(dirname(resolve(options.runtimeStatePath)))
      : null
  const runtimeStatePath = options?.runtimeStatePath ? resolve(options.runtimeStatePath) : null
  const monitorSessionId = options?.monitorSessionId ?? null
  const rootSessionId = options?.rootSessionId ?? null
  const host = options?.host ?? DEFAULT_HOST
  const preferredPort = isValidPort(options?.preferredPort) ? options.preferredPort : DEFAULT_PORT
  const preferredGatewayPort = resolveConfiguredPort(options?.preferredGatewayPort ?? process.env.MONITOR_GATEWAY_PORT, DEFAULT_GATEWAY_PORT)
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS

  if (!repoRoot) {
    return toFailureResult({
      port: preferredPort,
      message: 'monitor-board repo root is unavailable; could not locate apps/monitor-board/package.json',
    })
  }

  if (!runtimeStatePath) {
    return toFailureResult({
      port: preferredPort,
      message: 'monitor-board runtime state path is unavailable; could not persist board runtime state',
    })
  }

  if (!monitorSessionId) {
    return toFailureResult({
      port: preferredPort,
      message: 'monitor session id is required to launch monitor-board',
    })
  }

  const boardPackagePath = resolve(repoRoot, 'apps', 'monitor-board', 'package.json')
  const isPortReachable = deps.isPortReachable ?? defaultIsPortReachable
  const isMonitorBoard = deps.isMonitorBoard ?? defaultIsMonitorBoard
  const getMonitorBoardIdentity = deps.getMonitorBoardIdentity ?? defaultGetMonitorBoardIdentity
  const waitForPort = deps.waitForPort ?? ((waitOptions) => defaultWaitForPort({ ...waitOptions, isPortReachable }))
  const spawnProcess = deps.spawnProcess ?? defaultSpawnProcess
  const findAvailablePort = deps.findAvailablePort
    ?? ((portOptions) => defaultFindAvailablePort({ ...portOptions, isPortReachable }))
  const findAvailableGatewayPort = deps.findAvailableGatewayPort
    ?? ((gatewayOptions) => defaultFindAvailableGatewayPort({ ...gatewayOptions, isPortReachable }))
  const cleanupProcess = deps.cleanupProcess ?? defaultCleanupProcess
  const persistRuntimeState = deps.writeRuntimeState ?? writeRuntimeState

  let runtimeState = await readRuntimeState(runtimeStatePath)

  if (runtimeState?.repoRoot && resolve(runtimeState.repoRoot) !== repoRoot) {
    runtimeState = null
  }

  const recordedPort = isValidPort(runtimeState?.port) ? runtimeState.port : null
  if (recordedPort && (await isPortReachable({ host, port: recordedPort, timeoutMs: DEFAULT_IDENTITY_TIMEOUT_MS }))) {
    const looksLikeMonitorBoard = await checkMonitorBoardIdentity(isMonitorBoard, {
      host,
      port: recordedPort,
      repoRoot,
      stateRoot,
      timeoutMs: DEFAULT_IDENTITY_TIMEOUT_MS,
    })

    if (looksLikeMonitorBoard) {
      const nextRuntimeState = withTrackedRootSessionId(
        {
          ...runtimeState,
          host,
          gatewayPort: isValidPort(runtimeState?.gatewayPort) ? runtimeState.gatewayPort : preferredGatewayPort,
          port: recordedPort,
          url: runtimeState?.url ?? toBaseUrl(host, recordedPort),
          repoRoot,
        },
        rootSessionId,
      )

      if (runtimeState && JSON.stringify(nextRuntimeState) !== JSON.stringify(runtimeState)) {
        try {
          await persistRuntimeState(runtimeStatePath, nextRuntimeState)
        } catch {}
      }

      return {
        status: 'reused',
        url: toBoardUrl(host, recordedPort, monitorSessionId, nextRuntimeState.gatewayPort),
        port: recordedPort,
        pid: Number.isInteger(runtimeState?.pid) ? runtimeState.pid : null,
        message: `monitor-board already running on ${host}:${recordedPort}`,
      }
    }
  }

  if (!existsSync(boardPackagePath)) {
    return {
      status: 'failed',
      url: null,
      port: preferredPort,
      pid: null,
      message: 'monitor-board package.json is unavailable; could not launch board runtime',
    }
  }

  let gatewayPort
  try {
    gatewayPort = await findAvailableGatewayPort({
      host,
      preferredPort: preferredGatewayPort,
    })
  } catch (error) {
    return toFailureResult({
      port: preferredPort,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let launchPort = preferredPort
  try {
    if (await isPortReachable({ host, port: preferredPort, timeoutMs: DEFAULT_IDENTITY_TIMEOUT_MS })) {
      const reclaimedConflictingBoard = await maybeCleanupIdleConflictingBoard({
        host,
        port: preferredPort,
        repoRoot,
        stateRoot,
        getMonitorBoardIdentity,
        cleanupProcess,
      })

      if (!reclaimedConflictingBoard || (await isPortReachable({ host, port: preferredPort, timeoutMs: DEFAULT_IDENTITY_TIMEOUT_MS }))) {
        launchPort = await findAvailablePort({
          host,
          preferredPort: preferredPort + 1,
        })
      }
    }
  } catch (error) {
    return toFailureResult({
      port: preferredPort,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  let child
  try {
    child = spawnProcess({ repoRoot, host, port: launchPort, gatewayPort, stateRoot })
  } catch (error) {
    return toFailureResult({
      port: launchPort,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const pid = Number.isInteger(child?.pid) ? child.pid : null
  if (typeof child?.unref === 'function') {
    child.unref()
  }

  let startupResult
  try {
    startupResult = await waitForBoardStartup({
      child,
      host,
      port: launchPort,
      repoRoot,
      stateRoot,
      timeoutMs,
      waitForPort,
      isMonitorBoard,
    })
  } catch (error) {
    await cleanupProcess({ child, pid })
    return toFailureResult({
      port: launchPort,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (startupResult.kind !== 'ready') {
    await cleanupProcess({ child, pid })

    if (startupResult.kind === 'error') {
      const message = startupResult.error instanceof Error ? startupResult.error.message : String(startupResult.error)
      return toFailureResult({
        port: launchPort,
        message: `monitor-board process failed before becoming ready: ${message}`,
      })
    }

    if (startupResult.kind === 'exit') {
      return toFailureResult({
        port: launchPort,
        message: formatChildExitMessage(startupResult.code, startupResult.signal),
      })
    }

    if (startupResult.kind === 'identity-mismatch') {
      return toFailureResult({
        port: launchPort,
        message: `monitor-board became reachable on ${host}:${launchPort} but did not identify as monitor-board`,
      })
    }

    return toFailureResult({
      port: launchPort,
      message: `monitor-board failed to start on ${host}:${launchPort} within ${timeoutMs}ms`,
    })
  }

  const nextState = {
    pid,
    port: launchPort,
    gatewayPort,
    host,
    url: toBaseUrl(host, launchPort),
    startedAt: new Date().toISOString(),
    repoRoot,
    activeRootSessionIds: rootSessionId ? [rootSessionId] : [],
  }

  try {
    await persistRuntimeState(runtimeStatePath, nextState)
  } catch (error) {
    await cleanupProcess({ child, pid })

    return toFailureResult({
      port: launchPort,
      message: `monitor-board started on ${host}:${launchPort} but failed to persist runtime state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }

  return {
    status: 'started',
    url: toBoardUrl(host, launchPort, monitorSessionId, gatewayPort),
    port: launchPort,
    pid,
    message: `monitor-board started on ${host}:${launchPort}`,
  }
}
