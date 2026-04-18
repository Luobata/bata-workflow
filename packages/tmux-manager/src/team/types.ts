/**
 * Team management types for multi-agent orchestration.
 *
 * @module team/types
 */

// ── Task Types ───────────────────────────────────────────────────────────────

/**
 * Task status in the lifecycle
 */
export type TaskStatus =
  | 'pending'      // Not yet claimed
  | 'ready'        // Ready to be picked up
  | 'in_progress'  // Currently being worked on
  | 'completed'    // Successfully finished
  | 'failed'       // Failed with errors
  | 'blocked';     // Blocked by dependencies

/**
 * Task priority levels
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Task definition
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Short task title */
  subject: string;
  /** Detailed task description */
  description: string;
  /** Present continuous form for progress display */
  activeForm?: string;
  /** Current status */
  status: TaskStatus;
  /** Assigned worker name */
  owner?: string;
  /** Task priority */
  priority?: TaskPriority;
  /** Task IDs that this task depends on */
  dependsOn?: string[];
  /** Task IDs that depend on this task */
  blockedBy?: string[];
  /** Retry count */
  retryCount?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Started at timestamp */
  startedAt?: string;
  /** Completed at timestamp */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
  /** Result summary */
  summary?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Task creation input
 */
export interface CreateTaskInput {
  id?: string;
  subject: string;
  description: string;
  activeForm?: string;
  priority?: TaskPriority;
  dependsOn?: string[];
  maxRetries?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Task update input
 */
export interface UpdateTaskInput {
  status?: TaskStatus;
  owner?: string;
  error?: string;
  summary?: string;
  retryCount?: number;
  metadata?: Record<string, unknown>;
}

// ── Worker Types ─────────────────────────────────────────────────────────────

/**
 * Worker status
 */
export type WorkerStatus =
  | 'idle'         // No task assigned
  | 'working'      // Actively working on a task
  | 'blocked'      // Waiting for dependencies
  | 'done'         // Task completed
  | 'failed'       // Task failed
  | 'shutdown';    // Shutting down

/**
 * Worker type/agent
 */
export type WorkerType = 'claude' | 'codex' | 'gemini' | 'custom';

/**
 * Worker definition
 */
export interface Worker {
  /** Unique worker name */
  name: string;
  /** Worker type/agent */
  type: WorkerType;
  /** tmux pane ID (format: %N) */
  paneId: string;
  /** Current status */
  status: WorkerStatus;
  /** Currently assigned task ID */
  currentTaskId?: string;
  /** Task statistics */
  taskStats: {
    completed: number;
    failed: number;
    inProgress: number;
  };
  /** Heartbeat timestamp */
  lastHeartbeat?: string;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Worker creation input
 */
export interface CreateWorkerInput {
  name: string;
  type: WorkerType;
  cwd?: string;
  command?: string;
  env?: Record<string, string>;
}

// ── Team Types ───────────────────────────────────────────────────────────────

/**
 * Team phase in the execution lifecycle
 */
export type TeamPhase =
  | 'initializing'  // Team being set up
  | 'planning'      // Tasks being planned
  | 'executing'     // Tasks being executed
  | 'fixing'        // Fixing failed tasks
  | 'completed'     // All tasks completed successfully
  | 'failed';       // All tasks failed irrecoverably

/**
 * Team configuration
 */
export interface TeamConfig {
  /** Team name */
  name: string;
  /** Original task/goal */
  goal: string;
  /** Working directory */
  cwd: string;
  /** tmux session name */
  sessionName: string;
  /** Leader pane ID */
  leaderPaneId: string;
  /** Worker pane IDs */
  workerPaneIds: string[];
  /** Maximum concurrent workers */
  maxWorkers: number;
  /** Task retry limit */
  maxRetries: number;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Team creation options
 */
export interface CreateTeamOptions {
  /** Team name (auto-generated if not provided) */
  name?: string;
  /** Goal/task description */
  goal: string;
  /** Working directory */
  cwd: string;
  /** Number of workers */
  workerCount: number;
  /** Worker type */
  workerType: WorkerType;
  /** Create in new window */
  newWindow?: boolean;
  /** Maximum retries per task */
  maxRetries?: number;
}

// ── Monitor Types ─────────────────────────────────────────────────────────────

/**
 * Team snapshot for monitoring
 */
export interface TeamSnapshot {
  /** Team name */
  teamName: string;
  /** Current phase */
  phase: TeamPhase;
  /** Worker states */
  workers: Worker[];
  /** Task summary */
  tasks: {
    total: number;
    pending: number;
    ready: number;
    inProgress: number;
    completed: number;
    failed: number;
    blocked: number;
  };
  /** Whether all tasks are terminal */
  allTasksTerminal: boolean;
  /** Dead workers */
  deadWorkers: string[];
  /** Recommendations for next action */
  recommendations: string[];
  /** Snapshot timestamp */
  timestamp: string;
}

/**
 * Leader guidance for next action
 */
export type LeaderNextAction =
  | 'shutdown'           // All tasks done, can shutdown
  | 'reuse-team'         // Workers idle, can reuse
  | 'launch-new-team'    // Workers dead, need new team
  | 'keep-monitoring';   // Normal operation

/**
 * Leader guidance result
 */
export interface LeaderGuidance {
  nextAction: LeaderNextAction;
  reason: string;
  message: string;
}

// ── State Storage Types ───────────────────────────────────────────────────────

/**
 * Team state file structure
 */
export interface TeamState {
  config: TeamConfig;
  tasks: Task[];
  workers: Worker[];
  phase: TeamPhase;
  updatedAt: string;
}

/**
 * Options for state storage
 */
export interface StateStoreOptions {
  /** Root directory for state files */
  stateRoot: string;
  /** Team name */
  teamName: string;
}
