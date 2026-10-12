import { execFile } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

interface HookSession {
  sessionId: string
  surfaceId: string
  workspaceId: string
  pid: unknown
  updatedAt: number
  runtimeStatus: unknown
}

export interface PanelTarget {
  label: string
  sessionFile?: string
}

export interface ConversationTarget {
  workspaceId: string
  surfaceId: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hookSession(value: unknown): value is HookSession {
  return record(value) && typeof value.sessionId === 'string' && typeof value.surfaceId === 'string'
    && typeof value.workspaceId === 'string' && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function liveSession(row: HookSession, isAlive: (pid: number) => boolean): boolean {
  return typeof row.pid === 'number' && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.runtimeStatus === 'string' && ['running', 'idle', 'needsInput'].includes(row.runtimeStatus)
    && isAlive(row.pid)
}

/** An attached panel follows only its owner; legacy followers prefer the focused Pi terminal. */
export function selectSession(workspaceId: string, surfaces: unknown[], store: unknown, isAlive = alive, surfaceId?: string): string | undefined {
  if (!record(store) || !record(store.sessions))
    throw new Error('Cannot read cmux Pi session records')
  const terminals = surfaces.filter(record).filter(surface => surface.type === 'terminal' && !surface.dock_scope
    && (!surfaceId || surface.id === surfaceId))
  const rows = Object.values(store.sessions).filter(hookSession).filter(row => row.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt)
  const latest = new Map<string, HookSession>()
  for (const row of rows) {
    if (!latest.has(row.surfaceId))
      latest.set(row.surfaceId, row)
  }
  const candidates = terminals.flatMap((surface) => {
    const row = latest.get(String(surface.id))
    if (!row || !liveSession(row, isAlive))
      return []
    return [{ row, focused: surface.focused === true }]
  }).sort((a, b) => Number(b.focused) - Number(a.focused) || b.row.updatedAt - a.row.updatedAt)
  return candidates[0]?.row.sessionId
}

export function findSessionFile(sessionId: string): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const root = join(agentDir, 'sessions')
  const matches = globSync('*/*.jsonl', { cwd: root }).filter(file => basename(file).endsWith(`_${sessionId}.jsonl`))
  if (matches.length > 1)
    throw new Error('More than one saved file matches this Pi session')
  return matches[0] ? join(root, matches[0]) : undefined
}

export async function cmux(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { stdout } = await promisify(execFile)('cmux', ['rpc', method, JSON.stringify(params)], { timeout: 1500, maxBuffer: 1024 * 1024 })
  try {
    const value: unknown = JSON.parse(stdout)
    if (record(value))
      return value
  }
  catch {
    throw new Error('Invalid JSON from cmux')
  }
  throw new Error('Cannot read cmux workspace selection')
}

export async function activeSession(owner?: ConversationTarget): Promise<PanelTarget> {
  const list = await cmux('workspace.list')
  if (!Array.isArray(list.workspaces))
    throw new Error('Cannot read cmux workspaces')
  const workspace = list.workspaces.filter(record).find(row => owner ? row.id === owner.workspaceId : row.selected === true)
  if (!workspace || typeof workspace.id !== 'string')
    return { label: owner ? 'Conversation workspace closed' : 'No selected workspace' }
  const label = typeof workspace.title === 'string' ? workspace.title : 'Selected workspace'
  const result = await cmux('surface.list', { workspace_id: workspace.id })
  if (!Array.isArray(result.surfaces))
    throw new Error('Cannot read workspace terminals')
  let store: unknown
  try {
    store = JSON.parse(readFileSync(join(homedir(), '.cmuxterm', 'pi-hook-sessions.json'), 'utf8'))
  }
  catch (error) {
    if (record(error) && error.code === 'ENOENT')
      return { label }
    throw error
  }
  const sessionId = selectSession(workspace.id, result.surfaces, store, alive, owner?.surfaceId)
  if (!sessionId)
    return { label }
  const sessionFile = findSessionFile(sessionId)
  if (!sessionFile)
    return { label: `${label} · Pi has no saved session file yet` }
  return { label, sessionFile }
}
