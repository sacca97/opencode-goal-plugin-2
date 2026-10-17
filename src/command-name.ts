export const DEFAULT_COMMAND_NAME = "goal"

// Shared by the server (registration) and the TUI (palette actions) so both agree on the command.
export function resolveCommandName(value: unknown) {
  const name = typeof value === "string" ? value.trim() || DEFAULT_COMMAND_NAME : DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  if (name.toLowerCase() === "pause_goal" || name.toLowerCase() === "resume_goal") return DEFAULT_COMMAND_NAME
  return name
}
