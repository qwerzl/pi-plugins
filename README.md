# pi-plugins

Native TypeScript extensions for [pi](https://github.com/earendil-works/pi), maintained in a pnpm + Nx workspace.

## Stack

- **TypeScript** with strict checking. Pi loads `.ts` entry points directly; no compilation or bundling step.
- **Effect 4** for asynchronous orchestration, error handling and stream cleanup.
- **Nx** for package discovery, task orchestration and local caching.
- **pnpm** workspaces and named dependency catalogs.
- **@antfu/eslint-config**, including antislop rules, for linting and formatting. No Prettier.
- **Knip** for unused files, exports and dependencies.
- **Vitest** for offline unit and provider integration tests.

The main `typescript` dependency is held at 6.0 for ESLint compatibility. Effect tooling uses a separately pinned native TypeScript 7 alias (see below). The optional `skills-npm` auto-installer is intentionally omitted: its `detect-agent` dependency failed pnpm's no-downgrade trust policy. The policy remains enabled.

## Packages

| Package | Purpose |
| --- | --- |
| [`@qwerzl/pi-codexcont`](packages/codexcont) | Bounded reasoning continuation for OpenAI Responses providers, without a proxy server |
| [`@qwerzl/pi-auto-title`](packages/auto-title) | Short emoji-first session titles that update as the topic changes |
| [`@qwerzl/pi-codex-retry`](packages/codex-retry) | Codex-style retries for failed model responses, without hidden continuation messages |
| [`@qwerzl/pi-browser`](packages/browser) | Native cmux browser control and a browser-harness skill for Chrome |

```text
packages/
  codexcont/
    src/
      index.ts         # pi extension entry point
      fold.ts          # Effect-based stream folding
      constants.ts
      errors.ts
      types.ts
      *.test.ts
    package.json       # independent pi package manifest
    tsconfig.json
scripts/               # Effect LSP launcher and protocol smoke test
.pi-lens.json
eslint.config.js
knip.json
nx.json
pnpm-workspace.yaml
```

## Development

Use Node.js 24+ and the pnpm version pinned in `package.json` (via Corepack or your package manager).

```sh
pnpm install
pnpm run lint --fix
pnpm run ci
```

`ci` runs ESLint, TypeScript 6 checks, strict Nx Effect diagnostics, Knip, the LSP protocol smoke test, and Nx package tests. A local pre-commit hook runs the same checks. GitHub Actions repeats the gate on pushes to `main` and pull requests. No release or publishing workflow is configured.

```sh
# Run one package's targets
pnpm exec nx run @qwerzl/pi-codexcont:test
pnpm exec nx run @qwerzl/pi-codexcont:typecheck
pnpm exec nx run @qwerzl/pi-codexcont:effect:check

# Watch tests
pnpm --filter @qwerzl/pi-codexcont exec vitest
```

## Effect language service through pi-lens

This repository configures [pi-lens](https://github.com/apmantza/pi-lens) to use [Effect's TypeScript-Go language service](https://github.com/Effect-TS/tsgo) for TypeScript and JavaScript. Install pi-lens in your pi environment separately; it is not a runtime dependency of the plugins.

The development dependencies are pinned as a compatible pair:

- `@effect/tsgo@0.51.1`
- `@typescript/native`, an npm alias for `typescript@7.0.2`

The launcher resolves Effect's matching bundled executable and runs `--lsp --stdio`. It does **not** patch either compiler. Since both compiler packages expose a `tsc` binary, type-check scripts explicitly invoke the TypeScript 6 package instead of relying on `.bin/tsc`.

After `pnpm install`, start a **new pi session from this repository root** and approve project trust when prompted. For a checkout you have reviewed, `pi --approve` grants trust for that invocation. Project-defined LSP commands cannot run in an untrusted session. `.pi-lens.json` replaces the normal TypeScript/Deno LSPs only in this repository; it does not change global settings. Restart an existing session to discard previously cached servers.

The configuration uses a string `command` with separate `args` for compatibility with the installed pi-lens custom-server launcher. `pnpm --silent --workspace-root` keeps LSP stdout clean and finds the root script when launched from a nested package.

```sh
# The same Effect diagnostics in CI, independent of pi-lens
pnpm run effect:check

# Real stdio handshake, TypeScript + Effect diagnostics, edit-to-clean, navigation and shutdown
pnpm run test:tools
```

The smoke test opens a virtual document; it writes no deliberately broken source file. The pinned native server can exit with `context canceled` after acknowledging shutdown; the test permits only that specific nonzero shutdown outcome. Other failures remain errors.

`@effect/language-service` in `tsconfig.json` is the configuration identifier consumed by the native binary, not an additional package to install. Knip ignores that one identifier to avoid reporting a nonexistent dependency. Upgrade the native compiler and Effect tooling together according to Effect's supported-version table.

## Try the plugin

After installing dependencies, load just the repo copy for one invocation:

```sh
pi --no-extensions -e ./packages/codexcont
```

This disables other discovered extensions for that invocation, including any older CodexCont copy. It does not change your pi configuration. For an offline load check:

```sh
pi --offline --no-extensions -e ./packages/codexcont --list-models
```

To install the local package persistently:

```sh
pi install ./packages/codexcont
```

**Before persistent installation, disable or move any previous CodexCont extension out of `~/.pi/agent/extensions/`.** Do not load two copies that override the same provider. Read the [package setup and risks](packages/codexcont/README.md) first.

The root manifest also exposes the collection's extension entry points, so `pi install .` installs all plugins declared there. Install the published Git checkout with `pi install git:github.com/qwerzl/pi-plugins`.

## Automatic session titles

Install the [auto-title package](packages/auto-title) to name conversations automatically:

```sh
pi install ./packages/auto-title
```

Restart pi. After each completed reply, it generates a short emoji-first title (for example, `🏷️ Auto titles` or `🔐 Fix login`) and updates it only when the topic changes. Pi persists the name and includes it in the terminal title and session selector. A manual `/name` takes precedence.

Naming uses one small background request to the active model per completed reply, with no requested thinking and a 15-second timeout. Provider billing applies; see the package README for context and usage-accounting limits.

## Personal browser tools

The [browser package](packages/browser) registers `cmux_browser` for native embedded WebKit control and includes a browser-harness skill for Chrome. Install browser-harness separately and configure its upstream MCP server as described in the package README. Neither backend uses an OpenAI browser runtime or requires its Chrome extension.

Chrome requires user-enabled remote debugging and manual connection approval. Access is browser-wide, not approved per website; its background daemon and tabs are not automatically cleaned up at Pi turn end. Local recordings are opt-in and can contain sensitive page content. Browser-harness cannot control cmux's WebKit pane, which uses the native CLI independently.

## Model connection retries

The [codex-retry package](packages/codex-retry) applies Codex CLI 0.154.0's outer retry policy to failed Pi model responses. It does not replace providers or reproduce Codex's transport implementation.

Before using it, follow the package's setup instructions to disable Pi's native retries. Otherwise, the package stays inactive to prevent stacked retry loops. Removing it requires restoring native retries. Disabling native retries also disables them for compaction and summaries.

## Add a plugin

1. Create `packages/<name>/src/index.ts` exporting a pi extension factory.
2. Add an ESM `package.json` with a unique name, a `pi.extensions` entry, and `typecheck` / `effect:check` / `test` scripts. Nx discovers the workspace package automatically.
3. Extend the root `tsconfig.json`; keep tests next to the implementation.
4. Declare runtime dependencies in the package using `catalog:prod`. Host-provided pi packages belong in `peerDependencies` (`"*"`); add pinned development copies only for local checking.
5. Add the new entry point to the root `pi.extensions` array if it should be included in collection installs.
6. Run `pnpm run lint --fix` and `pnpm run ci`.

No shared utility package is created until more than one plugin needs it.

## License

MIT. CodexCont is adapted from [neteroster/CodexCont](https://github.com/neteroster/CodexCont); its original MIT copyright notice is preserved in [`packages/codexcont/LICENSE`](packages/codexcont/LICENSE).
