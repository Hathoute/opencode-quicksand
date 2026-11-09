import { Context, Effect, Stream } from "effect"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "path"
import { EmbeddedHost } from "../packages/sdk/src/internal/host"
import { Bus } from "../packages/core/src/bus"
import { Workspace } from "../packages/core/src/workspace"
import { SessionEvent } from "../packages/schema/src/session-event"
import type { Session } from "../packages/schema/src/session"
import { sshWorkspaceDriver } from "./driver"
import type { PathMap, SshTarget } from "./driver"

const port = Number(process.env.PORT ?? 4096)

// sandbox VM defaults: quicksand ubuntu VM exposing sshd on host 127.0.0.1:2222
const sshTarget: SshTarget = {
  host: process.env.SSH_HOST ?? "localhost",
  port: Number(process.env.SSH_PORT ?? 2222),
  user: process.env.SSH_USER ?? "root",
  keyFile: process.env.SSH_KEY ?? "",
}

// The embedded host defaults to an in-memory database, so globally stored
// credentials (`opencode auth login`) are invisible here. Inject config
// instead: shell=bash makes the shell tool POSIX-facing (the ssh guest runs
// bash regardless of the host platform), and ZAI_API_KEY -> provider options.
const apiKey = process.env.ZAI_API_KEY
const config = {
  content: JSON.stringify({
    shell: "bash",
    ...(apiKey === undefined ? {} : { provider: { "zai-coding-plan": { options: { apiKey } } } }),
  }),
}

// host directory mounted at /data in the sandbox (defaults to the caller's
// CWD in build/start-embed.ts, matching sandbox.py's mount semantics).
// Sessions are placed here so tools execute against the sandbox while config
// discovery and project resolution stay host-side. Without it, sessions stay
// host-local (opencode's implicit-local default).
const hostDataDir = process.env.WORKSPACE_HOST_DIR

// Pin the sandbox's host key at every boot: ssh-keyscan writes it next to the
// identity so the driver's ssh invocations verify silently. With the previous
// UserKnownHostsFile=<null> accept-and-discard setup, ssh printed "Warning:
// Permanently added …" into stderr on EVERY tool call. Always re-scan (the VM
// generates fresh host keys per boot); when the sandbox is not listening,
// remove a stale file so the driver falls back to accept-and-discard instead
// of failing verification against a key that no longer exists.
const knownHosts =
  sshTarget.keyFile !== "" ? path.join(path.dirname(sshTarget.keyFile), "known_hosts") : undefined
if (knownHosts !== undefined) {
  const scan = Bun.spawnSync([
    "ssh-keyscan", "-p", String(sshTarget.port), "-t", "ed25519,rsa", sshTarget.host,
  ])
  const keys = scan.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .flatMap((line) => {
      const rest = line.split(" ").slice(1).join(" ")
      return [
        `[localhost]:${sshTarget.port} ${rest}`,
        `[127.0.0.1]:${sshTarget.port} ${rest}`,
      ]
    })
  if (keys.length > 0) {
    writeFileSync(knownHosts, keys.join("\n") + "\n")
    console.log(`host key pinned: ${knownHosts} (${keys.length} entries)`)
  } else {
    rmSync(knownHosts, { force: true })
    console.log(
      `ssh-keyscan got no host key from ${sshTarget.host}:${sshTarget.port} (sandbox down?); ` +
        "driver will accept-and-discard (expect the added-host warning)",
    )
  }
}
const pathMap: PathMap | undefined =
  hostDataDir === undefined ? undefined : { host: hostDataDir, guest: process.env.WORKSPACE_GUEST_DIR ?? "/data" }

// fixed id: adopts the same workspace across embed restarts (workspace.create
// is idempotent per id+provider; a stale persisted binding keeps the ssh target
// of the boot that provisioned it)
const workspaceID = Workspace.ID.make("wrk_quicksand_ssh")

