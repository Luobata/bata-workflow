import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

const slashCommandSchema = z.object({
  action: z.enum(['plan', 'run', 'resume']),
  composition: z.string().min(1).optional(),
  teamName: z.string().min(1).optional(),
  adapter: z.string().min(1).optional(),
  dsl: z.enum(['team-run']).optional(),
  description: z.string().min(1)
})

const slashCommandConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z
    .object({
      teamName: z.string().min(1).optional(),
      adapter: z.string().min(1).optional()
    })
    .default({}),
  commands: z.record(slashCommandSchema)
})

export interface SlashCommandDefinition {
  name: string
  action: 'plan' | 'run' | 'resume'
  composition?: string
  teamName?: string
  adapter?: string
  dsl?: 'team-run'
  description: string
}

export interface SlashCommandRegistry {
  defaults: {
    teamName?: string
    adapter?: string
  }
  commands: Record<string, SlashCommandDefinition>
}

export interface SlashCommandResolution {
  command: 'plan' | 'run' | 'resume'
  flags: Map<string, string>
  dsl?: 'team-run'
}

export function loadSlashCommandRegistry(configPath: string): SlashCommandRegistry {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = slashCommandConfigSchema.parse(parse(raw))

  return {
    defaults: parsed.defaults,
    commands: Object.fromEntries(
      Object.entries(parsed.commands).map(([name, command]) => [
        name,
        {
          name,
          action: command.action,
          composition: command.composition,
          teamName: command.teamName,
          adapter: command.adapter,
          dsl: command.dsl,
          description: command.description
        } satisfies SlashCommandDefinition
      ])
    )
  }
}

export function resolveSlashCommand(
  rawCommand: string,
  flags: Map<string, string>,
  registry: SlashCommandRegistry
): SlashCommandResolution | null {
  if (!rawCommand.startsWith('/')) {
    return null
  }

  const slashName = rawCommand.slice(1)
  const slashCommand = registry.commands[slashName]
  if (!slashCommand) {
    const supportedCommands = Object.keys(registry.commands)
      .sort()
      .map((name) => `/${name}`)
      .join(', ')
    throw new Error(`未知 slash 命令: ${rawCommand}；可用命令: ${supportedCommands}`)
  }

  const resolvedFlags = new Map(flags)
  if (!resolvedFlags.has('teamName') && (slashCommand.teamName ?? registry.defaults.teamName)) {
    resolvedFlags.set('teamName', slashCommand.teamName ?? registry.defaults.teamName!)
  }
  if (!resolvedFlags.has('adapter') && (slashCommand.adapter ?? registry.defaults.adapter)) {
    resolvedFlags.set('adapter', slashCommand.adapter ?? registry.defaults.adapter!)
  }
  if (!resolvedFlags.has('composition') && slashCommand.composition) {
    resolvedFlags.set('composition', slashCommand.composition)
  }

  return {
    command: slashCommand.action,
    flags: resolvedFlags,
    dsl: slashCommand.dsl
  }
}
