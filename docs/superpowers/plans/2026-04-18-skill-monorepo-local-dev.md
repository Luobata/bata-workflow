# Skill Monorepo 本地开发闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `bata-workflow` monorepo 中落地本地优先的 skill 开发/安装工具链，先以 `monitor` 为样板跑通 `validate`、`link`、`pack`、`publish-local`、`status`、`doctor` 闭环。

**Architecture:** 新增 `packages/skill-contracts` 负责 schema 与错误类型，新增 `packages/skill-devkit` 负责文件系统探测、状态记录与安装逻辑，`apps/bata-workflow` 只作为 CLI shell 暴露 `skill` 子命令。`skills/monitor` 作为首个源码样板目录，`.bata-workflow/state/skills` 和 `.bata-workflow/skill-packs` 分别承载本地状态与 pack 产物。

**Tech Stack:** TypeScript、Rush、pnpm workspace、Zod、Vitest、Node.js fs/path/url、tinyglobby

---

## File Structure

### New projects

- Create: `packages/skill-contracts/package.json` — workspace library metadata for schema/types package
- Create: `packages/skill-contracts/tsconfig.json` — package TypeScript config
- Create: `packages/skill-contracts/vitest.config.ts` — package test config
- Create: `packages/skill-contracts/src/index.ts` — contracts exports
- Create: `packages/skill-contracts/src/manifest.ts` — `SkillManifestSchema` and related types
- Create: `packages/skill-contracts/src/local-install-record.ts` — install state schema and modes
- Create: `packages/skill-contracts/src/pack-metadata.ts` — pack artifact schema
- Create: `packages/skill-contracts/src/errors.ts` — typed error codes/classes
- Create: `packages/skill-contracts/src/contracts.test.ts` — schema and error tests

- Create: `packages/skill-devkit/package.json` — workspace library metadata for lifecycle logic
- Create: `packages/skill-devkit/tsconfig.json` — package TypeScript config
- Create: `packages/skill-devkit/vitest.config.ts` — package test config
- Create: `packages/skill-devkit/src/index.ts` — public exports
- Create: `packages/skill-devkit/src/paths.ts` — skill roots / pack roots / coco install roots
- Create: `packages/skill-devkit/src/manifest-loader.ts` — manifest loading and validation
- Create: `packages/skill-devkit/src/state-store.ts` — atomic read/write for local install state
- Create: `packages/skill-devkit/src/fs-probe.ts` — detect real install state from file system
- Create: `packages/skill-devkit/src/pack.ts` — build pack artifact from manifest whitelist
- Create: `packages/skill-devkit/src/link.ts` — create refreshable symlink install
- Create: `packages/skill-devkit/src/unlink.ts` — remove linked install safely
- Create: `packages/skill-devkit/src/publish-local.ts` — copy pack artifact to coco skills root
- Create: `packages/skill-devkit/src/status.ts` — compute recorded/detected status model
- Create: `packages/skill-devkit/src/doctor.ts` — diagnose and optionally repair broken state
- Create: `packages/skill-devkit/src/devkit.test.ts` — filesystem integration tests

### New skill seed

- Create: `skills/monitor/SKILL.md` — coco-visible monitor skill entry
- Create: `skills/monitor/skill.manifest.json` — first manifest sample

### Existing files to modify

- Modify: `apps/bata-workflow/package.json` — add `@luobata/skill-contracts`, `@luobata/skill-devkit`
- Modify: `apps/bata-workflow/src/runtime/repo-paths.ts` — add `skillsRoot`, `skillPacksRoot`, `skillStateRoot`
- Modify: `apps/bata-workflow/src/cli/index.ts` — dispatch `skill` subcommand before run/resume goal validation
- Create: `apps/bata-workflow/src/cli/skill-command.ts` — CLI glue for skill subcommands
- Create: `apps/bata-workflow/tests/skill-command.test.ts` — CLI command tests
- Modify: `apps/bata-workflow/tests/repo-paths.test.ts` — assert new root paths
- Modify: `rush.json` — register `@luobata/skill-contracts` and `@luobata/skill-devkit`
- Modify: `.gitignore` — ignore `.bata-workflow/skill-packs/`

---

### Task 1: Create workspace packages and path roots

**Files:**
- Create: `packages/skill-contracts/package.json`
- Create: `packages/skill-contracts/tsconfig.json`
- Create: `packages/skill-contracts/vitest.config.ts`
- Create: `packages/skill-devkit/package.json`
- Create: `packages/skill-devkit/tsconfig.json`
- Create: `packages/skill-devkit/vitest.config.ts`
- Modify: `apps/bata-workflow/package.json`
- Modify: `apps/bata-workflow/src/runtime/repo-paths.ts`
- Modify: `apps/bata-workflow/tests/repo-paths.test.ts`
- Modify: `rush.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing repo-path roots test**

Update `apps/bata-workflow/tests/repo-paths.test.ts` to assert the new roots:

```ts
expect(paths.skillsRoot).toBe(resolve(paths.repoRoot, 'skills'))
expect(paths.skillPacksRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'skill-packs'))
expect(paths.skillStateRoot).toBe(resolve(paths.repoRoot, '.bata-workflow', 'state', 'skills'))
```

Also extend the type import expectation by reading the new keys from `getHarnessRepoPaths()`.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test repo-paths
```

