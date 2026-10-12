import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import process from 'node:process'
import { Text } from '@earendil-works/pi-tui'
import { openPanel } from '../../../cmux/open-panel.ts'
import { panelFiles, readPanelLease, writePanelFile } from './state.ts'

type View = Component & { dispose?: () => void }
type WidgetContent = string[] | ((tui: TUI, theme: Theme) => View) | undefined

/** Install before the todo, lens, and footer extensions register their components. */
export function routePanel(ctx: {
  ui: Pick<ExtensionUIContext, 'setWidget' | 'setFooter' | 'notify'>
  cwd: string
  sessionManager: Pick<ExtensionContext['sessionManager'], 'getLeafId' | 'getSessionId'>
}, sessionFile: string, events?: Pick<ExtensionAPI['events'], 'on'>): () => void {
  const ui = ctx.ui
  const originalWidget = ui.setWidget
  const originalFooter = ui.setFooter
  const files = panelFiles(sessionFile)
  const views = new Map<string, View>()
  const renderers = new Set<TUI>()
  let hidden = false
  let stopped = false
  let warned = false
  const agents = new Map<string, { id: string, description: string, cwd: string, sessionId: string }>()

  const setHidden = (value: boolean): void => {
    if (hidden === value)
      return
    hidden = value
    for (const tui of renderers) tui.requestRender(true)
  }
  const wrap = (key: string, view: View, tui: TUI): View => {
    views.set(key, view)
    renderers.add(tui)
    return {
      render: width => hidden ? [] : view.render(width),
      invalidate: () => view.invalidate(),
      handleInput: view.handleInput?.bind(view),
      handleMouse: view.handleMouse?.bind(view),
      wantsKeyRelease: view.wantsKeyRelease,
      dispose: () => {
        if (views.get(key) === view)
          views.delete(key)
        view.dispose?.()
      },
    }
  }
  const setWidget = (key: string, content: WidgetContent, options?: Parameters<ExtensionUIContext['setWidget']>[2]): void => {
    if ((key === 'rpiv-todos' || key === 'pi-lens') && content !== undefined) {
      originalWidget.call(ui, key, (tui, theme) => wrap(key, Array.isArray(content) ? new Text(content.join('\n'), 1, 0) : content(tui, theme), tui), options)
    }
    else if (Array.isArray(content)) {
      originalWidget(key, content, options)
    }
    else {
      originalWidget(key, content, options)
    }
  }
  const setFooter: ExtensionUIContext['setFooter'] = (factory) => {
    originalFooter.call(ui, factory ? (tui, theme, data) => wrap('footer', factory(tui, theme, data), tui) : undefined)
  }
  // Pi 1.1.0 shares this UI object across extensions; no vendor files are patched.
  ui.setWidget = setWidget
  ui.setFooter = setFooter

  const capture = (key: string): string[] => views.get(key)?.render(4096) ?? []
  const tick = (): void => {
    if (stopped)
      return
    const lease = readPanelLease(files.lease)
    if (!lease) {
      setHidden(false)
      return
    }
    try {
      writePanelFile(files.state, {
        version: 1,
        producerPid: process.pid,
        updatedAt: Date.now(),
        leafId: ctx.sessionManager.getLeafId(),
        footer: capture('footer'),
        diagnostics: capture('pi-lens'),
        agents: [...agents.values()],
      })
      // Do not remove the main display until the reader acknowledges our output.
      setHidden(lease.producerPid === process.pid)
      warned = false
    }
    catch (cause) {
      setHidden(false)
      if (!warned)
        ui.notify(`Panel refresh failed. Main displays restored. ${cause instanceof Error ? cause.message : String(cause)}`, 'warning')
      warned = true
    }
  }
  const agentId = (data: unknown): data is { id: string, description: string } => {
    if (!data || typeof data !== 'object' || !('id' in data) || !('description' in data))
      return false
    return typeof data.id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{3}$/i.test(data.id) && typeof data.description === 'string'
  }
  const off = events
    ? [
        events.on('subagents:started', (data) => {
          if (agentId(data)) {
            agents.set(data.id, { id: data.id, description: data.description, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() })
            tick()
          }
        }),
        ...['subagents:completed', 'subagents:failed'].map(channel => events.on(channel, (data) => {
          if (agentId(data)) {
            agents.delete(data.id)
            tick()
          }
        })),
      ]
    : []
  const timer = setInterval(tick, 500)
  timer.unref()
  tick()
  return () => {
    if (stopped)
      return
    stopped = true
    clearInterval(timer)
    for (const unsubscribe of off) unsubscribe()
    setHidden(false)
    if (ui.setWidget === setWidget)
      ui.setWidget = originalWidget
    if (ui.setFooter === setFooter)
      ui.setFooter = originalFooter
  }
}

export default function (pi: ExtensionAPI): void {
  let stop: (() => void) | undefined
  pi.on('session_start', async (_event, ctx) => {
    stop?.()
    stop = undefined
    const file = ctx.sessionManager.getSessionFile()
    const workspace = process.env.CMUX_WORKSPACE_ID
    if (ctx.mode !== 'tui' || !workspace || !file)
      return
    stop = routePanel(ctx, file, pi.events)
    if (process.env.CMUX_SURFACE_ID) {
      try {
        await openPanel(workspace, process.env.CMUX_SURFACE_ID)
      }
      catch (error) {
        ctx.ui.notify(`Cannot open conversation panel: ${error instanceof Error ? error.message : String(error)}`, 'warning')
      }
    }
  })
  pi.on('session_shutdown', () => {
    stop?.()
    stop = undefined
  })
}
