import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createHarnessRepoPaths, getHarnessRepoPaths, resolveHarnessInputPath } from '../src/runtime/repo-paths.js'

describe('repo paths', () => {
  it('能从编译产物 module url 推导 monorepo 根路径', () => {
    const builtModuleUrl = pathToFileURL(
      resolve(import.meta.dirname, '..', 'dist', 'src', 'runtime', 'repo-paths.js')
    ).href

    const paths = createHarnessRepoPaths(builtModuleUrl)

    expect(paths.appRoot).toBe(resolve(import.meta.dirname, '..'))
    expect(paths.repoRoot).toBe(resolve(import.meta.dirname, '..', '..', '..'))
    expect(paths.configRoot).toBe(resolve(paths.appRoot, 'configs'))
    expect(paths.stateRoot).toBe(resolve(paths.repoRoot, '.harness', 'state'))
  })

  it('stateRoot 位于 monorepo 根目录的 .harness/state', () => {
    const paths = getHarnessRepoPaths()

    expect(paths.appRoot).toBe(resolve(import.meta.dirname, '..'))
    expect(paths.repoRoot).toBe(resolve(paths.appRoot, '..', '..'))
    expect(paths.configRoot).toBe(resolve(paths.appRoot, 'configs'))
    expect(paths.stateRoot).toBe(resolve(paths.repoRoot, '.harness', 'state'))
  })

  it('当输入仅存在于 repo root 时会 fallback 到 repo root', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'harness-repo-paths-'))
    const appRoot = resolve(workspace, 'apps', 'harness')
    const cwd = resolve(appRoot, 'src')
    const repoOnlyTarget = resolve(workspace, 'docs', 'spec.md')

    mkdirSync(cwd, { recursive: true })
    mkdirSync(resolve(workspace, 'docs'), { recursive: true })
    writeFileSync(repoOnlyTarget, '# spec\n', 'utf8')

    const resolvedPath = resolveHarnessInputPath('docs/spec.md', {
      cwd,
      repoRoot: workspace
    })

    expect(resolvedPath).toBe(repoOnlyTarget)
    expect(existsSync(resolvedPath)).toBe(true)
  })
})
