import { resolve } from 'node:path';
import { readdir, rm } from 'node:fs/promises';

import type { SessionSnapshot } from './session-registry';
import type {
  BuildBataWorkflowSnapshotsOptions,
  CocoSessionFileLike,
  MonitorBoardRuntimeStateLike,
  MonitorSessionStateLike,
  TaskStoreSnapshotLike,
} from './types';
import { MONITOR_BOARD_RUNTIME_STATE_DIR_PATH, MONITOR_SESSION_DIRECTORY_PATH } from './types';
import { readJsonFile, writeJsonFileAtomic, writeMonitorBoardLog } from './io';
import {
  normalizeActiveRootSessionIds,
  isDisconnectedSnapshot,
  getSnapshotDisconnectedTimestamp,
  buildShellSnapshot,
} from './snapshot-helpers';
import {
  shouldCleanupDisconnectedSession,
  persistDisconnectedSessionState,
  persistRecoveredSessionState,
} from './session-lifecycle';
import { buildCocoSnapshot, resolveCocoSessionsRoot } from './coco-snapshot';
import { buildSnapshotFromRun, findLatestRunCandidate } from './runtime-snapshot';

export const buildBataWorkflowSnapshots = async (
  stateRoot: string,
  options: BuildBataWorkflowSnapshotsOptions = {},
): Promise<SessionSnapshot[]> => {
  // Read all runtime-*.json files and the legacy runtime.json to aggregate
  // activeRootSessionIds across per-session runtime state files.
  const runtimeStateDir = resolve(stateRoot, ...MONITOR_BOARD_RUNTIME_STATE_DIR_PATH);
  let runtimeFiles: string[] = [];
  try {
    const entries = await readdir(runtimeStateDir);
    runtimeFiles = entries.filter((name) => (name.startsWith('runtime-') || name === 'runtime.json') && name.endsWith('.json'));
  } catch {
    // Directory may not exist yet — no runtime state to read.
  }

  type RuntimeFileEntry = { path: string; state: MonitorBoardRuntimeStateLike };
  const runtimeEntries: RuntimeFileEntry[] = [];
  const allActiveRootSessionIds: string[] = [];

  for (const fileName of runtimeFiles) {
    const filePath = resolve(runtimeStateDir, fileName);
    const fileState = await readJsonFile<MonitorBoardRuntimeStateLike>(filePath);
    if (fileState) {
      runtimeEntries.push({ path: filePath, state: fileState });
      const ids = normalizeActiveRootSessionIds(fileState.activeRootSessionIds);
      allActiveRootSessionIds.push(...ids);
    }
  }

  const activeRootSessionIds = [...new Set(allActiveRootSessionIds)];
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
          stateRoot,
          rootSessionId,
          sessionState,
          cocoSessionsRoot: options.cocoSessionsRoot,
        });
        if (preferredCocoSnapshot) {
          if (isDisconnectedSnapshot(preferredCocoSnapshot)) {
            if (shouldCleanupDisconnectedSession(sessionState, nowMs)) {
              await writeMonitorBoardLog(stateRoot, 'lease.release_disconnected_session', {
                rootSessionId,
                reason: 'bound_coco_snapshot_disconnected_cleanup_after',
              });
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
            await writeMonitorBoardLog(stateRoot, 'lease.release_disconnected_session', {
              rootSessionId,
              reason: 'bound_coco_session_missing_cleanup_after',
            });
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
            await writeMonitorBoardLog(stateRoot, 'lease.release_disconnected_session', {
              rootSessionId,
              reason: 'bound_coco_session_shell_cleanup_after',
            });
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
        await writeMonitorBoardLog(stateRoot, 'lease.release_disconnected_session', {
          rootSessionId,
          reason: 'run_snapshot_cleanup_after',
        });
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

  if (releasedRootSessionIds.length > 0) {
    await writeMonitorBoardLog(stateRoot, 'lease.release_runtime_state', {
      releasedRootSessionIds,
      before: activeRootSessionIds,
      after: activeRootSessionIds.filter((rootSessionId) => !releasedRootSessionIds.includes(rootSessionId)),
    });

    // Update each runtime file to remove released rootSessionIds.
    for (const entry of runtimeEntries) {
      const fileActiveIds = normalizeActiveRootSessionIds(entry.state.activeRootSessionIds);
      const remainingIds = fileActiveIds.filter((id) => !releasedRootSessionIds.includes(id));
      if (remainingIds.length !== fileActiveIds.length) {
        await writeJsonFileAtomic(entry.path, {
          ...entry.state,
          activeRootSessionIds: remainingIds,
        });
      }
    }
  }

  return snapshotResults
    .map((result) => result.snapshot)
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
};

// Re-export from sibling modules to preserve the gateway barrel
export * from './session-registry';
export * from './server';
