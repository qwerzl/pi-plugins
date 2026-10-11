import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import extension from './index.ts'

const model: Model<'openai-responses'> = {
  id: 'test',
  name: 'Test',
  provider: 'test',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function reply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: 'stop',
    timestamp: 0,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0))
    cleanup()
  vi.useRealTimers()
})

function harness(manager = SessionManager.inMemory()) {
  const handlers = new Map<string, unknown>()
  const result = vi.fn<() => Promise<AssistantMessage>>().mockResolvedValue(reply('🏷️ Auto titles'))
  const streamSimple = vi.fn<ModelRegistry['streamSimple']>(() => {
    const stream = createAssistantMessageEventStream()
    vi.spyOn(stream, 'result').mockImplementation(result)
    return stream
  })
  const setSessionName = vi.fn((name: string) => manager.appendSessionInfo(name))
  const appendEntry = vi.fn((type: string, data?: unknown) => manager.appendCustomEntry(type, data))
  const registry: Partial<ModelRegistry> = { streamSimple }
  const setTitle = vi.fn()
  const ui: Partial<ExtensionContext['ui']> = { setTitle }
  const ctx: Partial<ExtensionContext> = { hasUI: true, model, sessionManager: manager, modelRegistry: registry as ModelRegistry, ui: ui as ExtensionContext['ui'] }
  const api: Partial<ExtensionAPI> = {
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
      }
    },
    getSessionName: () => manager.getSessionName(),
    setSessionName,
    appendEntry,
  }
  extension(api as ExtensionAPI)
  function fire(event: ExtensionEvent) {
    const handler = handlers.get(event.type) as ((event: ExtensionEvent, ctx: ExtensionContext) => unknown) | undefined
    return handler?.(event, ctx as ExtensionContext)
  }
  function exchange(text = 'Please give conversations automatic titles') {
    manager.appendMessage({ role: 'user', content: text, timestamp: 0 })
    manager.appendMessage(reply('Done'))
  }
  fire({ type: 'session_start', reason: 'startup' })
  cleanups.push(() => {
    fire({ type: 'session_shutdown', reason: 'quit' })
  })
  return { manager, result, streamSimple, setSessionName, setTitle, appendEntry, ctx, fire, exchange }
}

