#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

let cachedYamlParse = null

function findYamlModuleEntry(startDirectory) {
  let current = resolve(startDirectory)

  while (true) {
    const candidate = resolve(current, 'node_modules', 'yaml', 'dist', 'index.js')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = resolve(current, '..')
    if (parent === current) {
      return null
    }
    current = parent
  }
}

async function loadYamlParse() {
  if (cachedYamlParse) {
    return cachedYamlParse
  }

  try {
    const yamlModule = await import('yaml')
    if (typeof yamlModule.parse === 'function') {
      cachedYamlParse = yamlModule.parse
      return cachedYamlParse
    }
  } catch {
    // fall through to portable lookup
  }

  const searchRoots = [
    process.env.BATA_WORKFLOW_REPO_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
    resolve(fileURLToPath(import.meta.url), '..', '..', '..'),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0)

  for (const root of searchRoots) {
    const moduleEntry = findYamlModuleEntry(root)
    if (!moduleEntry) {
      continue
    }

    const yamlModule = await import(pathToFileURL(moduleEntry).href)
    if (typeof yamlModule.parse === 'function') {
      cachedYamlParse = yamlModule.parse
      return cachedYamlParse
    }
    if (typeof yamlModule.default?.parse === 'function') {
      cachedYamlParse = yamlModule.default.parse
      return cachedYamlParse
    }
  }

  throw new Error('yaml parser unavailable: 请确认 bata-workflow 依赖已安装，或为运行环境提供 node_modules/yaml')
}

function parseSimpleTaskYamlBlock(content) {
  const result = {}
  const lines = String(content ?? '').split('\n')
  let currentKey = null
  let blockKey = null

  for (const rawLine of lines) {
    if (!rawLine.trim()) {
      if (blockKey) {
        result[blockKey].push('')
      }
      continue
    }

    const keyValueMatch = rawLine.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (keyValueMatch && !rawLine.startsWith('  ')) {
      const [, key, rawValue] = keyValueMatch
      currentKey = key
      blockKey = null

      if (rawValue === '|') {
        result[key] = []
        blockKey = key
        continue
      }

      if (!rawValue) {
        result[key] = []
        continue
      }

      result[key] = rawValue.trim()
      continue
    }

    const listItemMatch = rawLine.match(/^\s*[-*]\s+(.+)$/)
    if (listItemMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = []
      }
      result[currentKey].push(listItemMatch[1].trim())
      continue
    }

    if (blockKey && /^\s+/.test(rawLine)) {
      result[blockKey].push(rawLine.replace(/^\s+/, ''))
    }
  }

  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && key === blockKey) {
      result[key] = value.join('\n').trim()
      continue
    }

    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      result[key] = value.filter((item) => item.length > 0)
    }
  }

  return result
}

/**
 * Load YAML Config - 加载YAML配置文件
 */
export async function loadYamlConfig(configPath) {
  const content = await readFile(configPath, 'utf8')
  const parseYaml = await loadYamlParse()
  return parseYaml(content)
}

/**
 * Load Rules From Directory - 从目录加载规则
 * 
 * 目录结构约定：
 * rules-dir/
 * ├── coding/
 * │   ├── typescript.md
 * │   ├── react.md
 * │   └── api-design.md
 * ├── review/
 * │   ├── code-quality.md
 * │   ├── security.md
 * │   └── performance.md
 * └── context.md  (可选，项目背景)
 * 
 * 每个规则文件格式：
 * - 规则1
 * - 规则2
 * - 规则3
 * 
 * 或者带标题：
 * # 规则名称
 * - 规则1
 * - 规则2
 */
