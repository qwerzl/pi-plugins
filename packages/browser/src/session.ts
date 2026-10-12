import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { CallToolResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Data, Effect, Semaphore } from 'effect'
import { loadRuntime, runtimeDirectory } from './runtime.ts'

class BrowserError extends Data.TaggedError('BrowserError')<{ message: string, cause: unknown }> {}

interface BrowserContext {
  hasUI: boolean
  ui: Pick<ExtensionContext['ui'], 'select'>
}

export async function requestApproval(params: ElicitRequest['params'], ctx: BrowserContext | undefined, signal: AbortSignal): Promise<ElicitResult> {
  if (!ctx?.hasUI || signal.aborted || params.mode === 'url'
    || params._meta?.codex_request_type !== 'approval_request'
    || params._meta?.codex_approval_kind !== 'mcp_tool_call'
    || typeof params._meta?.tool_name !== 'string'
    || Object.keys(params.requestedSchema.properties).length !== 0
    || params.requestedSchema.required?.length) {
    return { action: 'cancel' as const }
  }
  const message = stripVTControlCharacters(`${params.message}\n\n${JSON.stringify({
    action: params._meta.tool_name,
    origin: params._meta.origin,
    persistence: params._meta.persist,
    sensitive: params._meta.codex_sensitive_action,
    parameters: params._meta.tool_params,
  }, null, 2)}`)
  if (message.length > 20000)
    return { action: 'cancel' as const }
  const choice = await ctx.ui.select(message, ['Deny', 'Allow'], { signal, timeout: 120000 })
  if (signal.aborted || choice === undefined)
    return { action: 'cancel' as const }
  return choice === 'Allow' ? { action: 'accept' as const, content: {} } : { action: 'decline' as const }
}

export class BrowserSession {
  private readonly sessionId = randomUUID()
  private readonly gate = Semaphore.makeUnsafe(1)
  private client: Client | undefined
  private turnId: string | undefined
  private context: BrowserContext | undefined
  private operationSignal: AbortSignal | undefined
  private cleanupFailed = false

  private readonly directory: string

  constructor(directory = runtimeDirectory) {
    this.directory = directory
  }

  private serial<A>(operation: (signal: AbortSignal) => Promise<A>, signal?: AbortSignal): Promise<A> {
    const requestSignal = signal ?? new AbortController().signal
    // Let the SDK finish cancelling before releasing the shared REPL/approval context.
    const task = Effect.tryPromise({
      try: () => {
        requestSignal.throwIfAborted()
        return operation(requestSignal)
      },
      catch: cause => new BrowserError({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    }).pipe(Effect.uninterruptible)
    return Effect.runPromise(this.gate.withPermit(task), { signal })
  }

  private async connect(signal: AbortSignal): Promise<Client> {
    if (this.client)
      return this.client
    const config = await loadRuntime(this.directory)
    const client = new Client({ name: 'pi-browser', version: '0.1.0' }, { capabilities: { elicitation: { form: {} } } })
    const transport = new StdioClientTransport({ ...config, env: { ...getDefaultEnvironment(), ...config.env }, stderr: 'pipe' })
    // Drain stderr without persisting potentially private browser data.
    transport.stderr?.on('data', () => undefined)
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => requestApproval(
      request.params,
      this.context,
      this.operationSignal ? AbortSignal.any([extra.signal, this.operationSignal]) : extra.signal,
    ))
    try {
      await client.connect(transport, { timeout: 30000, signal })
      const { tools } = await client.listTools(undefined, { timeout: 10000, signal })
      for (const name of ['js', 'js_reset', 'turn_ended']) {
        if (!tools.some(tool => tool.name === name))
          throw new Error(`Pinned browser runtime is missing the ${name} tool.`)
      }
      signal.throwIfAborted()
      this.client = client
      return client
    }
    catch (error) {
      await client.close()
      throw error
    }
  }

  execute(code: string, title: string, timeout: number, ctx: BrowserContext, signal?: AbortSignal): Promise<CallToolResult> {
    return this.serial(async (operationSignal) => {
      if (this.cleanupFailed)
        throw new Error('Browser turn cleanup failed. Use browser_reset before continuing; some browser tabs may still be open.')
      this.context = ctx
      this.operationSignal = operationSignal
      try {
        const client = await this.connect(operationSignal)
        operationSignal.throwIfAborted()
        this.turnId ??= randomUUID()
        return CallToolResultSchema.parse(await client.callTool({
          name: 'js',
          arguments: { code, title, timeout_ms: timeout },
          _meta: { 'x-codex-turn-metadata': { session_id: this.sessionId, turn_id: this.turnId } },
        }, CallToolResultSchema, { signal: operationSignal, timeout: timeout + 150000 }))
      }
      finally {
        this.context = undefined
        this.operationSignal = undefined
      }
    }, signal)
  }

  private async endTurn(hook: 'Stop' | 'Interrupt'): Promise<void> {
    if (!this.client || !this.turnId)
      return
    try {
      const result = CallToolResultSchema.parse(await this.client.callTool({
        name: 'turn_ended',
        arguments: { hook_event_name: hook, session_id: this.sessionId, turn_id: this.turnId },
      }, CallToolResultSchema, { timeout: 10000 }))
      if (result.isError)
        throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
      this.turnId = undefined
    }
    catch (error) {
      this.cleanupFailed = true
      throw error
    }
  }

  finishTurn(aborted = false): Promise<void> {
    return this.serial(() => this.endTurn(aborted ? 'Interrupt' : 'Stop'))
  }

  close(): Promise<string | undefined> {
    return this.serial(async () => {
      let warning: string | undefined
      try {
        await this.endTurn('Interrupt')
      }
      catch (error) {
        warning = `Browser turn cleanup failed; some browser tabs may still be open. ${String(error)}`
      }
      finally {
        await this.client?.close()
        this.client = undefined
        this.turnId = undefined
      }
      return warning
    })
  }
}
