#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import crypto from 'node:crypto'
import { inferVerificationCommands, inferE2ECommands, loadVerificationRules } from './config-loader.mjs'
import { normalizeTasks } from '../src/protocol/schemas/task-contract.mjs'

const toTaskId = () => `task-${crypto.randomUUID().slice(0, 8)}`

/**
 * Collect Path Insights - 收集路径洞察
 */
const collectPathInsights = async (basePath, options = {}) => {
  // 增强扫描限制：支持更深层次扫描
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 32  // 从 8 提升到 32
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 4   // 从 2 提升到 4
  const result = []

  const visit = async (directoryPath, depth) => {
    if (result.length >= maxFiles || depth > maxDepth) {
      return
    }

    let entries = []
    try {
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (result.length >= maxFiles) {
        break
      }

      const entryPath = resolve(directoryPath, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue
        }
        await visit(entryPath, depth + 1)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      if (!/\.(md|mdx|txt|ya?ml|json)$/i.test(entry.name)) {
        continue
      }

      try {
        const content = await readFile(entryPath, 'utf8')
        const lines = content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        const headings = content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => /^#{1,3}\s+/.test(line))
          .slice(0, 6)
          .map((line) => line.replace(/^#{1,3}\s+/, '').trim())

        const keyPoints = lines
          .filter((line) => /^-\s+\[.\]\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
          .map((line) => line.replace(/^-\s+\[.\]\s+/, '').replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
          .filter(Boolean)
          .slice(0, 30)

        const summary = lines
          .filter((line) => !/^#{1,3}\s+/.test(line) && !/^-\s+\[.\]\s+/.test(line) && !/^[-*]\s+/.test(line) && !/^\d+\.\s+/.test(line))
          .slice(0, 3)

        const topicCandidates = [...headings, ...keyPoints].filter(Boolean)

        result.push({
          file: entryPath,
          headings,
          keyPoints,
          summary,
          topicCandidates,
        })
      } catch {
        // ignore unreadable files
      }
    }
  }

  await visit(basePath, 0)
  return result
}

/**
 * Create Ordered Unique Topics - 创建有序唯一主题列表
 */
const createOrderedUniqueTopics = (candidates, limit = Number.POSITIVE_INFINITY) => {
  const seen = new Set()
  const topics = []

  for (const candidate of candidates) {
    const cleaned = String(candidate ?? '')
      .replace(/[：:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!cleaned || cleaned.length < 2) {
      continue
    }

    const key = cleaned.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    topics.push(cleaned)
    if (topics.length >= limit) {
      break
    }
  }

  return topics
}

/**
 * Build Path Context Summary - 构建路径上下文摘要
 */
const buildPathContextSummary = ({ path, insights }) => {
  const topFiles = (insights ?? []).slice(0, 8)
  const fileLines = topFiles.map((item) => {
    const heading = (item.headings ?? []).slice(0, 2).join(' / ') || 'no-headings'
    const keyPointCount = item.keyPoints?.length ?? 0
    return `- ${item.file} :: ${heading} (关键步骤: ${keyPointCount})`
  })

  return [
    `目标路径: ${path}`,
    '来源文档概览:',
    ...(fileLines.length > 0 ? fileLines : ['- (no source files detected)']),
    `文档复杂度摘要: files=${(insights ?? []).length}, headings=${(insights ?? []).reduce((sum, item) => sum + (item.headings?.length ?? 0), 0)}, checklist_items=${(insights ?? []).reduce((sum, item) => sum + (item.keyPoints?.length ?? 0), 0)}`,
  ].join('\n')
}

/**
 * Estimate Path Topic Limit - 估算路径主题数量上限
 */
const estimatePathTopicLimit = ({ insights, topics }) => {
  const fileCount = Array.isArray(insights) ? insights.length : 0
  const headingCount = (insights ?? []).reduce((sum, item) => sum + (item.headings?.length ?? 0), 0)
  const checklistCount = (insights ?? []).reduce((sum, item) => sum + (item.keyPoints?.length ?? 0), 0)
  const summaryCount = (insights ?? []).reduce((sum, item) => sum + (item.summary?.length ?? 0), 0)

  const complexityScore = fileCount * 2 + headingCount * 1.5 + checklistCount * 1 + summaryCount * 0.5
  const predictedLimit = Math.ceil(6 + complexityScore / 3)
  const softLimit = Math.max(3, Math.min(predictedLimit, 36))
  return Math.min((topics ?? []).length, softLimit)
}

/**
 * Default Todo Builder - 默认任务构建器
 */
export const defaultTodoBuilder = async ({ goal, path, dir, cwd }) => {
  const normalizedGoal = typeof goal === 'string' ? goal.trim() : ''
  const verificationConfig = await loadVerificationRules()
  const inferredVerificationCommands = inferVerificationCommands(cwd, verificationConfig)
  const inferredE2ECommands = inferE2ECommands(cwd, verificationConfig)

  // 新增：处理 --dir 参数（设计文档目录）
  if (dir) {
    const dirTasks = await buildDirDrivenTasks({
      dir,
      cwd,
      verificationCommands: inferredVerificationCommands,
      e2eCommands: inferredE2ECommands,
    })
    return normalizeTasks(dirTasks)
  }

  if (path) {
    const pathTasks = await buildPathDrivenTasks({
      path,
      cwd,
      verificationCommands: inferredVerificationCommands,
      e2eCommands: inferredE2ECommands,
    })
    return normalizeTasks(pathTasks)
  }

  const goalTasks = buildGoalDrivenTasks({
    normalizedGoal,
    verificationCommands: inferredVerificationCommands,
    e2eCommands: inferredE2ECommands,
  })
  return normalizeTasks(goalTasks)
}

/**
 * Assess Goal Complexity - 评估目标复杂度
 * 
 * 根据描述长度、分句数量、关键词等评估复杂度
 * 返回: 'simple' | 'medium' | 'complex'
 */
const assessGoalComplexity = (goal) => {
  if (!goal || goal.trim().length === 0) {
    return 'simple'
  }

  const trimmedGoal = goal.trim()
  
  // 1. 字数评估
  const charCount = trimmedGoal.length
  
  // 2. 分句数量
  const fragments = trimmedGoal
    .split(/[，,。；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const fragmentCount = fragments.length
  
  // 3. 关键词检测
  const complexityKeywords = [
    /重构|refactor/i,
    /架构|architecture/i,
    /性能优化|optimize|performance/i,
    /集成|integrate/i,
    /多模块|multi-module/i,
    /微服务|microservice/i,
    /安全|security/i,
    /并发|concurrent/i,
    /分布式|distributed/i,
  ]
  const hasComplexKeywords = complexityKeywords.some(pattern => pattern.test(trimmedGoal))
  
  // 4. 技术术语检测
  const techTerms = [
    /api|接口/i,
    /database|数据库/i,
    /cache|缓存/i,
    /queue|队列/i,
    /protocol|协议/i,
    /algorithm|算法/i,
  ]
  const techTermCount = techTerms.filter(pattern => pattern.test(trimmedGoal)).length
  
  // 5. 详细程度检测
  const hasDetails = /需要|要求|包括|包含|步骤|阶段|模块|组件|功能|特性/i.test(trimmedGoal)
  
  // 综合评估
  let score = 0
  
  // 字数评分
  if (charCount > 200) score += 3
  else if (charCount > 100) score += 2
  else if (charCount > 50) score += 1
  
  // 分句评分
  if (fragmentCount >= 5) score += 3
  else if (fragmentCount >= 3) score += 2
  else if (fragmentCount >= 2) score += 1
  
  // 关键词评分
  if (hasComplexKeywords) score += 2
  
  // 技术术语评分
  if (techTermCount >= 3) score += 2
  else if (techTermCount >= 1) score += 1
  
  // 详细程度评分
  if (hasDetails) score += 1
  
  // 返回复杂度等级
  if (score >= 8) return 'complex'
  if (score >= 4) return 'medium'
  return 'simple'
}

/**
 * Build Goal Driven Tasks - 构建目标驱动任务（带复杂度差异化）
 */
const buildGoalDrivenTasks = ({ normalizedGoal, verificationCommands, e2eCommands }) => {
  // 评估复杂度
  const complexity = assessGoalComplexity(normalizedGoal)
  
  const fragments = normalizedGoal
    .split(/[，,。；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)

  const concreteFragments = fragments.length > 0 ? fragments : ['理解需求并拆解实现步骤']
  
  // 根据复杂度调整任务数量
  let maxTopics = 3
  let includeAnalysisPhase = true
  let includeGlobalValidation = true
  let generateReviewContract = false
  
  switch (complexity) {
    case 'simple':
      maxTopics = Math.min(2, concreteFragments.length)
      includeAnalysisPhase = false  // 简单任务不需要分析阶段
      includeGlobalValidation = false  // 简单任务不需要全局验证
      generateReviewContract = false
      break
    case 'medium':
      maxTopics = Math.min(3, concreteFragments.length)
      includeAnalysisPhase = true
      includeGlobalValidation = true
      generateReviewContract = true
      break
    case 'complex':
      maxTopics = Math.min(5, concreteFragments.length)  // 复杂任务允许更多主题
      includeAnalysisPhase = true
      includeGlobalValidation = true
      generateReviewContract = true
      break
  }
  
  const topFragments = concreteFragments.slice(0, maxTopics)
  const tasks = []
  let previousTaskId = null

  // 分析阶段（仅中、复杂度任务）
  if (includeAnalysisPhase) {
    const analysisTask = pushDetailedTask({
      tasks,
      title: `子任务1: 需求澄清与影响面分析（${topFragments[0]}）`,
      deps: [],
      phase: 'analysis',
      verificationCommands,
    })
    previousTaskId = analysisTask.id
    
    // 为复杂任务生成 reviewContract
    if (generateReviewContract) {
      analysisTask.reviewContract = {
        reviewFocus: {
          primary: ['检查需求理解是否准确', '确认影响面分析是否完整'],
          secondary: ['识别潜在风险点'],
          riskAreas: ['需求理解偏差', '影响面遗漏'],
        },
        riskPoints: [
          { category: 'correctness', description: '需求理解偏差', severity: 'medium' },
        ],
        testRequirements: [
          { type: 'review', description: '需求确认', priority: 'must', relatedAcceptance: (analysisTask.acceptance ?? []).slice(0, 1) },
        ],
        acceptanceCriteria: (analysisTask.acceptance ?? []).map((acc, i) => ({
          id: `acc-${i + 1}`,
          description: acc,
          verification: 'review',
          priority: 'must',
        })),
        generatedAt: new Date().toISOString(),
      }
    }
  }

  // 实现阶段
  for (let index = 0; index < topFragments.length; index += 1) {
    const fragment = topFragments[index]
    const deps = previousTaskId ? [previousTaskId] : []
    
    const implementationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 实现推进 - ${fragment}`,
      deps,
      phase: 'implementation',
      verificationCommands,
      topic: fragment,
    })
    
    // 为中等/复杂任务生成 reviewContract
    if (generateReviewContract) {
      implementationTask.reviewContract = {
        reviewFocus: {
          primary: [`检查 ${fragment} 实现是否正确`],
          secondary: ['代码质量检查'],
          riskAreas: [],
        },
        riskPoints: [],
        testRequirements: [
          { type: 'unit', description: '单元测试', priority: 'must', relatedAcceptance: (implementationTask.acceptance ?? []).slice(0, 1) },
        ],
        acceptanceCriteria: (implementationTask.acceptance ?? []).map((acc, i) => ({
          id: `acc-${i + 1}`,
          description: acc,
          verification: 'review',
          priority: 'must',
        })),
        generatedAt: new Date().toISOString(),
      }
    }

    // 验证阶段（简单任务合并到实现任务中）
    if (complexity !== 'simple') {
      const validationTask = pushDetailedTask({
        tasks,
        title: `子任务${tasks.length + 1}: 验证闭环 - ${fragment}`,
        deps: [implementationTask.id],
        phase: 'validation',
        verificationCommands,
        e2eCommands,
        topic: fragment,
      })
      
      if (generateReviewContract) {
        validationTask.reviewContract = {
          reviewFocus: {
            primary: [`验证 ${fragment} 是否满足验收标准`],
            secondary: ['检查测试覆盖'],
            riskAreas: [],
          },
          riskPoints: [],
          testRequirements: [
            { type: 'unit', description: '单元测试', priority: 'must', relatedAcceptance: [] },
          ],
          acceptanceCriteria: (validationTask.acceptance ?? []).map((acc, i) => ({
            id: `acc-${i + 1}`,
            description: acc,
            verification: 'automated',
            priority: 'must',
          })),
          generatedAt: new Date().toISOString(),
        }
      }

      previousTaskId = validationTask.id
    } else {
      previousTaskId = implementationTask.id
    }
  }

  // 全局验证（仅中、复杂度任务）
  if (includeGlobalValidation && previousTaskId) {
    const finalTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 全局回归验证与e2e检查`,
      deps: [previousTaskId],
      phase: 'validation',
      verificationCommands,
      e2eCommands,
      topic: '全局回归验证',
    })
    
    if (generateReviewContract) {
      finalTask.reviewContract = {
        reviewFocus: {
          primary: ['全局功能验证', '回归测试'],
          secondary: ['性能检查'],
          riskAreas: ['回归问题', '性能退化'],
        },
        riskPoints: [
          { category: 'correctness', description: '回归问题', severity: 'medium' },
        ],
        testRequirements: [
          { type: 'integration', description: '集成测试', priority: 'must', relatedAcceptance: [] },
        ],
        acceptanceCriteria: (finalTask.acceptance ?? []).map((acc, i) => ({
          id: `acc-${i + 1}`,
          description: acc,
          verification: 'automated',
          priority: 'must',
        })),
        generatedAt: new Date().toISOString(),
      }
    }
  }

  return tasks
}

/**
 * Build Path Driven Tasks - 构建路径驱动任务
 */
const buildPathDrivenTasks = async ({ path, cwd, verificationCommands, e2eCommands }) => {
  const resolvedPath = resolve(cwd ?? process.cwd(), path)
  const insights = []

  try {
    const fileStat = await stat(resolvedPath)
    if (fileStat.isDirectory()) {
      insights.push(...(await collectPathInsights(resolvedPath)))
    } else {
      const content = await readFile(resolvedPath, 'utf8').catch(() => '')
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const headings = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^#{1,3}\s+/.test(line))
        .slice(0, 6)
        .map((line) => line.replace(/^#{1,3}\s+/, '').trim())
      const keyPoints = lines
        .filter((line) => /^-\s+\[.\]\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
        .map((line) => line.replace(/^-\s+\[.\]\s+/, '').replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 30)
      const summary = lines
        .filter((line) => !/^#{1,3}\s+/.test(line) && !/^-\s+\[.\]\s+/.test(line) && !/^[-*]\s+/.test(line) && !/^\d+\.\s+/.test(line))
        .slice(0, 3)
      const topicCandidates = [...headings, ...keyPoints].filter(Boolean)
      insights.push({ file: resolvedPath, headings, keyPoints, summary, topicCandidates })
    }
  } catch {
    // keep fallback tasks
  }

  const keyTopics = createOrderedUniqueTopics(
    insights.flatMap((item) => {
      const headings = item.headings ?? []
      const keyPoints = item.keyPoints ?? []

      const STRUCTURAL_HEADINGS = /^(file structure|new files?|modified files?|old files?|files? to retire|overview|introduction|background|summary|table of contents|contents?|index)$/i
      const filteredHeadings = headings.filter((h) => !STRUCTURAL_HEADINGS.test(h.trim()))

      const filteredKeyPoints = keyPoints.filter((kp) =>
        !/^`[^`]+`/.test(kp) &&
        !/^[-\w]+\/[-\w./]+/.test(kp) &&
        !/\.[jt]sx?$/.test(kp) &&
        kp.length > 4
      )

      return [...filteredHeadings, ...filteredKeyPoints]
    }),
    80,
  )

  const fallbackTopics = [
    `梳理 ${path} 中的需求点与依赖`,
    `按模块推进 ${path} 的 coding 与 review`,
    `补齐 ${path} 的测试建议与e2e核查`,
  ]

  const topics = keyTopics.length > 0 ? keyTopics : fallbackTopics
  const tasks = []
  const pathContextSummary = buildPathContextSummary({ path, insights })
  const sourceFiles = createOrderedUniqueTopics(insights.map((item) => item.file), 12)
  const recommendedTopicLimit = estimatePathTopicLimit({ insights, topics })

  const analysisTask = pushDetailedTask({
    tasks,
    title: `子任务1: 目录解析与任务映射（${path}）`,
    deps: [],
    phase: 'analysis',
    verificationCommands,
    backgroundContext: [
      '请先把技术方案拆成可执行功能点，并形成顺序依赖链。',
      `当前自动判断建议功能点数量: ${recommendedTopicLimit}。若你识别到遗漏，可在实现总结中补充。`,
      '要求覆盖来源文档中的核心章节与步骤，不允许只实现其中一小部分。',
      pathContextSummary,
    ].join('\n\n'),
    sourceRefs: sourceFiles,
  })

  let previousTaskId = analysisTask.id

  const executionTopics = topics.slice(0, recommendedTopicLimit)
  executionTopics.forEach((topic) => {
    const implementationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 目录实现推进 - ${topic}`,
      deps: [previousTaskId],
      phase: 'implementation',
      verificationCommands,
      topic,
      backgroundContext: [
        `当前功能点: ${topic}`,
        '该任务必须只实现当前功能点，不跳步、不跨功能点。',
        '优先复用上游任务输出；若缺少上下文，返回 NEEDS_CONTEXT。',
        '必须对齐来源技术方案，避免按个人假设实现。',
        pathContextSummary,
      ].join('\n\n'),
      sourceRefs: sourceFiles,
    })

    const validationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 目录验证闭环 - ${topic}`,
      deps: [implementationTask.id],
      phase: 'validation',
      verificationCommands,
      e2eCommands,
      topic,
      backgroundContext: [
        `当前验证点: ${topic}`,
        '请基于实现结果给出通过/阻塞结论、required_fixes 与 required_tests。',
        'review 必须引用来源文档与上游实现上下文，避免误判。',
        '如果发现实现偏离方案，必须在 required_fixes 中明确指出偏差位置。',
        pathContextSummary,
      ].join('\n\n'),
      sourceRefs: sourceFiles,
    })

    previousTaskId = validationTask.id
  })

  pushDetailedTask({
    tasks,
    title: `子任务${tasks.length + 1}: 全量回归与e2e建议校验`,
    deps: [previousTaskId],
    phase: 'validation',
    verificationCommands,
    e2eCommands,
    topic: `目录 ${path} 全量回归`,
    backgroundContext: [
      '执行全链路收敛验证：确认所有功能点均已覆盖并闭环。',
      '输出总体通过率、阻塞项、残留风险和后续建议。',
      pathContextSummary,
    ].join('\n\n'),
    sourceRefs: sourceFiles,
  })

  return tasks
}

/**
 * Push Detailed Task - 添加详细任务
 */
const pushDetailedTask = ({
  tasks,
  title,
  deps,
  phase,
  verificationCommands,
  e2eCommands = [],
  topic,
  backgroundContext = '',
  sourceRefs = [],
}) => {
  const contract = buildTaskContract({
    title,
    phase,
    verificationCommands,
    e2eCommands,
    topic,
  })
  const executionHints = buildExecutionHints({ title, phase, topic })
  const completionDefinition = buildCompletionDefinition({ title, phase, topic })

  const task = {
    id: toTaskId(),
    title,
    status: 'pending',
    reviewRounds: 0,
    lastAdvicePath: null,
    history: [],
    deps: [...deps],
    acceptance: contract.acceptance,
    verification_cmds: contract.verification_cmds,
    deliverables: contract.deliverables,
    handoffChecklist: contract.handoffChecklist,
    scopeRules: contract.scopeRules,
    executionHints,
    completionDefinition,
    backgroundContext: String(backgroundContext || '').trim(),
    sourceRefs: normalizeStringList(sourceRefs, []),
  }

  tasks.push(task)
  return task
}

/**
 * Build Task Contract - 构建任务契约
 */
const buildTaskContract = ({ title, phase, verificationCommands, e2eCommands = [], topic }) => {
  if (phase === 'analysis') {
    return {
      acceptance: [
        `完成分析: ${title}`,
        '明确输入/输出、约束边界与依赖关系',
        '形成可执行子任务链（实现→验证）',
      ],
      verification_cmds: ['echo "verify decomposition quality"'],
      deliverables: [
        '任务拆解与依赖链说明',
        '风险清单与执行顺序建议',
      ],
      handoffChecklist: [
        '为实现任务提供明确执行边界',
        '标注必须验证的重点场景',
      ],
      scopeRules: buildScopedRules({ role: 'coding', phase }),
    }
  }

  if (phase === 'validation') {
    return {
      acceptance: [
        `验证完成: ${topic || title}`,
        '覆盖关键回归场景并给出结果',
        '给出通过/阻塞判定与后续建议',
      ],
      verification_cmds: [...verificationCommands, ...e2eCommands],
      deliverables: [
        '验证记录（命令、结果、失败点）',
        '阻塞项与修复优先级建议',
      ],
      handoffChecklist: [
        '列出 required_tests 与 required_fixes',
        '输出可复现问题的最小步骤',
      ],
      scopeRules: buildScopedRules({ role: 'review', phase }),
    }
  }

  return {
    acceptance: [
      `完成子目标: ${topic || title}`,
      '提交实现说明、风险与回滚点',
      '提供可执行测试建议',
    ],
    verification_cmds: [...verificationCommands],
    deliverables: [
      '代码改动摘要与关键设计说明',
      '测试建议与回归关注点',
    ],
    handoffChecklist: [
      '为 review 提供 context_for_peer',
      '列出本轮未完成但已识别的风险',
    ],
    scopeRules: buildScopedRules({ role: 'coding', phase }),
  }
}

/**
 * Build Scoped Rules - 构建范围规则
 */
const buildScopedRules = ({ role, phase }) => {
  const shared = [
    '只处理当前子任务范围，不跨任务实现。',
    '不允许占位符实现，输出必须可验证。',
    '缺少关键上下文时返回 NEEDS_CONTEXT 并列出缺失信息。',
  ]

  if (role === 'review') {
    shared.push('仅审查当前子任务，不扩展到全局需求。')
  }

  if (role === 'coding') {
    shared.push('只按当前子任务 acceptance 实现，不做额外重构。')
  }

  if (phase === 'analysis') {
    shared.push('输出必须可直接用于后续子任务执行。')
  }

  if (phase === 'validation') {
    shared.push('优先给出验证结论与失败定位线索。')
  }

  return shared
}

/**
 * Build Execution Hints - 构建执行提示
 */
const buildExecutionHints = ({ title, phase, topic }) => {
  const target = String(topic || title || '').trim()
  const hints = []

  if (phase === 'analysis') {
    hints.push('将来源文档拆分为"可直接编码"的功能点，并标明依赖顺序。')
    hints.push('每个功能点至少包含输入、输出、边界条件三项定义。')
    hints.push('为后续实现任务补齐必要上下文，不留"待确认"占位。')
    return hints
  }

  if (phase === 'validation') {
    hints.push('逐条核对当前功能点 acceptance，不通过则明确 required_fixes。')
    hints.push('给出至少一条可执行 required_tests，避免"建议性"空话。')
    hints.push('若实现与来源方案不一致，标注偏差点与影响范围。')
    return hints
  }

  if (/test|测试|spec|vitest|jest/i.test(target)) {
    hints.push('优先补齐失败测试场景，再补通过路径。')
  }

  if (/types|interface|schema|类型/i.test(target)) {
    hints.push('先确定类型边界，再实现调用方与被调用方的一致性。')
  }

  if (/render|layout|clip|dirty|occlusion|cache|command|backend/i.test(target)) {
    hints.push('先实现主路径，再补边界条件与性能相关保护。')
  }

  if (/`[^`]+`/.test(target)) {
    hints.push('优先按目标文件落地改动，并在总结中说明变更点。')
  }

  hints.push('输出可复验的实现说明，明确哪些 acceptance 已覆盖。')
  return hints.slice(0, 4)
}

/**
 * Build Completion Definition - 构建完成定义
 */
const buildCompletionDefinition = ({ title, phase, topic }) => {
  const target = String(topic || title || '').trim()

  if (phase === 'analysis') {
    return '拆解结果可直接驱动后续实现，不需要额外澄清。'
  }

  if (phase === 'validation') {
    return '给出通过/阻塞结论，且 required_fixes/required_tests 可直接执行。'
  }

  return `完成"${target}"的实现与说明，并可被 review 直接验证。`
}

/**
 * Normalize String List - 归一化字符串列表
 */
const normalizeStringList = (value, fallback) => {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const items = value
    .map((item) => String(item).trim())
    .filter(Boolean)

  return items.length > 0 ? items : [...fallback]
}

/**
 * Generate Review Contract - 生成审查契约
 */
const generateReviewContract = ({ task, insights, sourceDocument }) => {
  // 从 insights 中提取审查重点
  const allHeadings = (insights ?? []).flatMap((item) => item.headings ?? [])
  const allKeyPoints = (insights ?? []).flatMap((item) => item.keyPoints ?? [])

  // 主要审查点：从标题中提取
  const primaryReviewFocus = allHeadings
    .filter((h) => h.length > 3)
    .slice(0, 5)
    .map((h) => `检查 ${h} 的实现是否满足要求`)

  // 次要审查点：从关键点中提取
  const secondaryReviewFocus = allKeyPoints
    .filter((kp) => kp.length > 5)
    .slice(0, 5)
    .map((kp) => `确认 ${kp}`)

  // 风险区域：基于任务类型推断
  const riskAreas = []
  const taskTitle = (task?.title ?? '').toLowerCase()
  if (/test|测试|spec/i.test(taskTitle)) {
    riskAreas.push('测试覆盖不全', '边界条件遗漏')
  }
  if (/api|接口|backend/i.test(taskTitle)) {
    riskAreas.push('错误处理缺失', '并发安全问题')
  }
  if (/ui|组件|component/i.test(taskTitle)) {
    riskAreas.push('样式兼容性问题', '交互状态遗漏')
  }
  if (/performance|性能|optimize/i.test(taskTitle)) {
    riskAreas.push('性能回归风险', '内存泄漏风险')
  }

  // 风险点
  const riskPoints = riskAreas.slice(0, 3).map((area) => ({
    category: 'correctness',
    description: area,
    severity: 'medium',
  }))

  // 测试要求
  const testRequirements = [
    {
      type: 'unit',
      description: '核心逻辑单元测试',
      priority: 'must',
      relatedAcceptance: (task?.acceptance ?? []).slice(0, 1),
    },
  ]

  if ((task?.verification_cmds ?? []).length > 0) {
    testRequirements.push({
      type: 'integration',
      description: '集成测试验证',
      priority: 'should',
      relatedAcceptance: (task?.acceptance ?? []).slice(1, 2),
    })
  }

  // 验收标准
  const acceptanceCriteria = (task?.acceptance ?? []).map((acc, index) => ({
    id: `acc-${index + 1}`,
    description: acc,
    verification: 'review',
    priority: 'must',
  }))

  return {
    reviewFocus: {
      primary: primaryReviewFocus.length > 0 ? primaryReviewFocus : ['检查实现是否满足验收标准'],
      secondary: secondaryReviewFocus,
      riskAreas,
    },
    riskPoints,
    testRequirements,
    acceptanceCriteria,
    generatedAt: new Date().toISOString(),
    sourceDocument,
  }
}

/**
 * Build Dir Driven Tasks - 构建目录驱动任务（语义分析）
 */
const buildDirDrivenTasks = async ({ dir, cwd, verificationCommands, e2eCommands }) => {
  const resolvedDir = resolve(cwd ?? process.cwd(), dir)

  // Step 1: 使用增强限制扫描目录
  const insights = await collectPathInsights(resolvedDir, {
    maxFiles: 32,
    maxDepth: 4,
  })

  // Step 2: 提取主题（与 path 模式共用逻辑）
  const keyTopics = createOrderedUniqueTopics(
    insights.flatMap((item) => {
      const headings = item.headings ?? []
      const keyPoints = item.keyPoints ?? []

      const STRUCTURAL_HEADINGS = /^(file structure|new files?|modified files?|old files?|files? to retire|overview|introduction|background|summary|table of contents|contents?|index)$/i
      const filteredHeadings = headings.filter((h) => !STRUCTURAL_HEADINGS.test(h.trim()))

      const filteredKeyPoints = keyPoints.filter((kp) =>
        !/^`[^`]+`/.test(kp) &&
        !/^[-\w]+\/[-\w./]+/.test(kp) &&
        !/\.[jt]sx?$/.test(kp) &&
        kp.length > 4
      )

      return [...filteredHeadings, ...filteredKeyPoints]
    }),
    80,
  )

  const fallbackTopics = [
    `梳理 ${dir} 中的需求点与依赖`,
    `按模块推进 ${dir} 的 coding 与 review`,
    `补齐 ${dir} 的测试建议与e2e核查`,
  ]

  const topics = keyTopics.length > 0 ? keyTopics : fallbackTopics
  const tasks = []
  const pathContextSummary = buildPathContextSummary({ path: dir, insights })
  const sourceFiles = createOrderedUniqueTopics(insights.map((item) => item.file), 12)
  const recommendedTopicLimit = estimatePathTopicLimit({ insights, topics })

  // Step 3: Analysis 任务
  const analysisTask = pushDetailedTask({
    tasks,
    title: `子任务1: 目录解析与任务映射（${dir}）`,
    deps: [],
    phase: 'analysis',
    verificationCommands,
    backgroundContext: [
      '请先把技术方案拆成可执行功能点，并形成顺序依赖链。',
      `当前自动判断建议功能点数量: ${recommendedTopicLimit}。若你识别到遗漏，可在实现总结中补充。`,
      '要求覆盖来源文档中的核心章节与步骤，不允许只实现其中一小部分。',
      pathContextSummary,
    ].join('\n\n'),
    sourceRefs: sourceFiles,
  })

  // 为 analysis 任务生成 reviewContract
  analysisTask.reviewContract = generateReviewContract({
    task: analysisTask,
    insights,
    sourceDocument: resolvedDir,
  })

  let previousTaskId = analysisTask.id

  // Step 4: Implementation + Validation 任务对
  const executionTopics = topics.slice(0, recommendedTopicLimit)
  executionTopics.forEach((topic) => {
    const implementationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 目录实现推进 - ${topic}`,
      deps: [previousTaskId],
      phase: 'implementation',
      verificationCommands,
      topic,
      backgroundContext: [
        `当前功能点: ${topic}`,
        '该任务必须只实现当前功能点，不跳步、不跨功能点。',
        '优先复用上游任务输出；若缺少上下文，返回 NEEDS_CONTEXT。',
        '必须对齐来源技术方案，避免按个人假设实现。',
        pathContextSummary,
      ].join('\n\n'),
      sourceRefs: sourceFiles,
    })

    // 为 implementation 任务生成 reviewContract
    implementationTask.reviewContract = generateReviewContract({
      task: implementationTask,
      insights,
      sourceDocument: resolvedDir,
    })

    const validationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 目录验证闭环 - ${topic}`,
      deps: [implementationTask.id],
      phase: 'validation',
      verificationCommands,
      e2eCommands,
      topic,
      backgroundContext: [
        `当前验证点: ${topic}`,
        '请基于实现结果给出通过/阻塞结论、required_fixes 与 required_tests。',
        'review 必须引用来源文档与上游实现上下文，避免误判。',
        '如果发现实现偏离方案，必须在 required_fixes 中明确指出偏差位置。',
        pathContextSummary,
      ].join('\n\n'),
      sourceRefs: sourceFiles,
    })

    // 为 validation 任务生成 reviewContract
    validationTask.reviewContract = generateReviewContract({
      task: validationTask,
      insights,
      sourceDocument: resolvedDir,
    })

    previousTaskId = validationTask.id
  })

  // Step 5: 最终回归验证任务
  const finalTask = pushDetailedTask({
    tasks,
    title: `子任务${tasks.length + 1}: 全量回归与e2e建议校验`,
    deps: [previousTaskId],
    phase: 'validation',
    verificationCommands,
    e2eCommands,
    topic: `目录 ${dir} 全量回归`,
    backgroundContext: [
      '执行全链路收敛验证：确认所有功能点均已覆盖并闭环。',
      '输出总体通过率、阻塞项、残留风险和后续建议。',
      pathContextSummary,
    ].join('\n\n'),
    sourceRefs: sourceFiles,
  })

  finalTask.reviewContract = generateReviewContract({
    task: finalTask,
    insights,
    sourceDocument: resolvedDir,
  })

  return tasks
}
