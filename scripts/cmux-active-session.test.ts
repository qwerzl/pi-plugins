import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findSessionFile, selectSession } from '../cmux/active-session.ts'

const a = { sessionId: 'session-a', workspaceId: 'workspace-a', surfaceId: 'terminal-a', pid: 1, updatedAt: 1, runtimeStatus: 'idle' }
const b = { sessionId: 'session-b', workspaceId: 'workspace-b', surfaceId: 'terminal-b', pid: 2, updatedAt: 2, runtimeStatus: 'running' }
const surfaceA = { id: 'terminal-a', type: 'terminal', focused: true }
const surfaceB = { id: 'terminal-b', type: 'terminal', focused: true }
const alive = (): boolean => true

describe('cmux selected session', () => {
  it('switches between workspaces without using the previous conversation', () => {
    const store = { sessions: { a, b } }
    expect(selectSession('workspace-a', [surfaceA], store, alive)).toBe('session-a')
    expect(selectSession('workspace-b', [surfaceB], store, alive)).toBe('session-b')
    expect(selectSession('empty', [], store, alive)).toBeUndefined()
  })

  it('ignores the global Dock even when its terminal has focus', () => {
    const dock = { ...b, workspaceId: 'workspace-a', surfaceId: 'dock', updatedAt: 10 }
    expect(selectSession('workspace-a', [surfaceA, { id: 'dock', type: 'terminal', dock_scope: 'global', focused: true }], { sessions: { a, dock } }, alive)).toBe('session-a')
  })

  it('prefers the focused Pi terminal, otherwise the latest one in that workspace', () => {
    const second = { ...b, workspaceId: 'workspace-a' }
    const store = { sessions: { a, second } }
    expect(selectSession('workspace-a', [surfaceA, { ...surfaceB, focused: false }], store, alive)).toBe('session-a')
    expect(selectSession('workspace-a', [{ ...surfaceA, focused: false }, { ...surfaceB, focused: false }], store, alive)).toBe('session-b')
  })

  it('does not revive an old session after the newest one ends or loses its process', () => {
    const latest = { ...a, sessionId: 'latest', updatedAt: 3, runtimeStatus: 'ended' }
    expect(selectSession('workspace-a', [surfaceA], { sessions: { a, latest } }, alive)).toBeUndefined()
    expect(selectSession('workspace-a', [surfaceA], { sessions: { a, latest: { ...latest, runtimeStatus: 'idle', pid: null } } }, alive)).toBeUndefined()
    expect(selectSession('workspace-a', [surfaceA], { sessions: { a } }, () => false)).toBeUndefined()
  })

  it('follows a new session in the same terminal and ignores removed surfaces', () => {
    const latest = { ...a, sessionId: 'new-session', updatedAt: 3 }
    expect(selectSession('workspace-a', [surfaceA], { sessions: { a, latest } }, alive)).toBe('new-session')
    expect(selectSession('workspace-a', [], { sessions: { a, latest } }, alive)).toBeUndefined()
    expect(selectSession('workspace-a', [{ ...surfaceA, type: 'browser' }], { sessions: { a } }, alive)).toBeUndefined()
  })

  it('keeps an attached panel on its owner even when another Pi terminal is focused', () => {
    const second = { ...b, workspaceId: 'workspace-a' }
    const surfaces = [{ ...surfaceA, focused: false }, surfaceB]
    const store = { sessions: { a, second } }
    expect(selectSession('workspace-a', surfaces, store, alive, 'terminal-a')).toBe('session-a')
    expect(selectSession('workspace-a', surfaces, store, alive, 'missing')).toBeUndefined()
    expect(selectSession('workspace-a', [surfaceB], store, alive, 'terminal-a')).toBeUndefined()
    expect(selectSession('workspace-a', surfaces, { sessions: { a: { ...a, runtimeStatus: 'ended' }, second } }, alive, 'terminal-a')).toBeUndefined()
  })

  it('follows /new and /resume on the owner without falling back to another terminal', () => {
    const latest = { ...a, sessionId: 'new-session', updatedAt: 3 }
    const second = { ...b, workspaceId: 'workspace-a', updatedAt: 4 }
    expect(selectSession('workspace-a', [surfaceA, surfaceB], { sessions: { a, latest, second } }, alive, 'terminal-a')).toBe('new-session')
  })

  it('reports unreadable hook records instead of retaining another workspace', () => {
    expect(() => selectSession('workspace-a', [surfaceA], null)).toThrow('Cannot read cmux Pi session records')
    expect(selectSession('workspace-a', [surfaceA], { sessions: { corrupt: { pid: 0 } } }, alive)).toBeUndefined()
  })
})

let directory: string | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  if (directory)
    rmSync(directory, { recursive: true, force: true })
})

describe('pi session file lookup', () => {
  it('uses the exact session ID, waits for new files, and rejects ambiguous copies', () => {
    directory = mkdtempSync(join(tmpdir(), 'cmux-session-'))
    vi.stubEnv('PI_CODING_AGENT_DIR', directory)
    const folder = join(directory, 'sessions', '--project--')
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'timestamp_session-a.jsonl')
    expect(findSessionFile('session-a')).toBeUndefined()
    writeFileSync(file, '')
    expect(findSessionFile('session-a')).toBe(file)
    expect(findSessionFile('a')).toBeUndefined()
    expect(findSessionFile('*')).toBeUndefined()
    writeFileSync(join(folder, 'other_session-a.jsonl'), '')
    expect(() => findSessionFile('session-a')).toThrow('More than one saved file')
  })
})
