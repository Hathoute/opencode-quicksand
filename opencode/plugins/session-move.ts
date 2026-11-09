import { Effect, Schema } from "effect"
import path from "path"
import { ToolFailure } from "../../packages/ai/src/effect"
import type { Interface } from "../../packages/core/src/session"
import type { Plugin } from "../../packages/plugin/src/effect/plugin"
import { AbsolutePath } from "../../packages/schema/src/schema"
import { Session } from "../../packages/schema/src/session"
import type { PathMap } from "../driver"

const MoveInput = Schema.Struct({
  sessionID: Schema.optionalKey(Session.ID).annotate({ description: "Omit to move the current session." }),
  directory: AbsolutePath.check(Schema.isMinLength(1)).annotate({
    description: "Destination directory, relative to the target session's directory or absolute. Supports ~.",
  }),
})

const MoveOutput = Schema.Struct({ sessionID: Session.ID, directory: AbsolutePath })

/** Overrides OpenCode's built-in tool so directory moves retain workspace placement. */
export const sessionMovePlugin = (sessions: Interface, map: PathMap): Plugin => ({
  id: "quicksand.session-move",
  effect: Effect.fn("QuicksandSessionMove.Plugin")(function* (ctx) {
    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "session_move",
          description:
            "Move a session to another directory, or omit sessionID to move the current session. Paths under the guest mount /data are accepted. The current session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
          input: MoveInput,
          output: MoveOutput,
          options: { namespace: "opencode", codemode: true, pinned: true },
          execute: (input, context) =>
            Effect.gen(function* () {
              const sessionID = input.sessionID ?? context.sessionID
              const session = yield* sessions.get(sessionID)
              yield* sessions.move({
                sessionID,
                directory: hostPath(input.directory, map),
                workspaceID: session.location.workspaceID,
                delivery: "steer",
              })
              return {
                output: { sessionID, directory: input.directory },
                content: `Moved session ${sessionID} to ${input.directory}.`,
              }
            }).pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to move session to ${input.directory}`, error }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
})

function hostPath(directory: string, map: PathMap) {
  if (!directory.startsWith("/")) return AbsolutePath.make(directory)
  const guest = path.posix.normalize(directory)
  const root = path.posix.normalize(map.guest)
  if (guest !== root && !guest.startsWith(root + "/")) return AbsolutePath.make(directory)
  const relative = path.posix.relative(root, guest)
  return AbsolutePath.make(path.resolve(map.host, ...relative.split("/").filter(Boolean)))
}
