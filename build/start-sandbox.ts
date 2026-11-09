/** Starts the content-addressed sandbox VM from source (quicksand/sandbox.py) inside the
 * uv-managed project environment (pyproject.toml + uv.lock; uv also manages
 * the interpreter via .python-version, so no system python is needed).
 * Long-running: interactive terminal waits for Enter; non-interactive (CI)
 * holds the VM open for 5 minutes. */

import path from "path"
import { $ } from "bun"
import { PROJECT_ROOT, SANDBOX_DIR, ensureUv } from "./common"
import { CONFIG_FILE } from "./config"

ensureUv()

// Declarative env: uv.lock pins quick-sandbox (+ qemu/ubuntu extras) and pip
// (quicksand's first-boot image auto-install shells out to `python -m pip`;
// uv-created environments ship without it). --frozen refuses lockfile drift.
await $`uv sync --frozen`.cwd(PROJECT_ROOT)

// --project selects the environment without changing the child cwd; Quicksand
// stores its named image saves under this project's .quicksand directory.
const proc = Bun.spawn(
  [
    "uv",
    "run",
    "--no-sync",
    "--project",
    PROJECT_ROOT,
    "python",
    path.join(SANDBOX_DIR, "sandbox.py"),
    "--config",
    CONFIG_FILE,
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
)
process.exit(await proc.exited)