export async function loadRulesFromDirectory(rulesDir, cwd) {
  const workspace = resolve(cwd ?? process.cwd())
  const rulesPath = resolve(workspace, rulesDir)
  
  if (!existsSync(rulesPath)) {
    return {
      codingRules: [],
      reviewRules: [],
      backgroundContext: '',
    }
  }
  
  const result = {
    codingRules: [],
    reviewRules: [],
    backgroundContext: '',
  }
  
  // 加载 coding 规则
  const codingDir = resolve(rulesPath, 'coding')
  if (existsSync(codingDir)) {
    result.codingRules = await loadRulesFromSubdirectory(codingDir)
  }
  
  // 加载 review 规则
  const reviewDir = resolve(rulesPath, 'review')
  if (existsSync(reviewDir)) {
    result.reviewRules = await loadRulesFromSubdirectory(reviewDir)
  }
  
  // 加载背景上下文
  const contextFile = resolve(rulesPath, 'context.md')
  if (existsSync(contextFile)) {
    try {
      const content = await readFile(contextFile, 'utf8')
      result.backgroundContext = parseRulesFile(content).join('\n')
    } catch {
      // ignore
    }
  }
  
  // 兼容旧结构：直接在根目录下的文件
  const legacyCodingFile = resolve(rulesPath, 'coding-rules.md')
  if (existsSync(legacyCodingFile)) {
    try {
      const content = await readFile(legacyCodingFile, 'utf8')
      result.codingRules.push(...parseRulesFile(content))
    } catch {
      // ignore
    }
  }
  
  const legacyReviewFile = resolve(rulesPath, 'review-rules.md')
  if (existsSync(legacyReviewFile)) {
    try {
      const content = await readFile(legacyReviewFile, 'utf8')
      result.reviewRules.push(...parseRulesFile(content))
    } catch {
      // ignore
    }
  }
  
  return result
}

/**
 * Load Rules From Subdirectory - 从子目录加载规则
 */
async function loadRulesFromSubdirectory(dirPath) {
  const rules = []
  
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.md$/i.test(entry.name)) continue
      
      const filePath = resolve(dirPath, entry.name)
      try {
        const content = await readFile(filePath, 'utf8')
        const fileRules = parseRulesFile(content)
        rules.push(...fileRules)
      } catch {
        // ignore unreadable files
      }
    }
  } catch {
    // ignore unreadable directories
  }
  
  return rules
}

/**
 * Parse Rules File - 解析规则文件
 * 
 * 支持两种格式：
 * 1. 简单列表：
 *    - 规则1
 *    - 规则2
 * 
 * 2. 带标题：
 *    # 规则名称
 *    - 规则1
 *    - 规则2
 */
function parseRulesFile(content) {
  const lines = content.split('\n')
  const rules = []
  
  for (const line of lines) {
    const trimmed = line.trim()
    
    // 跳过标题行
    if (trimmed.startsWith('#')) continue
    
    // 跳过空行
    if (!trimmed) continue
    
    // 解析列表项
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/)
    if (listMatch) {
      rules.push(listMatch[1].trim())
      continue
    }
    
    // 解析数字列表
    const numberMatch = trimmed.match(/^\d+[.、]\s+(.+)$/)
    if (numberMatch) {
      rules.push(numberMatch[1].trim())
      continue
    }
    
    // 如果是纯文本行（非列表格式），也作为规则
    if (trimmed.length > 5 && !trimmed.startsWith('```')) {
      rules.push(trimmed)
    }
  }
  
  return rules
}

/**
 * Build Knowledge Discovery Prompt - 构建知识发现 Prompt
 * 
 * 使用 LLM 判断是否需要沉淀规则
 */
