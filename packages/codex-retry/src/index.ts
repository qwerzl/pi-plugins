import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Failure } from './policy.ts'
import { Effect, Exit } from 'effect'
import { classifyFailure, maxRetries, retryDelay, streamFailure } from './policy.ts'

const statusKey = 'codex-retry'

export default function codexRetry(pi: ExtensionAPI): void {
  let retries = 0
  let connectionDelay = 5000
  let status: number | undefined
  let streamError: Failure['streamError']
  let pending = false
  let wait: AbortController | undefined
  let warned = false

  function configured(ctx: ExtensionContext): boolean {
    const settings = pi.getSettings().retry
    const ready = settings?.enabled === false && (settings.provider?.maxRetries ?? 0) === 0
    if (!ready && !warned) {
      ctx.ui.notify('Codex retry is inactive: set retry.enabled=false and retry.provider.maxRetries=0 to avoid stacked retries.', 'warning')
      warned = true
    }
    return ready
  }

  function reset(_event: unknown, ctx: ExtensionContext): void {
    wait?.abort()
    wait = undefined
    retries = 0
    connectionDelay = 5000
    status = undefined
    streamError = undefined
    pending = false
    ctx.ui.setStatus(statusKey, undefined)
  }

  pi.on('session_start', (event, ctx) => {
    reset(event, ctx)
    configured(ctx)
  })
  pi.on('session_shutdown', reset)
  pi.on('before_agent_start', reset)
  pi.on('agent_settled', reset)
  pi.on('turn_start', () => {
    status = undefined
    streamError = undefined
    pending = false
  })
  pi.on('before_provider_request', () => {
    status = undefined
    streamError = undefined
  })
  pi.on('after_provider_response', (event) => {
    status = event.status
  })
  pi.on('provider_stream_event', (event) => {
    streamError = streamFailure(event.data) ?? streamError
  })

  pi.on('turn_end', async (event, ctx) => {
    pending = false
    if (event.message.role !== 'assistant' || event.message.stopReason !== 'error') {
      retries = 0
      connectionDelay = 5000
      return
    }
    const signal = ctx.signal
    if (!configured(ctx) || !signal || signal.aborted || event.context.pendingMessages.length || event.continue)
      return
    const failure = classifyFailure({ message: event.message.errorMessage ?? '', status, streamError })
    if (!failure)
      return
    const connection = failure.connection && ctx.model?.api !== 'bedrock-converse-stream'
    if (!connection && retries >= maxRetries)
      return

    const delay = connection ? connectionDelay : failure.delayMs ?? retryDelay(retries + 1)
    if (connection)
      connectionDelay = Math.min(connectionDelay * 2, 60_000)
    else
      retries++
    const controller = new AbortController()
    wait = controller
    const combined = AbortSignal.any([signal, controller.signal])
    ctx.ui.setStatus(statusKey, connection ? 'Reconnecting... waiting for network' : `Reconnecting... ${retries}/${maxRetries}`)
    // Pi drops the run signal before before_settle, so sleep at the cancellable turn boundary.
    const result = await Effect.runPromiseExit(Effect.gen(function* () {
      let remaining = delay
      while (remaining > 0) {
        const chunk = Math.min(remaining, 2_147_483_647)
        yield* Effect.sleep(chunk)
        remaining -= chunk
      }
    }), { signal: combined })
    ctx.ui.setStatus(statusKey, undefined)
    if (wait === controller)
      wait = undefined
    if (Exit.isFailure(result) || combined.aborted || ctx.hasPendingMessages())
      return
    pending = true
    return { entries: [...event.entries, { type: 'context_edit' as const, targetId: event.messageEntryId, replacement: null }] }
  })

  pi.on('agent_before_settle', (event, ctx) => {
    const retry = pending
    pending = false
    // Error turns ignore turn_end's continue result; continue only after Pi finishes recovery.
    if (retry && event.outcome === 'error' && event.context.canContinue && !event.context.pendingMessages.length && configured(ctx))
      return { continue: true }
  })
}