function deferredReply() {
  let resolve!: (message: AssistantMessage) => void
  const promise = new Promise<AssistantMessage>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

const settled = { type: 'agent_settled', aborted: false } as const

describe('automatic session titles', () => {
  it('names in the background using the active model without reasoning or tools', async () => {
    const h = harness()
    h.exchange()
    expect(h.fire(settled)).toBeUndefined()
    await flush()
    expect(h.manager.getSessionName()).toBe('🏷️ Auto titles')
    expect(h.setTitle).toHaveBeenCalledWith('🏷️ Auto titles')
    expect(h.appendEntry).toHaveBeenCalledWith('auto-title', '🏷️ Auto titles')
    const [selected, context, options] = h.streamSimple.mock.calls[0]
    expect(selected).toBe(model)
    expect(context.systemPrompt).toContain('one emoji followed by 2–5 simple words')
    expect(context.tools).toBeUndefined()
    expect(options).toMatchObject({ maxTokens: 64, signal: expect.any(AbortSignal) })
    expect(options?.reasoning).toBeUndefined()
  })

  it('updates mid-session and avoids writing unchanged names', async () => {
    const h = harness()
    h.exchange()
    h.fire(settled)
    await flush()
    h.result.mockResolvedValue(reply('🔐 Fix login'))
    h.exchange('Now fix login')
    h.fire(settled)
    await flush()
    expect(h.manager.getSessionName()).toBe('🔐 Fix login')
    expect(h.streamSimple.mock.calls[1][1].messages[0].content).toContain('Current title: 🏷️ Auto titles')
    h.exchange('Thanks, keep testing the login')
    h.fire(settled)
    await flush()
    expect(h.setSessionName).toHaveBeenCalledTimes(2)
    expect(h.appendEntry).toHaveBeenCalledTimes(2)
    expect(h.setTitle).toHaveBeenLastCalledWith('🔐 Fix login')
  })

  it('restores ownership of generated names after reload', async () => {
    const first = harness()
    first.exchange()
    first.fire(settled)
    await flush()
    first.fire({ type: 'session_shutdown', reason: 'reload' })
    const resumed = harness(first.manager)
    expect(resumed.setTitle).toHaveBeenCalledWith('🏷️ Auto titles')
    resumed.result.mockResolvedValue(reply('🧪 Add tests'))
    resumed.exchange('Add regression tests next')
    resumed.fire(settled)
    await flush()
    expect(resumed.manager.getSessionName()).toBe('🧪 Add tests')
  })

  it('preserves manually named sessions without making a request', async () => {
    const h = harness()
    h.manager.appendSessionInfo('My chosen name')
    h.exchange()
    h.fire(settled)
    await flush()
    expect(h.streamSimple).not.toHaveBeenCalled()
    expect(h.manager.getSessionName()).toBe('My chosen name')
    expect(h.setTitle).not.toHaveBeenCalled()
  })

  it('does not overwrite a manual rename while generation is pending', async () => {
    const h = harness()
    const pending = deferredReply()
    h.result.mockReturnValue(pending.promise)
    h.exchange()
    h.fire(settled)
    await flush()
    h.manager.appendSessionInfo('Manual title')
    pending.resolve(reply('🏷️ Generated title'))
    await flush()
    expect(h.manager.getSessionName()).toBe('Manual title')
    expect(h.setSessionName).not.toHaveBeenCalled()
    expect(h.setTitle).not.toHaveBeenCalled()
  })

  it.each(['session_shutdown', 'agent_start'] as const)('cancels on %s and discards late results', async (type) => {
    const h = harness()
    const pending = deferredReply()
    h.result.mockReturnValue(pending.promise)
    h.exchange()
    h.fire(settled)
    await flush()
    h.fire(type === 'session_shutdown' ? { type, reason: 'new' } : { type })
    await flush()
    expect(h.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true)
    pending.resolve(reply('🏷️ Stale title'))
    await flush()
    expect(h.setSessionName).not.toHaveBeenCalled()
  })

  it('only includes bounded recent text, not tool results or hidden thinking', async () => {
    const h = harness()
    h.exchange('Old topic')
    h.exchange('x'.repeat(4000))
    h.exchange('New topic')
    h.manager.appendMessage({ ...reply('Answer'), content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Answer' }] })
    h.manager.appendMessage({ role: 'toolResult', toolCallId: 'id', toolName: 'read', content: [{ type: 'text', text: 'private tool result' }], isError: false, timestamp: 0 })
    h.fire(settled)
    await flush()
    const content = h.streamSimple.mock.calls[0][1].messages[0].content
    expect(content).toContain('New topic')
    expect(content).not.toContain('Old topic')
    expect(content).not.toContain('private')
    expect(content).not.toContain('x'.repeat(1201))
  })

  it.each([
    ['No emoji', '💬 No emoji'],
    ['"🧪 Test titles"', '🧪 Test titles'],
    ['\u001B[31m🧪 Test\u001B[0m\n titles\u0007', '🧪 Test titles'],
    ['👩‍💻 Fix code', '👩‍💻 Fix code'],
    ['🇬🇧 British English', '🇬🇧 British English'],
    ['x'.repeat(80), `💬 ${'x'.repeat(38)}`],
  ])('sanitizes and bounds title %j', async (input, expected) => {
    const h = harness()
    h.result.mockResolvedValue(reply(input))
    h.exchange()
    h.fire(settled)
    await flush()
    expect(h.manager.getSessionName()).toBe(expected)
  })

  it.each(['empty', 'error', 'reject'] as const)('leaves the title alone for %s responses', async (kind) => {
    const h = harness()
    if (kind === 'reject')
      h.result.mockRejectedValue(new Error('offline'))
    else
      h.result.mockResolvedValue({ ...reply(kind === 'empty' ? '  ' : 'partial'), stopReason: kind === 'error' ? 'error' : 'stop' })
    h.exchange()
    h.fire(settled)
    await flush()
    expect(h.setSessionName).not.toHaveBeenCalled()
  })

  it('aborts a request after 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = harness()
    h.result.mockReturnValue(new Promise(() => {}))
    h.exchange()
    h.fire(settled)
    await flush()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(h.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true)
    expect(h.setSessionName).not.toHaveBeenCalled()
  })

  it.each(['aborted', 'failed', 'headless'] as const)('skips %s runs', async (kind) => {
    const h = harness()
    h.exchange()
    if (kind === 'failed')
      h.manager.appendMessage({ ...reply('Failure'), stopReason: 'error' })
    if (kind === 'headless')
      Object.assign(h.ctx, { hasUI: false })
    h.fire({ ...settled, aborted: kind === 'aborted' })
    await flush()
    expect(h.streamSimple).not.toHaveBeenCalled()
  })
})
