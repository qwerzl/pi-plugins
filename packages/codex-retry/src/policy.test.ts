import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyFailure, retryDelay, streamFailure } from './policy.ts'

export const disconnect = 'stream error: stream disconnected before completion: stream closed before response.completed'

afterEach(() => vi.restoreAllMocks())

describe('codex 0.154.0 sampling policy', () => {
  it.each([
    disconnect,
    'Connection error.',
    'fetch failed',
    'ECONNRESET',
    'Request timed out',
    'WebSocket stream closed before response.completed',
    'Error while reading the server response: reset',
    '500 Internal Server Error',
    'HTTP 503 unavailable',
    'unexpected status 403 Forbidden',
    '404 Not Found',
  ])('bounds transient failure: %s', (message) => {
    expect(classifyFailure({ message })).toEqual({ connection: false })
  })

  it.each([
    '400 Bad Request',
    '429 Too Many Requests',
    'invalid_api_key',
    'insufficient_quota',
    'context_length_exceeded',
    'server_is_overloaded',
    'Selected model is at capacity. Please try a different model.',
    'usage_limit_reached',
    'usage_not_included',
    'cyber_policy',
    'misalignment_policy_violation',
    'Fatal error: socket closed',
    'Unknown error (no error details in response)',
  ])('does not retry terminal or unclassified failure: %s', (message) => {
    expect(classifyFailure({ message })).toBeUndefined()
  })

  it('uses unlimited recovery only for explicit HTTP connection failures', () => {
    expect(classifyFailure({ message: 'Connection failed: DNS unavailable' })).toEqual({ connection: true })
    expect(classifyFailure({ message: 'stream disconnected before completion: Connection failed: DNS' })).toEqual({ connection: false })
    expect(classifyFailure({ message: 'Connection failed: reset', status: 200 })).toEqual({ connection: false })
  })

  it('distinguishes HTTP 429 from in-stream rate limits and ignores HTTP retry-after advice', () => {
    const streamError = { code: 'rate_limit_exceeded', message: 'Try again in 1.25 seconds' }
    expect(classifyFailure({ message: 'rate limit exceeded', status: 429, streamError })).toBeUndefined()
    expect(classifyFailure({ message: 'rate limit exceeded', status: 200, streamError })).toEqual({ connection: false, delayMs: 1250 })
    expect(classifyFailure({ message: '503 Try again in 90 seconds' })).toEqual({ connection: false })
  })

  it.each([
    ['try again in 12.9 ms', 12],
    ['TRY AGAIN IN 0 s', 0],
    ['try again in 0.25s', 250],
    ['try again in 3600 seconds', 3_600_000],
  ])('honors stream rate-limit advice: %s', (message, delayMs) => {
    expect(classifyFailure({ message, streamError: { code: 'rate_limit_exceeded', message } })).toEqual({ connection: false, delayMs })
  })

  it('keeps unknown structured stream failures retryable but prioritizes terminal codes', () => {
    expect(classifyFailure({ message: 'opaque', streamError: { code: 'new_server_error' } })).toEqual({ connection: false })
    expect(classifyFailure({ message: 'stream disconnected', streamError: { code: 'insufficient_quota' } })).toBeUndefined()
  })

  it('uses Codex exponential backoff, jitter range, and integer truncation', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect([1, 2, 3, 4, 5].map(retryDelay)).toEqual([200, 400, 800, 1600, 3200])
    random.mockReturnValue(0)
    expect(retryDelay(1)).toBe(180)
    random.mockReturnValue(0.999)
    expect(retryDelay(1)).toBe(219)
  })

  it('reads error events defensively without changing provider data', () => {
    const error = { code: 'rate_limit_exceeded', message: 'try again in 1 s' }
    expect(streamFailure({ type: 'response.failed', response: { error } })).toEqual(error)
    expect(streamFailure({ type: 'error', error })).toEqual(error)
    expect(streamFailure({ type: 'response.incomplete', response: {} })).toEqual({})
    expect(streamFailure({ type: 'response.output_text.delta', delta: 'retry' })).toBeUndefined()
    expect(streamFailure(null)).toBeUndefined()
    expect(streamFailure('error')).toBeUndefined()
  })
})
