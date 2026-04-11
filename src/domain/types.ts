export type TaskType =
  | 'planning'
  | 'research'
  | 'coding'
  | 'code-review'
  | 'testing'
  | 'coordination'

export type TaskStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed'

export interface FixVerifyLoopPolicy {
  enabled: boolean
  maxRounds: number
  remediationRole: string | null
  remediationModel: string | null
  remediationTaskType: TaskType | null
  remediationSkills: string[]
  remediationTitleTemplate: string
  remediationDescriptionTemplate: string
}

export interface TaskFailurePolicy {
  maxAttempts: number
  retryDelayMs: number
  fallbackRole: string | null
  fallbackModel: string | null
  fixVerifyLoop: FixVerifyLoopPolicy | null
  retryOn: string[]
  terminalOn: string[]
}

export interface GoalInput {
  goal: string
  teamName?: string
  compositionName?: string
}

export interface Task {
  id: string
  title: string
  description: string
  role: string
  taskType: TaskType
  dependsOn: string[]
  acceptanceCriteria: string[]
  skills: string[]
  status: TaskStatus
  maxAttempts: number
  failurePolicy?: TaskFailurePolicy
  generatedFromTaskId?: string | null
}

export interface Plan {
  goal: string
  summary: string
  tasks: Task[]
}

export interface RoleDefinition {
  name: string
  description: string
  defaultTaskTypes: TaskType[]
  defaultSkills: string[]
}

export interface ModelResolutionInput {
  role: string
  taskType: TaskType
  skills?: string[]
  teamName?: string
}

export interface ModelResolution {
  model: string
  source: 'taskType' | 'skill' | 'role' | 'team' | 'global' | 'fallback' | 'remediation'
  reason: string
}

export interface DispatchFallbackTarget {
  roleDefinition: RoleDefinition
  modelResolution: ModelResolution
}

export interface DispatchRemediationTarget {
  roleDefinition: RoleDefinition
  modelResolution: ModelResolution
  taskType: TaskType
  skills: string[]
}

export interface DispatchAssignment {
  task: Task
  modelResolution: ModelResolution
  roleDefinition: RoleDefinition
  fallback: DispatchFallbackTarget | null
  remediation: DispatchRemediationTarget | null
}

export interface ExecutionBatch {
  batchId: string
  taskIds: string[]
}

export interface WorkerPoolConfig {
  maxConcurrency: number
}

export type WorkerStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface MailboxMessage {
  messageId: string
  workerId: string
  taskId: string
  direction: 'inbound' | 'outbound'
  content: string
  createdAt: string
}

export interface WorkerSnapshot {
  workerId: string
  role: string | null
  taskId: string | null
  model: string | null
  status: WorkerStatus
  lastHeartbeatAt: string | null
}

export interface RuntimeEvent {
  type:
    | 'batch-start'
    | 'task-claimed'
    | 'task-start'
    | 'task-complete'
    | 'task-failed'
    | 'task-retry'
    | 'task-generated'
    | 'task-rerouted'
    | 'task-released'
    | 'batch-complete'
  taskId?: string
  batchId: string
  detail: string
}

export interface RuntimeTaskState {
  taskId: string
  status: TaskStatus
  claimedBy: string | null
  attempts: number
  maxAttempts: number
  lastError: string | null
  attemptHistory: TaskAttemptRecord[]
  workerHistory: string[]
  failureTimestamps: string[]
  lastClaimedAt: string | null
  releasedAt: string | null
  nextAttemptAt: string | null
  lastUpdatedAt: string | null
}

export interface RuntimeDynamicTaskStats {
  generatedTaskCount: number
  generatedTaskIds: string[]
  generatedTaskCountBySourceTaskId: Record<string, number>
}

export interface RuntimeLoopSummary {
  sourceTaskId: string
  loopEnabled: boolean
  maxRounds: number | null
  generatedTaskIds: string[]
  completedGeneratedTaskIds: string[]
  pendingGeneratedTaskIds: string[]
}

export interface TaskAttemptRecord {
  attempt: number
  workerId: string
  startedAt: string
  finishedAt: string | null
  status: Extract<TaskStatus, 'in_progress' | 'completed' | 'failed'>
}

export interface QueueClaimResult {
  workerId: string
  taskId: string
  batchId: string
  attempt: number
  maxAttempts: number
  assignment: DispatchAssignment
}

export interface RuntimeSnapshot {
  maxConcurrency: number
  workers: WorkerSnapshot[]
  batches: ExecutionBatch[]
  completedTaskIds: string[]
  pendingTaskIds: string[]
  readyTaskIds: string[]
  inProgressTaskIds: string[]
  failedTaskIds: string[]
  dynamicTaskStats: RuntimeDynamicTaskStats
  loopSummaries: RuntimeLoopSummary[]
  events: RuntimeEvent[]
  mailbox: MailboxMessage[]
  taskStates: RuntimeTaskState[]
}

export interface TaskExecutionResult {
  taskId: string
  role: string
  model: string
  summary: string
  status: Extract<TaskStatus, 'completed' | 'failed'>
  attempt: number
}

export interface RunReport {
  goal: string
  plan: Plan
  assignments: DispatchAssignment[]
  batches: ExecutionBatch[]
  runtime: RuntimeSnapshot
  results: TaskExecutionResult[]
  summary: RunSummary
}

export interface RunSummary {
  generatedTaskCount: number
  loopCount: number
  loopedSourceTaskIds: string[]
  failedTaskCount: number
  completedTaskCount: number
  retryTaskCount: number
}
