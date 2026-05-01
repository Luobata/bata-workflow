#!/usr/bin/env node

/**
 * Session State Machine - Session状态机
 */

/**
 * Session Context - 会话状态转换上下文
 */
export const SESSION_TRANSITIONS = [
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
export function transitionSession(currentStatus, context) {
  for (const transition of SESSION_TRANSITIONS) {
    if (transition.from === '*' || transition.from === currentStatus) {
      if (transition.condition(context)) {
        return transition.to
      }
    }
  }
  return currentStatus
}
