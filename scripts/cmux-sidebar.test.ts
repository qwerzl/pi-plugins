import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../cmux/projects.js', import.meta.url), 'utf8')

function evaluate(expression: string, fixtures: object[] = [], groups: object[] = []) {
  return JSON.parse(runInNewContext(`${source}\nJSON.stringify(${expression})`, {
    computed: (fn: () => unknown) => fn,
    sidebar: () => {},
    fixtures,
    groups,
  }))
}

const agent = { id: 'session', panelId: 'panel', surfaceId: 'surface', status: 'working', lastActivityAt: 2, title: 'Fix the tests' }
const workspace = { id: 'workspace', directory: '/projects/example', title: 'π - example', selected: true, agents: [agent], tabs: [{ id: 'panel', surfaceId: 'surface', focused: true }] }
const projection = 'groupConversations(fixtures, groups)'

describe('cmux project conversations', () => {
  it('uses live titles, selection and status, while preserving explicit workspace names', () => {
    const [project] = evaluate(projection, [workspace])
    expect(project.title).toBe('example')
    expect(project.conversations[0]).toMatchObject({ title: 'Fix the tests', selected: true, state: { label: 'Working' } })
    const [named] = evaluate(projection, [{ ...workspace, title: 'Investigate flaky tests' }])
    expect(named.conversations[0].title).toBe('Investigate flaky tests')
  })

  it('uses the latest prompt when no conversation title is available', () => {
    const [project] = evaluate(projection, [{
      ...workspace,
      latestPrompt: 'Customize the sidebar',
      agents: [{ ...agent, title: undefined }],
      tabs: [{ ...workspace.tabs[0], title: 'π - example' }],
    }])
    expect(project.conversations[0].title).toBe('Customize the sidebar')
  })

  it('keeps only the latest session per terminal and does not highlight other panes', () => {
    const [project] = evaluate(projection, [{
      ...workspace,
      agents: [
        { ...agent, id: 'old', status: 'ended', lastActivityAt: 1 },
        agent,
        { ...agent, id: 'other', panelId: 'other-panel', surfaceId: 'other-surface', status: 'needs_input' },
      ],
      tabs: [...workspace.tabs, { id: 'other-panel', surfaceId: 'other-surface', focused: false }],
    }])
    expect(project.conversations).toHaveLength(2)
    expect(project.conversations[0]).toMatchObject({ key: 'workspace:session', selected: true })
    expect(project.conversations[1]).toMatchObject({ selected: false, state: { label: 'Needs you' } })
  })

  it('respects cmux groups and keeps same-named folders at different paths separate', () => {
    const projects = evaluate(projection, [
      { ...workspace, group: 'project', directory: '/elsewhere' },
      { ...workspace, id: 'second', group: 'project' },
      { ...workspace, id: 'third', directory: '/one/example/' },
      { ...workspace, id: 'fourth', directory: '/two/example' },
    ], [{ id: 'project', name: 'My project' }])
    expect(projects.map((project: { title: string }) => project.title)).toEqual(['My project', 'example', 'example'])
    expect(projects[0].conversations).toHaveLength(2)
  })

  it('does not confuse idle, ended, missing hooks, or unknown status with success', () => {
    for (const [status, label] of [['idle', 'Idle'], ['ended', 'Ended'], ['future-state', 'Unknown']]) {
      const [project] = evaluate(projection, [{ ...workspace, agents: [{ ...agent, status }] }])
      expect(project.conversations[0].state.label).toBe(label)
    }
    expect(evaluate(projection, [{ id: 'terminal' }])[0].conversations[0].state.label).toBe('Terminal')
    expect(evaluate(projection)).toEqual([])
  })

  it('shows the first five sessions or projects without promoting an older selection', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ key: String(i), selected: i === 7 }))
    expect(evaluate('visibleItems(fixtures, false)', rows)).toEqual(rows.slice(0, 5))
    expect(evaluate('visibleItems(fixtures, true)', rows)).toEqual(rows)
    for (const length of [0, 4, 5])
      expect(evaluate('visibleItems(fixtures, false)', rows.slice(0, length))).toEqual(rows.slice(0, length))
  })

  it('sorts sessions across workspaces by activity and updates their order without reordering projects', () => {
    const fixtures = [
      { ...workspace, id: 'older', agents: [{ ...agent, lastActivityAt: 10 }] },
      { ...workspace, id: 'separate', directory: '/projects/another', agents: [{ ...agent, lastActivityAt: 100 }] },
      { ...workspace, id: 'newer', agents: [{ ...agent, lastActivityAt: 20 }] },
    ]
    const projects = evaluate(projection, fixtures)
    expect(projects.map((project: { title: string }) => project.title)).toEqual(['example', 'another'])
    expect(projects[0].conversations.map((row: { workspaceId: string }) => row.workspaceId)).toEqual(['newer', 'older'])
    fixtures[0]!.agents[0]!.lastActivityAt = 30
    expect(evaluate(projection, fixtures)[0].conversations.map((row: { workspaceId: string }) => row.workspaceId)).toEqual(['older', 'newer'])
  })

  it('keeps ties stable and uses available timestamps before undated sessions', () => {
    const [project] = evaluate(projection, [
      { ...workspace, id: 'undated', agents: [{ ...agent, lastActivityAt: undefined }] },
      { ...workspace, id: 'dated', agents: [{ ...agent, lastActivityAt: 10 }] },
      { ...workspace, id: 'tied', agents: [{ ...agent, lastActivityAt: 10 }] },
      { ...workspace, id: 'tab-date', agents: [{ ...agent, lastActivityAt: undefined }], tabs: [{ ...workspace.tabs[0], latestAt: 5 }] },
      { ...workspace, id: 'terminal', agents: [], latestAt: 3 },
    ])
    expect(project.conversations.map((row: { workspaceId: string }) => row.workspaceId)).toEqual(['dated', 'tied', 'tab-date', 'terminal', 'undated'])
  })

  it('targets the containing workspace when focusing a conversation and tolerates missing surfaces', () => {
    const calls: unknown[] = []
    runInNewContext(`${source}\njump({ workspaceId: 'w', surfaceId: 's' }); jump({ workspaceId: 'fallback' })`, {
      computed: (fn: () => unknown) => fn,
      sidebar: () => {},
      cmux: (method: string, params: object) => calls.push([method, params]),
    })
    expect(calls).toEqual([
      ['workspace.select', { workspace_id: 'w' }],
      ['surface.focus', { workspace_id: 'w', surface_id: 's' }],
      ['workspace.select', { workspace_id: 'fallback' }],
    ])
  })
})
