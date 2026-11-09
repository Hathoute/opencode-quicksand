/** Syncs the poc into the configured opencode checkout and starts the embedder
 * from source (bun poc/embed.ts) on opencode.port. Long-running. */

import { existsSync } from "node:fs"
import path from "path"
import { ensureDeps, ensureRepo, syncPoc } from "./repo"
import { CHECKOUT_DIR, SSH_KEY } from "./common"
import { CONFIG_FILE, WORKSPACE_DIR, config } from "./config"

const configFile = path.join(config.opencode.configDir, "opencode.jsonc")
if (!existsSync(configFile)) throw new Error(`opencode config not found: ${configFile}`)

await ensureRepo()
const poc = syncPoc()
await ensureDeps()
console.log(`poc synced -> ${poc}`)

process.env.SSH_HOST ??= "localhost"
process.env.SSH_KEY ??= SSH_KEY
process.env.SSH_DRIVER_LOG ??= "1"

const proc = Bun.spawn(["bun", "poc/embed.ts", "--config", CONFIG_FILE, "--workspace", WORKSPACE_DIR], {
  cwd: CHECKOUT_DIR,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
})
process.exit(await proc.exited)
