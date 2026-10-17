import type { Plugin as TuiPluginV2 } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { readFile, stat } from "node:fs/promises"
import type { GoalMessages } from "./i18n"
import { messagesFor, presentGoalLastStatus, presentGoalStatus, presentGoalStopReason, resolveLocale } from "./i18n"
import { resolveCommandName } from "./command-name"
import { statePath } from "./state-path"

type GoalCheckpoint = {
  summary: string
  timestamp: number
}

type GoalHistoryEntry = {
  type: string
  detail: string
  timestamp: number
}

type GoalSnapshot = {
  sessionID: string
  objective: string
  status: "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet" | "cancelled"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  continuationFailures: number
  lastStatus: string | null
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  noProgressTokenThreshold: number | null
  maxNoProgressTurns: number | null
  noProgressTurns: number
  budgetWrapupSent: boolean
  stopReason: string | null
  history: GoalHistoryEntry[]
  checkpoints: GoalCheckpoint[]
  lastCheckpoint: GoalCheckpoint | null
  lastAssistantText: string
  lastAssistantMessageID: string
  autoTurns: number
  lastContinuationAt: number | null
  remainingTokens: number | null
  sampledAt?: number
}

type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

const GOAL_TOOL_NAMES: readonly string[] = [
  "get_goal",
  "get_goal_history",
  "create_goal",
  "update_goal",
  "update_goal_objective",
  "update_goal_status",
  "stop_goal",
  "replace_goal",
  "clear_goal",
]

function element(tag: string, props: Record<string, unknown>, children: ElementChild[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}

function text(props: Record<string, unknown>, children: ElementChild[]) {
  return element("text", props, children)
}

function box(props: Record<string, unknown>, children: ElementChild[] = []) {
  return element("box", props, children)
}

type SlotRender = (props: { sessionID: string }) => unknown
type SlotDispose = () => void

const noopDispose: SlotDispose = () => {}

/**
 * Registers a V2 TUI slot across both plugin-context generations.
 *
 * Early V2 previews exposed `ui.slot(name, render)`. Current previews expose a
 * single options argument, `ui.slot({ append, render })`, and silently register
 * nothing when handed the positional pair — which is how the goal sidebar and
 * the palette keymap layer both disappeared. Branch on the callback arity so
 * either host works, and tolerate hosts that return no disposer.
 */
export function registerSlotV2(context: TuiPluginV2.Context, name: string, render: SlotRender): SlotDispose {
  const slot = context.ui.slot as unknown as (...args: unknown[]) => unknown
  const dispose = slot.length <= 1 ? slot({ append: name, render }) : slot(name, render)
  return typeof dispose === "function" ? (dispose as SlotDispose) : noopDispose
}

/**
 * Reads a theme color by trying each candidate path in order, descending into a
 * `default` leaf when the resolved node is a color group.
 *
 * Current previews expose a nested theme (`text.default`, `text.subdued`,
 * `text.feedback.success`), while earlier previews and the V1 TUI expose flat
 * keys (`text`, `textMuted`, `primary`). Passing a color *group* as `fg`
 * renders nothing useful, so resolve to a leaf before handing it to OpenTUI.
 */
export function themeColorV2(theme: unknown, ...paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    let cursor: unknown = theme
    for (const key of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor !== null && typeof cursor === "object" && "default" in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>).default
    }
    if (cursor !== undefined && cursor !== null) return cursor
  }
  return undefined
}

function goalColorsV2(theme: unknown) {
  return {
    text: themeColorV2(theme, ["text", "default"], ["text"]),
    muted: themeColorV2(theme, ["text", "subdued"], ["textMuted"]),
    achieved: themeColorV2(theme, ["text", "feedback", "success"], ["primary"], ["text", "default"], ["text"]),
  }
}






export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const paddedSecs = String(secs).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
  return `${minutes}:${paddedSecs}`
}

function formatDurationBadge(seconds: number) {
  return formatDuration(seconds)
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function liveTimeUsedSeconds(goal: GoalSnapshot, nowSeconds = currentEpochSeconds()) {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds))
  if (goal.status !== "active") return baseSeconds
  if (typeof goal.sampledAt !== "number") return baseSeconds
  return baseSeconds + Math.max(0, Math.floor(nowSeconds - goal.sampledAt))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCheckpoint(value: unknown): value is GoalCheckpoint {
  return isRecord(value) && typeof value.summary === "string" && typeof value.timestamp === "number"
}

function isHistoryEntry(value: unknown): value is GoalHistoryEntry {
  return isRecord(value) && typeof value.type === "string" && typeof value.detail === "string" && typeof value.timestamp === "number"
}

