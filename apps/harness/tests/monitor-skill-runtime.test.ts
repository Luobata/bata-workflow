import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveMonitorContext } from '../../../skills/monitor/runtime/context.mjs'
import { invokeMonitor } from '../../../skills/monitor/runtime/invoke-monitor.mjs'

const tempRoots: string[] = []
const boardPids: number[] = []
const originalCocoSessionId = process.env.COCO_SESSION_ID
const originalCocoSessionsRoot = process.env.COCO_SESSIONS_ROOT
const originalMonitorGatewayPort = process.env.MONITOR_GATEWAY_PORT

const createTempRoot = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'monitor-runtime-'))
  tempRoots.push(root)
  return root
}

const getCocoSessionsRoot = (homeDir: string): string =>
  process.platform === 'darwin'
    ? resolve(homeDir, 'Library', 'Caches', 'coco', 'sessions')
    : resolve(homeDir, '.cache', 'coco', 'sessions')

const writeJson = (filePath: string, value: unknown) => {
  mkdirSync(resolve(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const writeJsonLines = (filePath: string, values: unknown[]) => {
  mkdirSync(resolve(filePath, '..'), { recursive: true })
  writeFileSync(filePath, values.map((value) => JSON.stringify(value)).join('\n').concat(values.length > 0 ? '\n' : ''), 'utf8')
}

const stopBoardProcess = (pid: number | null | undefined) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGTERM')
      return
    }
  } catch {}

  try {
    process.kill(pid, 'SIGTERM')
  } catch {}
}

