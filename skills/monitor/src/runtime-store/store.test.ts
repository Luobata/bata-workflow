import { describe, expect, it } from 'vitest'
import { createBoardEventId, type BoardEvent } from '../protocol/index.js'
import { createInitialBoardState } from './state.js'
import { reduceBoardEvent } from './reducer.js'
import { selectTopBarStats, selectVisibleTimeline } from './selectors.js'

type ToolBoardEvent = Extract<BoardEvent, { toolName: string }>
type NonToolBoardEvent = Exclude<BoardEvent, ToolBoardEvent>

const createEvent = (overrides: Partial<NonToolBoardEvent> = {}): NonToolBoardEvent => {
  const eventType: NonToolBoardEvent['eventType'] = overrides.eventType ?? 'actor.spawned'
  const actorId = overrides.actorId ?? 'lead-1'
  const sequence = overrides.sequence ?? 1

  return {
    id: overrides.id ?? createBoardEventId(eventType, actorId, sequence),
    sessionId: overrides.sessionId ?? 'session-1',
    rootSessionId: overrides.rootSessionId ?? 'session-1',
    monitorSessionId: overrides.monitorSessionId ?? 'monitor-1',
    actorId,
    parentActorId: overrides.parentActorId ?? null,
    actorType: overrides.actorType ?? 'lead',
    eventType,
    action: overrides.action ?? 'spawn',
    status: overrides.status ?? 'active',
    timestamp: overrides.timestamp ?? '2026-04-18T12:00:00.000Z',
    sequence,
    model: overrides.model ?? 'gpt-5.4',
    toolName: overrides.toolName ?? null,
    tokenIn: overrides.tokenIn ?? 10,
    tokenOut: overrides.tokenOut ?? 5,
    elapsedMs: overrides.elapsedMs ?? 100,
    costEstimate: overrides.costEstimate ?? 0.01,
    summary: overrides.summary ?? 'Lead started',
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    severity: overrides.severity ?? 'info',
    monitorEnabled: overrides.monitorEnabled ?? true,
    monitorInherited: overrides.monitorInherited ?? false,
    monitorOwnerActorId: overrides.monitorOwnerActorId ?? 'lead-1',
  }
}

const createToolEvent = (overrides: Partial<ToolBoardEvent> = {}): ToolBoardEvent => {
  const eventType: ToolBoardEvent['eventType'] = overrides.eventType ?? 'tool.called'
  const actorId = overrides.actorId ?? 'lead-1'
  const sequence = overrides.sequence ?? 1

  return {
    id: overrides.id ?? createBoardEventId(eventType, actorId, sequence),
    sessionId: overrides.sessionId ?? 'session-1',
    rootSessionId: overrides.rootSessionId ?? 'session-1',
    monitorSessionId: overrides.monitorSessionId ?? 'monitor-1',
    actorId,
    parentActorId: overrides.parentActorId ?? null,
    actorType: overrides.actorType ?? 'lead',
    eventType,
    action: overrides.action ?? (eventType === 'tool.finished' ? 'tool-finished' : 'tool-called'),
    status: overrides.status ?? (eventType === 'tool.finished' ? 'done' : 'active'),
    timestamp: overrides.timestamp ?? '2026-04-18T12:00:00.000Z',
    sequence,
    model: overrides.model ?? 'gpt-5.4',
    toolName: overrides.toolName ?? 'Read',
    tokenIn: overrides.tokenIn ?? 10,
    tokenOut: overrides.tokenOut ?? 5,
    elapsedMs: overrides.elapsedMs ?? 100,
    costEstimate: overrides.costEstimate ?? 0.01,
    summary: overrides.summary ?? 'Lead started',
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    severity: overrides.severity ?? 'info',
    monitorEnabled: overrides.monitorEnabled ?? true,
    monitorInherited: overrides.monitorInherited ?? false,
    monitorOwnerActorId: overrides.monitorOwnerActorId ?? 'lead-1',
  }
}

