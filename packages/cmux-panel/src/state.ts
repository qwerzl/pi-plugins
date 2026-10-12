import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

export interface PanelState {
  version: 1
  producerPid: number
  updatedAt: number
  leafId: string | null
  footer: string[]
  diagnostics: string[]
  agents?: { id: string, description: string, cwd: string, sessionId: string }[]
}

export interface PanelLease {
  readerPid: number
  producerPid: number | null
  updatedAt: number
}

export function panelFiles(sessionFile: string): { state: string, lease: string } {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  const key = createHash('sha256').update(resolve(sessionFile)).digest('hex')
  const path = join(agentDir, 'cache', 'cmux-panel', key)
  return { state: `${path}.json`, lease: `${path}.reader.json` }
}

const agentIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{3}$/i
const sessionIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function agentOutputFile(cwd: string, sessionId: string, agentId: string): string {
  if (!isAbsolute(cwd) || !agentIdPattern.test(agentId) || !sessionIdPattern.test(sessionId))
    throw new Error('Invalid subagent or parent session ID')
  const encoded = cwd.replaceAll(/[/\\]/g, '-').replace(/^[A-Z]:-/i, '').replace(/^-+/, '')
  return join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encoded, sessionId, 'tasks', `${agentId}.output`)
}

export function writePanelFile(path: string, value: PanelState | PanelLease): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, path)
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fresh(value: Record<string, unknown>): value is Record<string, unknown> & { updatedAt: number } {
  return typeof value.updatedAt === 'number' && Math.abs(Date.now() - value.updatedAt) < 4000
}

function pid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function readPanelLease(path: string): PanelLease | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (object(value) && fresh(value) && pid(value.readerPid)
      && (value.producerPid === null || pid(value.producerPid))) {
      return { readerPid: value.readerPid, producerPid: value.producerPid, updatedAt: value.updatedAt }
    }
  }
  catch {
    // No valid reader means the main panel must remain visible.
  }
}

export function readPanelState(path: string): PanelState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (object(value) && value.version === 1 && fresh(value) && pid(value.producerPid)
      && (value.leafId === null || typeof value.leafId === 'string')
      && Array.isArray(value.footer) && value.footer.every(line => typeof line === 'string')
      && Array.isArray(value.diagnostics) && value.diagnostics.every(line => typeof line === 'string')
      && (value.agents === undefined || (Array.isArray(value.agents) && value.agents.every(agent => object(agent)
        && typeof agent.id === 'string' && agentIdPattern.test(agent.id) && typeof agent.description === 'string'
        && typeof agent.cwd === 'string' && isAbsolute(agent.cwd)
        && typeof agent.sessionId === 'string' && sessionIdPattern.test(agent.sessionId))))) {
      return { version: 1, producerPid: value.producerPid, updatedAt: value.updatedAt, leafId: value.leafId, footer: value.footer, diagnostics: value.diagnostics, agents: value.agents }
    }
  }
  catch {
    // A missing, expired, or unreadable bridge is not an empty statistics report.
  }
}
