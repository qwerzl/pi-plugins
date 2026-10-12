import type { AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai'
import type { AgentSession, ExtensionFactory, ProviderConfig } from '@earendil-works/pi-coding-agent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import extension from './index.ts'

const disconnect = 'stream error: stream disconnected before completion: stream closed before response.completed'
const model: Model<'openai-responses'> = {
  id: 'test',
  name: 'Test',
  provider: 'retry-test',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function reply(errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: errorMessage ? 'Partial answer' : 'Done' }],
    stopReason: errorMessage ? 'error' : 'stop',
    errorMessage,
    timestamp: Date.now(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
}

interface Attempt {
  message: AssistantMessage
  status?: number
  previousStatus?: number
  headers?: Record<string, string>
  event?: unknown
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type RetrySettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>['retry']

async function harness(attempts: Attempt[], retry: RetrySettings = { enabled: false, provider: { maxRetries: 0 } }, before?: ExtensionFactory) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-codex-retry-'))
  const settingsManager = SettingsManager.inMemory({ retry, compaction: { enabled: false } })
  const contexts: TranscriptContext[] = []
  const streamSimple = vi.fn<NonNullable<ProviderConfig['streamSimple']>>((selected, context, options) => {
    contexts.push(structuredClone(context))
    const attempt = attempts[Math.min(contexts.length - 1, attempts.length - 1)]
    const out = createAssistantMessageEventStream()
    void (async () => {
      if (attempt.previousStatus !== undefined)
        await options?.onResponse?.({ status: attempt.previousStatus, headers: {} }, selected)
      await options?.onPayload?.({}, selected)
      if (attempt.status !== undefined)
        await options?.onResponse?.({ status: attempt.status, headers: attempt.headers ?? {} }, selected)
      if (attempt.event)
        await options?.onProviderStreamEvent?.(attempt.event, selected)
      const message = structuredClone(attempt.message)
      out.push({ type: 'start', partial: message })
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        out.push({ type: 'error', reason: message.stopReason, error: message })
      else if (message.stopReason !== 'pending')
        out.push({ type: 'done', reason: message.stopReason, message })
      out.end()
    })()
    return out
  })
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => { pi.registerProvider(model.provider, { apiKey: 'test-only', api: model.api, models: [model], streamSimple }) },
      ...(before ? [before] : []),
      extension,
    ],
  })
  await loader.reload()
  expect(loader.getExtensions().errors).toEqual([])
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
  let session: AgentSession | undefined
  const errors: unknown[] = []
  cleanups.push(async () => {
    await session?.abort()
    session?.dispose()
    await rm(dir, { recursive: true, force: true })
    expect(errors).toEqual([])
  })
  const manager = SessionManager.inMemory(dir)
  ;({ session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: manager,
    tools: [],
    thinkingLevel: 'off',
  }))
  await session.bindExtensions({ onError: error => errors.push(error) })
  const events: string[] = []
  session.subscribe(event => events.push(event.type))
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return { session, manager, streamSimple, contexts, events, settingsManager }
}

