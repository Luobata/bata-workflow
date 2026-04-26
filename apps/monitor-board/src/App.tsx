import React, { useEffect, useMemo, useState } from 'react';
import type { SessionSnapshot } from '@monitor/monitor-gateway';
import { useBoardStore } from './store/useBoardStore';
import { CrewGrid, type CrewCard } from './components/CrewGrid';
import { FocusDrawer, type FocusDrawerViewModel } from './components/FocusDrawer';
import { RunTree, type RunTreeNode } from './components/RunTree';
import { TimelinePanel, type TimelineEntry } from './components/TimelinePanel';
import { TopBar } from './components/TopBar';
import type { BoardMode, BoardPanelTab } from './store/useBoardStore';
import './styles/pixel-theme.css';

type SessionActor = SessionSnapshot['state']['actors'][number];
type SessionEvent = SessionSnapshot['state']['timeline'][number];
type ActorStatus = SessionActor['status'];

interface AdaptedActorViewModel {
  id: string;
  name: string;
  actorType: SessionActor['actorType'];
  parentActorId: string | null;
  status: ActorStatus;
  summary: string;
  currentAction: string;
  model: string;
  latestTool: string | null;
  tokenCount: number;
  elapsedLabel: string;
  updatedAt: string;
  progressPercent: number;
  progressStage: string;
}

interface OverallProgressViewModel {
  label: string;
  detail: string;
  percent: number;
  stage: string;
}

interface ProgressBoardRowViewModel {
  id: string;
  name: string;
  role: string;
  status: string;
  stage: string;
  progressPercent: number;
  detail: string;
}

interface FocusTargetViewModel {
  name: string;
  role: string;
  status: string;
  stage: string;
  progressPercent: number;
  currentAction: string;
}

interface AppProps {
  initialSnapshot?: SessionSnapshot;
  socketUrl?: string;
  connectSocket?: BoardSocketConnector;
  targetMonitorSessionId?: string | null;
}

type BoardSocketConnection = Pick<WebSocket, 'close'>;
type BoardSocketConnector = (url: string, onMessage: (payload: unknown) => void) => BoardSocketConnection;
type BoardSocketWithLifecycle = BoardSocketConnection & {
  addEventListener?: (type: 'open' | 'close' | 'error', listener: EventListener) => void;
  removeEventListener?: (type: 'open' | 'close' | 'error', listener: EventListener) => void;
};

const DEFAULT_SOCKET_URL = 'ws://127.0.0.1:8787';
const SOCKET_RECONNECT_BASE_DELAY_MS = 300;
const SOCKET_RECONNECT_MAX_DELAY_MS = 5_000;

const connectBoardSocket: BoardSocketConnector = (url, onMessage) => {
  const socket = new WebSocket(url);

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      return;
    }

    try {
      onMessage(JSON.parse(event.data));
    } catch {
      // Ignore malformed websocket payloads and wait for the next snapshot.
    }
  });

  return socket;
};

const cloneDemoSnapshotForMonitor = (monitorSessionId: string): SessionSnapshot => ({
  ...demoSnapshot,
  monitorSessionId,
  state: {
    actors: demoSnapshot.state.actors.map((actor) => ({
      ...actor,
      children: [...actor.children],
    })),
    timeline: demoSnapshot.state.timeline.map((event) => ({
      ...event,
      monitorSessionId,
    })),
  },
});

const createDemoSnapshot = (monitorSessionId = demoSnapshot.monitorSessionId): SessionSnapshot =>
  monitorSessionId === demoSnapshot.monitorSessionId ? demoSnapshot : cloneDemoSnapshotForMonitor(monitorSessionId);

const createLiveShellSnapshot = (monitorSessionId: string): SessionSnapshot => {
  const rootSessionId = monitorSessionId.startsWith('monitor:') ? monitorSessionId.slice('monitor:'.length) : monitorSessionId;
  const leadActorId = `lead:${rootSessionId}`;
  const timestamp = '1970-01-01T00:00:00.000Z';

  return {
    monitorSessionId,
    stats: {
      actorCount: 1,
      activeCount: 1,
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
          status: 'active',
          summary: 'live shell awaiting runtime data',
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
          sessionId: rootSessionId,
          rootSessionId,
          monitorSessionId,
          actorId: leadActorId,
          parentActorId: null,
          actorType: 'lead',
          eventType: 'session.started',
          action: 'awaiting runtime data',
          status: 'active',
          timestamp,
          sequence: 1,
          model: null,
          toolName: null,
          tokenIn: 0,
          tokenOut: 0,
          elapsedMs: 0,
          costEstimate: 0,
          summary: 'awaiting runtime data',
          metadata: {
            displayName: 'Lead Agent',
            currentAction: 'awaiting runtime data',
            timelineLabel: 'awaiting runtime data',
          },
          tags: ['harness-runtime', 'session-shell'],
          severity: 'info',
          monitorEnabled: true,
          monitorInherited: false,
          monitorOwnerActorId: leadActorId,
        },
      ],
    },
  };
};

