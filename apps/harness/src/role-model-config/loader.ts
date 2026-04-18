import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

import { roleModelConfigSchema, type RoleModelConfig } from './schema.js'

export function loadRoleModelConfig(configPath: string): RoleModelConfig {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = parse(raw)
  return roleModelConfigSchema.parse(parsed)
}