Expected: FAIL because `skillsRoot` / `skillPacksRoot` / `skillStateRoot` do not exist on `HarnessRepoPaths`.

- [ ] **Step 3: Add the package scaffolding and root path fields**

Create `packages/skill-contracts/package.json`:

```json
{
  "name": "@luobata/skill-contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.15.30",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

Create `packages/skill-devkit/package.json`:

```json
{
  "name": "@luobata/skill-devkit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@luobata/skill-contracts": "workspace:*",
    "tinyglobby": "^0.2.14"
  },
  "devDependencies": {
    "@types/node": "^22.15.30",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

Create matching `tsconfig.json` / `vitest.config.ts` files by following the existing package pattern from `packages/tmux-manager`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
```

Update `apps/bata-workflow/package.json` dependencies:

```json
"dependencies": {
  "@luobata/skill-contracts": "workspace:*",
  "@luobata/skill-devkit": "workspace:*",
  "@luobata/tmux-manager": "workspace:*",
  "yaml": "^2.8.1",
  "zod": "^3.25.76"
}
```

Update `apps/bata-workflow/src/runtime/repo-paths.ts`:

```ts
export type HarnessRepoPaths = {
  appRoot: string
  repoRoot: string
  configRoot: string
  stateRoot: string
  skillsRoot: string
  skillPacksRoot: string
  skillStateRoot: string
}
...
return {
  appRoot,
  repoRoot,
  configRoot: resolve(appRoot, 'configs'),
  stateRoot: resolve(repoRoot, '.bata-workflow', 'state'),
  skillsRoot: resolve(repoRoot, 'skills'),
  skillPacksRoot: resolve(repoRoot, '.bata-workflow', 'skill-packs'),
  skillStateRoot: resolve(repoRoot, '.bata-workflow', 'state', 'skills')
}
```

Update `rush.json` to register:

```json
{
  "packageName": "@luobata/skill-contracts",
  "projectFolder": "packages/skill-contracts",
  "tags": ["library", "tools"]
},
{
  "packageName": "@luobata/skill-devkit",
  "projectFolder": "packages/skill-devkit",
  "tags": ["library", "tools"]
}
```

Update `.gitignore`:

```gitignore
.bata-workflow/skill-packs/
```

- [ ] **Step 4: Run focused tests again to verify they pass**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test repo-paths
```

Expected: PASS.

- [ ] **Step 5: Refresh Rush workspace metadata**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow" run update
```

Expected: PASS and `common/config/rush/pnpm-lock.yaml` updates to include the two new packages.

- [ ] **Step 6: Optional commit checkpoint**

Only if the user explicitly requests commits during execution:

```bash
git add \
  apps/bata-workflow/package.json \
  apps/bata-workflow/src/runtime/repo-paths.ts \
  apps/bata-workflow/tests/repo-paths.test.ts \
  packages/skill-contracts \
  packages/skill-devkit \
  rush.json .gitignore common/config/rush/pnpm-lock.yaml
```

---

### Task 2: Define skill manifest, pack metadata, and install record contracts

**Files:**
- Create: `packages/skill-contracts/src/index.ts`
- Create: `packages/skill-contracts/src/manifest.ts`
- Create: `packages/skill-contracts/src/local-install-record.ts`
- Create: `packages/skill-contracts/src/pack-metadata.ts`
- Create: `packages/skill-contracts/src/errors.ts`
- Create: `packages/skill-contracts/src/contracts.test.ts`

- [ ] **Step 1: Write the failing contracts tests**

Create `packages/skill-contracts/src/contracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  LocalInstallRecordSchema,
  PackMetadataSchema,
  SkillErrorCode,
  SkillManifestSchema
} from './index.js'

describe('SkillManifestSchema', () => {
  it('accepts a valid monitor manifest', () => {
    expect(
      SkillManifestSchema.parse({
        name: 'monitor',
        displayName: 'Monitor',
        entry: 'SKILL.md',
        cocoInstallName: 'monitor',
        version: '0.1.0-local',
        files: ['SKILL.md', 'prompts/**'],
        dev: { link: true, publishLocal: true },
        metadata: { description: 'Open monitor', tags: ['monitor'] }
      }).name
    ).toBe('monitor')
  })

  it('rejects absolute entry paths', () => {
    expect(() =>
      SkillManifestSchema.parse({
        name: 'monitor',
        displayName: 'Monitor',
        entry: '/tmp/SKILL.md',
        cocoInstallName: 'monitor',
        version: '0.1.0-local',
        files: ['SKILL.md'],
        dev: { link: true, publishLocal: true },
        metadata: { description: 'Open monitor', tags: ['monitor'] }
      })
    ).toThrow(/entry/)
  })

  it('rejects file globs that escape skill root', () => {
    expect(() =>
      SkillManifestSchema.parse({
        name: 'monitor',
        displayName: 'Monitor',
        entry: 'SKILL.md',
        cocoInstallName: 'monitor',
        version: '0.1.0-local',
        files: ['../secret.txt'],
        dev: { link: true, publishLocal: true },
        metadata: { description: 'Open monitor', tags: ['monitor'] }
      })
    ).toThrow(/files/)
  })
})

describe('LocalInstallRecordSchema', () => {
  it('accepts link records', () => {
    expect(
      LocalInstallRecordSchema.parse({
        installName: 'monitor',
        mode: 'link',
        sourcePath: '/repo/skills/monitor',
        installedPath: '/Users/dev/.coco/skills/monitor',
        version: '0.1.0-local',
        updatedAt: '2026-04-18T12:00:00.000Z'
      }).mode
    ).toBe('link')
  })
})

