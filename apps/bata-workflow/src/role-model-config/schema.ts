import { z } from 'zod'

const executionBackendSchema = z.enum(['coco', 'claude-code', 'local-cc'])
const executionTransportSchema = z.enum(['print', 'pty', 'auto'])

export const roleModelTargetSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    backend: executionBackendSchema.optional(),
    profile: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    transport: executionTransportSchema.optional()
  })
])

export const roleModelConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    global: roleModelTargetSchema,
    teams: z.record(roleModelTargetSchema).default({})
  }),
  taskTypes: z.record(roleModelTargetSchema).default({}),
  roles: z.record(roleModelTargetSchema).default({}),
  skills: z.record(roleModelTargetSchema).default({})
})

export type RoleModelConfig = z.infer<typeof roleModelConfigSchema>
export type RoleModelTarget = z.infer<typeof roleModelTargetSchema>