const program = Effect.gen(function* () {
  const host = yield* Effect.acquireRelease(
    EmbeddedHost.create({
      workspaceProviders: { ssh: sshWorkspaceDriver(sshTarget, pathMap) },
      config,
    }),
    (host) => Effect.promise(host.close),
  )
  // Sessions must be BORN in the ssh workspace. Post-create moves only land
  // at a "safe inbox boundary", so a session's first turn can race the move
  // and run host-local (observed: `uname -r` returning the Windows host's
  // MSYS2 kernel). The wire schema (Location.PublicRef) strips workspaceID on
  // decode, so rewriting the request body is useless — instead intercept the
  // POST /api/session create and call the core Session.Service with a full
  // Location.Ref, whose in-process schema keeps workspaceID. parentID creates
  // (child inherits its parent's location) and explicit ids (adopt/resume)
  // pass through to the default handler; the bus sweep below remains the
  // fallback for anything that still slips out implicit-local.
  const createInWorkspace = async (request: Request) => {
    const pass = () => host.fetch(request)
    if (hostDataDir === undefined) return pass()
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/api/session") return pass()
    const payload = (await request.clone().json().catch(() => undefined)) as
      | { parentID?: string; id?: string; title?: string; agent?: string; model?: string; metadata?: unknown; permissions?: unknown; location?: { directory?: string } }
      | undefined
    if (payload === undefined || payload.parentID !== undefined || payload.id !== undefined) return pass()
    try {
      const session = await host.runtime.runPromise(
        host.sessions.create({
          title: payload.title,
          agent: payload.agent,
          model: payload.model,
          metadata: payload.metadata,
          permissions: payload.permissions,
          location: { directory: payload.location?.directory ?? hostDataDir, workspaceID },
        }),
      )
      console.log(`session ${session.id} born in ssh workspace ${workspaceID}`)
      return new Response(JSON.stringify({ data: session }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    } catch (error) {
      console.error("ssh-born session create failed; falling back to the default handler:", error)
      return pass()
    }
  }

  const server = Bun.serve({
    port,
    // Model steps can sit >10s before their first streamed byte; Bun's default
    // idleTimeout kills such requests and the client sees ECONNRESET. (max 255)
    idleTimeout: 255,
    fetch: (request) => createInWorkspace(request),
  })
  console.log(`opencode embedder listening on http://localhost:${server.port}`)
  console.log(
    `ssh target: ${sshTarget.user}@${sshTarget.host}:${sshTarget.port} (key: ${sshTarget.keyFile || "none"})`,
  )

  // Provision the ssh-backed workspace up front (idempotent per id+provider).
  // Sessions placed into it connect lazily when their tools execute; no boot
  // read is attempted — /data holds the caller's CWD, whose contents vary.
  const services = yield* host.runtime.contextEffect
  const workspace = Context.get(services, Workspace.Service)
  yield* workspace.create({ id: workspaceID, provider: "ssh" })

  // Fallback placement for sessions that were NOT born in the workspace
  // (pass-through creates: parentID children, explicit-id adoptions, and any
  // create where the interception above failed): move them at their next safe
  // inbox boundary. The workspaceID check makes re-placement idempotent.
  if (hostDataDir === undefined) {
    console.log("WORKSPACE_HOST_DIR not set; sessions stay host-local")
  } else {
    const bus = Context.get(services, Bus.Service)
    const placeSession = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const session = yield* host.sessions.get(sessionID)
        if (session.location.workspaceID !== undefined) return
        yield* host.sessions.move({ sessionID, directory: hostDataDir, workspaceID })
        console.log(`session ${sessionID} placed into ssh workspace ${workspaceID}`)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => console.error(`failed to place session ${sessionID}:`, cause)),
        ),
      )

    // Subscribe before sweeping: a session created between sweep and
    // subscription would otherwise be missed. The workspaceID check makes the
    // double placement of a session caught by both paths harmless. Bus events
    // are envelopes: the payload fields live under event.data.
    yield* bus.subscribe(SessionEvent.Created).pipe(
      Stream.runForEach((event) => placeSession(event.data.sessionID)),
      Effect.forkScoped,
    )
    const listed = yield* host.sessions.list({ limit: 200 })
    yield* Effect.forEach(listed.data, (session) => placeSession(session.id), { concurrency: 1, discard: true })
    console.log(`placing sessions into ssh workspace ${workspaceID} at ${hostDataDir}`)
  }

  // Park the fiber so the scope never closes and the host stays alive.
  yield* Effect.never
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(cause)
  process.exit(1)
})