describe('PackMetadataSchema', () => {
  it('accepts packed artifact metadata', () => {
    expect(
      PackMetadataSchema.parse({
        name: 'monitor',
        version: '0.1.0-local',
        packedAt: '2026-04-18T12:00:00.000Z',
        sourcePath: '/repo/skills/monitor',
        outputPath: '/repo/.bata-workflow/skill-packs/monitor'
      }).outputPath
    ).toContain('skill-packs')
  })
})

describe('SkillErrorCode', () => {
  it('exposes stable error codes', () => {
    expect(SkillErrorCode.InstallNameConflict).toBe('InstallNameConflict')
  })
})
```

- [ ] **Step 2: Run the new package test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-contracts" test
```

Expected: FAIL because the contract modules do not exist yet.

- [ ] **Step 3: Implement the contracts and exports**

Create `packages/skill-contracts/src/manifest.ts`:

```ts
import { z } from 'zod'

const RelativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.includes('..'), 'path must stay within skill root')

export const SkillManifestSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1),
  entry: RelativePathSchema,
  cocoInstallName: z.string().min(1).regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  files: z.array(RelativePathSchema).min(1),
  dev: z.object({
    link: z.boolean(),
    publishLocal: z.boolean()
  }),
  metadata: z.object({
    description: z.string().min(1),
    tags: z.array(z.string().min(1)).default([])
  })
})

export type SkillManifest = z.infer<typeof SkillManifestSchema>
```

Create `packages/skill-contracts/src/local-install-record.ts`:

```ts
import { z } from 'zod'

export const InstallModeSchema = z.enum(['link', 'publish-local'])

export const LocalInstallRecordSchema = z.object({
  installName: z.string().min(1),
  mode: InstallModeSchema,
  sourcePath: z.string().min(1),
  installedPath: z.string().min(1),
  version: z.string().min(1),
  updatedAt: z.string().datetime(),
  packedPath: z.string().min(1).optional()
})

export const LocalInstallsStateSchema = z.object({
  skills: z.record(LocalInstallRecordSchema)
})

export type InstallMode = z.infer<typeof InstallModeSchema>
export type LocalInstallRecord = z.infer<typeof LocalInstallRecordSchema>
export type LocalInstallsState = z.infer<typeof LocalInstallsStateSchema>
```

Create `packages/skill-contracts/src/pack-metadata.ts`:

```ts
import { z } from 'zod'

export const PackMetadataSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  packedAt: z.string().datetime(),
  sourcePath: z.string().min(1),
  outputPath: z.string().min(1)
})

export type PackMetadata = z.infer<typeof PackMetadataSchema>
```

Create `packages/skill-contracts/src/errors.ts`:

```ts
export const SkillErrorCode = {
  ManifestInvalid: 'ManifestInvalid',
  InstallNameConflict: 'InstallNameConflict',
  BrokenLocalInstall: 'BrokenLocalInstall',
  PackInputMissing: 'PackInputMissing',
  UnsafePath: 'UnsafePath',
  InstallTargetOccupied: 'InstallTargetOccupied'
} as const

export type SkillErrorCode = (typeof SkillErrorCode)[keyof typeof SkillErrorCode]

export class SkillError extends Error {
  constructor(
    public readonly code: SkillErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message)
    this.name = 'SkillError'
  }
}
```

Create `packages/skill-contracts/src/index.ts`:

```ts
export * from './manifest.js'
export * from './local-install-record.js'
export * from './pack-metadata.js'
export * from './errors.js'
```

- [ ] **Step 4: Run the contracts test again**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-contracts" test
```

Expected: PASS.

- [ ] **Step 5: Verify the new package builds cleanly**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-contracts" build
```

Expected: PASS and `dist/` is emitted.

---

### Task 3: Build the devkit state, probing, and pack logic

**Files:**
- Create: `packages/skill-devkit/src/index.ts`
- Create: `packages/skill-devkit/src/paths.ts`
- Create: `packages/skill-devkit/src/manifest-loader.ts`
- Create: `packages/skill-devkit/src/state-store.ts`
- Create: `packages/skill-devkit/src/fs-probe.ts`
- Create: `packages/skill-devkit/src/pack.ts`
- Create: `packages/skill-devkit/src/devkit.test.ts`

- [ ] **Step 1: Write failing integration tests for validate, pack, and status probing**

Create `packages/skill-devkit/src/devkit.test.ts`:

