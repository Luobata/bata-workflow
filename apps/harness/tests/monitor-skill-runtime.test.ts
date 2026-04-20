import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { invokeMonitor } from '../../../skills/monitor/runtime/invoke-monitor.mjs'

const tempRoots: string[] = []

const createTempRoot = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'monitor-runtime-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
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
        runtimeStatePath: resolve(import.meta.dirname, '..', '..', '..', '.harness', 'state', 'monitor-board', 'runtime.json'),
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