describe('runtime-store', () => {
  it('builds actor tree and aggregates top-bar stats', () => {
    let state = createInitialBoardState()

    state = reduceBoardEvent(state, createEvent())
    state = reduceBoardEvent(
      state,
      createEvent({
        id: createBoardEventId('actor.spawned', 'subagent-1', 2),
        actorId: 'subagent-1',
        parentActorId: 'lead-1',
        actorType: 'subagent',
        status: 'blocked',
        timestamp: '2026-04-18T12:00:01.000Z',
        sequence: 2,
        model: 'gpt-5.4-mini',
        tokenIn: 20,
        tokenOut: 10,
        elapsedMs: 300,
        summary: 'Waiting for input',
      }),
    )
    state = reduceBoardEvent(
      state,
      createEvent({
        id: createBoardEventId('actor.spawned', 'worker-1', 3),
        actorId: 'worker-1',
        parentActorId: 'subagent-1',
        actorType: 'worker',
        status: 'active',
        timestamp: '2026-04-18T12:00:02.000Z',
        sequence: 3,
        model: null,
        toolName: 'Read',
        tokenIn: 7,
        tokenOut: 3,
        elapsedMs: 120,
        summary: 'Inspecting file',
      }),
    )

    expect(state.actors.get('lead-1')).toMatchObject({
      children: ['subagent-1'],
      totalTokens: 15,
      elapsedMs: 100,
      lastEventAt: '2026-04-18T12:00:00.000Z',
    })
    expect(state.actors.get('subagent-1')).toMatchObject({
      parentActorId: 'lead-1',
      children: ['worker-1'],
      status: 'blocked',
      summary: 'Waiting for input',
      model: 'gpt-5.4-mini',
      totalTokens: 30,
      elapsedMs: 300,
      lastEventAt: '2026-04-18T12:00:01.000Z',
    })
    expect(state.actors.get('worker-1')).toMatchObject({
      parentActorId: 'subagent-1',
      children: [],
      toolName: 'Read',
      totalTokens: 10,
    })

    expect(selectTopBarStats(state)).toEqual({
      actorCount: 3,
      activeCount: 2,
      blockedCount: 1,
      totalTokens: 55,
      elapsedMs: 300,
    })
  })

  it('keeps newest actor snapshot when stale events arrive late while preserving a fully sorted timeline', () => {
    let state = createInitialBoardState()

    state = reduceBoardEvent(
      state,
      createToolEvent({
        actorId: 'worker-1',
        parentActorId: 'lead-1',
        actorType: 'worker',
        eventType: 'tool.finished',
        status: 'done',
        timestamp: '2026-04-18T12:00:02.000Z',
        sequence: 3,
        toolName: 'Read',
        tokenIn: 8,
        tokenOut: 4,
        elapsedMs: 240,
        summary: 'Finished latest work',
      }),
    )
    state = reduceBoardEvent(
      state,
      createToolEvent({
        actorId: 'worker-1',
        parentActorId: 'lead-1',
        actorType: 'worker',
        eventType: 'tool.called',
        status: 'active',
        timestamp: '2026-04-18T12:00:01.000Z',
        sequence: 2,
        toolName: 'Grep',
        tokenIn: 6,
        tokenOut: 2,
        elapsedMs: 120,
        summary: 'Older event arrived late',
      }),
    )
    state = reduceBoardEvent(
      state,
      createEvent({
        id: createBoardEventId('actor.spawned', 'lead-1', 1),
        timestamp: '2026-04-18T12:00:00.000Z',
        sequence: 1,
        summary: 'Lead started before worker events',
      }),
    )

    expect(state.actors.get('worker-1')).toMatchObject({
      parentActorId: 'lead-1',
      status: 'done',
      toolName: 'Read',
      summary: 'Finished latest work',
      totalTokens: 20,
      elapsedMs: 240,
      lastEventAt: '2026-04-18T12:00:02.000Z',
      lastEventSequence: 3,
    })

    expect(state.timeline.map((event) => `${event.timestamp}#${event.sequence}:${event.actorId}:${event.summary}`)).toEqual([
      '2026-04-18T12:00:00.000Z#1:lead-1:Lead started before worker events',
      '2026-04-18T12:00:01.000Z#2:worker-1:Older event arrived late',
      '2026-04-18T12:00:02.000Z#3:worker-1:Finished latest work',
    ])
  })

  it('sorts timeline and filters by selected actor', () => {
    let state = createInitialBoardState()

    state = reduceBoardEvent(
      state,
      createEvent({
        actorId: 'worker-1',
        parentActorId: 'lead-1',
        actorType: 'worker',
        timestamp: '2026-04-18T12:00:01.000Z',
        sequence: 2,
      }),
    )
    state = reduceBoardEvent(state, createEvent())
    state = reduceBoardEvent(
      state,
      createToolEvent({
        actorId: 'worker-1',
        parentActorId: 'lead-1',
        actorType: 'worker',
        eventType: 'tool.finished',
        toolName: 'Read',
        timestamp: '2026-04-18T12:00:01.000Z',
        sequence: 3,
        summary: 'Read complete',
      }),
    )

    expect(state.timeline.map((event) => `${event.timestamp}#${event.sequence}:${event.actorId}`)).toEqual([
      '2026-04-18T12:00:00.000Z#1:lead-1',
      '2026-04-18T12:00:01.000Z#2:worker-1',
      '2026-04-18T12:00:01.000Z#3:worker-1',
    ])

    expect(selectVisibleTimeline(state)).toHaveLength(3)
    expect(selectVisibleTimeline(state, 'worker-1').map((event) => event.sequence)).toEqual([2, 3])
    expect(selectVisibleTimeline(state, 'missing-actor')).toEqual([])
  })
})
