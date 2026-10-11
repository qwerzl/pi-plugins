import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export const runtimeDirectory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'browser-runtime')

export async function loadRuntime(directory = runtimeDirectory): Promise<{ command: string, args: string[], env: Record<string, string> }> {
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
  }
  catch (cause) {
    throw new Error(`Cannot read pinned browser runtime at ${directory}. Run the browser package setup command first.`, { cause })
  }
  if (!metadata || typeof metadata !== 'object'
    || !('version' in metadata) || typeof metadata.version !== 'string'
    || !('platform' in metadata) || metadata.platform !== process.platform
    || !('arch' in metadata) || metadata.arch !== process.arch) {
    throw new Error('Invalid or incompatible pinned browser runtime. Run the browser package setup command on this machine.')
  }
  const root = join(directory, 'cua_node')
  const modules = join(root, 'lib', 'node_modules')
  const command = join(root, 'bin', 'node')
  const args = [join(modules, '@oai', 'cua-repl', 'bin', 'cua-repl.mjs')]
  const repl = join(root, 'bin', 'node_repl')
  await Promise.all([command, args[0], repl].map(path => access(path)))
  return {
    command,
    args,
    env: {
      CODEX_HOME: join(homedir(), '.codex'),
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: '1000',
      NODE_REPL_NODE_MODULE_DIRS: modules,
      NODE_REPL_NODE_PATH: command,
      NODE_REPL_TRUSTED_CODE_PATHS: modules,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: '@oai/browser-desktop/service' }),
      CUA_REPL_NODE_REPL_PATH: repl,
      CUA_REPL_ENABLED_SURFACES: 'browser',
      BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
      BROWSER_USE_TINYSKY_ENABLED: '1',
      BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
      BROWSER_USE_CODEX_APP_VERSION: metadata.version,
    },
  }
}
