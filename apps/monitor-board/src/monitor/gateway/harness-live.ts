import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { BoardEventSchema, createBoardEventId, type ActorType, type BoardEvent, type BoardStatus, type Severity } from '../protocol';
import type { ActorNode } from '../runtime-store';

import { SessionRegistry, type SessionSnapshot } from './session-registry';

type RuntimeBoardEventType = Exclude<BoardEvent['eventType'], 'tool.called' | 'tool.finished'>;

type RuntimeEventLike = {
  type: string;
  createdAt?: string;
  taskId?: string;
  batchId: string;
  detail: string;
};

type QueueMonitorMetadata = {
  rootSessionId: string;
  monitorSessionId: string;
  workspaceRoot?: string;
};

type QueueSnapshotLike = {
  goal: string;
  createdAt: string;
  updatedAt: string;
  taskOrder: string[];
  events: RuntimeEventLike[];
  monitor?: QueueMonitorMetadata | null;
};

type RuntimeTaskStateLike = {
  taskId: string;
  status: string;
  phase: string;
  phaseDetail: string | null;
  claimedBy: string | null;
  attempts: number;
  lastError: string | null;
  lastClaimedAt: string | null;
  releasedAt: string | null;
  lastUpdatedAt: string | null;
  attemptHistory: Array<{
    startedAt: string;
    finishedAt: string | null;
  }>;
};

type AssignmentLike = {
  task: {
    id: string;
    title: string;
    role: string;
    taskType: string;
    generatedFromTaskId?: string | null;
  };
  executionTarget?: {
    model?: string | null;
  };
};

type ResultLike = {
  taskId: string;
  summary: string;
};

type TaskStoreSnapshotLike = {
  assignments: AssignmentLike[];
  taskStates: RuntimeTaskStateLike[];
  results: ResultLike[];
};

type MonitorBoardRuntimeStateLike = {
  activeRootSessionIds?: unknown;
};

type MonitorSessionStateLike = {
  rootSessionId?: string;
  monitorSessionId?: string;
  ownerActorId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  workspaceRoot?: string;
  cocoSessionId?: string;
  disconnectedAt?: string;
  cleanupAfter?: string;
};

type CocoSessionMetadataLike = {
  cwd?: string;
  model_name?: string;
  title?: string;
};

type CocoSessionFileLike = {
  id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: CocoSessionMetadataLike;
};

type CocoMessageLike = {
  role?: string;
  content?: string;
  extra?: {
    is_original_user_input?: boolean;
    is_additional_context_input?: boolean;
  };
};

type CocoAgentStartLike = {
  input?: CocoMessageLike[];
};

type CocoAssistantContentLike = {
  type?: string;
  text?: string;
};

type CocoAgentEndLike = {
  output?: {
    role?: string;
    content?: string;
    assistant_output_multi_content?: CocoAssistantContentLike[];
  };
};

type CocoToolCallLike = {
  tool_call_id?: string;
  tool_info?: {
    name?: string;
  };
};

type CocoToolCallOutputLike = {
  tool_call_id?: string;
};

type CocoEventEnvelopeLike = {
  session_id?: string;
  agent_id?: string;
  agent_name?: string;
  parent_tool_call_id?: string;
  created_at?: string;
  agent_start?: CocoAgentStartLike;
  agent_end?: CocoAgentEndLike;
  tool_call?: CocoToolCallLike;
  tool_call_output?: CocoToolCallOutputLike;
};

type CocoTraceTagLike = {
  key?: string;
  value?: string | number | boolean;
};

type CocoTraceLike = {
  startTime?: number;
  duration?: number;
  tags?: CocoTraceTagLike[];
};

type CocoSessionCandidate = {
  sessionDirectory: string;
  session: CocoSessionFileLike;
};

type CocoToolCallState = {
  actorId: string;
  parentActorId: string | null;
  actorType: ActorType;
  toolName: string;
  startedAt: string;
};

type CocoDraftBoardEvent = Omit<BoardEvent, 'id' | 'sequence'> & {
  sortOrder: number;
};

