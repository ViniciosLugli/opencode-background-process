---
name: background-process
description: |-
  Launch, wait for, monitor, and clean up background processes such as finite commands, dev servers, and build watchers. Covers completion waiting, startup verification, port conflict resolution, signal handling, and stale process cleanup. Use when you need to start a server, run a process in the background, wait for completion, fix "port already in use" errors, or kill a running process.

  Examples:
  - user: "Start the dev server" → load skill, then launch with proper cleanup practices
  - user: "Run bun run dev" → load skill to verify startup and use meaningful IDs
  - user: "Run the build in the background and wait for it" → launch, then wait with a bounded timeout
  - user: "Port 3000 is already in use" → find and kill the stale process, then relaunch
---

# Background Process Best Practices

<housekeeping>

## Keep the Process List Clean

- Kill processes when done - don't leave stale servers running
- Use `background_process_cleanup` periodically to remove exited processes
- Before launching, check `background_process_list` to avoid duplicates
- Use `remove: true` when killing to clean up in one step
- If SIGTERM does not stop a tracked process, retry with `signal: "SIGKILL"`
- Use `background_process_cleanup` with `killAll: true` to stop every tracked process; it escalates from SIGTERM to SIGKILL when required

## Verify Startup

For servers and watchers, wait before reading output - they need time to start:
1. Launch the process
2. Sleep at least 30 seconds (use bash `sleep` or just wait before next action)
3. `background_process_read` to confirm startup
4. If output is empty or incomplete, wait longer and re-read

Look for: "listening on", "ready", "started" - or errors like port conflicts.
If the process fails to start after 60s, read stderr, fix the issue, kill the process, and relaunch.

## Wait For Finite Processes

Use `background_process_wait` for commands that should eventually terminate, such as builds, tests, migrations, and scripts.

- Default timeout is 5 minutes
- Maximum timeout is 10 minutes
- Use `id` for one process or `ids` for multiple processes
- Use `mode: "all"` to wait for every target to finish
- Use `mode: "any"` to return when the first target finishes, then inspect completed/pending IDs or wait again
- Timeout does not kill the process
- Tool status metadata is updated every 2 minutes while waiting
- Heartbeat entries are also recorded in process output and returned with the final result
- If a process times out, inspect recent output before deciding whether to wait again or kill it explicitly

Do not use `background_process_wait` for dev servers, file watchers, or processes expected to run indefinitely.

## Diagnose Timeout Causes

When a wait times out, aggregate the likely causes from recent output before acting:

- still making progress: wait again with an appropriate timeout
- blocked on input: use `background_process_write` if the process is interactive
- failed but not exited: read output, then kill if it is unrecoverable
- wrong process type: switch to readiness checks for servers and watchers

## Respect Tracking Boundaries

Only processes started by `background_process_launch` are tracked.

- The plugin starts each command in its own process group and signals that group
- Do not assume this tool can walk unrelated host process trees
- Do not use tracked IDs as system PIDs
- For external port conflicts, inspect with shell tools first, then kill external PIDs explicitly

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

`background_process_kill` only removes a process from tracking after confirmed termination. If the result says the process is still running, use SIGKILL or inspect output before retrying.

</signals>

<gotchas>

- Processes persist for the session - they don't auto-cleanup on conversation end
- Output buffer is limited (500 lines default) - increase `maxOutputLines` for verbose builds
- Progress bars that redraw in place are normalized for text reads
- stderr is prefixed with `[stderr]` in output - helps distinguish errors

</gotchas>