const waitForSocketMessage = async <T>(
  socket: WebSocket,
  predicate: (payload: unknown) => payload is T,
  timeoutMs = 15_000,
): Promise<T> => {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(`timed out waiting for websocket payload after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        return
      }

      try {
        const payload = JSON.parse(event.data)
        if (predicate(payload)) {
          cleanup()
          resolvePromise(payload)
        }
      } catch {}
    }

    const onError = () => {
      cleanup()
      rejectPromise(new Error('websocket error while waiting for payload'))
    }

    const onClose = () => {
      cleanup()
      rejectPromise(new Error('websocket closed before the expected payload arrived'))
    }

    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

const isSessionSnapshot = (payload: unknown): payload is {
  monitorSessionId: string
  state: {
    timeline: Array<{
      eventType: string
      summary: string
      toolName: string | null
    }>
  }
} => {
  if (!payload || typeof payload !== 'object' || typeof (payload as { monitorSessionId?: unknown }).monitorSessionId !== 'string') {
    return false
  }

  const state = (payload as { state?: unknown }).state
  return Boolean(state && typeof state === 'object' && Array.isArray((state as { timeline?: unknown[] }).timeline))
}

afterEach(() => {
  for (const pid of boardPids.splice(0)) {
    stopBoardProcess(pid)
  }

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }

  if (originalCocoSessionId === undefined) {
    delete process.env.COCO_SESSION_ID
  } else {
    process.env.COCO_SESSION_ID = originalCocoSessionId
  }

  if (originalCocoSessionsRoot === undefined) {
    delete process.env.COCO_SESSIONS_ROOT
  } else {
    process.env.COCO_SESSIONS_ROOT = originalCocoSessionsRoot
  }

  if (originalMonitorGatewayPort === undefined) {
    delete process.env.MONITOR_GATEWAY_PORT
  } else {
    process.env.MONITOR_GATEWAY_PORT = originalMonitorGatewayPort
  }
})

describe('monitor skill runtime', () => {
  it('resolves the board repo root from the linked skill source when cwd is outside the harness repo', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const ensureBoardRunning = vi.fn(async () => ({
      status: 'failed',
      url: null,
      port: 5173,
      pid: null,
      message: 'board not started in test',
    }))

    await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning,
    })

    expect(ensureBoardRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: resolve(import.meta.dirname, '..', '..', '..'),
        runtimeStatePath: resolve(cwd, '.harness', 'state', 'monitor-board', 'runtime.json'),
        stateRoot: resolve(cwd, '.harness', 'state'),
        host: '127.0.0.1',
        preferredPort: 5173,
      }),
    )
  })

  it('creates a monitor session on first invocation and persists state', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const statePath = resolve(cwd, '.harness', 'state', 'monitor-sessions', 'default.json')

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
    })
    expect(result.message).toContain('Created monitor monitor:default')
    expect(existsSync(statePath)).toBe(true)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      rootSessionId: 'default',
      monitorSessionId: 'monitor:default',
      ownerActorId: 'lead',
      lastAttachedActorId: 'lead',
      status: 'active',
    })
  })

  it('supports isolated harness state roots for monitor debugging without writing into cwd', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const isolatedStateRoot = resolve(createTempRoot(), 'isolated-state')
    const defaultSessionPath = resolve(cwd, '.harness', 'state', 'monitor-sessions', 'default.json')
    const isolatedSessionPath = resolve(isolatedStateRoot, 'monitor-sessions', 'default.json')
    const ensureBoardRunning = vi.fn(async () => ({
      status: 'failed',
      url: null,
      port: 5173,
      pid: null,
      message: 'board not started in test',
    }))

    await invokeMonitor({
      cwd,
      homeDir,
      stateRoot: isolatedStateRoot,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning,
    })

    expect(existsSync(defaultSessionPath)).toBe(false)
    expect(existsSync(isolatedSessionPath)).toBe(true)
    expect(ensureBoardRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeStatePath: resolve(isolatedStateRoot, 'monitor-board', 'runtime.json'),
        stateRoot: isolatedStateRoot,
      }),
    )
  })

  it('uses the current COCO_SESSION_ID as the live monitor root session id', () => {
    const cwd = createTempRoot()

    process.env.COCO_SESSION_ID = '  coco-live-A  '

    const context = resolveMonitorContext({ cwd })

    expect(context.rootSessionId).toBe('coco-live-A')
    expect(context.stateFilePath).toBe(
      resolve(cwd, '.harness', 'state', 'monitor-sessions', `${encodeURIComponent('coco-live-A')}.json`),
    )
  })

  it('uses the latest Coco session id as the monitor root when COCO_SESSION_ID is unavailable', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const cocoSessionsRoot = getCocoSessionsRoot(homeDir)
    const legacyStatePath = resolveMonitorContext({ cwd }).stateFilePath
    const latestSessionId = 'coco-latest-session'
    const olderSessionId = 'coco-older-session'
    const ensureBoardRunning = vi.fn(async () => ({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Acoco-latest-session',
      port: 5173,
      pid: 43210,
      message: 'monitor-board started',
    }))

    mkdirSync(resolve(cocoSessionsRoot, olderSessionId), { recursive: true })
    writeFileSync(
      resolve(cocoSessionsRoot, olderSessionId, 'session.json'),
      `${JSON.stringify({
        id: olderSessionId,
        created_at: '2026-04-23T10:00:00.000Z',
        updated_at: '2026-04-23T10:00:10.000Z',
        metadata: { cwd },
      })}\n`,
      'utf8',
    )

    mkdirSync(resolve(cocoSessionsRoot, latestSessionId), { recursive: true })
    writeFileSync(
      resolve(cocoSessionsRoot, latestSessionId, 'session.json'),
      `${JSON.stringify({
        id: latestSessionId,
        created_at: '2026-04-23T11:00:00.000Z',
        updated_at: '2026-04-23T11:00:10.000Z',
        metadata: { cwd },
      })}\n`,
      'utf8',
    )

    mkdirSync(resolve(legacyStatePath, '..'), { recursive: true })
    writeFileSync(
      legacyStatePath,
      `${JSON.stringify({
        rootSessionId: 'legacy-workspace-root',
        monitorSessionId: 'monitor:legacy-workspace-root',
        ownerActorId: 'lead',
        lastAttachedActorId: 'lead',
        status: 'active',
        createdAt: '2026-04-23T09:59:00.000Z',
        updatedAt: '2026-04-23T09:59:00.000Z',
        workspaceRoot: cwd,
        cocoSessionId: olderSessionId,
      })}\n`,
      'utf8',
    )

    const result = await invokeMonitor({
      cwd,
      homeDir,
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning,
    })

    const latestStatePath = resolve(cwd, '.harness', 'state', 'monitor-sessions', `${encodeURIComponent(latestSessionId)}.json`)

    expect(result).toMatchObject({
      kind: 'create',
      rootSessionId: latestSessionId,
      monitorSessionId: `monitor:${latestSessionId}`,
    })
    expect(JSON.parse(readFileSync(latestStatePath, 'utf8'))).toMatchObject({
      rootSessionId: latestSessionId,
      monitorSessionId: `monitor:${latestSessionId}`,
      cocoSessionId: latestSessionId,
      workspaceRoot: cwd,
    })
    expect(ensureBoardRunning).toHaveBeenCalledWith(
      expect.objectContaining({
        rootSessionId: latestSessionId,
        monitorSessionId: `monitor:${latestSessionId}`,
      }),
    )
  })

  it('streams live board snapshots end-to-end for the inferred latest Coco session root', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const stateRoot = resolve(createTempRoot(), 'isolated-state')
    const cocoSessionsRoot = getCocoSessionsRoot(homeDir)
    const olderSessionId = 'coco-e2e-older'
    const latestSessionId = 'coco-e2e-latest'
    const preferredGatewayPort = String(9300 + Math.floor(Math.random() * 200))
    const now = Date.now()

    process.env.COCO_SESSIONS_ROOT = cocoSessionsRoot
    process.env.MONITOR_GATEWAY_PORT = preferredGatewayPort

    writeJson(resolve(cocoSessionsRoot, olderSessionId, 'session.json'), {
      id: olderSessionId,
      created_at: new Date(now - 120_000).toISOString(),
      updated_at: new Date(now - 110_000).toISOString(),
      metadata: {
        cwd,
        model_name: 'gpt-5.4',
        title: 'Older session',
      },
    })
    writeJsonLines(resolve(cocoSessionsRoot, olderSessionId, 'events.jsonl'), [])
    writeJsonLines(resolve(cocoSessionsRoot, olderSessionId, 'traces.jsonl'), [])

    writeJson(resolve(cocoSessionsRoot, latestSessionId, 'session.json'), {
      id: latestSessionId,
      created_at: new Date(now - 5_000).toISOString(),
      updated_at: new Date(now - 1_200).toISOString(),
      metadata: {
        cwd,
        model_name: 'gpt-5.4',
        title: 'Latest session',
      },
    })
    writeJsonLines(resolve(cocoSessionsRoot, latestSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: latestSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: new Date(now - 1_000).toISOString(),
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ])
    writeJsonLines(resolve(cocoSessionsRoot, latestSessionId, 'traces.jsonl'), [])

    const result = await invokeMonitor({
      cwd,
      homeDir,
      stateRoot,
      requesterActorId: 'lead',
      isRootActor: true,
    })

    expect(result).toMatchObject({
      kind: 'create',
      rootSessionId: latestSessionId,
      monitorSessionId: `monitor:${latestSessionId}`,
      board: {
        status: expect.stringMatching(/started|reused/),
      },
    })

    if (Number.isInteger(result.board.pid) && result.board.pid > 0) {
      boardPids.push(result.board.pid)
    }

    const boardUrl = new URL(result.board.url ?? 'http://127.0.0.1/')
    const socketUrl = boardUrl.searchParams.get('socketUrl')
    expect(socketUrl).toBeTruthy()

    const socket = new WebSocket(String(socketUrl))

    try {
      const initialSnapshot = await waitForSocketMessage(
        socket,
        (payload): payload is {
          monitorSessionId: string
          state: { timeline: Array<{ eventType: string; summary: string; toolName: string | null }> }
        } =>
          isSessionSnapshot(payload)
          && payload.monitorSessionId === `monitor:${latestSessionId}`
          && payload.state.timeline.some((event) => event.eventType === 'tool.called' && event.toolName === 'Skill'),
      )

      expect(initialSnapshot.state.timeline.some((event) => event.summary.includes('started Skill'))).toBe(true)

      writeJson(resolve(cocoSessionsRoot, latestSessionId, 'session.json'), {
        id: latestSessionId,
        created_at: new Date(now - 5_000).toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          cwd,
          model_name: 'gpt-5.4',
          title: 'Latest session',
        },
      })
      writeJsonLines(resolve(cocoSessionsRoot, latestSessionId, 'events.jsonl'), [
        {
          id: 'event-tool-call',
          session_id: latestSessionId,
          agent_id: 'agent-lead',
          agent_name: 'TraeCli',
          parent_tool_call_id: '',
          created_at: new Date(now - 1_000).toISOString(),
          tool_call: {
            tool_call_id: 'tool-call-1',
            tool_info: {
              name: 'Skill',
            },
          },
        },
        {
          id: 'event-tool-result',
          session_id: latestSessionId,
          agent_id: 'agent-lead',
          agent_name: 'TraeCli',
          parent_tool_call_id: '',
          created_at: new Date().toISOString(),
          tool_call_output: {
            tool_call_id: 'tool-call-1',
          },
        },
      ])

      const updatedSnapshot = await waitForSocketMessage(
        socket,
        (payload): payload is {
          monitorSessionId: string
          state: { timeline: Array<{ eventType: string; summary: string; toolName: string | null }> }
        } =>
          isSessionSnapshot(payload)
          && payload.monitorSessionId === `monitor:${latestSessionId}`
          && payload.state.timeline.some((event) => event.eventType === 'tool.finished' && event.toolName === 'Skill'),
      )

      expect(updatedSnapshot.state.timeline.some((event) => event.summary.includes('completed Skill'))).toBe(true)
    } finally {
      socket.close()
    }
  }, 30_000)

  it('resolves a relative stateRoot against the target cwd', () => {
    const cwd = createTempRoot()

    const context = resolveMonitorContext({ cwd, stateRoot: 'relative-state' })

    expect(context.harnessStateRoot).toBe(resolve(cwd, 'relative-state'))
    expect(context.stateFilePath).toBe(
      resolve(cwd, 'relative-state', 'monitor-sessions', `${encodeURIComponent(context.rootSessionId)}.json`),
    )
  })

  it('infers lead-prefixed requester actors as root by default and persists that actor as owner', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const statePath = resolve(cwd, '.harness', 'state', 'monitor-sessions', 'default.json')

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead-1',
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      rootSessionId: 'default',
      requesterActorId: 'lead-1',
      isRootActor: true,
    })
    expect(result.message).toContain('Created monitor monitor:default')
    expect(existsSync(statePath)).toBe(true)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      rootSessionId: 'default',
      monitorSessionId: 'monitor:default',
      ownerActorId: 'lead-1',
      lastAttachedActorId: 'lead-1',
      status: 'active',
    })
  })

  it('attaches to the existing monitor session on repeat invocation', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const statePath = resolve(cwd, '.harness', 'state', 'monitor-sessions', 'default.json')

    await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
    })

    const firstPersisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      createdAt: string
      updatedAt: string
    }

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'worker-1',
      isRootActor: false,
    })

    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      createdAt: string
      updatedAt: string
      ownerActorId: string
      lastAttachedActorId: string
      monitorSessionId: string
      rootSessionId: string
      status: string
    }

    expect(result).toMatchObject({
      kind: 'attach',
      monitorSessionId: 'monitor:default',
      rootSessionId: 'default',
      requesterActorId: 'worker-1',
      isRootActor: false,
    })
    expect(result.message).toContain('Attached actor worker-1')
    expect(persisted).toMatchObject({
      rootSessionId: 'default',
      monitorSessionId: 'monitor:default',
      ownerActorId: 'lead',
      lastAttachedActorId: 'worker-1',
      status: 'active',
    })
    expect(persisted.createdAt).toBe(firstPersisted.createdAt)
    expect(Date.parse(persisted.updatedAt)).toBeGreaterThanOrEqual(Date.parse(firstPersisted.updatedAt))
  })

  it('preserves the existing persisted coco session binding when COCO_SESSION_ID is unavailable', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const statePath = resolve(cwd, '.harness', 'state', 'monitor-sessions', 'default.json')
    const cocoSessionsRoot = getCocoSessionsRoot(homeDir)
    const olderSessionId = 'coco-older-session'
    const latestSessionId = 'coco-latest-session'

    mkdirSync(resolve(cocoSessionsRoot, olderSessionId), { recursive: true })
    writeFileSync(
      resolve(cocoSessionsRoot, olderSessionId, 'session.json'),
      `${JSON.stringify({
        id: olderSessionId,
        created_at: '2026-04-23T10:00:00.000Z',
        updated_at: '2026-04-23T10:00:10.000Z',
        metadata: { cwd },
      })}\n`,
      'utf8',
    )

    mkdirSync(resolve(cocoSessionsRoot, latestSessionId), { recursive: true })
    writeFileSync(
      resolve(cocoSessionsRoot, latestSessionId, 'session.json'),
      `${JSON.stringify({
        id: latestSessionId,
        created_at: '2026-04-23T11:00:00.000Z',
        updated_at: '2026-04-23T11:00:10.000Z',
        metadata: { cwd },
      })}\n`,
      'utf8',
    )

    mkdirSync(resolve(statePath, '..'), { recursive: true })
    writeFileSync(
      statePath,
      `${JSON.stringify({
        rootSessionId: 'default',
        monitorSessionId: 'monitor:default',
        ownerActorId: 'lead',
        lastAttachedActorId: 'lead',
        status: 'active',
        createdAt: '2026-04-23T09:59:00.000Z',
        updatedAt: '2026-04-23T09:59:00.000Z',
        workspaceRoot: cwd,
        cocoSessionId: olderSessionId,
      })}\n`,
      'utf8',
    )

    await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
    })

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      cocoSessionId: olderSessionId,
      workspaceRoot: cwd,
    })
  })

  it('returns board status started with a board URL when the launcher starts the board', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const ensureBoardRunning = vi.fn(async () => ({
      status: 'started',
      url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Adefault',
      port: 5173,
      pid: 43210,
      message: 'monitor-board started',
    }))

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning,
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      board: {
        status: 'started',
        url: 'http://127.0.0.1:5173/?monitorSessionId=monitor%3Adefault',
      },
    })
  })

  it('keeps the monitor session result when board startup fails', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const ensureBoardRunning = vi.fn(async () => ({
      status: 'failed',
      url: null,
      port: 5173,
      pid: null,
      message: 'monitor-board failed to start on 127.0.0.1:5173',
    }))

    const result = await invokeMonitor({
      cwd,
      homeDir,
      rootSessionId: 'default',
      requesterActorId: 'lead',
      isRootActor: true,
      ensureBoardRunning,
    })

    expect(result).toMatchObject({
      kind: 'create',
      monitorSessionId: 'monitor:default',
      board: {
        status: 'failed',
        url: null,
      },
    })
  })

  it('adds a migration hint when a legacy scoped install path exists', async () => {
    const homeDir = createTempRoot()
    const cwd = createTempRoot()
    const legacyInstallPath = resolve(homeDir, '.coco', 'skills', '%40luobata%2Fmonitor')

    mkdirSync(legacyInstallPath, { recursive: true })

    const result = await invokeMonitor({
      cwd,
      homeDir,
      requesterActorId: 'lead-1',
      isRootActor: true,
    })

    expect(result.message).toContain('legacy install @luobata/monitor detected')
  })
})
