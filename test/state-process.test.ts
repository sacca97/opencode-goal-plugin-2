import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const stateModule = new URL("../src/state.ts", import.meta.url).href
const lockModule = new URL("../src/state-lock.ts", import.meta.url).href

test("concurrent processes preserve every session's mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-processes-"))
  const file = join(dir, "goals.json")
  try {
    const children = Array.from({ length: 6 }, (_, worker) => Bun.spawn([
      process.execPath, "-e",
      `import { createGoal } from ${JSON.stringify(stateModule)};
       for (let i = 0; i < 10; i++) await createGoal("ses_${worker}_" + i, "worker ${worker}");`,
    ], { env: { ...process.env, OPENCODE_GOAL_STATE_PATH: file }, stdout: "ignore", stderr: "pipe" }))
    const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })))
    expect(results).toEqual(results.map(() => ({ code: 0, error: "" })))
    const state = JSON.parse(await readFile(file, "utf8"))
    expect(Object.keys(state.goals)).toHaveLength(60)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("separate server processes cannot reserve the same goal continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-reservation-race-"))
  const file = join(dir, "goals.json")
  const run = (code: string) => Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, OPENCODE_GOAL_STATE_PATH: file }, stdout: "pipe", stderr: "pipe",
  })
  try {
    const init = run(`import {createGoal} from ${JSON.stringify(stateModule)}; await createGoal("ses_shared", "shared");`)
    expect(await init.exited).toBe(0)
    const startAt = Date.now() + 1500
    const children = Array.from({ length: 2 }, () => run(`
      import {reserveContinuation} from ${JSON.stringify(stateModule)};
      await Bun.sleep(Math.max(0, ${startAt} - Date.now()));
      console.log(Boolean(await reserveContinuation("ses_shared", 1, 0)));
    `))
    const results = await Promise.all(children.map(async (child) => {
      expect(await child.exited).toBe(0)
      return (await new Response(child.stdout).text()).trim()
    }))
    expect(results.sort()).toEqual(["false", "true"])
    expect(JSON.parse(await readFile(file, "utf8")).goals.ses_shared.autoTurns).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a killed writer releases its lock without stale-file recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-killed-writer-"))
  const file = join(dir, "goals.json")
  const child = Bun.spawn([process.execPath, "-e",
    `import { withStateLock } from ${JSON.stringify(lockModule)};
     await withStateLock(${JSON.stringify(file)}, async () => {
       console.log("locked"); await new Promise(() => {});
     });`,
  ], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked")
    child.kill("SIGKILL")
    await child.exited
    const writer = Bun.spawn([process.execPath, "-e",
      `import { createGoal } from ${JSON.stringify(stateModule)}; await createGoal("ses_after_crash", "recovered");`,
    ], { env: { ...process.env, OPENCODE_GOAL_STATE_PATH: file }, stdout: "ignore", stderr: "pipe" })
    expect(await writer.exited).toBe(0)
    expect(JSON.parse(await readFile(file, "utf8")).goals.ses_after_crash.objective).toBe("recovered")
  } finally {
    child.kill()
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
})
