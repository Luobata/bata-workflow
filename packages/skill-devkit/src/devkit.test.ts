import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import * as exportedDevkit from './index.js'
import {
  getLocalInstallStatePath,
  getPackMetadataPath,
  getPackOutputDirectory,
  getSkillManifestPath,
  loadSkillManifest,
  packSkill,
  probeLocalInstall,
  readLocalInstallRecord,
  writeLocalInstallRecord,
} from './index.js'

const linkSkill = (exportedDevkit as Record<string, unknown>).linkSkill as (options: {
  skillRoot: string
  installRoot: string
  stateRoot: string
}) => {
  installPath: string
  statePath: string
  record: {
    mode: 'linked'
    sourcePath: string
  }
}

const removeLinkedSkill = (exportedDevkit as Record<string, unknown>).removeLinkedSkill as (options: {
  skillRoot: string
  installRoot: string
  stateRoot: string
}) => {
  removed: boolean
  reason?: string
  installPath: string
  statePath: string
}

const publishLocalSkill = (exportedDevkit as Record<string, unknown>).publishLocalSkill as (options: {
  skillRoot: string
  packRoot: string
  installRoot: string
  stateRoot: string
}) => {
  installPath: string
  statePath: string
  record: {
    mode: 'published-local'
    packPath: string
    integrity?: string
  }
  packResult: {
    metadata: {
      integrity: string
    }
  }
}

const resolveSkillStatus = (exportedDevkit as Record<string, unknown>).resolveSkillStatus as (options: {
  skillRoot: string
  installRoot: string
  stateRoot: string
}) => {
  status: 'not-installed' | 'linked' | 'published-local' | 'broken'
  health: 'ok' | 'error'
  probe: {
    status: 'absent' | 'linked' | 'published-local' | 'broken'
  }
  installed: {
    kind: 'absent' | 'symlink' | 'directory' | 'other'
  }
  issues: Array<{
    code: string
  }>
}

const doctorSkill = (exportedDevkit as Record<string, unknown>).doctorSkill as (options: {
  skillRoot: string
  installRoot: string
  stateRoot: string
}) => {
  ok: boolean
  issues: Array<{
    code: string
  }>
}

type ManifestInput = {
  name: string
  displayName: string
  entry: string
  cocoInstallName: string
  version: string
  files: string[]
  dev: {
    link: boolean
    publishLocal: boolean
  }
  metadata: {
    description: string
    tags: string[]
  }
}

const tempRoots: string[] = []

