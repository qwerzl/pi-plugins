import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadRuntime } from './runtime.ts'
import { copyRuntime } from './setup.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-test-'))
  directories.push(directory)
  const source = join(directory, 'app', 'cua_node')
  const manifest = join(directory, 'plugin', '.mcp.json')
  const destination = join(directory, 'pinned')
  for (const name of ['bin/node', 'bin/node_repl', 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs', 'LICENSE']) {
    const file = join(source, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `original ${name}`)
  }
  await mkdir(join(dirname(manifest), '.codex-plugin'), { recursive: true })
  await writeFile(join(dirname(manifest), '.codex-plugin/plugin.json'), '{"license":"Proprietary"}')
  await writeFile(manifest, JSON.stringify({ mcpServers: { cua_repl: { command: join(source, 'bin/node'), env: { BROWSER_USE_CODEX_APP_VERSION: '26.test' } } } }))
  return { source, manifest, destination }
}

it('copies rather than links the runtime, keeps notices, and relocates every launch path', async () => {
  const { source, manifest, destination } = await fixture()
  await copyRuntime(manifest, destination)
  await rm(source, { recursive: true })
  const config = await loadRuntime(destination)
  expect(config.command).toBe(join(destination, 'cua_node/bin/node'))
  expect(JSON.stringify(config)).not.toContain('/app/')
  expect(config.env.CUA_REPL_ENABLED_SURFACES).toBe('browser')
  expect(config.env.BROWSER_USE_AVAILABLE_BACKENDS).toBe('chrome')
  expect(config.env.NODE_REPL_TRUSTED_SERVICES).not.toContain('sky')
  expect(config.env).not.toHaveProperty('CODEX_CLI_PATH')
  expect(await readFile(config.command, 'utf8')).toBe('original bin/node')
  expect(await readFile(join(destination, 'cua_node/LICENSE'), 'utf8')).toBe('original LICENSE')
  expect(await readFile(join(destination, 'source-plugin.json'), 'utf8')).toContain('Proprietary')
})

it('never overwrites an installed runtime on a later setup', async () => {
  const { manifest, destination } = await fixture()
  await copyRuntime(manifest, destination)
  await expect(copyRuntime(manifest, destination)).rejects.toThrow('already exists')
  expect(await readFile(join(destination, 'cua_node/bin/node'), 'utf8')).toBe('original bin/node')
})

it('rejects missing files, malformed metadata, and incompatible platforms', async () => {
  const { destination, manifest } = await fixture()
  await expect(loadRuntime(destination)).rejects.toThrow('setup command')
  await copyRuntime(manifest, destination)
  const metadata = join(destination, 'runtime.json')
  await writeFile(metadata, '{bad json')
  await expect(loadRuntime(destination)).rejects.toThrow('Cannot read')
  await writeFile(metadata, JSON.stringify({ version: 'test', platform: 'unsupported', arch: process.arch }))
  await expect(loadRuntime(destination)).rejects.toThrow('incompatible')
})

it('rejects bad source manifests and incomplete copies without installing them', async () => {
  const { manifest, destination, source } = await fixture()
  await rm(join(source, 'bin/node_repl'))
  await expect(copyRuntime(manifest, destination)).rejects.toThrow()
  await expect(readFile(join(destination, 'runtime.json'))).rejects.toThrow()
  await writeFile(manifest, '{}')
  await expect(copyRuntime(manifest, destination)).rejects.toThrow('Expected a Codex')
  await writeFile(manifest, 'invalid')
  await expect(copyRuntime(manifest, destination)).rejects.toThrow('Cannot read the source')
})
