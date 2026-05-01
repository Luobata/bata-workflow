import { describe, expect, it } from 'vitest'
import { BoardEventSchema, createBoardEventId } from './schema.js'

const createValidEvent = (overrides: Record<string, unknown> = {}) => ({
  id: createBoardEventId('actor.spawned', 'lead-1', 1),
  sessionId: 'session-1',
  rootSessionId: 'session-1',
  monitorSessionId: 'monitor-1',
  actorId: 'lead-1',
  parentActorId: null,
  actorType: 'lead',
  eventType: 'actor.spawned',
  action: 'spawn',
  status: 'active',
  timestamp: '2026-04-18T12:00:00.000Z',
  sequence: 1,
  model: 'gpt-5.4',
  toolName: null,
  tokenIn: 10,
  tokenOut: 5,
  elapsedMs: 50,
  costEstimate: 0.01,
  summary: 'Lead agent started',
  metadata: { source: 'coco' },
  tags: ['root'],
  severity: 'info',
  monitorEnabled: true,
  monitorInherited: false,
  monitorOwnerActorId: 'lead-1',
  ...overrides,
})

describe('BoardEventSchema', () => {
  it('accepts a spawned actor event', () => {
    const event = BoardEventSchema.parse(createValidEvent())

    expect(event.actorType).toBe('lead')
  })

  it('rejects tool.called events when toolName is null', () => {
    expect(() =>
      BoardEventSchema.parse(
        createValidEvent({
          id: createBoardEventId('tool.called', 'lead-1', 2),
          eventType: 'tool.called',
          action: 'tool-call',
          toolName: null,
          sequence: 2,
          summary: 'Tool called',
        }),
      ),
    ).toThrow(/toolName/)
  })

  it('rejects invalid timestamps', () => {
    expect(() =>
      BoardEventSchema.parse(
        createValidEvent({
          timestamp: 'not-a-timestamp',
        }),
      ),
    ).toThrow(/timestamp/)
  })

  it('rejects negative token counts', () => {
    expect(() =>
      BoardEventSchema.parse(
        createValidEvent({
          tokenIn: -1,
        }),
      ),
    ).toThrow(/tokenIn/)
  })

  it('rejects invalid event types', () => {
    expect(() =>
      BoardEventSchema.parse(
        createValidEvent({
          eventType: 'tool.unknown',
        }),
      ),
    ).toThrow(/eventType/)
  })

  it('rejects invalid actor types', () => {
    expect(() =>
      BoardEventSchema.parse(
        createValidEvent({
          id: 'bad',
          actorId: 'bad-1',
          actorType: 'manager',
          model: null,
          toolName: null,
          tokenIn: 0,
          tokenOut: 0,
          elapsedMs: 0,
          costEstimate: 0,
          summary: 'bad',
          metadata: {},
          tags: [],
        }),
      ),
    ).toThrow(/actorType/)
  })
})