export function buildKnowledgeDiscoveryPrompt({ existingRules, issues, taskTitle, filesModified }) {
  const existingRulesText = existingRules.length > 0
    ? existingRules.map((r, i) => `${i + 1}. ${r}`).join('\n')
    : '(暂无已有规则)'
  
  const issuesText = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')
  
  const filesText = filesModified.length > 0
    ? filesModified.join(', ')
    : '(未知)'
  
  return `
# 任务：知识发现

你是一个知识发现专家。请分析以下 Review 发现的问题，判断是否需要沉淀为可复用规则。

## 已有规则
${existingRulesText}

## 本次发现的问题
${issuesText}

## 任务上下文
- 任务标题：${taskTitle}
- 修改文件：${filesText}

## 判断标准

请对每个问题判断：
1. **通用性**：这个问题是否可能在其他地方重复出现？
   - 高：项目通用问题（如并发、安全、性能）
   - 中：模块特定问题
   - 低：一次性问题

2. **价值**：沉淀这条规则是否能避免未来问题？
   - 高：能避免严重bug或安全漏洞
   - 中：能提高代码质量
   - 低：影响较小

3. **独特性**：是否与已有规则重复或相似？
   - 完全重复：跳过
   - 高度相似：合并或跳过
   - 独特：添加

## 输出要求

返回 JSON 格式：
\`\`\`json
{
  "knowledgeEntries": [
    {
      "shouldAdd": true,
      "reason": "这是常见的并发问题，具有高通用性",
      "title": "状态更新并发安全",
      "description": "状态更新必须使用锁或原子操作，避免竞态条件",
      "category": "concurrency",
      "examples": {
        "wrong": "// 未加锁的状态更新\\nstate.count++",
        "right": "// 使用乐观锁\\nconst updated = await State.update({ id, count: state.count + 1, version: state.version })"
      },
      "confidence": "high",
      "relatedFiles": ["${filesText}"]
    }
  ]
}
\`\`\`

## 类别选项
- concurrency: 并发问题
- security: 安全问题
- performance: 性能问题
- correctness: 正确性问题
- maintainability: 可维护性问题

## 置信度选项
- high: 确定需要沉淀（通用性高 + 价值高 + 独特）
- medium: 建议沉淀
- low: 可选沉淀

请仔细分析，只沉淀真正有价值的规则。
`.trim()
}

/**
 * Load Knowledge Base - 加载知识库
 * 
 * 知识库结构：
 * knowledge-base/
 * ├── coding-rules/
 * ├── review-rules/
 * ├── business-rules/
 * └── adr/
 */
export async function loadKnowledgeBase(knowledgeDir, cwd) {
  const workspace = resolve(cwd ?? process.cwd())
  const knowledgePath = resolve(workspace, knowledgeDir)
  
  if (!existsSync(knowledgePath)) {
    return {
      codingRules: [],
      reviewRules: [],
      businessRules: [],
      adr: [],
    }
  }
  
  const result = {
    codingRules: [],
    reviewRules: [],
    businessRules: [],
    adr: [],
  }
  
  // 加载 coding 规则
  const codingDir = resolve(knowledgePath, 'coding-rules')
  if (existsSync(codingDir)) {
    result.codingRules = await loadRulesFromSubdirectory(codingDir)
  }
  
  // 加载 review 规则
  const reviewDir = resolve(knowledgePath, 'review-rules')
  if (existsSync(reviewDir)) {
    result.reviewRules = await loadRulesFromSubdirectory(reviewDir)
  }
  
  // 加载业务规则
  const businessDir = resolve(knowledgePath, 'business-rules')
  if (existsSync(businessDir)) {
    result.businessRules = await loadRulesFromSubdirectory(businessDir)
  }
  
  // 加载 ADR
  const adrDir = resolve(knowledgePath, 'adr')
  if (existsSync(adrDir)) {
    result.adr = await loadRulesFromSubdirectory(adrDir)
  }
  
  return result
}

/**
 * Check If Rule Exists - 检查规则是否已存在
 */
export function checkRuleExists(rules, newRule) {
  const normalizedNew = newRule.toLowerCase().trim()
  return rules.some(rule => {
    const normalizedExisting = rule.toLowerCase().trim()
    // 完全匹配或高度相似
    return normalizedExisting === normalizedNew ||
           normalizedExisting.includes(normalizedNew) ||
           normalizedNew.includes(normalizedExisting)
  })
}