const COCO_SESSION_STALE_AFTER_MS = (() => {
  const parsed = Number.parseInt(process.env.COCO_SESSION_STALE_AFTER_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60_000;
})();
const DISCONNECTED_SESSION_CLEANUP_AFTER_MS = 60_000;

type RunCandidate = {
  runDirectory: string;
  queue: QueueSnapshotLike;
};

type BuildHarnessSnapshotsOptions = {
  cocoSessionsRoot?: string;
};

const LEAD_ACTOR_PREFIX = 'lead';
const MONITOR_BOARD_RUNTIME_STATE_PATH = ['monitor-board', 'runtime.json'] as const;
const MONITOR_SESSION_DIRECTORY_PATH = ['monitor-sessions'] as const;
const DEFAULT_COCO_SESSIONS_ENV = 'COCO_SESSIONS_ROOT';

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
};

const writeJsonFileAtomic = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(resolve(filePath, '..'), { recursive: true });
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempFilePath, filePath);
};

const readJsonLinesFile = async <T>(filePath: string): Promise<T[]> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const normalizeActiveRootSessionIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
};

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

const buildLeadActorId = (rootSessionId: string) => `${LEAD_ACTOR_PREFIX}:${rootSessionId}`;

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

const shouldCleanupDisconnectedSession = (sessionState: MonitorSessionStateLike | null, nowMs: number): boolean => {
  if (sessionState?.status !== 'disconnected') {
    return false;
  }

  const cleanupAfterMs = parseTimestampMs(sessionState.cleanupAfter);
  return cleanupAfterMs !== null && cleanupAfterMs <= nowMs;
};

const persistDisconnectedSessionState = async (params: {
  sessionStatePath: string;
  sessionState: MonitorSessionStateLike | null;
  rootSessionId: string;
  disconnectedAt: string;
  nowMs: number;
}): Promise<MonitorSessionStateLike> => {
  const { sessionStatePath, sessionState, rootSessionId, disconnectedAt, nowMs } = params;
  const nextDisconnectedAt = sessionState?.disconnectedAt?.trim() || disconnectedAt;
  const nextCleanupAfter = sessionState?.cleanupAfter?.trim() || new Date(nowMs + DISCONNECTED_SESSION_CLEANUP_AFTER_MS).toISOString();
  const nextState: MonitorSessionStateLike = {
    ...sessionState,
    rootSessionId: sessionState?.rootSessionId ?? rootSessionId,
    monitorSessionId: sessionState?.monitorSessionId ?? `monitor:${rootSessionId}`,
    ownerActorId: sessionState?.ownerActorId ?? 'lead',
    status: 'disconnected',
    createdAt: sessionState?.createdAt ?? nextDisconnectedAt,
    updatedAt: nextDisconnectedAt,
    disconnectedAt: nextDisconnectedAt,
    cleanupAfter: nextCleanupAfter,
  };

  if (
    sessionState?.status === nextState.status
    && sessionState?.updatedAt === nextState.updatedAt
    && sessionState?.disconnectedAt === nextState.disconnectedAt
    && sessionState?.cleanupAfter === nextState.cleanupAfter
  ) {
    return nextState;
  }

  await writeJsonFileAtomic(sessionStatePath, nextState);
  return nextState;
};

const persistRecoveredSessionState = async (params: {
  sessionStatePath: string;
  sessionState: MonitorSessionStateLike;
  nowMs: number;
}): Promise<MonitorSessionStateLike> => {
  const { sessionStatePath, sessionState, nowMs } = params;
  const { disconnectedAt: _disconnectedAt, cleanupAfter: _cleanupAfter, ...rest } = sessionState;
  const nextState: MonitorSessionStateLike = {
    ...rest,
    status: 'active',
    updatedAt: new Date(nowMs).toISOString(),
  };

  await writeJsonFileAtomic(sessionStatePath, nextState);
  return nextState;
};

const getSessionRunCutoffMs = (sessionState: MonitorSessionStateLike | null): number | null => {
  const candidate = sessionState?.updatedAt ?? sessionState?.createdAt;
  if (!candidate) {
    return null;
  }

  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? null : parsed;
};

const cleanUserFacingText = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const cleaned = value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : null;
};

