# Browser tools for Pi

Two independent backends, with no OpenAI browser runtime or Chrome extension dependency:

- **Chrome:** [browser-harness](https://github.com/browser-use/browser-harness), installed separately. Its upstream MCP server exposes browser actions; the bundled skill also explains the Python CLI helpers.
- **cmux's embedded browser:** this package registers `cmux_browser` using the native cmux CLI. WebKit does not expose Chrome's CDP protocol, so browser-harness cannot control this pane.

## Setup

Install the tested browser-harness release with its MCP extra:

```sh
uv tool install --python 3.12 'browser-harness[mcp]==0.1.13'
pi install ./packages/browser
```

The configuration below uses [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter). If it is not installed, run `pi install npm:pi-mcp-adapter` first. Add this entry to `mcpServers` in `~/.pi/agent/mcp-adapter.json`, preserving other servers. The adapter expands the leading `~/`; adjust the executable path if uv uses another bin directory.

```json
{
  "browser-harness": {
    "command": "~/.local/bin/browser-harness-mcp",
    "description": "Control existing Chrome through browser-harness. Use cmux_browser for embedded WebKit.",
    "requestTimeoutMs": 120000
  }
}
```

In Chrome, open `chrome://inspect/#remote-debugging` and enable the checkbox. Approve incoming connection prompts yourself. The checkbox persists across Chrome restarts; it is not tied to a Pi conversation. Uncheck it to stop remote debugging.

Restart Pi or run `/reload` to load the MCP configuration, `cmux_browser`, and the bundled `browser-harness` skill. The package alone does not install Python or configure an MCP server.

The skill is generated from browser-harness 0.1.13 with local changes for Pi routing, manual permissions, tab ownership, and explicit cloud approval. Its upstream MIT notice is retained alongside it. Review those changes when regenerating it.

## Use

Ask Pi to open a page in Chrome or in cmux. For Chrome, discover the `browser-harness` MCP tools and read their schemas. The CLI is also available:

```sh
browser-harness <<'PY'
target = new_tab()
try:
    goto_url('https://example.com')
    wait_for_load()
    print(page_info())
finally:
    close_tab(target)
PY
```

Create the blank tab explicitly: in 0.1.13, `new_tab(url)` can reuse a user's existing blank tab. Retain the exact target ID and close only tabs created for the task.

`cmux_browser` supports open, navigate, snapshot, click, fill, press, scroll, get, wait, eval, screenshot, help, and close. It requires Pi inside cmux, explicit surface IDs for existing panes, and can close only surfaces it opened in that extension session. Open accepts one optional URL, with no surface or CLI options; use navigate for an existing pane. It returns screenshots as images. Reload loses the ownership list and leaves existing panes alone.

The cmux backend is the regular CLI, not its richer JavaScript REPL. This avoids the missing `browser-repl/manifest.json` in the installed cmux 0.65.0 build. It neither patches nor relaunches cmux.

## Permissions, recordings, and lifecycle

Chrome debugging access is **browser-wide**, including logged-in pages. It replaces the old per-origin Pi approval dialogs. The agent must still follow the user's task boundaries and treat page content as untrusted data. Native Chrome prompts are approved manually, not with `mac-approve`.

The browser-harness daemon persists independently of Pi and shares an attached tab across calls and sessions. Serialize local browser tasks. There is no automatic turn-end tab cleanup, per-conversation isolation, or daemon shutdown. Close owned temporary tabs explicitly. `browser-harness --reload` stops the daemon; the next browser call can start it again. To revoke debugging access, uncheck Chrome's setting.

Recordings are an explicit local preference, separate from connection approval:

```sh
browser-harness recordings         # inspect preference and active recording
browser-harness recordings enable # opt in
browser-harness recordings disable
browser-harness telemetry disable # optional telemetry opt-out
```

Recordings can contain sensitive page content. Keep them local unless the user requests sharing. Retain the exact directory returned by `start_recording()` and stop that recording after the task. Automatic browser-harness recording does not apply to cmux. Cloud browsers, billing, and profile uploads require separate approval; this setup uses local Chrome only.

## Migration and validation

If you tried the earlier pinned-runtime preview of this package, its OpenAI `browser_js` and `browser_reset` tools, runtime loader, and copy command are no longer used. An existing private `~/.pi/agent/browser-runtime` directory is left untouched as an inactive backup. No vendor files are loaded or redistributed. Codex's own configuration and extension are not modified.

```sh
pnpm --filter @qwerzl/pi-browser test
pnpm --filter @qwerzl/pi-browser typecheck
pnpm --filter @qwerzl/pi-browser effect:check
browser-harness doctor --json --require-existing-daemon
```

Offline tests cover cmux validation, argument handling, ownership, failures, screenshot forwarding, and the cmux-only entry point. Live Chrome and cmux checks require user-approved browser access; offline tests do not grant permissions or connect to a browser.
