import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadSlashCommandRegistry, resolveSlashCommand } from '../src/cli/slash-command-loader.js'

const configPath = resolve(import.meta.dirname, '../configs/slash-commands.yaml')

describe('slash command loader', () => {
  it('把 /harness 映射为默认 run 入口', () => {
    const registry = loadSlashCommandRegistry(configPath)
    const resolved = resolveSlashCommand('/harness', new Map(), registry)

    expect(resolved).not.toBeNull()
    expect(resolved?.command).toBe('run')
    expect(resolved?.flags.get('teamName')).toBe('default')
    expect(resolved?.flags.has('composition')).toBe(false)
  })

  it('把 /review 映射为 run + review-only composition', () => {
    const registry = loadSlashCommandRegistry(configPath)
    const resolved = resolveSlashCommand('/review', new Map(), registry)

    expect(resolved).not.toBeNull()
    expect(resolved?.command).toBe('run')
    expect(resolved?.flags.get('composition')).toBe('review-only')
    expect(resolved?.flags.get('teamName')).toBe('default')
  })

  it('允许显式 flags 覆盖 slash command 默认值', () => {
    const registry = loadSlashCommandRegistry(configPath)
    const resolved = resolveSlashCommand('/research', new Map([['composition', 'qa-only']]), registry)

    expect(resolved?.command).toBe('run')
    expect(resolved?.flags.get('composition')).toBe('qa-only')
  })

  it('非 slash 命令返回 null', () => {
    const registry = loadSlashCommandRegistry(configPath)
    expect(resolveSlashCommand('run', new Map(), registry)).toBeNull()
  })
})
