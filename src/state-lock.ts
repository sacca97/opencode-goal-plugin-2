import { Database } from "bun:sqlite"
import { mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"

// SQLite supplies an OS-managed writer lock, including release on process death.
// Goal data stays in the existing atomic JSON file; this database stores no data.
export async function withStateLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lockFile = `${file}.lock.sqlite`
  const handle = await open(lockFile, "a", 0o600)
  await handle.close()
  const db = new Database(lockFile)
  db.exec("PRAGMA busy_timeout = 0")
  const deadline = Date.now() + 10_000
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE")
        break
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_BUSY") throw error
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for goal state lock: ${file}`, { cause: error })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    return await operation()
  } finally {
    db.close()
  }
}
