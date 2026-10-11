import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSession, requestApproval } from './session.ts'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  setRequestHandler: vi.fn(),
  transport: vi.fn(),
  stderr: vi.fn(),
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect
    close = mocks.close
    listTools = mocks.listTools
    callTool = mocks.callTool
    setRequestHandler = mocks.setRequestHandler
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: '/bin' }),
  StdioClientTransport: class {
    stderr = { on: mocks.stderr }
    constructor(config: unknown) { mocks.transport(config) }
  },
}))
vi.mock('./runtime.ts', () => ({
  runtimeDirectory: '/pinned',
  loadRuntime: async () => ({ command: '/pinned/node', args: ['/pinned/repl'], env: { CUA_REPL_ENABLED_SURFACES: 'browser' } }),
}))

function context(hasUI = true, answer: string | undefined = 'Allow') {
  const select = vi.fn().mockResolvedValue(answer)
  const ctx = { hasUI, ui: { select } }
  return { ctx, select }
}
const approval = {
  mode: 'form',
  message: 'Access example.com?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: {
    codex_request_type: 'approval_request',
    codex_approval_kind: 'mcp_tool_call',
    tool_name: 'access_browser_origin',
    origin: 'https://example.com',
    persist: 'always',
    codex_sensitive_action: true,
    tool_params: { origin: 'https://example.com' },
  },
} satisfies ElicitRequest['params']

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue(undefined)
  mocks.listTools.mockResolvedValue({ tools: ['js', 'js_reset', 'turn_ended'].map(name => ({ name })) })
  mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
})

describe('browser permissions', () => {
  it.each(['Allow', 'Deny', undefined])('forwards an explicit %s decision', async (answer) => {
    const { ctx, select } = context(true, answer)
    select.mockResolvedValue(answer)
    const result = await requestApproval(approval, ctx, new AbortController().signal)
    expect(result.action).toBe(answer === 'Allow' ? 'accept' : answer === 'Deny' ? 'decline' : 'cancel')
    expect(select).toHaveBeenCalledWith(expect.stringContaining('https://example.com'), ['Deny', 'Allow'], expect.objectContaining({ timeout: 120000 }))
    expect(select.mock.calls[0][0]).toContain('always')
    expect(select.mock.calls[0][0]).toContain('sensitive')
  })

  it('cancels without UI, after abort, and for unfamiliar request forms', async () => {
    const { ctx, select } = context()
    const signal = new AbortController().signal
    expect((await requestApproval(approval, context(false).ctx, signal)).action).toBe('cancel')
    expect((await requestApproval(approval, ctx, AbortSignal.abort())).action).toBe('cancel')
    expect((await requestApproval({ ...approval, _meta: {} }, ctx, signal)).action).toBe('cancel')
    expect((await requestApproval({ ...approval, requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } }, ctx, signal)).action).toBe('cancel')
    expect((await requestApproval({ ...approval, requestedSchema: { ...approval.requestedSchema, required: ['missing'] } }, ctx, signal)).action).toBe('cancel')
    expect((await requestApproval({ mode: 'url', message: 'Login', url: 'https://example.com', elicitationId: 'test' }, ctx, signal)).action).toBe('cancel')
    expect(select).not.toHaveBeenCalled()
  })

  it('does not accept if cancellation happens while the dialog is open', async () => {
    const controller = new AbortController()
    const { ctx, select } = context()
    select.mockImplementation(async () => {
      controller.abort()
      return 'Allow'
    })
    expect((await requestApproval(approval, ctx, controller.signal)).action).toBe('cancel')
  })
})