/**
 * Generate Knowledge Entry - 生成知识条目
 */
export function generateKnowledgeEntry({ type, issue, fix, files, category }) {
  const timestamp = new Date().toISOString().split('T')[0]
  
  const entry = {
    type,  // 'coding_rule' | 'review_rule' | 'business_rule'
    content: {
      title: '',
      description: '',
      examples: [],
      relatedFiles: files || [],
    },
    metadata: {
      createdAt: timestamp,
      category: category || 'general',
      source: 'review_finding',
    },
  }
  
  // 根据类型生成不同格式
  if (type === 'review_rule') {
    entry.content.title = extractRuleTitle(issue)
    entry.content.description = `${issue}。${fix}`
    entry.content.examples = [{
      wrong: issue,
      right: fix,
    }]
  } else if (type === 'coding_rule') {
    entry.content.title = extractRuleTitle(fix)
    entry.content.description = fix
    entry.content.examples = [{
      right: fix,
    }]
  }
  
  return entry
}

/**
 * Extract Rule Title - 从问题/修复中提取规则标题
 */
function extractRuleTitle(text) {
  // 尝试提取关键词作为标题
  const keywords = text.match(/(\w+[\u4e00-\u9fa5]+\w*)/g)
  if (keywords && keywords.length > 0) {
    return keywords.slice(0, 3).join(' ')
  }
  
  // 截取前 30 个字符
  return text.slice(0, 30).trim()
}

/**
 * Format Knowledge Entry for File - 格式化知识条目用于写入文件
 */
export function formatKnowledgeEntry(entry) {
  const lines = []
  
  lines.push(`## [${entry.metadata.createdAt}] ${entry.content.title}`)
  lines.push('')
  lines.push(`- ${entry.content.description}`)
  
  if (entry.content.examples && entry.content.examples.length > 0) {
    lines.push('')
    for (const example of entry.content.examples) {
      if (example.wrong) {
        lines.push('```typescript')
        lines.push(`// ❌ 错误示例`)
        lines.push(example.wrong)
        lines.push('```')
      }
      if (example.right) {
        lines.push('```typescript')
        lines.push(`// ✅ 正确示例`)
        lines.push(example.right)
        lines.push('```')
      }
    }
  }
  
  if (entry.content.relatedFiles && entry.content.relatedFiles.length > 0) {
    lines.push('')
    lines.push(`**相关文件**: ${entry.content.relatedFiles.join(', ')}`)
  }
  
  lines.push('')
  return lines.join('\n')
}

/**
 * Suggest Knowledge Path - 建议知识条目保存路径
 */
export function suggestKnowledgePath(entry, knowledgeDir) {
  const typeDir = {
    'coding_rule': 'coding-rules',
    'review_rule': 'review-rules',
    'business_rule': 'business-rules',
  }[entry.type] || 'review-rules'
  
  const category = entry.metadata.category || 'general'
  
  return resolve(knowledgeDir, typeDir, `${category}.md`)
}

/**
 * Load Ralph Config - 加载项目级 Ralph 配置
 * 
 * 优先级：
 * 1. ralph.config.json
 * 2. .ralph/config.json
 * 3. package.json 中的 ralph 字段
 */
