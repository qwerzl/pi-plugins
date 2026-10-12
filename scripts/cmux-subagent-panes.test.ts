import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cmux } from '../cmux/active-session.ts'
import { SubagentPanes } from '../cmux/subagent-panes.ts'

vi.mock('../cmux/active-session.ts', () => ({ cmux: vi.fn() }))
const rpc = vi.mocked(cmux)
const parent = '12345678-1234-1234-1234-123456789abc'
const agent = (id: string) => ({ id, description: `Research ${id}`, cwd: '/projects/demo', sessionId: parent })

beforeEach(() => rpc.mockReset())

describe('cmux vertical subagent panes', () => {
  it('opens under the Plan surface once, retains active peers, and closes finished panes', async () => {
    const panes = new SubagentPanes('workspace', 'plan')
    const a = agent('67d0c849-8a7f-4fd')
    const b = agent('67d0c849-8a7f-4fe')
    rpc.mockResolvedValueOnce({ surface_id: 'child-a' })
      .mockResolvedValueOnce({ panes: [{ surface_ids: ['child-a'] }] })
      .mockResolvedValueOnce({ surface_id: 'child-b' })
      .mockResolvedValueOnce({ surfaces: [{ id: 'child-a', initial_command: '/cmux/subagent-panel.ts' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ surfaces: [{ id: 'child-b', initial_command: '/cmux/subagent-panel.ts' }] })
      .mockResolvedValueOnce({})
    expect(await panes.sync([a, b])).toBe('')
    expect(rpc).toHaveBeenNthCalledWith(1, 'surface.split', expect.objectContaining({
      workspace_id: 'workspace',
      surface_id: 'plan',
      direction: 'down',
      focus: false,
      initial_command: expect.stringContaining(`${a.id}.output`),
    }))
    expect(rpc).toHaveBeenNthCalledWith(2, 'pane.list', { workspace_id: 'workspace' })
    expect(rpc).toHaveBeenNthCalledWith(3, 'surface.split', expect.objectContaining({ surface_id: 'child-a', direction: 'down' }))
    expect(await panes.sync([a, b])).toBe('')
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(await panes.sync([b])).toBe('')
    expect(rpc).toHaveBeenNthCalledWith(5, 'surface.close', { workspace_id: 'workspace', surface_id: 'child-a', force: true })
    expect(await panes.sync([])).toBe('')
    expect(rpc).toHaveBeenNthCalledWith(7, 'surface.close', { workspace_id: 'workspace', surface_id: 'child-b', force: true })
  })

  it('uses Plan if an earlier subagent pane was dismissed manually', async () => {
    const panes = new SubagentPanes('workspace', 'plan')
    const a = agent('67d0c849-8a7f-4fd')
    const b = agent('67d0c849-8a7f-4fe')
    rpc.mockResolvedValueOnce({ surface_id: 'child-a' })
      .mockResolvedValueOnce({ panes: [] })
      .mockResolvedValueOnce({ surface_id: 'child-b' })
    expect(await panes.sync([a, b])).toBe('')
    expect(rpc).toHaveBeenNthCalledWith(3, 'surface.split', expect.objectContaining({ surface_id: 'plan' }))
  })

  it('reports no-space failures once while the agent remains active, then retries a new run', async () => {
    const panes = new SubagentPanes('workspace', 'plan')
    const a = agent('67d0c849-8a7f-4fd')
    rpc.mockRejectedValueOnce(new Error('no space')).mockResolvedValueOnce({ surface_id: 'child' })
    expect(await panes.sync([a])).toContain('no space')
    expect(await panes.sync([a])).toContain('no space')
    expect(rpc).toHaveBeenCalledTimes(1)
    await panes.sync([])
    expect(await panes.sync([a])).toBe('')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('checks whether cmux closed a pane before treating an error as failure', async () => {
    const panes = new SubagentPanes('workspace', 'plan')
    const a = agent('67d0c849-8a7f-4fd')
    rpc.mockResolvedValueOnce({ surface_id: 'child' })
      .mockResolvedValueOnce({ surfaces: [{ id: 'child', initial_command: '/cmux/subagent-panel.ts' }] })
      .mockRejectedValueOnce(new Error('internal_error'))
      .mockResolvedValueOnce({ surfaces: [] })
    await panes.sync([a])
    expect(await panes.sync([])).toBe('')
  })

  it('never force-closes a subagent surface repurposed for another process', async () => {
    const panes = new SubagentPanes('workspace', 'plan')
    rpc.mockResolvedValueOnce({ surface_id: 'child' })
      .mockResolvedValueOnce({ surfaces: [{ id: 'child', initial_command: '/bin/bash' }] })
    await panes.sync([agent('67d0c849-8a7f-4fd')])
    await panes.sync([])
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('does not create panes without an attached cmux viewer surface', async () => {
    const panes = new SubagentPanes('workspace', '')
    expect(await panes.sync([agent('67d0c849-8a7f-4fd')])).toContain('outside a cmux terminal')
    expect(rpc).not.toHaveBeenCalled()
  })
})