```ts
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectInstallState,
  loadSkillManifest,
  packSkill,
  readLocalInstallsState,
  writeLocalInstallsState
} from './index.js'

function createSandbox() {
  const root = mkdtempSync(resolve(tmpdir(), 'skill-devkit-'))
  const repoRoot = resolve(root, 'repo')
  const skillRoot = resolve(repoRoot, 'skills', 'monitor')
  const cocoRoot = resolve(root, 'home', '.coco', 'skills')
  const stateRoot = resolve(repoRoot, '.bata-workflow', 'state', 'skills')
  const packRoot = resolve(repoRoot, '.bata-workflow', 'skill-packs')
  mkdirSync(skillRoot, { recursive: true })
  mkdirSync(cocoRoot, { recursive: true })
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(packRoot, { recursive: true })
  writeFileSync(resolve(skillRoot, 'SKILL.md'), '# monitor\n', 'utf8')
  writeFileSync(
    resolve(skillRoot, 'skill.manifest.json'),
    JSON.stringify({
      name: 'monitor',
      displayName: 'Monitor',
      entry: 'SKILL.md',
      cocoInstallName: 'monitor',
      version: '0.1.0-local',
      files: ['SKILL.md'],
      dev: { link: true, publishLocal: true },
      metadata: { description: 'Open monitor', tags: ['monitor'] }
    }),
    'utf8'
  )
  return { repoRoot, skillRoot, cocoRoot, stateRoot, packRoot }
}

describe('skill-devkit', () => {
  it('loads a manifest from the skill source directory', () => {
    const sandbox = createSandbox()
    expect(loadSkillManifest(sandbox.skillRoot).cocoInstallName).toBe('monitor')
  })

  it('packs only whitelisted files into the pack directory', async () => {
    const sandbox = createSandbox()
    const result = await packSkill({
      skillRoot: sandbox.skillRoot,
      packRoot: sandbox.packRoot
    })

    expect(result.outputPath).toBe(resolve(sandbox.packRoot, 'monitor'))
    expect(readFileSync(resolve(result.outputPath, 'SKILL.md'), 'utf8')).toContain('monitor')
  })

  it('writes and reads local install state atomically', async () => {
    const sandbox = createSandbox()
    const stateFile = resolve(sandbox.stateRoot, 'local-installs.json')
    await writeLocalInstallsState(stateFile, {
      skills: {
        monitor: {
          installName: 'monitor',
          mode: 'link',
          sourcePath: sandbox.skillRoot,
          installedPath: resolve(sandbox.cocoRoot, 'monitor'),
          version: '0.1.0-local',
          updatedAt: '2026-04-18T12:00:00.000Z'
        }
      }
    })

    expect(readLocalInstallsState(stateFile).skills.monitor.mode).toBe('link')
  })

  it('detects a linked install from the file system', () => {
    const sandbox = createSandbox()
    const installPath = resolve(sandbox.cocoRoot, 'monitor')
    symlinkSync(sandbox.skillRoot, installPath, 'dir')

    expect(detectInstallState(installPath, sandbox.skillRoot).kind).toBe('linked')
  })
})
```

- [ ] **Step 2: Run the devkit test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
```

Expected: FAIL because the devkit modules do not exist yet.

- [ ] **Step 3: Implement path helpers, manifest loading, atomic state store, probing, and pack**

Create `packages/skill-devkit/src/paths.ts`:

```ts
import { resolve } from 'node:path'

export function getSkillManifestPath(skillRoot: string): string {
  return resolve(skillRoot, 'skill.manifest.json')
}

export function getPackOutputPath(packRoot: string, skillName: string): string {
  return resolve(packRoot, skillName)
}

export function getInstallStateFile(skillStateRoot: string): string {
  return resolve(skillStateRoot, 'local-installs.json')
}
```

Create `packages/skill-devkit/src/manifest-loader.ts`:

```ts
import { readFileSync } from 'node:fs'
import { SkillError, SkillErrorCode, SkillManifestSchema, type SkillManifest } from '@luobata/skill-contracts'
import { getSkillManifestPath } from './paths.js'

export function loadSkillManifest(skillRoot: string): SkillManifest {
  const manifestPath = getSkillManifestPath(skillRoot)
  try {
    return SkillManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    throw new SkillError(SkillErrorCode.ManifestInvalid, `Invalid skill manifest at ${manifestPath}`, String(error))
  }
}
```

Create `packages/skill-devkit/src/state-store.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LocalInstallsStateSchema, type LocalInstallsState } from '@luobata/skill-contracts'

export function readLocalInstallsState(stateFile: string): LocalInstallsState {
  try {
    return LocalInstallsStateSchema.parse(JSON.parse(readFileSync(stateFile, 'utf8')))
  } catch {
    return { skills: {} }
  }
}

export async function writeLocalInstallsState(stateFile: string, state: LocalInstallsState): Promise<void> {
  mkdirSync(dirname(stateFile), { recursive: true })
  const tempFile = `${stateFile}.tmp`
  writeFileSync(tempFile, JSON.stringify(state, null, 2))
  renameSync(tempFile, stateFile)
}
```

Create `packages/skill-devkit/src/fs-probe.ts`:

```ts
import { existsSync, lstatSync, realpathSync } from 'node:fs'

export type DetectedInstallState =
  | { kind: 'absent' }
  | { kind: 'linked'; targetPath: string }
  | { kind: 'published-local' }
  | { kind: 'broken'; reason: string }

export function detectInstallState(installPath: string, expectedSourcePath: string): DetectedInstallState {
  if (!existsSync(installPath)) {
    return { kind: 'absent' }
  }

  const stat = lstatSync(installPath)
  if (stat.isSymbolicLink()) {
    const targetPath = realpathSync(installPath)
    if (targetPath === realpathSync(expectedSourcePath)) {
      return { kind: 'linked', targetPath }
    }
    return { kind: 'broken', reason: `link target mismatch: ${targetPath}` }
  }

  if (stat.isDirectory()) {
    return { kind: 'published-local' }
  }

  return { kind: 'broken', reason: 'install target is not a directory' }
}
```

Create `packages/skill-devkit/src/pack.ts`:

```ts
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { glob } from 'tinyglobby'
import { PackMetadataSchema, SkillError, SkillErrorCode, type PackMetadata } from '@luobata/skill-contracts'
import { loadSkillManifest } from './manifest-loader.js'
import { getPackOutputPath, getSkillManifestPath } from './paths.js'

