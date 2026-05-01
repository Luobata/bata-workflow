import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ActorType, BoardEvent, BoardStatus, Severity } from '../protocol';
import type { ActorNode } from '../runtime-store';
import type { SessionSnapshot } from './session-registry';
import type {
  AssignmentLike,
  MonitorSessionStateLike,
  QueueSnapshotLike,
  RuntimeBoardEventType,
  RuntimeEventLike,
  RunCandidate,
  RuntimeTaskStateLike,
  TaskStoreSnapshotLike,
} from './types';
import { readJsonFile } from './io';
import {
  buildLeadActorId,
  toTimestamp,
  normalizeActiveRootSessionIds,
} from './snapshot-helpers';
import { getSessionRunCutoffMs } from './session-lifecycle';

const mapTaskStatus = (status: string): BoardStatus => {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'in_progress':
      return 'active';
    case 'ready':
    case 'pending':
    default:
      return 'idle';
  }
};

const mapRuntimeEventType = (type: string): RuntimeBoardEventType => {
  switch (type) {
    case 'run-started':
      return 'session.started';
    case 'run-completed':
      return 'session.completed';
    case 'task-generated':
      return 'actor.spawned';
    case 'task-complete':
      return 'actor.completed';
    case 'task-failed':
      return 'actor.failed';
    case 'task-retry':
    case 'task-rerouted':
    case 'task-released':
      return 'actor.status_changed';
    case 'task-claimed':
    case 'task-start':
    case 'batch-start':
      return 'action.started';
    case 'batch-complete':
    case 'run-aborted':
    case 'run-abort-requested':
    case 'run-failed':
    default:
      return 'session.updated';
  }
};

const mapRuntimeEventSeverity = (type: string): Severity => {
  switch (type) {
    case 'task-failed':
    case 'run-failed':
      return 'error';
    case 'task-retry':
    case 'task-rerouted':
    case 'run-abort-requested':
    case 'run-aborted':
      return 'warn';
    default:
      return 'info';
  }
};

const calculateElapsedMs = (taskState: RuntimeTaskStateLike, fallbackTimestamp: string): number => {
  const fallbackEnd = Date.parse(fallbackTimestamp);

  return taskState.attemptHistory.reduce((total, attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    const finishedAt = Date.parse(attempt.finishedAt ?? fallbackTimestamp);

    if (Number.isNaN(startedAt) || Number.isNaN(finishedAt) || finishedAt < startedAt) {
      return total;
    }

    return total + (finishedAt - startedAt);
  }, 0);
};

const deriveLeadStatus = (taskStates: RuntimeTaskStateLike[]): BoardStatus => {
  if (taskStates.some((taskState) => taskState.status === 'failed')) {
    return 'failed';
  }

  if (taskStates.some((taskState) => taskState.status === 'in_progress')) {
    return 'active';
  }

  if (taskStates.some((taskState) => taskState.status === 'blocked')) {
    return 'blocked';
  }

  if (taskStates.length > 0 && taskStates.every((taskState) => taskState.status === 'completed')) {
    return 'done';
  }

  if (taskStates.length > 0) {
    return 'active';
  }

  return 'idle';
};

const buildTaskActorType = (assignment: AssignmentLike): ActorType =>
  assignment.task.generatedFromTaskId ? 'worker' : 'subagent';

const buildTaskCurrentAction = (taskState: RuntimeTaskStateLike, eventDetail: string | null): string =>
  taskState.phaseDetail ?? eventDetail ?? `${taskState.phase.replaceAll('_', ' ')}`;

const buildTaskEventMetadata = (assignment: AssignmentLike, action: string, event: RuntimeEventLike) => ({
  displayName: assignment.task.title,
  currentAction: action,
  timelineLabel: action,
  runtimeEventType: event.type,
  taskId: assignment.task.id,
  role: assignment.task.role,
  taskType: assignment.task.taskType,
  batchId: event.batchId,
});

