/* global Button, Circle, Divider, ForEach, HStack, Image, Menu, Spacer, Text, TextField, VStack, cmux, computed, data, sidebar, signal */
// The TS-backed unused-imports rule misreads Espree references; core no-unused-vars still checks this script.
/* eslint unused-imports/no-unused-vars: off */

const STATES = {
  working: { label: 'Working', symbol: '◌', color: '#8EACFF' },
  needs_input: { label: 'Needs you', symbol: '!', color: '#E9B76B' },
  idle: { label: 'Idle', symbol: '○', color: 'secondary' },
  ended: { label: 'Ended', symbol: '–', color: 'secondary' },
  unknown: { label: 'Unknown', symbol: '?', color: 'secondary' },
  terminal: { label: 'Terminal', symbol: '›', color: 'secondary' },
}

function conversationTitle(workspace, agent, tab, count) {
  const candidates = count === 1
    ? [workspace.title, agent?.title, tab?.latestPrompt, workspace.latestPrompt, tab?.title]
    : [agent?.title, tab?.latestPrompt, tab?.title]
  return candidates.find(title => title && !title.startsWith('π - ') && !title.startsWith('~/'))
    || workspace.title || 'Untitled conversation'
}

// Only the latest session in each terminal is navigable; old records would open a different conversation.
function latestSessions(agents) {
  const latest = new Map()
  for (const agent of [...agents].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))) {
    const target = agent.panelId || agent.surfaceId || agent.id
    if (!latest.has(target))
      latest.set(target, agent)
  }
  return latest
}

function groupConversations(workspaces, groups) {
  const projects = new Map()
  for (const workspace of workspaces) {
    const group = groups.find(item => item.id === workspace.group)
    const directory = (workspace.directory || '').replace(/\/+$/, '') || '/'
    const key = group ? `group:${group.id}` : `directory:${directory}`
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        title: group?.name || directory.split('/').pop() || 'Other conversations',
        groupId: group?.id,
        color: group?.color,
        directory,
        workspaceIds: [],
        conversations: [],
      })
    }
    projects.get(key).workspaceIds.push(workspace.id)
    const latest = latestSessions(workspace.agents || [])
    const conversations = projects.get(key).conversations
    for (const agent of latest.values()) {
      const tab = workspace.tabs?.find(item => item.id === agent.panelId || (agent.surfaceId && item.surfaceId === agent.surfaceId))
      conversations.push({
        key: `${workspace.id}:${agent.id}`,
        workspaceId: workspace.id,
        surfaceId: agent.surfaceId || tab?.surfaceId,
        title: conversationTitle(workspace, agent, tab, latest.size),
        state: STATES[agent.status] || STATES.unknown,
        unread: tab?.hasUnread ?? (latest.size === 1 && workspace.unread > 0),
        lastActivityAt: agent.lastActivityAt ?? tab?.latestAt ?? 0,
        selected: workspace.selected && (tab ? tab.focused : latest.size === 1),
      })
    }
    if (latest.size === 0) {
      conversations.push({
        key: workspace.id,
        workspaceId: workspace.id,
        title: workspace.title || 'Terminal',
        state: STATES.terminal,
        unread: workspace.unread > 0,
        lastActivityAt: workspace.latestAt ?? 0,
        selected: workspace.selected,
      })
    }
  }
  for (const project of projects.values())
    project.conversations.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return [...projects.values()]
}

function visibleItems(items, expanded) {
  return expanded ? items : items.slice(0, 5)
}

function jump(conversation) {
  cmux('workspace.select', { workspace_id: conversation.workspaceId })
  if (conversation.surfaceId) {
    cmux('surface.focus', {
      workspace_id: conversation.workspaceId,
      surface_id: conversation.surfaceId,
    })
  }
}

const projects = computed(() => groupConversations(data.workspaces() || [], data.groups() || []))

