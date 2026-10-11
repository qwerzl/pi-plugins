import type { Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'
import { normalizeContext } from '@earendil-works/pi-ai/compat'
import { afterEach, describe, expect, it, vi } from 'vitest'
import extension from './index.ts'

const model: Model<'openai-responses'> = {
  id: 'test-model',
  name: 'Test',
  provider: 'cpa',
  api: 'openai-responses',
  baseUrl: 'https://example.invalid/v1',
  reasoning: true,
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function registrations(): Map<string, ProviderConfig> {
  const providers = new Map<string, ProviderConfig>()
  extension({
    registerProvider: (id: string, config: ProviderConfig) => { providers.set(id, config) },
  } as ExtensionAPI)
  return providers
}

function response(id: string, tokens: number, text: string): Response {
  const reasoning = { type: 'reasoning', id: `rs_${id}`, summary: [{ type: 'summary_text', text: 'Thinking' }], encrypted_content: 'opaque' }
  const message = { type: 'message', id: `msg_${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Thinking' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 1, item: message },
    {
      type: 'response.completed',
      response: {
        id,
        status: 'completed',
        output: [reasoning, message],
        usage: { input_tokens: 100, output_tokens: tokens + 10, total_tokens: 110 + tokens, output_tokens_details: { reasoning_tokens: tokens } },
      },
    },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

afterEach(() => vi.unstubAllEnvs())

describe('pi provider extension', () => {
  it('defaults to cpa and does not replace models, credentials or endpoint', () => {
    vi.stubEnv('CODEXCONT_PROVIDERS', undefined)
    expect([...registrations()]).toEqual([['cpa', { api: 'openai-responses', streamSimple: expect.any(Function) }]])
  })

  it('trims and deduplicates configured provider IDs', () => {
    vi.stubEnv('CODEXCONT_PROVIDERS', ' custom, cpa,custom, ,')
    expect([...registrations().keys()]).toEqual(['custom', 'cpa'])
  })

  it('folds real pi Responses parsing using mocked HTTP and preserves instrumentation', async () => {
    vi.stubEnv('CODEXCONT_PROVIDERS', 'cpa')
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response('first', 516, 'discarded'))
      .mockResolvedValueOnce(response('second', 100, 'final'))
    const onPayload = vi.fn<NonNullable<SimpleStreamOptions['onPayload']>>()
    const onResponse = vi.fn()
    const onProviderStreamEvent = vi.fn()
    const stream = registrations().get('cpa')?.streamSimple
    expect(stream).toBeDefined()
    if (!stream)
      throw new Error('Missing stream registration')
    const result = await stream(model, normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }), {
      apiKey: 'test-only',
      reasoning: 'low',
      fetch,
      onPayload,
      onResponse,
      onProviderStreamEvent,
    }).result()
    expect(result.stopReason).toBe('stop')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onPayload).toHaveBeenCalledTimes(2)
    expect(onResponse).toHaveBeenCalledTimes(2)
    expect(onProviderStreamEvent).toHaveBeenCalledTimes(14)
    expect(result.content.filter(block => block.type === 'text')).toEqual([expect.objectContaining({ text: 'final' })])
    expect(onPayload.mock.calls[1][0]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', id: 'rs_first', encrypted_content: 'opaque' }),
        expect.objectContaining({ type: 'message', phase: 'commentary', content: [expect.objectContaining({ text: 'Continue thinking...' })] }),
      ]),
    })
  })

  it('bypasses continuation when thinking is disabled', async () => {
    vi.stubEnv('CODEXCONT_PROVIDERS', 'cpa')
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('only', 516, 'direct'))
    const stream = registrations().get('cpa')?.streamSimple
    if (!stream)
      throw new Error('Missing stream registration')
    const result = await stream(model, normalizeContext({ messages: [] }), { apiKey: 'test-only', fetch }).result()
    expect(result.stopReason).toBe('stop')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.content.at(-1)).toMatchObject({ text: 'direct' })
  })
})