const buildSnapshotFromRun = (queue: QueueSnapshotLike, taskStore: TaskStoreSnapshotLike): SessionSnapshot | null => {
  const monitor = queue.monitor;
  if (!monitor?.rootSessionId || !monitor.monitorSessionId) {
    return null;
  }

  const rootSessionId = monitor.rootSessionId;
  const monitorSessionId = monitor.monitorSessionId;
  const leadActorId = buildLeadActorId(rootSessionId);
  const assignmentByTaskId = new Map(taskStore.assignments.map((assignment) => [assignment.task.id, assignment]));
  const taskStateByTaskId = new Map(taskStore.taskStates.map((taskState) => [taskState.taskId, taskState]));
  const resultByTaskId = new Map(taskStore.results.map((result) => [result.taskId, result]));
  const latestRuntimeEventByTaskId = new Map<string, RuntimeEventLike>();

  queue.events.forEach((event) => {
    if (event.taskId) {
      latestRuntimeEventByTaskId.set(event.taskId, event);
    }
  });

  const taskActors = queue.taskOrder
    .map((taskId) => {
      const assignment = assignmentByTaskId.get(taskId);
      const taskState = taskStateByTaskId.get(taskId);
      if (!assignment || !taskState) {
        return null;
      }

      const latestEvent = latestRuntimeEventByTaskId.get(taskId) ?? null;
      const currentAction = buildTaskCurrentAction(taskState, latestEvent?.detail ?? null);
      const parentActorId = assignment.task.generatedFromTaskId ?? leadActorId;

      return {
        id: taskId,
        parentActorId,
        actorType: buildTaskActorType(assignment),
        status: mapTaskStatus(taskState.status),
        summary: resultByTaskId.get(taskId)?.summary ?? assignment.task.title,
        model: assignment.executionTarget?.model ?? null,
        toolName: null,
        totalTokens: 0,
        elapsedMs: calculateElapsedMs(taskState, queue.updatedAt),
        children: [] as string[],
        lastEventAt: toTimestamp(taskState.lastUpdatedAt ?? latestEvent?.createdAt, queue.updatedAt),
        lastEventSequence: 0,
        currentAction,
        displayName: assignment.task.title,
      };
    })
    .filter((actor): actor is NonNullable<typeof actor> => actor !== null);

  const actorById = new Map<string, ActorNode & { currentAction?: string; displayName?: string }>();

  taskActors.forEach((actor) => {
    actorById.set(actor.id, actor);
  });

  taskActors.forEach((actor) => {
    const parent = actorById.get(actor.parentActorId ?? '');
    if (parent && !parent.children.includes(actor.id)) {
      parent.children.push(actor.id);
    }
  });

  const leadActor: ActorNode & { currentAction?: string; displayName?: string } = {
    id: leadActorId,
    parentActorId: null,
    actorType: 'lead',
    status: deriveLeadStatus(taskStore.taskStates),
    summary: queue.goal,
    model: null,
    toolName: null,
    totalTokens: 0,
    elapsedMs: Math.max(0, Date.parse(queue.updatedAt) - Date.parse(queue.createdAt)),
    children: taskActors.filter((actor) => actor.parentActorId === leadActorId).map((actor) => actor.id),
    lastEventAt: queue.updatedAt,
    lastEventSequence: 0,
    currentAction: queue.goal,
    displayName: 'Lead Agent',
  };

  actorById.set(leadActorId, leadActor);

  const timeline = queue.events.map((event, index) => {
    const actorId = event.taskId && actorById.has(event.taskId) ? event.taskId : leadActorId;
    const actor = actorById.get(actorId) ?? leadActor;
    const action = event.detail;
    const timestamp = toTimestamp(event.createdAt, queue.updatedAt);

    actor.lastEventAt = timestamp;
    actor.lastEventSequence = index + 1;

    return {
      id: `runtime:${event.type}:${index + 1}`,
      eventType: mapRuntimeEventType(event.type),
      sessionId: rootSessionId,
      rootSessionId,
      monitorSessionId,
      actorId,
      parentActorId: actor.parentActorId,
      actorType: actor.actorType,
      action,
      status: actor.status,
      timestamp,
      sequence: index + 1,
      model: actor.model,
      toolName: null,
      tokenIn: 0,
      tokenOut: 0,
      elapsedMs: actor.elapsedMs,
      costEstimate: 0,
      summary: action,
      metadata:
        actorId === leadActorId
          ? {
              displayName: 'Lead Agent',
              currentAction: queue.goal,
              timelineLabel: action,
              runtimeEventType: event.type,
              batchId: event.batchId,
            }
          : buildTaskEventMetadata(assignmentByTaskId.get(actorId)!, actor.currentAction ?? action, event),
      tags: ['bata-workflow-runtime', event.type],
      severity: mapRuntimeEventSeverity(event.type),
      monitorEnabled: true,
      monitorInherited: false,
      monitorOwnerActorId: leadActorId,
    } satisfies BoardEvent;
  });

  const actors = [leadActor, ...taskActors].map(({ currentAction: _currentAction, displayName: _displayName, ...actor }) => actor);
  const activeCount = actors.filter((actor) => actor.status === 'active').length;
  const blockedCount = actors.filter((actor) => actor.status === 'blocked').length;
  const totalTokens = actors.reduce((sum, actor) => sum + actor.totalTokens, 0);
  const elapsedMs = actors.reduce((max, actor) => Math.max(max, actor.elapsedMs), 0);

  return {
    monitorSessionId,
    stats: {
      actorCount: actors.length,
      activeCount,
      blockedCount,
      totalTokens,
      elapsedMs,
    },
    actorCount: actors.length,
    timelineCount: timeline.length,
    state: {
      actors,
      timeline,
    },
  };
};

const listRunDirectories = async (stateRoot: string): Promise<string[]> => {
  const runsRoot = resolve(stateRoot, 'runs');

  try {
    const entries = await readdir(runsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(runsRoot, entry.name));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const findLatestRunCandidate = async (
  stateRoot: string,
  rootSessionId: string,
  sessionState: MonitorSessionStateLike | null,
): Promise<RunCandidate | null> => {
  const runDirectories = await listRunDirectories(stateRoot);
  const sessionRunCutoffMs = getSessionRunCutoffMs(sessionState);
  const candidates = (
    await Promise.all(
      runDirectories.map(async (runDirectory) => {
        const queue = await readJsonFile<QueueSnapshotLike>(resolve(runDirectory, 'queue.json'));
        if (!queue?.monitor || queue.monitor.rootSessionId !== rootSessionId) {
          return null;
        }

        const expectedMonitorSessionId = sessionState?.monitorSessionId?.trim();
        if (expectedMonitorSessionId && queue.monitor.monitorSessionId?.trim() !== expectedMonitorSessionId) {
          return null;
        }

        if (sessionRunCutoffMs != null) {
          const queueUpdatedAtMs = Date.parse(queue.updatedAt);
          if (Number.isNaN(queueUpdatedAtMs) || queueUpdatedAtMs < sessionRunCutoffMs) {
            return null;
          }
        }

        return {
          runDirectory,
          queue,
        } satisfies RunCandidate;
      }),
    )
  ).filter((candidate): candidate is RunCandidate => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) => Date.parse(right.queue.updatedAt) - Date.parse(left.queue.updatedAt))[0] ?? null;
};

export {
  buildSnapshotFromRun,
  findLatestRunCandidate,
};