export async function packSkill(input: { skillRoot: string; packRoot: string }): Promise<PackMetadata> {
  const manifest = loadSkillManifest(input.skillRoot)
  const outputPath = getPackOutputPath(input.packRoot, manifest.name)
  rmSync(outputPath, { recursive: true, force: true })
  mkdirSync(outputPath, { recursive: true })

  for (const pattern of manifest.files) {
    const matches = await glob(pattern, { cwd: input.skillRoot, onlyFiles: false, dot: true })
    if (matches.length === 0) {
      throw new SkillError(SkillErrorCode.PackInputMissing, `No files matched pattern ${pattern}`)
    }

    for (const match of matches) {
      const fromPath = `${input.skillRoot}/${match}`
      const toPath = `${outputPath}/${match}`
      mkdirSync(dirname(toPath), { recursive: true })
      cpSync(fromPath, toPath, { recursive: true })
    }
  }

  cpSync(getSkillManifestPath(input.skillRoot), `${outputPath}/skill.manifest.json`)

  const metadata = PackMetadataSchema.parse({
    name: manifest.name,
    version: manifest.version,
    packedAt: new Date().toISOString(),
    sourcePath: input.skillRoot,
    outputPath
  })

  writeFileSync(`${outputPath}/.skill-pack.json`, JSON.stringify(metadata, null, 2))
  return metadata
}
```

Create `packages/skill-devkit/src/index.ts`:

```ts
export * from './paths.js'
export * from './manifest-loader.js'
export * from './state-store.js'
export * from './fs-probe.js'
export * from './pack.js'
```

- [ ] **Step 4: Run the devkit tests again**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
```

Expected: PASS.

- [ ] **Step 5: Verify the devkit package builds**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" build
```

Expected: PASS.

---

### Task 4: Add link, unlink, publish-local, status, and doctor behavior

**Files:**
- Create: `packages/skill-devkit/src/link.ts`
- Create: `packages/skill-devkit/src/unlink.ts`
- Create: `packages/skill-devkit/src/publish-local.ts`
- Create: `packages/skill-devkit/src/status.ts`
- Create: `packages/skill-devkit/src/doctor.ts`
- Modify: `packages/skill-devkit/src/index.ts`
- Modify: `packages/skill-devkit/src/devkit.test.ts`

- [ ] **Step 1: Extend the failing devkit test with lifecycle scenarios**

Append these cases to `packages/skill-devkit/src/devkit.test.ts`:

```ts
import { lstatSync, readFileSync } from 'node:fs'
import { linkSkill, publishLocalSkill, removeLinkedSkill, resolveSkillStatus, doctorSkill } from './index.js'

it('links the skill source into the coco skills root', async () => {
  const sandbox = createSandbox()
  const installPath = resolve(sandbox.cocoRoot, 'monitor')

  await linkSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json')
  })

  expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
  expect(resolveSkillStatus({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json')
  }).health).toBe('ok')
})

it('publishes a packed copy into the coco skills root', async () => {
  const sandbox = createSandbox()
  const installPath = resolve(sandbox.cocoRoot, 'monitor')

  await publishLocalSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json'),
    packRoot: sandbox.packRoot
  })

  expect(lstatSync(installPath).isSymbolicLink()).toBe(false)
  expect(readFileSync(resolve(installPath, 'SKILL.md'), 'utf8')).toContain('monitor')
})

it('unlinks a linked install without deleting a published-local copy', async () => {
  const sandbox = createSandbox()
  await linkSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json')
  })

  await removeLinkedSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json')
  })

  expect(detectInstallState(resolve(sandbox.cocoRoot, 'monitor'), sandbox.skillRoot).kind).toBe('absent')
})

it('doctor reports broken state when the install record exists but the install path is missing', async () => {
  const sandbox = createSandbox()
  const stateFile = resolve(sandbox.stateRoot, 'local-installs.json')
  await writeLocalInstallsState(stateFile, {
    skills: {
      monitor: {
        installName: 'monitor',
        mode: 'link',
        sourcePath: sandbox.skillRoot,
        installedPath: resolve(sandbox.cocoRoot, 'monitor'),
        version: '0.1.0-local',
        updatedAt: '2026-04-18T12:00:00.000Z'
      }
    }
  })

  const report = await doctorSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile
  })

  expect(report.health).toBe('broken')
  expect(report.issues[0]).toContain('missing')
})
```

- [ ] **Step 2: Run the devkit tests to verify they fail**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
```

Expected: FAIL because the lifecycle helpers are not implemented yet.

- [ ] **Step 3: Implement lifecycle helpers and status reporting**

Create `packages/skill-devkit/src/link.ts`:

