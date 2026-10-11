# @qwerzl/pi-codexcont

An in-process pi provider extension adapted from [CodexCont](https://github.com/neteroster/CodexCont). Written in TypeScript with Effect; no Python, proxy server, listening port, or background service.

## Compatibility and setup

Tested against **@earendil-works/pi 1.1.0** provider APIs. This package uses `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`, not the older `@mariozechner` package family.

It wraps existing providers whose models use **`openai-responses`**, preserving their models, endpoint and authentication. It does not add credentials or configure a new upstream. Other APIs, including Anthropic and the separate `openai-codex-responses` transport, are not wrapped.

The default provider ID is `cpa`, matching the original local setup. Configure a different provider ID from your `models.json` before starting pi:

```sh
CODEXCONT_PROVIDERS=my-responses-provider pi
# Multiple provider IDs:
CODEXCONT_PROVIDERS=cpa,other-provider pi
```

Thinking must be enabled for folding. With thinking disabled, the built-in stream is used unchanged.

From the repository root:

```sh
pnpm install
pi --no-extensions -e ./packages/codexcont
```

For persistent installation, disable any previous CodexCont copy first, then run `pi install ./packages/codexcont`. Restart pi or use `/reload` after changing the loaded source. Removing the package via `pi remove ./packages/codexcont` stops this override on the next reload.

## Behavior

1. Forward reasoning-summary events as they arrive.
2. Hold back tentative text and tool calls until the round terminates.
3. If reasoning usage matches `518 × n − 2`, with `1 ≤ n ≤ 6`, and encrypted reasoning is present, discard the tentative actions and append the reasoning plus a hidden commentary message: `Continue thinking...`.
4. Stop after at most three extra rounds, or when the fingerprint/encryption is absent. Release only the final successful round's text and tool calls.
5. Emit one combined assistant result. Effect closes the output stream on completion or failure; the request abort signal is propagated to the provider.

Input/cache token fields use the latest round. Output, reasoning usage and cost are accumulated across rounds. These token fields are not a complete billed-input ledger; use upstream billing for actual charges.

## Tests

```sh
pnpm --filter @qwerzl/pi-codexcont test
pnpm --filter @qwerzl/pi-codexcont typecheck
```

Tests cover fingerprints and caps, normal/empty/Unicode output, discarded drafts and tool calls, encrypted reasoning checks, usage, provider failures, missing terminal events, cancellation, and real pi Responses parsing with mocked HTTP. No live credentials or API calls are needed.

## Risks and limits

- The fingerprint is an upstream project's **heuristic**, not a documented guarantee that reasoning was truncated. Matching counts can be coincidental, and the behavior may change.
- Continuations can increase token costs and latency, and may conflict with the upstream provider's service terms. The user is responsible for checking those terms.
- Answer text is buffered rather than streamed token by token. Thinking summaries still stream.
- A relay must preserve encrypted reasoning for continuation to work.
- This is a focused port of commentary-mode folding, not full parity with the Python proxy. It has no tool-pair mode, stateful repair, proxy headers or heartbeat injection.
- Do not combine it with another extension overriding streaming for the same provider without checking compatibility.
- Offline tests do not prove that a live provider currently exhibits the fingerprint or accepts continuation. No live provider behavior is guaranteed.

Original project copyright: © 2026 neteroster, MIT; see [LICENSE](LICENSE).
