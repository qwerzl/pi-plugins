import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cmux } from '../cmux/active-session.ts'
import { openPanel } from '../cmux/open-panel.ts'

vi.mock('../cmux/active-session.ts', () => ({ cmux: vi.fn() }))
const rpc = vi.mocked(cmux)

beforeEach(() => rpc.mockReset())

describe('attached conversation panel launcher', () => {
  it.each([[200, 0.8], [80, 0.5], [60, 0.5], [500, 0.9]])('uses a narrow right split for a %i-column conversation', async (columns, divider) => {
    rpc.mockResolvedValueOnce({ panes: [{ surface_ids: ['owner'], columns }] })
      .mockResolvedValueOnce({ surfaces: [] })
      .mockResolvedValueOnce({ surface_id: 'panel' })
    expect(await openPanel('workspace', 'owner')).toEqual({ surface_id: 'panel' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'pane.list', { workspace_id: 'workspace' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'surface.list', { workspace_id: 'workspace' })
    expect(rpc).toHaveBeenNthCalledWith(3, 'surface.split', expect.objectContaining({
      workspace_id: 'workspace',
      surface_id: 'owner',
      direction: 'right',
      focus: false,
      initial_divider_position: divider,
      initial_command: expect.stringContaining('--surface \'owner\''),
    }))
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('quotes shell arguments and uses the installed Node executable', async () => {
    const surfaceId = 'owner\'s surface; echo unsafe'
    rpc.mockResolvedValueOnce({ panes: [{ surface_ids: [surfaceId], columns: 200 }] })
      .mockResolvedValueOnce({ surfaces: [] })
      .mockResolvedValueOnce({})
    await openPanel('workspace', surfaceId)
    const command = String(rpc.mock.calls[2][1]?.initial_command)
    // Parse the generated arguments with a shell, but print them instead of starting the viewer.
    const args = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0').slice(0, -1)
    expect(args).toEqual([process.execPath, fileURLToPath(new URL('../cmux/todo-panel.ts', import.meta.url)), '--surface', surfaceId])
  })

  it('reuses only a panel owned by this conversation, including after /reload', async () => {
    const ownerCommand = `'${fileURLToPath(new URL('../cmux/todo-panel.ts', import.meta.url))}' --surface 'owner'`
    rpc.mockResolvedValueOnce({ panes: [{ surface_ids: ['owner'], columns: 200 }] })
      .mockResolvedValueOnce({ surfaces: [
        { id: 'other', initial_command: ownerCommand.replace('--surface \'owner\'', '--surface \'another\'') },
        { id: 'dock', dock_scope: 'global', initial_command: ownerCommand },
        { id: 'panel', initial_command: `'node' ${ownerCommand}` },
      ] })
    expect(await openPanel('workspace', 'owner')).toEqual({ surface_id: 'panel', reused: true })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('does not split when existing panels cannot be checked', async () => {
    rpc.mockResolvedValueOnce({ panes: [{ surface_ids: ['owner'], columns: 200 }] }).mockResolvedValueOnce({})
    await expect(openPanel('workspace', 'owner')).rejects.toThrow('Cannot check existing conversation panels')
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    {},
    { panes: [] },
    { panes: [null, { surface_ids: ['another'], columns: 200 }] },
    { panes: [{ surface_ids: ['owner'], columns: 200, dock_scope: 'global' }] },
    { panes: [{ surface_ids: ['owner'], columns: 0 }] },
    { panes: [{ surface_ids: ['owner'], columns: Number.NaN }] },
  ])('does not split an unknown, Dock, or unmeasurable source: %j', async (result) => {
    rpc.mockResolvedValueOnce(result)
    await expect(openPanel('workspace', 'owner')).rejects.toThrow('Cannot find the conversation terminal')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('requires explicit owner context instead of splitting the focused user terminal', async () => {
    await expect(openPanel('', 'owner')).rejects.toThrow('cmux conversation terminal')
    await expect(openPanel('workspace', '')).rejects.toThrow('cmux conversation terminal')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('surfaces cmux failures without retrying a possibly successful split', async () => {
    rpc.mockResolvedValueOnce({ panes: [{ surface_ids: ['owner'], columns: 200 }] })
      .mockResolvedValueOnce({ surfaces: [] })
      .mockRejectedValueOnce(new Error('no space'))
    await expect(openPanel('workspace', 'owner')).rejects.toThrow('no space')
    expect(rpc).toHaveBeenCalledTimes(3)
  })
})
