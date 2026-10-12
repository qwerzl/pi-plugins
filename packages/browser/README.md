# Personal browser tools for Pi

Control Chrome using a **pinned private copy of Codex's actual browser runtime**. No Codex model request is made. Also control cmux's embedded browser through its regular CLI.

## What is pinned

The one-time setup copies the complete `cua_node` directory, including Node, `node_repl`, `@oai/cua-repl`, `@oai/cua`, `@oai/browser-desktop`, dependencies, and bundled notices. Pi launches that copy. It does not read the app's MCP manifest or follow `latest` to select its runtime on startup.

Default location: `~/.pi/agent/browser-runtime` (or `$PI_CODING_AGENT_DIR/browser-runtime`). Setup never overwrites an existing copy. Original launch/plugin manifests are retained as provenance, not executed. `runtime.json` records the copied version, platform, and architecture.

**Still shared:** the installed Codex Chrome extension, its native messaging host, and `~/.codex` browser configuration/permission state. App updates cannot replace the pinned runtime, but a change to the extension/native-host protocol can still break compatibility. This is not a replacement Chrome extension. Codex's app-embedded browser (`iab`) is not exposed.

## Setup

Requires macOS, a working Codex Chrome extension connection, Node.js 22.19+, and this workspace's dependencies. Copy from an explicitly chosen installed version:

```sh
pnpm --filter @qwerzl/pi-browser setup \
  ~/.codex/plugins/cache/openai-bundled/unified-computer-use/26.1007.21159/.mcp.json
pi install ./packages/browser
```

Use the version actually installed on your machine. The pinned runtime is platform/architecture-specific. Do not copy credentials or your Chrome profile into the runtime directory. Restart Pi or run `/reload` after installation.

The package is private. The adapter source is MIT; OpenAI's copied runtime retains its own terms and is **not included in this repository or npm package**. This setup is for the owner's personal local copy, not a grant of public redistribution rights.

## Tools

- **`browser_js`**: persistent JavaScript using the runtime's initialized `cua` API. Returns its documentation, page text, and screenshot images directly to Pi. Prefer this for Chrome tasks. No native desktop APIs are enabled.
- **`browser_reset`**: stops the runtime and clears JavaScript bindings. The next call starts a fresh process. Use after a runtime disconnect, not to circumvent a denied permission.
- **`cmux_browser`**: opens a pane, navigates, snapshots, clicks, fills, presses keys, scrolls, evaluates page JavaScript, and captures screenshots inside cmux. Requires Pi to be running inside cmux. `help` shows the CLI argument syntax. It can close only panes it opened in this extension session.

For example, ask Pi:

- “Open example.com in Chrome, read the page, and show me a screenshot.”
- “Open the local app in the cmux browser and check the login form.”

For the first Chrome call, the model starts with one documented entry point, such as:

```js
const tab = await cua.createBrowserTab('chrome', 'https://example.com', {
  sessionName: '🔎 Check page',
})
```

Later calls can use `await tab.getAXState()` and `await tab.getScreenshot()`. Full API documentation comes from the pinned runtime, not a separately maintained clone.

## Permissions and lifecycle

Origin/action approval requests are shown in Pi with the action, origin, persistence, sensitive-action flag, and parameters. **Deny is the first option.** There is no automatic allowlist. Unknown/non-empty forms, URL approval flows, and requests without an interactive UI are cancelled. RPC mode supports these dialogs if its client handles Pi extension UI requests.

The Chrome runtime gets a fresh Pi-owned session ID and one turn ID per browser-using user interaction. It never borrows an active Codex conversation ID. Calls are serialized. Once Pi finally settles (including abort), it sends the runtime's `turn_ended` notification. Session replacement, tree navigation, reload, reset, and orderly shutdown release the old process. Cleanup failures are reported and block further execution until reset. Reset waits for process shutdown before allowing another runtime to start. If only turn cleanup fails, reset succeeds with a warning that tabs may remain open. If process shutdown fails, Pi reports an error and retains the session only for a shutdown retry. Execution stays blocked, including after a conversation change, until an explicit reset succeeds. A crashed runtime is not silently retried with stale JavaScript bindings.

The runtime normally closes unmarked agent-created Chrome tabs when a turn ends. The model must mark a deliverable with `tab.markDeliverable()` or an unfinished page with `tab.markHandoff()` before asking the user to act. Marks are turn-scoped. Marked tabs and user tabs may remain open after shutdown. A forced process kill cannot guarantee cleanup.

cmux panes are different: the model must explicitly close its temporary pane, or leave it open when requested. Reloading loses the tool's in-memory ownership list; existing panes are left alone. This package uses the regular cmux CLI because cmux 0.65.0's built-in REPL MCP lists tools but fails execution when `browser-repl/manifest.json` is absent. It does not patch cmux or invoke desktop Computer Use.

## Validation

```sh
pnpm --filter @qwerzl/pi-browser test
pnpm --filter @qwerzl/pi-browser typecheck
pnpm --filter @qwerzl/pi-browser effect:check
```

Tests use fake runtime files and mocked MCP/CLI clients. They do not browse or change Chrome permissions. They cover copying and relocation, update/overwrite protection, approval denial/cancellation, session/turn identity, serialization, cleanup, screenshot forwarding, and cmux ownership.

To upgrade deliberately, stop Pi browser use, preserve the old runtime directory as a backup, and run setup against the new explicit version. Setup also accepts a destination as its second argument for inspecting a candidate copy; normal Pi use always loads the default location. Never replace a running runtime or edit vendor files to disable approval checks.
