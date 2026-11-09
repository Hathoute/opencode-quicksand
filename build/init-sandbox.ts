/** Creates the content-addressed sandbox image when it does not exist. */

import path from "path"
import { $ } from "bun"
import { PROJECT_ROOT, SANDBOX_DIR, ensureUv } from "./common"

ensureUv()
await $`uv sync --frozen`.cwd(PROJECT_ROOT)

const proc = Bun.spawn(
  ["uv", "run", "--no-sync", "--project", PROJECT_ROOT, "python", path.join(SANDBOX_DIR, "sandbox.py"), "--init"],
  {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
)
process.exit(await proc.exited)
