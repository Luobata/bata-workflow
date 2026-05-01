import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { SkillDefinition } from './skill-registry.js'

const skillDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1)
})

const skillConfigSchema = z.object({
  version: z.number().int().positive(),
  skills: z.array(skillDefinitionSchema)
})

export function loadSkills(configPath: string): SkillDefinition[] {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = skillConfigSchema.parse(parse(raw))
  return parsed.skills
}
