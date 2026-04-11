export type TaskType =
  | 'planning'
  | 'research'
  | 'coding'
  | 'code-review'
  | 'testing'
  | 'coordination'

export type TaskStatus = 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed'

export interface GoalInput {
  goal: string
  teamName?: string
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
  source: 'taskType' | 'skill' | 'role' | 'team' | 'global'
  reason: string
}

export interface DispatchAssignment {
  task: Task
  modelResolution: ModelResolution
  roleDefinition: RoleDefinition
}

export interface ExecutionBatch {
  batchId: string
  taskIds: string[]
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
  role: string
  taskId: string
  model: string
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
}

export interface RuntimeSnapshot {
  workers: WorkerSnapshot[]
  batches: ExecutionBatch[]
  completedTaskIds: string[]
  pendingTaskIds: string[]
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
}
