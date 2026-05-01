import { BoardEventSchema, createBoardEventId, type BoardEvent } from '../protocol';
import type { SessionSnapshot } from './session-registry';
import type { MonitorSessionStateLike } from './types';
import { LEAD_ACTOR_PREFIX, MONITOR_SESSION_DIRECTORY_PATH } from './types';

const buildLeadActorId = (rootSessionId: string) => `${LEAD_ACTOR_PREFIX}:${rootSessionId}`;

const normalizeActiveRootSessionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
};

const toTimestamp = (value: string | undefined, fallback: string): string => {
  const candidate = value ?? fallback;
  const parsed = Date.parse(candidate);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  const fallbackParsed = Date.parse(fallback);
  return Number.isNaN(fallbackParsed) ? fallback : new Date(fallbackParsed).toISOString();
};

const parseTimestampMs = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const isDisconnectedSnapshot = (snapshot: SessionSnapshot) =>
  snapshot.state.actors.some((actor) => actor.status === 'disconnected')
  || snapshot.state.timeline.some((event) => event.status === 'disconnected' || event.tags.includes('session-disconnected'));

const getSnapshotDisconnectedTimestamp = (snapshot: SessionSnapshot): string => {
  const latestTimelineEvent = snapshot.state.timeline[snapshot.state.timeline.length - 1];
  return latestTimelineEvent?.timestamp ?? new Date().toISOString();
};

const markSnapshotWaitingForUserInput = (
  snapshot: SessionSnapshot,
  params: { timestamp: string; reason: string },
): SessionSnapshot => {
  if (snapshot.state.actors.some((actor) => actor.status === 'disconnected')) {
    return snapshot;
  }

  const leadActor = snapshot.state.actors.find((actor) => actor.actorType === 'lead') ?? snapshot.state.actors[0];
  if (!leadActor) {
    return snapshot;
  }

  const lastEvent = snapshot.state.timeline[snapshot.state.timeline.length - 1];
  if (lastEvent?.status === 'idle' && lastEvent?.action === params.reason) {
    return snapshot;
  }

  const sequence = snapshot.state.timeline.length + 1;
  const waitingEvent: BoardEvent = BoardEventSchema.parse({
    id: createBoardEventId('session.updated', leadActor.id, sequence),
    eventType: 'session.updated',
    sessionId: lastEvent?.sessionId ?? leadActor.id,
    rootSessionId: lastEvent?.rootSessionId ?? leadActor.id,
    monitorSessionId: snapshot.monitorSessionId,
    actorId: leadActor.id,
    parentActorId: null,
    actorType: 'lead',
    action: params.reason,
    status: 'idle',
    timestamp: params.timestamp,
    sequence,
    model: leadActor.model,
    toolName: null,
    tokenIn: 0,
    tokenOut: 0,
    elapsedMs: leadActor.elapsedMs,
    costEstimate: 0,
    summary: params.reason,
    metadata: {
      displayName: 'Lead Agent',
      currentAction: params.reason,
      timelineLabel: params.reason,
    },
    tags: ['coco-live', 'awaiting-user-input'],
    severity: 'info',
    monitorEnabled: true,
    monitorInherited: false,
    monitorOwnerActorId: leadActor.id,
  });

  return {
    ...snapshot,
    stats: {
      ...snapshot.stats,
      activeCount: 0,
    },
    timelineCount: sequence,
    state: {
      actors: snapshot.state.actors.map((actor) =>
        actor.id === leadActor.id
          ? {
              ...actor,
              status: 'idle',
              lastEventAt: params.timestamp,
              lastEventSequence: sequence,
            }
          : actor,
      ),
      timeline: [...snapshot.state.timeline, waitingEvent],
    },
  };
};

