#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()

const ensureDirectory = async (directoryPath) => {
  await mkdir(directoryPath, { recursive: true })
}

const writeJson = async (filePath, value) => {
  await ensureDirectory(resolve(filePath, '..'))
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const readJson = async (filePath) => {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

/**
 * Build State Paths - 构建状态目录路径
 */
export const buildStatePaths = (cwd) => {
  const root = resolve(cwd, '.ralph')
  return {
    root,
    sessionPath: resolve(root, 'session.json'),
    tasksPath: resolve(root, 'tasks.json'),
    todoStatePath: resolve(root, 'todo-state.json'),
    todoMarkdownPath: resolve(root, 'TODO.md'),
    confirmationStatePath: resolve(root, 'confirmation-state.json'),
    checkpointsDir: resolve(root, 'checkpoints'),
    reviewsDir: resolve(root, 'reviews'),
    artifactsDir: resolve(root, 'artifacts'),
    logsDir: resolve(root, 'logs'),
    runtimeLogPath: resolve(root, 'logs', 'runtime.jsonl'),
    monitorIntegrationPath: resolve(root, 'monitor-integration.json'),
  }
}

/**
 * Append Runtime Log - 追加运行时日志
 */
export const appendRuntimeLog = async (statePaths, event, data = {}) => {
  const payload = {
    ts: nowIso(),
    pid: process.pid,
    event,
    data,
  }

  try {
    await ensureDirectory(statePaths.logsDir)
    await appendFile(statePaths.runtimeLogPath, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // best effort logging; never break runtime flow
  }
}

/**
 * Render Todo Markdown - 渲染TODO Markdown
 */
export const renderTodoMarkdown = ({ session, tasks }) => {
  const lines = [
    '# Ralph TODO Progress',
    '',
    `- sessionId: ${session.sessionId}`,
    `- mode: ${session.mode}`,
    `- status: ${session.status}`,
    `- updatedAt: ${session.updatedAt}`,
    '',
    '| ID | Status | Title | Deps | Review Rounds |',
    '| --- | --- | --- | --- | --- |',
    ...tasks.map((task) => `| ${task.id} | ${task.status} | ${task.title} | ${(task.deps ?? []).join(', ') || 'none'} | ${task.reviewRounds ?? 0} |`),
    '',
  ]

  return `${lines.join('\n')}\n`
}

/**
 * Sync Todo Files - 同步TODO文件
 */
export const syncTodoFiles = async ({ statePaths, session, tasks }) => {
  const todoState = {
    sessionId: session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      deps: [...(task.deps ?? [])],
      reviewRounds: task.reviewRounds ?? 0,
      lastAdvicePath: task.lastAdvicePath ?? null,
      acceptance: [...(task.acceptance ?? [])],
      verification_cmds: [...(task.verification_cmds ?? [])],
      deliverables: [...(task.deliverables ?? [])],
      handoffChecklist: [...(task.handoffChecklist ?? [])],
      scopeRules: [...(task.scopeRules ?? [])],
      executionHints: [...(task.executionHints ?? [])],
      completionDefinition: task.completionDefinition ?? '',
      backgroundContext: task.backgroundContext ?? '',
      sourceRefs: [...(task.sourceRefs ?? [])],
      channel: {
        codingToReview: task.channel?.codingToReview ?? '',
        reviewToCoding: task.channel?.reviewToCoding ?? '',
        lastUpdatedAt: task.channel?.lastUpdatedAt ?? null,
      },
    })),
  }

  await writeJson(statePaths.todoStatePath, todoState)
  await writeFile(statePaths.todoMarkdownPath, renderTodoMarkdown({ session, tasks }), 'utf8')
}

/**
 * Sync Confirmation State - 同步确认状态
 */
export const syncConfirmationState = async ({ statePaths, awaitingConfirmation, reason, nextAction }) => {
  await writeJson(statePaths.confirmationStatePath, {
    awaitingConfirmation,
    reason,
    nextAction,
    updatedAt: nowIso(),
  })
}

/**
 * Write Checkpoint - 写入检查点
 */
export const writeCheckpoint = async ({ statePaths, task, stage, payload }) => {
  await ensureDirectory(statePaths.checkpointsDir)
  const checkpoint = {
    taskId: task.id,
    stage,
    at: nowIso(),
    payload,
  }
  const checkpointPath = resolve(statePaths.checkpointsDir, `${Date.now()}-${task.id}-${stage}.json`)
  await writeJson(checkpointPath, checkpoint)
  return checkpointPath
}

