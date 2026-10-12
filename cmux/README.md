# Project conversation sidebar

`projects.js` runs in the cmux sidebar. It shows conversations under project folders, with live status labels from cmux agent hooks. It does not change Pi or install another hook.

Existing cmux workspace groups supply the project names. Ungrouped workspaces use their working directory. Only the latest session in each terminal appears because older sessions no longer match that terminal.

Click a conversation to open its workspace and terminal. Click a folder to collapse it. Sessions within each project appear in order of latest activity, newest first. The order updates as cmux reports activity. Sessions without timestamps appear last, and ties keep their existing order.

Each folder shows its five newest rows and offers **Show more** for the rest. An older selected session stays in activity order rather than replacing a newer row. The sidebar also shows only five projects initially, with a separate **Show more** when there are additional projects. Project order stays unchanged.

Statuses distinguish Working, Needs you, Idle, Ended, Unknown, and Terminal. Idle and Ended do not mean that a task succeeded. cmux supplies these states, so their accuracy depends on its agent hooks.

A blue dot marks an unread update, including a turn-completion notification. It stays visible when the agent returns to Idle and disappears when cmux clears the unread state. It uses the terminal's native unread flag, so another terminal's notification does not mark every conversation. When terminal-level data is unavailable, only a single conversation or terminal-only row can use the workspace unread count. The dot means unread, not successful; questions and errors can also produce unread notifications. Hover over it for **Unread update**. The sidebar does not add timers, notifications, or its own read-state tracking.

Named workspaces keep their titles when they contain one conversation. Other rows use the agent title, then the latest prompt, then the terminal title. Hover over a row to see its full title and status. This sidebar does not generate summaries or browse archived Pi sessions.

Right-click a project folder to create a workspace, rename the project, or choose a color label. New workspaces open in that project and receive focus immediately. The folder icon shows the project color. **Ungroup (Keep Workspaces)** removes the group without closing its workspaces. For folders inferred from a working directory, choose **Save as Project…** first to enable persistent names and colors. This creates a cmux group from those workspaces. It does not rename the directory on disk.

Right-click a conversation to rename its workspace, reset its name, choose a color label, pin it, or change its read status. Workspace colors appear as small dots. These actions apply to the containing workspace, including when several conversations share it. Activity order stays unchanged when a workspace is pinned.

Choose **Close Workspace…** to remove a workspace. The sidebar asks for confirmation before closing all its terminals. Save any running work first. This action does not delete project files. Rename fields accept Enter to save and Escape to cancel. Blank names leave the current name unchanged.

## Install

From the repository root, run these commands. If `projects.js` already exists at the destination, back it up before copying.

```sh
mkdir -p ~/.config/cmux/sidebars
cp cmux/projects.js ~/.config/cmux/sidebars/projects.js
cmux sidebar validate projects
cmux sidebar select projects
```

Edit the repository copy, then copy it to the same destination again. cmux reloads the installed file when it changes. To switch back, right-click the sidebar toggle and choose another sidebar.

## Live plan panel (right side)

The plan panel sits directly to the right of its Pi conversation in a narrow terminal split, not the shared Dock. The installed Pi extension opens it automatically when an interactive conversation starts in cmux. It opens at about 40 columns wide. Drag the divider to resize it. The Projects sidebar stays on the left.

The panel follows its conversation, not the selected workspace or terminal. It is read-only and does not add a web server or model call. When a top-level Pi `Agent` subagent starts, cmux opens a separate pane below the Plan panel for its conversation. Each active subagent gets its own vertical pane. Its pane closes when that agent finishes or stops; the Plan panel stays open.

The panel uses a compact tree with `├─` and `└─` rows, task IDs, and status marks. It keeps tasks in their original order. Dependencies identify tasks that must finish before another task starts. The panel uses the Pi terminal UI toolkit to wrap text and handle scrolling and resizing.

The optional [`@qwerzl/pi-cmux-panel`](../packages/cmux-panel/README.md) extension moves the existing footer statistics and pi-lens diagnostic display into this tree. It keeps the existing calculations for model usage, speed, cost, Git, MCP, and extension status. While the panel reads these updates, the extension hides the main todo widget, diagnostic widget, and custom footer. Other widgets, tool output, and the input box stay unchanged.

