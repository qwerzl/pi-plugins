import type { PanelState } from '../packages/cmux-panel/src/state.ts'
import type { ConversationTarget, PanelTarget } from './active-session.ts'
import { readFileSync, rmSync, unwatchFile, watchFile } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { matchesKey, ProcessTerminal, ScrollView, sliceByColumn, stripTerminalSequences, Text, TuiAltScreen, visibleWidth, VStack } from '@earendil-works/pi-tui'
import { panelFiles, readPanelLease, readPanelState, writePanelFile } from '../packages/cmux-panel/src/state.ts'
import { activeSession } from './active-session.ts'
import { SubagentPanes } from './subagent-panes.ts'

interface Task {
  id: number
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  activeForm?: string
  blockedBy?: number[]
}

interface Snapshot {
  label: string
  tasks: Task[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTask(value: unknown): value is Task {
  return record(value)
    && Number.isSafeInteger(value.id) && Number(value.id) > 0
    && typeof value.subject === 'string'
    && ['pending', 'in_progress', 'completed', 'deleted'].includes(String(value.status))
    && (value.activeForm === undefined || typeof value.activeForm === 'string')
    && (value.blockedBy === undefined || (Array.isArray(value.blockedBy) && value.blockedBy.every(id => Number.isSafeInteger(id) && id > 0)))
}

function parseRecords(jsonl: string): Record<string, unknown>[] {
  const lines = jsonl.split('\n')
  return lines.flatMap((line, index) => {
    if (!line.trim())
      return []
    let entry: unknown
    try {
      entry = JSON.parse(line)
    }
    catch {
      // A writer may not have finished the final JSONL record yet.
      if (index === lines.length - 1)
        return []
      throw new Error(`Invalid session record on line ${index + 1}`)
    }
    if (!record(entry))
      throw new Error('Invalid session record')
    return [entry]
  })
}

function entryTasks(entry: Record<string, unknown>): Task[] | undefined {
  const message = entry.message
  if (entry.type !== 'message' || !record(message) || message.role !== 'toolResult' || message.toolName !== 'todo')
    return
  const details = message.details
  if (!record(details) || !Array.isArray(details.tasks) || typeof details.nextId !== 'number')
    return
  if (!details.tasks.every(isTask))
    throw new Error('Unsupported todo snapshot')
  return details.tasks
}

/** Match rpiv-todo's branch replay, not the last snapshot from a sibling branch. */
export function readSnapshot(jsonl: string, selectedLeaf?: string | null): Snapshot {
  const [header, ...rows] = parseRecords(jsonl)
  if (header?.type !== 'session' || ![2, 3].includes(Number(header.version)))
    throw new Error('Expected a Pi v2/v3 session; open older sessions in Pi to migrate them first')
  const label = `${typeof header.cwd === 'string' ? basename(header.cwd) : 'Session'} · ${String(header.id).slice(0, 8)}`
  const entries = new Map<string, Record<string, unknown>>()
  let leaf: string | null = null
  for (const entry of rows) {
    if (typeof entry.id !== 'string' || (entry.parentId !== null && typeof entry.parentId !== 'string'))
      throw new Error('Invalid session tree entry')
    entries.set(entry.id, entry)
    leaf = entry.id
  }
  if (selectedLeaf !== undefined)
    leaf = selectedLeaf
  const visited = new Set<string>()
  let tasks: Task[] | undefined
  while (leaf !== null) {
    if (visited.has(leaf))
      throw new Error('Cycle in session tree')
    visited.add(leaf)
    const entry = entries.get(leaf)
    if (!entry)
      throw new Error('Missing parent in session tree')
    tasks ??= entryTasks(entry)
    leaf = entry.parentId as string | null
  }
  return { label, tasks: tasks ?? [] }
}

function clean(text: string): string {
  return stripVTControlCharacters(text).replaceAll(/[\p{Cc}\p{Cf}]/gu, ' ')
}

function styledRows(line: string, separator: string): string[] {
  // eslint-disable-next-line no-control-regex -- Remove terminal strings whole, including embedded colors.
  const withoutCommands = line.replaceAll(/\u001B[\]PX^_][\s\S]*?(?:\u0007|\u001B\\|$)/g, '')
  // eslint-disable-next-line no-control-regex -- Preserve only numeric SGR style sequences.
  const text = withoutCommands.split(/(\u001B\[[\d;]*m)/g)
    .map((part, index) => index % 2 ? part : clean(part))
    .join('')
    .trim()
  let start = 0
  return stripTerminalSequences(text).split(separator).flatMap((chip) => {
    const width = visibleWidth(chip.trimEnd())
    const row = sliceByColumn(text, start, width)
    start += visibleWidth(chip) + visibleWidth(separator)
    // Keep inherited styling when a source color spans more than one chip.
    return chip.trim() ? [`${row}\u001B[0m`] : []
  })
}

const dim = (text: string): string => `\u001B[2m${text}\u001B[22m`
const bold = (text: string): string => `\u001B[1m${text}\u001B[22m`
const cyan = (text: string): string => `\u001B[36m${text}\u001B[39m`

function tree(title: string, rows: string[]): string {
  return [cyan(`● ${title}`), ...rows.map((row, index) => `${dim(index === rows.length - 1 ? '└─' : '├─')} ${row}`)].join('\n')
}

export function taskContent(tasks: Task[], showCompleted: boolean): string {
  const visible = tasks.filter(task => task.status !== 'deleted')
  const statuses = new Map(tasks.map(task => [task.id, task.status]))
  const completed = visible.filter(task => task.status === 'completed').length
  const marks = { completed: '✓', pending: '○', in_progress: '◐', deleted: '' }
  const rows = visible.filter(task => showCompleted || task.status !== 'completed').map((task) => {
    let text = `${marks[task.status]} #${task.id} ${clean(task.subject)}`
    if (task.status === 'completed')
      text = dim(`\u001B[9m${text}\u001B[29m`)
    if (task.status === 'in_progress') {
      text = cyan(text)
      if (task.activeForm)
        text += dim(` (${clean(task.activeForm)})`)
    }
    const blockers = (task.blockedBy ?? []).filter(id => !['completed', 'deleted'].includes(statuses.get(id) ?? ''))
    if (task.status === 'pending' && blockers.length)
      text += dim(` (Waiting for ${blockers.map(id => `#${id}`).join(', ')})`)
    return text
  })
  if (!rows.length)
    rows.push(completed ? 'All tasks complete' : 'No tasks yet')
  if (!showCompleted && completed)
    rows.push(dim(`${completed} completed · press c to show`))
  return tree(`Todos (${completed}/${visible.length})`, rows)
}

export function statusContent(state: PanelState | undefined): string {
  if (!state)
    return tree('Statistics', [dim('Waiting for Pi panel bridge. Use /reload after installation.')])
  const statistics = state.footer.flatMap(line => styledRows(line, ' · '))
  const diagnostics = state.diagnostics.flatMap(line => styledRows(line, '\n'))
  return [
    tree('Statistics', statistics.length ? statistics : ['No custom footer is registered']),
    ...(diagnostics.length ? [tree('Diagnostics', diagnostics)] : []),
  ].join('\n\n')
}

function runPanel(initialFile: string | undefined, follow: boolean | ConversationTarget): void {
  const owner = typeof follow === 'object' ? follow : undefined
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (!initialFile)
      throw new Error('Workspace following needs an interactive terminal')
    const snapshot = readSnapshot(readFileSync(initialFile, 'utf8'))
    process.stdout.write(`${clean(snapshot.label)}\n\n${stripTerminalSequences(taskContent(snapshot.tasks, true))}\n`)
    return
  }
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  const header = new Text('', 1, 0)
  const body = new Text('', 1, 1)
  const footer = new Text(dim('c completed · ↑↓ scroll · q close'), 1, 1)
  const scroll = new ScrollView(body, { primary: true, scrollbar: 'auto' })
  const agentPanes = new SubagentPanes(owner?.workspaceId ?? '', owner ? process.env.CMUX_SURFACE_ID ?? '' : '')
  tui.setLayoutRoot(new VStack([header, { component: scroll, grow: 1, basis: 0 }, footer]))
  let sessionFile: string | undefined
  let files: ReturnType<typeof panelFiles> | undefined
  let snapshot: Snapshot = { label: 'Selected workspace', tasks: [] }
  let state: PanelState | undefined
  let currentLeaf: string | null | undefined
  let showCompleted = false
  let error = ''
  let connectionError = ''
  let agentError = ''
  let refreshing = false
  let refreshDone: Promise<void> | undefined
  let stopped = false
  const render = (): void => {
    const failure = error || connectionError || agentError
    header.setText(`${dim(clean(snapshot.label))}${failure ? `\n${bold('Could not refresh panel')}\n${clean(failure)}` : ''}`)
    body.setText(sessionFile
      ? `${taskContent(snapshot.tasks, showCompleted)}\n\n${statusContent(state)}`
      : tree('Todos', [dim('No saved Pi session for this panel')]))
    tui.requestRender()
  }
  const refresh = (): void => {
    if (!sessionFile)
      return
    try {
      // shortcut: reread only on file changes; use incremental replay if large sessions make updates slow.
      snapshot = readSnapshot(readFileSync(sessionFile, 'utf8'), state?.leafId)
      currentLeaf = state?.leafId
      error = ''
    }
    catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    render()
  }
  const release = (): void => {
    if (sessionFile)
      unwatchFile(sessionFile, refresh)
    try {
      if (files && readPanelLease(files.lease)?.readerPid === process.pid)
        rmSync(files.lease, { force: true })
    }
    catch {
      // The heartbeat expires even if cleanup cannot remove its file.
    }
  }
  const select = (target: PanelTarget): void => {
    if (sessionFile === target.sessionFile) {
      if (!sessionFile)
        snapshot.label = target.label
      return
    }
    release()
    sessionFile = target.sessionFile
    files = sessionFile ? panelFiles(sessionFile) : undefined
    snapshot = { label: target.label, tasks: [] }
    state = undefined
    currentLeaf = undefined
    error = ''
    connectionError = ''
    showCompleted = false
    scroll.scrollToStart()
    if (sessionFile) {
      refresh()
      watchFile(sessionFile, { interval: 500 }, refresh)
    }
  }
  const syncAgents = async (): Promise<void> => {
    try {
      agentError = await agentPanes.sync(state?.agents ?? [])
    }
    catch (cause) {
      agentError = cause instanceof Error ? cause.message : String(cause)
    }
  }
  const refreshStatus = async (): Promise<void> => {
    if (refreshing || stopped)
      return
    refreshing = true
    try {
      if (follow) {
        const target = await activeSession(owner)
        if (stopped)
          return
        select(target)
      }
      if (files) {
        state = readPanelState(files.state)
        if (state?.leafId !== currentLeaf)
          refresh()
        writePanelFile(files.lease, { readerPid: process.pid, producerPid: error ? null : state?.producerPid ?? null, updatedAt: Date.now() })
      }
      connectionError = ''
    }
    catch (cause) {
      if (follow)
        select({ label: 'Workspace unavailable' })
      connectionError = cause instanceof Error ? cause.message : String(cause)
    }
    finally {
      await syncAgents()
      refreshing = false
      render()
    }
  }
  const scheduleRefresh = (): void => {
    if (!refreshing && !stopped)
      refreshDone = refreshStatus()
  }
  const statusTimer = setInterval(scheduleRefresh, 500)
  const stop = (): void => {
    if (stopped)
      return
    stopped = true
    clearInterval(statusTimer)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop)
    void (async () => {
      await refreshDone
      try {
        await agentPanes.sync([])
      }
      finally {
        release()
        tui.stop()
        process.exit(0)
      }
    })()
  }
  tui.addInputListener((data) => {
    if (matchesKey(data, 'q') || matchesKey(data, 'ctrl+c')) {
      stop()
    }
    else if (matchesKey(data, 'c')) {
      showCompleted = !showCompleted
      render()
    }
    else {
      return
    }
    return { consume: true }
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop)
  tui.start()
  terminal.setTitle('Plan')
  if (!follow)
    select({ sessionFile: initialFile, label: 'Pi session' })
  scheduleRefresh()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  let follow: boolean | ConversationTarget = mode === '--follow'
  if (mode === '--surface') {
    const workspaceId = process.env.CMUX_WORKSPACE_ID
    const surfaceId = process.argv[3]
    if (!workspaceId || !surfaceId)
      throw new Error('--surface needs a surface UUID and CMUX_WORKSPACE_ID')
    follow = { workspaceId, surfaceId }
  }
  const sessionFile = follow ? undefined : mode ?? process.env.PI_SESSION_FILE
  if (!sessionFile && !follow)
    throw new Error('Usage: node cmux/todo-panel.ts --surface UUID | --follow | /absolute/path/to/session.jsonl')
  runPanel(sessionFile ? resolve(sessionFile) : undefined, follow)
}
