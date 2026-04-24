import { z } from 'zod';

export const ActorTypeSchema = z.enum(['lead', 'subagent', 'worker']);

const toolEventTypes = ['tool.called', 'tool.finished'] as const;
const nonToolEventTypes = [
  'session.started',
  'session.updated',
  'session.completed',
  'actor.spawned',
  'actor.status_changed',
  'actor.completed',
  'actor.failed',
  'actor.canceled',
  'action.started',
  'action.summary',
] as const;

export const EventTypeSchema = z.enum([
  ...nonToolEventTypes,
  ...toolEventTypes,
]);
export const ToolEventTypeSchema = z.enum(toolEventTypes);
export const NonToolEventTypeSchema = z.enum(nonToolEventTypes);

export const StatusSchema = z.enum(['idle', 'active', 'blocked', 'done', 'failed', 'canceled', 'disconnected']);

export const SeveritySchema = z.enum(['info', 'warn', 'error']);

const BaseBoardEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  rootSessionId: z.string().min(1),
  monitorSessionId: z.string().min(1),
  actorId: z.string().min(1),
  parentActorId: z.string().nullable(),
  actorType: ActorTypeSchema,
  action: z.string().min(1),
  status: StatusSchema,
  timestamp: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  model: z.string().nullable(),
  toolName: z.string().nullable(),
  tokenIn: z.number().nonnegative(),
  tokenOut: z.number().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  costEstimate: z.number().nonnegative(),
  summary: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  severity: SeveritySchema,
  monitorEnabled: z.boolean(),
  monitorInherited: z.boolean(),
  monitorOwnerActorId: z.string().min(1),
});

const NonToolBoardEventSchema = BaseBoardEventSchema.extend({
  eventType: NonToolEventTypeSchema,
  toolName: z.string().nullable(),
});

const ToolBoardEventSchema = BaseBoardEventSchema.extend({
  eventType: ToolEventTypeSchema,
  toolName: z.string().min(1),
});

export const BoardEventSchema = z.discriminatedUnion('eventType', [
  NonToolBoardEventSchema,
  ToolBoardEventSchema,
]);

export type ActorType = z.infer<typeof ActorTypeSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type BoardStatus = z.infer<typeof StatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const createBoardEventId = (eventType: EventType, actorId: string, sequence: number) =>
  `${eventType}:${actorId}:${sequence}`;
