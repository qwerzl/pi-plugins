# Project conversation sidebar

`projects.js` runs in the cmux sidebar. It shows conversations under project folders, with live status labels from cmux agent hooks. It does not change Pi or install another hook.

Existing cmux workspace groups supply the project names. Ungrouped workspaces use their working directory. Only the latest session in each terminal appears because older sessions no longer match that terminal.

Click a conversation to open its workspace and terminal. Click a folder to collapse it. Sessions within each project appear in order of latest activity, newest first. The order updates as cmux reports activity. Sessions without timestamps appear last, and ties keep their existing order.

Each folder shows its five newest rows and offers **Show more** for the rest. An older selected session stays in activity order rather than replacing a newer row. The sidebar also shows only five projects initially, with a separate **Show more** when there are additional projects. Project order stays unchanged.

Statuses distinguish Working, Needs you, Idle, Ended, Unknown, and Terminal. Idle and Ended do not mean that a task succeeded. cmux supplies these states, so their accuracy depends on its agent hooks.

Named workspaces keep their titles when they contain one conversation. Other rows use the agent title, then the latest prompt, then the terminal title. Hover over a row to see its full title and status. This sidebar does not generate summaries or browse archived Pi sessions.

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

The tests cover project grouping, activity ordering, five-item limits, conversation titles, status mapping, session deduplication, selection, and navigation targets. The sidebar also needs a visual check in cmux after layout changes. Its custom sidebar API is in beta.

```sh
pnpm exec vitest run scripts/cmux-sidebar.test.ts
cmux sidebar validate projects
```
