import type { AssistantMessage, AssistantMessageEvent, ThinkingContent } from '@earendil-works/pi-ai'
import type { FoldContext, FoldModel, FoldOutput } from './types.ts'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { fold, truncationTier } from './fold.ts'

const model: FoldModel = { api: 'openai-responses', provider: 'cpa', id: 'test-model' }

function message(reasoning: number, text = 'answer', signature: string | undefined = '{"type":"reasoning","id":"rs_test","encrypted_content":"opaque"}'): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      { type: 'thinking', thinking: 'summary', thinkingSignature: signature },
      { type: 'text', text },
    ],
    usage: {
      input: 100,
      output: reasoning + 10,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning,
      totalTokens: 115 + reasoning,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
}

async function* round(result: AssistantMessage): AsyncGenerator<AssistantMessageEvent> {
  const partial = { ...result, content: [] as AssistantMessage['content'] }
  yield { type: 'start', partial }
  for (const block of result.content) {
    const contentIndex = partial.content.length
    if (block.type === 'thinking') {
      const thinking: ThinkingContent = { ...block, thinking: '' }
      partial.content.push(thinking)
      yield { type: 'thinking_start', contentIndex, partial }
      thinking.thinking = block.thinking
      yield { type: 'thinking_delta', contentIndex, delta: block.thinking, partial }
      yield { type: 'thinking_end', contentIndex, content: block.thinking, partial }
    }
    else {
      partial.content.push(block)
      if (block.type === 'text')
        yield { type: 'text_delta', contentIndex, delta: block.text, partial }
      else
        yield { type: 'toolcall_end', contentIndex, toolCall: block, partial }
    }
  }
  if (result.stopReason === 'error' || result.stopReason === 'aborted')
    yield { type: 'error', reason: result.stopReason, error: result }
  else
    yield { type: 'done', reason: result.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: result }
}

function collector(): FoldOutput & { events: AssistantMessageEvent[] } {
  const events: AssistantMessageEvent[] = []
  return {
    events,
    // Snapshot mutable partials at emission time, not after the stream has finished.
    push: event => events.push(structuredClone(event)),
    end: vi.fn(),
  }
}

function lastMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const terminal = events.at(-1)
  if (terminal?.type === 'done')
    return terminal.message
  if (terminal?.type === 'error')
    return terminal.error
  throw new Error('Expected terminal event')
}

describe('truncation fingerprint', () => {
  it.each([[516, 1], [1034, 2], [3106, 6], [517, 0], [0, 0], [-2, 0], [3624, 0], [Number.NaN, 0]])('maps %s to tier %s', (tokens, tier) => {
    expect(truncationTier(tokens)).toBe(tier)
  })
})

