export const maxRetries = 5

export interface Failure {
  message: string
  status?: number
  streamError?: { code?: string, message?: string }
}

const terminal = /context_length_exceeded|context[_ ]window[_ ]exceeded|maximum context length|insufficient_quota|quota exceeded|usage_limit_reached|usage_not_included|you(?:'ve| have) (?:hit|exceeded).*usage limit|budget (?:exceeded|exhausted)|invalid[_ ](?:request|api[_ ]key|image)|incorrect api key|refresh token.*(?:expired|revoked)|server_is_overloaded|slow_down|overloaded_error|model is at capacity|cyber_policy|misalignment_policy_violation|retry limit (?:reached|exceeded)|turn aborted|interrupted \(Ctrl-C\)|fatal error/iu
const transient = /stream (?:error|disconnected|closed|ended)|error while reading the server response|response stream|connection (?:error|failed|lost|refused|reset)|network error|fetch failed|socket|websocket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? out|timeout|terminated|internal server error|internal error; agent loop died|currently experiencing high demand|unexpected (?:HTTP )?status|rate[_ ]limit[_ ]exceeded/iu

export function classifyFailure(failure: Failure): { connection: boolean, delayMs?: number } | undefined {
  const { message, streamError } = failure
  const text = `${streamError?.code ?? ''} ${streamError?.message ?? ''} ${message}`
  const statusMatch = /^(?:HTTP(?: error)?\s+|unexpected (?:HTTP )?status\s+)?([45]\d{2})\b/iu.exec(message)
    ?? /^[^\n]+ API error \(([45]\d{2})\):/iu.exec(message)
  const status = failure.status ?? Number(statusMatch?.[1])
  if (status === 400 || status === 429 || terminal.test(text))
    return undefined

  // Only Codex's explicit HTTP connection category warrants an unlimited wait.
  const connection = !streamError && !status && /^Connection failed:/iu.test(message)
  if (!connection && !streamError && !(status >= 400 && status <= 599) && !transient.test(message))
    return undefined

  const rateLimited = streamError?.code === 'rate_limit_exceeded'
    || (!streamError && /rate[_ ]limit[_ ]exceeded/iu.test(message))
  const advice = rateLimited ? /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms)/iu.exec(streamError?.message ?? message) : null
  const delayMs = advice ? Number(advice[1]) * (advice[2].toLowerCase() === 'ms' ? 1 : 1000) : undefined
  return {
    connection,
    ...(delayMs !== undefined && Number.isSafeInteger(Math.trunc(delayMs)) ? { delayMs: Math.trunc(delayMs) } : {}),
  }
}

export function retryDelay(attempt: number): number {
  return Math.floor(200 * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2))
}

export function streamFailure(data: unknown): Failure['streamError'] {
  if (!data || typeof data !== 'object' || !('type' in data))
    return undefined
  if (data.type !== 'response.failed' && data.type !== 'response.incomplete' && data.type !== 'error')
    return undefined
  const response = 'response' in data && data.response && typeof data.response === 'object' ? data.response : data
  const error = 'error' in response && response.error && typeof response.error === 'object' ? response.error : response
  return {
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...('message' in error && typeof error.message === 'string' ? { message: error.message } : {}),
  }
}