const summarizeText = (value: string | null, maxLength = 120): string | null => {
  if (!value) {
    return null;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
};

const extractPromptSummary = (messages: CocoMessageLike[] | undefined): string | null => {
  if (!Array.isArray(messages)) {
    return null;
  }

  const preferred = messages.find(
    (message) => message.role === 'user' && message.extra?.is_original_user_input && cleanUserFacingText(message.content),
  );
  if (preferred) {
    return summarizeText(cleanUserFacingText(preferred.content));
  }

  const fallback = messages.find(
    (message) => message.role === 'user' && !message.extra?.is_additional_context_input && cleanUserFacingText(message.content),
  );
  return summarizeText(cleanUserFacingText(fallback?.content));
};

const extractAgentEndSummary = (agentEnd: CocoAgentEndLike | undefined): string | null => {
  const content = summarizeText(cleanUserFacingText(agentEnd?.output?.content));
  if (content) {
    return content;
  }

  const textItem = agentEnd?.output?.assistant_output_multi_content?.find(
    (item) => item.type === 'text' && cleanUserFacingText(item.text),
  );
  return summarizeText(cleanUserFacingText(textItem?.text));
};

const getTraceTagString = (trace: CocoTraceLike, key: string): string | null => {
  const tag = trace.tags?.find((entry) => entry.key === key)?.value;
  return typeof tag === 'string' && tag.trim().length > 0 ? tag : null;
};

const getTraceTagNumber = (trace: CocoTraceLike, key: string): number | null => {
  const tag = trace.tags?.find((entry) => entry.key === key)?.value;
  return typeof tag === 'number' && Number.isFinite(tag) ? tag : null;
};

const buildResponseTimelineSummary = (tokenIn: number, tokenOut: number): string => {
  const tokenParts = [tokenIn > 0 ? `${tokenIn} in` : null, tokenOut > 0 ? `${tokenOut} out` : null].filter(
    (part): part is string => part !== null,
  );

  return tokenParts.length > 0 ? `completed response · ${tokenParts.join(' · ')}` : 'completed response';
};

const toIsoFromMicroseconds = (value: number | undefined, fallback: string): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return new Date(Math.floor(value / 1000)).toISOString();
};

const resolveCocoSessionsRoot = (override: string | undefined): string | null => {
  if (override?.trim()) {
    return resolve(override);
  }

  const envValue = process.env[DEFAULT_COCO_SESSIONS_ENV]?.trim();
  if (envValue) {
    return resolve(envValue);
  }

  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE;
  if (!homeDirectory) {
    return null;
  }

  return process.platform === 'darwin'
    ? resolve(homeDirectory, 'Library', 'Caches', 'coco', 'sessions')
    : resolve(homeDirectory, '.cache', 'coco', 'sessions');
};

const findLatestCocoSessionCandidate = async (params: {
  cocoSessionsRoot: string | null;
  sessionState: MonitorSessionStateLike | null;
}): Promise<CocoSessionCandidate | null> => {
  const { cocoSessionsRoot, sessionState } = params;
  if (!cocoSessionsRoot) {
    return null;
  }

  const preferredSessionId = sessionState?.cocoSessionId?.trim();
  if (!preferredSessionId) {
    return null;
  }

  const preferredSession = await readJsonFile<CocoSessionFileLike>(resolve(cocoSessionsRoot, preferredSessionId, 'session.json'));
  if (!preferredSession) {
    return null;
  }

  return {
    sessionDirectory: resolve(cocoSessionsRoot, preferredSessionId),
    session: preferredSession,
  };
};

