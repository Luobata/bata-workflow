import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const tempRoots: string[] = []

const createTempRoot = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'monitor-board-launcher-'))
  tempRoots.push(root)
  return root
}

const loadBoardLauncher = async () => import('../../../skills/monitor/runtime/board-launcher.mjs')

afterEach(() => {
  vi.restoreAllMocks()

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

class FakeChildProcess extends EventEmitter {
  pid: number | undefined

  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  unref() {}
}

describe('monitor board launcher', () => {
  it('builds a launch command that passes host and port directly to vite', async () => {
    const repoRoot = createTempRoot()
    const mod = await loadBoardLauncher()

    expect(mod.createMonitorBoardLaunchSpec({ repoRoot, host: '127.0.0.1', port: 5173 })).toEqual({
      command: 'pnpm',
      args: ['--dir', resolve(repoRoot, 'apps', 'monitor-board'), 'exec', 'vite', '--host', '127.0.0.1', '--port', '5173'],
    })
  })

  it('starts monitor-board when no state exists and the port is offline', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))
    const isMonitorBoard = vi.fn().mockResolvedValue(true)

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-1',
        rootSessionId: 'workspace-1',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8788),
        isPortReachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        isMonitorBoard,
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-1&socketUrl=ws%3A%2F%2F127.0.0.1%3A8788',
      port: 5173,
      pid: 43210,
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(isMonitorBoard).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 5173,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['workspace-1'],
      gatewayPort: 8788,
      port: 5173,
      pid: 43210,
    })
  })

  it('uses MONITOR_GATEWAY_PORT as the preferred gateway port when starting a board', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()
    const previousGatewayPort = process.env.MONITOR_GATEWAY_PORT

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')
    process.env.MONITOR_GATEWAY_PORT = '9305'

    try {
      const findAvailableGatewayPort = vi.fn().mockResolvedValue(9311)
      const result = await mod.ensureMonitorBoardRunning(
        {
          repoRoot,
          runtimeStatePath,
          monitorSessionId: 'monitor:workspace-gateway-port',
          rootSessionId: 'workspace-gateway-port',
          preferredPort: 5173,
          host: '127.0.0.1',
        },
        {
          findAvailableGatewayPort,
          isPortReachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
          isMonitorBoard: vi.fn().mockResolvedValue(true),
          spawnProcess: vi.fn(() => ({ pid: 43211, unref() {}, stdout: null, stderr: null })),
          waitForPort: vi.fn().mockResolvedValue(true),
        },
      )

      expect(findAvailableGatewayPort).toHaveBeenCalledWith(expect.objectContaining({
        host: '127.0.0.1',
        preferredPort: 9305,
      }))
      expect(result).toMatchObject({
        status: 'started',
        url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-gateway-port&socketUrl=ws%3A%2F%2F127.0.0.1%3A9311',
      })
    } finally {
      if (previousGatewayPort === undefined) {
        delete process.env.MONITOR_GATEWAY_PORT
      } else {
        process.env.MONITOR_GATEWAY_PORT = previousGatewayPort
      }
    }
  })

  it('tracks additional root sessions when reusing an existing monitor-board', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')
    writeFileSync(
      runtimeStatePath,
      `${JSON.stringify({
        pid: 123,
        port: 5173,
        gatewayPort: 8788,
        url: 'http://127.0.0.1:5173',
        startedAt: '2026-04-20T00:00:00.000Z',
        repoRoot,
        activeRootSessionIds: ['workspace-1'],
      })}\n`,
      'utf8',
    )

    const isMonitorBoard = vi.fn().mockResolvedValue(true)

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-2',
        rootSessionId: 'workspace-2',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        isPortReachable: vi.fn().mockResolvedValue(true),
        isMonitorBoard,
        spawnProcess: vi.fn(),
        waitForPort: vi.fn(),
      },
    )

    expect(result).toMatchObject({
      status: 'reused',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-2&socketUrl=ws%3A%2F%2F127.0.0.1%3A8788',
      port: 5173,
      pid: 123,
    })
    expect(isMonitorBoard).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 5173,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['workspace-1', 'workspace-2'],
      gatewayPort: 8788,
      port: 5173,
      pid: 123,
    })
  })

  it('returns a session-targeted board URL for each Coco session while reusing the same isolated board runtime', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))
    const isPortReachable = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(true)
    const isMonitorBoard = vi.fn().mockResolvedValue(true)

    const firstResult = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:coco-live-A',
        rootSessionId: 'coco-live-A',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8788),
        isPortReachable,
        isMonitorBoard,
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    const secondResult = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:coco-live-B',
        rootSessionId: 'coco-live-B',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        isPortReachable,
        isMonitorBoard,
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(firstResult).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Acoco-live-A&socketUrl=ws%3A%2F%2F127.0.0.1%3A8788',
      port: 5173,
      pid: 43210,
    })
    expect(secondResult).toMatchObject({
      status: 'reused',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Acoco-live-B&socketUrl=ws%3A%2F%2F127.0.0.1%3A8788',
      port: 5173,
      pid: 43210,
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['coco-live-A', 'coco-live-B'],
      gatewayPort: 8788,
      port: 5173,
      pid: 43210,
    })
  })

  it('cleans up the detached board when persisting runtime state fails after startup', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const child = new FakeChildProcess(43210)
    const cleanupProcess = vi.fn().mockResolvedValue(undefined)
    const writeRuntimeState = vi.fn().mockRejectedValue(new Error('disk full'))

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-1',
        rootSessionId: 'workspace-1',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        cleanupProcess,
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8788),
        isMonitorBoard: vi.fn().mockResolvedValue(true),
        isPortReachable: vi.fn().mockResolvedValue(false),
        spawnProcess: vi.fn(() => child),
        waitForPort: vi.fn().mockResolvedValue(true),
        writeRuntimeState,
      },
    )

    expect(result.status).toBe('failed')
    expect(result.port).toBe(5173)
    expect(result.pid).toBe(null)
    expect(result.message).toContain('failed to persist runtime state')
    expect(result.message).toContain('disk full')
    expect(cleanupProcess).toHaveBeenCalledWith({ child, pid: 43210 })
    expect(writeRuntimeState).toHaveBeenCalledWith(
      runtimeStatePath,
      expect.objectContaining({
        activeRootSessionIds: ['workspace-1'],
        host: '127.0.0.1',
        pid: 43210,
        port: 5173,
        gatewayPort: 8788,
        repoRoot,
      }),
    )
    expect(existsSync(runtimeStatePath)).toBe(false)
  })

  it('requires positive monitor-board identity verification before reusing an existing port', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')
    writeFileSync(
      runtimeStatePath,
      `${JSON.stringify({
        pid: 123,
        port: 5172,
        gatewayPort: 8789,
        url: 'http://127.0.0.1:5172',
        startedAt: '2026-04-20T00:00:00.000Z',
        repoRoot,
      })}\n`,
      'utf8',
    )

    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))
    const isMonitorBoard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-1',
        rootSessionId: 'workspace-1',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8788),
        isPortReachable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        isMonitorBoard,
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-1&socketUrl=ws%3A%2F%2F127.0.0.1%3A8788',
      port: 5173,
      pid: 43210,
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(isMonitorBoard).toHaveBeenNthCalledWith(1, {
      host: '127.0.0.1',
      port: 5172,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(isMonitorBoard).toHaveBeenNthCalledWith(2, {
      host: '127.0.0.1',
      port: 5173,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['workspace-1'],
      gatewayPort: 8788,
      port: 5173,
      pid: 43210,
    })
  })

  it('chooses a different gateway port when the default websocket port is occupied', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-3',
        rootSessionId: 'workspace-3',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8791),
        isPortReachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        isMonitorBoard: vi.fn().mockResolvedValue(true),
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result.url).toBe('http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-3&socketUrl=ws%3A%2F%2F127.0.0.1%3A8791')
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      gatewayPort: 8791,
    })
    expect(spawnProcess).toHaveBeenCalledWith({
      repoRoot,
      host: '127.0.0.1',
      port: 5173,
      gatewayPort: 8791,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
    })
  })

  it('starts a fresh board on another port when the preferred port belongs to a different state root', async () => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board'), { recursive: true })
    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')
    writeFileSync(
      runtimeStatePath,
      `${JSON.stringify({
        pid: 123,
        port: 5173,
        gatewayPort: 8788,
        url: 'http://127.0.0.1:5173',
        startedAt: '2026-04-20T00:00:00.000Z',
        repoRoot,
        activeRootSessionIds: ['workspace-1'],
      })}\n`,
      'utf8',
    )

    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))
    const isMonitorBoard = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const findAvailablePort = vi.fn().mockResolvedValue(5174)

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-3',
        rootSessionId: 'workspace-3',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8789),
        findAvailablePort,
        isPortReachable: vi.fn().mockResolvedValue(true),
        isMonitorBoard,
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5174/?monitorSessionId=monitor%3Aworkspace-3&socketUrl=ws%3A%2F%2F127.0.0.1%3A8789',
      port: 5174,
      pid: 43210,
    })
    expect(findAvailablePort).toHaveBeenCalledWith({
      host: '127.0.0.1',
      preferredPort: 5174,
    })
    expect(spawnProcess).toHaveBeenCalledWith({
      repoRoot,
      host: '127.0.0.1',
      port: 5174,
      gatewayPort: 8789,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
    })
    expect(isMonitorBoard).toHaveBeenNthCalledWith(1, {
      host: '127.0.0.1',
      port: 5173,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(isMonitorBoard).toHaveBeenNthCalledWith(2, {
      host: '127.0.0.1',
      port: 5174,
      repoRoot,
      stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
      timeoutMs: 1_000,
    })
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['workspace-3'],
      gatewayPort: 8789,
      port: 5174,
      pid: 43210,
    })
  })

  it('reclaims the preferred port from an idle conflicting board after switching state roots', async () => {
    const repoRoot = createTempRoot()
    const currentStateRoot = resolve(createTempRoot(), 'current-state')
    const currentRuntimeStatePath = resolve(currentStateRoot, 'monitor-board', 'runtime.json')
    const conflictingStateRoot = resolve(createTempRoot(), 'previous-state')
    const conflictingRuntimeStatePath = resolve(conflictingStateRoot, 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    mkdirSync(resolve(conflictingRuntimeStatePath, '..'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')
    writeFileSync(
      conflictingRuntimeStatePath,
      `${JSON.stringify({
        pid: 123,
        port: 5173,
        gatewayPort: 8788,
        url: 'http://127.0.0.1:5173',
        startedAt: '2026-04-20T00:00:00.000Z',
        repoRoot,
        activeRootSessionIds: [],
      })}\n`,
      'utf8',
    )

    const cleanupProcess = vi.fn().mockResolvedValue(undefined)
    const findAvailablePort = vi.fn().mockResolvedValue(5174)
    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath: currentRuntimeStatePath,
        monitorSessionId: 'monitor:workspace-4',
        rootSessionId: 'workspace-4',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        cleanupProcess,
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8789),
        findAvailablePort,
        getMonitorBoardIdentity: vi.fn().mockResolvedValue({
          app: 'monitor-board',
          repoRoot,
          stateRoot: conflictingStateRoot,
          gatewayPort: 8788,
          pid: 123,
        }),
        isMonitorBoard: vi.fn().mockResolvedValue(true),
        isPortReachable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-4&socketUrl=ws%3A%2F%2F127.0.0.1%3A8789',
      port: 5173,
      pid: 43210,
    })
    expect(cleanupProcess).toHaveBeenCalledWith({ child: null, pid: 123 })
    expect(findAvailablePort).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalledWith({
      repoRoot,
      host: '127.0.0.1',
      port: 5173,
      gatewayPort: 8789,
      stateRoot: currentStateRoot,
    })
    expect(existsSync(conflictingRuntimeStatePath)).toBe(false)
    expect(JSON.parse(readFileSync(currentRuntimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: ['workspace-4'],
      gatewayPort: 8789,
      port: 5173,
      pid: 43210,
    })
  })

  it('reclaims the preferred port when a conflicting board is still listening but its runtime state is already gone', async () => {
    const repoRoot = createTempRoot()
    const currentStateRoot = resolve(createTempRoot(), 'current-state')
    const currentRuntimeStatePath = resolve(currentStateRoot, 'monitor-board', 'runtime.json')
    const conflictingStateRoot = resolve(createTempRoot(), 'previous-state')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const cleanupProcess = vi.fn().mockResolvedValue(undefined)
    const spawnProcess = vi.fn(() => ({ pid: 43210, unref() {}, stdout: null, stderr: null }))

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath: currentRuntimeStatePath,
        monitorSessionId: 'monitor:workspace-5',
        rootSessionId: 'workspace-5',
        preferredPort: 5173,
        host: '127.0.0.1',
      },
      {
        cleanupProcess,
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8789),
        findAvailablePort: vi.fn().mockResolvedValue(5174),
        getMonitorBoardIdentity: vi.fn().mockResolvedValue({
          app: 'monitor-board',
          repoRoot,
          stateRoot: conflictingStateRoot,
          gatewayPort: 8788,
          pid: 234,
        }),
        isMonitorBoard: vi.fn().mockResolvedValue(true),
        isPortReachable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        spawnProcess,
        waitForPort: vi.fn().mockResolvedValue(true),
      },
    )

    expect(result).toMatchObject({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Aworkspace-5&socketUrl=ws%3A%2F%2F127.0.0.1%3A8789',
      port: 5173,
      pid: 43210,
    })
    expect(cleanupProcess).toHaveBeenCalledWith({ child: null, pid: 234 })
    expect(spawnProcess).toHaveBeenCalledWith({
      repoRoot,
      host: '127.0.0.1',
      port: 5173,
      gatewayPort: 8789,
      stateRoot: currentStateRoot,
    })
  })

  it.each([
    {
      name: 'child error',
      emitFailure: (child: FakeChildProcess) => queueMicrotask(() => child.emit('error', new Error('spawn failed'))),
      expectedMessage: 'spawn failed',
    },
    {
      name: 'early child exit',
      emitFailure: (child: FakeChildProcess) => queueMicrotask(() => child.emit('exit', 1, null)),
      expectedMessage: 'exited before becoming ready (code 1)',
    },
    {
      name: 'startup timeout',
      emitFailure: () => {},
      expectedMessage: 'failed to start on 127.0.0.1:5173 within 25ms',
    },
  ])('fails cleanly on $name during startup', async ({ emitFailure, expectedMessage }) => {
    const repoRoot = createTempRoot()
    const runtimeStatePath = resolve(repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json')
    const mod = await loadBoardLauncher()

    mkdirSync(resolve(repoRoot, 'apps', 'monitor-board'), { recursive: true })
    writeFileSync(resolve(repoRoot, 'apps', 'monitor-board', 'package.json'), '{"name":"monitor-board"}\n', 'utf8')

    const child = new FakeChildProcess(54321)
    const cleanupProcess = vi.fn().mockResolvedValue(undefined)
    const waitForPort = vi.fn().mockResolvedValue(false)
    const spawnProcess = vi.fn(() => {
      emitFailure(child)
      return child
    })

    const result = await mod.ensureMonitorBoardRunning(
      {
        repoRoot,
        runtimeStatePath,
        monitorSessionId: 'monitor:workspace-1',
        rootSessionId: 'workspace-1',
        preferredPort: 5173,
        host: '127.0.0.1',
        timeoutMs: 25,
      },
      {
        cleanupProcess,
        findAvailableGatewayPort: vi.fn().mockResolvedValue(8788),
        isMonitorBoard: vi.fn(),
        isPortReachable: vi.fn().mockResolvedValue(false),
        spawnProcess,
        waitForPort,
      },
    )

    expect(result.status).toBe('failed')
    expect(result.port).toBe(5173)
    expect(result.pid).toBe(null)
    expect(result.message).toContain(expectedMessage)
    expect(cleanupProcess).toHaveBeenCalledWith({ child, pid: 54321 })
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
  })
})
