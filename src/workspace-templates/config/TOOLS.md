# TOOLS.md — Tool Notes

## General

- Array/object parameters in tool calls must be valid JSON.
- `git` in the container requires `git config --global --add safe.directory /app` before use.

## exec (Bash)

- Default timeout is 30s. Use `timeout` parameter for long-running commands.
- Working directory defaults to current dir. Use `cwd` for explicit paths.
- **Heredoc false positives:** The safety filter blocks any `exec` call containing the word `source` anywhere in the command string — including inside heredoc content. If appending text that contains "source" (e.g. markdown headings like "### Sources Used"), use `edit_file` instead of `cat >>` with a heredoc.

## File Operations

- `read_file` supports `offset` (1-indexed line number) and `limit` for reading ranges of large files.
- `edit_file` requires exact text match including whitespace. Read the file first if unsure.
- `write_file` creates parent directories automatically.
- **Preferred for appending:** Use `edit_file` (find last unique line, replace with itself + new content) rather than `cat >>` heredocs — avoids safety filter false positives on content containing shell keywords.

## spawn_agent

- Sub-agents share the filesystem but get their own conversation context.
- Good for: parallel research, delegating well-defined tasks, code review.
- Max 25 iterations. Default 15.
- Sub-agents can't use spawn_agent themselves (no nesting).

## Compilation

- Always run `cd /app && npx tsc --noEmit` after modifying source code.
- Pre-existing errors in `mcp.ts` (exactOptionalPropertyTypes) — ignore these.

## fetch

- Use `text_only: true` for HTML pages to strip tags.
- Default max response size is 100KB.

## request_screenshot

- Captures a PNG screenshot from the user's browser.
- First call: browser prompts the user to pick a window or screen to share (getDisplayMedia).
- Subsequent calls: reuses the active stream — zero additional friction for the user.
- Use proactively: when in doubt about the user's UI state, take a screenshot rather than asking them to describe it.
- No input parameters required.
