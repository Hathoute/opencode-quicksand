/** Builds the sandbox VM launcher as a standalone executable
 * (build/dist/sandbox-<os>-<arch>[.exe]): interpreter + deps + Ubuntu image +
 * QEMU binaries, via PyInstaller in the uv-managed build environment
 * (pyproject.toml `build` dependency-group). */

import { renameSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { DIST_DIR, PROJECT_ROOT, SANDBOX_DIR, ensureUv, exeSuffix, platformSlug } from "./common"

ensureUv()

// Runtime deps + the pyinstaller build group, exactly as locked.
await $`uv sync --frozen --group build`.cwd(PROJECT_ROOT)

await $`uv run --no-sync --project ${PROJECT_ROOT} pyinstaller --noconfirm --onefile --name sandbox --distpath ${DIST_DIR} --workpath ${path.join(DIST_DIR, "pyinstaller-work")} --specpath ${SANDBOX_DIR} --collect-all quicksand --collect-all quicksand_core --collect-all quicksand_qemu --collect-all quicksand_ubuntu --collect-all quicksand_smb --copy-metadata quick-sandbox --copy-metadata quicksand-core --copy-metadata quicksand-qemu --copy-metadata quicksand-ubuntu --copy-metadata quicksand-smb ${path.join(SANDBOX_DIR, "sandbox.py")}`

// PyInstaller appends .exe only on Windows; release artifacts carry a
// platform suffix so every target can live in the same directory.
const built = path.join(DIST_DIR, `sandbox${exeSuffix}`)
const final = path.join(DIST_DIR, `sandbox-${platformSlug()}${exeSuffix}`)
renameSync(built, final)
console.log(`built: ${final}`)
