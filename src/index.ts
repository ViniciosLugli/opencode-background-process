import { type Hooks, type Plugin, type ToolContext, tool } from "@opencode-ai/plugin"
import { readdirSync, readFileSync } from "node:fs"

import { createBundledSkillsHook } from "./skills"

interface ProcessInfo {
  id: string
  command: string
  proc: ReturnType<typeof Bun.spawn>
  exitPromise: Promise<number>
  outputPromise: Promise<void>
  output: string[]
  outputState: OutputState
  maxOutputLines: number
  startedAt: Date
  cwd: string
  exited: boolean
  exitCode: number | null
  treeSnapshot: number[] | null
}

type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT"
type WaitMode = "all" | "any"
type OutputStreamName = "stdout" | "stderr"

interface OutputStreamState {
  pending: string
  prefix: string
  carriageReturn: boolean
}

interface OutputState {
  stdout: OutputStreamState
  stderr: OutputStreamState
}

const processes = new Map<string, ProcessInfo>()

const DEFAULT_WAIT_TIMEOUT_SECONDS = 5 * 60
const MAX_WAIT_TIMEOUT_SECONDS = 10 * 60
const HEARTBEAT_INTERVAL_SECONDS = 2 * 60
const DEFAULT_OUTPUT_LINES = 50
const DEFAULT_MAX_OUTPUT_LINES = 500
const MAX_OUTPUT_LINES = 5000
const KILL_WAIT_MS = 2_000
const CLEANUP_TERM_WAIT_MS = 2_000
const CLEANUP_KILL_WAIT_MS = 2_000
const OUTPUT_DRAIN_WAIT_MS = 1_000
const WAIT_OBSERVER_POLL_MS = 250
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const PROC_POLL_INTERVAL_MS = 50

let processCounter = 0

function generateId(command: string): string {
  const shortCmd = command.split(" ")[0].split("/").pop() || "proc"
  return `${shortCmd}-${++processCounter}`
}

function appendOutput(info: ProcessInfo, data: string) {
  const lines = data.split("\n")
  for (const line of lines) {
    pushOutputLine(info, line)
  }
}

function pushOutputLine(info: ProcessInfo, line: string) {
  if (!line.trim()) return
  info.output.push(line)
  if (info.output.length > info.maxOutputLines) {
    info.output.shift()
  }
}

function getProcessStatus(info: ProcessInfo): string {
  if (info.exited) {
    if (isProcessGroupAlive(info)) {
      return `exited (code ${info.exitCode}, process group still running)`
    }
    return `exited (code ${info.exitCode})`
  }
  return "running"
}

function getRuntimeSeconds(info: ProcessInfo): number {
  return Math.round((Date.now() - info.startedAt.getTime()) / 1000)
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  if (remainingSeconds === 0) return `${minutes}m`
  return `${minutes}m ${remainingSeconds}s`
}

function formatProcessSummary(info: ProcessInfo): string[] {
  return [
    `ID: ${info.id}`,
    `PID: ${info.proc.pid}`,
    `Status: ${getProcessStatus(info)}`,
    `Runtime: ${formatDuration(getRuntimeSeconds(info))}`,
    `Command: ${info.command}`,
    `CWD: ${info.cwd}`,
  ]
}

function formatObserverSummary(targets: ProcessInfo[]): string[] {
  return targets.flatMap((info, index) => {
    const prefix = targets.length > 1 ? `${index + 1}. ` : ""
    const continuationPrefix = targets.length > 1 ? "   " : ""
    return formatProcessSummary(info).map((line, lineIndex) => `${lineIndex === 0 ? prefix : continuationPrefix}${line}`)
  })
}

function formatRecentOutput(info: ProcessInfo, lines: number): string {
  const output = getOutputSnapshot(info).slice(-lines)
  if (output.length === 0) return "No output captured."
  return output.join("\n")
}

function getOutputSnapshot(info: ProcessInfo): string[] {
  const snapshot = [...info.output]
  appendPendingSnapshotLine(snapshot, info.outputState.stdout)
  appendPendingSnapshotLine(snapshot, info.outputState.stderr)
  return snapshot
}

function clearOutput(info: ProcessInfo) {
  info.output = []
  info.outputState.stdout.pending = ""
  info.outputState.stderr.pending = ""
  info.outputState.stdout.carriageReturn = false
  info.outputState.stderr.carriageReturn = false
}

