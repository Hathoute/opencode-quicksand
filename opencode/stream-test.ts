/** Streaming verification: chunks from the ssh spawner must arrive as the
 * remote command prints them (~2s apart), not in one burst at process end. */

import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { sshSpawner } from "./driver"
import type { SshTarget } from "./driver"

const target: SshTarget = {
  host: process.env.SSH_HOST ?? "localhost",
  port: Number(process.env.SSH_PORT ?? 2222),
  user: process.env.SSH_USER ?? "root",
  keyFile: process.env.SSH_KEY ?? "",
}

const program = Effect.gen(function* () {
  const spawner = sshSpawner(target, undefined)
  const start = Date.now()
  const stamp = () => `+${((Date.now() - start) / 1000).toFixed(1)}s`

  // One line every 2 seconds for 10 seconds.
  const command = ChildProcess.make(
    "bash",
    ["-c", "for i in 1 2 3 4 5; do echo line-$i; sleep 2; done"],
    { env: {}, extendEnv: false },
  )
  const handle = yield* spawner.spawn(command)
  const stdoutLines = handle.stdout.pipe(
    Stream.map((chunk) => `${stamp()} stdout: ${JSON.stringify(new TextDecoder().decode(chunk))}`),
  )
  const stderrLines = handle.stderr.pipe(
    Stream.map((chunk) => `${stamp()} stderr: ${JSON.stringify(new TextDecoder().decode(chunk))}`),
  )
  yield* Stream.merge(stdoutLines, stderrLines).pipe(
    Stream.tap((line) => Effect.sync(() => console.log(line))),
    Stream.runDrain,
  )
  const code = yield* handle.exitCode
  console.log(`${stamp()} exit=${code}`)
})

Effect.runPromise(program).catch((cause) => {
  console.error(cause)
  process.exit(1)
})
