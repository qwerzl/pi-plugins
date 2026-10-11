import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

// Test the configured launcher from a nested package, not just the binary directly.
it('effect LSP reports TypeScript and Effect errors, then clears them after an edit', { timeout: 30000 }, async ({ onTestFinished }) => {
  const root = new URL('../', import.meta.url)
  const require = createRequire(import.meta.url)
  assert.match(require('typescript/package.json').version, /^6\./)
  assert.equal(require('@typescript/native/package.json').version, '7.0.2')
  const config = JSON.parse(await readFile(new URL('.pi-lens.json', root), 'utf8'))
  const server = config.lsp.servers['effect-tsgo']
  const child = spawn(server.command, server.args, {
    cwd: fileURLToPath(new URL('packages/codexcont/', root)),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  onTestFinished(() => {
    if (child.exitCode !== null || !child.pid)
      return
    if (process.platform === 'win32')
      child.kill()
    else
      process.kill(-child.pid, 'SIGTERM')
  })

  let buffer = Buffer.alloc(0)
  let nextId = 0
  let stderr = ''
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  function send(message: object): void {
    const data = JSON.stringify({ jsonrpc: '2.0', ...message })
    child.stdin.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`)
  }

  function request(method: string, params?: object): Promise<unknown> {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ id, method, params })
    })
  }

  child.on('error', (error) => {
    for (const waiter of pending.values())
      waiter.reject(error)
  })
  child.on('exit', (code) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`LSP exited with ${code}: ${stderr}`))
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const separator = buffer.indexOf('\r\n\r\n')
      if (separator < 0)
        return
      const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())
      assert.ok(length, 'Launcher must emit only framed LSP messages on stdout')
      const end = separator + 4 + Number(length[1])
      if (buffer.length < end)
        return
      const message = JSON.parse(buffer.subarray(separator + 4, end).toString())
      buffer = buffer.subarray(end)
      if (message.method && message.id !== undefined) {
        send({ id: message.id, result: null })
        continue
      }
      const waiter = pending.get(message.id)
      if (!waiter)
        continue
      pending.delete(message.id)
      if (message.error)
        waiter.reject(new Error(JSON.stringify(message.error)))
      else
        waiter.resolve(message.result)
    }
  })

  const initialized = await request('initialize', {
    processId: process.pid,
    rootUri: root.href,
    workspaceFolders: [{ uri: root.href, name: 'pi-plugins' }],
    capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } },
  })
  assert.ok(initialized && typeof initialized === 'object' && 'capabilities' in initialized)
  assert.ok(initialized.capabilities && typeof initialized.capabilities === 'object' && 'diagnosticProvider' in initialized.capabilities)
  send({ method: 'initialized', params: {} })
  const uri = new URL('packages/codexcont/src/__effect_lsp_probe__.ts', root).href
  send({
    method: 'textDocument/didOpen',
    params: { textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'import { Effect } from "effect"\nexport const value: number = "wrong"\nexport function floating() { Effect.succeed(1) }\n',
    } },
  })
  const dirty = await request('textDocument/diagnostic', { textDocument: { uri } })
  const diagnostics = JSON.stringify(dirty)
  assert.match(diagnostics, /2322/, 'Expected a normal TypeScript assignment error')
  assert.match(diagnostics, /floatingEffect/, 'Expected an Effect-specific diagnostic')
  const symbols = await request('textDocument/documentSymbol', { textDocument: { uri } })
  assert.match(JSON.stringify(symbols), /floating/, 'Expected working symbol navigation')

  send({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: 'import { Effect } from "effect"\nexport const value: number = 1\nexport const task = Effect.succeed(1)\n' }],
    },
  })
  const clean = await request('textDocument/diagnostic', { textDocument: { uri } })
  assert.deepEqual(clean, { kind: 'full', items: [] })
  send({ method: 'textDocument/didClose', params: { textDocument: { uri } } })
  await request('shutdown')
  const exited = once(child, 'exit')
  send({ method: 'exit' })
  const [code] = await exited
  // The pinned native server can report context cancellation after acknowledging shutdown.
  assert.ok(code === 0 || (code === 1 && stderr.trim() === 'context canceled'), stderr)
})
