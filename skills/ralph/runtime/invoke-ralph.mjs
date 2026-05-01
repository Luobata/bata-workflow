#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_MODE = 'independent'
const DEFAULT_MAX_REVIEW_ROUNDS = 3
const DEFAULT_MODEL = 'gpt-5.3-codex'

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

const parseArgs = (argv) => {
  const options = {
    cwd: process.cwd(),
    goal: '',
    path: '',
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

const toTaskId = () => `task-${crypto.randomUUID().slice(0, 8)}`

const inferVerificationCommands = (cwd) => {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name) => existsSync(resolve(workspace, name))

  if (has('package.json')) {
    return ['npm test', 'npm run build']
  }

  if (has('go.mod')) {
    return ['go test ./...']
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    return ['pytest']
  }

  if (has('Cargo.toml')) {
    return ['cargo test']
  }

  return ['echo "manual verification required"']
}

const inferE2ECommands = (cwd) => {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name) => existsSync(resolve(workspace, name))

  if (has('package.json')) {
    return ['npm run test:e2e', 'pnpm test:e2e']
  }

  if (has('go.mod')) {
    return ['go test ./... -run E2E']
  }

  if (has('pyproject.toml') || has('requirements.txt')) {
    return ['pytest -m e2e']
  }

  if (has('Cargo.toml')) {
    return ['cargo test e2e']
  }

  return ['(如项目有 e2e 套件，请在本子任务完成后执行)']
}

