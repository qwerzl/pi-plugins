import { stripVTControlCharacters } from 'node:util'
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent'
import { Markdown, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { agentConversation } from '../cmux/subagent-panel.ts'
import { agentOutputFile } from '../packages/cmux-panel/src/state.ts'

const id = '67d0c849-8a7f-4fd'
const parent = '12345678-1234-1234-1234-123456789abc'
const row = (type: string, content: unknown): string => JSON.stringify({ agentId: id, isSidechain: true, type, message: { content } })

describe('subagent transcript panel', () => {
  it('shows the conversation and tool activity without dumping private thinking', () => {
    const transcript = [
      row('user', 'Research the problem'),
      row('assistant', [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'I found the source.' },
        { type: 'toolCall', name: 'read', arguments: { path: 'secret.txt' } },
      ]),
      row('toolResult', [{ type: 'text', text: 'File contents' }]),
      '{"partial":',
    ].join('\n')
    const text = agentConversation(transcript)
    expect(text).toContain('**You**\n\nResearch the problem')
    expect(text).toContain('**Agent**\n\nI found the source.')
    expect(text).toContain('I found the source.')
    expect(text).toContain('↳ read · secret.txt')
    expect(text).toContain('✓ Done · 13 characters · e to show output')
    expect(text).not.toContain('File contents')
    expect(agentConversation(transcript, true)).toContain('    File contents')
    expect(text).not.toContain('private reasoning')
  })

  it('preserves Markdown and newlines while hiding terminal commands and large tool results', () => {
    const output = `\u001B]52;c;secret\u0007Safe\u001B[2J\u001B[31mred\u001B[39m\n\n\`\`\`ts\nconst ok = true\n\`\`\``
    const transcript = `${row('assistant', [{ type: 'text', text: output }])}\n${row('toolResult', 'x'.repeat(5000))}`
    const text = agentConversation(transcript)
    expect(text).toContain('Safered\n\n```ts\nconst ok = true\n```')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('\u001B[2J')
    expect(text).not.toContain('x'.repeat(100))
    const expanded = agentConversation(transcript, true)
    expect(expanded).toContain('x'.repeat(4000))
    expect(expanded).not.toContain('x'.repeat(5000))
    expect(expanded).toContain('… output shortened')
    initTheme()
    const lines = new Markdown(text, 1, 0, getMarkdownTheme()).render(50)
    expect(lines.every(line => visibleWidth(line) <= 50)).toBe(true)
    expect(lines.some(line => stripVTControlCharacters(line).includes('const ok = true'))).toBe(true)
  })

  it('derives an owner-scoped path and refuses traversal IDs', () => {
    const file = agentOutputFile('/Users/qwerzl/Documents/Projects/pi-plugins', parent, id)
    expect(file).toContain(`pi-subagents-${process.getuid?.() ?? 0}/Users-qwerzl-Documents-Projects-pi-plugins/${parent}/tasks/${id}.output`)
    expect(() => agentOutputFile('/projects/demo', parent, '../../secret')).toThrow('Invalid subagent')
    expect(() => agentOutputFile('/projects/demo', '../wrong', id)).toThrow('Invalid subagent')
  })
})
