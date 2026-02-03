# opencode-background-process

An OpenCode plugin for managing background processes. Launch, monitor, and control long-running tasks like dev servers, watchers, and build processes.

![background-process jpg](https://github.com/user-attachments/assets/33b3199b-146e-49ae-9914-9d8e6b112de1)

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["@howaboua/opencode-background-process@latest"]
}
```

OpenCode automatically installs plugin dependencies at runtime.

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

Send 'q' to process 'bun-1' to quit

Kill process 'bun-1'
```

## Notes

- Processes are tracked per OpenCode session and only include those started by this tool
- Output is buffered (last 500 lines by default)
- Auto-generated IDs use the command name (e.g., `bun-1`, `npm-2`)

## License

MIT