const createTempRoot = (prefix: string) => {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

const createManifest = (overrides: Partial<ManifestInput> = {}): ManifestInput => ({
  name: 'monitor-board',
  displayName: 'Monitor Board',
  entry: 'src/index.ts',
  cocoInstallName: '@luobata/monitor-board',
  version: '0.1.0',
  files: ['skill-manifest.json', 'src/**/*.ts', 'assets/*.json'],
  dev: {
    link: true,
    publishLocal: true,
  },
  metadata: {
    description: 'Local monitor board skill for bata-workflow development',
    tags: ['monitor', 'local-dev'],
  },
  ...overrides,
})

const writeText = (filePath: string, contents: string) => {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
}

const writeJson = (filePath: string, value: unknown) => {
  writeText(filePath, JSON.stringify(value, null, 2))
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()

    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('skill devkit integration', () => {
  it('loads a validated manifest and resolves canonical devkit paths', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const manifestPath = getSkillManifestPath(skillRoot)
    const installNamePath = encodeURIComponent('@luobata/monitor-board')

    writeJson(manifestPath, createManifest())

    const manifest = loadSkillManifest(skillRoot)
    const packOutputDirectory = getPackOutputDirectory(packRoot, manifest)

    expect(manifest.displayName).toBe('Monitor Board')
    expect(manifestPath).toBe(path.resolve(skillRoot, 'skill-manifest.json'))
    expect(packOutputDirectory).toBe(
      path.resolve(packRoot, installNamePath, '0.1.0'),
    )
    expect(getPackMetadataPath(packOutputDirectory)).toBe(
      path.resolve(packOutputDirectory, 'pack-metadata.json'),
    )
    expect(getLocalInstallStatePath(stateRoot, manifest.cocoInstallName)).toBe(
      path.resolve(stateRoot, `${installNamePath}.json`),
    )
  })

  it('derives distinct filesystem paths for install names that would otherwise collide', () => {
    const packRoot = createTempRoot('skill-devkit-pack-')
    const stateRoot = createTempRoot('skill-devkit-state-')

    const scopedOutput = getPackOutputDirectory(packRoot, {
      cocoInstallName: '@scope/pkg',
      version: '1.0.0',
    })
    const flattenedOutput = getPackOutputDirectory(packRoot, {
      cocoInstallName: 'scope--pkg',
      version: '1.0.0',
    })
    const scopedStatePath = getLocalInstallStatePath(stateRoot, '@scope/pkg')
    const flattenedStatePath = getLocalInstallStatePath(stateRoot, 'scope--pkg')

    expect(scopedOutput).not.toBe(flattenedOutput)
    expect(scopedStatePath).not.toBe(flattenedStatePath)
  })

  it('atomically persists local install records and probes absent, linked, published-local, and broken states', () => {
    const stateRoot = createTempRoot('skill-devkit-state-')
    const sourceRoot = createTempRoot('skill-devkit-source-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const cocoInstallName = '@luobata/monitor-board'
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)
    const absentProbe = probeLocalInstall(stateRoot, cocoInstallName)

    expect(absentProbe).toEqual({
      status: 'absent',
      statePath,
      record: null,
    })

    writeLocalInstallRecord(statePath, {
      name: 'monitor-board',
      cocoInstallName,
      version: '0.1.0',
      mode: 'linked',
      installedAt: '2026-04-18T12:00:00.000Z',
      sourcePath: sourceRoot,
    })

    expect(readLocalInstallRecord(statePath)).toMatchObject({
      mode: 'linked',
      sourcePath: sourceRoot,
    })
    expect(readdirSync(path.dirname(statePath)).some((entry) => entry.includes('.tmp-'))).toBe(false)
    expect(probeLocalInstall(stateRoot, cocoInstallName)).toMatchObject({
      status: 'linked',
      statePath,
      targetPath: sourceRoot,
      record: {
        mode: 'linked',
        sourcePath: sourceRoot,
      },
    })

    writeLocalInstallRecord(statePath, {
      name: 'monitor-board',
      cocoInstallName,
      version: '0.1.1-local',
      mode: 'published-local',
      installedAt: '2026-04-18T12:05:00.000Z',
      packPath: packRoot,
      integrity: 'sha512-cGFja2VkLWxvY2Fs',
    })

    expect(probeLocalInstall(stateRoot, cocoInstallName)).toMatchObject({
      status: 'published-local',
      statePath,
      targetPath: packRoot,
      record: {
        mode: 'published-local',
        packPath: packRoot,
      },
    })

    const missingPackPath = path.resolve(packRoot, 'missing-artifact')

    writeLocalInstallRecord(statePath, {
      name: 'monitor-board',
      cocoInstallName,
      version: '0.1.2-local',
      mode: 'published-local',
      installedAt: '2026-04-18T12:10:00.000Z',
      packPath: missingPackPath,
      integrity: 'sha512-bWlzc2luZy1hcnRpZmFjdA==',
    })

    expect(probeLocalInstall(stateRoot, cocoInstallName)).toMatchObject({
      status: 'broken',
      statePath,
      missingPath: missingPackPath,
      record: {
        mode: 'published-local',
        packPath: missingPackPath,
      },
    })
  })

  it('links, publishes locally, resolves status, and reports doctor issues across the install lifecycle', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })

    const linkResult = linkSkill({ skillRoot, installRoot, stateRoot })

    expect(linkResult).toMatchObject({
      installPath,
      statePath,
      record: {
        mode: 'linked',
        sourcePath: skillRoot,
      },
    })
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(installPath)).toBe(skillRoot)
    expect(readLocalInstallRecord(statePath)).toMatchObject({
      mode: 'linked',
      sourcePath: skillRoot,
    })
    expect(resolveSkillStatus({ skillRoot, installRoot, stateRoot })).toMatchObject({
      status: 'linked',
      health: 'ok',
      probe: {
        status: 'linked',
      },
      installed: {
        kind: 'symlink',
      },
      issues: [],
    })
    expect(doctorSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      ok: true,
      issues: [],
    })

    const publishResult = publishLocalSkill({ skillRoot, packRoot, installRoot, stateRoot })

    expect(publishResult).toMatchObject({
      installPath,
      statePath,
      record: {
        mode: 'published-local',
        packPath: installPath,
        integrity: publishResult.packResult.metadata.integrity,
      },
    })
    expect(lstatSync(installPath).isSymbolicLink()).toBe(false)
    expect(existsSync(path.resolve(installPath, 'skill-manifest.json'))).toBe(true)
    expect(existsSync(path.resolve(installPath, 'src/index.ts'))).toBe(true)
    expect(readLocalInstallRecord(statePath)).toMatchObject({
      mode: 'published-local',
      packPath: installPath,
      integrity: publishResult.packResult.metadata.integrity,
    })
    expect(resolveSkillStatus({ skillRoot, installRoot, stateRoot })).toMatchObject({
      status: 'published-local',
      health: 'ok',
      probe: {
        status: 'published-local',
      },
      installed: {
        kind: 'directory',
      },
      issues: [],
    })

    rmSync(installPath, { recursive: true, force: true })

    expect(resolveSkillStatus({ skillRoot, installRoot, stateRoot })).toMatchObject({
      status: 'broken',
      health: 'error',
      probe: {
        status: 'broken',
      },
      issues: [
        {
          code: 'missing-recorded-target',
        },
      ],
    })
    expect(doctorSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      ok: false,
      issues: [
        {
          code: 'missing-recorded-target',
        },
      ],
    })
  })

  it('removes only linked installs and leaves published-local installs untouched', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })

    linkSkill({ skillRoot, installRoot, stateRoot })

    expect(removeLinkedSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      removed: true,
      installPath,
      statePath,
    })
    expect(existsSync(installPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
    expect(resolveSkillStatus({ skillRoot, installRoot, stateRoot })).toMatchObject({
      status: 'not-installed',
      health: 'ok',
      issues: [],
    })

    publishLocalSkill({ skillRoot, packRoot, installRoot, stateRoot })

    expect(removeLinkedSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      removed: false,
      reason: 'not-linked',
      installPath,
      statePath,
    })
    expect(existsSync(installPath)).toBe(true)
    expect(readLocalInstallRecord(statePath)).toMatchObject({
      mode: 'published-local',
      packPath: installPath,
    })
  })

  it('refuses to overwrite an unexpected existing install directory when linking', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)
    const sentinelPath = path.resolve(installPath, 'unexpected.txt')

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    mkdirSync(installPath, { recursive: true })
    writeText(sentinelPath, 'leave me alone\n')

    expect(() => linkSkill({ skillRoot, installRoot, stateRoot })).toThrow(/refus/i)
    expect(lstatSync(installPath).isDirectory()).toBe(true)
    expect(readFileSync(sentinelPath, 'utf8')).toBe('leave me alone\n')
    expect(existsSync(statePath)).toBe(false)
  })

  it('refuses to overwrite an unexpected existing install directory when publishing locally', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)
    const sentinelPath = path.resolve(installPath, 'unexpected.txt')

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })
    mkdirSync(installPath, { recursive: true })
    writeText(sentinelPath, 'leave me alone\n')

    expect(() => publishLocalSkill({ skillRoot, packRoot, installRoot, stateRoot })).toThrow(/refus/i)
    expect(lstatSync(installPath).isDirectory()).toBe(true)
    expect(readFileSync(sentinelPath, 'utf8')).toBe('leave me alone\n')
    expect(existsSync(statePath)).toBe(false)
  })

  it('removes an orphan linked symlink that still points at the requested skill root', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    symlinkSync(skillRoot, installPath, 'dir')

    expect(removeLinkedSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      removed: true,
      installPath,
      statePath,
    })
    expect(existsSync(installPath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
  })

  it('refuses to remove a recorded linked install when the symlink target was repointed elsewhere', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const otherSkillRoot = createTempRoot('skill-devkit-other-skill-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeText(path.resolve(otherSkillRoot, 'src/index.ts'), 'export const other = 2\n')

    linkSkill({ skillRoot, installRoot, stateRoot })
    rmSync(installPath, { recursive: true, force: true })
    symlinkSync(otherSkillRoot, installPath, 'dir')

    expect(removeLinkedSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      removed: false,
      reason: 'unexpected-install-target',
      installPath,
      statePath,
    })
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(installPath)).toBe(otherSkillRoot)
    expect(readLocalInstallRecord(statePath)).toMatchObject({
      mode: 'linked',
      sourcePath: skillRoot,
    })
  })

  it('does not remove an orphan symlink that points somewhere else', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const otherSkillRoot = createTempRoot('skill-devkit-other-skill-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const stateRoot = createTempRoot('skill-devkit-state-')
    const cocoInstallName = '@luobata/monitor-board'
    const installPath = path.resolve(installRoot, encodeURIComponent(cocoInstallName))
    const statePath = getLocalInstallStatePath(stateRoot, cocoInstallName)

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeText(path.resolve(otherSkillRoot, 'src/index.ts'), 'export const other = 2\n')
    symlinkSync(otherSkillRoot, installPath, 'dir')

    expect(removeLinkedSkill({ skillRoot, installRoot, stateRoot })).toMatchObject({
      removed: false,
      reason: 'already-absent',
      installPath,
      statePath,
    })
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(installPath)).toBe(otherSkillRoot)
    expect(existsSync(statePath)).toBe(false)
  })

  it('removes a new linked install when state persistence fails after installation', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const blockedStateParent = createTempRoot('skill-devkit-state-parent-')
    const stateRoot = path.resolve(blockedStateParent, 'blocked-state-root')
    const installPath = path.resolve(installRoot, encodeURIComponent('@luobata/monitor-board'))

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeText(stateRoot, 'not a directory\n')

    expect(() => linkSkill({ skillRoot, installRoot, stateRoot })).toThrow()
    expect(existsSync(installPath)).toBe(false)
  })

  it('removes a new published-local install when state persistence fails after installation', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')
    const installRoot = createTempRoot('skill-devkit-install-')
    const blockedStateParent = createTempRoot('skill-devkit-state-parent-')
    const stateRoot = path.resolve(blockedStateParent, 'blocked-state-root')
    const installPath = path.resolve(installRoot, encodeURIComponent('@luobata/monitor-board'))

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })
    writeText(stateRoot, 'not a directory\n')

    expect(() => publishLocalSkill({ skillRoot, packRoot, installRoot, stateRoot })).toThrow()
    expect(existsSync(installPath)).toBe(false)
  })

  it('packs only whitelisted files into an output directory and writes pack metadata', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')

    writeJson(getSkillManifestPath(skillRoot), createManifest())
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeText(path.resolve(skillRoot, 'src/nested/helper.ts'), 'export const helper = 2\n')
    writeText(path.resolve(skillRoot, 'src/ignored.txt'), 'ignore me\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })
    writeText(path.resolve(skillRoot, 'docs/private.md'), '# do not pack\n')

    const result = packSkill({ skillRoot, packRoot })
    const metadataFile = getPackMetadataPath(result.outputDirectory)

    expect(result.outputDirectory).toBe(
      path.resolve(packRoot, encodeURIComponent('@luobata/monitor-board'), '0.1.0'),
    )
    expect(existsSync(path.resolve(result.outputDirectory, 'skill-manifest.json'))).toBe(true)
    expect(existsSync(path.resolve(result.outputDirectory, 'src/index.ts'))).toBe(true)
    expect(existsSync(path.resolve(result.outputDirectory, 'src/nested/helper.ts'))).toBe(true)
    expect(existsSync(path.resolve(result.outputDirectory, 'assets/config.json'))).toBe(true)
    expect(existsSync(path.resolve(result.outputDirectory, 'src/ignored.txt'))).toBe(false)
    expect(existsSync(path.resolve(result.outputDirectory, 'docs/private.md'))).toBe(false)
    expect(loadSkillManifest(result.outputDirectory).entry).toBe('src/index.ts')

    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as {
      artifactPath: string
      cocoInstallName: string
      fileCount: number
      integrity: string
      name: string
      packedAt: string
      unpackedSize: number
      version: string
    }

    expect(metadata).toMatchObject({
      name: 'monitor-board',
      cocoInstallName: '@luobata/monitor-board',
      version: '0.1.0',
      artifactPath: result.outputDirectory,
      fileCount: 4,
    })
    expect(metadata.unpackedSize).toBeGreaterThan(0)
    expect(metadata.integrity).toMatch(/^sha512-/)
    expect(() => new Date(metadata.packedAt).toISOString()).not.toThrow()
  })

  it('fails fast when manifest.files does not match any packable files', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')

    writeJson(
      getSkillManifestPath(skillRoot),
      createManifest({
        files: ['src/**/*.ts'],
      }),
    )

    expect(() => packSkill({ skillRoot, packRoot })).toThrow(/manifest\.files.*match/i)
  })

  it('fails fast when manifest.entry is not included in the packed output', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')

    writeJson(
      getSkillManifestPath(skillRoot),
      createManifest({
        files: ['skill-manifest.json', 'assets/*.json'],
      }),
    )
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeJson(path.resolve(skillRoot, 'assets/config.json'), { enabled: true })

    expect(() => packSkill({ skillRoot, packRoot })).toThrow(/manifest\.entry.*packed output/i)
  })

  it('packs files matched by Windows-style manifest globs on POSIX hosts', () => {
    const skillRoot = createTempRoot('skill-devkit-skill-')
    const packRoot = createTempRoot('skill-devkit-pack-')

    writeJson(
      getSkillManifestPath(skillRoot),
      createManifest({
        files: ['skill-manifest.json', 'src\\**\\*.ts'],
      }),
    )
    writeText(path.resolve(skillRoot, 'src/index.ts'), 'export const main = 1\n')
    writeText(path.resolve(skillRoot, 'src/nested/helper.ts'), 'export const helper = 2\n')

    const result = packSkill({ skillRoot, packRoot })

    expect(result.copiedFiles).toEqual([
      'skill-manifest.json',
      'src/index.ts',
      'src/nested/helper.ts',
    ])
  })
})