const collectPathInsights = async (basePath, options = {}) => {
  const maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : 8
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 2
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

const normalizeStringList = (value, fallback) => {
  if (!Array.isArray(value)) {
    return [...fallback]
  }

  const items = value
    .map((item) => String(item).trim())
    .filter(Boolean)

  return items.length > 0 ? items : [...fallback]
}

const DEFAULT_SCOPE_RULES = [
  '只处理当前子任务范围，不跨任务实现。',
  '不允许占位符实现，输出必须可验证。',
  '缺少关键上下文时返回 NEEDS_CONTEXT 并列出缺失信息。',
]

const DEFAULT_DELIVERABLES = [
  '本轮完成项与对应证据',
  '关键风险、限制与后续建议',
]

const DEFAULT_HANDOFF_CHECKLIST = [
  '总结已完成/未完成内容',
  '给下一角色提供最小充分上下文',
]

const DEFAULT_EXECUTION_HINTS = [
  '严格对齐当前功能点与 acceptance 执行。',
  '输出可复验证据，避免描述性空话。',
]

const buildScopedRules = ({ role, phase }) => {
  const shared = [...DEFAULT_SCOPE_RULES]

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

const buildExecutionHints = ({ title, phase, topic }) => {
  const target = String(topic || title || '').trim()
  const hints = []

  if (phase === 'analysis') {
    hints.push('将来源文档拆分为“可直接编码”的功能点，并标明依赖顺序。')
    hints.push('每个功能点至少包含输入、输出、边界条件三项定义。')
    hints.push('为后续实现任务补齐必要上下文，不留“待确认”占位。')
    return hints
  }

  if (phase === 'validation') {
    hints.push('逐条核对当前功能点 acceptance，不通过则明确 required_fixes。')
    hints.push('给出至少一条可执行 required_tests，避免“建议性”空话。')
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

const buildCompletionDefinition = ({ title, phase, topic }) => {
  const target = String(topic || title || '').trim()

  if (phase === 'analysis') {
    return '拆解结果可直接驱动后续实现，不需要额外澄清。'
  }

  if (phase === 'validation') {
    return '给出通过/阻塞结论，且 required_fixes/required_tests 可直接执行。'
  }

  return `完成“${target}”的实现与说明，并可被 review 直接验证。`
}

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

const clamp = (value, min, max) => {
  return Math.max(min, Math.min(max, value))
}

const estimatePathTopicLimit = ({ insights, topics }) => {
  const fileCount = Array.isArray(insights) ? insights.length : 0
  const headingCount = (insights ?? []).reduce((sum, item) => sum + (item.headings?.length ?? 0), 0)
  const checklistCount = (insights ?? []).reduce((sum, item) => sum + (item.keyPoints?.length ?? 0), 0)
  const summaryCount = (insights ?? []).reduce((sum, item) => sum + (item.summary?.length ?? 0), 0)

  const complexityScore = fileCount * 2 + headingCount * 1.5 + checklistCount * 1 + summaryCount * 0.5
  const predictedLimit = Math.ceil(6 + complexityScore / 3)
  const softLimit = clamp(predictedLimit, 3, 36)
  return Math.min((topics ?? []).length, softLimit)
}

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

const normalizeTask = (task, index, previousTaskId = null) => {
  const title = typeof task?.title === 'string' && task.title.trim() ? task.title.trim() : `子任务${index + 1}`
  const defaultAcceptance = [`完成: ${title}`, '输出可验证结果，不留占位符']
  const defaultVerificationCommands = ['echo "manual verification required"']
  const depsFromTask = Array.isArray(task?.deps) ? task.deps : Array.isArray(task?.dependsOn) ? task.dependsOn : []
  const deps = normalizeStringList(depsFromTask, previousTaskId ? [previousTaskId] : [])

  return {
    id: typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : toTaskId(),
    title,
    status: typeof task?.status === 'string' ? task.status : 'pending',
    reviewRounds: Number.isInteger(task?.reviewRounds) ? Number(task.reviewRounds) : 0,
    lastAdvicePath: typeof task?.lastAdvicePath === 'string' ? task.lastAdvicePath : null,
    history: Array.isArray(task?.history) ? task.history : [],
    deps,
    acceptance: normalizeStringList(task?.acceptance, defaultAcceptance),
    verification_cmds: normalizeStringList(task?.verification_cmds, defaultVerificationCommands),
    deliverables: normalizeStringList(task?.deliverables, DEFAULT_DELIVERABLES),
    handoffChecklist: normalizeStringList(task?.handoffChecklist ?? task?.handoff_checklist, DEFAULT_HANDOFF_CHECKLIST),
    scopeRules: normalizeStringList(task?.scopeRules ?? task?.scope_rules, DEFAULT_SCOPE_RULES),
    executionHints: normalizeStringList(task?.executionHints ?? task?.execution_hints, DEFAULT_EXECUTION_HINTS),
    completionDefinition: String(task?.completionDefinition ?? task?.completion_definition ?? '完成当前子任务并满足验收标准。').trim(),
    backgroundContext: String(task?.backgroundContext ?? task?.background_context ?? '').trim(),
    sourceRefs: normalizeStringList(task?.sourceRefs ?? task?.source_refs, []),
    channel: {
      codingToReview: String(task?.channel?.codingToReview ?? '').trim(),
      reviewToCoding: String(task?.channel?.reviewToCoding ?? '').trim(),
      lastUpdatedAt: String(task?.channel?.lastUpdatedAt ?? '').trim() || null,
    },
  }
}

const normalizeTasks = (tasks) => {
  const normalized = []
  for (let index = 0; index < tasks.length; index += 1) {
    const previousTaskId = normalized[index - 1]?.id ?? null
    normalized.push(normalizeTask(tasks[index], index, previousTaskId))
  }
  return normalized
}

const buildGoalDrivenTasks = ({ normalizedGoal, verificationCommands, e2eCommands }) => {
  const fragments = normalizedGoal
    .split(/[，,。；;\n]/)
    .map((item) => item.trim())
    .filter(Boolean)

  const concreteFragments = fragments.length > 0 ? fragments : ['理解需求并拆解实现步骤']
  const topFragments = concreteFragments.slice(0, 3)
  const tasks = []

  const analysisTask = pushDetailedTask({
    tasks,
    title: `子任务1: 需求澄清与影响面分析（${topFragments[0]}）`,
    deps: [],
    phase: 'analysis',
    verificationCommands,
  })

  let previousTaskId = analysisTask.id

  for (let index = 0; index < topFragments.length; index += 1) {
    const fragment = topFragments[index]
    const implementationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 实现推进 - ${fragment}`,
      deps: [previousTaskId],
      phase: 'implementation',
      verificationCommands,
      topic: fragment,
    })

    const validationTask = pushDetailedTask({
      tasks,
      title: `子任务${tasks.length + 1}: 验证闭环 - ${fragment}`,
      deps: [implementationTask.id],
      phase: 'validation',
      verificationCommands,
      e2eCommands,
      topic: fragment,
    })

    previousTaskId = validationTask.id
  }

  pushDetailedTask({
    tasks,
    title: `子任务${tasks.length + 1}: 全局回归验证与e2e检查`,
    deps: [previousTaskId],
    phase: 'validation',
    verificationCommands,
    e2eCommands,
    topic: '全局回归验证',
  })

  return tasks
}

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

      // 过滤掉文档结构性标题（不是可执行任务的 heading）
      const STRUCTURAL_HEADINGS = /^(file structure|new files?|modified files?|old files?|files? to retire|overview|introduction|background|summary|table of contents|contents?|index)$/i
      const filteredHeadings = headings.filter((h) => !STRUCTURAL_HEADINGS.test(h.trim()))

      // keyPoints 过滤掉纯文件路径条目（含反引号路径、.ts/.js 后缀、斜杠路径）
      // 保留描述性文字（如 "Task 1: Add the test bata-workflow"）
      const filteredKeyPoints = keyPoints.filter((kp) =>
        !/^`[^`]+`/.test(kp) &&          // 排除 `path/to/file.ts` 格式
        !/^[-\w]+\/[-\w./]+/.test(kp) &&  // 排除 path/to/file 格式
        !/\.[jt]sx?$/.test(kp) &&         // 排除以 .ts/.js/.tsx/.jsx 结尾
        kp.length > 4                      // 排除太短的噪音
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

const defaultTodoBuilder = async ({ goal, path, cwd }) => {
  const normalizedGoal = typeof goal === 'string' ? goal.trim() : ''
  const inferredVerificationCommands = inferVerificationCommands(cwd)
  const inferredE2ECommands = inferE2ECommands(cwd)

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

const buildTodoSnapshotSection = ({ allTasks, currentTaskId }) => {
  const taskLines = (allTasks ?? []).map((item, index) => {
    const marker = item.id === currentTaskId ? ' <= current' : ''
    return `${index + 1}. [${item.status}] ${item.id} | ${item.title}${marker}`
  })

  const todoJson = {
    todos: (allTasks ?? []).map((item) => ({
      id: item.id,
      content: item.title,
      status: item.status === 'done' ? 'completed' : item.status === 'in_progress' ? 'in_progress' : 'pending',
      priority: 'high',
    })),
  }

  return [
    '全局 TODO 快照（执行前）：',
    ...(taskLines.length > 0 ? taskLines : ['- none']),
    '你必须在执行过程中使用 TodoWrite 同步进度：',
    `- 开始当前任务前，把 ${currentTaskId} 标记为 in_progress`,
    `- 当前任务完成后，把 ${currentTaskId} 标记为 completed`,
    '- 非当前任务保持 pending（除非已完成）',
    `TodoWrite 初始 payload 建议: ${JSON.stringify(todoJson)}`,
  ].join('\n')
}

const buildDependencyContextSection = ({ task, allTasks }) => {
  const all = Array.isArray(allTasks) ? allTasks : []
  const depTasks = all.filter((candidate) => (task.deps ?? []).includes(candidate.id))

  if (depTasks.length === 0) {
    return '上游依赖摘要:\n- none'
  }

  const lines = depTasks.map((dep) => {
    const summary = dep.channel?.codingToReview || dep.channel?.reviewToCoding || dep.history?.at(-1)?.summary || '无可用摘要'
    return `- ${dep.id} | ${dep.title} | status=${dep.status} | summary=${String(summary).replace(/\s+/g, ' ').slice(0, 240)}`
  })

  return ['上游依赖摘要:', ...lines].join('\n')
}

const buildRolePrompt = ({ role, task, goal, mode, path, advice, allTasks }) => {
  const roleInstruction = role === 'coding'
    ? '你是 coding agent。你只负责实现，不做最终评审结论。'
    : '你是 review agent。你只做审查并给出修改建议，不直接改代码。'

  const modeInstruction = mode === 'subagent'
    ? '如可用，请优先使用 coco 内置 subAgent 能力来拆分并执行子步骤。'
    : '请使用非交互执行风格，输出结构化结论。'

  const roleSpecificRules = role === 'review'
    ? [
      'Review Rules（仅针对当前子任务）:',
      '- 先检查是否严格满足当前子任务 acceptance，不要评审全量需求。',
      '- 检查是否过度实现（YAGNI）。',
      '- 至少给出一条测试建议：单测/集成/e2e（按项目上下文选择）。',
      '- 如果需要返工，明确 required_fixes 与 required_tests。',
      '- 必须检查 completionDefinition 是否满足，未满足则判定 needs_changes。',
      '- 按状态协议输出：DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED（或兼容 completed/needs_changes/failed）。',
    ].join('\n')
    : [
      'Coding Rules（仅针对当前子任务）:',
      '- 严格实现当前子任务，不扩展到其它任务。',
      '- 输出可执行的测试建议 test_suggestions（包含至少一条回归建议）。',
      '- 给 review 提供 context_for_peer，帮助下一轮审查。',
      '- 按状态协议输出：DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED（或兼容 completed/needs_changes/failed）。',
    ].join('\n')

  const adviceBlock = advice ? `\n上一轮 review 建议（必须优先处理）：\n${advice}\n` : ''
  const todoSnapshotBlock = buildTodoSnapshotSection({ allTasks, currentTaskId: task.id })
  const dependencyContextBlock = buildDependencyContextSection({ task, allTasks })

  return [
    roleInstruction,
    modeInstruction,
    roleSpecificRules,
    todoSnapshotBlock,
    dependencyContextBlock,
    `当前任务: ${task.title}`,
    `任务依赖: ${task.deps.length > 0 ? task.deps.join(', ') : 'none'}`,
    task.backgroundContext ? `背景上下文:\n${task.backgroundContext}` : '',
    `来源参考:\n- ${((task.sourceRefs ?? []).length > 0 ? task.sourceRefs : ['(none)']).join('\n- ')}`,
    `验收标准:\n- ${task.acceptance.join('\n- ')}`,
    `建议验证命令:\n- ${task.verification_cmds.join('\n- ')}`,
    `交付物（deliverables）:\n- ${(task.deliverables ?? DEFAULT_DELIVERABLES).join('\n- ')}`,
    `交接清单（handoffChecklist）:\n- ${(task.handoffChecklist ?? DEFAULT_HANDOFF_CHECKLIST).join('\n- ')}`,
    `范围规则（scopeRules）:\n- ${(task.scopeRules ?? DEFAULT_SCOPE_RULES).join('\n- ')}`,
    `执行要点（executionHints）:\n- ${(task.executionHints ?? DEFAULT_EXECUTION_HINTS).join('\n- ')}`,
    `完成定义（completionDefinition）:\n${task.completionDefinition || '完成当前子任务并满足验收标准。'}`,
    goal ? `用户目标: ${goal}` : '',
    path ? `目标目录: ${path}` : '',
    adviceBlock,
    `与对端通信上下文:\n- codingToReview: ${task.channel?.codingToReview || '(none)'}\n- reviewToCoding: ${task.channel?.reviewToCoding || '(none)'}`,
    '请输出 JSON：{"status":"DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|completed|needs_changes|failed","summary":"...","suggestions":["..."],"test_suggestions":["..."],"required_tests":["..."],"required_fixes":["..."],"context_for_peer":"..."}',
    '注意：请只处理当前子任务，不要把其它子任务混入本轮实现/审查。'
  ].filter(Boolean).join('\n')
}

const runIndependentCocoAgent = async ({ role, prompt, mode, model }) => {
  const modelName = model || DEFAULT_MODEL
  const args = ['-c', `model.name=${modelName}`, '--yolo', '--query-timeout', '120s', prompt]
  return await runInteractiveCocoAgent({ role, mode, args })
}

const stripTerminalControl = (raw) => {
  return raw
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
}

const isPtyChromeLine = (line) => {
  const trimmed = line.trim()
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('╭') ||
    trimmed.startsWith('╰') ||
    trimmed.startsWith('│ >') ||
    trimmed.startsWith('$/!') ||
    trimmed.startsWith('⬡ ') ||
    trimmed.startsWith('initializing MCP servers') ||
    trimmed.startsWith('upgrading') ||
    trimmed.includes('Thinking...') ||
    trimmed.startsWith('Thought')
  )
}

const extractPtyAssistantOutput = (raw) => {
  const cleaned = stripTerminalControl(raw)
  const lines = cleaned.split('\n')
  const blocks = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const markerIndex = line.indexOf('⏺')
    if (markerIndex < 0) {
      continue
    }

    const block = []
    const firstLine = line.slice(markerIndex + 1).trim()
    if (firstLine) {
      block.push(firstLine)
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const continuation = lines[cursor]
      if (continuation.includes('⏺') || isPtyChromeLine(continuation)) {
        break
      }

      const trimmed = continuation.trim()
      if (trimmed) {
        block.push(trimmed)
      }
    }

    if (block.length > 0) {
      blocks.push(block)
    }
  }

  const lastBlock = blocks.at(-1)
  if (!lastBlock) {
    return cleaned.trim()
  }

  const compact = lastBlock.join('').trim()
  if (compact.startsWith('{') || compact.startsWith('[')) {
    return compact
  }

  return lastBlock.join(' ').replace(/\s+/g, ' ').trim()
}

const runInteractiveCocoAgent = async ({ role, mode, args }) => {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('python3', [
      '-c',
      String.raw`import os, pty, select, subprocess, sys, time

timeout_sec = float(sys.argv[1])
args = sys.argv[2:]
master, slave = pty.openpty()
proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

chunks = []
start = time.time()
last_output = start
response_seen = False

while True:
    now = time.time()
    if now - start > timeout_sec:
        break

    readable, _, _ = select.select([master], [], [], 0.2)
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break

        if not data:
            break

        chunks.append(data)
        last_output = time.time()

        if b'\xe2\x8f\xba' in data or b'{"status' in data or b'"summary"' in data:
            response_seen = True

    if proc.poll() is not None:
        break

    if response_seen and now - last_output > 1.0:
        break

if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

sys.stdout.buffer.write(b''.join(chunks))`,
      '130',
      'coco',
      ...args,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RALPH_ROLE: role,
        RALPH_MODE: mode,
        RALPH_AGENT_KIND: mode.includes('subagent') ? 'subagent' : 'independent',
      },
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => rejectPromise(error))
    child.on('close', (code) => {
      if (code === 0) {
        const normalized = extractPtyAssistantOutput(stdout)
        resolvePromise({ stdout: normalized, stderr: stderr.trim() })
        return
      }
      rejectPromise(new Error(stderr.trim() || extractPtyAssistantOutput(stdout) || `coco exited with code ${code}`))
    })
  })
}

const runSubagentCocoAgent = async ({ role, prompt, mode, model }) => {
  const subagentPrompt = [
    '请优先使用 coco 内置 Agent/subAgent 能力完成当前角色目标；若超时可直接给出结构化结果。',
    '如果当前角色是 review，请使用独立 reviewer 子代理进行代码审查并返回结构化结论。',
    prompt,
  ].join('\n\n')

  const modelName = model || DEFAULT_MODEL
  const args = ['-c', `model.name=${modelName}`, '--yolo', '--query-timeout', '120s', subagentPrompt]
  return await runInteractiveCocoAgent({ role, mode, args })
}

const runDefaultAgentByMode = async ({ role, prompt, mode, model }) => {
  if (mode === 'subagent') {
    try {
      return await runSubagentCocoAgent({ role, prompt, mode, model })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const timeoutLike = /deadline exceeded|timed out|timeout/i.test(message)
      if (!timeoutLike) {
        throw error
      }

      // Fallback: keep role separation but avoid subagent deadlock.
      return await runIndependentCocoAgent({ role, prompt, mode: 'independent-fallback', model })
    }
  }

  return await runIndependentCocoAgent({ role, prompt, mode, model })
}

const runStubAgent = async ({ role, mode }) => {
  const base = {
    status: 'completed',
    summary: `[stub] ${role} completed in ${mode}`,
    suggestions: [],
  }

  if (role === 'review') {
    base.suggestions = ['[stub] review建议: 在正式运行时补充更严格的断言和边界验证。']
  }

  return {
    stdout: JSON.stringify(base),
    stderr: '',
  }
}

const normalizeAgentStatus = (statusValue) => {
  const rawStatus = String(statusValue ?? '').trim()
  const normalized = rawStatus.toLowerCase()

  if (normalized === 'done' || normalized === 'completed' || normalized === 'pass') {
    return 'completed'
  }

  if (normalized === 'done_with_concerns' || normalized === 'needs_changes' || normalized === 'changes_requested') {
    return 'needs_changes'
  }

  if (normalized === 'needs_context') {
    return 'needs_changes'
  }

  if (normalized === 'blocked' || normalized === 'failed' || normalized === 'error') {
    return 'failed'
  }

  return rawStatus || 'completed'
}

const parseAgentOutput = (raw) => {
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
    return { status, summary, suggestions, testSuggestions, requiredTests, requiredFixes, contextForPeer }
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

const buildStatePaths = (cwd) => {
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

const appendRuntimeLog = async (statePaths, event, data = {}) => {
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

const renderTodoMarkdown = ({ session, tasks }) => {
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
    ...tasks.map((task) => `| ${task.id} | ${task.status} | ${task.title} | ${task.deps.join(', ') || 'none'} | ${task.reviewRounds} |`),
    '',
  ]

  return `${lines.join('\n')}\n`
}

const syncTodoFiles = async ({ statePaths, session, tasks }) => {
  const todoState = {
    sessionId: session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      deps: [...task.deps],
      reviewRounds: task.reviewRounds,
      lastAdvicePath: task.lastAdvicePath,
      acceptance: [...task.acceptance],
      verification_cmds: [...task.verification_cmds],
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

const syncConfirmationState = async ({ statePaths, awaitingConfirmation, reason, nextAction }) => {
  await writeJson(statePaths.confirmationStatePath, {
    awaitingConfirmation,
    reason,
    nextAction,
    updatedAt: nowIso(),
  })
}

const maybeInterruptOnceForE2E = async (statePaths) => {
  if (process.env.RALPH_TEST_INTERRUPT_ONCE !== '1') {
    return
  }

  const markerPath = resolve(statePaths.root, 'interrupt-once.marker')
  if (existsSync(markerPath)) {
    return
  }

  await writeFile(markerPath, `${nowIso()}\n`, 'utf8')
  throw new Error('simulated one-time interruption for e2e')
}

const loadOrInitializeState = async ({ options, statePaths, todoBuilder }) => {
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
    const tasks = normalizeTasks(await readJson(statePaths.tasksPath))
    const recoveredTasks = tasks.map((task) => (
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

  if (!options.goal.trim() && !options.path.trim()) {
    throw new Error('请提供 --goal 或 --path，或者使用 --resume')
  }

  const tasks = normalizeTasks(await todoBuilder({ goal: options.goal, path: options.path, cwd: options.cwd }))
  const session = {
    sessionId: `ralph:${crypto.randomUUID()}`,
    cwd: options.cwd,
    goal: options.goal,
    path: options.path,
    mode: options.mode,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }

  return { session, tasks, resumed: false }
}

const writeCheckpoint = async ({ statePaths, task, stage, payload }) => {
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

const writeReviewOutputs = async ({ statePaths, task, reviewResult }) => {
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

const executeTaskLoop = async ({ task, context }) => {
  const {
    options,
    statePaths,
    runAgent,
    maxReviewRounds,
    persistState,
    writeRuntimeLog,
    allTasks,
  } = context

  task.status = 'in_progress'
  task.history.push({ at: nowIso(), event: 'task-start' })
  await writeRuntimeLog('task.start', { taskId: task.id, title: task.title })
  await persistState()
  await writeCheckpoint({ statePaths, task, stage: 'task-start', payload: { status: task.status } })

  let advice = ''

  for (let round = 1; round <= maxReviewRounds; round += 1) {
    const codingPrompt = buildRolePrompt({
      role: 'coding',
      task,
      goal: options.goal,
      mode: options.mode,
      path: options.path,
      advice,
      allTasks,
    })

    const codingRaw = await runAgent({ role: 'coding', prompt: codingPrompt, mode: options.mode, model: options.model })
    const codingResult = parseAgentOutput(codingRaw.stdout)
    task.channel.codingToReview = [
      codingResult.summary,
      ...codingResult.testSuggestions,
      codingResult.contextForPeer,
    ].filter(Boolean).join('\n')
    task.channel.lastUpdatedAt = nowIso()
    await writeRuntimeLog('task.coding.finished', { taskId: task.id, round, status: codingResult.status, summary: codingResult.summary })
    task.history.push({ at: nowIso(), event: 'coding-finished', round, summary: codingResult.summary })
    await writeCheckpoint({ statePaths, task, stage: 'coding-finished', payload: codingResult })

    const reviewPrompt = buildRolePrompt({
      role: 'review',
      task,
      goal: options.goal,
      mode: options.mode,
      path: options.path,
      advice: `coding-summary: ${codingResult.summary}`,
      allTasks,
    })
    const reviewRaw = await runAgent({ role: 'review', prompt: reviewPrompt, mode: options.mode, model: options.model })
    const reviewResult = parseAgentOutput(reviewRaw.stdout)
    task.channel.reviewToCoding = [
      ...reviewResult.requiredFixes,
      ...reviewResult.requiredTests,
      reviewResult.contextForPeer,
    ].filter(Boolean).join('\n')
    task.channel.lastUpdatedAt = nowIso()
    await writeRuntimeLog('task.review.finished', { taskId: task.id, round, status: reviewResult.status, summary: reviewResult.summary })
    task.reviewRounds = round

    const { advicePath } = await writeReviewOutputs({ statePaths, task, reviewResult })
    task.lastAdvicePath = advicePath
    advice = [
      ...reviewResult.suggestions,
      ...reviewResult.requiredFixes,
      ...reviewResult.requiredTests,
      reviewResult.contextForPeer,
    ].filter(Boolean).join('\n')

    await writeCheckpoint({
      statePaths,
      task,
      stage: 'review-finished',
      payload: {
        reviewStatus: reviewResult.status,
        advicePath,
      },
    })

    const reviewPassed = reviewResult.status === 'completed' || reviewResult.status === 'pass'
    if (reviewPassed) {
      task.status = 'done'
      task.history.push({ at: nowIso(), event: 'task-completed', round })
      await writeRuntimeLog('task.completed', { taskId: task.id, round })
      await persistState()
      await writeCheckpoint({ statePaths, task, stage: 'task-completed', payload: { reviewStatus: reviewResult.status } })
      return
    }

    task.history.push({ at: nowIso(), event: 'review-requested-changes', round })
    await persistState()
  }

  task.status = 'blocked'
  task.history.push({ at: nowIso(), event: 'task-blocked', reason: 'max review rounds reached' })
  await writeRuntimeLog('task.blocked', { taskId: task.id, reason: 'max review rounds reached' })
  await persistState()
  await writeCheckpoint({ statePaths, task, stage: 'task-blocked', payload: { reason: 'max review rounds reached' } })
}

export async function invokeRalph(options = {}) {
  const normalizedOptions = {
    cwd: resolve(options.cwd ?? process.cwd()),
    goal: typeof options.goal === 'string' ? options.goal : '',
    path: typeof options.path === 'string' ? options.path : '',
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

  // 默认安全模式：除非明确传 --execute 或 --resume，否则只做规划不执行
  // 这样即使 agent 忘记加 --dryRunPlan，也不会意外触发 coding/review 循环
  const autoPlanOnly = !normalizedOptions.resume && !normalizedOptions.execute && !normalizedOptions.dryRunPlan
  if (autoPlanOnly) {
    normalizedOptions.dryRunPlan = true
  }

  const statePaths = buildStatePaths(normalizedOptions.cwd)
  await ensureDirectory(statePaths.root)
  await ensureDirectory(statePaths.artifactsDir)
  await ensureDirectory(statePaths.logsDir)

  const todoBuilder = options.todoBuilder ?? defaultTodoBuilder
  const runAgent = options.runAgent ?? (normalizedOptions.stubAgent || process.env.RALPH_STUB_AGENT === '1' ? runStubAgent : runDefaultAgentByMode)
  const runMonitor = options.runMonitor ?? defaultRunMonitor
  const maxReviewRounds = Number.isInteger(options.maxReviewRounds) ? Number(options.maxReviewRounds) : DEFAULT_MAX_REVIEW_ROUNDS

  const { session, tasks, resumed } = await loadOrInitializeState({
    options: normalizedOptions,
    statePaths,
    todoBuilder,
  })

  const persistState = async () => {
    session.updatedAt = nowIso()
    await writeJson(statePaths.sessionPath, session)
    await writeJson(statePaths.tasksPath, tasks)
    await syncTodoFiles({ statePaths, session, tasks })
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

  await persistState()

  if (normalizedOptions.dryRunPlan) {
    session.status = 'planned'
    await persistState()
    await syncConfirmationState({
      statePaths,
      awaitingConfirmation: autoPlanOnly,
      reason: autoPlanOnly ? 'directory_mode_requires_confirm' : 'manual_plan_only',
      nextAction: autoPlanOnly ? '回复“确认”或执行 /ralph --resume 开始执行子任务' : '按需执行 /ralph --resume',
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
      confirmationPrompt: autoPlanOnly ? '目录模式已完成规划。请回复“确认”以开始执行，或使用 /ralph --resume。' : null,
      summary: `planned=${tasks.length}, executed=0`,
      monitorIntegration: null,
      tasks,
    }
  }

  const monitorIntegration = await maybeStartMonitorForRalph({
    options: normalizedOptions,
    statePaths,
    runMonitor,
  })

  await syncConfirmationState({
    statePaths,
    awaitingConfirmation: false,
    reason: 'execution_started',
    nextAction: null,
  })

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
          persistState,
          writeRuntimeLog,
          allTasks: tasks,
        },
      })
      await maybeInterruptOnceForE2E(statePaths)
    } catch (error) {
      task.status = 'blocked'
      task.history.push({ at: nowIso(), event: 'task-error', message: error instanceof Error ? error.message : String(error) })
      await writeRuntimeLog('task.error', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      })
      await persistState()
      break
    }
  }

  const blockedCount = tasks.filter((task) => task.status === 'blocked').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  session.status = blockedCount > 0 ? 'partial' : 'completed'
  await persistState()
  await writeRuntimeLog('session.completed', {
    blockedCount,
    doneCount,
    total: tasks.length,
    status: session.status,
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
