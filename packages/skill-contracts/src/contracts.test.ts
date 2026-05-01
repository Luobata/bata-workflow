import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  LocalInstallRecordSchema,
  PackMetadataSchema,
  SkillError,
  SkillErrorCode,
  SkillManifestSchema,
} from './index.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type PackageJsonConfig = {
  main?: string
  types?: string
  files?: string[]
  scripts?: {
    build?: string
  }
  exports?: {
    '.': {
      import?: string
      types?: string
    }
  }
}

type TsConfig = {
  compilerOptions?: {
    outDir?: string
    rootDir?: string
  }
  include?: string[]
  exclude?: string[]
}

const readJson = async <T>(fileName: string) => {
  const fileContents = await readFile(path.join(packageRoot, fileName), 'utf8')

  return JSON.parse(fileContents) as T
}

const createValidManifest = (overrides: Record<string, unknown> = {}) => ({
  name: 'monitor-board',
  displayName: 'Monitor Board',
  entry: 'src/monitor/index.ts',
  cocoInstallName: '@luobata/monitor-board',
  version: '0.1.0',
  files: ['src/**/*.ts', 'assets/*.json'],
  dev: {
    link: true,
    publishLocal: true,
  },
  metadata: {
    description: 'Local monitor skill for bata-workflow development',
    tags: ['monitor', 'local-dev'],
  },
  ...overrides,
})

const globLikeEntryValues = [
  'src/**/*.ts',
  'src/monitor?.ts',
  'src/[monitor].ts',
  'src/{monitor,index}.ts',
]

describe('SkillManifestSchema', () => {
  it('accepts a valid local skill manifest', () => {
    const manifest = SkillManifestSchema.parse(createValidManifest())

    expect(manifest.entry).toBe('src/monitor/index.ts')
    expect(manifest.dev.publishLocal).toBe(true)
  })

  it('accepts a semver version with prerelease and build metadata', () => {
    const manifest = SkillManifestSchema.parse(
      createValidManifest({
        version: '1.2.3-alpha.1+build.5',
      }),
    )

    expect(manifest.version).toBe('1.2.3-alpha.1+build.5')
  })

  it('rejects a manifest with an invalid version', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          version: 'latest',
        }),
      ),
    ).toThrow(/version/)
  })

  it('rejects an absolute entry path', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          entry: '/tmp/monitor/index.ts',
        }),
      ),
    ).toThrow(/entry/)
  })

  it("rejects './' as an entry path", () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          entry: './',
        }),
      ),
    ).toThrow(/entry/)
  })

  it('rejects drive-relative entry paths', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          entry: 'C:skill/index.ts',
        }),
      ),
    ).toThrow(/entry/)
  })

  it.each(globLikeEntryValues)('rejects glob-like entry paths: %s', (entry) => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          entry,
        }),
      ),
    ).toThrow(/entry/)
  })

  it('continues to allow glob-like file patterns within the skill root', () => {
    const manifest = SkillManifestSchema.parse(
      createValidManifest({
        files: [...globLikeEntryValues],
      }),
    )

    expect(manifest.files).toEqual(globLikeEntryValues)
  })

  it('rejects file globs that escape the skill root', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          files: ['../shared/**/*.md'],
        }),
      ),
    ).toThrow(/files/)
  })

  it('rejects glob-like file patterns that traverse outside the skill root after expansion', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          files: ['src/**/../../secret.txt'],
        }),
      ),
    ).toThrow(/files/)
  })

  it("rejects './' inside files", () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          files: ['./'],
        }),
      ),
    ).toThrow(/files/)
  })

  it('rejects drive-relative file paths', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          files: ['C:skill/index.ts'],
        }),
      ),
    ).toThrow(/files/)
  })

  it('rejects unknown top-level manifest keys', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          extra: true,
        }),
      ),
    ).toThrow(/unrecognized key/i)
  })

  it('rejects unknown dev keys', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          dev: {
            link: true,
            publishLocal: true,
            extra: true,
          },
        }),
      ),
    ).toThrow(/unrecognized key/i)
  })

  it('rejects unknown metadata keys', () => {
    expect(() =>
      SkillManifestSchema.parse(
        createValidManifest({
          metadata: {
            description: 'Local monitor skill for bata-workflow development',
            tags: ['monitor', 'local-dev'],
            extra: true,
          },
        }),
      ),
    ).toThrow(/unrecognized key/i)
  })
})

