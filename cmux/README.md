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

## Test

The tests cover project grouping, activity ordering, five-item limits, conversation titles, status mapping, session deduplication, selection, and navigation targets. Tests against the installed cmux JavaScript runtime also cover context menus, rename cancellation, color updates, workspace creation, close confirmation, and unread dots surviving status changes until cmux clears them. These runtime tests skip when cmux is not installed. The sidebar also needs a visual check in cmux after layout changes. Its custom sidebar API is in beta.

```sh
pnpm exec vitest run scripts/cmux-sidebar.test.ts
cmux sidebar validate projects
```
