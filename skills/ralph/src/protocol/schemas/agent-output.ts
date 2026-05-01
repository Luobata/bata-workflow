import { z } from 'zod'

/**
 * Agent Status - Agent执行状态
 * 
 * 统一状态映射：
 * - completed: DONE, completed, pass
 * - needs_changes: DONE_WITH_CONCERNS, NEEDS_CONTEXT, needs_changes, changes_requested
 * - failed: BLOCKED, failed, error
 */
export const AgentStatusSchema = z.enum(['completed', 'needs_changes', 'failed'])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

/**
 * Agent Output - Agent执行输出
 */
export const AgentOutputSchema = z.object({
  status: AgentStatusSchema,
  summary: z.string(),
  suggestions: z.array(z.string()),
  testSuggestions: z.array(z.string()),
  requiredTests: z.array(z.string()),
  requiredFixes: z.array(z.string()),
  contextForPeer: z.string(),
})
export type AgentOutput = z.infer<typeof AgentOutputSchema>

/**
 * Normalize Agent Status - 归一化Agent状态
 */
export function normalizeAgentStatus(statusValue: unknown): AgentStatus {
  const rawStatus = String(statusValue ?? '').trim()
  const normalized = rawStatus.toLowerCase()

  if (normalized === 'done' || normalized === 'completed' || normalized === 'pass') {
    return 'completed'
  }

  if (
    normalized === 'done_with_concerns' ||
    normalized === 'needs_changes' ||
    normalized === 'changes_requested' ||
    normalized === 'needs_context'
  ) {
    return 'needs_changes'
  }

  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'failed'
  }

  return 'completed' // 默认值
}

/**
 * Parse Agent Output - 解析Agent输出
 */
export function parseAgentOutput(raw: string): AgentOutput {
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      status: 'failed',
      summary: 'agent returned empty output',
      suggestions: [],
      testSuggestions: [],
      requiredTests: [],
      requiredFixes: [],
      contextForPeer: '',
    }
  }

  try {
    const parsed = JSON.parse(trimmed)
    const status = normalizeAgentStatus(parsed.status)
    const summary = typeof parsed.summary === 'string' ? parsed.summary : trimmed
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((item: unknown) => String(item))
      : []
    const testSuggestions = Array.isArray(parsed.test_suggestions)
      ? parsed.test_suggestions.map((item: unknown) => String(item))
      : []
    const requiredTests = Array.isArray(parsed.required_tests)
      ? parsed.required_tests.map((item: unknown) => String(item))
      : []
    const requiredFixes = Array.isArray(parsed.required_fixes)
      ? parsed.required_fixes.map((item: unknown) => String(item))
      : []
    const contextForPeer = typeof parsed.context_for_peer === 'string' ? parsed.context_for_peer.trim() : ''

    return {
      status,
      summary,
      suggestions,
      testSuggestions,
      requiredTests,
      requiredFixes,
      contextForPeer,
    }
  } catch {
    return {
      status: 'completed',
      summary: trimmed,
      suggestions: [],
      testSuggestions: [],
      requiredTests: [],
      requiredFixes: [],
      contextForPeer: '',
    }
  }
}

/**
 * Build Agent Output JSON Schema Prompt - 构建Agent输出格式的JSON Schema提示
 */
export function buildAgentOutputSchemaPrompt(): string {
  return JSON.stringify({
    status: 'DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|completed|needs_changes|failed',
    summary: '...',
    suggestions: ['...'],
    test_suggestions: ['...'],
    required_tests: ['...'],
    required_fixes: ['...'],
    context_for_peer: '...',
  })
}
