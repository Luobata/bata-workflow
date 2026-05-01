import type { ActorType, BoardEvent, BoardStatus, Severity } from '../protocol';
import type { SessionSnapshot } from './session-registry';

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
const DISCONNECTED_SESSION_CLEANUP_AFTER_MS = (() => {
  const parsed = Number.parseInt(process.env.MONITOR_DISCONNECTED_SESSION_CLEANUP_AFTER_MS ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return 300_000; // 5 minutes — clean up orphaned sessions to prevent port accumulation
})();

type RunCandidate = {
  runDirectory: string;
  queue: QueueSnapshotLike;
};

type BuildBataWorkflowSnapshotsOptions = {
  cocoSessionsRoot?: string;
};

const LEAD_ACTOR_PREFIX = 'lead';
const MONITOR_BOARD_RUNTIME_STATE_DIR_PATH = ['monitor-board'] as const;
const MONITOR_BOARD_RUNTIME_STATE_PATH = ['monitor-board', 'runtime.json'] as const;
const MONITOR_SESSION_DIRECTORY_PATH = ['monitor-sessions'] as const;
const DEFAULT_COCO_SESSIONS_ENV = 'COCO_SESSIONS_ROOT';
const MONITOR_BOARD_LOG_FILE_NAME = 'monitor-board.log';

export type {
  RuntimeBoardEventType,
  RuntimeEventLike,
  QueueMonitorMetadata,
  QueueSnapshotLike,
  RuntimeTaskStateLike,
  AssignmentLike,
  ResultLike,
  TaskStoreSnapshotLike,
  MonitorBoardRuntimeStateLike,
  MonitorSessionStateLike,
  CocoSessionMetadataLike,
  CocoSessionFileLike,
  CocoMessageLike,
  CocoAgentStartLike,
  CocoAssistantContentLike,
  CocoAgentEndLike,
  CocoToolCallLike,
  CocoToolCallOutputLike,
  CocoEventEnvelopeLike,
  CocoTraceTagLike,
  CocoTraceLike,
  CocoSessionCandidate,
  CocoToolCallState,
  CocoDraftBoardEvent,
  RunCandidate,
  BuildBataWorkflowSnapshotsOptions,
};

export {
  COCO_SESSION_STALE_AFTER_MS,
  DISCONNECTED_SESSION_CLEANUP_AFTER_MS,
  LEAD_ACTOR_PREFIX,
  MONITOR_BOARD_RUNTIME_STATE_DIR_PATH,
  MONITOR_BOARD_RUNTIME_STATE_PATH,
  MONITOR_SESSION_DIRECTORY_PATH,
  DEFAULT_COCO_SESSIONS_ENV,
  MONITOR_BOARD_LOG_FILE_NAME,
};
