import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { registerCmux } from './cmux.ts'

function harness() {
  const registerTool = vi.fn()
  const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'OK surface=surface:42 pane=pane:2', stderr: '', killed: false })
  vi.stubEnv('CMUX_WORKSPACE_ID', 'workspace:1')
  registerCmux({ registerTool, exec })
  const execute = registerTool.mock.calls[0][0].execute
  return { exec, run: (args: Record<string, unknown>) => execute('test', args, new AbortController().signal) }
}
afterEach(() => vi.unstubAllEnvs())

it('requires cmux and explicit surfaces, and cannot close unrelated panes', async () => {
  const h = harness()
  await expect(h.run({ action: 'snapshot' })).rejects.toThrow('explicit')
  await expect(h.run({ action: 'close', surface: 'surface:99' })).rejects.toThrow('Only browser panes')
  await expect(h.run({ action: 'screenshot', surface: 'surface:42', args: ['--out', '/elsewhere'] })).rejects.toThrow('extra arguments')
  vi.stubEnv('CMUX_WORKSPACE_ID', '')
  await expect(h.run({ action: 'open' })).rejects.toThrow('inside cmux')
  expect(h.exec).not.toHaveBeenCalled()
})

it.each([
  { surface: 'surface:42', args: ['https://example.com'] },
  { args: ['--surface', 'surface:42', 'https://example.com'] },
  { args: ['--surface=surface:42'] },
  { args: ['https://example.com', '--workspace', 'workspace:2'] },
])('rejects open selectors and CLI options before execution: %j', async (args) => {
  const h = harness()
  await expect(h.run({ action: 'open', ...args })).rejects.toThrow('open creates a new pane')
  await expect(h.run({ action: 'close', surface: 'surface:42' })).rejects.toThrow('Only browser panes')
  expect(h.exec).not.toHaveBeenCalled()
})

it('passes argument arrays without a shell and tracks only panes it opens', async () => {
  const h = harness()
  await h.run({ action: 'open', args: ['https://example.com'] })
  await h.run({ action: 'fill', surface: 'surface:42', args: ['#input', '$(do-not-execute)'] })
  expect(h.exec).toHaveBeenLastCalledWith('cmux', ['browser', '--surface', 'surface:42', 'fill', '#input', '$(do-not-execute)'], expect.objectContaining({ timeout: 30000 }))
  await h.run({ action: 'close', surface: 'surface:42' })
  expect(h.exec).toHaveBeenLastCalledWith('cmux', ['close-surface', '--surface', 'surface:42'], expect.anything())
  await expect(h.run({ action: 'close', surface: 'surface:42' })).rejects.toThrow('Only browser panes')
})

it('returns screenshot bytes and removes its temporary file', async () => {
  const h = harness()
  let output = ''
  h.exec.mockImplementation(async (_command, args) => {
    output = args.at(-1)
    await writeFile(output, 'image bytes')
    return { code: 0, stdout: '', stderr: '', killed: false }
  })
  const result = await h.run({ action: 'screenshot', surface: 'surface:42' })
  expect(result.content).toEqual([{ type: 'image', data: Buffer.from('image bytes').toString('base64'), mimeType: 'image/png' }])
  await expect(readFile(output)).rejects.toThrow()
})

it('reports command failures rather than pretending the action succeeded', async () => {
  const h = harness()
  h.exec.mockResolvedValue({ code: 1, stdout: '', stderr: 'browser unavailable' })
  await expect(h.run({ action: 'open' })).rejects.toThrow('browser unavailable')
  h.exec.mockResolvedValue({ code: 0, stdout: 'OK but no surface', stderr: '' })
  await expect(h.run({ action: 'open' })).rejects.toThrow('did not return a browser surface')
})
