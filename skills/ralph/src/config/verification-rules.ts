import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import yaml from 'yaml'

/**
 * Verification Command Rule - 验证命令规则
 */
export interface VerificationCommandRule {
  detectors: Array<{ file: string }>
  commands: {
    verification: string[]
    e2e: string[]
  }
}

/**
 * Verification Rules Config - 验证规则配置
 */
export interface VerificationRulesConfig {
  projectTypes: Record<string, VerificationCommandRule>
  fallback: {
    verification: string[]
    e2e: string[]
  }
}

/**
 * Load Verification Rules - 加载验证规则配置
 */
export async function loadVerificationRules(configPath?: string): Promise<VerificationRulesConfig> {
  const defaultPath = resolve(import.meta.dirname, '../../config/verification-rules.yaml')
  const filePath = configPath ?? defaultPath
  
  const content = await readFile(filePath, 'utf8')
  return yaml.parse(content) as VerificationRulesConfig
}

/**
 * Infer Verification Commands - 推断验证命令
 */
export function inferVerificationCommands(
  cwd: string,
  config: VerificationRulesConfig
): string[] {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name: string) => existsSync(resolve(workspace, name))

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
export function inferE2ECommands(
  cwd: string,
  config: VerificationRulesConfig
): string[] {
  const workspace = resolve(cwd ?? process.cwd())
  const has = (name: string) => existsSync(resolve(workspace, name))

  for (const [_typeName, rule] of Object.entries(config.projectTypes)) {
    const matched = rule.detectors.some(detector => has(detector.file))
    if (matched) {
      return rule.commands.e2e
    }
  }

  return config.fallback.e2e
}
