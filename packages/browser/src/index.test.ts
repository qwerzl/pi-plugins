import { expect, it, vi } from 'vitest'
import browser from './index.ts'

it('registers only native cmux control, without starting any browser process', () => {
  const registerTool = vi.fn()
  const exec = vi.fn()
  browser({ registerTool, exec })
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(['cmux_browser'])
  expect(exec).not.toHaveBeenCalled()
})
