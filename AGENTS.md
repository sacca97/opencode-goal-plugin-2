# Agent Notes

## Project Shape

This fork targets OpenCode 2.x with separate server and TUI entrypoints:

- `src/server.ts` is the V2 server plugin. It registers goal commands, tools, session hooks, usage accounting, compaction context, and execution continuation. `server.js` exposes the build to the V2 local-directory loader.
- `src/state.ts` owns goal persistence and lifecycle state. It stores JSON at `OPENCODE_GOAL_STATE_PATH` when set, otherwise under the user's OpenCode data location.
- `src/tui.ts` is the V2 Solid/OpenTUI sidebar and palette. `tui.ts` exposes it to the local-directory loader. OpenTUI/Solid remain peer dependencies resolved from the host.
- `src/prompts.ts` contains the goal-mode continuation/system/compaction prompts.
- `test/` covers state, server hooks/tools, and TUI behavior with Bun tests.

## Change Guidelines

- The server runs on Bun only: `src/state-lock.ts` uses `bun:sqlite` for the cross-process state lock, and the build targets Bun. It leaves a `<state>.lock.sqlite` file next to the state file; that is expected.
- `dist/` is gitignored and untracked. Run `bun run build` before loading the checkout through the root `server.js`.

- Preserve the public Promise-based state API (`getGoal`, `createGoal`, `completeGoal`, etc.) because OpenCode hooks and tests call it directly.
- Keep `zod` for OpenCode tool argument schemas unless the OpenCode plugin API explicitly supports another schema format.
- Effect is intentionally used in the state/persistence boundary. Do not spread Effect into the TUI unless the benefit clearly outweighs the extra runtime footprint.
- If server code imports a runtime dependency that should be resolved from `dependencies`, externalize it in the Bun build script so the package does not silently bundle it.
- State writes should remain atomic: write to a temp file, then `rename` into place.
- Use `OPENCODE_GOAL_STATE_PATH` for tests and smoke runs so you do not touch a real user's goal state.

## Local Validation

Before treating a code change as complete, run the relevant checks. For release-level changes, run the full local gate:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
bun run pack:dry-run
```

`bun run build` writes `dist/server.js`. Confirm `npm pack --dry-run` includes the runtime entrypoints and shared TUI modules listed in package.json.

## Publishing Flow

This repo publishes from GitHub Actions on pushes to `main`. The workflow computes the next patch version from npm, builds, publishes, and creates a GitHub release.

After pushing a release change, monitor the workflow with `gh run list --branch main` and `gh run watch <run-id> --exit-status`. Verify the release and package metadata after success:

```bash
npm view @prevalentware/opencode-goal-plugin version dependencies
gh release view v<version>
```

## End-To-End Plugin Test

To test this plugin end to end, do not stop at unit tests. Run the local gates first: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run pack:dry-run`.

For this local fork, run the deterministic smoke test directly from the checkout. It starts a private V2 server with an isolated home, configuration, database, and state file, and loads the local build without installing the plugin:

```bash
OPENCODE_V2_BIN=/path/to/opencode bun run smoke:v2
```

The smoke test must deliver exactly two automatic continuations and complete the goal. It prints the temporary artifact directory for inspection. Do not install, publish, or modify the user's OpenCode configuration unless requested.
