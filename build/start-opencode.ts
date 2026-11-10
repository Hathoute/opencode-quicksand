/** Starts the sandbox, a persistent OpenCode init shell, then the embedder.
 * Ctrl+C stops them gracefully in reverse order. */

import { existsSync, statSync } from "node:fs"
import path from "path"
import { PROJECT_ROOT } from "./common"
import { CONFIG_FILE, config } from "./config"

const sandboxInitScript = config.sandbox.initScript
const opencodeInitScript = config.opencode.initScript
for (const [name, script] of [
  ["sandbox.initScript", sandboxInitScript],
  ["opencode.initScript", opencodeInitScript],
] as const) {
  if (!existsSync(script) || !statSync(script).isFile())
    throw new Error(`${name} does not exist or is not a file: ${script}`)
}

let sandbox: ReturnType<typeof startSandbox> | undefined
let opencodeInit: ReturnType<typeof spawnOpenCodeInit> | undefined
let embed: ReturnType<typeof startEmbed> | undefined
let signalCount = 0
let signal: (outcome: { type: "signal"; code: number }) => void = () => {}
const signaled = new Promise<{ type: "signal"; code: number }>((resolve) => (signal = resolve))

const onSignal = (name: NodeJS.Signals) => {
  signalCount++
  if (signalCount === 1) {
    signal({ type: "signal", code: name === "SIGINT" ? 130 : 143 })
    return
  }
  console.error("\nSecond signal received; forcing child processes to stop")
  if (embed) killTree(embed, "SIGKILL")
  if (opencodeInit) killTree(opencodeInit, "SIGKILL")
  if (sandbox) killTree(sandbox, "SIGKILL")
  process.exit(name === "SIGINT" ? 130 : 143)
}

const onSigint = () => onSignal("SIGINT")
const onSigterm = () => onSignal("SIGTERM")
process.on("SIGINT", onSigint)
process.on("SIGTERM", onSigterm)

let exitCode = 0
try {
  exitCode = await run()
} finally {
  await shutdown()
  process.off("SIGINT", onSigint)
  process.off("SIGTERM", onSigterm)
}

process.exitCode = exitCode

async function run() {
  console.log(`Starting sandbox and applying ${sandboxInitScript}...`)
  sandbox = startSandbox()

  let ready = () => {}
  const sandboxReady = new Promise<void>((resolve) => (ready = resolve))
  void forward(sandbox.stdout, process.stdout, "Sandbox is ready:", ready).catch((error) =>
    console.error("Failed to read sandbox output:", error),
  )
  void forward(sandbox.stderr, process.stderr).catch((error) => console.error("Failed to read sandbox errors:", error))

  const startup = await Promise.race([
    sandboxReady.then(() => ({ type: "ready" as const })),
    sandbox.exited.then((code) => ({ type: "sandbox-exit" as const, code })),
    signaled,
  ])

  if (startup.type !== "ready") {
    const code = startup.type === "signal" ? startup.code : startup.code || 1
    if (startup.type === "sandbox-exit") console.error(`Sandbox exited before becoming ready (${startup.code})`)
    return code
  }

  console.log(`Running OpenCode init from ${opencodeInitScript}...`)
  opencodeInit = await startOpenCodeInit()
  let initReady = () => {}
  const opencodeInitReady = new Promise<void>((resolve) => (initReady = resolve))
  void forward(opencodeInit.stdout, process.stdout, "OpenCode init is ready", initReady).catch((error) =>
    console.error("Failed to read OpenCode init output:", error),
  )
  void forward(opencodeInit.stderr, process.stderr).catch((error) =>
    console.error("Failed to read OpenCode init errors:", error),
  )

  const initialization = await Promise.race([
    opencodeInitReady.then(() => ({ type: "init-ready" as const })),
    opencodeInit.exited.then((code) => ({ type: "init-exit" as const, code })),
    sandbox.exited.then((code) => ({ type: "sandbox-exit" as const, code })),
    signaled,
  ])
  if (initialization.type !== "init-ready") {
    const code = initialization.type === "signal" ? initialization.code : initialization.code || 1
    if (initialization.type !== "signal")
      console.error(
        `${initialization.type === "init-exit" ? "OpenCode init shell" : "Sandbox"} ` +
          `exited during initialization (${initialization.code})`,
      )
    return code
  }

  console.log("Starting opencode embedder...")
  embed = startEmbed()
  const outcome = await Promise.race([
    embed.exited.then((code) => ({ type: "embed-exit" as const, code })),
    opencodeInit.exited.then((code) => ({ type: "init-exit" as const, code })),
    sandbox.exited.then((code) => ({ type: "sandbox-exit" as const, code })),
    signaled,
  ])
  const code = outcome.type === "signal" ? outcome.code : outcome.code || 1
  if (outcome.type !== "signal") {
    const name =
      outcome.type === "embed-exit" ? "Embedder" : outcome.type === "init-exit" ? "OpenCode init shell" : "Sandbox"
    console.error(`${name} exited unexpectedly (${outcome.code})`)
  }
  return code
}