function appendPendingSnapshotLine(snapshot: string[], state: OutputStreamState) {
  if (!state.pending.trim()) return
  snapshot.push(`${state.prefix}${state.pending}`)
}

function appendStreamOutput(info: ProcessInfo, streamName: OutputStreamName, data: string) {
  const state = info.outputState[streamName]
  const text = data.replace(ANSI_ESCAPE_PATTERN, "")

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (state.carriageReturn) {
      state.carriageReturn = false
      if (char === "\n") {
        flushStreamOutput(info, streamName)
        continue
      }
      if (char === "\r") {
        state.carriageReturn = true
        continue
      }
      state.pending = ""
    }

    if (char === "\r") {
      state.carriageReturn = true
      continue
    }

    if (char === "\n") {
      flushStreamOutput(info, streamName)
      continue
    }

    if (char === "\b") {
      state.pending = state.pending.slice(0, -1)
      continue
    }

    if (isIgnoredControlCharacter(char)) continue
    state.pending += char
  }
}

function flushStreamOutput(info: ProcessInfo, streamName: OutputStreamName) {
  const state = info.outputState[streamName]
  if (state.pending.trim()) {
    pushOutputLine(info, `${state.prefix}${state.pending}`)
  }
  state.pending = ""
  state.carriageReturn = false
}

function isIgnoredControlCharacter(char: string): boolean {
  if (char === "\t") return false
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}

function updateWaitMetadata(
  context: ToolContext,
  info: ProcessInfo,
  title: string,
  extra: Record<string, unknown> = {},
) {
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
  })
}

