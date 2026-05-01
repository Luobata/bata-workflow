import type { MonitorSessionStateLike } from './types';
import { DISCONNECTED_SESSION_CLEANUP_AFTER_MS } from './types';
import { parseTimestampMs } from './snapshot-helpers';
import { writeJsonFileAtomic } from './io';

const shouldCleanupDisconnectedSession = (sessionState: MonitorSessionStateLike | null, nowMs: number): boolean => {
  if (!Number.isFinite(DISCONNECTED_SESSION_CLEANUP_AFTER_MS)) {
    return false;
  }

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
  const nextCleanupAfter = sessionState?.cleanupAfter?.trim()
    || (Number.isFinite(DISCONNECTED_SESSION_CLEANUP_AFTER_MS)
      ? new Date(nowMs + DISCONNECTED_SESSION_CLEANUP_AFTER_MS).toISOString()
      : undefined);
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
    && (sessionState?.cleanupAfter ?? undefined) === nextState.cleanupAfter
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

export {
  shouldCleanupDisconnectedSession,
  persistDisconnectedSessionState,
  persistRecoveredSessionState,
  getSessionRunCutoffMs,
};