const buildShellSnapshot = (params: {
  rootSessionId: string;
  sessionState: MonitorSessionStateLike | null;
  disconnected?: boolean;
}): SessionSnapshot => {
  const { rootSessionId, sessionState, disconnected = false } = params;
  const monitorSessionId = sessionState?.monitorSessionId || `monitor:${rootSessionId}`;
  const leadActorId = buildLeadActorId(rootSessionId);
  const timestamp = toTimestamp(sessionState?.updatedAt ?? sessionState?.createdAt, '1970-01-01T00:00:00.000Z');
  const leadStatus = disconnected ? 'disconnected' : sessionState?.status === 'failed' ? 'failed' : 'active';
  const action =
    disconnected
      ? 'live session disconnected'
      : sessionState?.status === 'active'
      ? 'awaiting runtime data'
      : `monitor session ${sessionState?.status ?? 'ready'}`;

  return {
    monitorSessionId,
    stats: {
      actorCount: 1,
      activeCount: leadStatus === 'active' ? 1 : 0,
      blockedCount: 0,
      totalTokens: 0,
      elapsedMs: 0,
    },
    actorCount: 1,
    timelineCount: 1,
    state: {
      actors: [
        {
          id: leadActorId,
          parentActorId: null,
          actorType: 'lead',
          status: leadStatus,
          summary: disconnected ? 'live session disconnected' : 'live shell awaiting runtime data',
          model: null,
          toolName: null,
          totalTokens: 0,
          elapsedMs: 0,
          children: [],
          lastEventAt: timestamp,
          lastEventSequence: 1,
        },
      ],
      timeline: [
        {
          id: `runtime:shell:${rootSessionId}`,
          eventType: disconnected ? 'session.updated' : 'session.started',
          sessionId: rootSessionId,
          rootSessionId,
          monitorSessionId,
          actorId: leadActorId,
          parentActorId: null,
          actorType: 'lead',
          action,
          status: leadStatus,
          timestamp,
          sequence: 1,
          model: null,
          toolName: null,
          tokenIn: 0,
          tokenOut: 0,
          elapsedMs: 0,
          costEstimate: 0,
          summary: action,
          metadata: {
            displayName: 'Lead Agent',
            currentAction: action,
            timelineLabel: action,
            ownerActorId: sessionState?.ownerActorId ?? 'lead',
          },
          tags: disconnected ? ['bata-workflow-runtime', 'session-shell', 'session-disconnected'] : ['bata-workflow-runtime', 'session-shell'],
          severity: disconnected ? 'warn' : 'info',
          monitorEnabled: true,
          monitorInherited: false,
          monitorOwnerActorId: leadActorId,
        },
      ],
    },
  };
};

const markSnapshotDisconnected = (
  snapshot: SessionSnapshot,
  params: { timestamp: string; reason: string },
): SessionSnapshot => {
  if (snapshot.state.actors.some((actor) => actor.status === 'disconnected')) {
    return snapshot;
  }

  const leadActor = snapshot.state.actors.find((actor) => actor.actorType === 'lead') ?? snapshot.state.actors[0];
  if (!leadActor) {
    return snapshot;
  }

  const lastEvent = snapshot.state.timeline[snapshot.state.timeline.length - 1];
  const sequence = snapshot.state.timeline.length + 1;
  const disconnectedEvent: BoardEvent = BoardEventSchema.parse({
    id: createBoardEventId('session.updated', leadActor.id, sequence),
    eventType: 'session.updated',
    sessionId: lastEvent?.sessionId ?? leadActor.id,
    rootSessionId: lastEvent?.rootSessionId ?? leadActor.id,
    monitorSessionId: snapshot.monitorSessionId,
    actorId: leadActor.id,
    parentActorId: null,
    actorType: 'lead',
    action: params.reason,
    status: 'disconnected',
    timestamp: params.timestamp,
    sequence,
    model: leadActor.model,
    toolName: null,
    tokenIn: 0,
    tokenOut: 0,
    elapsedMs: leadActor.elapsedMs,
    costEstimate: 0,
    summary: params.reason,
    metadata: {
      displayName: 'Lead Agent',
      currentAction: params.reason,
      timelineLabel: params.reason,
    },
    tags: ['bata-workflow-runtime', 'session-disconnected'],
    severity: 'warn',
    monitorEnabled: true,
    monitorInherited: false,
    monitorOwnerActorId: leadActor.id,
  });

  return {
    ...snapshot,
    stats: {
      ...snapshot.stats,
      activeCount: 0,
    },
    timelineCount: sequence,
    state: {
      actors: snapshot.state.actors.map((actor) =>
        actor.id === leadActor.id
          ? {
              ...actor,
              status: 'disconnected',
              lastEventAt: params.timestamp,
              lastEventSequence: sequence,
            }
          : actor,
      ),
      timeline: [...snapshot.state.timeline, disconnectedEvent],
    },
  };
};

export {
  buildLeadActorId,
  normalizeActiveRootSessionIds,
  toTimestamp,
  parseTimestampMs,
  isDisconnectedSnapshot,
  getSnapshotDisconnectedTimestamp,
  markSnapshotWaitingForUserInput,
  buildShellSnapshot,
  markSnapshotDisconnected,
  MONITOR_SESSION_DIRECTORY_PATH,
};
