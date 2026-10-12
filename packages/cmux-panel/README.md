# Pi cmux panel bridge

This extension moves the main todo widget, pi-lens diagnostic widget, and custom footer into a [narrow plan panel beside the conversation](../../cmux/README.md#live-plan-panel-right-side), not the shared cmux sidebar or Dock. It uses the existing footer output rather than calculating statistics again. Task tools, saved tasks, permission dialogs, and the input box remain unchanged.

## Install

Run `pnpm install` from the repository root first. Add the absolute path to this package as the first entry in `packages` in `~/.pi/agent/settings.json`. Keep the other package entries. Then run `/reload` in Pi.

The bridge must load before `@juicesharp/rpiv-todo`, `pi-lens`, and `pi-cc-extensions`. Explicit `--extension` arguments load before packages and can change that order. The bridge runs only in interactive cmux sessions with a saved session file and automatically opens one attached panel per conversation terminal. Reload each already-running Pi conversation once to activate it. A missing cmux surface ID leaves the main displays in place; an opening failure shows a warning and does not block Pi startup.

## Display routing

The viewer and extension exchange private files under `~/.pi/agent/cache/cmux-panel/`. `PI_CODING_AGENT_DIR` changes the base directory. Each session path gets separate files. The attached viewer follows its source terminal, even when another workspace or terminal has focus. When that terminal changes sessions, the viewer releases the previous reader so its main displays return. Active top-level subagents get separate cmux panes beneath the Plan pane; those panes close when the agents finish. The legacy `--follow` mode still follows the selected workspace.

The extension keeps the original components and their cleanup methods. It hides a main component only after the viewer acknowledges a fresh statistics update. If the viewer closes, its heartbeat expires, or publishing fails, the main displays return. These files contain styled display text, not conversation transcripts.

The bridge uses the shared UI context in Pi 1.1.0 to wrap `setWidget` and `setFooter`. It targets only `rpiv-todos`, `pi-lens`, and custom footers. A built-in footer remains visible when no custom footer is registered. Extension or Pi updates that change these contracts need another integration test.

The source footer renders at a wide width to retain its status fields. The viewer splits the existing ` · ` separators into tree rows and wraps long text. It preserves the original footer and diagnostic colors and text styles. Each row resets its style so colors do not spread to tree branches or later sections. The viewer removes terminal control commands, including clipboard and cursor commands. Unknown footer formats remain unsplit rows. Shutdown and `/reload` restore the original UI methods.

After updating the bridge, run `/reload` in each Pi conversation. Existing viewers stay open; the extension opens missing panels without duplicating them.

## Test

Unit tests cover reader acknowledgement, expiry, write failures, unrelated widgets, component cleanup, file permissions, and separate sessions. The viewer tests cover tree formatting, active branches, subagent event routing, transcript sanitization, and native pane lifecycles. A real Pi terminal test also covers the installed todo and footer extensions, `/reload`, and restoration after viewer exit.

```sh
pnpm --filter @qwerzl/pi-cmux-panel test
pnpm exec vitest run scripts/cmux-todo-panel.test.ts
```
