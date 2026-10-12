import type { ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ProcessTerminal, TuiAltScreen } from '@earendil-works/pi-tui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPanel } from '../../../cmux/open-panel.ts'
import panelExtension, { routePanel } from './index.ts'
import { panelFiles, readPanelLease, readPanelState, writePanelFile } from './state.ts'

vi.mock('../../../cmux/open-panel.ts', () => ({ openPanel: vi.fn() }))

type View = Component & { dispose?: () => void }

function harness(): { ctx: Parameters<typeof routePanel>[0], widgets: Map<string, View>, footer: () => View | undefined, requestRender: ReturnType<typeof vi.fn>, placements: Map<string, unknown> } {
  const widgets = new Map<string, View>()
  const placements = new Map<string, unknown>()
  const tui = new TuiAltScreen(new ProcessTerminal())
  const requestRender = vi.spyOn(tui, 'requestRender').mockImplementation(() => {})
  const theme = {} as Theme
  let footer: View | undefined
  const ui: Parameters<typeof routePanel>[0]['ui'] = {
    setWidget: (key: string, content: string[] | ((tui: TUI, theme: Theme) => View) | undefined, options?: unknown) => {
      widgets.get(key)?.dispose?.()
      widgets.delete(key)
      placements.set(key, options)
      if (typeof content === 'function')
        widgets.set(key, content(tui, theme))
    },
    setFooter: (factory: Parameters<ExtensionUIContext['setFooter']>[0]) => {
      footer?.dispose?.()
      footer = factory?.(tui, theme, {
        getExtensionStatuses: () => new Map([['ponytail', 'FULL']]),
        getGitBranch: () => null,
        onBranchChange: () => () => {},
        getAvailableProviderCount: () => 1,
      })
    },
    notify: vi.fn(),
  }
  const ctx = { ui, cwd: '/projects/demo', sessionManager: { getLeafId: () => 'leaf', getSessionId: () => '12345678-1234-1234-1234-123456789abc' } }
  return { ctx, widgets, footer: () => footer, requestRender, placements }
}

let directory: string
let cleanup: (() => void) | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pi-cmux-panel-test-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', directory)
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function acknowledge(file: string): void {
  writePanelFile(panelFiles(file).lease, { readerPid: process.pid, producerPid: process.pid, updatedAt: Date.now() })
  vi.advanceTimersByTime(500)
}

