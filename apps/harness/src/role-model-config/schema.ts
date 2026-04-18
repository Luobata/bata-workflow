import { z } from 'zod'

export const roleModelConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    global: z.string().min(1),
    teams: z.record(z.string().min(1)).default({})
  }),
  taskTypes: z.record(z.string().min(1)).default({}),
  roles: z.record(z.string().min(1)).default({}),
  skills: z.record(z.string().min(1)).default({})
})

export type RoleModelConfig = z.infer<typeof roleModelConfigSchema>
