import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { TaskType } from '../domain/types.js'

export interface TeamCompositionWorkstream {
  taskType: TaskType
  role: string
  title: string
  skills: string[]
  acceptance: string[]
}

export interface TeamComposition {
  name: string
  description: string
  workstreams: TeamCompositionWorkstream[]
}

export interface TeamCompositionRegistry {
  defaultComposition: string
  compositions: Record<string, TeamComposition>
}

const taskTypeSchema = z.enum(['planning', 'research', 'coding', 'code-review', 'testing', 'coordination'])

const workstreamSchema = z.object({
  taskType: taskTypeSchema,
  role: z.string().min(1),
  title: z.string().min(1),
  skills: z.array(z.string().min(1)).min(1),
  acceptance: z.array(z.string().min(1)).min(1)
})

const teamCompositionConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    composition: z.string().min(1)
  }),
  compositions: z.record(
    z.object({
      description: z.string().min(1),
      workstreams: z.array(workstreamSchema).min(1)
    })
  )
})

export function loadTeamCompositionRegistry(configPath: string): TeamCompositionRegistry {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = teamCompositionConfigSchema.parse(parse(raw))

  return {
    defaultComposition: parsed.defaults.composition,
    compositions: Object.fromEntries(
      Object.entries(parsed.compositions).map(([name, composition]) => [
        name,
        {
          name,
          description: composition.description,
          workstreams: composition.workstreams
        } satisfies TeamComposition
      ])
    )
  }
}

export function getTeamComposition(registry: TeamCompositionRegistry, compositionName: string): TeamComposition {
  const composition = registry.compositions[compositionName]
  if (!composition) {
    throw new Error(`未找到 team composition: ${compositionName}`)
  }
  return composition
}
