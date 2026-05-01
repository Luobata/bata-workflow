import { isAbsolute, win32 } from 'node:path'

type SkillCommandName = 'validate' | 'pack' | 'link' | 'unlink' | 'publish-local' | 'status' | 'doctor'

type SkillCommandPayload = {
  skillName: string
}

type DoctorSkillCommandPayload = SkillCommandPayload & {
  fix: boolean
}

type Awaitable = Promise<void> | void

export interface SkillCommandHandlers {
  validate(payload: SkillCommandPayload): Awaitable
  pack(payload: SkillCommandPayload): Awaitable
  link(payload: SkillCommandPayload): Awaitable
  unlink(payload: SkillCommandPayload): Awaitable
  publishLocal(payload: SkillCommandPayload): Awaitable
  status(payload: SkillCommandPayload): Awaitable
  doctor(payload: DoctorSkillCommandPayload): Awaitable
}

interface ParsedSkillCommand {
  subcommand: SkillCommandName
  skillName: string
  fix: boolean
}

const KNOWN_SKILL_COMMANDS = new Set<SkillCommandName>([
  'validate',
  'pack',
  'link',
  'unlink',
  'publish-local',
  'status',
  'doctor',
])

const BOOLEAN_FLAGS = new Set(['fix'])

function parseBooleanFlagValue(flagName: string, rawValue: string): string {
  if (rawValue === 'true' || rawValue === 'false') {
    return rawValue
  }

  throw new Error(`${flagName} 非法: ${rawValue}（可选: true, false）`)
}

function parseSkillFlags(args: string[]): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!

    if (arg.startsWith('--')) {
      const rawFlag = arg.slice(2)
      const separatorIndex = rawFlag.indexOf('=')
      const flagName = separatorIndex >= 0 ? rawFlag.slice(0, separatorIndex) : rawFlag

      if (separatorIndex >= 0) {
        const rawValue = rawFlag.slice(separatorIndex + 1)
        flags.set(flagName, BOOLEAN_FLAGS.has(flagName) ? parseBooleanFlagValue(flagName, rawValue) : rawValue)
        continue
      }

      const nextArg = args[index + 1]
      if (BOOLEAN_FLAGS.has(rawFlag)) {
        if (nextArg === 'true' || nextArg === 'false') {
          flags.set(rawFlag, nextArg)
          index += 1
          continue
        }

        if (nextArg && !nextArg.startsWith('-')) {
          throw new Error(`${rawFlag} 非法: ${nextArg}（可选: true, false）`)
        }
      }

      if (nextArg && !nextArg.startsWith('-') && !BOOLEAN_FLAGS.has(rawFlag)) {
        flags.set(rawFlag, nextArg)
        index += 1
        continue
      }

      flags.set(rawFlag, 'true')
      continue
    }

    positionals.push(arg)
  }

  return { flags, positionals }
}

function parseSkillName(rawSkillName: string | undefined): string {
  const skillName = rawSkillName?.trim()

  if (!skillName) {
    throw new Error('请提供 skill 名称')
  }

  if (isAbsolute(skillName) || win32.isAbsolute(skillName)) {
    throw new Error('skill 名称不能是绝对路径')
  }

  const skillNameSegments = skillName.split(/[\\/]+/)
  if (skillNameSegments.some((segment) => segment === '..')) {
    throw new Error('skill 名称不能包含目录逃逸片段')
  }

  if (skillNameSegments.some((segment) => segment === '.')) {
    throw new Error('skill 名称不能包含当前目录片段')
  }

  return skillName
}

export function parseSkillCommand(args: string[]): ParsedSkillCommand {
  const { flags, positionals } = parseSkillFlags(args)
  const [rawSubcommand, rawSkillName, ...restPositionals] = positionals

  if (!rawSubcommand) {
    throw new Error('请提供 skill 子命令（可选: validate, pack, link, unlink, publish-local, status, doctor）')
  }

  if (!KNOWN_SKILL_COMMANDS.has(rawSubcommand as SkillCommandName)) {
    throw new Error(`未知 skill 子命令: ${rawSubcommand}`)
  }

  const subcommand = rawSubcommand as SkillCommandName
  const skillName = parseSkillName(rawSkillName)

  if (restPositionals.length > 0) {
    throw new Error('skill 命令只接受一个 skill 名称')
  }

  const unsupportedFlags = [...flags.keys()].filter((flag) => subcommand !== 'doctor' || flag !== 'fix')
  if (unsupportedFlags.length > 0) {
    throw new Error(`skill ${subcommand} 不支持参数: ${unsupportedFlags.join(', ')}`)
  }

  return {
    subcommand,
    skillName,
    fix: flags.get('fix') === 'true',
  }
}

export async function dispatchSkillCommand(args: string[], handlers: SkillCommandHandlers): Promise<void> {
  const command = parseSkillCommand(args)

  switch (command.subcommand) {
    case 'validate':
      await handlers.validate({ skillName: command.skillName })
      return
    case 'pack':
      await handlers.pack({ skillName: command.skillName })
      return
    case 'link':
      await handlers.link({ skillName: command.skillName })
      return
    case 'unlink':
      await handlers.unlink({ skillName: command.skillName })
      return
    case 'publish-local':
      await handlers.publishLocal({ skillName: command.skillName })
      return
    case 'status':
      await handlers.status({ skillName: command.skillName })
      return
    case 'doctor':
      await handlers.doctor({ skillName: command.skillName, fix: command.fix })
      return
  }
}
