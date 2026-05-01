import type { SessionStatus } from '../schemas/session-state.js'

/**
 * Session Context - 会话状态转换上下文
 */
export interface SessionContext {
  dryRunPlan: boolean
  hasBlockedTasks: boolean
  allTasksDone: boolean
  isResumed: boolean
}

/**
 * Session Transition - 会话状态转换规则
 */
export interface SessionTransition {
  from: SessionStatus | '*'
  to: SessionStatus
  condition: (context: SessionContext) => boolean
  description: string
}

/**
 * Session State Transitions - 会话状态转换规则表
 */
export const SESSION_TRANSITIONS: SessionTransition[] = [
  {
    from: 'running',
    to: 'planned',
    condition: (ctx) => ctx.dryRunPlan,
    description: 'dryRunPlan mode stops at planning phase',
  },
  {
    from: 'running',
    to: 'completed',
    condition: (ctx) => !ctx.dryRunPlan && ctx.allTasksDone,
    description: 'all tasks completed successfully',
  },
  {
    from: 'running',
    to: 'partial',
    condition: (ctx) => !ctx.dryRunPlan && ctx.hasBlockedTasks,
    description: 'some tasks are blocked',
  },
  {
    from: 'partial',
    to: 'completed',
    condition: (ctx) => ctx.allTasksDone,
    description: 'blocked tasks resolved, all tasks done',
  },
  {
    from: 'planned',
    to: 'running',
    condition: (ctx) => ctx.isResumed,
    description: 'resume from planned state',
  },
]

/**
 * Transition Session - 执行会话状态转换
 */
export function transitionSession(
  currentStatus: SessionStatus,
  context: SessionContext
): SessionStatus {
  for (const transition of SESSION_TRANSITIONS) {
    if (transition.from === '*' || transition.from === currentStatus) {
      if (transition.condition(context)) {
        return transition.to
      }
    }
  }
  return currentStatus
}

/**
 * Get Session Transition Description - 获取状态转换描述
 */
export function getSessionTransitionDescription(
  from: SessionStatus,
  to: SessionStatus
): string | undefined {
  return SESSION_TRANSITIONS.find(
    (t) => (t.from === '*' || t.from === from) && t.to === to
  )?.description
}

/**
 * Validate Session Transition - 验证状态转换是否合法
 */
export function validateSessionTransition(
  from: SessionStatus,
  to: SessionStatus,
  context: SessionContext
): boolean {
  const result = transitionSession(from, context)
  return result === to
}
