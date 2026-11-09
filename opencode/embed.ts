import { Context, Effect, Layer, Stream } from "effect"
import { existsSync, mkdirSync } from "node:fs"
import path from "path"
import { EmbeddedHost } from "../packages/sdk/src/internal/host"
import { Bus } from "../packages/core/src/bus"
import { Workspace } from "../packages/core/src/workspace"
import { RipgrepBinary } from "../packages/core/src/ripgrep/binary"
import type { Agent } from "../packages/schema/src/agent"
import type { Model } from "../packages/schema/src/model"
import type { Permission } from "../packages/schema/src/permission"
import { SessionEvent } from "../packages/schema/src/session-event"
import type { Session } from "../packages/schema/src/session"
import { sshWorkspaceDriver } from "./driver"
import type { PathMap, SshTarget } from "./driver"
import { sessionMovePlugin } from "./plugins/session-move"
import { loadRuntimeConfig } from "./runtime-config"
import { pinHostKey } from "./ssh"

const configArgument = process.argv.indexOf("--config")
if (configArgument !== -1 && process.argv[configArgument + 1] === undefined)
  throw new Error("--config requires a file path")
const runtime = await loadRuntimeConfig(
  configArgument === -1 ? path.resolve("config.jsonc") : process.argv[configArgument + 1],
)
const workspaceArgument = process.argv.indexOf("--workspace")
if (workspaceArgument !== -1 && process.argv[workspaceArgument + 1] === undefined)
  throw new Error("--workspace requires a directory path")
const hostDataDir = path.resolve(workspaceArgument === -1 ? process.cwd() : process.argv[workspaceArgument + 1])
const port = runtime.opencode.port

// Load the complete config (including provider/model settings) from an
// explicit directory. Resolving here also makes relative paths work for the
// standalone executable; build/start-embed.ts resolves them before changing
// the child process cwd.
const configDir = runtime.opencode.configDir
const configFile = path.join(configDir, "opencode.jsonc")
if (!existsSync(configFile)) throw new Error(`opencode config not found: ${configFile}`)

// EmbeddedHost defaults to an isolated in-memory database. Keep sessions,
// credentials, and other server state in a persistent SQLite database instead.
const cacheDir = runtime.opencode.cacheDir
mkdirSync(cacheDir, { recursive: true })
const databaseFile = path.join(cacheDir, "opencode.db")
const sshPortFile = path.join(runtime.sandbox.cacheDir, "ssh-port")
if (!existsSync(sshPortFile))
  throw new Error(`sandbox SSH port file not found: ${sshPortFile}; start the sandbox first`)
const sshPort = Number((await Bun.file(sshPortFile).text()).trim())
if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535)
  throw new Error(`invalid sandbox SSH port in ${sshPortFile}`)

// Quicksand allocates an internal SSH forward and publishes its host port.
const sshTarget: SshTarget = {
  host: process.env.SSH_HOST ?? "localhost",
  port: sshPort,
  user: process.env.SSH_USER ?? "root",
  keyFile: process.env.SSH_KEY ?? "",
}

// The launcher's original working directory is both mounted at /data and used
// as the session workspace, so tools operate on the directory being launched.

// Pin the sandbox's host key for this boot (see ssh.ts): silent verified
// driver invocations instead of an accept-and-discard warning per tool call.
pinHostKey(sshTarget)

const pathMap: PathMap = { host: hostDataDir, guest: "/data" }

// Fixed id: adopts the same logical workspace across embed restarts. The SSH
// driver deliberately reconnects with this boot's target rather than its
// persisted binding because the host port is allocated per boot.
const workspaceID = Workspace.ID.make("wrk_quicksand_ssh")

const program = Effect.gen(function* () {
  const host = yield* Effect.acquireRelease(
    EmbeddedHost.create(
      {
        workspaceProviders: { ssh: sshWorkspaceDriver(sshTarget, pathMap, runtime.sandbox.env) },
        config: { directory: configDir },
        database: { path: databaseFile },
      },
      {
        overrides: [
          RipgrepBinary.node.replace(
            Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed("rg") })),
          ),
        ],
      },
    ),
    (host) => Effect.promise(host.close),
  )
  // SDK plugins activate after OpenCode's built-ins, so registering the same
  // effective tool name replaces session_move without patching the checkout.
  yield* host.plugins.register(sessionMovePlugin(host.sessions, pathMap))
  // Sessions must be BORN in the ssh workspace. Post-create moves only land
  // at a "safe inbox boundary", so a session's first turn can race the move
  // and run host-local (observed: `uname -r` returning the Windows host's
  // MSYS2 kernel). The wire schema (Location.PublicRef) strips workspaceID on
  // decode, so rewriting the request body is useless — instead intercept the
  // POST /api/session create and call the core Session.Service with a full
  // Location.Ref, whose in-process schema keeps workspaceID. parentID creates
  // pass through so children inherit their parent's location; explicit ids are
  // handled here because the TUI mints them before creating a session. Existing
  // ids remain safe because Session.create adopts their recorded location.
  const createInWorkspace = async (request: Request) => {
    const url = new URL(request.url)
    // The CLI closes its SSE subscription after every non-interactive run.
    // Bun reports that normal socket close by aborting the inbound Request with
    // "The connection was closed". Passing the signal into OwnedFetch makes it
    // error the response stream, which Bun treats as an unhandled rejection and
    // terminates the embedder. Give only the SSE route a transport-independent
    // signal; cancellation of the returned response body still propagates to
    // EmbeddedHost and releases the subscription.
    const pass = () =>
      host.fetch(
        url.pathname === "/api/event" ? new Request(request, { signal: new AbortController().signal }) : request,
      )
    if (request.method !== "POST" || url.pathname !== "/api/session") return pass()
    const payload = (await request
      .clone()
      .json()
      .catch(() => undefined)) as
      | {
          parentID?: Session.ID
          id?: Session.ID
          title?: string
          agent?: Agent.ID
          model?: Model.Ref
          metadata?: Session.Metadata
          permissions?: Permission.Ruleset
          location?: { directory?: string }
        }
      | undefined
    if (payload === undefined || payload.parentID !== undefined) return pass()
    try {
      const requested = path.resolve(payload.location?.directory ?? hostDataDir)
      const relative = path.relative(hostDataDir, requested)
      const directory =
        relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
          ? requested
          : hostDataDir
      const session = await host.runtime.runPromise(
        host.sessions.create({
          id: payload.id,
          title: payload.title,
          agent: payload.agent,
          model: payload.model,
          metadata: payload.metadata,
          permissions: payload.permissions,
          location: { directory, workspaceID },
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
  console.log(`ssh target: ${sshTarget.user}@${sshTarget.host}:${sshTarget.port} (key: ${sshTarget.keyFile || "none"})`)
  console.log(`database: ${databaseFile}`)

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
  const bus = Context.get(services, Bus.Service)
  const placeSession = (sessionID: Session.ID) =>
    Effect.gen(function* () {
      const session = yield* host.sessions.get(sessionID)
      if (session.location.workspaceID !== undefined) return
      yield* host.sessions.move({ sessionID, directory: hostDataDir, workspaceID })
      console.log(`session ${sessionID} placed into ssh workspace ${workspaceID}`)
    }).pipe(
      Effect.catchCause((cause) => Effect.sync(() => console.error(`failed to place session ${sessionID}:`, cause))),
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

  // Park the fiber so the scope never closes and the host stays alive.
  yield* Effect.never
})

Effect.runPromise(Effect.scoped(program)).catch((cause) => {
  console.error(cause)
  process.exit(1)
})
