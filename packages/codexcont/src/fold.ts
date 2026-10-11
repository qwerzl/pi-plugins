import type { AssistantMessage, AssistantMessageEvent, Message, Usage } from '@earendil-works/pi-ai'
import type { FoldContext, FoldModel, FoldOutput, TerminalEvent, ThinkingEvent } from './types.ts'
import { Effect } from 'effect'
import { CONTINUATION_MARKER, MAX_CONTINUATIONS, MAX_TIER, TRUNCATION_STEP } from './constants.ts'
import { StreamFailure } from './errors.ts'

/** CodexCont's observed fingerprint is a heuristic, not a documented provider guarantee. */
export function truncationTier(reasoning = 0): number {
  const tier = (reasoning + 2) / TRUNCATION_STEP
  return Number.isInteger(tier) && tier >= 1 && tier <= MAX_TIER ? tier : 0
}

function hasEncrypted(block: AssistantMessage['content'][number]): boolean {
  if (block.type !== 'thinking' || !block.thinkingSignature)
    return false
  try {
    const item: unknown = JSON.parse(block.thinkingSignature)
    return typeof item === 'object' && item !== null
      && 'encrypted_content' in item
      && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
  }
  catch {
    return false
  }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function addUsage(total: Usage, usage: Usage): void {
  // Keep the last round's input estimate, but charge every round's output and cost.
  total.input = usage.input
  total.cacheRead = usage.cacheRead
  total.cacheWrite = usage.cacheWrite
  total.output += usage.output
  if (usage.reasoning !== undefined)
    total.reasoning = (total.reasoning ?? 0) + usage.reasoning
  total.totalTokens = total.input + total.cacheRead + total.cacheWrite + total.output
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
    total.cost[key] += usage.cost[key]
}

function flushOutput(message: AssistantMessage, final: AssistantMessage, out: FoldOutput): void {
  for (const block of message.content) {
    if (block.type === 'thinking')
      continue
    const contentIndex = final.content.length
    if (block.type === 'text') {
      const text = { ...block, text: '' }
      final.content.push(text)
      out.push({ type: 'text_start', contentIndex, partial: final })
      text.text = block.text
      out.push({ type: 'text_delta', contentIndex, delta: block.text, partial: final })
      out.push({ type: 'text_end', contentIndex, content: block.text, partial: final })
    }
    else {
      const toolCall = { ...block, arguments: {} }
      final.content.push(toolCall)
      out.push({ type: 'toolcall_start', contentIndex, partial: final })
      toolCall.arguments = block.arguments
      out.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial: final })
      out.push({ type: 'toolcall_end', contentIndex, toolCall, partial: final })
    }
  }
}

function forwardThinking(event: ThinkingEvent, final: AssistantMessage, out: FoldOutput, indices: Map<number, number>): void {
  if (event.type === 'thinking_start')
    indices.set(event.contentIndex, final.content.push(event.partial.content[event.contentIndex]) - 1)
  const contentIndex = indices.get(event.contentIndex)
  if (contentIndex === undefined)
    throw new Error('CodexCont: thinking event without a start')
  final.content[contentIndex] = event.partial.content[event.contentIndex]
  out.push({ ...event, contentIndex, partial: final })
}

async function readRound(
  stream: AsyncIterable<AssistantMessageEvent>,
  final: AssistantMessage,
  out: FoldOutput,
  forwardStart: boolean,
): Promise<TerminalEvent> {
  const indices = new Map<number, number>()
  for await (const event of stream) {
    switch (event.type) {
      case 'start':
        if (forwardStart)
          out.push({ type: 'start', partial: final })
        break
      case 'done':
      case 'error': {
        const message = event.type === 'done' ? event.message : event.error
        for (const [input, output] of indices)
          final.content[output] = message.content[input]
        return event
      }
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end':
        forwardThinking(event, final, out, indices)
        break
    }
  }
  throw new Error('CodexCont: inner stream ended without a terminal event')
}

/** Fold hidden continuation rounds into one pi stream, retaining only the final round's actions. */
export function fold<C extends FoldContext>(
  inner: (context: C, signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>,
  model: FoldModel,
  context: C,
  out: FoldOutput,
  signal?: AbortSignal,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const final: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: 'pending',
      timestamp: Date.now(),
    }
    const extra: Message[] = []
    return Effect.tryPromise({
      try: async (effectSignal) => {
        const requestSignal = signal ? AbortSignal.any([signal, effectSignal]) : effectSignal
        for (let round = 0; ; round++) {
          requestSignal.throwIfAborted()
          const terminal = await readRound(
            inner({ ...context, messages: [...context.messages, ...extra] }, requestSignal),
            final,
            out,
            round === 0,
          )
          const message = terminal.type === 'done' ? terminal.message : terminal.error
          addUsage(final.usage, message.usage)
          requestSignal.throwIfAborted()

          const thinking = message.content.filter(block => block.type === 'thinking')
          if (terminal.type === 'done' && round < MAX_CONTINUATIONS
            && truncationTier(message.usage.reasoning) && thinking.some(hasEncrypted)) {
            extra.push({
              role: 'assistant',
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [
                ...thinking,
                { type: 'text', text: CONTINUATION_MARKER, textSignature: JSON.stringify({ v: 1, id: `msg_codexcont_${round}`, phase: 'commentary' }) },
              ],
              usage: zeroUsage(),
              stopReason: 'stop',
              timestamp: Date.now(),
            })
            continue
          }

          if (terminal.type === 'done')
            flushOutput(message, final, out)
          Object.assign(final, { ...message, content: final.content, usage: final.usage, timestamp: final.timestamp })
          out.push(terminal.type === 'done'
            ? { type: 'done', reason: terminal.reason, message: final }
            : { type: 'error', reason: terminal.reason, error: final })
          return
        }
      },
      catch: cause => new StreamFailure({ cause }),
    }).pipe(
      Effect.catch(error => Effect.sync(() => {
        final.stopReason = signal?.aborted ? 'aborted' : 'error'
        final.errorMessage = error.cause instanceof Error ? error.cause.message : String(error.cause)
        out.push({ type: 'error', reason: final.stopReason, error: final })
      })),
      Effect.ensuring(Effect.sync(() => out.end())),
    )
  })
}
