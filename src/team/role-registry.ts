import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { RoleDefinition } from '../domain/types.js'

const rolesConfigSchema = z.object({
  version: z.number().int().positive(),
  roles: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      defaultTaskTypes: z.array(z.string().min(1)),
      defaultSkills: z.array(z.string().min(1))
    })
  )
})

export function loadRoles(configPath: string): RoleDefinition[] {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = rolesConfigSchema.parse(parse(raw))

  return parsed.roles as RoleDefinition[]
}

export function buildRoleRegistry(roles: RoleDefinition[]): Map<string, RoleDefinition> {
  return new Map(roles.map((role) => [role.name, role]))
}