const createPendingShellSnapshot = (): SessionSnapshot => createLiveShellSnapshot('monitor:pending');

export const resolveAppBootstrapFromLocation = (
  search: string,
): Pick<AppProps, 'initialSnapshot' | 'targetMonitorSessionId' | 'socketUrl'> => {
  const params = new URLSearchParams(search);
  const targetMonitorSessionId = params.get('monitorSessionId')?.trim();
  const socketUrl = params.get('socketUrl')?.trim();

  if (targetMonitorSessionId) {
    return {
      targetMonitorSessionId,
      ...(socketUrl ? { socketUrl } : {}),
    };
  }

  const demoSeed = params.get('seed')?.trim();

  if (demoSeed) {
    return {
      initialSnapshot: createDemoSnapshot(demoSeed),
    };
  }

  return {};
};

const resolveInitialSnapshot = (
  initialSnapshot: SessionSnapshot | undefined,
  targetMonitorSessionId: string | null | undefined,
): SessionSnapshot => (targetMonitorSessionId ? createLiveShellSnapshot(targetMonitorSessionId) : (initialSnapshot ?? createPendingShellSnapshot()));

const demoSnapshot: SessionSnapshot = {
  monitorSessionId: 'Task 8 Board',
  stats: {
    actorCount: 3,
    activeCount: 2,
    blockedCount: 0,
    totalTokens: 1280,
    elapsedMs: 734000,
  },
  actorCount: 3,
  timelineCount: 4,
  state: {
    actors: [
      {
        id: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        status: 'active',
        summary: 'Coordinating panel focus state',
        model: 'GPT-5.4',
        toolName: 'planning',
        totalTokens: 640,
        elapsedMs: 734000,
        children: ['subagent-1'],
        lastEventAt: '2026-04-18T12:05:00.000Z',
        lastEventSequence: 3,
      },
      {
        id: 'subagent-1',
        parentActorId: 'lead-1',
        actorType: 'subagent',
        status: 'active',
        summary: 'Shipping panel composition',
        model: 'GPT-5.4-mini',
        toolName: 'apply_patch',
        totalTokens: 420,
        elapsedMs: 511000,
        children: ['worker-1'],
        lastEventAt: '2026-04-18T12:03:00.000Z',
        lastEventSequence: 2,
      },
      {
        id: 'worker-1',
        parentActorId: 'subagent-1',
        actorType: 'worker',
        status: 'idle',
        summary: 'Holding virtualized rows',
        model: 'GPT-5.4-nano',
        toolName: 'vitest',
        totalTokens: 220,
        elapsedMs: 260000,
        children: [],
        lastEventAt: '2026-04-18T12:08:00.000Z',
        lastEventSequence: 4,
      },
    ],
    timeline: [
      {
        id: 'evt-1',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId: 'Task 8 Board',
        actorId: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'session.started',
        action: 'opened Task 8 board shell',
        status: 'active',
        timestamp: '2026-04-18T12:01:00.000Z',
        sequence: 1,
        model: 'GPT-5.4',
        toolName: null,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 1000,
        costEstimate: 0,
        summary: 'Lead opened Task 8 board shell',
        metadata: {
          displayName: 'Lead Agent',
          currentAction: 'Aligning the board view-model pipeline',
          timelineLabel: 'opened Task 8 board shell',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-2',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId: 'Task 8 Board',
        actorId: 'subagent-1',
        parentActorId: 'lead-1',
        actorType: 'subagent',
        eventType: 'action.summary',
        action: 'Wiring summary and metadata variants',
        status: 'active',
        timestamp: '2026-04-18T12:03:00.000Z',
        sequence: 2,
        model: 'GPT-5.4-mini',
        toolName: 'apply_patch',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 3000,
        costEstimate: 0,
        summary: 'UI worker wired summary and metadata panels',
        metadata: {
          displayName: 'UI Worker',
          currentAction: 'Wiring summary and metadata variants',
          timelineLabel: 'wired summary and metadata panels',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: true,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-3',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId: 'Task 8 Board',
        actorId: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'action.summary',
        action: 'Synced focus hand-off',
        status: 'active',
        timestamp: '2026-04-18T12:05:00.000Z',
        sequence: 3,
        model: 'GPT-5.4',
        toolName: 'planning',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 5000,
        costEstimate: 0,
        summary: 'Lead synced focus hand-off',
        metadata: {
          displayName: 'Lead Agent',
          currentAction: 'Aligning the board view-model pipeline',
          timelineLabel: 'synced focus hand-off',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-4',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId: 'Task 8 Board',
        actorId: 'worker-1',
        parentActorId: 'subagent-1',
        actorType: 'worker',
        eventType: 'action.summary',
        action: 'Waiting for next actor filter update',
        status: 'idle',
        timestamp: '2026-04-18T12:08:00.000Z',
        sequence: 4,
        model: 'GPT-5.4-nano',
        toolName: 'vitest',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 8000,
        costEstimate: 0,
        summary: 'Timeline worker mounted virtual rows',
        metadata: {
          displayName: 'Timeline Worker',
          currentAction: 'Waiting for next actor filter update',
          timelineLabel: 'mounted virtual rows',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: true,
        monitorOwnerActorId: 'lead-1',
      },
    ],
  },
};

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const formatElapsedMs = (elapsedMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};

const formatClockTime = (value: string) => {
  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return value;
  }

  const timeZoneFromUrl = (() => {
    try {
      return new URLSearchParams(globalThis.location?.search ?? '').get('timeZone')?.trim() ?? '';
    } catch {
      return '';
    }
  })();

  const resolvedTimeZone = timeZoneFromUrl || Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    return timestamp.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...(resolvedTimeZone ? { timeZone: resolvedTimeZone } : {}),
    });
  } catch {
    // Fallback when URL timeZone parameter is invalid.
  }

  return timestamp.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

const normalizeRatio = (value: number, max: number) => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, value / max));
};