function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.objective !== "string") return false
  if (!["active", "paused", "budgetLimited", "usageLimited", "complete", "unmet", "cancelled"].includes(String(value.status))) return false
  if (value.tokenBudget !== null && typeof value.tokenBudget !== "number") return false
  if (typeof value.tokensUsed !== "number") return false
  if (typeof value.timeUsedSeconds !== "number") return false
  if (typeof value.createdAt !== "number") return false
  if (typeof value.updatedAt !== "number") return false
  if (value.completionEvidence != null && typeof value.completionEvidence !== "string") return false
  if (value.blocker != null && typeof value.blocker !== "string") return false
  if (value.closedAt != null && typeof value.closedAt !== "number") return false
  if (typeof value.continuationFailures !== "number") return false
  if (value.lastStatus != null && typeof value.lastStatus !== "string") return false
  if (value.maxAutoTurns !== null && typeof value.maxAutoTurns !== "number") return false
  if (value.maxDurationSeconds !== null && typeof value.maxDurationSeconds !== "number") return false
  if (value.noProgressTokenThreshold !== null && typeof value.noProgressTokenThreshold !== "number") return false
  if (value.maxNoProgressTurns !== null && typeof value.maxNoProgressTurns !== "number") return false
  if (typeof value.noProgressTurns !== "number") return false
  if (typeof value.budgetWrapupSent !== "boolean") return false
  if (value.stopReason !== null && typeof value.stopReason !== "string") return false
  if (!Array.isArray(value.history) || !value.history.every(isHistoryEntry)) return false
  if (!Array.isArray(value.checkpoints) || !value.checkpoints.every(isCheckpoint)) return false
  if (value.lastCheckpoint !== null && !isCheckpoint(value.lastCheckpoint)) return false
  if (typeof value.lastAssistantText !== "string") return false
  if (typeof value.lastAssistantMessageID !== "string") return false
  if (typeof value.autoTurns !== "number") return false
  if (value.lastContinuationAt != null && typeof value.lastContinuationAt !== "number") return false
  if (value.remainingTokens !== null && typeof value.remainingTokens !== "number") return false
  if (value.sampledAt != null && typeof value.sampledAt !== "number") return false
  return true
}

/** Read only the current session from the server's atomic state file. */
export async function readPersistedGoal(sessionID: string): Promise<GoalSnapshot | null | undefined> {
  try {
    const state: unknown = JSON.parse(await readFile(statePath(), "utf8"))
    if (!isRecord(state) || (state.version !== 1 && state.version !== 2 && state.version !== 3) || !isRecord(state.goals)) return undefined
    const stored = state.goals[sessionID]
    if (stored === undefined) return null
    if (!isRecord(stored) || stored.sessionID !== sessionID) return undefined
    const sampledAt = currentEpochSeconds()
    const timeUsedSeconds = typeof stored.timeUsedSeconds === "number" ? stored.timeUsedSeconds : 0
    const activeSeconds = stored.status === "active" && typeof stored.lastAccountedAt === "number"
      ? Math.max(0, sampledAt - stored.lastAccountedAt)
      : 0
    const tokenBudget = stored.tokenBudget
    const tokensUsed = stored.tokensUsed
    const snapshot = {
      ...stored,
      timeUsedSeconds: timeUsedSeconds + activeSeconds,
      sampledAt,
      remainingTokens: typeof tokenBudget === "number" && typeof tokensUsed === "number"
        ? Math.max(0, tokenBudget - tokensUsed)
        : null,
    }
    return isGoalSnapshot(snapshot) ? snapshot : undefined
  } catch {
    // Keep the last valid snapshot when the file is unavailable or incomplete.
    return undefined
  }
}

function usePersistedGoal(sessionID: string) {
  const [persisted, setPersisted] = createSignal<GoalSnapshot | null | undefined>(undefined)
  let disposed = false
  let reading = false
  let lastFile: { ino: number; mtimeMs: number; size: number } | undefined
  const refresh = async () => {
    if (reading) return
    reading = true
    try {
      const file = await stat(statePath())
      if (lastFile && lastFile.ino === file.ino && lastFile.mtimeMs === file.mtimeMs && lastFile.size === file.size) return
      const next = await readPersistedGoal(sessionID)
      if (next === undefined) return
      lastFile = { ino: file.ino, mtimeMs: file.mtimeMs, size: file.size }
      if (!disposed && (next !== null || persisted() !== undefined)) setPersisted(() => next)
    } catch {
      // Missing or unreadable state leaves the last valid view in place.
    } finally {
      reading = false
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1000)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })
  return persisted
}