function normalizeWaitTimeout(timeoutSeconds: number | undefined): number {
  const value = timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS
  if (!Number.isFinite(value) || value < 1 || value > MAX_WAIT_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be between 1 and ${MAX_WAIT_TIMEOUT_SECONDS}.`)
  }
  return Math.round(value)
}

function normalizeOutputLines(lines: number | undefined, defaultLines = DEFAULT_OUTPUT_LINES): number {
  const value = lines ?? defaultLines
  if (!Number.isFinite(value) || value < 1 || value > MAX_OUTPUT_LINES) {
    throw new Error(`lines must be between 1 and ${MAX_OUTPUT_LINES}.`)
  }
  return Math.round(value)
}

function normalizeWaitMode(mode: WaitMode | undefined): WaitMode {
  return mode ?? "all"
}

function normalizeWaitTargets(id: string | undefined, ids: string[] | undefined): ProcessInfo[] {
  const requested = [id, ...(ids ?? [])].filter((value): value is string => typeof value === "string" && value.length > 0)
  const uniqueIds = Array.from(new Set(requested))

  if (uniqueIds.length === 0) {
    throw new Error("Provide id for one process or ids for multiple processes.")
  }

  const missing = uniqueIds.filter((processId) => !processes.has(processId))
  if (missing.length > 0) {
    const available = Array.from(processes.keys())
    throw new Error(
      `No process found with ID${missing.length === 1 ? "" : "s"} "${missing.join(", ")}". Available processes: ${
        available.length ? available.join(", ") : "none"
      }`,
    )
  }

  return uniqueIds.map((processId) => processes.get(processId)!)
}

function signalToNumber(signal: KillSignal): number {
  if (signal === "SIGKILL") return 9
  if (signal === "SIGINT") return 2
  return 15
}

function isLinux(): boolean {
  return process.platform === "linux"
}

function isErrnoException(value: unknown, code?: string): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    typeof (value as NodeJS.ErrnoException).code === "string" &&
    (code === undefined || (value as NodeJS.ErrnoException).code === code)
  )
}

interface ProcStat {
  pid: number
  ppid: number
  pgrp: number
}

function readProcStat(pid: number): ProcStat | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterComm = raw.slice(raw.lastIndexOf(")") + 2)
    const fields = afterComm.trim().split(/\s+/)
    const state = fields[0]
    if (state === "Z") return null
    const ppid = Number(fields[1])
    const pgrp = Number(fields[2])
    if (!Number.isFinite(ppid) || !Number.isFinite(pgrp)) return null
    return { pid, ppid, pgrp }
  } catch {
    return null
  }
}

function enumerateProcessTree(rootPid: number): number[] {
  if (!isLinux()) return [rootPid]
  const root = readProcStat(rootPid)
  if (!root) return [rootPid]

  const all: Map<number, ProcStat> = new Map()
  all.set(rootPid, root)

  let procEntries: string[] = []
  try {
    procEntries = readdirSync("/proc")
  } catch {
    return [rootPid]
  }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === rootPid) continue
    const stat = readProcStat(pid)
    if (!stat) continue
    all.set(pid, stat)
  }

  const result = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const [pid, stat] of all) {
      if (result.has(pid)) continue
      const isChildOfCurrent = stat.ppid === current
      const sharesRootGroup = stat.pgrp === rootPid && stat.pgrp !== stat.pid
      if (isChildOfCurrent || sharesRootGroup) {
        result.add(pid)
        queue.push(pid)
      }
    }
  }

  return Array.from(result)
}

function signalOnePid(pid: number, signal: KillSignal): "ok" | "esrch" | "eperm" | "error" {
  try {
    process.kill(pid, signalToNumber(signal))
    return "ok"
  } catch (error) {
    if (isErrnoException(error, "ESRCH")) return "esrch"
    if (isErrnoException(error, "EPERM")) return "eperm"
    return "error"
  }
}

function signalProcessGroup(info: ProcessInfo, signal: KillSignal): { ok: true } | { ok: false; error: unknown } {
  const leaderPid = info.proc.pid
  if (typeof leaderPid !== "number" || !Number.isFinite(leaderPid)) {
    return { ok: false, error: new Error("Process PID is not available.") }
  }

  // Snapshot the descendant tree BEFORE signaling. Once the leader dies, detached
  // children (setsid daemons, privilege-dropping services) reparent to init and
  // become unfindable via /proc PPID walks. Capturing up front avoids that race.
  if (!info.treeSnapshot || info.treeSnapshot.length === 0) {
    info.treeSnapshot = enumerateProcessTree(leaderPid)
  }
  const tree = info.treeSnapshot

  let signaledAny = false
  let lastError: unknown

  // Fast path: signal the whole process group in one syscall. This reaches every
  // member that shares the leader's PGID. Detached descendants (different PGID)
  // are caught by the per-PID pass below.
  try {
    process.kill(-leaderPid, signal)
    signaledAny = true
  } catch (groupError) {
    if (isErrnoException(groupError, "ESRCH")) {
      // Leader's group is already empty; per-PID pass below handles survivors.
    } else {
      // EPERM or other: whole-group failed (e.g. a member we can't signal).
      // Fall through to per-PID delivery so signalable members still get hit.
      lastError = groupError
    }
  }

  // Per-PID pass: reaches descendants that left the leader's process group
  // (setsid/daemon services) and bypasses atomic EPERM on whole-group kills.
  for (const pid of tree) {
    const result = signalOnePid(pid, signal)
    if (result === "ok") signaledAny = true
    else if (result !== "esrch" && result !== "eperm") lastError = new Error(`signal ${signal} to ${pid}: ${result}`)
  }

  if (signaledAny) return { ok: true }
  if (lastError) return { ok: false, error: lastError }
  // Everything in the tree was already dead (ESRCH) — treat as success.
  return { ok: true }
}

function isProcessGroupAlive(info: ProcessInfo): boolean {
  const leaderPid = info.proc.pid
  if (typeof leaderPid !== "number" || !Number.isFinite(leaderPid)) return false

  try {
    process.kill(-leaderPid, 0)
    return true
  } catch (groupError) {
    if (isErrnoException(groupError, "ESRCH")) {
      // Leader's own process group is empty, but detached descendants (setsid
      // daemons) may still be alive in other groups. Check the cached snapshot
      // captured at signal time, since /proc PPID walks fail after reparenting.
      const tree = info.treeSnapshot ?? enumerateProcessTree(leaderPid)
      for (const pid of tree) {
        try {
          process.kill(pid, 0)
          return true
        } catch (pidError) {
          if (isErrnoException(pidError, "ESRCH")) continue
          if (isErrnoException(pidError, "EPERM")) return true
          return true
        }
      }
      return false
    }
    if (isErrnoException(groupError, "EPERM")) {
      const tree = info.treeSnapshot ?? enumerateProcessTree(leaderPid)
      for (const pid of tree) {
        try {
          process.kill(pid, 0)
          return true
        } catch (pidError) {
          if (isErrnoException(pidError, "ESRCH")) continue
          if (isErrnoException(pidError, "EPERM")) return true
          return true
        }
      }
      return false
    }
    return true
  }
}

function isProcessTerminated(info: ProcessInfo): boolean {
  return info.exited && !isProcessGroupAlive(info)
}

async function waitForTrackedTermination(info: ProcessInfo, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isProcessTerminated(info)) return true
    await Bun.sleep(PROC_POLL_INTERVAL_MS)
  }
  return isProcessTerminated(info)
}

async function waitForOutputDrain(info: ProcessInfo): Promise<void> {
  await Promise.race([info.outputPromise, Bun.sleep(OUTPUT_DRAIN_WAIT_MS)])
}

async function waitForOutputDrains(infos: ProcessInfo[]) {
  await Promise.all(infos.map((info) => waitForOutputDrain(info)))
}

function formatProcessList(): string {
  if (processes.size === 0) {
    return "No background processes running."
  }

  const lines: string[] = ["Background Processes:", ""]
  for (const [id, info] of processes) {
    const status = getProcessStatus(info)
    const pid = info.proc.pid
    lines.push(`[${id}] PID: ${pid} | Status: ${status} | Runtime: ${formatDuration(getRuntimeSeconds(info))}`)
    lines.push(`    Command: ${info.command}`)
    lines.push(`    CWD: ${info.cwd}`)
    lines.push("")
  }
  return lines.join("\n")
}

async function streamToOutput(stream: ReadableStream<Uint8Array> | null, info: ProcessInfo, streamName: OutputStreamName) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        appendStreamOutput(info, streamName, decoder.decode())
        flushStreamOutput(info, streamName)
        break
      }
      const text = decoder.decode(value, { stream: true })
      appendStreamOutput(info, streamName, text)
    }
  } catch {
    // Stream closed
  } finally {
    flushStreamOutput(info, streamName)
  }
}

function getCompletedTargets(targets: ProcessInfo[]): ProcessInfo[] {
  return targets.filter(isProcessTerminated)
}

function shouldFinishObserver(targets: ProcessInfo[], completed: ProcessInfo[], mode: WaitMode): boolean {
  if (mode === "any") return completed.length > 0
  return completed.length === targets.length
}

function formatTargetIds(targets: ProcessInfo[]): string {
  return targets.map((info) => info.id).join(", ")
}

function formatObserverHeartbeat(targets: ProcessInfo[], completed: ProcessInfo[], remainingSeconds: number): string {
  const pending = targets.filter((info) => !completed.includes(info))
  return `[wait] Process observer still waiting after ${formatDuration(
    Math.max(...targets.map(getRuntimeSeconds)),
  )}. Completed ${completed.length}/${targets.length}. Pending: ${formatTargetIds(pending)}. Timeout in ${formatDuration(
    remainingSeconds,
  )}.`
}

function appendHeartbeatToPendingTargets(targets: ProcessInfo[], completed: ProcessInfo[], heartbeat: string) {
  for (const info of targets) {
    if (!completed.includes(info)) appendOutput(info, heartbeat)
  }
}

function compactLines(lines: string[]): string {
  return lines.filter((line, index, array) => line !== "" || array[index - 1] !== "").join("\n")
}

function formatWaitResponse(
  intro: string,
  mode: WaitMode,
  completedIds: string[],
  pendingIds: string[],
  summary: string[],
  heartbeatLines: string[],
  recentOutputBlocks: string[],
): string {
  return compactLines([
    intro,
    `Mode: ${mode}`,
    `Completed: ${completedIds.length ? completedIds.join(", ") : "none"}`,
    `Pending: ${pendingIds.length ? pendingIds.join(", ") : "none"}`,
    "",
    ...summary,
    "",
    "Heartbeats:",
    ...heartbeatLines,
    "",
    ...recentOutputBlocks,
  ])
}

async function waitForObservedProcesses(
  targets: ProcessInfo[],
  mode: WaitMode,
  timeoutSeconds: number,
  abort: AbortSignal,
  onHeartbeat: (heartbeat: string, remainingSeconds: number, completed: ProcessInfo[]) => void,
): Promise<{ result: "completed" | "timeout" | "aborted"; completed: ProcessInfo[]; heartbeats: string[] }> {
  const startedAt = Date.now()
  const deadline = startedAt + timeoutSeconds * 1000
  const heartbeats: string[] = []
  let nextHeartbeatAt = startedAt + HEARTBEAT_INTERVAL_SECONDS * 1000

  while (true) {
    const completed = getCompletedTargets(targets)
    if (shouldFinishObserver(targets, completed, mode)) {
      await waitForOutputDrains(completed)
      return { result: "completed", completed, heartbeats }
    }

    if (abort.aborted) return { result: "aborted", completed, heartbeats }

    const now = Date.now()
    const remainingMs = deadline - now
    if (remainingMs <= 0) return { result: "timeout", completed, heartbeats }

    if (now >= nextHeartbeatAt) {
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
      const heartbeat = formatObserverHeartbeat(targets, completed, remainingSeconds)
      heartbeats.push(heartbeat)
      appendHeartbeatToPendingTargets(targets, completed, heartbeat)
      onHeartbeat(heartbeat, remainingSeconds, completed)
      nextHeartbeatAt += HEARTBEAT_INTERVAL_SECONDS * 1000
    }

    const waitMs = Math.min(WAIT_OBSERVER_POLL_MS, remainingMs, Math.max(1, nextHeartbeatAt - now))
    await Promise.race([
      Bun.sleep(waitMs),
      ...targets.filter((info) => !info.exited).map((info) => info.exitPromise.then(() => undefined)),
    ])
  }
}

export const BackgroundProcessPlugin: Plugin = async ({ directory }) => {
  const skillsHook = createBundledSkillsHook()
  const config: Hooks["config"] = async (value) => {
    await skillsHook.config?.(value)
  }

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
          const cwd = args.cwd || directory
          const id = args.id || generateId(args.command)

          if (processes.has(id)) {
            return `Error: Process with ID "${id}" already exists. Use a different ID or kill the existing process first.`
          }

          let maxOutputLines: number
          try {
            maxOutputLines = normalizeOutputLines(args.maxOutputLines, DEFAULT_MAX_OUTPUT_LINES)
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }

          const proc = Bun.spawn(["sh", "-c", args.command], {
            cwd,
            detached: true,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          })

          let info: ProcessInfo
          const exitPromise = proc.exited.then((code) => {
            info.exited = true
            info.exitCode = code
            appendOutput(info, `[exit] Process exited with code ${code}`)
            return code
          })

          info = {
            id,
            command: args.command,
            proc,
            exitPromise,
            outputPromise: Promise.resolve(),
            output: [],
            outputState: {
              stdout: { pending: "", prefix: "", carriageReturn: false },
              stderr: { pending: "", prefix: "[stderr] ", carriageReturn: false },
            },
            maxOutputLines,
            startedAt: new Date(),
            cwd,
            exited: false,
            exitCode: null,
            treeSnapshot: null,
          }

          info.outputPromise = Promise.all([
            streamToOutput(proc.stdout, info, "stdout"),
            streamToOutput(proc.stderr, info, "stderr"),
          ]).then(() => undefined)

          processes.set(id, info)

          // Wait briefly to catch immediate errors
          await Bun.sleep(100)

          if (info.exited) {
            await waitForOutputDrain(info)
            return `Process "${id}" started but exited immediately with code ${info.exitCode}.\nOutput:\n${getOutputSnapshot(info).join("\n")}`
          }

          return `Background process started successfully.
ID: ${id}
PID: ${proc.pid}
Command: ${args.command}
CWD: ${cwd}

Use background_process_read to see output, or background_process_kill to stop it.`
        },
      }),

      background_process_list: tool({
        description:
          "List background processes started by this tool in the current session (NOT system processes). You MUST NOT expect host process visibility. Shows running and recently exited processes with status, PID, runtime, and command.",
        args: {},
        async execute() {
          return formatProcessList()
        },
      }),

      background_process_read: tool({
        description:
          "Read the captured output from a background process started by this tool. You SHOULD use this to verify long-running startup before assuming readiness. Returns the most recent lines from the output buffer.",
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
          const info = processes.get(args.id)
          if (!info) {
            const available = Array.from(processes.keys())
            return `Error: No process found with ID "${args.id}". Available processes: ${available.length ? available.join(", ") : "none"}`
          }

          const status = getProcessStatus(info)
          let lines: number
          try {
            lines = normalizeOutputLines(args.lines)
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }

          const output = getOutputSnapshot(info).slice(-lines)

          if (args.clear) {
            clearOutput(info)
          }

          if (output.length === 0) {
            return `Process "${args.id}" (${status}): No output captured yet.`
          }

          const header = `Process "${args.id}" (${status}) - Last ${output.length} lines:`
          return `${header}\n${"─".repeat(50)}\n${output.join("\n")}`
        },
      }),

      background_process_wait: tool({
        description:
          "Wait for one or more tracked background processes to finish. Use id for a single process or ids for multiple processes. mode=all waits for every target; mode=any returns when the first target finishes. The wait is bounded, supports aborts, records heartbeat entries every 2 minutes while waiting, and never kills processes on timeout.",
        args: {
          id: tool.schema.string().optional().describe("Single process ID to wait for"),
          ids: tool.schema.array(tool.schema.string()).optional().describe("Process IDs to observe together"),
          mode: tool.schema
            .enum(["all", "any"])
            .optional()
            .default("all")
            .describe("Wait mode for multiple processes: all or any (default: all)"),
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
          let targets: ProcessInfo[]
          let timeoutSeconds: number
          let lines: number
          let mode: WaitMode
          try {
            targets = normalizeWaitTargets(args.id, args.ids)
            mode = normalizeWaitMode(args.mode)
            timeoutSeconds = normalizeWaitTimeout(args.timeoutSeconds)
            lines = normalizeOutputLines(args.lines)
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`
          }

          const titleTarget = targets.length === 1 ? targets[0].id : `${targets.length} processes`
          updateWaitMetadata(context, targets[0], `Waiting for ${titleTarget}`, {
            ids: targets.map((info) => info.id),
            mode,
            timeoutSeconds,
            remainingSeconds: timeoutSeconds,
            heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
          })

          const wait = await waitForObservedProcesses(
            targets,
            mode,
            timeoutSeconds,
            context.abort,
            (heartbeat, remainingSeconds, completed) => {
              updateWaitMetadata(context, targets[0], `Still waiting for ${titleTarget}`, {
                ids: targets.map((info) => info.id),
                completedIds: completed.map((info) => info.id),
                pendingIds: targets.filter((info) => !completed.includes(info)).map((info) => info.id),
                mode,
                heartbeat,
                remainingSeconds,
                timeoutSeconds,
                heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
              })
            },
          )

          const completedIds = wait.completed.map((info) => info.id)
          const pending = targets.filter((info) => !wait.completed.includes(info))
          const pendingIds = pending.map((info) => info.id)
          const summary = formatObserverSummary(targets)
          const heartbeatLines =
            wait.heartbeats.length > 0 ? wait.heartbeats.map((line) => `- ${line}`) : ["No heartbeat was needed."]
          const recentOutputBlocks = targets.flatMap((info) => [
            `Recent output for "${info.id}" (${lines} line limit):`,
            formatRecentOutput(info, lines),
            "",
          ])

          if (wait.result === "timeout") {
            updateWaitMetadata(context, targets[0], `Wait timed out for ${titleTarget}`, {
              ids: targets.map((info) => info.id),
              completedIds,
              pendingIds,
              mode,
              result: wait.result,
              timeoutSeconds,
            })
            const intro =
              targets.length === 1
                ? `Timed out waiting for process "${targets[0].id}" after ${formatDuration(timeoutSeconds)}. The process is still tracked and was not killed.`
                : `Timed out waiting for ${titleTarget} after ${formatDuration(timeoutSeconds)}. Processes are still tracked and were not killed.`
            return formatWaitResponse(intro, mode, completedIds, pendingIds, summary, heartbeatLines, recentOutputBlocks)
          }

          if (wait.result === "aborted") {
            updateWaitMetadata(context, targets[0], `Wait aborted for ${titleTarget}`, {
              ids: targets.map((info) => info.id),
              completedIds,
              pendingIds,
              mode,
              result: wait.result,
              timeoutSeconds,
            })
            const intro =
              targets.length === 1
                ? `Stopped waiting for process "${targets[0].id}" because the tool call was aborted. The process was not killed.`
                : `Stopped waiting for ${titleTarget} because the tool call was aborted. Processes were not killed.`
            return formatWaitResponse(intro, mode, completedIds, pendingIds, summary, heartbeatLines, recentOutputBlocks)
          }

          updateWaitMetadata(context, targets[0], `Finished waiting for ${titleTarget}`, {
            ids: targets.map((info) => info.id),
            completedIds,
            pendingIds,
            mode,
            result: wait.result,
            timeoutSeconds,
          })

          const intro =
            targets.length === 1
              ? `Process "${targets[0].id}" finished.`
              : mode === "any"
                ? `At least one process finished: ${completedIds.join(", ")}.`
                : `All processes finished: ${completedIds.join(", ")}.`
          return formatWaitResponse(intro, mode, completedIds, pendingIds, summary, heartbeatLines, recentOutputBlocks)
        },
      }),

      background_process_write: tool({
        description:
          "Send input to a running background process started by this tool. You MUST NOT use this for system processes. Useful for interactive processes that accept commands.",
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
          const info = processes.get(args.id)
          if (!info) {
            return `Error: No process found with ID "${args.id}".`
          }

          if (info.exited) {
            return `Error: Process "${args.id}" has already exited.`
          }

          const newline = args.newline ?? true
          const data = newline ? `${args.input}\n` : args.input
          const stdin = info.proc.stdin
          if (!stdin || typeof stdin === "number") {
            return `Error: Process "${args.id}" stdin is not available.`
          }
          stdin.write(data)

          return `Sent input to process "${args.id}": ${JSON.stringify(args.input)}`
        },
      }),

      background_process_kill: tool({
        description:
          "Terminate a background process started by this tool. Sends signals to the launched process group, waits for confirmed termination, and only removes it from tracking after it is stopped. You MUST NOT use this to target system processes.",
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
          const info = processes.get(args.id)
          if (!info) {
            return `Error: No process found with ID "${args.id}".`
          }

          const status = getProcessStatus(info)
          if (isProcessTerminated(info)) {
            if (args.remove ?? false) {
              processes.delete(args.id)
              return `Process "${args.id}" already exited (${status}). Removed from tracking.`
            }
            return `Process "${args.id}" already exited (${status}). Use remove=true to clear it.`
          }

          const signal: KillSignal = args.signal ?? "SIGTERM"
          const remove = args.remove ?? false
          const sent = signalProcessGroup(info, signal)
          if (!sent.ok) {
            return `Error: Failed to send ${signal} to process "${args.id}": ${
              sent.error instanceof Error ? sent.error.message : String(sent.error)
            }`
          }

          const exited = await waitForTrackedTermination(info, KILL_WAIT_MS)

          const newStatus = getProcessStatus(info)
          if (!exited) {
            return `Signal ${signal} was sent to process "${args.id}", but it is still running (${newStatus}). It was not removed. Use signal=SIGKILL if it does not stop gracefully.`
          }

          await waitForOutputDrain(info)

          if (remove) {
            processes.delete(args.id)
            return `Process "${args.id}" terminated with ${signal} (${newStatus}). Removed from tracking.`
          }

          return `Process "${args.id}" terminated with ${signal} (${newStatus}).`
        },
      }),

      background_process_cleanup: tool({
        description:
          "Remove fully exited processes from tracking, or terminate all tracked process groups with SIGTERM followed by SIGKILL when needed. Only affects processes started by this tool; you MUST NOT expect system cleanup.",
        args: {
          killAll: tool.schema
            .boolean()
            .optional()
            .default(false)
            .describe("Kill all running processes before cleanup (default: false, only removes exited)"),
        },
        async execute(args) {
          const removed: string[] = []
          const killed: string[] = []

          const failed: string[] = []

          for (const [id, info] of processes) {
            if (isProcessTerminated(info)) {
              processes.delete(id)
              removed.push(id)
            } else if (args.killAll ?? false) {
              const term = signalProcessGroup(info, "SIGTERM")
              if (!term.ok) {
                failed.push(`${id} (SIGTERM failed)`)
                continue
              }

              let exited = await waitForTrackedTermination(info, CLEANUP_TERM_WAIT_MS)
              let signal: KillSignal = "SIGTERM"
              if (!exited) {
                const force = signalProcessGroup(info, "SIGKILL")
                if (!force.ok) {
                  failed.push(`${id} (SIGKILL failed)`)
                  continue
                }
                signal = "SIGKILL"
                exited = await waitForTrackedTermination(info, CLEANUP_KILL_WAIT_MS)
              }

              if (exited) {
                await waitForOutputDrain(info)
                killed.push(`${id} (${signal})`)
                processes.delete(id)
              } else {
                failed.push(`${id} (still running)`)
              }
            }
          }

          const parts: string[] = []
          if (killed.length) parts.push(`Killed: ${killed.join(", ")}`)
          if (removed.length) parts.push(`Removed: ${removed.join(", ")}`)
          if (failed.length) parts.push(`Failed: ${failed.join(", ")}`)
          if (parts.length === 0) parts.push("No processes to clean up.")

          return parts.join("\n")
        },
      }),
    },
  }
}

export default BackgroundProcessPlugin