```ts
import { mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { SkillError, SkillErrorCode } from '@luobata/skill-contracts'
import { loadSkillManifest } from './manifest-loader.js'
import { readLocalInstallsState, writeLocalInstallsState } from './state-store.js'

export async function linkSkill(input: { skillRoot: string; installRoot: string; stateFile: string }): Promise<void> {
  const manifest = loadSkillManifest(input.skillRoot)
  const installPath = resolve(input.installRoot, manifest.cocoInstallName)
  mkdirSync(input.installRoot, { recursive: true })

  rmSync(installPath, { recursive: true, force: true })
  symlinkSync(input.skillRoot, installPath, 'dir')

  const state = readLocalInstallsState(input.stateFile)
  state.skills[manifest.name] = {
    installName: manifest.cocoInstallName,
    mode: 'link',
    sourcePath: input.skillRoot,
    installedPath: installPath,
    version: manifest.version,
    updatedAt: new Date().toISOString()
  }
  await writeLocalInstallsState(input.stateFile, state)

  if (basename(readlinkSync(installPath)) === '') {
    throw new SkillError(SkillErrorCode.BrokenLocalInstall, 'Failed to create link install')
  }
}
```

Create `packages/skill-devkit/src/unlink.ts`:

```ts
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { SkillError, SkillErrorCode } from '@luobata/skill-contracts'
import { loadSkillManifest } from './manifest-loader.js'
import { detectInstallState } from './fs-probe.js'
import { readLocalInstallsState, writeLocalInstallsState } from './state-store.js'

export async function removeLinkedSkill(input: { skillRoot: string; installRoot: string; stateFile: string }): Promise<void> {
  const manifest = loadSkillManifest(input.skillRoot)
  const installPath = resolve(input.installRoot, manifest.cocoInstallName)
  const detected = detectInstallState(installPath, input.skillRoot)

  if (detected.kind === 'published-local') {
    throw new SkillError(SkillErrorCode.BrokenLocalInstall, 'unlink only removes linked installs')
  }

  rmSync(installPath, { recursive: true, force: true })
  const state = readLocalInstallsState(input.stateFile)
  delete state.skills[manifest.name]
  await writeLocalInstallsState(input.stateFile, state)
}
```

Create `packages/skill-devkit/src/publish-local.ts`:

```ts
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSkillManifest } from './manifest-loader.js'
import { packSkill } from './pack.js'
import { readLocalInstallsState, writeLocalInstallsState } from './state-store.js'

export async function publishLocalSkill(input: {
  skillRoot: string
  installRoot: string
  stateFile: string
  packRoot: string
}): Promise<void> {
  const manifest = loadSkillManifest(input.skillRoot)
  const packed = await packSkill({ skillRoot: input.skillRoot, packRoot: input.packRoot })
  const installPath = resolve(input.installRoot, manifest.cocoInstallName)
  mkdirSync(input.installRoot, { recursive: true })
  rmSync(installPath, { recursive: true, force: true })
  cpSync(packed.outputPath, installPath, { recursive: true })

  const state = readLocalInstallsState(input.stateFile)
  state.skills[manifest.name] = {
    installName: manifest.cocoInstallName,
    mode: 'publish-local',
    sourcePath: input.skillRoot,
    installedPath: installPath,
    packedPath: packed.outputPath,
    version: manifest.version,
    updatedAt: new Date().toISOString()
  }
  await writeLocalInstallsState(input.stateFile, state)
}
```

Create `packages/skill-devkit/src/status.ts`:

```ts
import { resolve } from 'node:path'
import { loadSkillManifest } from './manifest-loader.js'
import { detectInstallState } from './fs-probe.js'
import { readLocalInstallsState } from './state-store.js'

export function resolveSkillStatus(input: { skillRoot: string; installRoot: string; stateFile: string }) {
  const manifest = loadSkillManifest(input.skillRoot)
  const installPath = resolve(input.installRoot, manifest.cocoInstallName)
  const recorded = readLocalInstallsState(input.stateFile).skills[manifest.name] ?? null
  const detected = detectInstallState(installPath, input.skillRoot)
  const health =
    detected.kind === 'broken' || (recorded && recorded.mode === 'link' && detected.kind !== 'linked') ? 'broken' : 'ok'

  return { manifest, recorded, detected, health }
}
```

Create `packages/skill-devkit/src/doctor.ts`:

```ts
import { resolveSkillStatus } from './status.js'

export async function doctorSkill(input: { skillRoot: string; installRoot: string; stateFile: string }) {
  const status = resolveSkillStatus(input)
  const issues: string[] = []

  if (status.recorded && status.detected.kind === 'absent') {
    issues.push('record exists but installed path is missing')
  }

  if (status.detected.kind === 'broken') {
    issues.push(status.detected.reason)
  }

  return {
    health: issues.length === 0 ? 'ok' : 'broken',
    issues,
    status
  }
}
```

Update `packages/skill-devkit/src/index.ts`:

```ts
export * from './link.js'
export * from './unlink.js'
export * from './publish-local.js'
export * from './status.js'
export * from './doctor.js'
```

- [ ] **Step 4: Run the devkit lifecycle tests again**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
```

Expected: PASS.

- [ ] **Step 5: Run the devkit build again**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" build
```

Expected: PASS.

---

### Task 5: Expose the skill subcommand from apps/bata-workflow

**Files:**
- Create: `apps/bata-workflow/src/cli/skill-command.ts`
- Modify: `apps/bata-workflow/src/cli/index.ts`
- Create: `apps/bata-workflow/tests/skill-command.test.ts`

- [ ] **Step 1: Write failing CLI tests for the skill command glue**

