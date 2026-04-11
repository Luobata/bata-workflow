import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { RolePromptTemplate } from './prompt-templates.js'

const rolePromptTemplateSchema = z.object({
  opening: z.string().min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  outputContract: z.array(z.string().min(1)).min(1)
})

const rolePromptConfigSchema = z.object({
  version: z.number().int().positive(),
  roles: z.record(rolePromptTemplateSchema)
})

export interface RolePromptTemplateRegistry {
  roles: Record<string, RolePromptTemplate>
}

export function loadRolePromptTemplates(configPath: string): RolePromptTemplateRegistry {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = rolePromptConfigSchema.parse(parse(raw))
  const roles = Object.fromEntries(
    Object.entries(parsed.roles).map(([role, template]) => [
      role,
      {
        role,
        opening: template.opening,
        responsibilities: template.responsibilities,
        outputContract: template.outputContract
      }
    ])
  )

  return { roles }
}
