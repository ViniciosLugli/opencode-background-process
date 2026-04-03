---
name: background-process
description: |-
  Launch, monitor, and clean up background processes such as dev servers and build watchers. Covers startup verification, port conflict resolution, signal handling, and stale process cleanup. Use when you need to start a server, run a process in the background, fix "port already in use" errors, or kill a running process.

  Examples:
  - user: "Start the dev server" → load skill, then launch with proper cleanup practices
  - user: "Run npm run dev" → load skill to verify startup and use meaningful IDs
  - user: "Port 3000 is already in use" → find and kill the stale process, then relaunch
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

Look for: "listening on", "ready", "started" - or errors like port conflicts.
If the process fails to start after 60s, read stderr, fix the issue, kill the process, and relaunch.

## Port Conflict Resolution

1. `lsof -i :<port>` to identify the process holding the port
2. `background_process_kill` with its ID (or `kill <PID>` for external processes)
3. Verify port is free: `lsof -i :<port>` returns empty
4. Relaunch the server

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