const buildCocoSnapshot = async (params: {
  rootSessionId: string;
  sessionState: MonitorSessionStateLike | null;
  cocoSessionsRoot?: string;
}): Promise<SessionSnapshot | null> => {
  const { rootSessionId, sessionState, cocoSessionsRoot } = params;
  const candidate = await findLatestCocoSessionCandidate({
    cocoSessionsRoot: resolveCocoSessionsRoot(cocoSessionsRoot),
    sessionState,
  });

  if (!candidate) {
    return null;
  }

  const cocoEvents = await readJsonLinesFile<CocoEventEnvelopeLike>(resolve(candidate.sessionDirectory, 'events.jsonl'));
  const cocoTraces = await readJsonLinesFile<CocoTraceLike>(resolve(candidate.sessionDirectory, 'traces.jsonl'));
  if (cocoEvents.length === 0 && cocoTraces.length === 0) {
    return null;
  }

  const monitorSessionId = sessionState?.monitorSessionId || `monitor:${rootSessionId}`;
  const leadActorId = buildLeadActorId(rootSessionId);
  const sessionId = candidate.session.id || rootSessionId;
  const defaultModel = candidate.session.metadata?.model_name ?? null;
  const defaultSessionSummary = candidate.session.metadata?.title?.trim() || 'coco live session';
  const fallbackTimestamp = toTimestamp(candidate.session.updated_at ?? candidate.session.created_at, new Date().toISOString());
  const actorNameById = new Map<string, string>([[leadActorId, 'TraeCli']]);
  const actorParentById = new Map<string, string | null>([[leadActorId, null]]);
  const actorTypeById = new Map<string, ActorType>([[leadActorId, 'lead']]);
  const rawAgentToBoardActor = new Map<string, string>();
  const boardActorInitialized = new Set<string>();
  const activeToolCalls = new Map<string, CocoToolCallState>();
  let sortOrder = 0;

  const nextSortOrder = () => {
    sortOrder += 1;
    return sortOrder;
  };

  const createMetadata = (params: {
    actorId: string;
    action: string;
    timelineLabel?: string;
    rawKind: string;
  }) => ({
    source: 'coco',
    rawKind: params.rawKind,
    displayName: actorNameById.get(params.actorId) ?? 'TraeCli',
    currentAction: params.action,
    timelineLabel: params.timelineLabel ?? params.action,
  });

  const resolveBoardActorId = (rawAgentId: string, parentToolCallId: string | undefined, agentName: string | undefined) => {
    const existing = rawAgentToBoardActor.get(rawAgentId);
    if (existing) {
      if (agentName?.trim()) {
        actorNameById.set(existing, agentName.trim());
      }
      return existing;
    }

    const parentActorId = parentToolCallId ? (activeToolCalls.get(parentToolCallId)?.actorId ?? leadActorId) : null;
    const boardActorId = parentActorId === null ? leadActorId : rawAgentId;

    rawAgentToBoardActor.set(rawAgentId, boardActorId);
    actorParentById.set(boardActorId, parentActorId);
    actorTypeById.set(boardActorId, parentActorId === null ? 'lead' : 'subagent');
    if (agentName?.trim()) {
      actorNameById.set(boardActorId, agentName.trim());
    }

    return boardActorId;
  };

  const drafts: CocoDraftBoardEvent[] = [];
  const pushDraft = (draft: Omit<CocoDraftBoardEvent, 'sortOrder'>) => {
    drafts.push({
      ...draft,
      sortOrder: nextSortOrder(),
    });
  };

  const sortedCocoEvents = [...cocoEvents].sort((left, right) => {
    const leftTime = Date.parse(left.created_at ?? '');
    const rightTime = Date.parse(right.created_at ?? '');
    return leftTime - rightTime;
  });

  sortedCocoEvents.forEach((event) => {
    const rawAgentId = event.agent_id?.trim();
    if (!rawAgentId) {
      return;
    }

    const timestamp = toTimestamp(event.created_at, fallbackTimestamp);
    const actorId = resolveBoardActorId(rawAgentId, event.parent_tool_call_id, event.agent_name);
    const actorType = actorTypeById.get(actorId) ?? 'lead';
    const parentActorId = actorParentById.get(actorId) ?? null;

    if (event.agent_start) {
      const action = extractPromptSummary(event.agent_start.input) ?? `${actorNameById.get(actorId) ?? event.agent_name ?? 'Agent'} active`;
      if (actorId === leadActorId) {
        pushDraft({
          sessionId,
          rootSessionId,
          monitorSessionId,
          actorId,
          parentActorId: null,
          actorType: 'lead',
          eventType: 'action.started',
          action,
          status: 'active',
          timestamp,
          model: defaultModel,
          toolName: null,
          tokenIn: 0,
          tokenOut: 0,
          elapsedMs: 0,
          costEstimate: 0,
          summary: action,
          metadata: createMetadata({ actorId, action, rawKind: 'agent_start' }),
          tags: ['coco-live', 'agent-start'],
          severity: 'info',
          monitorEnabled: true,
          monitorInherited: false,
          monitorOwnerActorId: leadActorId,
        });
      } else if (!boardActorInitialized.has(actorId)) {
        boardActorInitialized.add(actorId);
        pushDraft({
          sessionId,
          rootSessionId,
          monitorSessionId,
          actorId,
          parentActorId,
          actorType,
          eventType: 'actor.spawned',
          action,
          status: 'active',
          timestamp,
          model: defaultModel,
          toolName: null,
          tokenIn: 0,
          tokenOut: 0,
          elapsedMs: 0,
          costEstimate: 0,
          summary: action,
          metadata: createMetadata({ actorId, action, rawKind: 'agent_start' }),
          tags: ['coco-live', 'agent-start'],
          severity: 'info',
          monitorEnabled: true,
          monitorInherited: true,
          monitorOwnerActorId: leadActorId,
        });
      }
    }

    if (event.tool_call?.tool_call_id && event.tool_call.tool_info?.name) {
      const toolName = event.tool_call.tool_info.name;
      activeToolCalls.set(event.tool_call.tool_call_id, {
        actorId,
        parentActorId,
        actorType,
        toolName,
        startedAt: timestamp,
      });

      const action = `running ${toolName}`;
      pushDraft({
        sessionId,
        rootSessionId,
        monitorSessionId,
        actorId,
        parentActorId,
        actorType,
        eventType: 'tool.called',
        action,
        status: 'active',
        timestamp,
        model: defaultModel,
        toolName,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 0,
        costEstimate: 0,
        summary: `${actorNameById.get(actorId) ?? 'Agent'} started ${toolName}`,
        metadata: createMetadata({ actorId, action, timelineLabel: `started ${toolName}`, rawKind: 'tool_call' }),
        tags: ['coco-live', 'tool-call'],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: actorId !== leadActorId,
        monitorOwnerActorId: leadActorId,
      });
    }

    if (event.tool_call_output?.tool_call_id) {
      const toolCall = activeToolCalls.get(event.tool_call_output.tool_call_id);
      if (!toolCall) {
        return;
      }

      const elapsedMs = Math.max(0, Date.parse(timestamp) - Date.parse(toolCall.startedAt));
      const action = `completed ${toolCall.toolName}`;
      pushDraft({
        sessionId,
        rootSessionId,
        monitorSessionId,
        actorId: toolCall.actorId,
        parentActorId: toolCall.parentActorId,
        actorType: toolCall.actorType,
        eventType: 'tool.finished',
        action,
        status: 'done',
        timestamp,
        model: defaultModel,
        toolName: toolCall.toolName,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs,
        costEstimate: 0,
        summary: `${actorNameById.get(toolCall.actorId) ?? 'Agent'} completed ${toolCall.toolName}`,
        metadata: createMetadata({ actorId: toolCall.actorId, action, timelineLabel: `completed ${toolCall.toolName}`, rawKind: 'tool_call_output' }),
        tags: ['coco-live', 'tool-result'],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: toolCall.actorId !== leadActorId,
        monitorOwnerActorId: leadActorId,
      });
      activeToolCalls.delete(event.tool_call_output.tool_call_id);
    }

    if (event.agent_end) {
      const summary = extractAgentEndSummary(event.agent_end) ?? `${actorNameById.get(actorId) ?? 'Agent'} completed`;
      pushDraft({
        sessionId,
        rootSessionId,
        monitorSessionId,
        actorId,
        parentActorId,
        actorType,
        eventType: 'actor.completed',
        action: summary,
        status: 'done',
        timestamp,
        model: defaultModel,
        toolName: null,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 0,
        costEstimate: 0,
        summary,
        metadata: createMetadata({ actorId, action: summary, rawKind: 'agent_end' }),
        tags: ['coco-live', 'agent-end'],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: actorId !== leadActorId,
        monitorOwnerActorId: leadActorId,
      });
    }
  });

  const leadDisplayName = actorNameById.get(leadActorId) ?? 'TraeCli';
  pushDraft({
    sessionId,
    rootSessionId,
    monitorSessionId,
    actorId: leadActorId,
    parentActorId: null,
    actorType: 'lead',
    eventType: 'session.started',
    action: defaultSessionSummary,
    status: 'active',
    timestamp: toTimestamp(candidate.session.created_at ?? candidate.session.updated_at, fallbackTimestamp),
    model: defaultModel,
    toolName: null,
    tokenIn: 0,
    tokenOut: 0,
    elapsedMs: 0,
    costEstimate: 0,
    summary: defaultSessionSummary,
    metadata: {
      source: 'coco',
      rawKind: 'session.started',
      displayName: leadDisplayName,
      currentAction: defaultSessionSummary,
      timelineLabel: defaultSessionSummary,
    },
    tags: ['coco-live', 'session-started'],
    severity: 'info',
    monitorEnabled: true,
    monitorInherited: false,
    monitorOwnerActorId: leadActorId,
  });

  cocoTraces.forEach((trace) => {
    if (getTraceTagString(trace, 'span.category') !== 'model.call') {
      return;
    }

    const rawAgentId = getTraceTagString(trace, 'agent.id');
    if (!rawAgentId) {
      return;
    }

    const actorId = resolveBoardActorId(rawAgentId, undefined, getTraceTagString(trace, 'agent.name') ?? undefined);
    const actorType = actorTypeById.get(actorId) ?? 'lead';
    const parentActorId = actorParentById.get(actorId) ?? null;
    const modelName = getTraceTagString(trace, 'model.name') ?? defaultModel;
    const tokenIn = Math.max(0, getTraceTagNumber(trace, 'usage.input_tokens') ?? 0);
    const tokenOut = Math.max(0, getTraceTagNumber(trace, 'usage.output_tokens') ?? 0);
    const elapsedMs = Math.max(0, Math.round((trace.duration ?? 0) / 1000));
    const startTime = typeof trace.startTime === 'number' ? trace.startTime : undefined;
    const endTimestamp = toIsoFromMicroseconds(
      typeof startTime === 'number' ? startTime + (trace.duration ?? 0) : undefined,
      fallbackTimestamp,
    );
    const action = 'completed response';
    const timelineSummary = buildResponseTimelineSummary(tokenIn, tokenOut);
    const actorDisplayName = actorNameById.get(actorId) ?? 'Agent';

    pushDraft({
      sessionId,
      rootSessionId,
      monitorSessionId,
      actorId,
      parentActorId,
      actorType,
      eventType: 'action.summary',
      action,
      status: 'active',
      timestamp: endTimestamp,
      model: modelName,
      toolName: null,
      tokenIn,
      tokenOut,
      elapsedMs,
      costEstimate: 0,
      summary: `${actorDisplayName} ${timelineSummary}`,
      metadata: {
        ...createMetadata({ actorId, action, timelineLabel: 'completed response', rawKind: 'model.call' }),
        timelineSummary,
        modelName,
      },
      tags: ['coco-live', 'model-call'],
      severity: 'info',
      monitorEnabled: true,
      monitorInherited: actorId !== leadActorId,
      monitorOwnerActorId: leadActorId,
    });
  });

  const registry = new SessionRegistry();
  const snapshot = drafts
    .sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      if (leftTime === rightTime) {
        return left.sortOrder - right.sortOrder;
      }
      return leftTime - rightTime;
    })
    .map((draft, index) =>
      BoardEventSchema.parse({
        ...draft,
        id: createBoardEventId(draft.eventType, draft.actorId, index + 1),
        sequence: index + 1,
      }),
    )
    .reduce<SessionSnapshot | null>((currentSnapshot, event) => registry.append(event), null);

  if (!snapshot) {
    return null;
  }

  const latestActivityMs = [
    parseTimestampMs(candidate.session.updated_at),
    parseTimestampMs(candidate.session.created_at),
    ...cocoEvents.map((event) => parseTimestampMs(event.created_at)),
    ...cocoTraces.map((trace) => {
      if (typeof trace.startTime !== 'number') {
        return null;
      }

      const duration = typeof trace.duration === 'number' ? Math.max(0, trace.duration) : 0;
      return Math.floor((trace.startTime + duration) / 1000);
    }),
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (latestActivityMs.length > 0 && Math.max(...latestActivityMs) <= Date.now() - COCO_SESSION_STALE_AFTER_MS) {
    const disconnectedAt = new Date(Math.max(...latestActivityMs)).toISOString();
    return markSnapshotDisconnected(snapshot, {
      timestamp: disconnectedAt,
      reason: 'live session disconnected',
    });
  }

  return snapshot;
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
          tags: disconnected ? ['harness-runtime', 'session-shell', 'session-disconnected'] : ['harness-runtime', 'session-shell'],
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
    tags: ['harness-runtime', 'session-disconnected'],
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
      tags: ['harness-runtime', event.type],
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

export const buildHarnessSnapshots = async (
  stateRoot: string,
  options: BuildHarnessSnapshotsOptions = {},
): Promise<SessionSnapshot[]> => {
  const runtimeState = await readJsonFile<MonitorBoardRuntimeStateLike>(resolve(stateRoot, ...MONITOR_BOARD_RUNTIME_STATE_PATH));
  const activeRootSessionIds = normalizeActiveRootSessionIds(runtimeState?.activeRootSessionIds);
  const nowMs = Date.now();

  const snapshotResults = await Promise.all(
    activeRootSessionIds.map(async (rootSessionId) => {
      const sessionStatePath = resolve(stateRoot, ...MONITOR_SESSION_DIRECTORY_PATH, `${encodeURIComponent(rootSessionId)}.json`);
      const sessionState = await readJsonFile<MonitorSessionStateLike>(
        sessionStatePath,
      );

      const boundCocoSessionId = sessionState?.cocoSessionId?.trim();
      if (boundCocoSessionId) {
        const preferredCocoSnapshot = await buildCocoSnapshot({
          rootSessionId,
          sessionState,
          cocoSessionsRoot: options.cocoSessionsRoot,
        });
        if (preferredCocoSnapshot) {
          if (isDisconnectedSnapshot(preferredCocoSnapshot)) {
            if (shouldCleanupDisconnectedSession(sessionState, nowMs)) {
              await rm(sessionStatePath, { force: true });
              return { rootSessionId, snapshot: null, releaseLease: true };
            }

            await persistDisconnectedSessionState({
              sessionStatePath,
              sessionState,
              rootSessionId,
              disconnectedAt: getSnapshotDisconnectedTimestamp(preferredCocoSnapshot),
              nowMs,
            });
          } else if (sessionState?.status === 'disconnected') {
            await persistRecoveredSessionState({ sessionStatePath, sessionState, nowMs });
          }

          return { rootSessionId, snapshot: preferredCocoSnapshot, releaseLease: false };
        }

        const cocoSessionsRoot = resolveCocoSessionsRoot(options.cocoSessionsRoot);
        const boundSession = cocoSessionsRoot
          ? await readJsonFile<CocoSessionFileLike>(resolve(cocoSessionsRoot, boundCocoSessionId, 'session.json'))
          : null;

        if (!boundSession) {
          if (shouldCleanupDisconnectedSession(sessionState, nowMs)) {
            await rm(sessionStatePath, { force: true });
            return { rootSessionId, snapshot: null, releaseLease: true };
          }

          const disconnectedState = await persistDisconnectedSessionState({
            sessionStatePath,
            sessionState,
            rootSessionId,
            disconnectedAt: new Date(nowMs).toISOString(),
            nowMs,
          });

          return {
            rootSessionId,
            snapshot: buildShellSnapshot({ rootSessionId, sessionState: disconnectedState, disconnected: true }),
            releaseLease: false,
          };
        }

        if (sessionState?.status === 'disconnected') {
          if (shouldCleanupDisconnectedSession(sessionState, nowMs)) {
            await rm(sessionStatePath, { force: true });
            return { rootSessionId, snapshot: null, releaseLease: true };
          }

          return {
            rootSessionId,
            snapshot: buildShellSnapshot({ rootSessionId, sessionState, disconnected: true }),
            releaseLease: false,
          };
        }

        return {
          rootSessionId,
          snapshot: buildShellSnapshot({ rootSessionId, sessionState }),
          releaseLease: false,
        };
      }

      if (shouldCleanupDisconnectedSession(sessionState, nowMs)) {
        await rm(sessionStatePath, { force: true });
        return { rootSessionId, snapshot: null, releaseLease: true };
      }

      const runCandidate = await findLatestRunCandidate(stateRoot, rootSessionId, sessionState);
      if (!runCandidate) {
        return { rootSessionId, snapshot: buildShellSnapshot({ rootSessionId, sessionState }), releaseLease: false };
      }

      const taskStore = await readJsonFile<TaskStoreSnapshotLike>(resolve(runCandidate.runDirectory, 'task-store.json'));
      if (!taskStore) {
        return { rootSessionId, snapshot: buildShellSnapshot({ rootSessionId, sessionState }), releaseLease: false };
      }

      return { rootSessionId, snapshot: buildSnapshotFromRun(runCandidate.queue, taskStore), releaseLease: false };
    }),
  );

  const releasedRootSessionIds = snapshotResults
    .filter((result) => result.releaseLease)
    .map((result) => result.rootSessionId);

  if (releasedRootSessionIds.length > 0 && runtimeState) {
    await writeJsonFileAtomic(resolve(stateRoot, ...MONITOR_BOARD_RUNTIME_STATE_PATH), {
      ...runtimeState,
      activeRootSessionIds: activeRootSessionIds.filter((rootSessionId) => !releasedRootSessionIds.includes(rootSessionId)),
    });
  }

  return snapshotResults
    .map((result) => result.snapshot)
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
};