function colorMenu(setColor) {
  const colors = { Red: '#E06C75', Orange: '#D99A5E', Yellow: '#E5C07B', Green: '#98C379', Blue: '#61AFEF', Purple: '#C678DD', Pink: '#E58AB5', Gray: '#9DA5B4' }
  return Menu('Color Label', [
    ...Object.entries(colors).map(([name, hex]) => Button(name, () => setColor(hex))),
    Divider(),
    Button('None', () => setColor(null)),
  ])
}

function projectMenu(project, rename, toggleCollapse) {
  const groupId = project().groupId
  return [
    Button('New Workspace', () => cmux('workspace.create', {
      cwd: project().directory,
      focus: true,
      ...(groupId ? { group_id: groupId } : {}),
    })),
    Button(groupId ? 'Rename Project…' : 'Save as Project…', rename),
    ...(groupId
      ? [colorMenu(hex => cmux('workspace.group.set_color', { group_id: groupId, ...(hex ? { hex } : {}) })), Divider(), Button('Ungroup (Keep Workspaces)', () => cmux('workspace.group.ungroup', { group_id: groupId }))]
      : []),
    Divider(),
    Button('Expand / Collapse', toggleCollapse),
  ]
}

function workspaceMenu(workspace, setMode) {
  const act = (action, params = {}) => {
    if (workspace())
      cmux('workspace.action', { workspace_id: workspace().id, action, ...params })
  }
  return [
    Button('Rename Workspace…', () => setMode('rename')),
    Button('Reset Workspace Name', () => act('clear_name')),
    colorMenu(hex => act(hex ? 'set_color' : 'clear_color', hex ? { color: hex } : {})),
    Button(() => workspace()?.pinned ? 'Unpin Workspace' : 'Pin Workspace', () => act(workspace()?.pinned ? 'unpin' : 'pin')),
    Button(() => workspace()?.unread ? 'Mark as Read' : 'Mark as Unread', () => act(workspace()?.unread ? 'mark_read' : 'mark_unread')),
    Divider(),
    Button('Close Workspace…', () => setMode('close')).destructive(),
  ]
}

function conversationRow(item) {
  const [mode, setMode] = signal(null)
  const workspace = () => (data.workspaces() || []).find(workspace => workspace.id === item().workspaceId)
  const row = HStack({ spacing: 7 }, [
    ForEach({ items: () => workspace()?.color ? [workspace().color] : [], key: color => color }, color => Circle({ size: 6 }).fill(color)),
    // Keep native keyboard activation while the outer row supplies cmux's full-rectangle hit target.
    Button('', () => jump(item()), [
      Text(() => item().title).font(13).lineLimit(1).truncation('tail').color('primary'),
    ]).frame({ maxWidth: 'infinity', alignment: 'leading' }).layoutPriority(1),
    Spacer({ minLength: 0 }),
    Text(() => `${item().state.symbol} ${item().state.label}`)
      .font(10)
      .color(() => item().state.color)
      .fixedSize()
      .layoutPriority(2),
    ForEach({ items: () => item().unread ? ['unread'] : [], key: key => key }, () => Circle({ size: 7 }).fill('blue').help('Unread update')),
  ])
    .help(() => `${item().title} (${item().state.label}${item().unread ? ', unread update' : ''})`)
    .paddingLeading(32)
    .paddingTrailing(10)
    .paddingVertical(9)
    .frame({ maxWidth: 'infinity' })
    .background(() => item().selected ? '#7f7f7f30' : null)
    .cornerRadius(10)
    .hoverBackground('#7f7f7f20')
    .onTap(() => jump(item()))
    .contextMenu(workspaceMenu(workspace, setMode))

  return VStack({ spacing: 2 }, [
    row,
    ForEach({ items: () => mode() ? [mode()] : [], key: mode => mode }, (editing) => {
      if (editing() === 'rename') {
        return TextField(() => workspace()?.title || '', {
          placeholder: 'Workspace name',
          onSubmit: (text) => {
            const title = text.trim()
            if (title && workspace())
              cmux('workspace.action', { workspace_id: workspace().id, action: 'rename', title })
            setMode(null)
          },
          onCancel: () => setMode(null),
        }).font(13).paddingLeading(32).paddingTrailing(10)
      }
      return VStack({ spacing: 6 }, [
        Text(() => `Close “${workspace()?.title || item().title}”? All terminals in this workspace will close. Running work may be lost.`).font(12),
        HStack({ spacing: 12 }, [
          Button('Cancel', () => setMode(null)),
          Button('Close Workspace', () => {
            if (workspace())
              cmux('workspace.close', { workspace_id: workspace().id })
            setMode(null)
          }).destructive(),
        ]),
      ]).paddingHorizontal(10).paddingVertical(8)
    }),
  ])
}