const getProgressStage = (progressPercent: number) => {
  if (progressPercent >= 95) {
    return 'Completed';
  }

  if (progressPercent >= 75) {
    return 'Wrapping';
  }

  if (progressPercent >= 45) {
    return 'Execution';
  }

  if (progressPercent >= 20) {
    return 'Scouting';
  }

  return 'Booting';
};

const buildActorProgressPercent = (params: {
  status: ActorStatus;
  tokenRatio: number;
  elapsedRatio: number;
  eventRatio: number;
  shellActor: boolean;
  disconnectedActor: boolean;
}) => {
  const { status, tokenRatio, elapsedRatio, eventRatio, shellActor, disconnectedActor } = params;

  if (shellActor) {
    return 0;
  }

  if (disconnectedActor) {
    return 0;
  }

  if (status === 'done') {
    return 100;
  }

  const activityBoost = clampPercent(tokenRatio * 12 + elapsedRatio * 10 + eventRatio * 8);

  switch (status) {
    case 'active':
      return Math.min(90, 52 + activityBoost);
    case 'blocked':
      return Math.min(84, 44 + activityBoost);
    case 'idle':
      return Math.min(74, 30 + activityBoost);
    case 'failed':
      return Math.min(40, 18 + Math.round(activityBoost * 0.25));
    case 'canceled':
      return 8;
    case 'disconnected':
      return 0;
    default:
      return clampPercent(24 + activityBoost);
  }
};

const operationsDeckTabs: Array<{ id: BoardPanelTab; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'runTree', label: 'Run Tree' },
  { id: 'progress', label: 'Progress Board' },
];

const readStringFromMetadata = (metadata: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = metadata[key];

    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
};

const hasEventTag = (event: SessionEvent | undefined, tag: string) => Array.isArray(event?.tags) && event.tags.includes(tag);

const isShellEvent = (event: SessionEvent | undefined) => hasEventTag(event, 'session-shell');

const isDisconnectedEvent = (event: SessionEvent | undefined) =>
  event?.status === 'disconnected' || hasEventTag(event, 'session-disconnected');

const isShellSnapshot = (snapshot: SessionSnapshot) => snapshot.state.timeline.some((event) => isShellEvent(event));

const isDisconnectedShellSnapshot = (snapshot: SessionSnapshot) =>
  isShellSnapshot(snapshot) && snapshot.state.timeline.some((event) => isDisconnectedEvent(event));

const isDisconnectedSnapshot = (snapshot: SessionSnapshot) =>
  snapshot.state.actors.some((actor) => actor.status === 'disconnected')
  || snapshot.state.timeline.some((event) => isDisconnectedEvent(event));

