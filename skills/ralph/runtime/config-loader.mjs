#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

/**
 * Load YAML Config - 加载YAML配置文件
 */
export async function loadYamlConfig(configPath) {
  const content = await readFile(configPath, 'utf8')
  return parseYaml(content)
}

/**
 * Build Role Prompt From Config - 从配置构建角色Prompt
 */
export function buildRolePromptFromConfig({ role, task, goal, mode, path, advice, allTasks, promptsConfig }) {
  const roleConfig = promptsConfig.roles[role]
  if (!roleConfig) {
    throw new Error(`Unknown role: ${role}`)
  }

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

  return [
    roleInstruction,
    modeInstruction,
    `Role Rules:\n${roleSpecificRules}`,
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
