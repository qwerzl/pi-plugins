import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cmux } from './active-session.ts'

export function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

export async function openPanel(workspaceId: string, surfaceId: string): Promise<Record<string, unknown>> {
  if (!workspaceId || !surfaceId)
    throw new Error('Open the panel from a cmux conversation terminal, or supply its surface UUID')
  const result = await cmux('pane.list', { workspace_id: workspaceId })
  const pane = Array.isArray(result.panes) && result.panes.find((row: unknown) => {
    if (!row || typeof row !== 'object' || !('surface_ids' in row))
      return false
    return Array.isArray(row.surface_ids) && row.surface_ids.includes(surfaceId)
  }) as Record<string, unknown> | undefined
  if (!pane || pane.dock_scope || typeof pane.columns !== 'number' || !Number.isFinite(pane.columns) || pane.columns <= 0)
    throw new Error('Cannot find the conversation terminal in this workspace')

  const viewer = fileURLToPath(new URL('./todo-panel.ts', import.meta.url))
  const ownerArg = `${shellQuote(viewer)} --surface ${shellQuote(surfaceId)}`
  const existing = await cmux('surface.list', { workspace_id: workspaceId })
  if (!Array.isArray(existing.surfaces))
    throw new Error('Cannot check existing conversation panels')
  const panel = existing.surfaces.find((row: unknown) => row && typeof row === 'object' && 'initial_command' in row
    && typeof row.initial_command === 'string' && row.initial_command.includes(ownerArg) && !('dock_scope' in row && row.dock_scope)) as Record<string, unknown> | undefined
  if (panel)
    return { surface_id: panel.id, reused: true }

  return cmux('surface.split', {
    workspace_id: workspaceId,
    surface_id: surfaceId,
    direction: 'right',
    focus: false,
    // Leave at least half the source pane for the conversation; cmux caps the ratio at 0.9.
    initial_divider_position: Math.min(0.9, Math.max(0.5, 1 - 40 / pane.columns)),
    initial_command: `${shellQuote(process.execPath)} ${ownerArg}`,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  openPanel(process.env.CMUX_WORKSPACE_ID ?? '', process.argv[2] ?? process.env.CMUX_SURFACE_ID ?? '')
    .then(panel => process.stdout.write(`Opened conversation panel: ${String(panel.surface_ref ?? panel.surface_id)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
