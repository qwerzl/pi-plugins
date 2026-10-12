# @qwerzl/pi-codex-retry

Retry failed model responses with the outer sampling policy from Codex CLI 0.154.0. A sampling request is one model response, including retries before that response succeeds.

This package handles errors such as:

```text
stream error: stream disconnected before completion: stream closed before response.completed
```

It uses Pi's public extension events. It does not replace providers, patch Pi internals, or insert hidden “continue” messages. It works alongside CodexCont.

## Setup

Use Pi 1.1.0 or later. Install from the repository root:

```sh
pi install ./packages/codex-retry
```

In `~/.pi/agent/settings.json`, merge these values into the existing configuration:

```json
{
  "retry": {
    "enabled": false,
    "provider": { "maxRetries": 0 }
  }
}
```

Restart Pi or run `/reload`. Project configuration overrides personal configuration, so `.pi/settings.json` must not re-enable native retries.

The package stays inactive unless both native retry layers are disabled. It shows a warning in modes with a UI. This prevents two retry loops from multiplying requests. To remove the package, also restore `retry.enabled` to `true`.

Disabling native retries also disables Pi's native retry policy for compaction and summaries. This package retries ordinary agent responses only. SDK hosts must set the same values in their `SettingsManager`.

## Behavior

| Failure | Action |
| --- | --- |
| Stream disconnect, timeout, generic network failure | Five retries, then preserve the last error |
| Explicit `Connection failed:` error, without an HTTP response or stream error | Retry until success or cancellation, except on Bedrock |
| HTTP 400 or 429 | Stop |
| Context, quota, usage, invalid request, policy, or recognized overload error | Stop |
| Other observed HTTP 4xx or 5xx | Use the bounded retry policy |
| Structured stream error with `rate_limit_exceeded` | Use the bounded policy and its `try again in …` delay |
| Unknown text-only error | Stop rather than guess |
| Success, empty response, output limit, or user cancellation | Do not start a retry |

Ordinary delays are 200, 400, 800, 1600, and 3200 milliseconds, with independent ±10% jitter. Jitter varies each delay randomly. A stream rate-limit delay replaces that schedule without jitter. HTTP `Retry-After` headers do not change the schedule, matching the pinned Codex version.

Explicit connection failures use 5, 10, 20, 40, then 60 seconds repeatedly, without jitter. Generic `Connection error.` and `fetch failed` messages remain bounded. Pi does not expose enough information to classify them as Codex's HTTP connection category.

The two counters remain independent. A successful response resets both counters before the next model request. Partial text does not reset either counter. The status displays `Reconnecting... n/5` or `Reconnecting... waiting for network`. Escape cancels the active wait.

Failed attempts remain in the raw session history. A persisted context edit excludes each retried failure from the next model request. Previously completed tool results remain in context. Pi does not execute tool calls from a failed partial response, and this package does not execute them itself.

## Compatibility limits

This package reproduces the exposed outer retry policy, not the entire Codex transport:

- No additional HTTP-request retry layer, WebSocket reconnection, HTTPS fallback, or authentication recovery. Those belong to Pi's provider implementation.
- No Codex checkpointing of completed output items within a failed stream. Pi discards that failed assistant message from model context as a unit.
- No retry of successful or output-limited responses, even when their provider event is `response.incomplete`. No compaction or summary retries.
- Pi often reduces typed provider errors to text. The package uses response status and structured stream errors when available, then recognized message text. Unclassified failures stop.
- Pi does not expose Codex's internal-session identity. Every session that loads this package receives the same policy, including SDK sessions and subagents. Do not load it in a child that must avoid unlimited connection waits.
- All retry status updates are visible. Pi does not expose the active transport needed to hide Codex's first WebSocket retry notification.
- This package does not configure transport timeouts or read `~/.codex/config.toml`. It pins the default five-retry sampling budget rather than exposing extra configuration.

Retries resend context and can incur provider charges. They do not guarantee exactly-once tool side effects if the model independently repeats an action. Other extensions that retry or continue failures can conflict with this package.

## Source reference and tests

The reference is OpenAI Codex tag [`rust-v0.154.0`](https://github.com/openai/codex/tree/rust-v0.154.0), commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. These upstream files define the policy:

- [`responses_retry.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/responses_retry.rs#L58-L135): independent connection and stream budgets, delays, and status text.
- [`turn.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/turn.rs#L1416-L1520): counter lifetime and retry input.
- [`util.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/util.rs#L86-L91): exponential delay and jitter.
- [`api_bridge.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/codex-api/src/api_bridge.rs#L21-L204): HTTP and stream error categories.
- [`responses.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/codex-api/src/sse/responses.rs#L685-L748): stream rate-limit delay parsing.

Run the offline tests from the repository root:

```sh
pnpm --filter @qwerzl/pi-codex-retry test
```

Tests use the real Pi `AgentSession` with a scripted provider and fake timers. They cover the screenshot error, exact attempt budgets, cancellation, delays, structured errors, native retry exclusion, tool history, and new input during a wait.
