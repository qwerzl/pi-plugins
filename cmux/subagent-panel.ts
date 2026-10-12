import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { getMarkdownTheme, initTheme } from '@earendil-works/pi-coding-agent'
import { Markdown, matchesKey, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack } from '@earendil-works/pi-tui'

function plain(value: string): string {
  return stripVTControlCharacters(value).replaceAll(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : ' ')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function formatToolResult(text: string, isError: boolean, expandTools: boolean): string[] {
  const summary = `> ${isError ? '✗ Failed' : '✓ Done'}${text ? ` · ${text.length} characters` : ''}${text && !expandTools ? ' · e to show output' : ''}`
  if (!text || !expandTools)
    return [summary]
  const output = text.slice(0, 4000).split('\n').map(line => `    ${line}`).join('\n')
  return [summary, `\n${output}${text.length > 4000 ? '\n\n> … output shortened' : ''}`]
}

function formatEntry(value: unknown, expandTools: boolean): string[] {
  if (!record(value) || !record(value.message))
    return []
  const blocks = typeof value.message.content === 'string'
    ? [{ type: 'text', text: value.message.content }]
    : Array.isArray(value.message.content) ? value.message.content : []
  const text = blocks.filter((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block: { text: string }) => plain(block.text))
    .join('\n')
    .trim()
  if (value.type === 'user')
    return text ? [`**You**\n\n${text}`] : []
  if (value.type === 'toolResult')
    return formatToolResult(text, value.message.isError === true, expandTools)
  if (value.type !== 'assistant')
    return []
  return [
    ...(text ? [`**Agent**\n\n${text}`] : []),
    ...blocks.filter((block: unknown) => record(block) && block.type === 'toolCall' && typeof block.name === 'string')
      .map((block: { name: string, arguments?: unknown }) => {
        const args = record(block.arguments) ? block.arguments : {}
        const detail = typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command : ''
        return `> ↳ ${plain(block.name)}${detail ? ` · ${plain(detail).slice(0, 100)}` : ''}`
      }),
  ]
}

export function agentConversation(jsonl: string, expandTools = false): string {
  const rows = jsonl.split('\n').flatMap((line) => {
    if (!line.trim())
      return []
    try {
      return formatEntry(JSON.parse(line), expandTools)
    }
    catch {
      // A writer may be appending its next record.
      return []
    }
  })
  return rows.join('\n\n') || 'Waiting for subagent transcript…'
}

function run(file: string, title: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(agentConversation(readFileSync(file, 'utf8')))
    return
  }
  initTheme()
  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  const body = new Markdown('Waiting for subagent transcript…', 1, 1, getMarkdownTheme())
  const scroll = new ScrollView(body, { primary: true, follow: 'end', scrollbar: 'auto' })
  tui.setLayoutRoot(new VStack([
    new Text(`\u001B[36m● ${plain(title)}\u001B[39m`, 1, 0),
    { component: scroll, grow: 1, basis: 0 },
    new Text('↑↓ scroll · e tool output · q close', 1, 0),
  ]))
  let transcript = ''
  let expandTools = false
  const refresh = (): void => {
    try {
      transcript = readFileSync(file, 'utf8')
      body.setText(agentConversation(transcript, expandTools))
    }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        body.setText('Waiting for transcript, or transcript recording is disabled.')
      else
        body.setText(`Cannot read transcript: ${plain(String(error))}`)
    }
    tui.requestRender()
  }
  const stop = (): void => {
    unwatchFile(file, refresh)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop)
    tui.stop()
    process.exit(0)
  }
  tui.addInputListener((data) => {
    if (matchesKey(data, 'q') || matchesKey(data, 'ctrl+c')) {
      stop()
      return { consume: true }
    }
    if (matchesKey(data, 'e')) {
      expandTools = !expandTools
      body.setText(agentConversation(transcript, expandTools))
      tui.requestRender()
      return { consume: true }
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop)
  tui.start()
  terminal.setTitle(plain(title))
  watchFile(file, { interval: 500 }, refresh)
  refresh()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error('Usage: node cmux/subagent-panel.ts /absolute/path/to/agent.output [title]')
  run(resolve(process.argv[2]), process.argv[3] ?? 'Subagent')
}
