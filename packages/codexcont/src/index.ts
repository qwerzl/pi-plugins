import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { createAssistantMessageEventStream, openAIResponsesApi } from '@earendil-works/pi-ai/compat'
import { Effect } from 'effect'
import { fold } from './fold.ts'

/** Providers (from models.json) whose openai-responses models get continue-thinking folding. */
export default function (pi: ExtensionAPI): void {
  const providers = new Set((process.env.CODEXCONT_PROVIDERS ?? 'cpa').split(',').map(id => id.trim()).filter(Boolean))
  const api = openAIResponsesApi()
  for (const id of providers) {
    pi.registerProvider(id, {
      api: 'openai-responses',
      streamSimple: (model, context, options) => {
        if (!options?.reasoning || !model.reasoning)
          return api.streamSimple(model, context, options)
        const out = createAssistantMessageEventStream()
        void Effect.runPromise(fold(
          (ctx, signal) => api.streamSimple(model, ctx, { ...options, signal }),
          model,
          context,
          out,
          options.signal,
        ))
        return out
      },
    })
  }
}