const mergeDisconnectedSnapshot = (currentSnapshot: SessionSnapshot, disconnectedSnapshot: SessionSnapshot): SessionSnapshot => {
  if (isDisconnectedSnapshot(currentSnapshot) && !isShellSnapshot(currentSnapshot)) {
    return currentSnapshot;
  }

  if (isShellSnapshot(currentSnapshot)) {
    return disconnectedSnapshot;
  }

  const leadActor = currentSnapshot.state.actors.find((actor) => actor.actorType === 'lead') ?? currentSnapshot.state.actors[0];
  if (!leadActor) {
    return disconnectedSnapshot;
  }

  const shellEvent = disconnectedSnapshot.state.timeline[disconnectedSnapshot.state.timeline.length - 1];
  const timestamp = shellEvent?.timestamp ?? currentSnapshot.state.timeline[currentSnapshot.state.timeline.length - 1]?.timestamp ?? new Date().toISOString();
  const sequence = currentSnapshot.state.timeline.length + 1;
  const reason = shellEvent?.summary ?? shellEvent?.action ?? 'live session disconnected';
  const disconnectedEvent: SessionEvent = {
    id: `disconnect:${leadActor.id}:${sequence}`,
    eventType: 'session.updated',
    sessionId: shellEvent?.sessionId ?? currentSnapshot.state.timeline[currentSnapshot.state.timeline.length - 1]?.sessionId ?? leadActor.id,
    rootSessionId:
      shellEvent?.rootSessionId ?? currentSnapshot.state.timeline[currentSnapshot.state.timeline.length - 1]?.rootSessionId ?? leadActor.id,
    monitorSessionId: currentSnapshot.monitorSessionId,
    actorId: leadActor.id,
    parentActorId: null,
    actorType: 'lead',
    action: reason,
    status: 'disconnected',
    timestamp,
    sequence,
    model: leadActor.model,
    toolName: null,
    tokenIn: 0,
    tokenOut: 0,
    elapsedMs: leadActor.elapsedMs,
    costEstimate: 0,
    summary: reason,
    metadata: {
      displayName: 'Lead Agent',
      currentAction: reason,
      timelineLabel: reason,
    },
    tags: ['harness-runtime', 'session-disconnected'],
    severity: 'warn',
    monitorEnabled: true,
    monitorInherited: false,
    monitorOwnerActorId: leadActor.id,
  };

  return {
    ...currentSnapshot,
    stats: {
      ...currentSnapshot.stats,
      activeCount: 0,
    },
    timelineCount: sequence,
    state: {
      actors: currentSnapshot.state.actors.map((actor) =>
        actor.id === leadActor.id
          ? {
              ...actor,
              status: 'disconnected',
              lastEventAt: timestamp,
              lastEventSequence: sequence,
            }
          : actor,
      ),
      timeline: [...currentSnapshot.state.timeline, disconnectedEvent],
    },
  };
};

const buildFallbackActorName = (actor: SessionActor) => {
  if (actor.actorType === 'lead') {
    return 'Lead Agent';
  }

  const suffix = actor.id.match(/(\d+)$/)?.[1];
  return suffix ? `${titleCase(actor.actorType)} ${suffix}` : `${titleCase(actor.actorType)} ${actor.id}`;
};

const compareEventOrder = (left: Pick<SessionEvent, 'timestamp' | 'sequence'>, right: Pick<SessionEvent, 'timestamp' | 'sequence'>) => {
  if (left.timestamp === right.timestamp) {
    return left.sequence - right.sequence;
  }

  return left.timestamp.localeCompare(right.timestamp);
};

const getLatestEventByActorId = (snapshot: SessionSnapshot) => {
  const latestByActorId = new Map<string, SessionEvent>();

  snapshot.state.timeline.forEach((event) => {
    const current = latestByActorId.get(event.actorId);

    if (!current || compareEventOrder(current, event) <= 0) {
      latestByActorId.set(event.actorId, event);
    }
  });

  return latestByActorId;
};

const getEventCountByActorId = (snapshot: SessionSnapshot) => {
  const eventCountByActorId = new Map<string, number>();

  snapshot.state.timeline.forEach((event) => {
    eventCountByActorId.set(event.actorId, (eventCountByActorId.get(event.actorId) ?? 0) + 1);
  });

  return eventCountByActorId;
};

