export type TaskType =
  | 'planning'
  | 'research'
  | 'coding'
  | 'code-review'
  | 'testing'
  | 'coordination'

export type ExecutionBackend = 'coco' | 'claude-code' | 'local-cc'
export type ExecutionTransport = 'print' | 'pty' | 'auto'
export type ExecutionTargetSource = ModelResolution['source'] | 'slot-override'

export interface ExecutionTargetSpec {
  backend?: ExecutionBackend
  model?: string
  profile?: string
  command?: string
  transport?: ExecutionTransport
}

export interface ExecutionTarget extends ExecutionTargetSpec {
  backend: ExecutionBackend
  model: string
  source: ExecutionTargetSource
  reason: string
  transport: ExecutionTransport
}

export type TeamSlotOverrideKey = 'backend' | 'model' | 'profile'

export interface TeamSlotOverride {
  slotId: number
  key: TeamSlotOverrideKey
  value: string
}

export interface TeamSlotSpec {
  slotId: number
  backend?: ExecutionBackend
  model?: string
  profile?: string
  tmux?: TeamSlotTmuxBinding | null
}

export interface TeamRunSpec {
  teamSize: number
  slots: TeamSlotSpec[]
  overrides: TeamSlotOverride[]
}

export interface TeamSlotTmuxBinding {
  paneId: string
  sessionName: string
  mode: 'split-pane' | 'dedicated-window' | 'detached-session'
  paneIndex?: number | null
  title?: string | null
}

export type TaskStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'blocked'

export type TaskPhase = 'queued' | 'ready' | 'running' | 'finalizing' | 'retrying' | 'blocked' | 'completed' | 'failed'

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
  teamRunSpec?: TeamRunSpec
  targetFile?: GoalTargetFile | null
  targetFiles?: GoalTargetFile[]
}

export interface GoalTargetFile {
  path: string
  content: string
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
  executionTarget: ExecutionTarget
}

export interface DispatchRemediationTarget {
  roleDefinition: RoleDefinition
  modelResolution: ModelResolution
  executionTarget: ExecutionTarget
  taskType: TaskType
  skills: string[]
}

export interface DispatchAssignment {
  task: Task
  modelResolution: ModelResolution
  executionTarget: ExecutionTarget
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
  slotCount?: number
  slots?: TeamSlotSpec[]
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
  slotId?: number
  slotBackend?: ExecutionBackend | null
  slotProfile?: string | null
  slotConfiguredModel?: string | null
  backend?: ExecutionBackend | null
  command?: string | null
  transport?: ExecutionTransport | null
  profile?: string | null
  configuredModel?: string | null
  tmux?: TeamSlotTmuxBinding | null
  role: string | null
  taskId: string | null
  model: string | null
  status: WorkerStatus
  lastHeartbeatAt: string | null
}

export interface RuntimeEvent {
  type:
    | 'run-started'
    | 'run-abort-requested'
    | 'run-aborted'
    | 'run-completed'
    | 'run-failed'
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
  createdAt?: string
  taskId?: string
  batchId: string
  detail: string
}

export interface RuntimeTaskState {
  taskId: string
  status: TaskStatus
  phase: TaskPhase
  phaseDetail: string | null
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

export interface TaskArtifactChange {
  path: string
  type: 'added' | 'modified' | 'deleted'
  additions: number | null
  deletions: number | null
}

export interface TaskArtifacts {
  taskId: string
  changes: TaskArtifactChange[]
  generatedFiles: string[]
  notes: string[]
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
  blockedTaskIds: string[]
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
  backend?: ExecutionBackend
  command?: string | null
  transport?: ExecutionTransport
  profile?: string | null
  slotId?: number
  summary: string
  status: Extract<TaskStatus, 'completed' | 'failed'>
  attempt: number
}

export interface UpstreamTaskContext {
  taskId: string
  role: string
  taskType: TaskType
  status: TaskStatus
  summary: string | null
  attempt: number | null
}

export interface RunReport {
  goal: string
  plan: Plan
  assignments: DispatchAssignment[]
  batches: ExecutionBatch[]
  runtime: RuntimeSnapshot
  results: TaskExecutionResult[]
  summary: RunSummary
  artifactsByTaskId?: Record<string, TaskArtifacts>
}

export interface RunSummary {
  generatedTaskCount: number
  loopCount: number
  loopedSourceTaskIds: string[]
  failedTaskCount: number
  blockedTaskCount: number
  completedTaskCount: number
  retryTaskCount: number
}
