import { resolve } from 'node:path';

import { BoardEventSchema, createBoardEventId, type ActorType } from '../protocol';
import { SessionRegistry, type SessionSnapshot } from './session-registry';
import type {
  CocoAgentEndLike,
  CocoAssistantContentLike,
  CocoDraftBoardEvent,
  CocoEventEnvelopeLike,
  CocoMessageLike,
  CocoSessionCandidate,
  CocoSessionFileLike,
  CocoToolCallState,
  CocoTraceLike,
  MonitorSessionStateLike,
} from './types';
import { COCO_SESSION_STALE_AFTER_MS, DEFAULT_COCO_SESSIONS_ENV } from './types';
import { readJsonFile, readJsonLinesFile, writeMonitorBoardLog } from './io';
import {
  buildLeadActorId,
  toTimestamp,
  parseTimestampMs,
  markSnapshotWaitingForUserInput,
  markSnapshotDisconnected,
} from './snapshot-helpers';

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
  stateRoot: string;
  rootSessionId: string;
  sessionState: MonitorSessionStateLike | null;
  cocoSessionsRoot?: string;
}): Promise<SessionSnapshot | null> => {
  const { stateRoot, rootSessionId, sessionState, cocoSessionsRoot } = params;
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
  const activeAgentIds = new Set<string>();
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
      activeAgentIds.add(actorId);
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
      activeAgentIds.delete(actorId);
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
      status: 'done',
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

  const hasActiveToolCalls = activeToolCalls.size > 0;
  const hasActiveAgents = activeAgentIds.size > 0;
  if (hasActiveToolCalls || hasActiveAgents) {
    await writeMonitorBoardLog(stateRoot, 'coco.snapshot.keep_active_execution', {
      rootSessionId,
      activeToolCallCount: activeToolCalls.size,
      activeAgentCount: activeAgentIds.size,
      cocoSessionId: sessionId,
    });
    return snapshot;
  }

  const latestActivityAtMs = latestActivityMs.length > 0 ? Math.max(...latestActivityMs) : null;

  if (latestActivityAtMs !== null && latestActivityAtMs > Date.now() - COCO_SESSION_STALE_AFTER_MS) {
    const waitingAt = new Date(latestActivityAtMs).toISOString();
    await writeMonitorBoardLog(stateRoot, 'coco.snapshot.waiting_for_user_input', {
      rootSessionId,
      cocoSessionId: sessionId,
      waitingAt,
    });
    return markSnapshotWaitingForUserInput(snapshot, {
      timestamp: waitingAt,
      reason: 'waiting for user input',
    });
  }

  if (latestActivityAtMs !== null && latestActivityAtMs <= Date.now() - COCO_SESSION_STALE_AFTER_MS) {
    const disconnectedAt = new Date(latestActivityAtMs).toISOString();
    await writeMonitorBoardLog(stateRoot, 'coco.snapshot.mark_disconnected', {
      rootSessionId,
      cocoSessionId: sessionId,
      latestActivityAt: disconnectedAt,
      staleAfterMs: COCO_SESSION_STALE_AFTER_MS,
    });
    return markSnapshotDisconnected(snapshot, {
      timestamp: disconnectedAt,
      reason: 'live session disconnected',
    });
  }

  return snapshot;
};

export {
  buildCocoSnapshot,
  resolveCocoSessionsRoot,
};