/**
 * Write Review Outputs - 写入Review输出
 */
export const writeReviewOutputs = async ({ statePaths, task, reviewResult }) => {
  await ensureDirectory(statePaths.reviewsDir)
  const reviewPath = resolve(statePaths.reviewsDir, `${task.id}.review.json`)
  const advicePath = resolve(statePaths.reviewsDir, `${task.id}.advice.md`)

  const adviceLines = [
    `# ${task.title} - Review Advice`,
    '',
    `Status: ${reviewResult.status}`,
    '',
    '## Summary',
    reviewResult.summary || 'No summary',
    '',
    '## Actionable Suggestions',
    ...(reviewResult.suggestions.length > 0
      ? reviewResult.suggestions.map((item, index) => `${index + 1}. ${item}`)
      : ['1. 无阻塞问题，可继续后续任务。']),
    '',
    '## Required Fixes',
    ...(reviewResult.requiredFixes.length > 0
      ? reviewResult.requiredFixes.map((item, index) => `${index + 1}. ${item}`)
      : ['1. 无强制修复项。']),
    '',
    '## Required Tests',
    ...(reviewResult.requiredTests.length > 0
      ? reviewResult.requiredTests.map((item, index) => `${index + 1}. ${item}`)
      : ['1. 无新增必测项。']),
    '',
  ]

  await writeJson(reviewPath, {
    taskId: task.id,
    status: reviewResult.status,
    summary: reviewResult.summary,
    suggestions: reviewResult.suggestions,
    requiredFixes: reviewResult.requiredFixes,
    requiredTests: reviewResult.requiredTests,
    contextForPeer: reviewResult.contextForPeer,
    createdAt: nowIso(),
  })
  await writeFile(advicePath, `${adviceLines.join('\n')}\n`, 'utf8')

  return { reviewPath, advicePath }
}

/**
 * Persist State - 持久化状态
 */
export const persistState = async ({ statePaths, session, tasks }) => {
  session.updatedAt = nowIso()
  await writeJson(statePaths.sessionPath, session)
  await writeJson(statePaths.tasksPath, tasks)
  await syncTodoFiles({ statePaths, session, tasks })
}

/**
 * Load Or Initialize State - 加载或初始化状态
 */
export const loadOrInitializeState = async ({ options, statePaths, todoBuilder }) => {
  const hasSession = existsSync(statePaths.sessionPath)
  const hasTasks = existsSync(statePaths.tasksPath)

  if (options.resume && (!hasSession || !hasTasks)) {
    const missing = [
      hasSession ? null : `session missing (${statePaths.sessionPath})`,
      hasTasks ? null : `tasks missing (${statePaths.tasksPath})`,
    ].filter(Boolean).join('; ')
    throw new Error(`无法恢复执行：${missing}`)
  }

  if (options.resume && hasSession && hasTasks) {
    const session = await readJson(statePaths.sessionPath)
    const tasks = await readJson(statePaths.tasksPath)
    
    // 使用 normalizeTasks 确保旧任务格式迁移
    const { normalizeTasks } = await import('../src/protocol/schemas/task-contract.mjs')
    const normalizedTasks = normalizeTasks(tasks)
    
    const recoveredTasks = normalizedTasks.map((task) => (
      task.status === 'in_progress' || task.status === 'blocked'
        ? { ...task, status: 'pending', history: [...(task.history ?? []), { at: nowIso(), event: 'resume-recover' }] }
        : task
    ))
    return {
      session: {
        ...session,
        status: 'running',
        resumedAt: nowIso(),
        mode: options.mode,
      },
      tasks: recoveredTasks,
      resumed: true,
    }
  }

  if (!options.goal.trim() && !options.path.trim() && !options.dir.trim()) {
    throw new Error('请提供 --goal、--path 或 --dir，或者使用 --resume')
  }

  const tasks = await todoBuilder({ goal: options.goal, path: options.path, dir: options.dir, cwd: options.cwd })
  
  // Import normalizeTasks dynamically to avoid circular dependency
  const { normalizeTasks } = await import('../src/protocol/schemas/task-contract.mjs')
  const normalizedTasks = normalizeTasks(tasks)
  
  const session = {
    sessionId: `ralph:${crypto.randomUUID()}`,
    cwd: options.cwd,
    goal: options.goal,
    path: options.path,
    dir: options.dir,  // 新增：设计文档目录
    mode: options.mode,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  return { session, tasks: normalizedTasks, resumed: false }
}

export { ensureDirectory, writeJson, readJson, nowIso }