async function flush() {
  for (let i = 0; i < 4; i++)
    await new Promise<void>(resolve => setImmediate(resolve))
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

async function exhaust() {
  for (const delay of [200, 400, 800, 1600, 3200])
    await advance(delay)
}

describe('real Pi 1.1 lifecycle', () => {
  it('retries the screenshot error inside prompt(), without hidden prompts or native retries', async () => {
    const h = await harness([{ message: reply(disconnect) }, { message: reply() }])
    const settled = vi.fn()
    const running = h.session.prompt('Do the work').then(settled)
    await flush()
    expect(h.contexts).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
    await advance(199)
    expect(h.contexts).toHaveLength(1)
    await advance(1)
    await running
    expect(h.contexts).toHaveLength(2)
    expect(h.contexts[1]).toEqual(h.contexts[0])
    expect(h.manager.getEntries().filter(entry => entry.type === 'context_edit')).toHaveLength(1)
    expect(h.manager.getEntries().filter(entry => entry.type === 'custom_message')).toHaveLength(0)
    expect(h.events).not.toContain('auto_retry_start')
    expect(h.events.filter(type => type === 'agent_settled')).toHaveLength(1)
    expect(h.session.getLastAssistantText()).toBe('Done')
  })

  it('makes six attempts total and preserves the final error, then resets for a new prompt', async () => {
    const h = await harness([{ message: reply(disconnect) }])
    const running = h.session.prompt('Try')
    await flush()
    await exhaust()
    await running
    expect(h.contexts).toHaveLength(6)
    expect(h.session.messages.at(-1)).toMatchObject({ stopReason: 'error', errorMessage: disconnect })
    const next = h.session.prompt('Try again')
    await flush()
    expect(h.contexts).toHaveLength(7)
    await exhaust()
    await next
    expect(h.contexts).toHaveLength(12)
  })

  it('cancels backoff promptly through the real session abort signal', async () => {
    const h = await harness([{ message: reply(disconnect) }])
    const running = h.session.prompt('Try')
    await flush()
    await h.session.abort()
    await running
    await advance(60_000)
    expect(h.contexts).toHaveLength(1)
    expect(h.manager.getEntries().some(entry => entry.type === 'context_edit')).toBe(false)
    expect(h.session.isIdle).toBe(true)
  })

  it('does not retry user-aborted responses or permanent errors', async () => {
    const h = await harness([{ message: { ...reply(disconnect), stopReason: 'aborted' } }])
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([400, 429])('preserves observed HTTP %i even when the message sounds transient', async (status) => {
    const h = await harness([{ message: reply('Connection error.'), status }])
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
  })

  it.each([400, 429])('does not retry provider-prefixed HTTP %i without a response callback', async (status) => {
    const h = await harness([{ message: reply(`OpenAI API error (${status}): rate_limit_exceeded; try again in 1 second`) }])
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
  })

  it('retries provider-prefixed HTTP 503 without a response callback', async () => {
    const h = await harness([{ message: reply('cpa API error (503): unavailable') }, { message: reply() }])
    const running = h.session.prompt('Try')
    await flush()
    await advance(200)
    await running
    expect(h.contexts).toHaveLength(2)
  })

  it('preserves proposed entries from an earlier extension', async () => {
    const h = await harness([{ message: reply(disconnect) }, { message: reply() }], undefined, (pi) => {
      pi.on('turn_end', (event) => {
        if (event.outcome === 'error')
          return { entries: [...event.entries, { type: 'custom', customType: 'other-extension', data: 'keep me' }] }
      })
    })
    const running = h.session.prompt('Try')
    await flush()
    await advance(200)
    await running
    expect(h.manager.getEntries()).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'other-extension', data: 'keep me' }))
    expect(h.manager.getEntries().filter(entry => entry.type === 'context_edit')).toHaveLength(1)
  })

  it('honors structured stream rate-limit advice', async () => {
    const h = await harness([
      { message: reply('Rate limit'), status: 200, event: { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'try again in 1.25 seconds' } } } },
      { message: reply() },
    ])
    const running = h.session.prompt('Try')
    await flush()
    await advance(1249)
    expect(h.contexts).toHaveLength(1)
    await advance(1)
    await running
    expect(h.contexts).toHaveLength(2)
  })

  it('keeps explicit connection recovery separate, capped at 60s without jitter or a retry count limit', async () => {
    const h = await harness([{ message: reply('Connection failed: offline') }])
    const running = h.session.prompt('Try')
    await flush()
    for (const [index, delay] of [5000, 10000, 20000, 40000, 60000, 60000, 60000].entries()) {
      await advance(delay - 1)
      expect(h.contexts).toHaveLength(index + 1)
      await advance(1)
      expect(h.contexts).toHaveLength(index + 2)
    }
    await h.session.abort()
    await running
  })

  it('retains completed tool results and never executes a tool from a failed partial response', async () => {
    const failed = reply(disconnect)
    failed.content.push({ type: 'toolCall', id: 'partial-call', name: 'read', arguments: { path: 'missing' } })
    const h = await harness([{ message: failed }, { message: reply() }])
    h.manager.appendMessage({ role: 'user', content: 'Earlier task', timestamp: 0 })
    h.manager.appendMessage({ ...reply(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'finished', name: 'read', arguments: {} }] })
    h.manager.appendMessage({ role: 'toolResult', toolCallId: 'finished', toolName: 'read', content: [{ type: 'text', text: 'Already read' }], isError: false, timestamp: 0 })
    const running = h.session.prompt('Continue')
    await flush()
    await advance(200)
    await running
    expect(h.contexts[1]).toEqual(h.contexts[0])
    expect(h.contexts[1].messages.some(message => message.role === 'toolResult')).toBe(true)
    expect(h.events).not.toContain('tool_execution_start')
  })

  it('stays inactive when native retry is enabled instead of stacking budgets', async () => {
    const h = await harness([{ message: reply(disconnect) }], { enabled: true })
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
    expect(h.manager.getEntries().some(entry => entry.type === 'context_edit')).toBe(false)
  })

  it('stays inactive when provider-level retries are configured', async () => {
    const h = await harness([{ message: reply(disconnect) }], { enabled: false, provider: { maxRetries: 2 } })
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
  })

  it('ignores HTTP Retry-After just like the pinned Codex sampling policy', async () => {
    const h = await harness([{ message: reply('503 Unavailable'), status: 503, headers: { 'retry-after': '120' } }, { message: reply() }])
    const running = h.session.prompt('Try')
    await flush()
    await advance(200)
    await running
    expect(h.contexts).toHaveLength(2)
  })

  it('resets the budget after a successful tool-call response within the same prompt', async () => {
    const toolReply: AssistantMessage = { ...reply(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'not_registered', arguments: {} }] }
    const h = await harness([{ message: reply(disconnect) }, { message: reply(disconnect) }, { message: toolReply }, { message: reply(disconnect) }, { message: reply() }])
    const running = h.session.prompt('Try')
    await flush()
    await advance(200)
    await advance(400)
    expect(h.contexts).toHaveLength(4)
    await advance(199)
    expect(h.contexts).toHaveLength(4)
    await advance(1)
    await running
    expect(h.contexts).toHaveLength(5)
    expect(h.contexts[4].messages).toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: 'call' }))
  })

  it('does not reset connection delay or spend stream budget on intervening connection failures', async () => {
    const h = await harness([
      { message: reply('Connection failed: offline') },
      { message: reply(disconnect) },
      { message: reply('Connection failed: offline') },
      { message: reply(disconnect) },
    ])
    const running = h.session.prompt('Try')
    await flush()
    await advance(5000)
    await advance(200)
    await advance(9999)
    expect(h.contexts).toHaveLength(3)
    await advance(1)
    for (const delay of [400, 800, 1600, 3200])
      await advance(delay)
    await running
    expect(h.contexts).toHaveLength(8)
  })

  it('does not reuse HTTP metadata from an earlier request folded into the same response', async () => {
    const h = await harness([{ message: reply('Connection failed: offline'), previousStatus: 429 }, { message: reply() }])
    const running = h.session.prompt('Try')
    await flush()
    await advance(4999)
    expect(h.contexts).toHaveLength(1)
    await advance(1)
    await running
    expect(h.contexts).toHaveLength(2)
  })

  it('bounds ambiguous connection failures instead of waiting forever', async () => {
    const h = await harness([{ message: reply('Connection error.') }])
    const running = h.session.prompt('Try')
    await flush()
    await exhaust()
    await running
    expect(h.contexts).toHaveLength(6)
  })

  it('avoids Node timer overflow for long server-requested delays', async () => {
    const h = await harness([{ message: reply('rate_limit_exceeded: try again in 3000000 seconds') }])
    const running = h.session.prompt('Try')
    await flush()
    await advance(60_000)
    expect(h.contexts).toHaveLength(1)
    await h.session.abort()
    await running
  })

  it('does not continue successful, empty, or length-limited replies', async () => {
    const h = await harness([{ message: { ...reply(), content: [], stopReason: 'length' } }])
    await h.session.prompt('Try')
    expect(h.contexts).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not add a retry after new input arrives during backoff', async () => {
    const h = await harness([{ message: reply(disconnect) }, { message: reply() }])
    const running = h.session.prompt('Old request')
    await flush()
    await h.session.steer('New request')
    await advance(200)
    await running
    expect(h.contexts).toHaveLength(2)
    expect(h.contexts[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'New request' }] }))
    expect(h.manager.getEntries().some(entry => entry.type === 'context_edit')).toBe(false)
  })
})