export async function loadRalphConfig(cwd) {
  const workspace = resolve(cwd ?? process.cwd())
  
  const configPaths = [
    resolve(workspace, 'ralph.config.json'),
    resolve(workspace, '.ralph/config.json'),
  ]
  
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = await readFile(configPath, 'utf8')
        const config = JSON.parse(content)
        
        // 如果配置了 rulesDir，从目录加载规则
        if (config.rulesDir) {
          const dirRules = await loadRulesFromDirectory(config.rulesDir, cwd)
          
          // 合并规则（配置文件中的规则 + 目录中的规则）
          config.codingRules = [
            ...(config.codingRules || []),
            ...dirRules.codingRules,
          ]
          config.reviewRules = [
            ...(config.reviewRules || []),
            ...dirRules.reviewRules,
          ]
          
          // 背景上下文合并
          if (dirRules.backgroundContext) {
            config.backgroundContext = config.backgroundContext
              ? `${config.backgroundContext}\n\n${dirRules.backgroundContext}`
              : dirRules.backgroundContext
          }
        }
        
        return config
      } catch {
        // continue to next path
      }
    }
  }
  
  // Try package.json
  const packageJsonPath = resolve(workspace, 'package.json')
  if (existsSync(packageJsonPath)) {
    try {
      const content = await readFile(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(content)
      if (packageJson.ralph) {
        return packageJson.ralph
      }
    } catch {
      // ignore
    }
  }
  
  return {}
}

/**
 * Parse Task-Level Config - 解析任务级配置
 * 
 * 从 Markdown 计划文件中提取 ralph-config 注释块
 * 
 * 格式：
 * <!-- ralph-config
 * codingRules:
 *   - 规则1
 * reviewRules:
 *   - 规则2
 * backgroundContext: |
 *   背景说明
 * -->
 */
export function parseTaskLevelConfig(markdownContent) {
  const configMatch = markdownContent.match(/<!--\s*ralph-config\s*([\s\S]*?)-->/)
  if (!configMatch) {
    return {}
  }
  
  try {
    return parseSimpleTaskYamlBlock(configMatch[1].trim())
  } catch {
    return {}
  }
}

/**
 * Merge Role Rules - 合并角色规则
 * 
 * 优先级：CLI > 任务级 > 项目配置 > 默认
 */
export function mergeRoleRules({ 
  defaultRules, 
  projectRules = [], 
  taskRules = [], 
  cliRules = [] 
}) {
  // CLI 规则优先级最高，直接覆盖
  if (cliRules.length > 0) {
    return [...defaultRules, ...cliRules]
  }
  
  // 任务级规则次之
  if (taskRules.length > 0) {
    return [...defaultRules, ...taskRules]
  }
  
  // 项目配置规则
  if (projectRules.length > 0) {
    return [...defaultRules, ...projectRules]
  }
  
  // 默认规则
  return [...defaultRules]
}

/**
 * Build Role Config - 构建角色配置
 * 
 * 合并所有来源的配置
 */
export function buildRoleConfig({ 
  role, 
  promptsConfig, 
  ralphConfig = {}, 
  taskConfig = {},
  cliConfig = {}
}) {
  const roleDefaults = promptsConfig.roles[role]
  if (!roleDefaults) {
    throw new Error(`Unknown role: ${role}`)
  }
  
  // Coding rules
  const codingRules = mergeRoleRules({
    defaultRules: role === 'coding' ? roleDefaults.rules : [],
    projectRules: ralphConfig.codingRules || [],
    taskRules: taskConfig.codingRules || [],
    cliRules: cliConfig.codingRules || [],
  })
  
  // Review rules
  const reviewRules = mergeRoleRules({
    defaultRules: role === 'review' ? roleDefaults.rules : [],
    projectRules: ralphConfig.reviewRules || [],
    taskRules: taskConfig.reviewRules || [],
    cliRules: cliConfig.reviewRules || [],
  })
  
  // Background context
  const backgroundContext = [
    cliConfig.backgroundContext || '',
    taskConfig.backgroundContext || '',
    ralphConfig.backgroundContext || '',
  ].filter(Boolean).join('\n\n')
  
  return {
    instruction: roleDefaults.instruction,
    rules: role === 'coding' ? codingRules : reviewRules,
    outputFormat: roleDefaults.outputFormat,
    backgroundContext: backgroundContext.trim(),
  }
}

/**
 * Build Role Prompt From Config - 从配置构建角色Prompt
 */