describe('pinned browser session', () => {
  it('is lazy, uses browser-only launch config, and drains stderr', async () => {
    const session = new BrowserSession()
    expect(mocks.connect).not.toHaveBeenCalled()
    await session.execute('code', 'test', 1000, context().ctx)
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ command: '/pinned/node', env: { PATH: '/bin', CUA_REPL_ENABLED_SURFACES: 'browser' } }))
    expect(mocks.stderr).toHaveBeenCalledWith('data', expect.any(Function))
    await session.close()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('keeps one turn ID across calls, changes it after settlement, and isolates sessions', async () => {
    const session = new BrowserSession()
    const ctx = context().ctx
    await session.execute('one', 'test', 1000, ctx)
    await session.execute('two', 'test', 1000, ctx)
    const first = mocks.callTool.mock.calls[0][0]._meta['x-codex-turn-metadata']
    expect(mocks.callTool.mock.calls[1][0]._meta['x-codex-turn-metadata']).toEqual(first)
    await session.finishTurn()
    await session.finishTurn()
    expect(mocks.callTool).toHaveBeenCalledTimes(3)
    expect(mocks.callTool.mock.calls[2][0]).toEqual({ name: 'turn_ended', arguments: { hook_event_name: 'Stop', ...first } })
    await session.execute('three', 'test', 1000, ctx)
    const next = mocks.callTool.mock.calls[3][0]._meta['x-codex-turn-metadata']
    expect(next.session_id).toBe(first.session_id)
    expect(next.turn_id).not.toBe(first.turn_id)
    await new BrowserSession().execute('other', 'test', 1000, ctx)
    expect(mocks.callTool.mock.calls[4][0]._meta['x-codex-turn-metadata'].session_id).not.toBe(first.session_id)
  })

  it('serializes calls sharing the JavaScript REPL', async () => {
    let resolveFirst!: (value: { content: { type: string, text: string }[] }) => void
    mocks.callTool.mockReturnValueOnce(new Promise((resolve) => {
      resolveFirst = resolve
    }))
    const session = new BrowserSession()
    const a = session.execute('one', 'test', 1000, context().ctx)
    const b = session.execute('two', 'test', 1000, context().ctx)
    await vi.waitFor(() => expect(mocks.callTool).toHaveBeenCalledOnce())
    resolveFirst({ content: [{ type: 'text', text: 'one' }] })
    await Promise.all([a, b])
    expect(mocks.callTool).toHaveBeenCalledTimes(2)
  })

  it('keeps errors, images and documentation in the result', async () => {
    const result = { isError: true, content: [{ type: 'text', text: 'Permission denied' }, { type: 'image', data: 'cG5n', mimeType: 'image/png' }] }
    mocks.callTool.mockResolvedValue(result)
    expect(await new BrowserSession().execute('code', 'test', 1000, context().ctx)).toEqual(result)
  })

  it('cancels unused/headless elicitation and forwards active interactive approval', async () => {
    const session = new BrowserSession()
    const { ctx, select } = context()
    mocks.callTool.mockImplementation(async () => {
      const handler = mocks.setRequestHandler.mock.calls[0][1]
      const reply = await handler({ params: approval }, { signal: new AbortController().signal })
      expect(reply.action).toBe('accept')
      return { content: [] }
    })
    await session.execute('code', 'test', 1000, ctx)
    expect(select).toHaveBeenCalledOnce()
    const idle = await mocks.setRequestHandler.mock.calls[0][1]({ params: approval }, { signal: new AbortController().signal })
    expect(idle.action).toBe('cancel')
  })

  it('sends Interrupt on aborted settlement and close remains idempotent', async () => {
    const session = new BrowserSession()
    await session.execute('code', 'test', 1000, context().ctx)
    await session.finishTurn(true)
    expect(mocks.callTool.mock.calls[1][0].arguments.hook_event_name).toBe('Interrupt')
    await session.close()
    await session.close()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('blocks further execution after cleanup failure but still closes the process', async () => {
    const session = new BrowserSession()
    await session.execute('code', 'test', 1000, context().ctx)
    mocks.callTool.mockRejectedValue(new Error('cleanup failed'))
    await expect(session.finishTurn()).rejects.toThrow('cleanup failed')
    await expect(session.execute('code', 'test', 1000, context().ctx)).rejects.toThrow('cleanup failed')
    await expect(session.close()).rejects.toThrow('cleanup failed')
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('fails closed on a missing tool or failed connection and releases the client', async () => {
    mocks.listTools.mockResolvedValue({ tools: [] })
    await expect(new BrowserSession().execute('code', 'test', 1000, context().ctx)).rejects.toThrow('missing the js tool')
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.callTool).not.toHaveBeenCalled()
  })

  it('does not start a tool that was already cancelled', async () => {
    await expect(new BrowserSession().execute('code', 'test', 1000, context().ctx, AbortSignal.abort())).rejects.toThrow()
    expect(mocks.callTool).not.toHaveBeenCalled()
  })
})