Create `apps/bata-workflow/tests/skill-command.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { runSkillCommand } from '../src/cli/skill-command.js'

describe('runSkillCommand', () => {
  it('dispatches validate to the devkit', async () => {
    const validate = vi.fn(async () => undefined)

    await runSkillCommand({
      args: ['validate', 'monitor'],
      handlers: { validate } as never
    })

    expect(validate).toHaveBeenCalledWith('monitor')
  })

  it('dispatches doctor --fix with the fix flag set', async () => {
    const doctor = vi.fn(async () => undefined)

    await runSkillCommand({
      args: ['doctor', 'monitor', '--fix'],
      handlers: { doctor } as never
    })

    expect(doctor).toHaveBeenCalledWith('monitor', { fix: true })
  })

  it('rejects unknown subcommands', async () => {
    await expect(
      runSkillCommand({ args: ['explode', 'monitor'], handlers: {} as never })
    ).rejects.toThrow(/unknown skill subcommand/i)
  })
})
```

- [ ] **Step 2: Run the new CLI test to verify it fails**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test skill-command
```

Expected: FAIL because `skill-command.ts` does not exist yet.

- [ ] **Step 3: Implement the CLI subcommand module and wire it into the main CLI**

Create `apps/bata-workflow/src/cli/skill-command.ts`:

```ts
type SkillHandlers = {
  validate: (name: string) => Promise<void>
  link: (name: string) => Promise<void>
  unlink: (name: string) => Promise<void>
  pack: (name: string) => Promise<void>
  publishLocal: (name: string) => Promise<void>
  status: (name?: string) => Promise<void>
  doctor: (name?: string, options?: { fix: boolean }) => Promise<void>
}

export async function runSkillCommand(input: { args: string[]; handlers: SkillHandlers }): Promise<void> {
  const [subcommand, maybeName, ...rest] = input.args
  const name = maybeName && !maybeName.startsWith('-') ? maybeName : undefined
  const fix = rest.includes('--fix') || maybeName === '--fix'

  switch (subcommand) {
    case 'validate':
      if (!name) throw new Error('skill validate requires a skill name')
      return input.handlers.validate(name)
    case 'link':
      if (!name) throw new Error('skill link requires a skill name')
      return input.handlers.link(name)
    case 'unlink':
      if (!name) throw new Error('skill unlink requires a skill name')
      return input.handlers.unlink(name)
    case 'pack':
      if (!name) throw new Error('skill pack requires a skill name')
      return input.handlers.pack(name)
    case 'publish-local':
      if (!name) throw new Error('skill publish-local requires a skill name')
      return input.handlers.publishLocal(name)
    case 'status':
      return input.handlers.status(name)
    case 'doctor':
      return input.handlers.doctor(name, { fix })
    default:
      throw new Error(`unknown skill subcommand: ${subcommand}`)
  }
}
```

Modify `apps/bata-workflow/src/cli/index.ts` to intercept top-level `skill` before the existing goal validation branch:

```ts
import { runSkillCommand } from './skill-command.js'
import {
  doctorSkill,
  linkSkill,
  packSkill,
  publishLocalSkill,
  removeLinkedSkill,
  resolveSkillStatus
} from '@luobata/skill-devkit'
...
const { appRoot, repoRoot, stateRoot, skillsRoot, skillPacksRoot, skillStateRoot } = getHarnessRepoPaths()
...
if (rawCommand === 'skill') {
  const stateFile = resolve(skillStateRoot, 'local-installs.json')
  const installRoot = resolve(process.env.HOME ?? process.env.USERPROFILE ?? repoRoot, '.coco', 'skills')
  const resolveSkillRoot = (name: string) => resolve(skillsRoot, name)

  await runSkillCommand({
    args: rawArgs,
    handlers: {
      validate: async (name) => { loadSkillManifest(resolveSkillRoot(name)) },
      link: async (name) => { await linkSkill({ skillRoot: resolveSkillRoot(name), installRoot, stateFile }) },
      unlink: async (name) => { await removeLinkedSkill({ skillRoot: resolveSkillRoot(name), installRoot, stateFile }) },
      pack: async (name) => { await packSkill({ skillRoot: resolveSkillRoot(name), packRoot: skillPacksRoot }) },
      publishLocal: async (name) => {
        await publishLocalSkill({ skillRoot: resolveSkillRoot(name), installRoot, stateFile, packRoot: skillPacksRoot })
      },
      status: async (name) => {
        const result = resolveSkillStatus({ skillRoot: resolveSkillRoot(name ?? 'monitor'), installRoot, stateFile })
        process.stdout.write(`${result.manifest.name}: ${result.health}\n`)
      },
      doctor: async (name) => {
        const report = await doctorSkill({ skillRoot: resolveSkillRoot(name ?? 'monitor'), installRoot, stateFile })
        process.stdout.write(`${report.health}: ${report.issues.join(' | ') || 'ok'}\n`)
      }
    }
  })
  return
}
```

- [ ] **Step 4: Run the CLI test again**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test skill-command
```

Expected: PASS.

- [ ] **Step 5: Verify the app build still succeeds after the new dependency graph**

Run:

```bash
cd "/Users/bytedance/luobata/bata-skill/bata-workflow" && npx -y @microsoft/rush@5.175.0 build --to bata-workflow
```

Expected: PASS.

---

### Task 6: Seed `skills/monitor` and add end-to-end local install verification

