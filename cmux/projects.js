/* global Button, ForEach, HStack, Image, Spacer, Text, VStack, cmux, computed, data, sidebar, signal */
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
        conversations: [],
      })
    }
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

function conversationRow(item) {
  return Button('', () => jump(item()), [HStack({ spacing: 7 }, [
    Text(() => item().title).font(13).lineLimit(1).truncation('tail').color('primary'),
    Spacer({ minLength: 0 }),
    Text(() => `${item().state.symbol} ${item().state.label}`)
      .font(10)
      .color(() => item().state.color)
      .fixedSize()
      .layoutPriority(2),
  ])])
    .help(() => `${item().title} (${item().state.label})`)
    .paddingLeading(32)
    .paddingTrailing(10)
    .paddingVertical(9)
    .frame({ maxWidth: 'infinity' })
    .background(() => item().selected ? '#7f7f7f30' : null)
    .cornerRadius(10)
    .hoverBackground('#7f7f7f20')
}

function projectSection(project) {
  const [collapsed, setCollapsed] = signal(false)
  const [expanded, setExpanded] = signal(false)
  return VStack({ spacing: 2 }, [
    Button('', () => setCollapsed(!collapsed()), [HStack({ spacing: 9 }, [
      Image('folder').font(15).color('primary'),
      Text(() => project().title).font(14).weight('medium').lineLimit(1).truncation('tail'),
      Spacer({ minLength: 0 }),
      Image('chevron.right').font(9).color('secondary').rotation(() => collapsed() ? 0 : 90),
    ])])
      .help(() => `${collapsed() ? 'Expand' : 'Collapse'} ${project().title}`)
      .paddingHorizontal(10)
      .paddingVertical(9)
      .frame({ maxWidth: 'infinity' })
      .cornerRadius(8)
      .hoverBackground('#7f7f7f18'),
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