describe('LocalInstallRecordSchema', () => {
  it('accepts a linked local install record', () => {
    const record = LocalInstallRecordSchema.parse({
      name: 'monitor-board',
      cocoInstallName: '@luobata/monitor-board',
      version: '0.1.0',
      mode: 'linked',
      installedAt: '2026-04-18T12:00:00.000Z',
      sourcePath: '/tmp/skills/monitor-board',
    })

    expect(record.mode).toBe('linked')
  })

  it('accepts a published-local install record', () => {
    const record = LocalInstallRecordSchema.parse({
      name: 'monitor-board',
      cocoInstallName: '@luobata/monitor-board',
      version: '0.1.0-local',
      mode: 'published-local',
      installedAt: '2026-04-18T12:00:00.000Z',
      packPath: '/tmp/packs/monitor-board-0.1.0-local.tgz',
      integrity: 'sha256-abc123==',
    })

    expect(record.mode).toBe('published-local')
    expect(record.version).toBe('0.1.0-local')
    expect(record.integrity).toBe('sha256-abc123==')
  })

  it('rejects a linked local install record with an invalid version', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: 'version-one',
        mode: 'linked',
        installedAt: '2026-04-18T12:00:00.000Z',
        sourcePath: '/tmp/skills/monitor-board',
      }),
    ).toThrow(/version/)
  })

  it('rejects a linked local install record with a relative sourcePath', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'linked',
        installedAt: '2026-04-18T12:00:00.000Z',
        sourcePath: '../skills/monitor-board',
      }),
    ).toThrow(/sourcePath/)
  })

  it('rejects unknown keys on linked install records', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'linked',
        installedAt: '2026-04-18T12:00:00.000Z',
        sourcePath: '/tmp/skills/monitor-board',
        extra: true,
      }),
    ).toThrow(/unrecognized key/i)
  })

  it('rejects a published-local install record without the packPath required by its mode', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'published-local',
        installedAt: '2026-04-18T12:00:00.000Z',
        sourcePath: '/tmp/skills/monitor-board',
      }),
    ).toThrow(/packPath/)
  })

  it('rejects a published-local install record with a relative packPath', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'published-local',
        installedAt: '2026-04-18T12:00:00.000Z',
        packPath: 'packs/monitor-board-0.1.0.tgz',
      }),
    ).toThrow(/packPath/)
  })

  it('rejects a published-local install record with an invalid integrity value', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'published-local',
        installedAt: '2026-04-18T12:00:00.000Z',
        packPath: '/tmp/packs/monitor-board-0.1.0.tgz',
        integrity: 'totally-not-an-integrity',
      }),
    ).toThrow(/integrity/)
  })

  it('rejects unknown keys on published-local install records', () => {
    expect(() =>
      LocalInstallRecordSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        mode: 'published-local',
        installedAt: '2026-04-18T12:00:00.000Z',
        packPath: '/tmp/packs/monitor-board-0.1.0.tgz',
        extra: true,
      }),
    ).toThrow(/unrecognized key/i)
  })
})