const adaptActors = (snapshot: SessionSnapshot): AdaptedActorViewModel[] => {
  const latestEventByActorId = getLatestEventByActorId(snapshot);
  const eventCountByActorId = getEventCountByActorId(snapshot);
  const maxTokenCount = Math.max(1, ...snapshot.state.actors.map((actor) => actor.totalTokens));
  const maxElapsedMs = Math.max(1, ...snapshot.state.actors.map((actor) => actor.elapsedMs));
  const maxEventCount = Math.max(1, ...snapshot.state.actors.map((actor) => eventCountByActorId.get(actor.id) ?? 0));

  return snapshot.state.actors.map((actor) => {
    const latestEvent = latestEventByActorId.get(actor.id);
    const metadata = isRecord(latestEvent?.metadata) ? latestEvent.metadata : {};
    const name = readStringFromMetadata(metadata, ['displayName', 'actorName', 'name']) ?? buildFallbackActorName(actor);
    const currentAction =
      readStringFromMetadata(metadata, ['currentAction', 'actionLabel']) ?? latestEvent?.action ?? actor.summary;
    const eventCount = eventCountByActorId.get(actor.id) ?? 0;
    const shellActor = isShellEvent(latestEvent);
    const disconnectedActor = actor.status === 'disconnected' || isDisconnectedEvent(latestEvent);
    const progressPercent = buildActorProgressPercent({
      status: actor.status,
      tokenRatio: normalizeRatio(actor.totalTokens, maxTokenCount),
      elapsedRatio: normalizeRatio(actor.elapsedMs, maxElapsedMs),
      eventRatio: normalizeRatio(eventCount, maxEventCount),
      shellActor,
      disconnectedActor,
    });
    const progressStage = disconnectedActor ? 'Disconnected' : shellActor ? 'Syncing' : getProgressStage(progressPercent);

    return {
      id: actor.id,
      name,
      actorType: actor.actorType,
      parentActorId: actor.parentActorId,
      status: actor.status,
      summary: actor.summary,
      currentAction,
      model: actor.model ?? latestEvent?.model ?? 'unassigned',
      latestTool: actor.toolName ?? latestEvent?.toolName ?? null,
      tokenCount: actor.totalTokens,
      elapsedLabel: formatElapsedMs(actor.elapsedMs),
      updatedAt: formatClockTime(actor.lastEventAt),
      progressPercent,
      progressStage,
    };
  });
};

const buildRunTreeNodes = (actors: AdaptedActorViewModel[], parentActorId: string | null): RunTreeNode[] =>
  actors
    .filter((actor) => actor.parentActorId === parentActorId)
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      role: actor.actorType,
      status: actor.status,
      progressPercent: actor.progressPercent,
      children: buildRunTreeNodes(actors, actor.id),
    }));

const buildCrewCards = (actors: AdaptedActorViewModel[], mode: BoardMode): CrewCard[] =>
  actors.map((actor) => ({
    id: actor.id,
    name: actor.name,
    role: titleCase(actor.actorType),
    status: actor.status,
    actorType: actor.actorType,
    primaryDetail: mode === 'summary' ? actor.summary : `Model ${actor.model}`,
    secondaryDetail:
      mode === 'summary'
        ? `Action ${actor.currentAction}`
        : `Status ${actor.status} · Tool ${actor.latestTool ?? 'none'}`,
    progressPercent: actor.progressPercent,
    progressStage: actor.progressStage,
    progressLabel: `Progress ${actor.progressPercent}%`,
    metricLabel: mode === 'summary' ? `Updated ${actor.updatedAt}` : `Tokens ${actor.tokenCount}`,
  }));

const deriveHealth = (actors: AdaptedActorViewModel[]) => {
  const statuses = new Set(actors.map((actor) => actor.status));

  if (statuses.has('failed')) {
    return 'failed';
  }

  if (statuses.has('disconnected')) {
    return 'disconnected';
  }

  if (statuses.has('blocked')) {
    return 'blocked';
  }

  if (statuses.has('active')) {
    return 'active';
  }

  if (statuses.has('done')) {
    return 'done';
  }

  return 'idle';
};

const buildOverallProgress = (snapshot: SessionSnapshot, actors: AdaptedActorViewModel[]): OverallProgressViewModel => {
  if (isDisconnectedShellSnapshot(snapshot)) {
    return {
      label: 'Quest 0%',
      detail: 'live shell · disconnected',
      percent: 0,
      stage: 'Disconnected',
    };
  }

  if (isShellSnapshot(snapshot)) {
    return {
      label: 'Quest 0%',
      detail: 'live shell · waiting for runtime data',
      percent: 0,
      stage: 'Syncing',
    };
  }

  const doneCount = actors.filter((actor) => actor.status === 'done').length;
  const percent = clampPercent(
    actors.reduce((total, actor) => total + actor.progressPercent, 0) / Math.max(1, actors.length),
  );

  if (actors.some((actor) => actor.status === 'disconnected')) {
    return {
      label: `Quest ${percent}%`,
      detail: 'live session disconnected',
      percent,
      stage: 'Disconnected',
    };
  }

  return {
    label: `Quest ${percent}%`,
    detail: `${snapshot.stats.activeCount} active · ${snapshot.stats.blockedCount} blocked · ${doneCount} done`,
    percent,
    stage: getProgressStage(percent),
  };
};

