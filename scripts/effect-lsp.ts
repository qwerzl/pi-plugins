import { spawn } from 'node:child_process'
import { chmodSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import getExePath from '@effect/tsgo/lib/getExePath'

// Resolve the pinned native compiler from this workspace, even when started in a package.
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const executable = getExePath()
chmodSync(executable, 0o755)
const child = spawn(executable, ['--lsp', '--stdio'], { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => child.kill(signal))
child.once('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
