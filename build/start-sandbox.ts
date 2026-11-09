/** Starts the content-addressed sandbox VM from source (quicksand/sandbox.py) inside the
 * uv-managed project environment (pyproject.toml + uv.lock; uv also manages
 * the interpreter via .python-version, so no system python is needed).
 * Long-running: interactive terminal waits for Enter; non-interactive (CI)
 * holds the VM open for 5 minutes. */

import path from "path"
import { $ } from "bun"
import { PROJECT_ROOT, SANDBOX_DIR, ensureUv } from "./common"

ensureUv()

// Declarative env: uv.lock pins quick-sandbox (+ qemu/ubuntu extras) and pip
// (quicksand's first-boot image auto-install shells out to `python -m pip`;
// uv-created environments ship without it). --frozen refuses lockfile drift.
await $`uv sync --frozen`.cwd(PROJECT_ROOT)

// no cwd on purpose: the child must inherit THIS process's CWD — sandbox.py
// mounts the directory it is run from at /data in the guest. --project
// selects the environment WITHOUT changing the child's working directory.
const proc = Bun.spawn(
  ["uv", "run", "--no-sync", "--project", PROJECT_ROOT, "python", path.join(SANDBOX_DIR, "sandbox.py")],
  {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
)
process.exit(await proc.exited)
