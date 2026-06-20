import { tool } from "@opencode-ai/plugin";
import { createBundledSkillsHook } from "./skills";
const processes = new Map();
const DEFAULT_WAIT_TIMEOUT_SECONDS = 5 * 60;
const MAX_WAIT_TIMEOUT_SECONDS = 10 * 60;
const HEARTBEAT_INTERVAL_SECONDS = 2 * 60;
const DEFAULT_OUTPUT_LINES = 50;
const DEFAULT_MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_LINES = 5000;
let processCounter = 0;
function generateId(command) {
    const shortCmd = command.split(" ")[0].split("/").pop() || "proc";
    return `${shortCmd}-${++processCounter}`;
}
function appendOutput(info, data) {
    const lines = data.split("\n");
    for (const line of lines) {
        if (line.trim()) {
            info.output.push(line);
            if (info.output.length > info.maxOutputLines) {
                info.output.shift();
            }
        }
    }
}
function getProcessStatus(info) {
    if (info.exited) {
        return `exited (code ${info.exitCode})`;
    }
    return "running";
}
function getRuntimeSeconds(info) {
    return Math.round((Date.now() - info.startedAt.getTime()) / 1000);
}
function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes === 0)
        return `${remainingSeconds}s`;
    if (remainingSeconds === 0)
        return `${minutes}m`;
    return `${minutes}m ${remainingSeconds}s`;
}
function formatProcessSummary(info) {
    return [
        `ID: ${info.id}`,
        `PID: ${info.proc.pid}`,
        `Status: ${getProcessStatus(info)}`,
        `Runtime: ${formatDuration(getRuntimeSeconds(info))}`,
        `Command: ${info.command}`,
        `CWD: ${info.cwd}`,
    ];
}
function formatRecentOutput(info, lines) {
    const output = info.output.slice(-lines);
    if (output.length === 0)
        return "No output captured.";
    return output.join("\n");
}
function updateWaitMetadata(context, info, title, extra = {}) {
    context.metadata({
        title,
        metadata: {
            id: info.id,
            pid: info.proc.pid,
            command: info.command,
            cwd: info.cwd,
            status: getProcessStatus(info),
            runtimeSeconds: getRuntimeSeconds(info),
            ...extra,
        },
    });
}
function normalizeWaitTimeout(timeoutSeconds) {
    const value = timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
    if (!Number.isFinite(value) || value < 1 || value > MAX_WAIT_TIMEOUT_SECONDS) {
        throw new Error(`timeoutSeconds must be between 1 and ${MAX_WAIT_TIMEOUT_SECONDS}.`);
    }
    return Math.round(value);
}
function normalizeOutputLines(lines, defaultLines = DEFAULT_OUTPUT_LINES) {
    const value = lines ?? defaultLines;
    if (!Number.isFinite(value) || value < 1 || value > MAX_OUTPUT_LINES) {
        throw new Error(`lines must be between 1 and ${MAX_OUTPUT_LINES}.`);
    }
    return Math.round(value);
}
function formatProcessList() {
    if (processes.size === 0) {
        return "No background processes running.";
    }
    const lines = ["Background Processes:", ""];
    for (const [id, info] of processes) {
        const status = getProcessStatus(info);
        const pid = info.proc.pid;
        lines.push(`[${id}] PID: ${pid} | Status: ${status} | Runtime: ${formatDuration(getRuntimeSeconds(info))}`);
        lines.push(`    Command: ${info.command}`);
        lines.push(`    CWD: ${info.cwd}`);
        lines.push("");
    }
    return lines.join("\n");
}
async function streamToOutput(stream, info, prefix = "") {
    if (!stream)
        return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const text = decoder.decode(value, { stream: true });
            appendOutput(info, prefix ? `${prefix}${text}` : text);
        }
    }
    catch {
        // Stream closed
    }
}
function waitForNextEvent(info, seconds, abort) {
    if (info.exited)
        return Promise.resolve(info.exitCode ?? 0);
    if (abort.aborted)
        return Promise.resolve("aborted");
    return new Promise((resolve) => {
        let settled = false;
        let timeout;
        function settle(value) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            abort.removeEventListener("abort", onAbort);
            resolve(value);
        }
        const onAbort = () => settle("aborted");
        timeout = setTimeout(() => settle("heartbeat"), seconds * 1000);
        abort.addEventListener("abort", onAbort, { once: true });
        info.exitPromise.then((code) => settle(code));
    });
}
async function waitForProcessExit(info, timeoutSeconds, abort, onHeartbeat) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutSeconds * 1000;
    const heartbeats = [];
    let nextHeartbeatAt = startedAt + HEARTBEAT_INTERVAL_SECONDS * 1000;
    while (!info.exited) {
        const now = Date.now();
        const secondsUntilTimeout = Math.max(0, Math.ceil((deadline - now) / 1000));
        if (secondsUntilTimeout === 0)
            return { result: "timeout", heartbeats };
        const secondsUntilHeartbeat = Math.max(1, Math.ceil((nextHeartbeatAt - now) / 1000));
        const waitSeconds = Math.min(secondsUntilTimeout, secondsUntilHeartbeat);
        const result = await waitForNextEvent(info, waitSeconds, abort);
        if (typeof result === "number") {
            await info.outputPromise;
            return { result: "exited", heartbeats };
        }
        if (result === "aborted")
            return { result: "aborted", heartbeats };
        if (Date.now() >= nextHeartbeatAt && !info.exited) {
            const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            const heartbeat = `[wait] Process "${info.id}" still running after ${formatDuration(getRuntimeSeconds(info))}. Timeout in ${formatDuration(remainingSeconds)}.`;
            heartbeats.push(heartbeat);
            appendOutput(info, heartbeat);
            onHeartbeat(heartbeat, remainingSeconds);
            nextHeartbeatAt += HEARTBEAT_INTERVAL_SECONDS * 1000;
        }
    }
    await info.outputPromise;
    return { result: "exited", heartbeats };
}
export const BackgroundProcessPlugin = async ({ directory }) => {
    const skillsHook = createBundledSkillsHook();
    const config = async (value) => {
        await skillsHook.config?.(value);
    };
    return {
        config,
        tool: {
            background_process_launch: tool({
                description: `Launch a command as a background process. For long-running tasks (dev servers, watchers, builds) you MUST use this tool instead of blocking shell runs. Only processes launched via this tool are tracked. Returns the process ID for future reference.`,
                args: {
                    command: tool.schema.string().describe("The shell command to run in the background"),
                    cwd: tool.schema
                        .string()
                        .optional()
                        .describe("Working directory for the command (defaults to current directory)"),
                    id: tool.schema.string().optional().describe("Custom ID for this process (auto-generated if not provided)"),
                    maxOutputLines: tool.schema
                        .number()
                        .int()
                        .min(1)
                        .max(MAX_OUTPUT_LINES)
                        .optional()
                        .default(DEFAULT_MAX_OUTPUT_LINES)
                        .describe("Maximum output lines to keep in buffer (default: 500)"),
                },
                async execute(args) {
                    const cwd = args.cwd || directory;
                    const id = args.id || generateId(args.command);
                    if (processes.has(id)) {
                        return `Error: Process with ID "${id}" already exists. Use a different ID or kill the existing process first.`;
                    }
                    let maxOutputLines;
                    try {
                        maxOutputLines = normalizeOutputLines(args.maxOutputLines, DEFAULT_MAX_OUTPUT_LINES);
                    }
                    catch (error) {
                        return `Error: ${error instanceof Error ? error.message : String(error)}`;
                    }
                    const proc = Bun.spawn(["sh", "-c", args.command], {
                        cwd,
                        stdin: "pipe",
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    let info;
                    const exitPromise = proc.exited.then((code) => {
                        info.exited = true;
                        info.exitCode = code;
                        appendOutput(info, `[exit] Process exited with code ${code}`);
                        return code;
                    });
                    info = {
                        id,
                        command: args.command,
                        proc,
                        exitPromise,
                        outputPromise: Promise.resolve(),
                        output: [],
                        maxOutputLines,
                        startedAt: new Date(),
                        cwd,
                        exited: false,
                        exitCode: null,
                    };
                    info.outputPromise = Promise.all([
                        streamToOutput(proc.stdout, info),
                        streamToOutput(proc.stderr, info, "[stderr] "),
                    ]).then(() => undefined);
                    processes.set(id, info);
                    // Wait briefly to catch immediate errors
                    await Bun.sleep(100);
                    if (info.exited) {
                        await info.outputPromise;
                        return `Process "${id}" started but exited immediately with code ${info.exitCode}.\nOutput:\n${info.output.join("\n")}`;
                    }
                    return `Background process started successfully.
ID: ${id}
PID: ${proc.pid}
Command: ${args.command}
CWD: ${cwd}

Use background_process_read to see output, or background_process_kill to stop it.`;
                },
            }),
            background_process_list: tool({
                description: "List background processes started by this tool in the current session (NOT system processes). You MUST NOT expect host process visibility. Shows running and recently exited processes with status, PID, runtime, and command.",
                args: {},
                async execute() {
                    return formatProcessList();
                },
            }),
            background_process_read: tool({
                description: "Read the captured output from a background process started by this tool. You SHOULD use this to verify long-running startup before assuming readiness. Returns the most recent lines from the output buffer.",
                args: {
                    id: tool.schema.string().describe("The process ID to read output from"),
                    lines: tool.schema
                        .number()
                        .int()
                        .min(1)
                        .max(MAX_OUTPUT_LINES)
                        .optional()
                        .default(DEFAULT_OUTPUT_LINES)
                        .describe("Number of recent lines to return (default: 50)"),
                    clear: tool.schema.boolean().optional().default(false).describe("Clear the output buffer after reading"),
                },
                async execute(args) {
                    const info = processes.get(args.id);
                    if (!info) {
                        const available = Array.from(processes.keys());
                        return `Error: No process found with ID "${args.id}". Available processes: ${available.length ? available.join(", ") : "none"}`;
                    }
                    const status = getProcessStatus(info);
                    let lines;
                    try {
                        lines = normalizeOutputLines(args.lines);
                    }
                    catch (error) {
                        return `Error: ${error instanceof Error ? error.message : String(error)}`;
                    }
                    const output = info.output.slice(-lines);
                    if (args.clear) {
                        info.output = [];
                    }
                    if (output.length === 0) {
                        return `Process "${args.id}" (${status}): No output captured yet.`;
                    }
                    const header = `Process "${args.id}" (${status}) - Last ${output.length} lines:`;
                    return `${header}\n${"─".repeat(50)}\n${output.join("\n")}`;
                },
            }),
            background_process_wait: tool({
                description: "Wait for a tracked background process to finish. Use for finite commands that were launched in the background. The wait is bounded, supports aborts, records heartbeat entries every 2 minutes while waiting, and never kills the process on timeout.",
                args: {
                    id: tool.schema.string().describe("The process ID to wait for"),
                    timeoutSeconds: tool.schema
                        .number()
                        .int()
                        .min(1)
                        .max(MAX_WAIT_TIMEOUT_SECONDS)
                        .optional()
                        .default(DEFAULT_WAIT_TIMEOUT_SECONDS)
                        .describe("Maximum seconds to wait, from 1 to 600 (default: 300)"),
                    lines: tool.schema
                        .number()
                        .int()
                        .min(1)
                        .max(MAX_OUTPUT_LINES)
                        .optional()
                        .default(DEFAULT_OUTPUT_LINES)
                        .describe("Number of recent output lines to include in the result (default: 50)"),
                },
                async execute(args, context) {
                    const info = processes.get(args.id);
                    if (!info) {
                        const available = Array.from(processes.keys());
                        return `Error: No process found with ID "${args.id}". Available processes: ${available.length ? available.join(", ") : "none"}`;
                    }
                    let timeoutSeconds;
                    let lines;
                    try {
                        timeoutSeconds = normalizeWaitTimeout(args.timeoutSeconds);
                        lines = normalizeOutputLines(args.lines);
                    }
                    catch (error) {
                        return `Error: ${error instanceof Error ? error.message : String(error)}`;
                    }
                    updateWaitMetadata(context, info, `Waiting for ${info.id}`, {
                        timeoutSeconds,
                        remainingSeconds: timeoutSeconds,
                        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
                    });
                    const wait = await waitForProcessExit(info, timeoutSeconds, context.abort, (heartbeat, remainingSeconds) => {
                        updateWaitMetadata(context, info, `Still waiting for ${info.id}`, {
                            heartbeat,
                            remainingSeconds,
                            timeoutSeconds,
                            heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
                        });
                    });
                    const summary = formatProcessSummary(info);
                    const heartbeatLines = wait.heartbeats.length > 0 ? wait.heartbeats.map((line) => `- ${line}`) : ["No heartbeat was needed."];
                    const output = formatRecentOutput(info, lines);
                    if (wait.result === "timeout") {
                        updateWaitMetadata(context, info, `Wait timed out for ${info.id}`, {
                            result: wait.result,
                            timeoutSeconds,
                        });
                        return [
                            `Timed out waiting for process "${info.id}" after ${formatDuration(timeoutSeconds)}. The process is still tracked and was not killed.`,
                            "",
                            ...summary,
                            "",
                            "Heartbeats:",
                            ...heartbeatLines,
                            "",
                            `Recent output (${lines} line limit):`,
                            output,
                        ].join("\n");
                    }
                    if (wait.result === "aborted") {
                        updateWaitMetadata(context, info, `Wait aborted for ${info.id}`, {
                            result: wait.result,
                            timeoutSeconds,
                        });
                        return [
                            `Stopped waiting for process "${info.id}" because the tool call was aborted. The process was not killed.`,
                            "",
                            ...summary,
                            "",
                            "Heartbeats:",
                            ...heartbeatLines,
                            "",
                            `Recent output (${lines} line limit):`,
                            output,
                        ].join("\n");
                    }
                    updateWaitMetadata(context, info, `Finished ${info.id}`, {
                        result: wait.result,
                        exitCode: info.exitCode,
                        timeoutSeconds,
                    });
                    return [
                        `Process "${info.id}" finished.`,
                        "",
                        ...summary,
                        "",
                        "Heartbeats:",
                        ...heartbeatLines,
                        "",
                        `Recent output (${lines} line limit):`,
                        output,
                    ].join("\n");
                },
            }),
            background_process_write: tool({
                description: "Send input to a running background process started by this tool. You MUST NOT use this for system processes. Useful for interactive processes that accept commands.",
                args: {
                    id: tool.schema.string().describe("The process ID to send input to"),
                    input: tool.schema.string().describe("The input to send to the process stdin"),
                    newline: tool.schema
                        .boolean()
                        .optional()
                        .default(true)
                        .describe("Append a newline after the input (default: true)"),
                },
                async execute(args) {
                    const info = processes.get(args.id);
                    if (!info) {
                        return `Error: No process found with ID "${args.id}".`;
                    }
                    if (info.exited) {
                        return `Error: Process "${args.id}" has already exited.`;
                    }
                    const newline = args.newline ?? true;
                    const data = newline ? `${args.input}\n` : args.input;
                    const stdin = info.proc.stdin;
                    if (!stdin || typeof stdin === "number") {
                        return `Error: Process "${args.id}" stdin is not available.`;
                    }
                    stdin.write(data);
                    return `Sent input to process "${args.id}": ${JSON.stringify(args.input)}`;
                },
            }),
            background_process_kill: tool({
                description: "Kill a background process started by this tool. You MUST NOT use this to target system processes. Sends SIGTERM by default, or SIGKILL for force kill. Optionally removes the process from tracking.",
                args: {
                    id: tool.schema.string().describe("The process ID to kill"),
                    signal: tool.schema
                        .enum(["SIGTERM", "SIGKILL", "SIGINT"])
                        .optional()
                        .default("SIGTERM")
                        .describe("Signal to send (default: SIGTERM)"),
                    remove: tool.schema
                        .boolean()
                        .optional()
                        .default(false)
                        .describe("Remove process from tracking after killing (default: false)"),
                },
                async execute(args) {
                    const info = processes.get(args.id);
                    if (!info) {
                        return `Error: No process found with ID "${args.id}".`;
                    }
                    const status = getProcessStatus(info);
                    if (info.exited) {
                        if (args.remove ?? false) {
                            processes.delete(args.id);
                            return `Process "${args.id}" already exited (${status}). Removed from tracking.`;
                        }
                        return `Process "${args.id}" already exited (${status}). Use remove=true to clear it.`;
                    }
                    const signal = args.signal ?? "SIGTERM";
                    const remove = args.remove ?? false;
                    const signalNum = signal === "SIGKILL" ? 9 : signal === "SIGINT" ? 2 : 15;
                    info.proc.kill(signalNum);
                    // Wait for process to exit
                    await Bun.sleep(200);
                    const newStatus = getProcessStatus(info);
                    if (remove) {
                        processes.delete(args.id);
                        return `Process "${args.id}" killed with ${signal} (${newStatus}). Removed from tracking.`;
                    }
                    return `Process "${args.id}" killed with ${signal} (${newStatus}).`;
                },
            }),
            background_process_cleanup: tool({
                description: "Remove all exited processes from tracking, or kill all tracked processes and clean up. Only affects processes started by this tool; you MUST NOT expect system cleanup.",
                args: {
                    killAll: tool.schema
                        .boolean()
                        .optional()
                        .default(false)
                        .describe("Kill all running processes before cleanup (default: false, only removes exited)"),
                },
                async execute(args) {
                    const removed = [];
                    const killed = [];
                    for (const [id, info] of processes) {
                        if (info.exited) {
                            processes.delete(id);
                            removed.push(id);
                        }
                        else if (args.killAll ?? false) {
                            info.proc.kill(15); // SIGTERM
                            killed.push(id);
                            processes.delete(id);
                        }
                    }
                    const parts = [];
                    if (killed.length)
                        parts.push(`Killed: ${killed.join(", ")}`);
                    if (removed.length)
                        parts.push(`Removed: ${removed.join(", ")}`);
                    if (parts.length === 0)
                        parts.push("No processes to clean up.");
                    return parts.join("\n");
                },
            }),
        },
    };
};
export default BackgroundProcessPlugin;
//# sourceMappingURL=index.js.map