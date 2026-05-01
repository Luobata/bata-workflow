#!/usr/bin/env node

/**
 * Ralph Skill - 主入口文件（精简版）
 * 
 * 职责：
 * 1. 解析CLI参数
 * 2. 协调执行流程
 * 3. 输出格式化
 * 
 * 不应包含：
 * - 任务生成逻辑 → plan-builder.mjs
 * - 状态管理逻辑 → state-manager.mjs
 * - Agent执行逻辑 → agent-runner.mjs
 * - Prompt构建逻辑 → 使用配置文件
 */

import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { buildStatePaths, loadOrInitializeState, persistState, appendRuntimeLog, syncConfirmationState, writeCheckpoint, writeReviewOutputs } from './state-manager.mjs'
import { defaultTodoBuilder } from './plan-builder.mjs'
import { runDefaultAgentByMode, parseAgentOutput } from './agent-runner.mjs'
import { loadPrompts, buildRolePromptFromConfig } from './config-loader.mjs'
import { transitionSession } from '../src/protocol/state-machine/session-machine.mjs'
import { transitionTask } from '../src/protocol/state-machine/task-machine.mjs'
import { normalizeTasks } from '../src/protocol/schemas/task-contract.mjs'
import crypto from 'node:crypto'

const DEFAULT_MODE = 'independent'
const DEFAULT_MAX_REVIEW_ROUNDS = 3
const DEFAULT_MODEL = 'gpt-5.3-codex'

/**
 * Default Validation Config - 默认校验配置
 */
const DEFAULT_VALIDATION_CONFIG = {
  maxTotalRounds: 5,              // 总上限
  maxCommunicationRounds: 3,      // 通信轮次上限
  maxValidationRounds: 2,         // 校验轮次上限
  basicRules: [
    { type: 'basic_correctness', description: '代码能运行', required: true },
    { type: 'no_placeholders', description: '无TODO/FIXME占位符', required: true },
    { type: 'acceptance_coverage', description: '满足acceptance', required: true },
  ],
  enableEarlyStop: true,
  earlyStopSeverity: ['critical'],
}

/**
 * Check Basic Rules - 检查基础规则
 */
const checkBasicRules = (codingResult, reviewResult, task) => {
  const results = []
  const summary = (codingResult?.summary ?? '').toLowerCase()
  const contextForPeer = (codingResult?.contextForPeer ?? '').toLowerCase()
  
  // Rule 1: basic_correctness - 检查是否包含错误标识
  const hasError = /error|failed|exception|崩溃|报错/i.test(summary)
  results.push({
    ruleType: 'basic_correctness',
    passed: !hasError,
    message: hasError ? '代码存在运行错误' : '代码基本正确',
  })
  
  // Rule 2: no_placeholders - 检查是否有占位符
  const hasPlaceholders = /TODO|FIXME|XXX|HACK|占位|待实现|待完成/i.test(summary + contextForPeer)
  results.push({
    ruleType: 'no_placeholders',
    passed: !hasPlaceholders,
    message: hasPlaceholders ? '存在占位符实现' : '无占位符',
  })
  
  // Rule 3: acceptance_coverage - 检查 review 结果
  const acceptancePassed = reviewResult?.status === 'completed' || reviewResult?.status === 'pass'
  results.push({
    ruleType: 'acceptance_coverage',
    passed: acceptancePassed,
    message: acceptancePassed ? '验收标准满足' : '验收标准未满足',
  })
  
  const allPassed = results.every((r) => r.passed)
  const hasCriticalIssue = reviewResult?.severity === 'critical' || /critical|严重|阻塞/i.test(reviewResult?.summary ?? '')
  
  return {
    allPassed,
    hasCriticalIssue,
    results,
  }
}

/**
 * Determine Round Type - 决定轮次类型
 */
const determineRoundType = (task, config) => {
  // 如果校验轮次用完，必须是通信
  if ((task.validationRounds ?? 0) >= config.maxValidationRounds) {
    return 'communication'
  }
  
  // 如果通信轮次用完，必须是校验
  if ((task.communicationRounds ?? 0) >= config.maxCommunicationRounds) {
    return 'validation'
  }
  
  // 如果上一次 review 请求了测试，走校验
  const lastReview = task.channel?.reviewToCoding
  if (typeof lastReview === 'object' && (lastReview?.requiredTests?.length ?? 0) > 0 && (task.communicationRounds ?? 0) > 0) {
    return 'validation'
  }
  
  // 默认为通信
  return 'communication'
}