const buildProgressBoardRows = (actors: AdaptedActorViewModel[]): ProgressBoardRowViewModel[] =>
  actors.map((actor) => ({
    id: actor.id,
    name: actor.name,
    role: titleCase(actor.actorType),
    status: actor.status,
    stage: actor.progressStage,
    progressPercent: actor.progressPercent,
    detail: `${actor.currentAction} · ${actor.elapsedLabel}`,
  }));

const buildFocusTargetViewModel = (actor: AdaptedActorViewModel | null): FocusTargetViewModel | null => {
  if (!actor) {
    return null;
  }

  return {
    name: actor.name,
    role: titleCase(actor.actorType),
    status: actor.status,
    stage: actor.progressStage,
    progressPercent: actor.progressPercent,
    currentAction: actor.currentAction,
  };
};

const buildTopBarStats = (snapshot: SessionSnapshot, actors: AdaptedActorViewModel[], overallProgress: OverallProgressViewModel) => ({
  mission: snapshot.monitorSessionId,
  progress: `${overallProgress.percent}% quest`,
  tokens: snapshot.stats.totalTokens.toLocaleString(),
  elapsed: formatElapsedMs(snapshot.stats.elapsedMs),
  actors: String(snapshot.actorCount),
  health: deriveHealth(actors),
});

const buildTimelineEntries = (
  snapshot: SessionSnapshot,
  actors: AdaptedActorViewModel[],
  selectedActorId: string | null,
): TimelineEntry[] => {
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));

  return snapshot.state.timeline
    .filter((entry) => !selectedActorId || entry.actorId === selectedActorId)
    .map((entry) => {
      const metadata = isRecord(entry.metadata) ? entry.metadata : {};
      const summary = readStringFromMetadata(metadata, ['timelineSummary', 'timelineLabel']) ?? entry.summary ?? entry.action;
      const actor = actorsById.get(entry.actorId);
      const actorName = actor?.name ?? 'Unknown Actor';
      const actorType = actor?.actorType ?? entry.actorType ?? 'worker';
      const timestamp = formatClockTime(entry.timestamp);

      return {
        id: entry.id,
        actorId: entry.actorId,
        actorName,
        actorType,
        status: entry.status,
        timestamp,
        summary,
      };
    });
};

const buildFocusDrawerViewModel = (actor: AdaptedActorViewModel | null, mode: BoardMode): FocusDrawerViewModel => {
  if (!actor) {
    return {
      title: `FOCUS ${mode === 'summary' ? 'SUMMARY' : 'METADATA'}`,
      focusLine: 'Focus: none',
      detailLines: ['Select an actor to inspect the current task lane.'],
      chips: ['NO TARGET', `MODE ${mode.toUpperCase()}`],
    };
  }

  return {
    title: `FOCUS ${mode === 'summary' ? 'SUMMARY' : 'METADATA'}`,
    focusLine: `Focus: ${actor.name}`,
    detailLines:
      mode === 'summary'
        ? [actor.summary, `Action: ${actor.currentAction}`, `Lane progress: ${actor.progressPercent}%`, `Stage: ${actor.progressStage}`]
        : [`Model: ${actor.model}`, `Status: ${actor.status} · Tokens: ${actor.tokenCount}`, `Lane progress: ${actor.progressPercent}%`, `Stage: ${actor.progressStage}`],
    chips: [actor.actorType.toUpperCase(), actor.status.toUpperCase(), actor.progressStage.toUpperCase(), `MODE ${mode.toUpperCase()}`, `TOOL ${(actor.latestTool ?? 'none').toUpperCase()}`],
  };
};

