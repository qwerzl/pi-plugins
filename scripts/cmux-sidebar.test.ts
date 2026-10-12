import { existsSync, readFileSync } from 'node:fs'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../cmux/projects.js', import.meta.url), 'utf8')
const runtimePath = '/Applications/cmux.app/Contents/Resources/CmuxSwiftRenderUI_CmuxSwiftRenderUI.bundle/Contents/Resources/SidebarRuntime.js'

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

function renderSidebar(workspaces: object[], groups: object[] = []) {
  const nodes = new Map<string, Record<string, any>>()
  const calls: unknown[] = []
  const context = createContext({
    __host_applyOps(json: string) {
      for (const op of JSON.parse(json)) {
        if (op.op === 'create')
          nodes.set(op.id, { type: op.type })
        if (op.op === 'update')
          nodes.get(op.id)![op.key] = op.value
        if (op.op === 'children')
          nodes.get(op.id)!.children = op.children
        if (op.op === 'append')
          (nodes.get(op.id)!.children ??= []).push(op.child)
        if (op.op === 'remove')
          nodes.delete(op.id)
      }
    },
    __host_action: (json: string) => calls.push(JSON.parse(json)),
  })
  runInContext(readFileSync(runtimePath, 'utf8'), context)
  runInContext(source, context)
  context.__setData('groups', JSON.stringify(groups))
  context.__setData('workspaces', JSON.stringify(workspaces))
  const descendants = (id: string): [string, Record<string, any>][] => {
    const node = nodes.get(id)!
    return [[id, node], ...(node.children || []).flatMap((child: string) => descendants(child))]
  }
  const find = (predicate: (node: Record<string, any>) => boolean, root?: string): [string, Record<string, any>] => {
    const candidates = root ? descendants(root) : [...nodes.entries()]
    const match = candidates.find(([, node]) => predicate(node))
    if (!match)
      throw new Error('Sidebar node not found')
    return match
  }
  return {
    nodes,
    calls,
    context,
    find,
    click(text: string, root?: string) {
      context.__dispatch(find(node => node.type === 'button' && node.text === text, root)[0], 'tap', 'null')
    },
    edit(event: 'submit' | 'cancel', text = '') {
      context.__dispatch(find(node => node.type === 'textfield')[0], event, JSON.stringify({ text }))
    },
  }
}

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

  it('uses per-terminal unread state without marking sibling conversations unread', () => {
    const [project] = evaluate(projection, [{
      ...workspace,
      unread: 1,
      agents: [agent, { ...agent, id: 'other', panelId: 'other-panel', surfaceId: 'other-surface' }],
      tabs: [
        { ...workspace.tabs[0], hasUnread: true },
        { id: 'other-panel', surfaceId: 'other-surface', hasUnread: false },
      ],
    }])
    expect(project.conversations.map((row: { unread: boolean }) => row.unread)).toEqual([true, false])
    const [read] = evaluate(projection, [{ ...workspace, unread: 1, tabs: [{ ...workspace.tabs[0], hasUnread: false }] }])
    expect(read.conversations[0].unread).toBe(false)
  })

  it('falls back to workspace unread state only when it can identify a single row', () => {
    expect(evaluate(projection, [{ ...workspace, unread: 1 }])[0].conversations[0].unread).toBe(true)
    expect(evaluate(projection, [workspace])[0].conversations[0].unread).toBe(false)
    const [multiple] = evaluate(projection, [{
      ...workspace,
      unread: 1,
      tabs: [],
      agents: [agent, { ...agent, id: 'other', panelId: 'other-panel' }],
    }])
    expect(multiple.conversations.map((row: { unread: boolean }) => row.unread)).toEqual([false, false])
    expect(evaluate(projection, [{ id: 'terminal', unread: 1 }])[0].conversations[0].unread).toBe(true)
  })

  it.skipIf(!existsSync(runtimePath))('keeps an unread dot through completion status changes until cmux clears it', () => {
    const ui = renderSidebar([workspace])
    const dots = () => [...ui.nodes.values()].filter(node => node.type === 'circle' && node.help === 'Unread update')
    expect(dots()).toHaveLength(0)
    for (const [status, label] of [['needs_input', 'Needs you'], ['idle', 'Idle'], ['working', 'Working']]) {
      ui.context.__setData('workspaces', JSON.stringify([{
        ...workspace,
        agents: [{ ...agent, status }],
        tabs: [{ ...workspace.tabs[0], hasUnread: true }],
      }]))
      expect(dots()).toHaveLength(1)
      expect(dots()[0]).toMatchObject({ fill: 'blue', size: 7 })
      expect(ui.find(node => node.help === `Fix the tests (${label}, unread update)`)).toBeDefined()
    }
    expect(ui.calls).toEqual([])
    ui.context.__setData('workspaces', JSON.stringify([{
      ...workspace,
      agents: [{ ...agent, status: 'idle' }],
      tabs: [{ ...workspace.tabs[0], hasUnread: false }],
    }]))
    expect(dots()).toHaveLength(0)
    expect(ui.find(node => node.help === 'Fix the tests (Idle)')).toBeDefined()
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

  it.skipIf(!existsSync(runtimePath))('makes the full row tappable and keeps a native title button in the installed cmux runtime', () => {
    const { nodes, calls, context } = renderSidebar([workspace])
    const row = [...nodes.entries()].find(([, node]) => node.help === 'Fix the tests (Working)')!
    expect(row[1]).toMatchObject({ type: 'hstack', tappable: true, maxWidth: 'infinity', paddingLeading: 32, paddingVertical: 9 })
    const title = [...nodes.entries()].find(([, node]) => node.type === 'button'
      && Array.isArray(node.children) && node.children.some(id => nodes.get(id)?.text === 'Fix the tests'))!
    expect(title).toBeDefined()

    context.__setData('workspaces', JSON.stringify([{ ...workspace, agents: [{ ...agent, status: 'idle', lastActivityAt: 3 }] }]))
    expect(nodes.get(row[0])?.help).toBe('Fix the tests (Idle)')
    for (const id of [row[0], title[0]]) {
      calls.length = 0
      context.__dispatch(id, 'tap', 'null')
      expect(calls).toEqual([
        { kind: 'cmux', method: 'workspace.select', params: { workspace_id: 'workspace' } },
        { kind: 'cmux', method: 'surface.focus', params: { workspace_id: 'workspace', surface_id: 'surface' } },
      ])
    }
  })

  it.skipIf(!existsSync(runtimePath))('attaches project menus and creates focused workspaces in the correct group', () => {
    const ui = renderSidebar([{ ...workspace, group: 'project' }], [{ id: 'project', name: 'Example' }])
    const header = ui.find(node => node.help === 'Collapse Example')[0]
    expect(ui.find(node => node.type === 'contextMenu', header)).toBeDefined()
    ui.click('New Workspace', header)
    ui.click('Blue', header)
    ui.click('None', header)
    ui.click('Rename Project…', header)
    ui.edit('submit', '  Renamed  ')
    ui.click('Ungroup (Keep Workspaces)', header)
    expect(ui.calls).toEqual([
      { kind: 'cmux', method: 'workspace.create', params: { group_id: 'project', cwd: '/projects/example', focus: 'true' } },
      { kind: 'cmux', method: 'workspace.group.set_color', params: { group_id: 'project', hex: '#61AFEF' } },
      { kind: 'cmux', method: 'workspace.group.set_color', params: { group_id: 'project' } },
      { kind: 'cmux', method: 'workspace.group.rename', params: { group_id: 'project', name: 'Renamed' } },
      { kind: 'cmux', method: 'workspace.group.ungroup', params: { group_id: 'project' } },
    ])
    ui.context.__setData('groups', JSON.stringify([{ id: 'project', name: 'Renamed', color: '#61AFEF' }]))
    expect(ui.find(node => node.help === 'Collapse Renamed')).toBeDefined()
    expect(ui.find(node => node.color === '#61AFEF')).toBeDefined()
  })

  it.skipIf(!existsSync(runtimePath))('creates focused workspaces by directory and saves folders as projects without duplicate members', () => {
    const ui = renderSidebar([{ ...workspace, agents: [agent, { ...agent, id: 'second', panelId: 'second' }] }])
    const header = ui.find(node => node.help === 'Collapse example')[0]
    ui.click('New Workspace', header)
    ui.click('Save as Project…', header)
    ui.edit('submit', 'My Project')
    expect(ui.calls).toEqual([
      { kind: 'cmux', method: 'workspace.create', params: { cwd: '/projects/example', focus: 'true' } },
      { kind: 'cmux', method: 'workspace.group.create', params: { name: 'My Project', cwd: '/projects/example', child_workspace_ids: '["workspace"]' } },
    ])
  })

  it.skipIf(!existsSync(runtimePath))('targets the clicked workspace rather than the selected workspace and requires confirmation before closing', () => {
    const ui = renderSidebar([workspace, { ...workspace, id: 'other', selected: false, title: 'Other workspace' }])
    const row = ui.find(node => node.help === 'Other workspace (Working)')[0]
    expect(ui.find(node => node.type === 'contextMenu', row)).toBeDefined()
    ui.click('Rename Workspace…', row)
    ui.edit('submit', '  New title  ')
    ui.click('Purple', row)
    ui.click('None', row)
    ui.click('Pin Workspace', row)
    ui.click('Mark as Unread', row)
    ui.click('Reset Workspace Name', row)
    expect(ui.calls).toEqual([
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'rename', title: 'New title' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'set_color', color: '#C678DD' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'clear_color' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'pin' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'mark_unread' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'other', action: 'clear_name' } },
    ])
    ui.calls.length = 0
    ui.click('Close Workspace…', row)
    expect(ui.calls).toEqual([])
    ui.click('Cancel')
    expect(ui.calls).toEqual([])
    ui.click('Close Workspace…', row)
    expect(ui.find(node => typeof node.text === 'string' && node.text.includes('All terminals'))).toBeDefined()
    ui.click('Close Workspace')
    expect(ui.calls).toEqual([{ kind: 'cmux', method: 'workspace.close', params: { workspace_id: 'other' } }])
  })

  it.skipIf(!existsSync(runtimePath))('cancels rename or blank names without mutating data and reacts to workspace labels', () => {
    const ui = renderSidebar([{ ...workspace, group: 'project' }], [{ id: 'project', name: 'Example' }])
    for (const menu of ['Rename Workspace…', 'Rename Project…']) {
      ui.click(menu)
      ui.edit('cancel')
      ui.click(menu)
      ui.edit('submit', '   ')
    }
    expect(ui.calls).toEqual([])
    ui.context.__setData('workspaces', JSON.stringify([{ ...workspace, group: 'project', title: 'New title', color: '#C678DD', pinned: true, unread: 1 }]))
    expect(ui.find(node => node.help === 'New title (Working, unread update)')).toBeDefined()
    expect(ui.find(node => node.type === 'circle' && node.fill === '#C678DD')).toBeDefined()
    ui.click('Unpin Workspace')
    ui.click('Mark as Read')
    expect(ui.calls).toEqual([
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'workspace', action: 'unpin' } },
      { kind: 'cmux', method: 'workspace.action', params: { workspace_id: 'workspace', action: 'mark_read' } },
    ])
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
