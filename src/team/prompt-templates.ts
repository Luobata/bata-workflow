import type { DispatchAssignment } from '../domain/types.js'
import { getSkillsByNames } from './skill-registry.js'
import type { RolePromptTemplateRegistry } from './prompt-loader.js'

export interface RolePromptTemplate {
  role: string
  opening: string
  responsibilities: string[]
  outputContract: string[]
}

const DEFAULT_ROLE_PROMPT_TEMPLATES: Record<string, RolePromptTemplate> = {
  coordinator: {
    role: 'coordinator',
    opening: '你是协调者，负责综合各角色结果并形成简洁可执行的最终结论。',
    responsibilities: ['只基于已知任务信息汇总', '明确指出风险、结论和下一步建议'],
    outputContract: ['summary 必须是最终汇总结论', '禁止扩展执行范围']
  },
  planner: {
    role: 'planner',
    opening: '你是规划者，负责理解目标、澄清边界，并把目标转成可执行步骤。',
    responsibilities: ['强调目标约束与依赖', '避免直接进入实现'],
    outputContract: ['summary 必须体现计划或拆解结果', '禁止假装完成实现']
  },
  researcher: {
    role: 'researcher',
    opening: '你是调研者，负责补充事实、上下文与外部约束。',
    responsibilities: ['优先收集证据', '总结关键发现和风险'],
    outputContract: ['summary 必须体现发现结论', '不要给出虚构事实']
  },
  coder: {
    role: 'coder',
    opening: '你是实现者，负责围绕当前任务完成编码或实现方案。',
    responsibilities: ['严格围绕当前实现任务作答', '结果中明确实现点与边界'],
    outputContract: ['summary 必须说明完成了什么实现', '若失败必须指出阻塞原因']
  },
  reviewer: {
    role: 'reviewer',
    opening: '你是审查者，负责识别实现风险、质量问题和改进建议。',
    responsibilities: ['聚焦风险与反馈', '不要重新实现整个任务'],
    outputContract: ['summary 必须体现审查结论', '指出最重要的问题或通过结论']
  },
  tester: {
    role: 'tester',
    opening: '你是测试者，负责验证场景、确认通过条件并指出失败点。',
    responsibilities: ['优先判断是否满足验收标准', '明确测试范围和结果'],
    outputContract: ['summary 必须体现验证结论', '失败时说明未通过项']
  }
}

export function getRolePromptTemplate(role: string): RolePromptTemplate {
  return (
    DEFAULT_ROLE_PROMPT_TEMPLATES[role] ?? {
      role,
      opening: `你是 ${role}，请仅完成当前分配任务。`,
      responsibilities: ['遵循任务边界', '给出可验证结论'],
      outputContract: ['summary 必须准确概括结果']
    }
  )
}

export function buildRolePromptSection(
  assignment: DispatchAssignment,
  registry?: RolePromptTemplateRegistry
): string {
  const template = registry?.roles[assignment.roleDefinition.name] ?? getRolePromptTemplate(assignment.roleDefinition.name)
  const skills = getSkillsByNames(assignment.task.skills)

  return [
    template.opening,
    `角色职责: ${assignment.roleDefinition.description}`,
    '角色要求:',
    ...template.responsibilities.map((item, index) => `${index + 1}. ${item}`),
    '技能上下文:',
    ...(skills.length > 0 ? skills.map((skill) => `- ${skill.name}: ${skill.description}`) : ['- none']),
    '输出要求:',
    ...template.outputContract.map((item, index) => `${index + 1}. ${item}`)
  ].join('\n')
}
