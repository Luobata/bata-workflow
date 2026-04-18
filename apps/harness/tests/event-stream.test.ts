import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appendRuntimeEvent, readAllRuntimeEvents, readRuntimeEventsSince } from '../src/runtime/event-stream.js'

describe('runtime event stream', () => {
  it('按顺序写入多条 runtime event 并可完整读回', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-event-stream-'))

    appendRuntimeEvent({
      runDirectory,
      seq: 1,
      type: 'run-started',
      payload: { detail: 'started' }
    })
    appendRuntimeEvent({
      runDirectory,
      seq: 2,
      type: 'task-completed',
      payload: { taskId: 'T1', detail: 'done' }
    })

    const events = await readAllRuntimeEvents(runDirectory)
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.seq)).toEqual([1, 2])
    expect(events[0]?.type).toBe('run-started')
    expect(events[1]?.payload).toMatchObject({ taskId: 'T1', detail: 'done' })
  })

  it('支持从上次 cursor 之后继续读取新事件', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-event-stream-cursor-'))

    appendRuntimeEvent({
      runDirectory,
      seq: 1,
      type: 'run-started',
      payload: { detail: 'started' }
    })

    const firstRead = await readRuntimeEventsSince(runDirectory, 0)
    expect(firstRead.events).toHaveLength(1)
    expect(firstRead.nextCursor).toBe(1)

    appendRuntimeEvent({
      runDirectory,
      seq: 2,
      type: 'task-failed',
      payload: { taskId: 'T1', detail: 'boom' }
    })
    appendRuntimeEvent({
      runDirectory,
      seq: 3,
      type: 'run-failed',
      payload: { detail: 'failed' }
    })

    const secondRead = await readRuntimeEventsSince(runDirectory, firstRead.nextCursor)
    expect(secondRead.events.map((event) => event.seq)).toEqual([2, 3])
    expect(secondRead.nextCursor).toBe(3)
  })
})
