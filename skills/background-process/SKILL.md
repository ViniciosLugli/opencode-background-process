---
name: background-process
description: |-
  Housekeeping guide for background process tools. You SHOULD load this skill before launching background processes to avoid stale processes, port conflicts, and buffer issues.

  Examples:
  - user: "Start the dev server" → load skill, then launch with proper cleanup practices
  - user: "Run npm run dev" → load skill to verify startup and use meaningful IDs
  - user: "Why won't my server start?" → check for duplicate processes, port conflicts
---

# Background Process Best Practices

<housekeeping>

## Keep the Process List Clean

- Kill processes when done - don't leave stale servers running
- Use `background_process_cleanup` periodically to remove exited processes
- Before launching, check `background_process_list` to avoid duplicates
- Use `remove: true` when killing to clean up in one step

## Verify Startup

After launching, wait before reading output - servers need time to start:
1. Launch the process
2. Sleep at least 30 seconds (use bash `sleep` or just wait before next action)
3. `background_process_read` to confirm startup
4. If output is empty or incomplete, wait longer and re-read

Look for: "listening on", "ready", "started" - or errors like port conflicts

## Use Meaningful IDs

When running multiple processes, set custom `id` for clarity:
- `id: "frontend"` and `id: "backend"` instead of `vite-1`, `node-2`
- Makes kill/read commands unambiguous

</housekeeping>

<signals>

## When to Use Each Signal

| Signal | Use When |
|--------|----------|
| SIGTERM (default) | Normal shutdown - gives process time to cleanup |
| SIGINT | Simulate Ctrl+C - some processes handle this differently |
| SIGKILL | Process won't die with SIGTERM - force kill |

</signals>

<gotchas>

- Processes persist for the session - they don't auto-cleanup on conversation end
- Output buffer is limited (500 lines default) - increase `maxOutputLines` for verbose builds
- stderr is prefixed with `[stderr]` in output - helps distinguish errors

</gotchas>
