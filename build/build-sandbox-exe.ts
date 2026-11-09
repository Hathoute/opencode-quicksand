/** Builds the sandbox VM launcher as a standalone executable
 * (build/dist/sandbox.exe): interpreter + deps + Ubuntu image + QEMU binaries.
 * Requires python on PATH (or $PYTHON) to bootstrap the venv. */

import { existsSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { DIST_DIR, SANDBOX_DIR, SANDBOX_VENV, pythonExe, venvPython } from "./common"

const venvPy = venvPython()

if (!existsSync(venvPy)) {
  console.log(`creating venv at ${SANDBOX_VENV}`)
  await $`${pythonExe()} -m venv ${SANDBOX_VENV}`
}

// quick-sandbox[qemu,ubuntu]: runtime + bundled QEMU + the Ubuntu image wheel.
// pyinstaller for this build; uv/pip resolve from the venv's own pip.
await $`${venvPy} -m pip install --quiet 'quick-sandbox[qemu,ubuntu]' pyinstaller`

await $`${venvPy} -m PyInstaller --noconfirm --onefile --name sandbox --distpath ${DIST_DIR} --workpath ${path.join(DIST_DIR, "pyinstaller-work")} --specpath ${SANDBOX_DIR} --collect-all quicksand --collect-all quicksand_core --collect-all quicksand_qemu --collect-all quicksand_ubuntu --collect-all quicksand_smb --copy-metadata quick-sandbox --copy-metadata quicksand-core --copy-metadata quicksand-qemu --copy-metadata quicksand-ubuntu --copy-metadata quicksand-smb ${path.join(SANDBOX_DIR, "sandbox.py")}`

console.log(`built: ${path.join(DIST_DIR, "sandbox.exe")}`)