export function formatGoal(goal: GoalSnapshot | null, messages: GoalMessages, locale: ReturnType<typeof resolveLocale>) {
  if (!goal) return messages.tui.noGoal
  const lines = [
    `${messages.tui.objective}: ${goal.objective}`,
    `${messages.tui.status}: ${presentGoalStatus(goal.status, locale)}`,
    `${messages.tui.timeUsed}: ${formatDuration(goal.timeUsedSeconds)}`,
    `${messages.tui.tokens}: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`,
    `${messages.tui.autoContinues}: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`,
  ]
  if (goal.remainingTokens != null) lines.push(`${messages.tui.tokensRemaining}: ${goal.remainingTokens}`)
  if (goal.maxDurationSeconds != null) lines.push(`${messages.tui.durationLimit}: ${formatDuration(goal.maxDurationSeconds)}`)
  if (goal.noProgressTurns > 0) lines.push(`${messages.tui.noProgressTurns}: ${goal.noProgressTurns}`)
  if (goal.lastCheckpoint) lines.push(`${messages.tui.latestCheckpoint}: ${goal.lastCheckpoint.summary}`)
  if (goal.stopReason) lines.push(`${messages.tui.stopReason}: ${presentGoalStopReason(goal.stopReason, locale)}`)
  if (goal.lastStatus) lines.push(`${messages.tui.lastStatus}: ${presentGoalLastStatus(goal.lastStatus, locale)}`)
  if (goal.completionEvidence) lines.push(`${messages.tui.completionEvidence}: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`${messages.tui.blocker}: ${presentGoalLastStatus(goal.blocker, locale)}`)
  return lines.join("\n")
}

// --- V2 TUI plugin ---

/**
 * Scans the V2 session message list for the newest completed goal tool result.
 * Assistant tool content entries carry `name` plus a completed `state.content`
 * array; goal tool output is serialized in text ToolContent parts. Returns
 * `undefined` when no goal tool output is present (so callers can fall back to
 * a cached snapshot), `null` after a completed clear_goal, or the snapshot.
 */
export function goalFromV2Messages(messages: readonly SessionMessageInfo[]): GoalSnapshot | null | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message || message.type !== "assistant") continue
    const parts = message.content
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (!part || part.type !== "tool") continue
      if (!GOAL_TOOL_NAMES.includes(part.name)) continue
      if (part.state.status !== "completed") continue
      if (part.name === "clear_goal") return null
      const textContent = part.state.content.find((entry) => entry.type === "text")
      if (!textContent) continue
      try {
        const parsed: unknown = JSON.parse(textContent.text)
        if (!isRecord(parsed)) continue
        if (parsed.goal === null) return null
        if (isGoalSnapshot(parsed.goal)) return parsed.goal
      } catch {
        // Malformed tool output: keep scanning older tool entries.
      }
    }
  }
  return undefined
}

function currentSessionIDV2(api: TuiPluginV2.Context) {
  const route = api.ui.router.current()
  if (route.type !== "session") return undefined
  return route.sessionID
}

function toastV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  api.ui.toast.show({ title: messages.tui.title, message, variant, duration: 2500 })
}

async function showSummaryV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  locale: ReturnType<typeof resolveLocale>,
  sessionID: string,
  goal: GoalSnapshot | null,
) {
  const options = [
    { title: messages.tui.refresh, value: "refresh", description: messages.tui.refreshDescription },
    ...(goal
      ? [
          { title: messages.tui.history, value: "history", description: messages.tui.historyDescription },
          ...(goal.status === "active"
            ? [{ title: messages.tui.pause, value: "pause", description: messages.tui.pauseDescription }]
            : []),
          ...(goal.status === "paused" || goal.status === "budgetLimited" || goal.status === "usageLimited"
            ? [{ title: messages.tui.resume, value: "resume", description: messages.tui.resumeDescription }]
            : []),
          { title: messages.tui.clear, value: "clear", description: messages.tui.clearDescription },
        ]
      : []),
  ]
  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({
    title: messages.tui.title,
    placeholder: formatGoal(goal, messages, locale),
    options,
  })
  if (typeof selected !== "string" || !options.some((option) => option.value === selected)) return
  try {
    const name = resolveCommandName(api.options?.command_name)
    // The pinned V2 SDK calls this field command; current V2 hosts call it name.
    const input = { sessionID, command: name, name, text: selected === "refresh" ? "status" : selected }
    await api.client.session.command(input)
  } catch (error) {
    toastV2(api, messages, error instanceof Error ? error.message : String(error), "error")
  }
}

function GoalSidebarV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  locale: ReturnType<typeof resolveLocale>,
  sessionID: string,
) {
  const colors = goalColorsV2(api.theme)
  const [cache, setCache] = api.storage.memory<{ goal: GoalSnapshot | null }>(`goal-mode.v2.${sessionID}`, {
    initial: { goal: null },
  })
  const persisted = usePersistedGoal(sessionID)
  const messageGoal = createMemo(() => goalFromV2Messages(api.data.session.message.list(sessionID)))
  const goal = createMemo<GoalSnapshot | null>(() => {
    const found = messageGoal()
    if (found === null) return null
    const live = persisted()
    if (live !== undefined) {
      if (found && live && (found.createdAt > live.createdAt || found.updatedAt > live.updatedAt)) return found
      return live
    }
    return found === undefined ? cache.goal : found
  })
  createEffect(() =>
    setCache((draft) => {
      draft.goal = goal()
    }),
  )

  const [nowSeconds, setNowSeconds] = createSignal(currentEpochSeconds())
  const active = createMemo(() => goal()?.status === "active")
  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => setNowSeconds(currentEpochSeconds()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return box({}, [() => {
    const snapshot = goal()
    if (!snapshot) return null
    if (snapshot.status === "complete" || snapshot.status === "unmet") {
      const elapsed = liveTimeUsedSeconds(snapshot)
      return text({ fg: snapshot.status === "complete" ? colors.achieved : colors.muted }, [
        `${snapshot.status === "complete" ? messages.tui.achieved : messages.tui.unmet} (${formatDurationBadge(elapsed)})`,
      ])
    }
    return box({}, [
      text({ fg: colors.text }, [messages.tui.title]),
      text({ fg: colors.muted }, [`${messages.tui.status}: ${presentGoalStatus(snapshot.status, locale)}`]),
      text({ fg: colors.muted }, [`${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, nowSeconds()))}`]),
      text({ fg: colors.muted }, [
        `${messages.tui.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`,
      ]),
      text({ fg: colors.muted }, [
        `${messages.tui.autoContinues}: ${snapshot.autoTurns}${
          snapshot.maxAutoTurns == null ? "" : `/${snapshot.maxAutoTurns}`
        }`,
      ]),
      ...(snapshot.lastCheckpoint
        ? [text({ fg: colors.muted }, [`${messages.tui.checkpoint}: ${snapshot.lastCheckpoint.summary}`])]
        : []),
      ...(snapshot.stopReason
        ? [
            text(
              { fg: colors.muted },
              [`${messages.tui.stop}: ${presentGoalStopReason(snapshot.stopReason, locale)}`],
            ),
          ]
        : []),
      ...(snapshot.lastStatus
        ? [text({ fg: colors.muted }, [presentGoalLastStatus(snapshot.lastStatus, locale)])]
        : []),
      text({ fg: colors.muted }, [snapshot.objective]),
    ])
  }])
}

function GoalKeymapLayerV2(api: TuiPluginV2.Context, messages: GoalMessages, locale: ReturnType<typeof resolveLocale>) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "goal.show",
        title: messages.tui.title,
        description: messages.tui.commandDescription,
        group: messages.tui.title,
        palette: true,
        run: async () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, messages, messages.tui.openSession, "warning")
            return
          }
          const persisted = await readPersistedGoal(sessionID)
          const goal = persisted === undefined
            ? goalFromV2Messages(api.data.session.message.list(sessionID)) ?? null
            : persisted
          void showSummaryV2(api, messages, locale, sessionID, goal)
        },
      },
    ],
  }))
  return null
}

/**
 * V2 TUI setup: registers the goal sidebar via `ui.slot` and a palette command
 * through a keymap layer mounted from the global `app` slot. `keymap.layer`
 * must be invoked from a Solid component scope, so the layer lives inside a
 * component rendered by the `app` slot; its cleanup is owned by that component
 * and released automatically when the slot unmounts. The setup cleanup only
 * needs to dispose the two `ui.slot` registrations.
 */
export function setupTuiV2(context: TuiPluginV2.Context): TuiPluginV2.Cleanup {
  const locale = resolveLocale(typeof context.options?.locale === "string" ? context.options.locale : undefined)
  const messages = messagesFor(locale)
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) =>
    GoalSidebarV2(context, messages, locale, props.sessionID),
  )
  const offApp = registerSlotV2(context, "app", () => GoalKeymapLayerV2(context, messages, locale))
  return () => {
    offSidebar()
    offApp()
  }
}

const plugin: TuiPluginV2.Definition = {
  id: "local.goal-mode.tui",
  setup: setupTuiV2,
}

export default plugin