describe('fold', () => {
  it.each(['answer 🌍', ''])('emits a normal answer with valid text start state: %s', async (text) => {
    const out = collector()
    const inner = vi.fn(() => round(message(100, text)))
    await Effect.runPromise(fold(inner, model, { messages: [] }, out))
    expect(inner).toHaveBeenCalledTimes(1)
    expect(lastMessage(out.events).content.at(-1)).toEqual({ type: 'text', text })
    const start = out.events.find(event => event.type === 'text_start')
    expect(start?.partial.content[start.contentIndex]).toEqual({ type: 'text', text: '' })
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it('discards tentative text and tool calls, replays reasoning, and totals billing', async () => {
    const first = message(516, 'discard me')
    first.content.push({ type: 'toolCall', id: 'draft', name: 'delete_file', arguments: {} })
    const second = message(100, 'final')
    second.usage.input = 200
    const results = [first, second]
    const seen: FoldContext[] = []
    const context: FoldContext = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }
    const original = structuredClone(context)
    const out = collector()
    await Effect.runPromise(fold((ctx) => {
      seen.push(ctx)
      return round(results[seen.length - 1])
    }, model, context, out))

    expect(seen).toHaveLength(2)
    expect(context).toEqual(original)
    const replay = seen[1].messages.at(-1)
    expect(replay?.role).toBe('assistant')
    if (replay?.role !== 'assistant')
      throw new Error('Missing continuation')
    expect(replay.content[0]).toEqual(first.content[0])
    const marker = replay.content[1]
    expect(marker.type).toBe('text')
    if (marker.type !== 'text')
      throw new Error('Missing commentary marker')
    expect(marker.text).toBe('Continue thinking...')
    expect(JSON.parse(marker.textSignature ?? '{}')).toMatchObject({ phase: 'commentary' })
    const final = lastMessage(out.events)
    expect(final.content.map(block => block.type)).toEqual(['thinking', 'thinking', 'text'])
    expect(final.content.at(-1)).toEqual({ type: 'text', text: 'final' })
    expect(final.usage).toMatchObject({ input: 200, output: 636, reasoning: 616, totalTokens: 841, cost: { total: 4 } })
    expect(out.events.filter(event => event.type === 'start')).toHaveLength(1)
    expect(out.events.filter(event => event.type === 'done')).toHaveLength(1)
    expect(out.events.filter(event => event.type === 'toolcall_end')).toHaveLength(0)
    expect(out.events.filter(event => event.type === 'text_delta').map(event => event.delta)).toEqual(['final'])
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it('caps continuation at four total rounds', async () => {
    const out = collector()
    const inner = vi.fn(() => round(message(516)))
    await Effect.runPromise(fold(inner, model, { messages: [] }, out))
    expect(inner).toHaveBeenCalledTimes(4)
    expect(lastMessage(out.events).content.at(-1)).toEqual({ type: 'text', text: 'answer' })
    expect(lastMessage(out.events).usage.cost.total).toBe(8)
  })

  it.each(['{}', 'null', 'malformed', '{"encrypted_content":false}', '{"encrypted_content":""}'])('does not continue without usable encrypted reasoning: %s', async (signature) => {
    const out = collector()
    const inner = vi.fn(() => round(message(516, 'only', signature)))
    await Effect.runPromise(fold(inner, model, { messages: [] }, out))
    expect(inner).toHaveBeenCalledTimes(1)
    expect(lastMessage(out.events).stopReason).toBe('stop')
  })

  it('preserves the final tool call, namespace, arguments and stop reason', async () => {
    const result = message(100)
    const toolCall = { type: 'toolCall', id: 'call_1', name: 'read', namespace: 'files', arguments: { path: '/tmp/🌍' } } as const
    result.content = [result.content[0], toolCall]
    result.stopReason = 'toolUse'
    const out = collector()
    await Effect.runPromise(fold(() => round(result), model, { messages: [] }, out))
    expect(lastMessage(out.events).stopReason).toBe('toolUse')
    expect(lastMessage(out.events).content.at(-1)).toEqual(toolCall)
    expect(out.events.filter(event => event.type === 'toolcall_end')).toHaveLength(1)
  })

  it.each(['error', 'aborted'] as const)('does not continue or release tool calls on %s', async (stopReason) => {
    const result = message(516)
    result.stopReason = stopReason
    result.errorMessage = 'upstream failure'
    result.content.push({ type: 'toolCall', id: 'failed', name: 'write', arguments: {} })
    const inner = vi.fn(() => round(result))
    const out = collector()
    await Effect.runPromise(fold(inner, model, { messages: [] }, out))
    expect(inner).toHaveBeenCalledTimes(1)
    expect(lastMessage(out.events)).toMatchObject({ stopReason, errorMessage: 'upstream failure' })
    expect(out.events.some(event => event.type === 'toolcall_end')).toBe(false)
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it('closes with an error if the provider never emits a terminal event', async () => {
    const out = collector()
    await Effect.runPromise(fold(() => (async function* () {
      yield { type: 'start', partial: message(0) } as const
    })(), model, { messages: [] }, out))
    expect(lastMessage(out.events)).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('without a terminal event') })
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it.each([new Error('network failure'), 'network failure'])('keeps billed usage and closes if the continuation rejects with %s', async (error) => {
    const out = collector()
    const inner = vi.fn()
      .mockImplementationOnce(() => round(message(516)))
      .mockImplementationOnce(() => (async function* () { yield await Promise.reject(error) })())
    await Effect.runPromise(fold(inner, model, { messages: [] }, out))
    expect(lastMessage(out.events)).toMatchObject({ stopReason: 'error', errorMessage: 'network failure', usage: { cost: { total: 2 } } })
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it('does not start a request when already cancelled', async () => {
    const out = collector()
    const inner = vi.fn(() => round(message(516)))
    await Effect.runPromise(fold(inner, model, { messages: [] }, out, AbortSignal.abort()))
    expect(inner).not.toHaveBeenCalled()
    expect(lastMessage(out.events).stopReason).toBe('aborted')
    expect(out.end).toHaveBeenCalledTimes(1)
  })

  it('forwards cancellation to the active provider request', async () => {
    const controller = new AbortController()
    const out = collector()
    await Effect.runPromise(fold((_ctx, signal) => (async function* () {
      yield { type: 'start', partial: message(0) } as const
      controller.abort()
      signal.throwIfAborted()
    })(), model, { messages: [] }, out, controller.signal))
    expect(lastMessage(out.events).stopReason).toBe('aborted')
    expect(out.end).toHaveBeenCalledTimes(1)
  })
})
