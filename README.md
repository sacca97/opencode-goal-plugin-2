# OpenCode Goal Plugin — V2 fork

This checkout targets OpenCode 2.x. It has not been installed into the user's OpenCode configuration.

Goal Mode records one objective per session and continues after successful executions until the goal is completed, blocked, cancelled, paused, or limited. Cancellation, Plan-mode restrictions, task deferral, and duplicate-delivery protection remain enforced.

## Changes in this fork

- Removed the V1 server and TUI adapters and their obsolete tests.
- Removed the runtime dependency on `@opencode-ai/plugin`.
- `get_goal` defaults to a compact summary. Use `{ "view": "full" }` for the full plan and history.
- Plan updates default to compact responses; `response_mode: "full"` opts into full output.
- Plans are optional. Existing plans retain revision checks, evidence requirements, and incremental `plan_ops`.
- Sessions without goals receive no Goal Mode system policy.
- Unchanged mutations skip atomic disk replacement and fsync. Schema migrations, normalized data, and corrupt-state recovery still persist.
- The V2 palette reads persisted state so compact tool output does not hide the current goal.
- Local directory entrypoints and the native smoke harness work with V2 loading.
- Pause, resume, status, history, stop, clear and edit execute in the command handler before the model acknowledges the result. Resume then starts goal work. Editing leaves the revised goal paused until explicitly resumed.
- Ordinary messages steer work while the goal stays active. They invalidate stale continuation preparation; continuation resumes after the human-directed turn. Use pause or stop explicitly to halt the goal.
- Removed the duplicate `set_goal` tool; use `create_goal`.
- Dropped event streams reconnect up to three times, after 250 ms, 1 s and 2 s. Continuations wait during the outage; recovery checks the live runner before restarting. Retry progress and the last failure are recorded in goal status/history. Exhausted retries pause owned active goals with a visible cause and instructions to reload the plugin and resume. A connection must process events for at least 30 seconds before its retry allowance resets, so a flapping stream cannot retry forever. Unloading cancels the backoff.

The Promise-based state API and version 3 state format remain compatible. Effect stays at the persistence boundary; Zod validates tool input. Budget accounting and lifecycle guards are retained rather than replaced with unverified timing assumptions.

## Commands and tools

Use `/goal <objective>` to start, `/goal` for status, and `/pause_goal` or `/resume_goal` for control. The main command also supports `history`, `edit <objective>`, `stop`, `clear`, and `replace <objective>`.

The agent can create/read/update goals through the existing goal tools. `update_goal` accepts `status: "complete"` with evidence or `status: "unmet"` with a blocker. Plans, when used, can be updated incrementally with `update_goal_plan` and `plan_ops`, avoiding resending task descriptions for status changes.

Defaults: automatic continuation enabled, 25 continuation turns, a three-second minimum interval, task deferral enabled, and Plan-mode execution disabled. Token and elapsed-time budgets are optional. Goal control does not bypass OpenCode permissions.

## State

State lives at `$XDG_DATA_HOME/opencode-goal-plugin/goals.json`, defaulting to `~/.local/share/opencode-goal-plugin/goals.json`. Set `OPENCODE_GOAL_STATE_PATH` for an isolated file.

Writes use a same-directory temporary file and atomic rename with owner-only permissions. Existing version 1 and 2 files migrate on mutation. Invalid state is not silently overwritten; recoverable padding is quarantined.

The mutation queue serializes writers within one process. A companion `goals.json.lock.sqlite` file uses Bun's built-in SQLite writer lock to serialize complete read-modify-write operations across processes. It stores no goal data. The OS releases the lock when a writer exits or crashes; no stale PID files or timeout-based lock stealing are needed. Lock acquisition yields between retries and fails after ten seconds rather than overwriting unlocked state. All writers must use this fork; older plugins do not honor its lock.

## Development and verification

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test
bun run build
bun run pack:dry-run
OPENCODE_V2_BIN=/path/to/opencode bun run smoke:v2
GOAL_TWO_SERVERS=1 OPENCODE_V2_BIN=/path/to/opencode bun run smoke:v2
GOAL_TWO_SERVERS=1 GOAL_BACKGROUND_SHELL=1 OPENCODE_V2_BIN=/path/to/opencode bun run smoke:v2
```

Development dependencies are installed only in this checkout. The default smoke test loads this checkout into a temporary V2 server with an isolated home, config, database and goal state, using a deterministic loopback model. It does not install or register this fork in the user's OpenCode setup. It verifies two automatic continuations, direct pause/status/resume, ordinary human steering, and completion, with a second location loaded to catch duplicate delivery. Process tests verify concurrent state writers and lock release after a forced process kill.

The two-server variant runs concurrent goals through separate native server processes sharing the same private database and goal file. Reservation race tests additionally send the same idle boundary to two plugin instances and race two processes for the same goal. Normal continuation and optional watchdog retries both reserve atomically.

Running tool calls and host transcript shells defer continuation even after an execution ends. These waits leave the goal active, consume no auto-turns, and suppress watchdog retries; continuation rechecks after completion. This safety check is independent of the optional child-task deferral setting.
The background-shell smoke variant verifies this with a real three-second background process, not just simulated tool hooks.

For a future manual activation, the V2 server and CLI each accept a `plugins` entry pointing to this repository directory. Build first. No activation has been performed here.

Original project: [prevalentWare/opencode-goal-plugin](https://github.com/prevalentWare/opencode-goal-plugin). MIT license.
