# @qwerzl/pi-auto-title

Short, AI-generated pi session names that follow the conversation:

- `🏷️ Auto titles`
- `🔐 Fix login`
- `🧪 Add tests`

## Enable

From this repository after installing its dependencies:

```sh
pi install ./packages/auto-title
```

Restart pi. The local installation loads this checkout directly, so keep it and its dependencies in place. Use `pi remove ./packages/auto-title` from the repo root to disable it for future sessions.

## Behavior

After a successful completed reply, the extension asks the active model for one emoji plus 2–5 simple words. Titles are capped at 40 grapheme clusters, terminal control sequences are stripped, and a missing emoji gets a `💬` prefix.

The current title and at most four recent user/assistant text messages (1,200 characters each) are sent to the same model/provider already selected for the conversation. Tool results, thinking blocks and images are excluded. The model is told to keep the existing title unless the topic clearly changes; identical titles are not written again. Topic-change judgment is model-dependent.

The session name is persisted through pi's normal API for `/resume`. The terminal receives just the short emoji title, without pi's usual `π - … - Projects` wrapper; this also lets the cmux Projects sidebar display it rather than falling back to the latest prompt. No separate shell hook is required. Existing unnamed sessions get a title after their next successful reply. Generated names keep updating after resume/reload.

A manual `/name` takes precedence, including if you rename while a request is in flight. A new reply or session shutdown cancels stale title requests. Failures and the 15-second timeout leave the existing title alone. Print/headless runs and aborted or failed replies do not trigger naming.

## Cost and privacy

Each eligible completed reply makes **one extra background request**, capped at 64 output tokens with no requested thinking and no tools. This does not add messages to the main conversation or change its model/settings. Normal provider billing applies; the extra request's usage is **not added to pi's main conversation token totals**.

Names are visible in terminal tabs and session lists. Although the model is instructed not to include secrets or personal information, that is not a redaction guarantee. Assign a manual generic name before discussing sensitive material if it must not influence the title.

## Checks

```sh
pnpm --filter @qwerzl/pi-auto-title test
pnpm --filter @qwerzl/pi-auto-title run typecheck
pnpm --filter @qwerzl/pi-auto-title run effect:check
```
