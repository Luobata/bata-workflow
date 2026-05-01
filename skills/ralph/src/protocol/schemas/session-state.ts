import { z } from 'zod'

/**
 * Session Status - 会话状态
 */
export const SessionStatusSchema = z.enum(['running', 'planned', 'partial', 'completed'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

/**
 * Execution Mode - 执行模式
 */
export const ExecutionModeSchema = z.enum(['independent', 'subagent'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

/**
 * Session State - 会话状态
 */
export const SessionStateSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string(),
  goal: z.string(),
  path: z.string(),
  mode: ExecutionModeSchema,
  status: SessionStatusSchema,

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resumedAt: z.string().datetime().optional(),
})
export type SessionState = z.infer<typeof SessionStateSchema>

/**
 * Create Session State - 创建新会话状态
 */
export function createSessionState(options: {
  cwd: string
  goal: string
  path: string
  mode: ExecutionMode
}): SessionState {
  const now = new Date().toISOString()
  return {
    sessionId: `ralph:${crypto.randomUUID()}`,
    cwd: options.cwd,
    goal: options.goal,
    path: options.path,
    mode: options.mode,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Update Session State - 更新会话状态
 */
export function updateSessionState(
  session: SessionState,
  updates: Partial<Pick<SessionState, 'status' | 'resumedAt' | 'mode'>>
): SessionState {
  return {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  }
}
