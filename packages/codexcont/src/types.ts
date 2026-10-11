import type { Api, AssistantMessageEvent, Message, Model } from '@earendil-works/pi-ai'

export interface FoldContext {
  messages: Message[]
}

export interface FoldOutput {
  push: (event: AssistantMessageEvent) => void
  end: () => void
}

export type FoldModel = Pick<Model<Api>, 'api' | 'provider' | 'id'>
export type ThinkingEvent = Extract<AssistantMessageEvent, { type: 'thinking_start' | 'thinking_delta' | 'thinking_end' }>
export type TerminalEvent = Extract<AssistantMessageEvent, { type: 'done' | 'error' }>
