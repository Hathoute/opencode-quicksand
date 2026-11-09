/** Syncs the poc into the pinned opencode checkout and starts the embedder
 * from source (bun poc/embed.ts) on http://localhost:4096. Long-running. */

import { ensureDeps, ensureRepo, syncPoc } from "./repo"
import { CHECKOUT_DIR, SSH_KEY } from "./common"

await ensureRepo()
const poc = syncPoc()
await ensureDeps()
console.log(`poc synced -> ${poc}`)

// env contract (FINDINGS.md #1): the embedded server's DB is in-memory, so
// auth comes via ZAI_API_KEY. The sandbox mounts the CALLER'S CWD at /data, so
// the workspace must default to the same directory (bun run executes scripts
// from the project root — the same CWD `bun run start:sandbox` ran from).
process.env.PORT ??= "4096"
process.env.SSH_HOST ??= "localhost"
process.env.SSH_PORT ??= "2222"
process.env.SSH_KEY ??= SSH_KEY
process.env.WORKSPACE_HOST_DIR ??= process.cwd()
process.env.SSH_DRIVER_LOG ??= "1"

const proc = Bun.spawn(["bun", "poc/embed.ts"], {
  cwd: CHECKOUT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
})
process.exit(await proc.exited)
