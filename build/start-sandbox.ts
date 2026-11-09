/** Starts the sandbox VM from source (quicksand/sandbox.py), bootstrapping the
 * venv on first run. Long-running: interactive terminal waits for Enter;
 * non-interactive (CI) holds the VM open for 5 minutes. */

import { existsSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { SANDBOX_DIR, SANDBOX_VENV, pythonExe, venvPython } from "./common"

const venvPy = venvPython()

if (!existsSync(venvPy)) {
  console.log(`creating venv at ${SANDBOX_VENV}`)
  await $`${pythonExe()} -m venv ${SANDBOX_VENV}`
}
await $`${venvPy} -m pip install --quiet 'quick-sandbox[qemu,ubuntu]'`

const proc = Bun.spawn([venvPy, path.join(SANDBOX_DIR, "sandbox.py")], {
  // no cwd: the child must inherit THIS process's CWD — sandbox.py mounts the
  // directory it is run from at /data in the guest. Forcing cwd to SANDBOX_DIR
  // would mount quicksand/ itself instead of the caller's directory.
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
})
process.exit(await proc.exited)