describe('sidebar routing', () => {
  it('waits for reader acknowledgement, then moves only the requested displays', () => {
    const { ctx, widgets, footer, requestRender, placements } = harness()
    cleanup = routePanel(ctx, '/session.jsonl')
    const todo = { render: vi.fn(() => ['Todos']), invalidate: vi.fn(), dispose: vi.fn() }
    ctx.ui.setWidget('rpiv-todos', () => todo, { placement: 'aboveEditor' })
    ctx.ui.setWidget('pi-lens', () => ({ render: () => ['pi-lens 2W'], invalidate() {} }), { placement: 'belowEditor' })
    ctx.ui.setWidget('approval', () => ({ render: () => ['Permission required'], invalidate() {} }))
    ctx.ui.setFooter((_tui, _theme, data) => ({ render: () => [`model high · ponytail ${data.getExtensionStatuses().get('ponytail')}`], invalidate() {} }))
    const files = panelFiles('/session.jsonl')
    writePanelFile(files.lease, { readerPid: process.pid, producerPid: null, updatedAt: Date.now() })
    vi.advanceTimersByTime(500)
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual(['Todos'])
    expect(readPanelState(files.state)?.footer).toEqual(['model high · ponytail FULL'])
    acknowledge('/session.jsonl')
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual([])
    expect(widgets.get('pi-lens')?.render(40)).toEqual([])
    expect(footer()?.render(40)).toEqual([])
    expect(widgets.get('approval')?.render(40)).toEqual(['Permission required'])
    expect(readPanelState(files.state)?.diagnostics).toEqual(['pi-lens 2W'])
    expect(statSync(files.state).mode & 0o777).toBe(0o600)
    expect(placements.get('pi-lens')).toEqual({ placement: 'belowEditor' })
    expect(requestRender).toHaveBeenCalledWith(true)
    widgets.get('rpiv-todos')?.invalidate()
    expect(todo.invalidate).toHaveBeenCalledOnce()
    ctx.ui.setWidget('rpiv-todos', undefined)
    expect(todo.dispose).toHaveBeenCalledOnce()
  })

  it('preserves original footer and diagnostic styles in the published snapshot', () => {
    const { ctx } = harness()
    cleanup = routePanel(ctx, '/session.jsonl')
    const footer = '\u001B[38;2;90;180;220mmodel\u001B[39m · \u001B[32m42%\u001B[39m'
    const diagnostics = '\u001B[33mpi-lens 2W\u001B[39m'
    ctx.ui.setFooter(() => ({ render: () => [footer], invalidate() {} }))
    ctx.ui.setWidget('pi-lens', () => ({ render: () => [diagnostics], invalidate() {} }))
    acknowledge('/session.jsonl')
    expect(readPanelState(panelFiles('/session.jsonl').state)).toMatchObject({ footer: [footer], diagnostics: [diagnostics] })
  })

  it('publishes active top-level agents and removes them at completion or shutdown', () => {
    const { ctx } = harness()
    const listeners = new Map<string, (data: unknown) => void>()
    const events = { on: vi.fn((channel: string, listener: (data: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    }) }
    cleanup = routePanel(ctx, '/session.jsonl', events)
    acknowledge('/session.jsonl')
    const id = '67d0c849-8a7f-4fd'
    listeners.get('subagents:started')?.({ id, description: 'Find Pi sessions', type: 'Explore' })
    expect(readPanelState(panelFiles('/session.jsonl').state)?.agents).toEqual([{
      id,
      description: 'Find Pi sessions',
      cwd: '/projects/demo',
      sessionId: ctx.sessionManager.getSessionId(),
    }])
    listeners.get('subagents:started')?.({ id: '../../secret', description: 'Unsafe' })
    expect(readPanelState(panelFiles('/session.jsonl').state)?.agents).toHaveLength(1)
    listeners.get('subagents:completed')?.({ id, description: 'Find Pi sessions' })
    expect(readPanelState(panelFiles('/session.jsonl').state)?.agents).toEqual([])
    listeners.get('subagents:started')?.({ id, description: 'Find Pi sessions' })
    listeners.get('subagents:failed')?.({ id, description: 'Find Pi sessions' })
    expect(readPanelState(panelFiles('/session.jsonl').state)?.agents).toEqual([])
    cleanup()
    expect(listeners.size).toBe(0)
  })

  it('restores the main UI when the reader exits or its acknowledgement expires', () => {
    const { ctx, widgets } = harness()
    cleanup = routePanel(ctx, '/session.jsonl')
    ctx.ui.setWidget('rpiv-todos', () => ({ render: () => ['Todos'], invalidate() {} }))
    acknowledge('/session.jsonl')
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual([])
    vi.advanceTimersByTime(4000)
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual(['Todos'])
    acknowledge('/session.jsonl')
    rmSync(panelFiles('/session.jsonl').lease)
    vi.advanceTimersByTime(500)
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual(['Todos'])
  })

  it('keeps the main UI visible when a snapshot cannot be written', () => {
    const { ctx, widgets } = harness()
    cleanup = routePanel(ctx, '/session.jsonl')
    ctx.ui.setWidget('rpiv-todos', () => ({ render: () => ['Todos'], invalidate() {} }))
    mkdirSync(panelFiles('/session.jsonl').state, { recursive: true })
    acknowledge('/session.jsonl')
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual(['Todos'])
    expect(ctx.ui.notify).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    expect(ctx.ui.notify).toHaveBeenCalledOnce()
  })

  it('restores methods and rendering on shutdown without disposing host-owned components', () => {
    const { ctx, widgets } = harness()
    const originalWidget = ctx.ui.setWidget
    const originalFooter = ctx.ui.setFooter
    cleanup = routePanel(ctx, '/session.jsonl')
    const dispose = vi.fn()
    ctx.ui.setWidget('rpiv-todos', () => ({ render: () => ['Todos'], invalidate() {}, dispose }))
    acknowledge('/session.jsonl')
    cleanup()
    cleanup()
    expect(ctx.ui.setWidget).toBe(originalWidget)
    expect(ctx.ui.setFooter).toBe(originalFooter)
    expect(widgets.get('rpiv-todos')?.render(40)).toEqual(['Todos'])
    expect(dispose).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overwrite a newer UI wrapper during cleanup', () => {
    const { ctx } = harness()
    cleanup = routePanel(ctx, '/session.jsonl')
    const newer = vi.fn()
    ctx.ui.setFooter = newer
    cleanup()
    expect(ctx.ui.setFooter).toBe(newer)
  })
})

describe('automatic conversation panel', () => {
  function start() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>()
    panelExtension({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => { handlers.set(name, handler) },
      events: { on: () => () => {} },
    } as never)
    const { ctx } = harness()
    const session = { ...ctx, mode: 'tui', sessionManager: { ...ctx.sessionManager, getSessionFile: () => '/session.jsonl' } }
    return { handlers, session, ui: ctx.ui }
  }

  beforeEach(() => vi.mocked(openPanel).mockReset())

  it('opens automatically on an interactive cmux session, without taking over startup', async () => {
    vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace')
    vi.stubEnv('CMUX_SURFACE_ID', 'owner')
    vi.mocked(openPanel).mockResolvedValue({ surface_id: 'plan' })
    const { handlers, session } = start()
    await handlers.get('session_start')?.({}, session)
    expect(openPanel).toHaveBeenCalledWith('workspace', 'owner')
    handlers.get('session_shutdown')?.({}, session)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not open from a child or a session without its own cmux surface', async () => {
    vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace')
    vi.stubEnv('CMUX_SURFACE_ID', 'owner')
    const { handlers, session } = start()
    await handlers.get('session_start')?.({}, { ...session, mode: 'rpc' })
    await handlers.get('session_start')?.({}, { ...session, sessionManager: { ...session.sessionManager, getSessionFile: () => undefined } })
    vi.stubEnv('CMUX_SURFACE_ID', '')
    await handlers.get('session_start')?.({}, session)
    expect(openPanel).not.toHaveBeenCalled()
    handlers.get('session_shutdown')?.({}, session)
  })
})

describe('sidebar files', () => {
  it('isolates sessions and rejects stale or incompatible state', () => {
    expect(panelFiles('/a.jsonl')).not.toEqual(panelFiles('/b.jsonl'))
    const files = panelFiles('/a.jsonl')
    expect(readPanelState(files.state)).toBeUndefined()
    writePanelFile(files.state, { version: 1, producerPid: process.pid, updatedAt: Date.now(), leafId: null, footer: [], diagnostics: [] })
    expect(readPanelState(files.state)?.leafId).toBeNull()
    writePanelFile(files.state, {
      version: 1,
      producerPid: process.pid,
      updatedAt: Date.now(),
      leafId: null,
      footer: [],
      diagnostics: [],
      agents: [{ id: '../../other', description: 'Injected', cwd: '/tmp', sessionId: '12345678-1234-1234-1234-123456789abc' }],
    })
    expect(readPanelState(files.state)).toBeUndefined()
    vi.advanceTimersByTime(4000)
    expect(readPanelState(files.state)).toBeUndefined()
    writePanelFile(files.lease, { readerPid: -1, producerPid: null, updatedAt: Date.now() })
    expect(readPanelLease(files.lease)).toBeUndefined()
  })
})