describe('PackMetadataSchema', () => {
  it('accepts metadata for a locally built pack artifact', () => {
    const metadata = PackMetadataSchema.parse({
      name: 'monitor-board',
      cocoInstallName: '@luobata/monitor-board',
      version: '0.1.0',
      artifactPath: '/tmp/packs/monitor-board-0.1.0.tgz',
      packedAt: '2026-04-18T12:30:00.000Z',
      integrity: 'sha512-deadbeef',
      fileCount: 4,
      unpackedSize: 4096,
    })

    expect(metadata.integrity).toBe('sha512-deadbeef')
  })

  it('accepts a semver version with prerelease and build metadata in pack metadata', () => {
    const metadata = PackMetadataSchema.parse({
      name: 'monitor-board',
      cocoInstallName: '@luobata/monitor-board',
      version: '1.2.3-alpha.1+build.5',
      artifactPath: '/tmp/packs/monitor-board-1.2.3-alpha.1+build.5.tgz',
      packedAt: '2026-04-18T12:30:00.000Z',
      integrity: 'sha512-deadbeef',
      fileCount: 4,
      unpackedSize: 4096,
    })

    expect(metadata.version).toBe('1.2.3-alpha.1+build.5')
  })

  it('rejects metadata with an invalid version', () => {
    expect(() =>
      PackMetadataSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '1.2',
        artifactPath: '/tmp/packs/monitor-board-0.1.0.tgz',
        packedAt: '2026-04-18T12:30:00.000Z',
        integrity: 'sha512-deadbeef',
        fileCount: 4,
        unpackedSize: 4096,
      }),
    ).toThrow(/version/)
  })

  it('rejects metadata with an invalid integrity value', () => {
    expect(() =>
      PackMetadataSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        artifactPath: '/tmp/packs/monitor-board-0.1.0.tgz',
        packedAt: '2026-04-18T12:30:00.000Z',
        integrity: 'junk',
        fileCount: 4,
        unpackedSize: 4096,
      }),
    ).toThrow(/integrity/)
  })

  it('rejects metadata with a relative artifactPath', () => {
    expect(() =>
      PackMetadataSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        artifactPath: 'packs/monitor-board-0.1.0.tgz',
        packedAt: '2026-04-18T12:30:00.000Z',
        integrity: 'sha512-deadbeef',
        fileCount: 4,
        unpackedSize: 4096,
      }),
    ).toThrow(/artifactPath/)
  })

  it('rejects unknown metadata keys', () => {
    expect(() =>
      PackMetadataSchema.parse({
        name: 'monitor-board',
        cocoInstallName: '@luobata/monitor-board',
        version: '0.1.0',
        artifactPath: '/tmp/packs/monitor-board-0.1.0.tgz',
        packedAt: '2026-04-18T12:30:00.000Z',
        integrity: 'sha512-deadbeef',
        fileCount: 4,
        unpackedSize: 4096,
        extra: true,
      }),
    ).toThrow(/unrecognized key/i)
  })
})

describe('package entry surface', () => {
  it('declares dist entrypoints that line up with the build configuration', async () => {
    const packageJson = await readJson<PackageJsonConfig>('package.json')
    const tsconfig = await readJson<TsConfig>('tsconfig.json')

    expect(packageJson.main).toBe('./dist/index.js')
    expect(packageJson.types).toBe('./dist/index.d.ts')
    expect(packageJson.exports).toEqual({
      '.': {
        import: './dist/index.js',
        types: './dist/index.d.ts',
      },
    })
    expect(packageJson.files).toContain('dist')
    expect(packageJson.scripts?.build).toContain("rmSync('dist'")
    expect(packageJson.scripts?.build).toContain('tsc -p tsconfig.json')

    expect(tsconfig.compilerOptions?.outDir).toBe('dist')
    expect(tsconfig.compilerOptions?.rootDir).toBe('src')
    expect(tsconfig.include).toEqual(['src/**/*.ts'])
    expect(tsconfig.exclude).toContain('src/**/*.test.ts')
  })
})

describe('SkillError', () => {
  it('captures a typed code and preserves error metadata', () => {
    const cause = new Error('root cause')
    const error = new SkillError(SkillErrorCode.INVALID_MANIFEST, 'Manifest is invalid', {
      cause,
      details: { field: 'entry' },
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('SkillError')
    expect(error.code).toBe(SkillErrorCode.INVALID_MANIFEST)
    expect(error.message).toBe('Manifest is invalid')
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ field: 'entry' })
  })
})