export function buildRolePromptFromConfig({ 
  role, 
  task, 
  goal, 
  mode, 
  path, 
  advice, 
  allTasks, 
  promptsConfig,
  ralphConfig = {},
  taskConfig = {},
  cliConfig = {}
}) {
  const roleConfig = buildRoleConfig({
    role,
    promptsConfig,
    ralphConfig,
    taskConfig,
    cliConfig,
  })
  
  const phaseConfig = task.phase ? promptsConfig.phases[task.phase] : null
  const defaults = promptsConfig.defaults

  const roleInstruction = roleConfig.instruction
  const modeInstruction = mode === 'subagent'
    ? '如可用，请优先使用 coco 内置 subAgent 能力来拆分并执行子步骤。'
    : '请使用非交互执行风格，输出结构化结论。'

  const roleSpecificRules = roleConfig.rules.map(rule => `- ${rule}`).join('\n')

  // Build TODO snapshot section
  const taskLines = (allTasks ?? []).map((item, index) => {
    const marker = item.id === task.id ? ' <= current' : ''
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

  const todoSnapshotBlock = [
    '全局 TODO 快照（执行前）：',
    ...(taskLines.length > 0 ? taskLines : ['- none']),
    '你必须在执行过程中使用 TodoWrite 同步进度：',
    `- 开始当前任务前，把 ${task.id} 标记为 in_progress`,
    `- 当前任务完成后，把 ${task.id} 标记为 completed`,
    '- 非当前任务保持 pending（除非已完成）',
    `TodoWrite 初始 payload 建议: ${JSON.stringify(todoJson)}`,
  ].join('\n')

  // Build dependency context section
  const depTasks = (allTasks ?? []).filter((candidate) => (task.deps ?? []).includes(candidate.id))
  const dependencyContextBlock = depTasks.length === 0
    ? '上游依赖摘要:\n- none'
    : [
        '上游依赖摘要:',
        ...depTasks.map((dep) => {
          const summary = dep.channel?.codingToReview || dep.channel?.reviewToCoding || dep.history?.at(-1)?.summary || '无可用摘要'
          return `- ${dep.id} | ${dep.title} | status=${dep.status} | summary=${String(summary).replace(/\s+/g, ' ').slice(0, 240)}`
        }),
      ].join('\n')

  const adviceBlock = advice ? `\n上一轮 review 建议（必须优先处理）：\n${advice}\n` : ''

  // Build phase-specific scope rules
  const scopeRules = [
    ...defaults.scopeRules,
    ...(phaseConfig?.scopeRules || []),
  ]

  // Build phase-specific execution hints
  const executionHints = [
    ...defaults.executionHints,
    ...(phaseConfig?.executionHints || []),
  ]
  
  // Build user custom rules block
  const userRulesBlock = roleConfig.rules.length > (promptsConfig.roles[role]?.rules?.length || 0)
    ? `\n用户自定义规则（必须遵守）：\n${roleConfig.rules.slice(promptsConfig.roles[role]?.rules?.length || 0).map(r => `- ${r}`).join('\n')}\n`
    : ''
  
  // Build background context block
  const backgroundContextBlock = roleConfig.backgroundContext
    ? `\n项目背景上下文：\n${roleConfig.backgroundContext}\n`
    : ''

  return [
    roleInstruction,
    modeInstruction,
    `Role Rules:\n${roleSpecificRules}`,
    userRulesBlock,
    backgroundContextBlock,
    todoSnapshotBlock,
    dependencyContextBlock,
    `当前任务: ${task.title}`,
    `任务依赖: ${task.deps.length > 0 ? task.deps.join(', ') : 'none'}`,
    task.backgroundContext ? `背景上下文:\n${task.backgroundContext}` : '',
    `来源参考:\n- ${((task.sourceRefs ?? []).length > 0 ? task.sourceRefs : ['(none)']).join('\n- ')}`,
    `验收标准:\n- ${task.acceptance.join('\n- ')}`,
    `建议验证命令:\n- ${task.verification_cmds.join('\n- ')}`,
    `交付物（deliverables）:\n- ${(task.deliverables ?? defaults.deliverables).join('\n- ')}`,
    `交接清单（handoffChecklist）:\n- ${(task.handoffChecklist ?? defaults.handoffChecklist).join('\n- ')}`,
    `范围规则（scopeRules）:\n- ${scopeRules.join('\n- ')}`,
    `执行要点（executionHints）:\n- ${executionHints.join('\n- ')}`,
    `完成定义（completionDefinition）:\n${task.completionDefinition || '完成当前子任务并满足验收标准。'}`,
    goal ? `用户目标: ${goal}` : '',
    path ? `目标目录: ${path}` : '',
    adviceBlock,
    `与对端通信上下文:\n- codingToReview: ${task.channel?.codingToReview || '(none)'}\n- reviewToCoding: ${task.channel?.reviewToCoding || '(none)'}`,
    `请输出 JSON：${JSON.stringify(roleConfig.outputFormat)}`,
    '注意：请只处理当前子任务，不要把其它子任务混入本轮实现/审查。'
  ].filter(Boolean).join('\n')
}

/**
 * Load Prompts - 加载Prompt模板配置
 */
export async function loadPrompts(configPath) {
  const defaultPath = resolve(import.meta.dirname, '../config/prompts.yaml')
  const filePath = configPath ?? defaultPath
  return await loadYamlConfig(filePath)
}

/**
 * Load Verification Rules - 加载验证规则配置
 */
export async function loadVerificationRules(configPath) {
  const defaultPath = resolve(import.meta.dirname, '../config/verification-rules.yaml')
  const filePath = configPath ?? defaultPath
  return await loadYamlConfig(filePath)
}

/**
 * Load Task Templates - 加载任务模板配置
 */
export async function loadTaskTemplates(configPath) {
  const defaultPath = resolve(import.meta.dirname, '../config/task-templates.yaml')
  const filePath = configPath ?? defaultPath
  return await loadYamlConfig(filePath)
}

/**
 * Infer Verification Commands - 推断验证命令
 */
export function inferVerificationCommands(cwd, config) {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name) => existsSync(resolve(workspace, name))

  for (const [_typeName, rule] of Object.entries(config.projectTypes)) {
    const matched = rule.detectors.some(detector => has(detector.file))
    if (matched) {
      return rule.commands.verification
    }
  }

  return config.fallback.verification
}

/**
 * Infer E2E Commands - 推断E2E命令
 */
export function inferE2ECommands(cwd, config) {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name) => existsSync(resolve(workspace, name))

  for (const [_typeName, rule] of Object.entries(config.projectTypes)) {
    const matched = rule.detectors.some(detector => has(detector.file))
    if (matched) {
      return rule.commands.e2e
    }
  }

  return config.fallback.e2e
}

/**
 * Build Task Contract from Template - 从模板构建任务契约
 */
export function buildTaskContractFromTemplate(phase, options, templates) {
  const phaseTemplate = templates.phases[phase]
  if (!phaseTemplate) {
    throw new Error(`Unknown phase: ${phase}`)
  }

  const title = options.title || ''
  const topic = options.topic || title

  const acceptance = phaseTemplate.acceptanceTemplate.map(template =>
    template.replace('{title}', title).replace('{topic}', topic)
  )

  return {
    acceptance,
    verification_cmds: phaseTemplate.verificationCommands || [],
    deliverables: [...phaseTemplate.deliverables],
    handoffChecklist: [...phaseTemplate.handoffChecklist],
    scopeRules: [...(phaseTemplate.scopeRules || [])],
    executionHints: [...phaseTemplate.executionHints],
    completionDefinition: phaseTemplate.completionDefinition.replace('{topic}', topic),
  }
}