If the panel closes or stops reading, those main displays return within four seconds. The extension does not edit installed dependencies. After installation, run `/reload` once in the main Pi session.

To use these controls, click the panel first:

- Press `c` to show or hide completed tasks.
- Press the arrow keys or use the mouse wheel to scroll.
- Press `q` to exit.

Install the [Pi extension](../packages/cmux-panel/README.md#install) and run `pnpm install` from the repository root. New interactive Pi conversations in cmux open their panel automatically without taking focus. For Pi processes already running before this change, run `/reload` in each conversation. The extension reuses an existing panel on reload or when switching sessions in the same terminal.

If automatic opening fails, run `node /absolute/path/to/pi-plugins/cmux/open-panel.ts` from that conversation's cmux terminal. The command uses `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`; you can pass the conversation's surface UUID as the first argument when `CMUX_SURFACE_ID` is unavailable. It also reuses an existing panel rather than opening a duplicate.

The launcher runs `todo-panel.ts --surface <conversation-surface-uuid>`. Closing its tab also closes the subagent panes it opened. If you used the old Dock viewer, close its Plan tab to avoid two viewers reading the same session.

For a fixed session file, run `node cmux/todo-panel.ts /absolute/path/to/session.jsonl`. Without a terminal, this prints the task list. The legacy `--follow` mode still follows the selected workspace, but the launcher does not use it.

The viewer reads saved task lists from `@juicesharp/rpiv-todo` in Pi v2/v3 JSONL session files. It follows the conversation branch from the latest saved entry. It includes older tasks and ignores deleted tasks. It looks for file changes every half second. A read or format error displays a warning. The viewer never writes to the session file.

Each panel stays in its conversation's workspace. Switching workspaces shows that workspace's own layout. Clicking another terminal does not redirect an attached panel. Its header identifies the project and session ID.

The viewer checks the conversation every half second. `/new`, `/resume`, and `/fork` select the new session after cmux reports it and Pi saves its file. This releases the previous reader and clears its tasks and statistics. If the source terminal closes or has no saved Pi session, the panel shows an empty state instead of another conversation.

The viewer reads cmux Pi hook records and searches `~/.pi/agent/sessions/` for the matching session ID. `PI_CODING_AGENT_DIR` changes the Pi directory. A session stored elsewhere still works in fixed-file mode. Existing Pi processes need `/reload` once to activate the statistics bridge and automatic opening.

With the bridge active, the task tree follows the live Pi branch. Without the bridge, a `/tree` selection cannot appear until Pi writes again. The viewer does not support unsaved sessions or other todo tools. Large session files with frequent changes can slow updates because the viewer reads the complete file after each change.

Subagent panes follow the installed `@tintinweb/pi-subagents` extension's top-level lifecycle events. They use Pi's Markdown renderer for the saved prompt and assistant text. Tool calls appear as compact rows; tool results stay collapsed so large file reads do not bury the conversation. Click a subagent pane and press `e` to show or hide tool output. The transcript updates after each agent turn, not token by token. Internal thinking is not shown. If transcript recording is disabled, the pane shows a waiting message instead of reading another data source. Workflow-owned and nested agents do not emit top-level lifecycle events, so they do not get panes. cmux may refuse another split when the side column runs out of height; the Plan panel shows that error instead of dropping an agent silently. Run `/reload` in each Pi conversation after updating the bridge. The existing Plan viewer stays open.

## Test

The tests cover project grouping, activity ordering, five-item limits, conversation titles, status mapping, session deduplication, selection, and navigation targets. Tests against the installed cmux JavaScript runtime also cover context menus, rename cancellation, color updates, workspace creation, close confirmation, and unread dots surviving status changes until cmux clears them. These runtime tests skip when cmux is not installed. The sidebar also needs a visual check in cmux after layout changes. Its custom sidebar API is in beta.

```sh
pnpm exec vitest run scripts/cmux-sidebar.test.ts
cmux sidebar validate projects
```