function startSandbox() {
  return Bun.spawn([process.execPath, path.join(PROJECT_ROOT, "build", "start-sandbox.ts"), "--config", CONFIG_FILE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  })
}

function startEmbed() {
  return Bun.spawn([process.execPath, path.join(PROJECT_ROOT, "build", "start-embed.ts"), "--config", CONFIG_FILE], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    env: process.env,
  })
}

function spawnOpenCodeInit() {
  const bash = Bun.which("bash")
  if (bash === null) throw new Error("bash is required to run opencode.initScript")
  return Bun.spawn([bash, "--noprofile", "--norc"], {
    cwd: path.dirname(opencodeInitScript),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: process.env,
  })
}

async function startOpenCodeInit() {
  const proc = spawnOpenCodeInit()
  proc.stdin.write(`source ${shQuote(opencodeInitScript)}\nprintf 'OpenCode init is ready\\n'\n`)
  await proc.stdin.flush()
  return proc
}

async function forward(
  stream: ReadableStream<Uint8Array>,
  output: NodeJS.WriteStream,
  marker?: string,
  found: () => void = () => {},
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) return
    output.write(chunk.value)
    if (!marker) continue
    text += decoder.decode(chunk.value, { stream: true })
    if (text.includes(marker)) {
      found()
      marker = undefined
      continue
    }
    text = text.slice(-Math.max(marker.length * 2, 1024))
  }
}

async function shutdown() {
  if (embed?.exitCode === null) {
    console.log("Stopping opencode embedder...")
    killTree(embed, "SIGTERM")
    if (!(await exitedWithin(embed, 10_000))) {
      console.error("Embedder did not stop within 10 seconds; forcing it")
      killTree(embed, "SIGKILL")
      await embed.exited
    }
  }

  if (opencodeInit?.exitCode === null) {
    console.log("Stopping OpenCode init shell gracefully...")
    opencodeInit.stdin.write("exit\n")
    await opencodeInit.stdin.flush()
    opencodeInit.stdin.end()
    if (!(await exitedWithin(opencodeInit, 30_000))) {
      console.error("OpenCode init shell did not exit within 30 seconds; terminating it")
      killTree(opencodeInit, "SIGTERM")
      if (!(await exitedWithin(opencodeInit, 10_000))) killTree(opencodeInit, "SIGKILL")
      await opencodeInit.exited
    }
  }

  if (sandbox?.exitCode === null) {
    console.log("Closing sandbox gracefully...")
    sandbox.stdin.write("\n")
    await sandbox.stdin.flush()
    sandbox.stdin.end()
    if (!(await exitedWithin(sandbox, 30_000))) {
      console.error("Sandbox did not close within 30 seconds; terminating it")
      killTree(sandbox, "SIGTERM")
      if (!(await exitedWithin(sandbox, 10_000))) killTree(sandbox, "SIGKILL")
      await sandbox.exited
    }
  }
}

function shQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function killTree(proc: { pid: number; kill: (signal?: NodeJS.Signals | number) => void }, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    proc.kill(signal)
    return
  }
  try {
    process.kill(-proc.pid, signal)
  } catch {
    proc.kill(signal)
  }
}

async function exitedWithin(proc: { exited: Promise<number> }, milliseconds: number) {
  return Promise.race([proc.exited.then(() => true), Bun.sleep(milliseconds).then(() => false)])
}