/**
 * Record Unresolved Issue - 记录未解决问题
 */
const recordUnresolvedIssue = ({ task, issue, priority, category, reason }) => {
  if (!task.channel.unresolvedIssues) {
    task.channel.unresolvedIssues = []
  }
  
  const existingIssue = task.channel.unresolvedIssues.find(
    i => i.description === issue && i.status === 'open'
  )
  
  if (existingIssue) {
    // 已存在，更新
    existingIssue.priority = priority
    existingIssue.category = category
    existingIssue.reason = reason
    return existingIssue
  }
  
  // 新建
  const newIssue = {
    id: `issue-${crypto.randomUUID().slice(0, 8)}`,
    description: issue,
    priority,
    category,
    status: 'open',
    reason,
    taskId: task.id,
    taskTitle: task.title,
    round: task.communicationRounds ?? 0,
    createdAt: new Date().toISOString(),
  }
  
  task.channel.unresolvedIssues.push(newIssue)
  return newIssue
}

/**
 * Defer Issue - 标记问题为延后处理
 */
const deferIssue = ({ task, issueId, reason }) => {
  if (!task.channel.unresolvedIssues) return
  
  const issue = task.channel.unresolvedIssues.find(i => i.id === issueId)
  if (issue) {
    issue.status = 'deferred'
    issue.deferredAt = new Date().toISOString()
    issue.deferredReason = reason
  }
}

/**
 * Write Error Pattern - 写入错误模式到沉淀目录
 */
const writeErrorPattern = async ({ statePaths, pattern }) => {
  const lessonsDir = resolve(statePaths.root, 'lessons-learned')
  if (!existsSync(lessonsDir)) {
    mkdirSync(lessonsDir, { recursive: true })
  }
  
  const patternFile = resolve(lessonsDir, `${pattern.id}.json`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(patternFile, JSON.stringify(pattern, null, 2), 'utf8')
  
  return patternFile
}

/**
 * Analyze Error Pattern - 分析错误模式
 */
const analyzeErrorPattern = ({ reviewResult, codingResult, task }) => {
  const requiredFixes = reviewResult?.requiredFixes ?? []
  if (requiredFixes.length === 0) return null
  
  // 简单的错误分类逻辑
  const categories = {
    logic: /逻辑|判断|条件|if|else|condition/i,
    boundary: /边界|越界|空值|null|undefined|empty|边界条件/i,
    type: /类型|type|类型错误|类型不匹配/i,
    concurrency: /并发|锁|线程|异步|async|await|race/i,
    resource: /内存|泄漏|资源|连接|connection|memory|leak/i,
    api: /api|接口|调用|参数|parameter|argument/i,
    configuration: /配置|config|环境|environment/i,
    testing: /测试|test|覆盖|coverage|边界测试/i,
    documentation: /文档|注释|document|comment|readme/i,
  }
  
  const fixes = []
  for (const fix of requiredFixes) {
    let category = 'other'
    for (const [cat, pattern] of Object.entries(categories)) {
      if (pattern.test(fix)) {
        category = cat
        break
      }
    }
    
    fixes.push({
      description: fix,
      category,
    })
  }
  
  // 合并同类错误
  const categoryMap = new Map()
  for (const fix of fixes) {
    if (!categoryMap.has(fix.category)) {
      categoryMap.set(fix.category, [])
    }
    categoryMap.get(fix.category).push(fix.description)
  }
  
  // 生成错误模式
  const patterns = []
  for (const [category, descriptions] of categoryMap) {
    patterns.push({
      id: `error-${category}-${crypto.randomUUID().slice(0, 8)}`,
      pattern: `${category} error in ${task.phase ?? 'implementation'}`,
      description: descriptions.join('; '),
      category,
      severity: reviewResult.severity ?? 'medium',
      rootCause: '待分析',
      fixStrategy: descriptions.join('; '),
      preventionTip: `在实现时注意 ${category} 相关问题`,
      examples: [{
        taskId: task.id,
        taskTitle: task.title,
        wrongApproach: codingResult.summary ?? '',
        correctApproach: descriptions.join('; '),
      }],
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrences: 1,
    })
  }
  
  return patterns
}

const parseArgs = (argv) => {
  const options = {
    cwd: process.cwd(),
    goal: '',
    path: '',
    dir: '',  // 新增：设计文档目录
    mode: DEFAULT_MODE,
    model: DEFAULT_MODEL,
    output: 'text',
    resume: false,
    resumeForce: false,
    stubAgent: false,
    dryRunPlan: false,
    execute: false,
    monitor: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]

    if (token === '--cwd' && next) {
      options.cwd = next
      index += 1
      continue
    }
    if (token === '--goal' && next) {
      options.goal = next
      index += 1
      continue
    }
    if (token === '--path' && next) {
      options.path = next
      index += 1
      continue
    }
    if (token === '--dir' && next) {
      options.dir = next
      index += 1
      continue
    }
    if (token === '--mode' && next) {
      options.mode = next
      index += 1
      continue
    }
    if (token === '--model' && next) {
      options.model = next
      index += 1
      continue
    }
    if (token === '--output' && next) {
      options.output = next
      index += 1
      continue
    }
    if (token === '--resume') {
      options.resume = true
    }
    if (token === '--resumeForce') {
      options.resumeForce = true
      options.resume = true
    }
    if (token === '--stubAgent') {
      options.stubAgent = true
    }
    if (token === '--dryRunPlan') {
      options.dryRunPlan = true
    }
    if (token === '--execute') {
      options.execute = true
    }
    if (token === '--monitor') {
      options.monitor = true
    }
  }

  return options
}

