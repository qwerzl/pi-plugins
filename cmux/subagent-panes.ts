import type { PanelState } from '../packages/cmux-panel/src/state.ts'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { agentOutputFile } from '../packages/cmux-panel/src/state.ts'
import { cmux } from './active-session.ts'
import { shellQuote } from './open-panel.ts'

export class SubagentPanes {
  private panes = new Map<string, string>()
  private failed = new Map<string, string>()
  private workspaceId: string
  private sourceSurfaceId: string

  constructor(workspaceId: string, sourceSurfaceId: string) {
    this.workspaceId = workspaceId
    this.sourceSurfaceId = sourceSurfaceId
  }

  async sync(agents: NonNullable<PanelState['agents']>): Promise<string> {
    const wanted = new Set(agents.map(agent => agent.id))
    await this.removeInactive(wanted)
    if (!this.workspaceId || !this.sourceSurfaceId)
      return agents.length ? 'Cannot open subagent panes outside a cmux terminal' : ''
    let error = [...this.failed.values()].at(-1) ?? ''
    for (const agent of agents) {
      if (this.panes.has(agent.id) || this.failed.has(agent.id))
        continue
      try {
        this.panes.set(agent.id, await this.open(agent))
      }
      catch (cause) {
        error = `Cannot open ${agent.description}: ${cause instanceof Error ? cause.message : String(cause)}`
        this.failed.set(agent.id, error)
      }
    }
    return error
  }

  private async removeInactive(wanted: Set<string>): Promise<void> {
    for (const [id, surfaceId] of this.panes) {
      if (!wanted.has(id)) {
        await this.close(surfaceId)
        this.panes.delete(id)
      }
    }
    for (const id of this.failed.keys()) {
      if (!wanted.has(id))
        this.failed.delete(id)
    }
  }

  private async open(agent: NonNullable<PanelState['agents']>[number]): Promise<string> {
    const file = agentOutputFile(agent.cwd, agent.sessionId, agent.id)
    const title = `Agent: ${agent.description}`
    const viewer = fileURLToPath(new URL('./subagent-panel.ts', import.meta.url))
    let source = this.sourceSurfaceId
    if (this.panes.size) {
      const current = await cmux('pane.list', { workspace_id: this.workspaceId })
      const panes = Array.isArray(current.panes) ? current.panes : []
      source = [...this.panes.values()].toReversed().find(id => panes.some(pane => pane && typeof pane === 'object' && Array.isArray(pane.surface_ids) && pane.surface_ids.includes(id))) ?? source
    }
    const result = await cmux('surface.split', {
      workspace_id: this.workspaceId,
      surface_id: source,
      direction: 'down',
      focus: false,
      initial_divider_position: 0.5,
      initial_command: `${shellQuote(process.execPath)} ${shellQuote(viewer)} ${shellQuote(file)} ${shellQuote(title)}`,
    })
    if (typeof result.surface_id !== 'string')
      throw new Error('cmux did not return the new subagent surface')
    return result.surface_id
  }

  private async close(surfaceId: string): Promise<void> {
    const listed = async (): Promise<Record<string, unknown> | undefined> => {
      const result = await cmux('surface.list', { workspace_id: this.workspaceId })
      return Array.isArray(result.surfaces)
        ? result.surfaces.find(row => row && typeof row === 'object' && row.id === surfaceId)
        : undefined
    }
    const current = await listed()
    if (current && (typeof current.initial_command !== 'string' || !current.initial_command.includes('/cmux/subagent-panel.ts')))
      return
    try {
      await cmux('surface.close', { workspace_id: this.workspaceId, surface_id: surfaceId, force: true })
    }
    catch (error) {
      // Some cmux builds close the pane but report an error. Check before retrying.
      if (await listed())
        throw error
    }
  }
}
