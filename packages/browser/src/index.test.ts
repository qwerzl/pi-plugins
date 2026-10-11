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
  await h.fire(event)
  expect(mocks.close).toHaveBeenCalledOnce()
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