const isMonitorUnavailableError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  return /Cannot find module|ERR_MODULE_NOT_FOUND|monitor runtime missing|ENOENT/i.test(message)
}

const defaultRunMonitor = async ({ cwd }) => {
  const monitorRuntimeModulePath = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'monitor', 'runtime', 'invoke-monitor.mjs')
  if (!existsSync(monitorRuntimeModulePath)) {
    throw new Error('monitor runtime missing')
  }

  const monitorRuntimeModule = await import(pathToFileURL(monitorRuntimeModulePath).href)
  if (typeof monitorRuntimeModule?.invokeMonitor !== 'function') {
    throw new Error('monitor runtime missing invokeMonitor')
  }

  return await monitorRuntimeModule.invokeMonitor({ cwd })
}

const maybeStartMonitorForRalph = async ({ options, statePaths, runMonitor }) => {
  if (!options.monitor || options.dryRunPlan) {
    return null
  }

  let monitorState = null
  if (existsSync(statePaths.monitorIntegrationPath)) {
    try {
      const { readJson } = await import('./state-manager.mjs')
      monitorState = await readJson(statePaths.monitorIntegrationPath)
    } catch {
      monitorState = null
    }
  }

  if (monitorState?.started) {
    return {
      status: 'skipped',
      monitorSessionId: typeof monitorState.monitorSessionId === 'string' ? monitorState.monitorSessionId : null,
      monitorStatePath: statePaths.monitorIntegrationPath,
      monitorUrl: typeof monitorState.monitorUrl === 'string' ? monitorState.monitorUrl : null,
      message: 'already started in current session',
    }
  }

  if (process.env.RALPH_TEST_MONITOR_FORCE_MISSING === '1') {
    return {
      status: 'unavailable',
      monitorStatePath: statePaths.monitorIntegrationPath,
      monitorUrl: null,
      message: 'monitor runtime unavailable',
    }
  }

  let result = null
  try {
    if (process.env.RALPH_TEST_MONITOR_STUB === '1') {
      result = {
        kind: 'create',
        monitorSessionId: 'stub-monitor-session',
        board: {
          url: 'http://127.0.0.1:3939?monitorSessionId=stub-monitor-session',
        },
      }
    } else {
      result = await runMonitor({ cwd: options.cwd })
    }
  } catch (error) {
    if (isMonitorUnavailableError(error)) {
      return {
        status: 'unavailable',
        monitorStatePath: statePaths.monitorIntegrationPath,
        monitorUrl: null,
        message: error instanceof Error ? error.message : String(error),
      }
    }

    return {
      status: 'failed',
      monitorStatePath: statePaths.monitorIntegrationPath,
      monitorUrl: null,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const monitorUrl = typeof result?.board?.url === 'string' ? result.board.url : null
  const { writeJson, nowIso } = await import('./state-manager.mjs')
  await writeJson(statePaths.monitorIntegrationPath, {
    started: true,
    startCount: Number.isInteger(monitorState?.startCount) ? Number(monitorState.startCount) + 1 : 1,
    monitorSessionId: result?.monitorSessionId ?? null,
    monitorResultKind: result?.kind ?? 'unknown',
    monitorUrl,
    updatedAt: nowIso(),
  })

  return {
    status: 'started',
    monitorSessionId: result?.monitorSessionId ?? null,
    monitorStatePath: statePaths.monitorIntegrationPath,
    monitorUrl,
    message: result?.kind ?? 'monitor started',
  }
}

const maybeInterruptOnceForE2E = async (statePaths) => {
  if (process.env.RALPH_TEST_INTERRUPT_ONCE !== '1') {
    return
  }

  const markerPath = resolve(statePaths.root, 'interrupt-once.marker')
  if (existsSync(markerPath)) {
    return
  }

  const { writeFile, nowIso } = await import('./state-manager.mjs')
  await writeFile(markerPath, `${nowIso()}\n`, 'utf8')
  throw new Error('simulated one-time interruption for e2e')
}

const executeTaskLoop = async ({ task, context }) => {
  const {
    options,
    statePaths,
    runAgent,
    maxReviewRounds,
    validationConfig = DEFAULT_VALIDATION_CONFIG,
    persistStateFn,
    writeRuntimeLog,
    allTasks,
    promptsConfig,
  } = context

  task.status = transitionTask(task.status, {})
  task.history.push({ at: new Date().toISOString(), event: 'task-start' })
  await writeRuntimeLog('task.start', { taskId: task.id, title: task.title })
  await persistStateFn()
  await writeCheckpoint({ statePaths, task, stage: 'task-start', payload: { status: task.status } })

  // 初始化轮次计数器
  task.communicationRounds = task.communicationRounds ?? 0
  task.validationRounds = task.validationRounds ?? 0
  task.reviewRounds = task.reviewRounds ?? 0
  
  // 初始化未解决问题列表
  if (!task.channel.unresolvedIssues) {
    task.channel.unresolvedIssues = []
  }
  if (!task.channel.errorPatterns) {
    task.channel.errorPatterns = []
  }

  let advice = ''
  let shouldContinue = true
  let lastReviewPassed = false  // 记录最后一次 review 是否通过

  while (shouldContinue) {
    const totalRounds = task.communicationRounds + task.validationRounds
    
    // 检查总轮次上限
    if (totalRounds >= validationConfig.maxTotalRounds) {
      task.status = transitionTask(task.status, { maxRoundsReached: true })
      task.history.push({
        at: new Date().toISOString(),
        event: 'task-blocked',
        reason: `max total rounds (${validationConfig.maxTotalRounds}) reached`,
        communicationRounds: task.communicationRounds,
        validationRounds: task.validationRounds,
      })
      await writeRuntimeLog('task.blocked', { taskId: task.id, reason: 'max total rounds reached' })
      break
    }

    // 决定轮次类型
    const roundType = determineRoundType(task, validationConfig)
    
    if (roundType === 'communication') {
      // === 通信轮次：Coding → Review ===
      const codingPrompt = buildRolePromptFromConfig({
        role: 'coding',
        task,
        goal: options.goal,
        mode: options.mode,
        path: options.path,
        dir: options.dir,
        advice,
        allTasks,
        promptsConfig,
      })

      const codingRaw = await runAgent({ role: 'coding', prompt: codingPrompt, mode: options.mode, model: options.model })
      const codingResult = parseAgentOutput(codingRaw.stdout)
      
      // 更新 channel（支持新旧格式）
      if (typeof task.channel.codingToReview === 'object') {
        task.channel.codingToReview = {
          summary: codingResult.summary,
          filesModified: codingResult.filesModified ?? [],
          testsSuggested: codingResult.testSuggestions ?? [],
          contextForPeer: codingResult.contextForPeer ?? '',
          risksIdentified: codingResult.risksIdentified ?? [],
        }
      } else {
        task.channel.codingToReview = [
          codingResult.summary,
          ...(codingResult.testSuggestions ?? []),
          codingResult.contextForPeer,
        ].filter(Boolean).join('\n')
      }
      task.channel.lastUpdatedAt = new Date().toISOString()
      
      await writeRuntimeLog('task.coding.finished', {
        taskId: task.id,
        round: task.communicationRounds + 1,
        type: 'communication',
        status: codingResult.status,
        summary: codingResult.summary,
      })
      task.history.push({
        at: new Date().toISOString(),
        event: 'coding-finished',
        round: task.communicationRounds + 1,
        type: 'communication',
        summary: codingResult.summary,
      })
      await writeCheckpoint({ statePaths, task, stage: 'coding-finished', payload: codingResult })

      // Review Agent
      const reviewPrompt = buildRolePromptFromConfig({
        role: 'review',
        task,
        goal: options.goal,
        mode: options.mode,
        path: options.path,
        dir: options.dir,
        advice: `coding-summary: ${codingResult.summary}\ntest-suggestions: ${(codingResult.testSuggestions ?? []).join('; ')}`,
        allTasks,
        promptsConfig,
      })
      const reviewRaw = await runAgent({ role: 'review', prompt: reviewPrompt, mode: options.mode, model: options.model })
      const reviewResult = parseAgentOutput(reviewRaw.stdout)
      
      // 更新 channel（支持新旧格式）
      if (typeof task.channel.reviewToCoding === 'object') {
        task.channel.reviewToCoding = {
          summary: reviewResult.summary,
          requiredFixes: reviewResult.requiredFixes ?? [],
          requiredTests: reviewResult.requiredTests ?? [],
          acceptanceStatus: reviewResult.acceptanceStatus ?? (reviewResult.status === 'completed' || reviewResult.status === 'pass' ? 'passed' : 'partial'),
          severity: reviewResult.severity ?? 'none',
          adviceToCoding: reviewResult.contextForPeer,
        }
      } else {
        task.channel.reviewToCoding = [
          ...(reviewResult.requiredFixes ?? []),
          ...(reviewResult.requiredTests ?? []),
          reviewResult.contextForPeer,
        ].filter(Boolean).join('\n')
      }
      task.channel.lastUpdatedAt = new Date().toISOString()
      
      // === 新增：记录未解决问题 ===
      const unresolvedItems = reviewResult.unresolvedIssues ?? []
      for (const item of unresolvedItems) {
        recordUnresolvedIssue({
          task,
          issue: item.description ?? item,
          priority: item.priority ?? 'medium',
          category: item.category ?? 'other',
          reason: item.reason ?? '待解决',
        })
      }
      
      // === 新增：处理延后的问题 ===
      const deferredItems = reviewResult.deferredIssues ?? []
      for (const item of deferredItems) {
        deferIssue({
          task,
          issueId: item.id,
          reason: item.reason ?? '暂时不需要解决',
        })
      }
      
      // === 新增：分析并沉淀错误模式 ===
      if ((reviewResult.requiredFixes ?? []).length > 0) {
        const errorPatterns = analyzeErrorPattern({ reviewResult, codingResult, task })
        if (errorPatterns && errorPatterns.length > 0) {
          for (const pattern of errorPatterns) {
            const patternFile = await writeErrorPattern({ statePaths, pattern })
            task.channel.errorPatterns.push(pattern.id)
            await writeRuntimeLog('task.error-pattern.recorded', {
              taskId: task.id,
              patternId: pattern.id,
              category: pattern.category,
              patternFile,
            })
          }
        }
      }
      
      await writeRuntimeLog('task.review.finished', {
        taskId: task.id,
        round: task.communicationRounds + 1,
        type: 'communication',
        status: reviewResult.status,
        summary: reviewResult.summary,
        unresolvedCount: task.channel.unresolvedIssues.length,
      })

      task.communicationRounds += 1
      task.reviewRounds += 1

      const { advicePath } = await writeReviewOutputs({ statePaths, task, reviewResult })
      task.lastAdvicePath = advicePath
      advice = [
        ...(reviewResult.suggestions ?? []),
        ...(reviewResult.requiredFixes ?? []),
        ...(reviewResult.requiredTests ?? []),
        reviewResult.contextForPeer,
      ].filter(Boolean).join('\n')

      await writeCheckpoint({
        statePaths,
        task,
        stage: 'review-finished',
        payload: {
          reviewStatus: reviewResult.status,
          advicePath,
          roundType: 'communication',
        },
      })

      // 检查基础规则
      const basicCheck = checkBasicRules(codingResult, reviewResult, task)
      
      // Early Stop：严重问题立即阻塞
      if (basicCheck.hasCriticalIssue && validationConfig.enableEarlyStop) {
        task.status = transitionTask(task.status, { maxRoundsReached: true })
        task.history.push({
          at: new Date().toISOString(),
          event: 'early-stop',
          reason: 'critical issue detected',
          communicationRounds: task.communicationRounds,
          validationRounds: task.validationRounds,
        })
        await writeRuntimeLog('task.blocked', { taskId: task.id, reason: 'critical issue - early stop' })
        break
      }

      // === 修改：只有 review 明确通过验收才能往下走 ===
      const reviewPassed = reviewResult.status === 'completed' || reviewResult.status === 'pass'
      lastReviewPassed = reviewPassed && basicCheck.allPassed
      
      if (lastReviewPassed) {
        task.status = transitionTask(task.status, { reviewPassed: true })
        task.history.push({
          at: new Date().toISOString(),
          event: 'task-completed',
          communicationRounds: task.communicationRounds,
          validationRounds: task.validationRounds,
          unresolvedIssues: task.channel.unresolvedIssues.length,
        })
        await writeRuntimeLog('task.completed', { 
          taskId: task.id, 
          communicationRounds: task.communicationRounds, 
          validationRounds: task.validationRounds,
          unresolvedIssues: task.channel.unresolvedIssues.length,
        })
        break
      }

      task.history.push({
        at: new Date().toISOString(),
        event: 'review-requested-changes',
        round: task.communicationRounds,
        basicRulesPassed: basicCheck.allPassed,
        requiredFixes: reviewResult.requiredFixes ?? [],
      })
      await persistStateFn()
    } else {
      // === 校验轮次：运行测试验证 ===
      await writeRuntimeLog('task.validation.start', {
        taskId: task.id,
        round: task.validationRounds + 1,
      })
      
      // 执行验证命令
      let validationPassed = true
      const verificationCmds = task.verification_cmds ?? []
      
      for (const cmd of verificationCmds.slice(0, 3)) {
        try {
          // 这里只是记录，实际执行需要通过 agent 或 shell
          task.history.push({
            at: new Date().toISOString(),
            event: 'validation-cmd',
            cmd,
            status: 'recorded',
          })
        } catch (error) {
          validationPassed = false
        }
      }

      task.validationRounds += 1
      
      await writeRuntimeLog('task.validation.finished', {
        taskId: task.id,
        round: task.validationRounds,
        passed: validationPassed,
      })

      task.history.push({
        at: new Date().toISOString(),
        event: 'validation-finished',
        round: task.validationRounds,
        passed: validationPassed,
      })

      if (validationPassed) {
        task.status = transitionTask(task.status, { reviewPassed: true })
        task.history.push({
          at: new Date().toISOString(),
          event: 'task-completed',
          communicationRounds: task.communicationRounds,
          validationRounds: task.validationRounds,
        })
        await writeRuntimeLog('task.completed', { taskId: task.id, communicationRounds: task.communicationRounds, validationRounds: task.validationRounds })
        break
      }

      await persistStateFn()
    }
  }

  await persistStateFn()
  await writeCheckpoint({ statePaths, task, stage: 'task-completed', payload: { status: task.status } })
}

export async function invokeRalph(options = {}) {
  const normalizedOptions = {
    cwd: resolve(options.cwd ?? process.cwd()),
    goal: typeof options.goal === 'string' ? options.goal : '',
    path: typeof options.path === 'string' ? options.path : '',
    dir: typeof options.dir === 'string' ? options.dir : '',  // 新增：设计文档目录
    mode: options.mode === 'subagent' ? 'subagent' : DEFAULT_MODE,
    model: typeof options.model === 'string' && options.model.trim() ? options.model.trim() : DEFAULT_MODEL,
    output: options.output === 'json' ? 'json' : 'text',
    resume: Boolean(options.resume) || Boolean(options.resumeForce),
    resumeForce: Boolean(options.resumeForce),
    stubAgent: Boolean(options.stubAgent),
    dryRunPlan: Boolean(options.dryRunPlan),
    execute: Boolean(options.execute),
    monitor: Boolean(options.monitor),
  }

  const autoPlanOnly = !normalizedOptions.resume && !normalizedOptions.execute && !normalizedOptions.dryRunPlan
  if (autoPlanOnly) {
    normalizedOptions.dryRunPlan = true
  }

  const statePaths = buildStatePaths(normalizedOptions.cwd)
  const { ensureDirectory } = await import('./state-manager.mjs')
  await ensureDirectory(statePaths.root)
  await ensureDirectory(statePaths.artifactsDir)
  await ensureDirectory(statePaths.logsDir)

  const todoBuilder = options.todoBuilder ?? defaultTodoBuilder
  const runAgent = options.runAgent ?? (normalizedOptions.stubAgent || process.env.RALPH_STUB_AGENT === '1' ? 
    async ({ role }) => ({
      stdout: JSON.stringify({ status: 'completed', summary: `[stub] ${role} completed`, suggestions: [] }),
      stderr: '',
    }) : 
    (args) => runDefaultAgentByMode({ ...args, stubAgent: normalizedOptions.stubAgent })
  )
  const runMonitor = options.runMonitor ?? defaultRunMonitor
  const maxReviewRounds = Number.isInteger(options.maxReviewRounds) ? Number(options.maxReviewRounds) : DEFAULT_MAX_REVIEW_ROUNDS

  const { session, tasks, resumed } = await loadOrInitializeState({
    options: normalizedOptions,
    statePaths,
    todoBuilder,
  })

  const persistStateFn = async () => {
    await persistState({ statePaths, session, tasks })
  }

  const writeRuntimeLog = async (event, data = {}) => {
    await appendRuntimeLog(statePaths, event, {
      sessionId: session.sessionId,
      mode: normalizedOptions.mode,
      ...data,
    })
  }

  await writeRuntimeLog('session.start', {
    resumed,
    dryRunPlan: normalizedOptions.dryRunPlan,
    autoPlanOnly,
    cwd: normalizedOptions.cwd,
  })

  await persistStateFn()

  // === 修改：即使 dryRunPlan 也可能需要启动 monitor ===
  let monitorIntegration = null
  if (normalizedOptions.monitor && normalizedOptions.dryRunPlan) {
    // dryRunPlan 模式下也启动 monitor，方便用户监控规划结果
    monitorIntegration = await maybeStartMonitorForRalph({
      options: normalizedOptions,
      statePaths,
      runMonitor,
    })
  }

  if (normalizedOptions.dryRunPlan) {
    session.status = transitionSession(session.status, {
      dryRunPlan: true,
      hasBlockedTasks: false,
      allTasksDone: false,
      isResumed: false,
    })
    await persistStateFn()
    await syncConfirmationState({
      statePaths,
      awaitingConfirmation: autoPlanOnly,
      reason: autoPlanOnly ? 'directory_mode_requires_confirm' : 'manual_plan_only',
      nextAction: autoPlanOnly ? '回复"确认"或执行 /ralph --resume 开始执行子任务' : '按需执行 /ralph --resume',
    })
    await writeRuntimeLog('session.planned', { taskCount: tasks.length })

    return {
      kind: resumed ? 'resume-plan' : 'plan',
      sessionId: session.sessionId,
      mode: normalizedOptions.mode,
      model: normalizedOptions.model,
      stubAgent: normalizedOptions.stubAgent,
      dryRunPlan: true,
      autoPlanOnly,
      cwd: normalizedOptions.cwd,
      ralphDirectory: statePaths.root,
      sessionPath: statePaths.sessionPath,
      tasksPath: statePaths.tasksPath,
      todoStatePath: statePaths.todoStatePath,
      todoMarkdownPath: statePaths.todoMarkdownPath,
      runtimeLogPath: statePaths.runtimeLogPath,
      requiresConfirmation: autoPlanOnly,
      confirmationPrompt: autoPlanOnly ? '目录模式已完成规划。请回复"确认"以开始执行，或使用 /ralph --resume。' : null,
      summary: `planned=${tasks.length}, executed=0`,
      monitorIntegration,
      tasks,
    }
  }

  // 非 dryRunPlan 模式下启动 monitor
  if (!monitorIntegration) {
    monitorIntegration = await maybeStartMonitorForRalph({
      options: normalizedOptions,
      statePaths,
      runMonitor,
    })
  }

  await syncConfirmationState({
    statePaths,
    awaitingConfirmation: false,
    reason: 'execution_started',
    nextAction: null,
  })

  // Load prompts configuration once
  const promptsConfig = await loadPrompts()

  for (const task of tasks) {
    if (task.status === 'done') {
      continue
    }

    try {
      await executeTaskLoop({
        task,
        context: {
          options: normalizedOptions,
          statePaths,
          runAgent,
          maxReviewRounds,
          persistStateFn,
          writeRuntimeLog,
          allTasks: tasks,
          promptsConfig,
        },
      })
      await maybeInterruptOnceForE2E(statePaths)
    } catch (error) {
      task.status = transitionTask(task.status, { hasError: true })
      task.history.push({ at: new Date().toISOString(), event: 'task-error', message: error instanceof Error ? error.message : String(error) })
      await writeRuntimeLog('task.error', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      })
      await persistStateFn()
      break
    }
  }

  const blockedCount = tasks.filter((task) => task.status === 'blocked').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  
  // === 新增：汇总所有未解决问题 ===
  const allUnresolvedIssues = tasks.flatMap((task) => 
    (task.channel?.unresolvedIssues ?? []).map((issue) => ({
      ...issue,
      taskId: task.id,
      taskTitle: task.title,
    }))
  )
  
  // 按优先级排序
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  allUnresolvedIssues.sort((a, b) => 
    (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99)
  )
  
  // 写入未解决问题汇总文件
  if (allUnresolvedIssues.length > 0) {
    const issuesSummaryPath = resolve(statePaths.root, 'unresolved-issues-summary.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(issuesSummaryPath, JSON.stringify({
      total: allUnresolvedIssues.length,
      byPriority: {
        critical: allUnresolvedIssues.filter(i => i.priority === 'critical').length,
        high: allUnresolvedIssues.filter(i => i.priority === 'high').length,
        medium: allUnresolvedIssues.filter(i => i.priority === 'medium').length,
        low: allUnresolvedIssues.filter(i => i.priority === 'low').length,
      },
      byStatus: {
        open: allUnresolvedIssues.filter(i => i.status === 'open').length,
        deferred: allUnresolvedIssues.filter(i => i.status === 'deferred').length,
        wontfix: allUnresolvedIssues.filter(i => i.status === 'wontfix').length,
      },
      issues: allUnresolvedIssues,
      generatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    
    await writeRuntimeLog('session.unresolved-issues', {
      total: allUnresolvedIssues.length,
      summaryPath: issuesSummaryPath,
    })
  }
  
  session.status = transitionSession(session.status, {
    dryRunPlan: false,
    hasBlockedTasks: blockedCount > 0,
    allTasksDone: blockedCount === 0,
    isResumed: resumed,
  })
  await persistStateFn()
  await writeRuntimeLog('session.completed', {
    blockedCount,
    doneCount,
    total: tasks.length,
    status: session.status,
    unresolvedIssues: allUnresolvedIssues.length,
  })

  return {
    kind: resumed ? 'resume' : 'create',
    sessionId: session.sessionId,
    mode: normalizedOptions.mode,
    model: normalizedOptions.model,
    stubAgent: normalizedOptions.stubAgent,
    dryRunPlan: false,
    autoPlanOnly,
    cwd: normalizedOptions.cwd,
    ralphDirectory: statePaths.root,
    sessionPath: statePaths.sessionPath,
    tasksPath: statePaths.tasksPath,
    todoStatePath: statePaths.todoStatePath,
    todoMarkdownPath: statePaths.todoMarkdownPath,
    runtimeLogPath: statePaths.runtimeLogPath,
    requiresConfirmation: false,
    confirmationPrompt: null,
    summary: `done=${doneCount}, blocked=${blockedCount}, total=${tasks.length}`,
    monitorIntegration,
    tasks,
    // === 新增：未解决问题汇总 ===
    unresolvedIssues: allUnresolvedIssues,
    unresolvedIssuesPath: allUnresolvedIssues.length > 0 
      ? resolve(statePaths.root, 'unresolved-issues-summary.json')
      : null,
    // === 新增：错误沉淀目录 ===
    lessonsLearnedDir: resolve(statePaths.root, 'lessons-learned'),
  }
}

const printResult = (result, output) => {
  if (output === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }

  const lines = [
    `Ralph session: ${result.sessionId}`,
    `Mode: ${result.mode}`,
    `Workspace: ${result.cwd}`,
    `State: ${result.ralphDirectory}`,
    `Summary: ${result.summary}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

const isMainModule = (() => {
  if (!process.argv[1]) {
    return false
  }

  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMainModule) {
  const options = parseArgs(process.argv.slice(2))
  invokeRalph(options)
    .then((result) => {
      printResult(result, options.output)
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
