# opencode-background-process

This repository is a public GitHub fork of `fernandezbaptiste/opencode-background-process`, which is itself a fork of `IgorWarzocha/opencode-background-process`. This fork keeps the prompt/skill changes from that fork and adds a focused update for package maintenance plus reliable waiting on background processes.

## Fork Changes

- Updated the package to a Bun-based workflow and refreshed compatible dependencies.
- Added `background_process_wait` to wait for finite background processes with a 5 minute default timeout, 10 minute maximum timeout, safe abort/timeout behavior, and status heartbeats.
- Refined the bundled background-process skill guidance for wait usage, timeout diagnosis, and tracked-process boundaries.

An OpenCode plugin for managing background processes. Launch, monitor, and control long-running tasks like dev servers, watchers, and build processes.

![background-process jpg](https://github.com/user-attachments/assets/33b3199b-146e-49ae-9914-9d8e6b112de1)

## Installation

Add the package to your OpenCode plugins:

```json
{
  "plugin": [
    "@vinicioslugli/opencode-background-process@git+https://github.com/ViniciosLugli/opencode-background-process.git#improve-background-process-skill"
  ]
}
```

OpenCode automatically installs plugin dependencies at runtime. This package is intended to be installed through OpenCode's plugin directive from the repository URL, without manually cloning the repository.

For local development, use Bun:

```sh
bun install
bun run typecheck
bun run build
```

## Bundled Skill

This plugin ships a bundled skill at `skills/background-process/SKILL.md` that provides housekeeping guidance for long-running processes and how to differentiate it from standard system processes. The plugin registers the skill automatically.

## Tools

### `background_process_launch`

Start a command as a background process. Use for long-running tasks instead of blocking shell runs.

| Argument         | Type   | Required | Description                                |
| ---------------- | ------ | -------- | ------------------------------------------ |
| `command`        | string | yes      | The shell command to run                   |
| `cwd`            | string | no       | Working directory (defaults to current)    |
| `id`             | string | no       | Custom ID (auto-generated if not provided) |
| `maxOutputLines` | number | no       | Output buffer size (default: 500)          |

### `background_process_list`

List background processes started by this tool in the current session (not system processes).

### `background_process_read`

Read captured output from a background process started by this tool.

| Argument | Type    | Required | Description                                 |
| -------- | ------- | -------- | ------------------------------------------- |
| `id`     | string  | yes      | Process ID to read from                     |
| `lines`  | number  | no       | Number of lines to return (default: 50)     |
| `clear`  | boolean | no       | Clear buffer after reading (default: false) |

### `background_process_wait`

Wait for a tracked background process to terminate. Use for finite commands that were launched in the background.

| Argument         | Type   | Required | Description                                           |
| ---------------- | ------ | -------- | ----------------------------------------------------- |
| `id`             | string | yes      | Process ID to wait for                                |
| `timeoutSeconds` | number | no       | Maximum seconds to wait, 1-600 (default: 300)         |
| `lines`          | number | no       | Recent output lines to include in result (default: 50) |

The wait operation publishes tool metadata updates every 2 minutes, records heartbeat entries in the process output buffer, and returns those heartbeats in the final result. A timeout does not kill the process; it remains tracked and can be read, waited on again, or killed explicitly.

### `background_process_write`

Send input to a running process started by this tool.

| Argument  | Type    | Required | Description                    |
| --------- | ------- | -------- | ------------------------------ |
| `id`      | string  | yes      | Process ID                     |
| `input`   | string  | yes      | Input to send                  |
| `newline` | boolean | no       | Append newline (default: true) |

### `background_process_kill`

Kill a background process started by this tool.

| Argument | Type    | Required | Description                                         |
| -------- | ------- | -------- | --------------------------------------------------- |
| `id`     | string  | yes      | Process ID to kill                                  |
| `signal` | enum    | no       | SIGTERM, SIGKILL, or SIGINT (default: SIGTERM)      |
| `remove` | boolean | no       | Remove from tracking after killing (default: false) |

### `background_process_cleanup`

Remove exited processes or kill all tracked processes.

| Argument  | Type    | Required | Description                                                      |
| --------- | ------- | -------- | ---------------------------------------------------------------- |
| `killAll` | boolean | no       | Kill all running processes (default: false, only removes exited) |

## Usage Examples

```
Start a dev server with 'bun run dev' in the background

List all background processes

Read the last 100 lines from process 'bun-1'

Wait for process 'bun-1' to finish, with a 5 minute default timeout

Send 'q' to process 'bun-1' to quit

Kill process 'bun-1'
```

## Notes

- Processes are tracked per OpenCode session and only include those started by this tool
- Output is buffered (last 500 lines by default)
- Auto-generated IDs use the command name (e.g., `bun-1`, `node-2`)
- `background_process_wait` is for finite processes. For servers and watchers, use `background_process_read` to verify readiness and `background_process_kill` when finished.
- This plugin does not walk or manage the host process tree. It only controls processes launched through `background_process_launch`.

## License

MIT
