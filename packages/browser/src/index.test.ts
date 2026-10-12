import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { beforeEach, expect, it, vi } from 'vitest'
import browser from './index.ts'

const mocks = vi.hoisted(() => ({
  created: vi.fn(),
  execute: vi.fn(),
  close: vi.fn(),
  finishTurn: vi.fn(),
}))
vi.mock('./session.ts', () => ({
  BrowserSession: class {
    constructor() { mocks.created() }
    execute = mocks.execute
    close = mocks.close
    finishTurn = mocks.finishTurn
  },
}))

function harness() {
  const on = vi.fn()
  const registerTool = vi.fn()
  const api: Pick<ExtensionAPI, 'on' | 'registerTool' | 'exec'> = { on, registerTool, exec: vi.fn() }
  browser(api as ExtensionAPI)
  const ctx = { ui: { notify: vi.fn() } }
  const tools = new Map(registerTool.mock.calls.map(([tool]) => [tool.name, tool]))
  return {
    ctx,
    tools,
    run: (name = 'browser_js') => tools.get(name).execute('test', { code: 'code', title: 'test' }, undefined, undefined, ctx),
    fire: async (name: string, event = {}) => {
      for (const [type, handler] of on.mock.calls) {
        if (type === name)
          await handler(event, ctx)
      }
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.execute.mockResolvedValue({ content: [{ type: 'text', text: 'Runtime documentation' }] })
  mocks.close.mockResolvedValue(undefined)
  mocks.finishTurn.mockResolvedValue(undefined)
})

it('registers browser tools without spawning a runtime, and waits until final settlement for cleanup', async () => {
  const h = harness()
  expect([...h.tools.keys()]).toEqual(['browser_js', 'browser_reset', 'cmux_browser'])
  expect(mocks.created).not.toHaveBeenCalled()
  await h.run()
  expect(mocks.created).toHaveBeenCalledOnce()
  await h.fire('agent_end')
  expect(mocks.finishTurn).not.toHaveBeenCalled()
  await h.fire('agent_settled', { aborted: true })
  expect(mocks.finishTurn).toHaveBeenCalledWith(true)
})

it.each(['session_shutdown', 'session_start', 'session_tree'])('closes state on %s and creates fresh state afterward', async (event) => {
  const h = harness()
  await h.run()
  mocks.close.mockResolvedValueOnce('Turn cleanup failed; some browser tabs may still be open.')
  await h.fire(event)
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('tabs may still be open'), 'warning')
  await h.run()
  expect(mocks.created).toHaveBeenCalledTimes(2)
})

it.each(['session_shutdown', 'session_start', 'session_tree'])('reports process shutdown failures during %s and allows an explicit retry', async (event) => {
  const h = harness()
  await h.run()
  mocks.close.mockRejectedValueOnce(new Error('transport shutdown failed'))
  await h.fire(event)
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('Browser shutdown failed; use browser_reset'), 'error')
  await h.run('browser_reset')
  expect(mocks.close).toHaveBeenCalledTimes(2)
  await h.run()
  expect(mocks.created).toHaveBeenCalledTimes(2)
})

it('reports a successful reset with a warning when only turn cleanup failed', async () => {
  const h = harness()
  await h.run()
  mocks.close.mockResolvedValueOnce('Turn cleanup failed; some browser tabs may still be open.')
  const result = await h.run('browser_reset')
  expect(result.content[0].text).toContain('Browser runtime stopped')
  expect(result.content[0].text).toContain('tabs may still be open')
  await h.run()
  expect(mocks.created).toHaveBeenCalledTimes(2)
})

it('waits for shutdown before creating another runtime and shares concurrent resets', async () => {
  const h = harness()
  await h.run()
  let release!: () => void
  mocks.close.mockReturnValueOnce(new Promise<void>((resolve) => {
    release = resolve
  }))
  const reset = h.run('browser_reset')
  const change = h.fire('session_start')
  const execution = h.run()
  try {
    await Promise.resolve()
    expect(mocks.created).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  }
  finally {
    release()
    await Promise.all([reset, change, execution])
  }
  expect(mocks.created).toHaveBeenCalledTimes(2)
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it('retains the session for a shutdown retry instead of abandoning its process', async () => {
  const h = harness()
  await h.run()
  mocks.close.mockRejectedValueOnce(new Error('transport shutdown failed'))
  await expect(h.run('browser_reset')).rejects.toThrow('transport shutdown failed')
  await h.run('browser_reset')
  expect(mocks.close).toHaveBeenCalledTimes(2)
  await h.run()
  expect(mocks.created).toHaveBeenCalledTimes(2)
})

it('preserves runtime error text and image content in Pi results', async () => {
  const h = harness()
  const content = [{ type: 'text', text: 'Permission denied' }, { type: 'image', mimeType: 'image/png', data: 'cG5n' }]
  mocks.execute.mockResolvedValue({ isError: true, content })
  expect(await h.run()).toEqual({ isError: true, content, details: undefined })
  expect(h.tools.get('browser_js').executionMode).toBe('sequential')
})

it('resets disconnected sessions explicitly and reports failed cleanup', async () => {
  const h = harness()
  await h.run()
  mocks.finishTurn.mockRejectedValueOnce(new Error('offline'))
  await h.fire('agent_settled', { aborted: false })
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'), 'error')
  await h.run('browser_reset')
  expect(mocks.close).toHaveBeenCalledOnce()
  await h.run()
  expect(mocks.created).toHaveBeenCalledTimes(2)
})
