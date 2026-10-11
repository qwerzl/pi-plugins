import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadRuntime, runtimeDirectory } from './runtime.ts'

export async function copyRuntime(sourceManifest: string, destination = runtimeDirectory): Promise<void> {
  let manifest: { mcpServers?: { cua_repl?: { command?: unknown, env?: { BROWSER_USE_CODEX_APP_VERSION?: unknown } } } }
  try {
    manifest = JSON.parse(await readFile(sourceManifest, 'utf8'))
  }
  catch (cause) {
    throw new Error('Cannot read the source cua_repl MCP manifest.', { cause })
  }
  const source = manifest?.mcpServers?.cua_repl
  const version = source?.env?.BROWSER_USE_CODEX_APP_VERSION
  if (typeof source?.command !== 'string' || typeof version !== 'string' || basename(source.command) !== 'node')
    throw new Error('Expected a Codex cua_repl manifest with a Node executable and app version.')
  const sourceRoot = dirname(dirname(source.command))
  if (basename(sourceRoot) !== 'cua_node')
    throw new Error('Expected the complete cua_node directory; refusing to copy an arbitrary directory.')

  await mkdir(dirname(destination), { recursive: true })
  // A lock prevents replacing an existing or currently running pinned runtime.
  const lock = `${destination}.installing`
  await mkdir(lock)
  let staging: string | undefined
  try {
    const existing = await readFile(join(destination, 'runtime.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
      return undefined
    })
    if (existing !== undefined)
      throw new Error(`A pinned runtime already exists at ${destination}. Choose another destination to upgrade explicitly.`)
    staging = await mkdtemp(join(dirname(destination), '.browser-runtime-'))
    await cp(sourceRoot, join(staging, 'cua_node'), { recursive: true, dereference: true })
    await cp(sourceManifest, join(staging, 'source-mcp.json'))
    await cp(join(dirname(sourceManifest), '.codex-plugin', 'plugin.json'), join(staging, 'source-plugin.json'))
    await writeFile(join(staging, 'runtime.json'), `${JSON.stringify({ version, platform: process.platform, arch: process.arch }, null, 2)}\n`)
    await writeFile(join(staging, 'README.txt'), 'Private personal-use copy of the installed Codex browser runtime.\nOriginal files and bundled notices are preserved unchanged in cua_node.\nThis copy is not covered by the Pi adapter license and must not be published.\nsource-mcp.json is provenance only; Pi uses its own relocated browser-only configuration.\nThe Codex Chrome extension and its native messaging host are still required.\n')
    await loadRuntime(staging)
    await rename(staging, destination)
    staging = undefined
  }
  finally {
    if (staging)
      await rm(staging, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv[2]
  if (!manifest)
    throw new Error('Usage: node src/setup.ts /path/to/unified-computer-use/VERSION/.mcp.json [destination]')
  copyRuntime(resolve(manifest), process.argv[3] ? resolve(process.argv[3]) : undefined).then(() => {
    process.stdout.write(`Pinned browser runtime: ${process.argv[3] || runtimeDirectory}\n`)
  }).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