**Files:**
- Create: `skills/monitor/SKILL.md`
- Create: `skills/monitor/skill.manifest.json`
- Modify: `packages/skill-devkit/src/devkit.test.ts`

- [ ] **Step 1: Add failing end-to-end tests for dev mode and publish-local mode**

Extend `packages/skill-devkit/src/devkit.test.ts` with these assertions:

```ts
it('reflects source edits immediately when installed via link', async () => {
  const sandbox = createSandbox()
  const installPath = resolve(sandbox.cocoRoot, 'monitor')

  await linkSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json')
  })

  writeFileSync(resolve(sandbox.skillRoot, 'SKILL.md'), '# monitor\nupdated\n', 'utf8')

  expect(readFileSync(resolve(installPath, 'SKILL.md'), 'utf8')).toContain('updated')
})

it('does not reflect source edits after publish-local installs a copied artifact', async () => {
  const sandbox = createSandbox()
  const installPath = resolve(sandbox.cocoRoot, 'monitor')

  await publishLocalSkill({
    skillRoot: sandbox.skillRoot,
    installRoot: sandbox.cocoRoot,
    stateFile: resolve(sandbox.stateRoot, 'local-installs.json'),
    packRoot: sandbox.packRoot
  })

  writeFileSync(resolve(sandbox.skillRoot, 'SKILL.md'), '# monitor\nsource changed\n', 'utf8')

  expect(readFileSync(resolve(installPath, 'SKILL.md'), 'utf8')).not.toContain('source changed')
})
```

- [ ] **Step 2: Run the devkit suite to confirm the new E2E cases fail until the seed skill exists**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
```

Expected: FAIL if the real repo seed skill has not been created yet or if pack/publish behavior is still incorrect.

- [ ] **Step 3: Create the first real skill source directory**

Create `skills/monitor/SKILL.md`:

```md
# monitor

Use this skill to open or attach to the AI coding monitor board for the current root session.

## Expected behavior

- Root actor may create the monitor session for the current root session.
- Child actors must attach to the existing monitor session.
- The monitor session id is derived as `monitor:<rootSessionId>`.
- Nested monitor creation is not allowed.
```

Create `skills/monitor/skill.manifest.json`:

```json
{
  "name": "monitor",
  "displayName": "Monitor",
  "entry": "SKILL.md",
  "cocoInstallName": "monitor",
  "version": "0.1.0-local",
  "files": [
    "SKILL.md"
  ],
  "dev": {
    "link": true,
    "publishLocal": true
  },
  "metadata": {
    "description": "Open or attach to the local AI coding monitor board",
    "tags": ["monitor", "debug", "board"]
  }
}
```

Use the existing monitor board source as the semantic reference only:

```ts
// Reference behavior from apps/monitor-board/src/monitor/skill/monitor-command.ts
export const deriveMonitorSessionId = (rootSessionId: string): string => `monitor:${rootSessionId}`
```

- [ ] **Step 4: Run the full package-level verification for the new local workflow**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" test
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/packages/skill-devkit" build
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" test skill-command
cd "/Users/bytedance/luobata/bata-skill/bata-workflow" && npx -y @microsoft/rush@5.175.0 build --to bata-workflow --to @luobata/skill-contracts --to @luobata/skill-devkit
```

Expected: all commands PASS.

- [ ] **Step 5: Manually smoke-test the local workflow against the developer coco directory**

Run:

```bash
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev skill validate monitor
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev skill link monitor
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev skill status monitor
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev skill publish-local monitor
pnpm --dir "/Users/bytedance/luobata/bata-skill/bata-workflow/apps/bata-workflow" dev skill doctor monitor
```

Expected:

- `validate` succeeds
- `link` creates `~/.coco/skills/monitor` as a symlink
- `status` reports `ok`
- `publish-local` replaces the link with a copied artifact
- `doctor` reports either `ok` or actionable issues with explicit guidance

- [ ] **Step 6: Optional commit checkpoint**

Only if the user explicitly requests commits during execution:

```bash
git add \
  skills/monitor \
  apps/bata-workflow/src/cli/index.ts \
  apps/bata-workflow/src/cli/skill-command.ts \
  apps/bata-workflow/tests/skill-command.test.ts \
  packages/skill-contracts \
  packages/skill-devkit
```

---

## Plan Self-Review

### Spec coverage

- `skills/*` 源码层：Task 6
- `packages/skill-contracts`：Task 2
- `packages/skill-devkit`：Task 3 + Task 4
- `apps/bata-workflow` 作为 CLI shell：Task 5
- `.bata-workflow/state/skills` 与 `.bata-workflow/skill-packs`：Task 1 + Task 3 + Task 4
- 本地双轨安装（`link` / `publish-local`）：Task 4 + Task 6
- `status` / `doctor`：Task 4
- 测试与验收标准：Task 2–6 的每一步验证命令

### Placeholder scan

- No `TODO` / `TBD`
- 所有步骤都给出了具体文件、代码和命令

### Type consistency

- `SkillManifestSchema`、`LocalInstallRecordSchema`、`PackMetadataSchema` 统一先在 `@luobata/skill-contracts` 定义，再由 `@luobata/skill-devkit` 使用
- `mode` 固定为 `link | publish-local`
- `doctorSkill` 与 `resolveSkillStatus` 在 Task 4 中定义并在 Task 5/6 复用