const ProgressBoardPanel = ({
  overallProgress,
  rows,
}: {
  overallProgress: OverallProgressViewModel;
  rows: ProgressBoardRowViewModel[];
}) => {
  return (
    <section className="pixel-panel board-panel">
      <div className="panel-section progress-board-panel">
        <h2 className="panel-title">PROGRESS BOARD</h2>
        <div className="progress-board-quest">
          <div className="progress-board-quest-copy">
            <span className="progress-board-quest-label">Quest Stage</span>
            <strong className="progress-board-quest-stage">{overallProgress.stage}</strong>
            <span className="progress-board-quest-detail">{overallProgress.label} · {overallProgress.detail}</span>
          </div>
          <span className="progress-board-quest-track" aria-hidden="true">
            <span className="progress-board-quest-fill" style={{ width: `${overallProgress.percent}%` }} />
          </span>
        </div>
        <div className="progress-board-list" role="list" aria-label="Agent progress board">
          {rows.map((row) => (
            <div key={row.id} className="progress-board-row" role="listitem" data-status={row.status}>
              <div className="progress-board-row-head">
                <span className="progress-board-row-name">{row.name}</span>
                <span className="progress-board-row-role">{row.role}</span>
                <span className="progress-board-row-stage">{row.stage}</span>
              </div>
              <span className="progress-board-row-detail">{row.detail}</span>
              <div className="progress-board-row-progress">
                <span className="progress-board-row-track" aria-hidden="true">
                  <span className="progress-board-row-fill" style={{ width: `${row.progressPercent}%` }} />
                </span>
                <span className="progress-board-row-value">{row.progressPercent}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const isSessionSnapshot = (payload: unknown): payload is SessionSnapshot => {
  if (!isRecord(payload) || typeof payload.monitorSessionId !== 'string') {
    return false;
  }

  if (!isRecord(payload.stats) || !isRecord(payload.state)) {
    return false;
  }

  return Array.isArray(payload.state.actors) && Array.isArray(payload.state.timeline);
};

export const App = ({
  initialSnapshot,
  socketUrl = DEFAULT_SOCKET_URL,
  connectSocket = connectBoardSocket,
  targetMonitorSessionId = null,
}: AppProps) => {
  const resolvedInitialSnapshot = useMemo(
    () => resolveInitialSnapshot(initialSnapshot, targetMonitorSessionId),
    [initialSnapshot, targetMonitorSessionId],
  );
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(resolvedInitialSnapshot);
  const [socketConnectionIssue, setSocketConnectionIssue] = useState<string | null>(null);

  const mode = useBoardStore((state) => state.mode);
  const activePanelTab = useBoardStore((state) => state.activePanelTab);
  const selectedActorId = useBoardStore((state) => state.selectedActorId);
  const setMode = useBoardStore((state) => state.setMode);
  const setActivePanelTab = useBoardStore((state) => state.setActivePanelTab);
  const setSelectedActorId = useBoardStore((state) => state.setSelectedActorId);

  useEffect(() => {
    setSnapshot(resolvedInitialSnapshot);
  }, [resolvedInitialSnapshot]);

  useEffect(() => {
    let socket: BoardSocketWithLifecycle | null = null;
    let cancelled = false;
    let connectionTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let reconnectDelayMs = SOCKET_RECONNECT_BASE_DELAY_MS;

    const clearScheduledConnect = () => {
      if (connectionTimer !== null) {
        globalThis.clearTimeout(connectionTimer);
        connectionTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || connectionTimer !== null) {
        return;
      }

      connectionTimer = globalThis.setTimeout(() => {
        connectionTimer = null;
        void connectWithRetry();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, SOCKET_RECONNECT_MAX_DELAY_MS);
    };

    const attachSocketLifecycle = (activeSocket: BoardSocketWithLifecycle) => {
      if (typeof activeSocket.addEventListener !== 'function' || typeof activeSocket.removeEventListener !== 'function') {
        setSocketConnectionIssue(null);
        return () => undefined;
      }

      const handleOpen = () => {
        reconnectDelayMs = SOCKET_RECONNECT_BASE_DELAY_MS;
        setSocketConnectionIssue(null);
      };

      const handleCloseOrError = () => {
        if (cancelled) {
          return;
        }

        setSocketConnectionIssue('live gateway disconnected · retrying');
        scheduleReconnect();
      };

      activeSocket.addEventListener('open', handleOpen);
      activeSocket.addEventListener('close', handleCloseOrError);
      activeSocket.addEventListener('error', handleCloseOrError);

      return () => {
        activeSocket.removeEventListener?.('open', handleOpen);
        activeSocket.removeEventListener?.('close', handleCloseOrError);
        activeSocket.removeEventListener?.('error', handleCloseOrError);
      };
    };

    let detachSocketLifecycle: () => void = () => {};

    const connectWithRetry = async () => {
      if (cancelled) {
        return;
      }

      try {
        socket = connectSocket(socketUrl, (payload) => {
          if (isSessionSnapshot(payload) && (!targetMonitorSessionId || payload.monitorSessionId === targetMonitorSessionId)) {
            reconnectDelayMs = SOCKET_RECONNECT_BASE_DELAY_MS;
            setSocketConnectionIssue(null);
            setSnapshot((currentSnapshot) =>
              isDisconnectedShellSnapshot(payload) ? mergeDisconnectedSnapshot(currentSnapshot, payload) : payload,
            );
          }
        }) as BoardSocketWithLifecycle;
        detachSocketLifecycle();
        detachSocketLifecycle = attachSocketLifecycle(socket);
      } catch (error) {
        setSocketConnectionIssue(error instanceof Error ? `live gateway unavailable · ${error.message}` : 'live gateway unavailable · retrying');
        socket = null;
        scheduleReconnect();
      }
    };

    connectionTimer = globalThis.setTimeout(() => {
      connectionTimer = null;
      void connectWithRetry();
    }, 0);

    return () => {
      cancelled = true;
      clearScheduledConnect();
      detachSocketLifecycle();
      socket?.close();
    };
  }, [connectSocket, socketUrl, targetMonitorSessionId]);

  const actors = useMemo(() => adaptActors(snapshot), [snapshot]);
  const leadActorId = actors.find((actor) => actor.actorType === 'lead')?.id ?? actors[0]?.id ?? null;
  const resolvedSelectedActorId =
    selectedActorId && actors.some((actor) => actor.id === selectedActorId) ? selectedActorId : leadActorId;

  useEffect(() => {
    if (resolvedSelectedActorId !== selectedActorId) {
      setSelectedActorId(resolvedSelectedActorId);
    }
  }, [resolvedSelectedActorId, selectedActorId, setSelectedActorId]);

  const overallProgress = useMemo(() => buildOverallProgress(snapshot, actors), [snapshot, actors]);
  const topBarStats = useMemo(() => buildTopBarStats(snapshot, actors, overallProgress), [snapshot, actors, overallProgress]);
  const runTreeNodes = useMemo(() => buildRunTreeNodes(actors, null), [actors]);
  const crewCards = useMemo(() => buildCrewCards(actors, mode), [actors, mode]);
  const progressBoardRows = useMemo(() => buildProgressBoardRows(actors), [actors]);
  const selectedActor = actors.find((actor) => actor.id === resolvedSelectedActorId) ?? null;
  const roleCounts = useMemo(
    () =>
      actors.reduce(
        (counts, actor) => {
          counts[actor.actorType] += 1;
          return counts;
        },
        { lead: 0, subagent: 0, worker: 0 },
      ),
    [actors],
  );
  const focusTarget = useMemo(() => buildFocusTargetViewModel(selectedActor), [selectedActor]);
  const focusDrawerViewModel = useMemo(
    () => buildFocusDrawerViewModel(selectedActor, mode),
    [selectedActor, mode],
  );
  const visibleTimelineEntries = useMemo(
    () => buildTimelineEntries(snapshot, actors, resolvedSelectedActorId),
    [snapshot, actors, resolvedSelectedActorId],
  );

  return (
    <div className="board-shell" data-mode={mode} data-selected-actor-id={resolvedSelectedActorId ?? ''}>
      {socketConnectionIssue ? (
        <div className="pixel-panel" role="status" aria-live="polite">
          {socketConnectionIssue}
        </div>
      ) : null}
      <TopBar
        mode={mode}
        onModeChange={setMode}
        stats={topBarStats}
        overallProgress={overallProgress}
        focusedActor={focusTarget}
      />
      <main className="board-grid board-main">
        <div className="board-center-stack">
          <CrewGrid actors={crewCards} selectedActorId={resolvedSelectedActorId} onFocus={setSelectedActorId} />
          <FocusDrawer viewModel={focusDrawerViewModel} />
        </div>
        <div className="board-side-stack">
          <div className="board-panel-switch" role="group" aria-label="Operations deck tabs">
            {operationsDeckTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`mode-button board-panel-tab${activePanelTab === tab.id ? ' is-active' : ''}`}
                onClick={() => setActivePanelTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {activePanelTab === 'timeline' ? (
            <TimelinePanel
              entries={visibleTimelineEntries}
              focusLabel={focusTarget ? `LOG LOCK · ${focusTarget.name.toUpperCase()}` : 'LOG LOCK · ALL LANES'}
              focusDetail={
                focusTarget
                  ? `${focusTarget.role} · ${focusTarget.status.toUpperCase()} · ${focusTarget.stage.toUpperCase()} · ${focusTarget.progressPercent}% · lead ${roleCounts.lead} · subagent ${roleCounts.subagent} · worker ${roleCounts.worker}`
                  : `Quest-wide event feed · lead ${roleCounts.lead} · subagent ${roleCounts.subagent} · worker ${roleCounts.worker}`
              }
            />
          ) : activePanelTab === 'runTree' ? (
            <RunTree nodes={runTreeNodes} selectedActorId={resolvedSelectedActorId} />
          ) : (
            <ProgressBoardPanel overallProgress={overallProgress} rows={progressBoardRows} />
          )}
        </div>
      </main>
    </div>
  );
};
