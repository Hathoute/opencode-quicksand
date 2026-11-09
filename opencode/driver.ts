import { Effect, PlatformError, Sink, Stream } from "effect"
import { ExitCode, make, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { existsSync } from "node:fs"
import path from "path"
import type { WorkspaceDriver } from "../packages/core/src/workspace/driver"
import type { EnvironmentDriver } from "../packages/core/src/environment/driver"
import type { FilesImpl } from "../packages/core/src/environment/files"
import { execDefaults } from "../packages/core/src/environment/exec-defaults"
import { linuxAdapter } from "./driver-linux"
import { macosAdapter } from "./driver-macos"
import { windowsAdapter } from "./driver-windows"

/** A guest command after host-shell translation. */
export interface GuestCommand {
  readonly command: string
  readonly args: string[]
}

/**
 * Host-platform quirks of the ssh driver. The shell tool resolves its shell
 * against the host platform and session paths are host-style, so everything
 * host-shaped that reaches the sandbox goes through this adapter first.
 */
export interface PlatformAdapter {
  /** value for ssh -o UserKnownHostsFile that discards host keys */
  readonly nullKnownHosts: string
  /** translate a host-shell invocation into the guest command to run */
  readonly guestShell: (command: string, args: ReadonlyArray<string>) => GuestCommand
  /** translate a host-style path onto the guest mount namespace */
  readonly toGuestPath: (value: string, map: PathMap) => string
}

export const platformAdapter = (): PlatformAdapter => {
  switch (process.platform) {
    case "win32":
      return windowsAdapter()
    case "darwin":
      return macosAdapter()
    case "linux":
      return linuxAdapter()
    default:
      throw new Error(`unsupported host platform: ${process.platform}`)
  }
}

const platform = platformAdapter()

const systemError = (method: string, cause: unknown) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "SshDriver",
    method,
    description: `ssh exec failed: ${String(cause)}`,
    cause,
  })

const toStream = (source: ReadableStream<Uint8Array>, method: string) =>
  Stream.fromReadableStream({ evaluate: () => source, onError: (cause) => systemError(method, cause) })

// set SSH_DRIVER_LOG=1 (run_opencode.ps1 does) to trace every ssh invocation
const debug = (message: string) => {
  if (process.env.SSH_DRIVER_LOG === undefined) return
  console.error(`[ssh-driver ${new Date().toISOString().slice(11, 23)}] ${message}`)
}

// quote a single argument for the remote POSIX shell
const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Without a TTY, long-running guest programs block-buffer stdout (4-8KB before
 * ssh sees anything). Wrap in stdbuf line-buffering when the guest has it so
 * lines reach the host streams as printed; pass through unchanged otherwise.
 * The file plane ("sh" scripts from execDefaults) is left byte-identical.
 */
const lineBuffered = (guest: GuestCommand): string => {
  const cmd = `${shQuote(guest.command)} ${guest.args.map(shQuote).join(" ")}`
  if (guest.command === "sh") return cmd
  return `if command -v stdbuf >/dev/null 2>&1; then exec stdbuf -oL -eL ${cmd}; else exec ${cmd}; fi`
}

export interface SshTarget {
  host: string
  port: number
  user: string
  /** path to an OpenSSH private key (BatchMode: no password prompts) */
  keyFile: string
}

/**
 * Maps the host directory backing a sandbox mount onto its guest path
 * (host ...\quicksand-example\data <-> guest /data). Session Locations keep the
 * host-style directory: config discovery, project resolution, and move
 * validation are host-side by design. Every path that reaches the sandbox is
 * translated here instead, so tool file ops and shell commands run against the
 * guest namespace while the model keeps seeing host-style absolute paths.
 */
export interface PathMap {
  host: string
  guest: string
}

/** host-style placement path -> guest path; guest-native paths pass through */
export const toGuest = (value: string, map: PathMap | undefined) => {
  if (map === undefined) return value
  return platform.toGuestPath(value, map)
}

/**
 * Spawner: every command becomes one `ssh` invocation on the sandbox VM.
 * cwd is translated through the path map, env/cwd are folded into the remote
 * command line (sshd has no --workdir/--env). stdin is discarded; stdout/stderr
 * stream back through the spawner.
 */
