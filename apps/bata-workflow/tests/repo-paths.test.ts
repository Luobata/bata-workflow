import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

const tempRoots: string[] = []
const builtModuleUrl = pathToFileURL(resolve(import.meta.dirname, '..', 'dist', 'src', 'runtime', 'repo-paths.js')).href

const createTempRoot = (prefix: string): string => {
  const root = mkdtempSync(resolve(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

async function loadRepoPathsModule(options: { stateRoot?: string; skillPacksRoot?: string } = {}) {
  vi.resetModules()
  vi.stubEnv('BATA_WORKFLOW_STATE_ROOT', options.stateRoot ?? '')
  vi.stubEnv('BATA_WORKFLOW_SKILL_PACKS_ROOT', options.skillPacksRoot ?? '')
  return await import('../src/runtime/repo-paths.js')
}

describe('repo paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()

    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('能从编译产物 module url 推导 monorepo 根路径', async () => {
    const { createBataWorkflowRepoPaths } = await loadRepoPathsModule()

    const paths = createBataWorkflowRepoPaths(builtModuleUrl)

    expect(paths.appRoot).toBe(resolve(import.meta.dirname, '..'))
    expect(paths.repoRoot).toBe(resolve(import.meta.dirname, '..', '..', '..'))
    expect(paths.configRoot).toBe(resolve(paths.appRoot, 'configs'))
    expect(paths.skillsRoot).toBe(resolve(paths.repoRoot, 'skills'))
    expect(paths.skillPacksRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'skill-packs'))
    expect(paths.stateRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'state'))
    expect(paths.skillStateRoot).toBe(resolve(paths.stateRoot, 'skills'))
  })

  it('允许通过环境变量覆写 stateRoot 与 skillPacksRoot', async () => {
    const overriddenStateRoot = createTempRoot('bata-workflow-test-state-root-')
    const overriddenSkillPacksRoot = createTempRoot('bata-workflow-test-skill-packs-root-')
    const { createBataWorkflowRepoPaths } = await loadRepoPathsModule({
      stateRoot: overriddenStateRoot,
      skillPacksRoot: overriddenSkillPacksRoot,
    })

    const paths = createBataWorkflowRepoPaths(builtModuleUrl)

    expect(paths.appRoot).toBe(resolve(import.meta.dirname, '..'))
    expect(paths.repoRoot).toBe(resolve(import.meta.dirname, '..', '..', '..'))
    expect(paths.stateRoot).toBe(overriddenStateRoot)
    expect(paths.skillStateRoot).toBe(resolve(overriddenStateRoot, 'skills'))
    expect(paths.skillPacksRoot).toBe(overriddenSkillPacksRoot)
    expect(paths.skillsRoot).toBe(resolve(paths.repoRoot, 'skills'))
  })

  it('stateRoot 位于 monorepo 根目录的 .bata-workflow/state', async () => {
    const { getBataWorkflowRepoPaths } = await loadRepoPathsModule()
    const paths = getBataWorkflowRepoPaths()

    expect(paths.appRoot).toBe(resolve(import.meta.dirname, '..'))
    expect(paths.repoRoot).toBe(resolve(paths.appRoot, '..', '..'))
    expect(paths.configRoot).toBe(resolve(paths.appRoot, 'configs'))
    expect(paths.skillsRoot).toBe(resolve(paths.repoRoot, 'skills'))
    expect(paths.skillPacksRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'skill-packs'))
    expect(paths.stateRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'state'))
    expect(paths.skillStateRoot).toBe(resolve(paths.stateRoot, 'skills'))
  })

  it('当输入仅存在于 repo root 时会 fallback 到 repo root', async () => {
    const { resolveBataWorkflowInputPath } = await loadRepoPathsModule()
    const workspace = createTempRoot('bata-workflow-repo-paths-')
    const appRoot = resolve(workspace, 'apps', 'bata-workflow')
    const cwd = resolve(appRoot, 'src')
    const repoOnlyTarget = resolve(workspace, 'docs', 'spec.md')

    mkdirSync(cwd, { recursive: true })
    mkdirSync(resolve(workspace, 'docs'), { recursive: true })
    writeFileSync(repoOnlyTarget, '# spec\n', 'utf8')

    const resolvedPath = resolveBataWorkflowInputPath('docs/spec.md', {
      cwd,
      repoRoot: workspace,
    })

    expect(resolvedPath).toBe(repoOnlyTarget)
    expect(existsSync(resolvedPath)).toBe(true)
  })
})
