#!/usr/bin/env node

/**
 * Agent Output Schema - Agent输出Schema定义
 */

import { z } from 'zod'

/**
 * Agent Status - Agent执行状态
 */
export const AgentStatusSchema = z.enum(['completed', 'needs_changes', 'failed'])

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

/**
 * Normalize Agent Status - 归一化Agent状态
 */
export function normalizeAgentStatus(statusValue) {
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

  return 'completed'
}

/**
 * Parse Agent Output - 解析Agent输出
 */
export function parseAgentOutput(raw) {
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
      ? parsed.suggestions.map((item) => String(item))
      : []
    const testSuggestions = Array.isArray(parsed.test_suggestions)
      ? parsed.test_suggestions.map((item) => String(item))
      : []
    const requiredTests = Array.isArray(parsed.required_tests)
      ? parsed.required_tests.map((item) => String(item))
      : []
    const requiredFixes = Array.isArray(parsed.required_fixes)
      ? parsed.required_fixes.map((item) => String(item))
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
 * Build Agent Output JSON Schema Prompt
 */
export function buildAgentOutputSchemaPrompt() {
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