// Exported for streaming tests (poc/stream-test.ts).
export const sshSpawner = (target: SshTarget, map: PathMap | undefined): ChildProcessSpawner["Service"] =>  make((command) => {
    if (command._tag !== "StandardCommand")
      return Effect.die(new Error("PipedCommand is unsupported in the poc ssh driver"))

    const remote: string[] = []
    for (const [key, value] of Object.entries(command.options.env ?? {}))
      remote.push(`${key}=${shQuote(value)}`)
    const cwd = command.options.cwd !== undefined ? toGuest(command.options.cwd, map) : undefined
    if (cwd !== undefined) remote.push(`cd ${shQuote(cwd)} &&`)
    const guest = platform.guestShell(command.command, command.args)
    remote.push(lineBuffered(guest))

    // Host-key pinning: verify silently against the known_hosts beside the
    // identity when it exists (the embedder's boot ssh-keyscan wrote it).
    // Without the file (embedder started before the sandbox) accept-and-
    // discard, which prints "Warning: Permanently added …" into stderr on
    // EVERY invocation because the null file cannot store anything.
    const knownHosts = path.join(path.dirname(target.keyFile), "known_hosts")
    const hostKeyArgs = existsSync(knownHosts)
      ? ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"]
      : ["-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${platform.nullKnownHosts}`]

    const args = [
      "ssh", "-T", "-x",
      "-i", target.keyFile,
      "-o", "BatchMode=yes",
      ...hostKeyArgs,
      "-p", String(target.port),
      `${target.user}@${target.host}`,
      "--", remote.join(" "),
    ]

    debug(`spawn: ${remote.join(" ").slice(0, 300)}${remote.join(" ").length > 300 ? " …" : ""} (cwd=${cwd ?? "-"} stdin=${command.options.stdin !== undefined ? "stream" : "closed"})`)
    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    let outBytes = 0
    let errBytes = 0
    const stdout = toStream(proc.stdout, "stdout").pipe(
      Stream.tap((chunk) => Effect.sync(() => { outBytes += chunk.length })),
    )
    const stderr = toStream(proc.stderr, "stderr").pipe(
      Stream.tap((chunk) => Effect.sync(() => { errBytes += chunk.length })),
    )

    // execDefaults.write pipes file bytes through command.options.stdin into a
    // remote `cat > file`: pump the stream into Bun's stdin sink and always
    // close it so the guest sees EOF instead of waiting forever.
    const pump = command.options.stdin !== undefined
      ? Stream.runForEach(command.options.stdin, (chunk) =>
          Effect.sync(() => {
            try { proc.stdin?.write(chunk) } catch (cause) { debug(`stdin write failed: ${cause}`) }
          }),
        )
      : Effect.void
    Effect.runFork(pump.pipe(Effect.onExit(() => Effect.sync(() => proc.stdin?.end()))))

    return Effect.succeed(
      makeHandle({
        pid: ProcessId(proc.pid),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            try { proc.stdin?.write(chunk) } catch (cause) { debug(`stdin write failed: ${cause}`) }
          }),
        ),
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.map(Effect.promise(() => proc.exited), () => false),
        exitCode: Effect.map(Effect.promise(() => proc.exited), (code) => {
          debug(`exit: pid=${proc.pid} code=${code} stdout=${outBytes}B stderr=${errBytes}B`)
          return ExitCode(code)
        }),
        kill: () =>
          Effect.sync(() => {
            debug(`kill: pid=${proc.pid}`)
            proc.kill()
          }),
        unref: Effect.succeed(Effect.void),
      }),
    )
  })

// exec-defaults build every file op as `sh -c <script> sh <path> ...`, so the
// path is a typed argument at this boundary: translate it before delegation
// instead of sniffing argv inside the spawner.
const sshFiles = (target: SshTarget, map: PathMap | undefined): FilesImpl => {
  const files = execDefaults(sshSpawner(target, map))
  return {
    stat: (value) => files.stat(toGuest(value, map)),
    read: (value, range) => files.read(toGuest(value, map), range),
    write: (value, bytes) => files.write(toGuest(value, map), bytes),
    list: (value) => files.list(toGuest(value, map)),
    remove: (value) => files.remove(toGuest(value, map)),
    move: (from, to) => files.move(toGuest(from, map), toGuest(to, map)),
    mkdir: (value) => files.mkdir(toGuest(value, map)),
  }
}

export const sshWorkspaceDriver = (target: SshTarget, map?: PathMap): WorkspaceDriver.Interface => ({
  create: () => Effect.succeed({ binding: { ...target } }),
  connect: ({ binding }) => {
    const t = binding as Partial<SshTarget>
    const resolved: SshTarget =
      typeof t.host === "string" && typeof t.keyFile === "string"
        ? { host: t.host, port: Number(t.port), user: t.user ?? target.user, keyFile: t.keyFile }
        : target
    // The map comes from the embed env each boot and is stable for a given
    // sandbox setup, so it stays out of the persisted binding.
    return Effect.succeed({
      spawner: sshSpawner(resolved, map),
      overrides: sshFiles(resolved, map),
    } satisfies EnvironmentDriver.Driver)
  },
  suspendForIdle: () => Effect.void,
  destroy: () => Effect.void,
})
