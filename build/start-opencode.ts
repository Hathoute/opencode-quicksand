/** Starts the sandbox followed by the opencode embedder. Ctrl+C stops the
 * embedder first, then sends Enter to the sandbox for a graceful VM shutdown. */

import { existsSync, statSync } from "node:fs"
import path from "path"
import { PROJECT_ROOT } from "./common"
import { CONFIG_FILE, config } from "./config"

const initScript = config.sandbox.initScript
if (!existsSync(initScript) || !statSync(initScript).isFile())
  throw new Error(`sandbox.initScript does not exist or is not a file: ${initScript}`)

let initializer: ReturnType<typeof startInitSandbox> | undefined
let sandbox: ReturnType<typeof startSandbox> | undefined
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
  if (sandbox) killTree(sandbox, "SIGKILL")
  if (initializer) killTree(initializer, "SIGKILL")
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
  console.log(`Initializing sandbox image from ${initScript}...`)
  initializer = startInitSandbox()
  const initialization = await Promise.race([
    initializer.exited.then((code) => ({ type: "init-exit" as const, code })),
    signaled,
  ])
  if (initialization.type === "signal") return initialization.code
  if (initialization.code !== 0) {
    console.error(`Sandbox initialization failed (${initialization.code})`)
    return initialization.code || 1
  }

  console.log("Starting sandbox...")
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

  if (startup.type === "ready") {
    console.log("Starting opencode embedder...")
    embed = startEmbed()
    const outcome = await Promise.race([
      embed.exited.then((code) => ({ type: "embed-exit" as const, code })),
      sandbox.exited.then((code) => ({ type: "sandbox-exit" as const, code })),
      signaled,
    ])
    const code = outcome.type === "signal" ? outcome.code : outcome.code || 1
    if (outcome.type !== "signal")
      console.error(`${outcome.type === "embed-exit" ? "Embedder" : "Sandbox"} exited unexpectedly (${outcome.code})`)
    return code
  }

  const code = startup.type === "signal" ? startup.code : startup.code || 1
  if (startup.type === "sandbox-exit") console.error(`Sandbox exited before becoming ready (${startup.code})`)
  return code
}

function startInitSandbox() {
  return Bun.spawn([process.execPath, path.join(PROJECT_ROOT, "build", "init-sandbox.ts"), "--config", CONFIG_FILE], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  })
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

  if (initializer?.exitCode === null) {
    console.log("Stopping sandbox initialization...")
    killTree(initializer, "SIGTERM")
    if (!(await exitedWithin(initializer, 10_000))) killTree(initializer, "SIGKILL")
    await initializer.exited
  }
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