function projectSection(project) {
  const [collapsed, setCollapsed] = signal(false)
  const [expanded, setExpanded] = signal(false)
  const [renaming, setRenaming] = signal(false)
  const toggleCollapse = () => setCollapsed(!collapsed())
  return VStack({ spacing: 2 }, [
    Button('', toggleCollapse, [HStack({ spacing: 9 }, [
      Image('folder').font(15).color(() => project().color || 'primary'),
      Text(() => project().title).font(14).weight('medium').lineLimit(1).truncation('tail'),
      Spacer({ minLength: 0 }),
      Image('chevron.right').font(9).color('secondary').rotation(() => collapsed() ? 0 : 90),
    ])])
      .help(() => `${collapsed() ? 'Expand' : 'Collapse'} ${project().title}`)
      .paddingHorizontal(10)
      .paddingVertical(9)
      .frame({ maxWidth: 'infinity' })
      .cornerRadius(8)
      .hoverBackground('#7f7f7f18')
      .contextMenu(projectMenu(project, () => setRenaming(true), toggleCollapse)),
    ForEach({ items: () => renaming() ? ['rename'] : [], key: item => item }, () => TextField(() => project().title, {
      placeholder: 'Project name',
      onSubmit: (text) => {
        const name = text.trim()
        if (name) {
          if (project().groupId)
            cmux('workspace.group.rename', { group_id: project().groupId, name })
          else
            cmux('workspace.group.create', { name, cwd: project().directory, child_workspace_ids: JSON.stringify(project().workspaceIds) })
        }
        setRenaming(false)
      },
      onCancel: () => setRenaming(false),
    }).font(14).paddingHorizontal(10)),
    ForEach({
      items: () => collapsed() ? [] : visibleItems(project().conversations, expanded()),
      key: item => item.key,
    }, conversationRow),
    ForEach({
      items: () => !collapsed() && project().conversations.length > 5 ? ['more'] : [],
      key: item => item,
    }, () => HStack([
      Button(() => expanded() ? 'Show less' : 'Show more', () => setExpanded(!expanded()))
        .font(13)
        .color('secondary'),
      Spacer(),
    ]).paddingLeading(32).paddingVertical(7)),
  ])
}

sidebar(() => {
  const [expanded, setExpanded] = signal(false)
  return VStack({ spacing: 18 }, [
    ForEach({ items: () => visibleItems(projects(), expanded()), key: project => project.key }, projectSection),
    ForEach({
      items: () => projects().length > 5 ? ['more-projects'] : [],
      key: item => item,
    }, () => HStack([
      Button(() => expanded() ? 'Show less' : 'Show more', () => setExpanded(!expanded()))
        .font(13)
        .color('secondary')
        .help('Show or hide additional projects'),
      Spacer(),
    ]).paddingHorizontal(10)),
    Text(() => projects().length ? '' : 'Open a workspace to get started.')
      .font(13)
      .color('secondary')
      .paddingHorizontal(10),
    Spacer(),
  ]).paddingHorizontal(8).paddingVertical(12)
})
