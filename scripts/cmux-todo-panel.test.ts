import { stripTerminalSequences, Text, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { readSnapshot, statusContent, taskContent } from '../cmux/todo-panel.ts'

const header = { type: 'session', version: 3, id: 'session-123456', cwd: '/projects/demo' }
const pending = { id: 1, subject: 'Build the panel', status: 'pending' as const }

function snapshot(id: string, parentId: string | null, tasks: unknown[]): object {
  return { type: 'message', id, parentId, message: { role: 'toolResult', toolName: 'todo', details: { tasks, nextId: 2 } } }
}

function jsonl(...entries: unknown[]): string {
  return `${[header, ...entries].map(entry => JSON.stringify(entry)).join('\n')}\n`
}

describe('cmux plan snapshot', () => {
  it('reads the latest complete snapshot and identifies its conversation', () => {
    const completed = { ...pending, status: 'completed' }
    expect(readSnapshot(jsonl(snapshot('a', null, [pending]), snapshot('b', 'a', [completed])))).toEqual({
      label: 'demo · session-',
      tasks: [completed],
    })
  })

  it('follows parents rather than showing tasks from an abandoned branch', () => {
    const data = jsonl(
      snapshot('a', null, [pending]),
      snapshot('b', 'a', [{ ...pending, subject: 'Wrong branch' }]),
      { type: 'branch_summary', id: 'c', parentId: 'a' },
    )
    expect(readSnapshot(data).tasks).toEqual([pending])
    expect(readSnapshot(`${data}${JSON.stringify({ type: 'message', id: 'd', parentId: null })}\n`).tasks).toEqual([])
  })

  it('uses the live bridge branch even before a tree selection is written', () => {
    const data = jsonl(snapshot('a', null, [pending]), snapshot('b', 'a', []))
    expect(readSnapshot(data, 'a').tasks).toEqual([pending])
    expect(readSnapshot(data, null).tasks).toEqual([])
  })

  it('keeps an explicit cleared list, even with earlier tasks', () => {
    expect(readSnapshot(jsonl(snapshot('a', null, [pending]), snapshot('b', 'a', []))).tasks).toEqual([])
  })

  it('reads tasks through compaction and unrelated tools', () => {
    const data = jsonl(
      snapshot('a', null, [pending]),
      { type: 'compaction', id: 'b', parentId: 'a', firstKeptEntryId: 'b' },
      { type: 'message', id: 'c', parentId: 'b', message: { role: 'toolResult', toolName: 'bash', details: { tasks: [], nextId: 1 } } },
    )
    expect(readSnapshot(data).tasks).toEqual([pending])
  })

  it('waits for a partial append but rejects corrupt complete records', () => {
    const data = jsonl(snapshot('a', null, [pending]))
    expect(readSnapshot(`${data}{"type":`).tasks).toEqual([pending])
    expect(() => readSnapshot(`${data}{"type":\n`)).toThrow('Invalid session record')
    expect(readSnapshot(data.trimEnd()).tasks).toEqual([pending])
  })

  it('rejects unsupported snapshots and broken trees instead of hiding the problem', () => {
    expect(() => readSnapshot(jsonl(snapshot('a', null, [{ ...pending, status: 'success' }])))).toThrow('Unsupported todo snapshot')
    expect(() => readSnapshot(jsonl(snapshot('a', 'missing', [])))).toThrow('Missing parent')
    expect(() => readSnapshot(jsonl(snapshot('a', 'b', []), snapshot('b', 'a', [])))).toThrow('Cycle')
    expect(() => readSnapshot('')).toThrow('Expected a Pi')
    expect(() => readSnapshot('{"type":"session","version":1}\n')).toThrow('migrate')
  })
})

describe('cmux plan presentation', () => {
  const tasks = [
    pending,
    { id: 2, subject: 'Research', status: 'completed' as const },
    { id: 3, subject: 'Verify', status: 'in_progress' as const, activeForm: 'Running tests' },
    { id: 4, subject: 'Removed task', status: 'deleted' as const },
    { id: 5, subject: 'Enable', status: 'pending' as const, blockedBy: [1, 2, 4] },
  ]

  it('uses the native-style task tree, resolves blockers and hides deleted tasks', () => {
    const text = stripTerminalSequences(taskContent(tasks, false))
    expect(text).toContain('● Todos (1/4)\n├─ ○ #1 Build the panel')
    expect(text).toContain('├─ ◐ #3 Verify (Running tests)')
    expect(text).toContain('└─ 1 completed')
    expect(text).toContain('Running tests')
    expect(text).toContain('Waiting for #1')
    expect(text).not.toContain('#2')
    expect(text).not.toContain('#4')
    expect(text).not.toContain('Removed task')
    expect(text).not.toContain('Research')
    expect(text).toContain('1 completed · press c to show')
    expect(stripTerminalSequences(taskContent(tasks, true))).toContain('✓ #2 Research')
  })

  it('shows all actual footer chips and diagnostics as tree rows', () => {
    const text = stripTerminalSequences(statusContent({
      version: 1,
      producerPid: 123,
      updatedAt: Date.now(),
      leafId: null,
      footer: ['model high · 42%/272k · 99% · avg 29 tok/s', 'project on main · MCP: 2 servers enabled · ponytail: FULL'],
      diagnostics: ['pi-lens !7W', 'todo-panel.ts 4W'],
    }))
    expect(text).toContain('● Statistics\n├─ model high\n├─ 42%/272k')
    expect(text).toContain('├─ MCP: 2 servers enabled')
    expect(text).toContain('└─ ponytail: FULL')
    expect(text).toContain('● Diagnostics\n├─ pi-lens !7W\n└─ todo-panel.ts 4W')
    expect(statusContent(undefined)).toContain('Waiting for Pi panel bridge')
  })

  it('keeps source colors across styled separators and resets each tree row', () => {
    const text = statusContent({
      version: 1,
      producerPid: 123,
      updatedAt: Date.now(),
      leafId: null,
      footer: ['\u001B[38;2;90;180;220mmodel\u001B[2m · \u001B[22m42%\u001B[39m'],
      diagnostics: ['\u001B[33mpi-lens 2W\u001B[39m', '\u001B[2m  \u001B[22m'],
    })
    const rows = text.split('\n')
    expect(rows.find(line => line.includes('model'))).toContain('\u001B[38;2;90;180;220mmodel\u001B[0m')
    expect(rows.find(line => line.includes('42%'))).toContain('\u001B[38;2;90;180;220m\u001B[2m\u001B[22m42%\u001B[0m')
    expect(rows.find(line => line.includes('pi-lens'))).toContain('\u001B[33mpi-lens 2W\u001B[0m')
    expect(stripTerminalSequences(text)).toBe('● Statistics\n├─ model\n└─ 42%\n\n● Diagnostics\n└─ pi-lens 2W')
    const wrapped = new Text(text, 1, 1).render(20)
    expect(wrapped.every(line => visibleWidth(line) <= 20)).toBe(true)
    expect(wrapped.join('\n')).toContain('\u001B[38;2;90;180;220m')
  })

  it('preserves background colors but never forwards terminal commands from the cache', () => {
    const text = statusContent({
      version: 1,
      producerPid: 123,
      updatedAt: Date.now(),
      leafId: null,
      footer: ['\u001B[48;2;20;180;90m  \u001B[49m 42% · \u001B]52;c;secret\u001B[31mhidden\u0007safe\u001B[2J\u001B[?25l'],
      diagnostics: ['\u001B]0;unwanted title\u001B\\\u001B[32mclean\u001B[39m\r\u202E'],
    })
    expect(text).toContain('\u001B[48;2;20;180;90m  \u001B[49m 42%')
    expect(text).toContain('\u001B[32mclean')
    expect(stripTerminalSequences(text)).toContain('safe')
    for (const blocked of ['secret', 'hidden', 'unwanted title', '\u001B]', '\u001B[2J', '\u001B[?25l', '\r', '\u202E'])
      expect(text).not.toContain(blocked)
  })

  it('distinguishes empty and completed plans', () => {
    expect(taskContent([], false)).toContain('No tasks yet')
    expect(taskContent([tasks[1]], false)).toContain('All tasks complete')
  })

  it('strips terminal control sequences from task text', () => {
    const text = stripTerminalSequences(taskContent([{ ...pending, subject: '\u001B]52;c;secret\u0007Safe\rtitle\u202E' }], true))
    expect(text).toContain('Safe title')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('\r')
    expect(text).not.toContain('\u202E')
  })

  it('wraps long and wide task titles within a narrow pane', () => {
    const text = new Text(taskContent([{ ...pending, subject: '测试任务 👩‍💻 '.repeat(12) }], true), 1, 1)
    for (const width of [20, 35, 40, 60]) {
      const lines = text.render(width)
      expect(lines.length).toBeGreaterThan(3)
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
    }
  })
})
